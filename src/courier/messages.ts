import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { FeedLog } from '../storage/feedLog.js';
import type { TimelineKey } from '../feed/timeline.js';

/**
 * The chat thread of each BlackHole session as the Chat page shows it: what was sent to the
 * web chat, and the web agent's replies. Kept in the `courier_messages` table next to the database.
 */
export type CourierMessageKind = 'user' | 'agent';
/** `streaming`: an agent reply segment still being written (updated in place until final). */
export type CourierMessageStatus = 'sent' | 'unconfirmed' | 'failed' | 'reply' | 'streaming';

export interface CourierMessage {
  id: string;
  sessionId: string;
  kind: CourierMessageKind;
  text: string;
  at: number;
  status: CourierMessageStatus;
  site: string | null;
  targetId: string | null;
  conversationKey: string | null;
  /** Failure reason (user messages) or the responding model (agent replies). */
  code?: string;
  message?: string;
  model?: string;
  /** Number of images sent with a user message (the bytes are not kept). */
  images?: number;
  /** Arena turn number: replies are de-duplicated on (conversationKey, turn). */
  turn?: number;
  /** Streamed reply segment (text between two tool calls); updates of one segment replace its text. */
  segment?: string;
  /** The web page's own id of this reply (ChatGPT's data-message-id): stable across page reloads. */
  messageId?: string;
  /** The web agent asked a question with options (answered by sending an option number, its text, 跳过 or free text). */
  question?: CourierQuestion;
  /** 变更号：每次新增或更新都取 FeedLog 的下一个号（全会话共用一个计数器）。feed 用 `changedSince(offset)` 取增量。 */
  rev?: number;
}

export interface CourierQuestion {
  title: string;
  options: string[];
  /** The card has a Skip button (answer 跳过). */
  skip: boolean;
  /** The card has a free-text box (any other text is the answer). */
  input: boolean;
  /** Answered already (on the web page or through BlackHole): UIs close the question card. */
  answered?: boolean;
  /** The option picked on the web page, when Courier could read it. */
  answer?: string;
}

export type CourierMessageListener = (m: CourierMessage) => void;

/** `list()` 默认只取最新的这么多条（沿用旧的每会话 200 条上限，旧接口 `/courier/messages` 因此不变）。 */
const LIST_DEFAULT = 200;

/**
 * 保留期清扫（daemon 启动时和工具调用等一起清扫，保留期 7 天）：删除 `at` 早于 `cutoff` 的回复，返回删除条数。
 * 不需要 CourierMessages 实例，所以能在构造 hub 之前和其他仓库的清扫放在一起。
 */
export function purgeCourierMessagesOlderThan(db: DatabaseSync, cutoff: number): number {
  return Number(db.prepare('DELETE FROM courier_messages WHERE at < ?').run(cutoff).changes);
}

interface Row {
  id: string;
  session_id: string;
  kind: string;
  text: string;
  at: number;
  status: string;
  site: string | null;
  target_id: string | null;
  conversation_key: string | null;
  code: string | null;
  message: string | null;
  model: string | null;
  images: number | null;
  turn: number | null;
  segment: string | null;
  message_id: string | null;
  question_json: string | null;
  rev: number;
}

/** 行转消息：可选字段为 NULL 时不带这个属性，与旧的 JSON 存储吐出的形状一致。 */
function toMessage(r: Row): CourierMessage {
  let question: CourierQuestion | undefined;
  if (r.question_json) {
    try { question = JSON.parse(r.question_json) as CourierQuestion; } catch { /* 损坏的提问卡片丢弃，消息本身保留 */ }
  }
  return {
    id: r.id, sessionId: r.session_id, kind: r.kind as CourierMessageKind, text: r.text, at: r.at,
    status: r.status as CourierMessageStatus, site: r.site, targetId: r.target_id, conversationKey: r.conversation_key,
    ...(r.code !== null ? { code: r.code } : {}),
    ...(r.message !== null ? { message: r.message } : {}),
    ...(r.model !== null ? { model: r.model } : {}),
    ...(r.images !== null ? { images: r.images } : {}),
    ...(r.turn !== null ? { turn: r.turn } : {}),
    ...(r.segment !== null ? { segment: r.segment } : {}),
    ...(r.message_id !== null ? { messageId: r.message_id } : {}),
    ...(question ? { question } : {}),
    rev: r.rev,
  };
}

/**
 * 会话聊天线程，存在 SQLite 的 `courier_messages` 表里（取代原来的 JSON 文件）。
 * 所有写入都是同步 SQL，不再有 400ms 的延迟落盘，崩溃也不会丢最后一段回复；
 * 不设条数上限，行随会话删除或由保留期清扫删除。rev 由 FeedLog 分配。
 */
export class CourierMessages {
  private readonly listeners = new Set<CourierMessageListener>();
  private readonly feed: FeedLog;

  /** `feed` 缺省时自建一个（测试用）；daemon 里传入全局共用的那一个。 */
  constructor(private readonly db: DatabaseSync, feed?: FeedLog) {
    this.feed = feed ?? FeedLog.open(db);
  }

  private get(id: string): CourierMessage {
    return toMessage(this.db.prepare('SELECT * FROM courier_messages WHERE id = ?').get(id) as unknown as Row);
  }

  /** 会话最新的 `limit` 条，按时间升序（先按 at，再按写入顺序）。 */
  list(sessionId: string, limit: number = LIST_DEFAULT): CourierMessage[] {
    const n = Math.max(1, Math.floor(limit));
    const rows = this.db.prepare('SELECT * FROM courier_messages WHERE session_id = ? ORDER BY at DESC, rowid DESC LIMIT ?')
      .all(sessionId, n) as unknown as Row[];
    return rows.reverse().map(toMessage);
  }

  /**
   * 最近一条「用户消息或带提问的消息」，没有则 null。hub 用它判断网页 agent 是否在等回答，
   * 不必读出整个会话；走 `(session_id, at)` 索引，只看这一轮里的几条。
   */
  latestTurnMarker(sessionId: string): CourierMessage | null {
    const r = this.db
      .prepare("SELECT * FROM courier_messages WHERE session_id = ? AND (kind = 'user' OR question_json IS NOT NULL) ORDER BY at DESC, rowid DESC LIMIT 1")
      .get(sessionId) as unknown as Row | undefined;
    return r ? toMessage(r) : null;
  }

  /** Exact boundary for current-turn review; user `at` is captured when send/start begins. */
  latestUserAt(sessionId: string): number | null {
    const row = this.db
      .prepare("SELECT at FROM courier_messages WHERE session_id = ? AND kind = 'user' AND status IN ('sent', 'unconfirmed') ORDER BY at DESC, rowid DESC LIMIT 1")
      .get(sessionId) as { at: number } | undefined;
    return row?.at ?? null;
  }

  /** feed 增量：该会话 `rev > after` 的消息，按 rev 升序，最多 `limit` 条（走 idx_courier_messages_session_rev）。 */
  changedSince(sessionId: string, after: number, limit: number): CourierMessage[] {
    const rows = this.db.prepare('SELECT * FROM courier_messages WHERE session_id = ? AND rev > ? ORDER BY rev ASC LIMIT ?')
      .all(sessionId, after, limit) as unknown as Row[];
    return rows.map(toMessage);
  }

  /**
   * 时间线翻页：严格早于 `before`（见 feed/timeline.ts）的消息，按 (at, id) 倒序最多 `limit` 条。
   * 同一毫秒里回复排在调用后面，所以游标是调用时同一毫秒的回复不算「更早」。
   */
  pageBefore(sessionId: string, before: TimelineKey | null, limit: number): CourierMessage[] {
    const sql = 'SELECT * FROM courier_messages WHERE session_id = ?';
    const order = ' ORDER BY at DESC, id DESC LIMIT ?';
    let rows: Row[];
    if (!before) rows = this.db.prepare(sql + order).all(sessionId, limit) as unknown as Row[];
    else if (before.kind === 'c') rows = this.db.prepare(`${sql} AND at < ?${order}`).all(sessionId, before.t, limit) as unknown as Row[];
    else rows = this.db.prepare(`${sql} AND (at < ? OR (at = ? AND id < ?))${order}`).all(sessionId, before.t, before.t, before.id, limit) as unknown as Row[];
    return rows.map(toMessage);
  }

  /** The session is gone (deleted/ended): drop its whole thread. */
  drop(sessionId: string): boolean {
    return Number(this.db.prepare('DELETE FROM courier_messages WHERE session_id = ?').run(sessionId).changes) > 0;
  }

  /** Every added or updated message (live Chat page updates). Returns the unsubscribe function. */
  subscribe(fn: CourierMessageListener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private notify(m: CourierMessage): void {
    for (const fn of this.listeners) {
      try { fn(m); } catch { /* a broken listener must not stop the others */ }
    }
  }

  /**
   * A streamed reply segment: the first update adds it, later ones replace its text (and status,
   * model, turn) in place. Returns null when nothing changed.
   */
  upsertSegment(m: Omit<CourierMessage, 'id' | 'at'> & { segment: string }): CourierMessage | null {
    const find = (cond: string, ...args: (string | number | null)[]): CourierMessage | undefined => {
      const r = this.db.prepare(`SELECT * FROM courier_messages WHERE session_id = ? AND ${cond} ORDER BY at, rowid LIMIT 1`)
        .get(m.sessionId, ...args) as unknown as Row | undefined;
      return r ? toMessage(r) : undefined;
    };
    // Same segment, or the same page message seen again after a reload (the segment is per page
    // load, the page's message id is not). A final reply stored before message ids were sent is
    // matched once by its text and gets the id.
    // `conversation_key IS ?` 是空值安全的相等比较（旧实现里 null === null 为真）。
    // 调用方可能省略 conversationKey（undefined），SQLite 绑定不接受 undefined，一律规范成 null。
    const key = m.conversationKey ?? null;
    const old = find('segment = ? AND conversation_key IS ?', m.segment, key)
      ?? (m.messageId ? find("kind = 'agent' AND message_id = ? AND conversation_key IS ?", m.messageId, key) : undefined)
      ?? (m.messageId && m.status === 'reply'
        ? find("kind = 'agent' AND message_id IS NULL AND status = 'reply' AND conversation_key IS ? AND text = ?", key, m.text)
        : undefined);
    if (!old) return this.add(m);
    if (m.messageId && old.messageId !== m.messageId) {
      this.db.prepare('UPDATE courier_messages SET message_id = ?, rev = ? WHERE id = ?').run(m.messageId, this.feed.next(old.sessionId), old.id);
      old.messageId = m.messageId;
    }
    if (old.status === 'reply' && m.status === 'streaming') return null; // a late partial after the final one
    const next: CourierMessage = { ...old, text: m.text, status: m.status, ...(m.model ? { model: m.model } : {}), ...(m.turn != null ? { turn: m.turn } : {}), ...(m.question ? { question: m.question } : {}) };
    if (next.text === old.text && next.status === old.status && next.model === old.model && next.turn === old.turn
      && JSON.stringify(next.question) === JSON.stringify(old.question)) return null;
    this.db.prepare('UPDATE courier_messages SET text = ?, status = ?, model = ?, turn = ?, question_json = ?, rev = ? WHERE id = ?').run(
      next.text, next.status, next.model ?? null, next.turn ?? null, next.question ? JSON.stringify(next.question) : null,
      this.feed.next(old.sessionId), old.id,
    );
    const updated = this.get(old.id);
    this.notify(updated);
    return updated;
  }

  /** Courier went away mid-reply: segments still streaming are as complete as they will get. */
  finishStreaming(): void {
    const rows = this.db.prepare("SELECT id, session_id FROM courier_messages WHERE status = 'streaming'").all() as unknown as { id: string; session_id: string }[];
    for (const r of rows) {
      this.db.prepare("UPDATE courier_messages SET status = 'reply', rev = ? WHERE id = ?").run(this.feed.next(r.session_id), r.id);
      this.notify(this.get(r.id));
    }
  }

  add(m: Omit<CourierMessage, 'id' | 'at'> & { at?: number }): CourierMessage | null {
    const key = m.conversationKey ?? null; // 同 upsertSegment：undefined 规范成 null
    if (m.kind === 'agent' && m.turn != null && !m.segment
      && this.db.prepare("SELECT 1 FROM courier_messages WHERE session_id = ? AND kind = 'agent' AND conversation_key IS ? AND turn = ?")
        .get(m.sessionId, key, m.turn)) return null;
    // A send is recorded once the page confirms it, often after the reply started: `at` keeps time
    // order on read (ORDER BY at), so nothing has to be shifted on write.
    const id = randomUUID();
    this.db.prepare(`INSERT INTO courier_messages
      (id, session_id, kind, text, at, status, site, target_id, conversation_key, code, message, model, images, turn, segment, message_id, question_json, rev)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, m.sessionId, m.kind, m.text, m.at ?? Date.now(), m.status, m.site ?? null, m.targetId ?? null, key,
      m.code ?? null, m.message ?? null, m.model ?? null, m.images ?? null, m.turn ?? null, m.segment ?? null, m.messageId ?? null,
      m.question ? JSON.stringify(m.question) : null, this.feed.next(m.sessionId),
    );
    const full = this.get(id);
    this.notify(full);
    return full;
  }
}
