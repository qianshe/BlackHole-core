import type { CourierTurnState } from '../../packages/contracts/dist/courier-state.js';
import { cleanModelAttribution, type ModelAttribution } from '../../packages/contracts/dist/courier-model.js';
import { randomUUID } from 'node:crypto';
import type { WsConnection } from './ws.js';
import type { CourierMessages, CourierMessage, CourierQuestion } from './messages.js';
import type { CourierPairs, SessionLink } from './pairs.js';
import { draftName } from '../storage/draftName.js';
import { templateForSite } from './siteTemplate.js';
import type { TemplateKind } from './prompt.js';

/**
 * The one Courier extension connected to this daemon, and the chats it has bound.
 * Courier decides whether a send is safe (strict targeting); the hub only relays.
 */
export const COURIER_PROTOCOL = 1;
export const COURIER_CLIENT = 'blackhole-courier';
export const MAX_TEXT = 20000;
const TARGET_ID = /^[A-Za-z0-9-]{1,64}$/;
/** BlackHole session primary key (stable across rotate; never the credential). */
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const HELLO_MS = 5000;
const REFRESH_MS = 3000;
/** 有绑定的聊天在生成时，隔多久主动向 Courier 要一次最新目标状态（防 busy 卡住）。 */
const BUSY_REFRESH_MS = 7500;
const MAX_PENDING = 8;
/** Images pasted into a composer: uploaded first (POST /attachments), then named by id in /send. */
export const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGES = 4;
const IMAGE_TTL_MS = 30 * 60_000;
const SENT_IMAGE_CAP = 128 * 1024 * 1024;
const MAX_STORED_BYTES = 64 * 1024 * 1024;
/** Built-in sites; user-added ones come from the courierSites setting (opts.sites). */
const SITES = new Set(['arena', 'chatgpt']);
const BUILTIN_SITE_NAMES = [{ id: 'arena', name: 'Arena' }, { id: 'chatgpt', name: 'ChatGPT' }];
const MAX_REPLY = 60000;
/** No valid subscription ticket: sending and new pairings stop; pairings and threads are kept. */
export const SUBSCRIPTION_REQUIRED = 'subscription_required';
const SUBSCRIPTION_MESSAGE = 'BlackHole 订阅已到期或需要重新登录：续费或登录后即可继续发送，已有的配对和消息都保留';

export interface CourierTarget {
  targetId: string;
  site: string;
  label: string;
  conversationKey: string | null;
  pending: boolean;
  expectModel: string | null;
  open: boolean;
  ready: boolean | null;
  busy: boolean | null;
  turnState?: CourierTurnState | null;
  draft: boolean | null;
  model: string | null;
  modelAttribution?: ModelAttribution;
  /** Title of an open Arena rating card (此任务成功了吗？), null when none. */
  card: string | null;
  /** The BlackHole session this chat is bound to: only that session may send to it. */
  sessionId: string | null;
}

/** A BlackHole session as Courier shows it in its binding picker. */
export interface CourierSession {
  id: string;
  name: string;
  /** false: `name` is only the fallback (workspace folder); the first message will name the session. */
  named?: boolean;
  status: string;
  /** Courier's picker hides `paired` sessions: one session, one web chat. */
  link?: SessionLink;
}

export interface CourierResult {
  ok: boolean;
  code?: string;
  message: string;
  /** True when the text may already be in the chat: never resend automatically. */
  sent: boolean;
  targetId?: string;
}

/** What every UI needs: is the browser extension connected, and which chats can receive. */
export interface CourierStatus {
  connected: boolean;
  targets: CourierTarget[];
  /** Per live session: `new` (composer opens a chat), `paired`, `unpaired` / `direct` (receive only). */
  links: Record<string, SessionLink>;
  /** Sites a new chat can be opened on: built-in first, then the ones added in Courier. */
  sites: Array<{ id: string; name: string; custom: boolean; template: TemplateKind }>;
  /** Live sessions whose web agent asked a question (card) nobody has answered yet. */
  asking: string[];
}

/** What the hub needs of the courierSites setting (the profiles themselves are Courier's business). */
export interface CourierSitesStore {
  list: () => Array<{ id: string; name: string; origin?: string }>;
  put: (site: unknown) => { ok: boolean; message?: string };
  remove: (id: unknown) => { ok: boolean; message?: string };
}

type Waiter = { resolve: (v: Record<string, unknown>) => void; timer: NodeJS.Timeout };

const str = (v: unknown, max: number): string | null => (typeof v === 'string' ? v.slice(0, max) : null);
/** A question card forwarded by Courier: title, 1-12 option labels, whether Skip / free text exist. */
function question(v: unknown): CourierQuestion | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const q = v as Record<string, unknown>;
  const title = str(q.title, 500);
  if (!title || !Array.isArray(q.options)) return null;
  const options = q.options.filter((o): o is string => typeof o === 'string' && o.trim() !== '').slice(0, 12).map((o) => o.slice(0, 200));
  if (!options.length) return null;
  const answer = str(q.answer, 200);
  return { title, options, skip: q.skip === true, input: q.input === true, ...(q.answered === true ? { answered: true } : {}), ...(answer ? { answer } : {}) };
}
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

function cleanTargets(raw: unknown): CourierTarget[] {
  if (!Array.isArray(raw)) return [];
  const out: CourierTarget[] = [];
  for (const t of raw.slice(0, 100)) {
    if (!t || typeof t !== 'object') continue;
    const r = t as Record<string, unknown>;
    if (typeof r.targetId !== 'string' || !TARGET_ID.test(r.targetId)) continue;
    out.push({
      targetId: r.targetId,
      site: str(r.site, 32) ?? '',
      label: str(r.label, 80) ?? '',
      conversationKey: str(r.conversationKey, 128),
      pending: r.pending === true,
      expectModel: str(r.expectModel, 80),
      open: r.open === true,
      ready: bool(r.ready),
      busy: bool(r.busy),
      ...(r.site === 'arena' ? { turnState: ['running', 'done', 'stopped'].includes(String(r.turnState)) ? r.turnState as CourierTurnState : null } : {}),
      draft: bool(r.draft),
      model: r.site === 'arena' ? null : r.site === 'chatgpt' ? cleanModelAttribution(r.modelAttribution, 'chatgpt', r.model).label : str(r.model, 80),
      ...(['arena', 'chatgpt'].includes(String(r.site)) ? { modelAttribution: cleanModelAttribution(r.modelAttribution, String(r.site), r.model) } : {}),
      card: str(r.card, 120),
      sessionId: typeof r.sessionId === 'string' && SESSION_ID.test(r.sessionId) ? r.sessionId : null,
    });
  }
  return out;
}

export class CourierHub {
  private conn: WsConnection | null = null;
  private version: string | null = null;
  private since: number | null = null;
  private targets: CourierTarget[] = [];
  private readonly waiters = new Map<string, Waiter>();
  /** Set by close(): a retiring daemon must not take Courier back while it shuts down. */
  private closed = false;
  /** busy 兔底循环的定时器（见 syncBusyLoop）。 */
  private busyTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: {
    sendTimeoutMs?: number;
    log?: (line: string) => void;
    /** Live BlackHole sessions (bind picker and the send check). */
    sessions?: () => CourierSession[];
    /** Chat thread per session (sent messages + web agent replies). */
    messages?: CourierMessages;
    /** Opening a new chat takes longer than a send: page load + composer mount. */
    startTimeoutMs?: number;
    /** Pressing the page stop control waits for the page to answer (compose.stop). */
    stopTimeoutMs?: number;
    /** A forced reload waits for the page to load and its composer to come back (tab.reload). */
    reloadTimeoutMs?: number;
    /** Answering a rating card waits for the page (card.rate). */
    cardTimeoutMs?: number;
    /** Session ↔ web chat pairing (one to one). */
    pairs?: CourierPairs;
    /** Sites added in Courier (courierSites setting). */
    sites?: CourierSitesStore;
    /**
     * Subscription gate (the daemon's local entitlement ticket). Without it everything is allowed.
     * Gated: opening/sending to web chats and new pairings. Existing pairings and threads stay.
     */
    access?: { valid: () => boolean; check: () => Promise<boolean>; until?: () => Promise<number | null> };
    /** The first message reached a new chat: store the draft session for real (`text` names an unnamed one). */
    onStarted?: (sessionId: string, text?: string) => void;
    /**
     * Wraps the typed first message with the selected connection bootstrap (credential, connector
     * name/channel check) so no client has to hold the session credential; the phone never sees it.
     */
    initialPrompt?: (sessionId: string, message: string, kind?: 'connector' | 'sandbox') => { text: string } | { code: string; message: string };
    /** Chat targets or pairings changed (bumps the daemon's change epoch). */
    onChange?: () => void;
    /**
     * A bound chat went from busy to not busy: the web agent's turn is over. The daemon clears the
     * session's 60 s activity window so 「运行中」 ends with the reply, not up to a minute later.
     */
    onIdle?: (sessionId: string) => void;
    /**
     * 会话 state（配对、Courier 目标、busy）可能变了：daemon 据此刷新 feed 的 state。多次通知无害，
     * 由接收方比较快照后决定要不要取新 rev。
     */
    onStateChange?: (sessionId: string) => void;
    /** busy 兔底循环的间隔（默认 7500ms）。 */
    busyRefreshMs?: number;
  } = {}) {}

  /** UI state of one session (see SessionLink). */
  link(sessionId: string): SessionLink {
    const s = this.liveSessions().find((x) => x.id === sessionId);
    const draft = s?.status === 'draft';
    // User-added sites are fill-only (the page gets the prompt, the user sends it): never paired.
    const p = this.opts.pairs?.get(sessionId);
    if (p?.site && !SITES.has(p.site)) return 'direct';
    return this.opts.pairs?.link(sessionId, draft) ?? (draft ? 'new' : this.targets.some((t) => t.sessionId === sessionId) ? 'paired' : 'direct');
  }

  private links(): Record<string, SessionLink> {
    return Object.fromEntries(this.liveSessions().map((s) => [s.id, this.link(s.id)]));
  }

  /** 回复线程的存储（feed/history 处理函数直接查它）。 */
  get messageStore(): CourierMessages | undefined {
    return this.opts.messages;
  }

  /** 绑定了会话的聊天目标所属的会话 id。 */
  private boundSessions(): string[] {
    return this.targets.map((t) => t.sessionId).filter((id): id is string => !!id);
  }

  /** 该会话绑定的聊天目标，没有则 null（feed 的 state 用）。 */
  targetOf(sessionId: string): CourierTarget | null {
    return this.targets.find((t) => t.sessionId === sessionId) ?? null;
  }

  /** 通知 daemon：这些会话的 state 可能变了。回调抛错不影响 hub。 */
  private touch(ids: Iterable<string>): void {
    const notify = this.opts.onStateChange;
    if (!notify) return;
    for (const id of new Set(ids)) {
      try { notify(id); } catch { /* 只是通知 */ }
    }
  }

  /**
   * busy 兔底（session-feed 计划 §8 R11）：Courier 已连接且有绑定的聊天在生成时，定时向它要一次
   * 最新目标状态。否则 busy 的翻转只靠 Courier 主动推送，一旦丢了就会一直卡在「生成中」。
   * 没有 busy 目标、断连或关闭即停。
   */
  private syncBusyLoop(): void {
    const needed = !this.closed && this.conn !== null && this.targets.some((t) => t.sessionId && t.busy === true);
    if (!needed) { this.stopBusyLoop(); return; }
    if (this.busyTimer) return;
    this.busyTimer = setInterval(() => {
      if (!this.conn) { this.stopBusyLoop(); return; }
      void this.request({ type: 'targets.list' }, REFRESH_MS).catch(() => undefined);
    }, this.opts.busyRefreshMs ?? BUSY_REFRESH_MS);
    this.busyTimer.unref();
  }

  private stopBusyLoop(): void {
    if (this.busyTimer) { clearInterval(this.busyTimer); this.busyTimer = null; }
  }

  /** Cut the pairing of a session (any UI). The session stays; it only receives from now on. */
  unpair(sessionId: unknown): { ok: boolean; message: string } {
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return { ok: false, message: '缺少 BlackHole 会话' };
    // An ended session has no pairing left to cut (forget() removed it); never write one back.
    if (!this.liveSessions().some((s) => s.id === sessionId)) return { ok: false, message: '这个 BlackHole 会话已结束' };
    const p = this.opts.pairs?.get(sessionId);
    const t = this.targets.find((x) => x.sessionId === sessionId);
    this.opts.pairs?.set(sessionId, 'unpaired', p?.site ?? t?.site ?? null, p?.conversationKey ?? t?.conversationKey ?? null);
    // 'unpaired' says it plainly: the pairing was cut, so the web chat must not be deleted.
    this.conn?.send(JSON.stringify({ type: 'bind.clear', sessionId, reason: 'unpaired' }));
    this.opts.log?.(`courier: unpaired ${sessionId}`);
    this.opts.onChange?.();
    this.touch([sessionId]);
    return { ok: true, message: '已解除配对' };
  }

  /**
   * The session was deleted/ended in some UI: Courier unbinds its chat tab, and the pairing and
   * the thread are removed for good (nothing to re-pair to).
   *
   * `reason` is what happened to the session, and Courier decides what to do about the web chat:
   * 'revoked' (deleted) may also delete it — but only if the user's Courier setting says so;
   * 'archived' keeps it; 'unpaired' is not an end at all, just a cut pairing. The daemon never
   * deletes a web conversation on its own.
   */
  forget(sessionId: string, opts: { reason?: 'revoked' | 'archived' | 'unpaired' | 'discarded' } = {}): void {
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return;
    const pair = this.opts.pairs?.delete(sessionId) ?? false;
    const thread = this.opts.messages?.drop(sessionId) ?? false;
    const bound = this.targets.some((t) => t.sessionId === sessionId);
    // Until Courier pushes its new list, the cached binding must not route anything to this session.
    for (const t of this.targets) if (t.sessionId === sessionId) t.sessionId = null;
    this.conn?.send(JSON.stringify({ type: 'bind.clear', sessionId, ...(opts.reason ? { reason: opts.reason } : {}) }));
    if (pair || thread || bound) {
      this.opts.log?.(`courier: forgot ended session ${sessionId}`);
      this.opts.onChange?.();
    }
    this.touch([sessionId]);
  }

  /** Courier's bindings are the pairing truth, except ones the user cut (Courier is told again). */
  private syncPairs(): void {
    const pairs = this.opts.pairs;
    if (!pairs) return;
    // Sessions deleted while Courier was away: clear those bindings instead of re-pairing them.
    const live = this.opts.sessions ? new Set(this.liveSessions().map((s) => s.id)) : null;
    for (const t of this.targets) {
      if (!t.sessionId) continue;
      if (live && !live.has(t.sessionId)) {
        // Deleted while Courier was away: same reason as a live delete, so its web chat follows.
        const st = this.opts.sessions?.().find((s) => s.id === t.sessionId)?.status;
        this.forget(t.sessionId, st === 'revoked' || st === 'archived' ? { reason: st } : {});
        continue;
      }
      const p = pairs.get(t.sessionId);
      if (p?.state === 'unpaired') { this.conn?.send(JSON.stringify({ type: 'bind.clear', sessionId: t.sessionId })); continue; }
      if (p?.state !== 'paired' && this.accessState() === 'denied') continue; // no new pairings without a subscription
      pairs.set(t.sessionId, 'paired', t.site || p?.site || null, t.conversationKey ?? p?.conversationKey ?? null);
    }
  }

  /** The Chat page thread of one BlackHole session. */
  messages(sessionId: string): CourierMessage[] {
    return SESSION_ID.test(sessionId) ? this.opts.messages?.list(sessionId) ?? [] : [];
  }

  private record(sessionId: string, text: string, r: CourierResult, target: { site?: string; conversationKey?: string | null } | undefined, at?: number, note?: string, images = 0): string | null {
    return this.opts.messages?.add({
      sessionId, kind: 'user', text, ...(at ? { at } : {}), ...(images ? { images } : {}),
      status: r.ok ? 'sent' : r.sent ? 'unconfirmed' : 'failed',
      site: target?.site ?? null, targetId: r.targetId ?? null, conversationKey: target?.conversationKey ?? null,
      ...(r.ok ? (note ? { message: note } : {}) : { code: r.code, message: r.message }),
    })?.id ?? null;
  }

  /** Live updates of one session's thread (added or updated messages). Returns the unsubscribe function. */
  watch(sessionId: string, fn: (m: CourierMessage) => void): () => void {
    if (!SESSION_ID.test(sessionId) || !this.opts.messages) return () => {};
    return this.opts.messages.subscribe((m) => { if (m.sessionId === sessionId) fn(m); });
  }

  /**
   * Courier forwards web agent reply text; only chats bound to a session are kept. Streamed
   * replies come per segment (the text between tool calls) with `partial` until final.
   */
  private onReply(m: Record<string, unknown>): void {
    const key = str(m.conversationKey, 128);
    const text = typeof m.text === 'string' ? m.text.slice(0, MAX_REPLY) : '';
    if (!key || !text.trim()) return;
    const target = this.targets.find((t) => t.conversationKey === key && t.sessionId);
    if (!target?.sessionId) return;
    // A reply racing a deletion must not bring the removed thread back.
    if (!this.liveSessions().some((s) => s.id === target.sessionId)) return;
    const segment = str(m.segment, 120);
    const base = {
      sessionId: target.sessionId, kind: 'agent' as const, text,
      site: target.site, targetId: target.targetId, conversationKey: key,
      ...(str(m.model, 80) ? { model: str(m.model, 80)! } : {}),
      ...(typeof m.turn === 'number' && Number.isInteger(m.turn) ? { turn: m.turn } : {}),
      ...(question(m.question) ? { question: question(m.question)! } : {}),
      ...(str(m.messageId, 128) ? { messageId: str(m.messageId, 128)! } : {}),
    };
    if (segment) this.opts.messages?.upsertSegment({ ...base, segment, status: m.partial === true ? 'streaming' : 'reply' });
    else this.opts.messages?.add({ ...base, status: 'reply' });
  }

  private liveSessions(): CourierSession[] {
    return (this.opts.sessions?.() ?? []).filter((s) => s.status !== 'revoked' && s.status !== 'archived');
  }

  attach(conn: WsConnection): void {
    // Courier reconnects within a second of close(); on a daemon that is shutting down that socket
    // would pin Courier to it (and keep server.close() from finishing: upgraded sockets are not
    // dropped by closeAllConnections). Refuse it so Courier reaches the replacement daemon.
    if (this.closed) { conn.close(1001); return; }
    let hello = false;
    const helloTimer = setTimeout(() => { if (!hello) conn.close(1008); }, HELLO_MS);
    helloTimer.unref();
    conn.on('message', (text: string) => {
      let m: Record<string, unknown>;
      try { m = JSON.parse(text) as Record<string, unknown>; } catch { return; }
      if (!m || typeof m !== 'object') return;
      if (hello) { if (this.conn === conn) this.onMessage(m); return; }
      if (m.type !== 'hello' || m.client !== COURIER_CLIENT) {
        conn.send(JSON.stringify({ type: 'hello.rejected', message: '不是 BlackHole Courier' }));
        conn.close(1008);
        return;
      }
      if (m.protocol !== COURIER_PROTOCOL) {
        conn.send(JSON.stringify({ type: 'hello.rejected', message: 'Courier 与 BlackHole 版本不匹配，请更新' }));
        conn.close(1008);
        return;
      }
      hello = true;
      clearTimeout(helloTimer);
      const old = this.conn;
      this.conn = conn;
      this.version = str(m.version, 32);
      this.since = Date.now();
      const touched = this.boundSessions();
      this.targets = [];
      // Courier 连上了：所有存活会话的 state.connected 都可能变（草稿、还没绑定的会话也要知道）
      this.touch([...touched, ...this.liveSessions().map((s) => s.id)]);
      this.syncBusyLoop();
      if (old) { this.settleAll('courier_replaced'); old.close(1000); }
      conn.send(JSON.stringify({ type: 'hello.ok', protocol: COURIER_PROTOCOL, ...(this.opts.sites ? { sites: this.opts.sites.list() } : {}), ...(this.opts.access ? { access: (this.lastAccess = this.accessState()) } : {}) }));
      this.opts.log?.(`courier: connected (v${this.version ?? '?'})`);
      void this.sendUntil();
    });
    conn.on('close', () => {
      clearTimeout(helloTimer);
      if (this.conn !== conn) return;
      this.conn = null;
      this.version = null;
      this.since = null;
      const touched = this.boundSessions();
      this.targets = [];
      this.syncBusyLoop();
      // 断连立即刷新 state：曾绑定的会话让 busy 立刻清除（不依赖 busy 兔底循环），所有存活会话的 connected 变为 false
      this.touch([...touched, ...this.liveSessions().map((s) => s.id)]);
      this.settleAll('courier_offline');
      this.opts.messages?.finishStreaming();
      this.opts.log?.('courier: disconnected');
    });
  }

  private onMessage(m: Record<string, unknown>): void {
    switch (m.type) {
      case 'targets':
        {
          const before = JSON.stringify(this.targets);
          const touched = this.boundSessions();
          const wasBusy = new Set(this.targets.filter((t) => t.busy === true && t.sessionId).map((t) => t.targetId));
          this.targets = cleanTargets(m.targets);
          const idle = new Set(this.targets.filter((t) => t.sessionId && t.busy === false && wasBusy.has(t.targetId)).map((t) => t.sessionId!));
          for (const id of idle) { try { this.opts.onIdle?.(id); } catch { /* status only */ } }
          this.syncPairs();
          // UIs that skip polls while nothing changed must still see open/busy/binding changes.
          if (JSON.stringify(this.targets) !== before) this.opts.onChange?.();
          // 旧、新两份绑定的会话都要刷新 state；快照没变时接收方不会取新 rev
          this.touch([...touched, ...this.boundSessions()]);
          this.syncBusyLoop();
        }
        if (typeof m.id === 'string') this.settle(m.id, m);
        return;
      case 'compose.result':
        if (typeof m.id === 'string') this.settle(m.id, m);
        return;
      case 'reply':
        this.onReply(m);
        return;
      case 'access.get': // Courier's overview asks for the subscription end now and then
        void this.sendUntil();
        return;
      case 'sessions.list': // Courier's bind picker
        this.conn?.send(JSON.stringify({ type: 'sessions', id: typeof m.id === 'string' ? m.id : null, sessions: this.liveSessions().slice(0, 200).map((s) => ({ ...s, link: this.link(s.id) })) }));
        return;
      case 'pair': { // a manual binding in Courier (also re-pairs a cut session)
        const sid = typeof m.sessionId === 'string' && SESSION_ID.test(m.sessionId) ? m.sessionId : null;
        if (sid && this.accessState() === 'denied' && this.link(sid) !== 'paired') return; // no new pairings without a subscription
        if (!SITES.has(str(m.site, 32) ?? '')) return; // user-added sites are fill-only, never paired
        if (sid && this.liveSessions().some((x) => x.id === sid)) {
          this.opts.onStarted?.(sid); // a draft picked in Courier is kept for real
          this.opts.pairs?.set(sid, 'paired', str(m.site, 32), str(m.conversationKey, 128));
          this.touch([sid]);
        }
        return;
      }
      case 'unpair': { // unbound in Courier
        const sid = typeof m.sessionId === 'string' && SESSION_ID.test(m.sessionId) ? m.sessionId : null;
        if (sid && this.liveSessions().some((x) => x.id === sid)) { const p = this.opts.pairs?.get(sid); this.opts.pairs?.set(sid, 'unpaired', p?.site ?? null, p?.conversationKey ?? null); }
        return;
      }
      case 'sites.put': { // 检测此页面 confirmed in Courier, or it learnt a stop button / chat address
        const r = this.opts.sites?.put(m.site);
        if (r && !r.ok) this.opts.log?.(`courier: site not saved (${r.message ?? 'invalid'})`);
        return;
      }
      case 'sites.remove': { // deleted in Courier's popup
        const r = this.opts.sites?.remove(m.id);
        if (r && !r.ok) this.opts.log?.(`courier: site not removed (${r.message ?? 'invalid'})`);
        return;
      }
      case 'ping':
        this.conn?.send(JSON.stringify({ type: 'pong', t: m.t }));
        return;
      default:
    }
  }

  private settle(id: string, value: Record<string, unknown>): void {
    const w = this.waiters.get(id);
    if (!w) return;
    clearTimeout(w.timer);
    this.waiters.delete(id);
    w.resolve(value);
  }

  private settleAll(code: string): void {
    for (const id of [...this.waiters.keys()]) this.settle(id, { __local: code });
  }

  /** Send one message and wait for its reply, a local failure, or the timeout. */
  private request(msg: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    const id = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.settle(id, { __local: 'timeout' }), timeoutMs);
      timer.unref();
      this.waiters.set(id, { resolve, timer });
      if (!this.conn?.send(JSON.stringify({ ...msg, id }))) this.settle(id, { __local: 'courier_offline' });
    });
  }

  get connected(): boolean {
    return this.conn !== null;
  }

  /** Ask Courier for fresh target states (open/busy/draft change without a push); falls back to the cache. */
  async status(refresh = true): Promise<CourierStatus> {
    if (refresh && this.conn) await this.request({ type: 'targets.list' }, REFRESH_MS);
    return { connected: this.conn !== null, targets: this.targets, links: this.links(), sites: this.siteChoices(), asking: this.asking() };
  }

  /** The newest question since the last user message is still open (not answered on the page). */
  private asking(): string[] {
    const out: string[] = [];
    for (const s of this.liveSessions()) {
      // 只看最近一条「用户消息或带提问的消息」，不读整个会话：是带未答问题的 agent 消息才算在等回答
      const m = this.opts.messages?.latestTurnMarker(s.id);
      if (m && m.kind !== 'user' && m.question && !m.question.answered) out.push(s.id);
    }
    return out;
  }

  /** Built-in sites, then the ones added in Courier. */
  siteChoices(): CourierStatus['sites'] {
    const custom = (this.opts.sites?.list() ?? []).map((s) => ({ id: s.id, name: s.name, custom: true, template: templateForSite(s.id, s.origin) }));
    return [...BUILTIN_SITE_NAMES.map((s) => ({ ...s, custom: false, template: templateForSite(s.id) })), ...custom];
  }

  /** 'ok' | 'denied' for Courier: it hides binding and auto-draw when denied. No reason, no dates. */
  accessState(): 'ok' | 'denied' {
    return !this.opts.access || this.opts.access.valid() ? 'ok' : 'denied';
  }
  private lastAccess: 'ok' | 'denied' | null = null;
  /** The entitlement ticket changed: tell Courier when the answer flipped. */
  pushAccess(): void {
    const a = this.accessState();
    if (a === this.lastAccess) return;
    this.lastAccess = a;
    this.conn?.send(JSON.stringify({ type: 'access', access: a }));
    this.opts.onChange?.();
    void this.sendUntil();
  }
  /**
   * Subscription end (ms epoch, from the daemon's cached account view) for Courier's overview line.
   * Sent after hello, on ticket changes and when Courier asks (access.get); null = unknown.
   */
  async sendUntil(): Promise<void> {
    const conn = this.conn;
    if (!conn || !this.opts.access?.until) return;
    const until = await this.opts.access.until().catch(() => null);
    // The account already shows a live subscription but the local ticket still says denied (e.g. the
    // subscription was just renewed): renew the ticket now instead of at its next scheduled check, so
    // Courier's binding/抽卡 come back together with the new end time (Courier asks once a minute).
    if (this.accessState() === 'denied' && Number.isFinite(until) && (until as number) > Date.now()) await this.opts.access.check().catch(() => false);
    if (this.conn !== conn) return;
    conn.send(JSON.stringify({ type: 'access', access: this.accessState(), until: Number.isFinite(until) ? until : null }));
  }
  private async denied(): Promise<boolean> {
    return !!this.opts.access && !(await this.opts.access.check());
  }

  /** The courierSites setting changed (any UI): Courier reconciles, unregistering deleted sites. */
  pushSites(): void {
    if (this.opts.sites) this.conn?.send(JSON.stringify({ type: 'sites', sites: this.opts.sites.list() }));
  }

  /**
   * Send one message to a chat bound to `sessionId`. The session check is the security gate:
   * a chat only takes messages on behalf of the BlackHole session it was bound to.
   */
  // Sent images, in memory only, so local UIs can show them above the message (never on disk;
  // gone after a daemon restart, when the UIs fall back to the count). Oldest dropped past the cap.
  private sent = new Map<string, { mime: string; data: Buffer }[]>();
  private keepSent(messageId: string, list: { mime: string; data: Buffer }[]): void {
    this.sent.set(messageId, list);
    let total = 0;
    for (const v of this.sent.values()) for (const x of v) total += x.data.length;
    for (const [k, v] of this.sent) {
      if (total <= SENT_IMAGE_CAP || k === messageId) break;
      for (const x of v) total -= x.data.length;
      this.sent.delete(k);
    }
  }
  /** One image of a sent message (local UIs only), or null when unknown / dropped. */
  sentImage(messageId: string, n: number): { mime: string; data: Buffer } | null {
    return this.sent.get(messageId)?.[n] ?? null;
  }

  // Uploaded images, in memory only: they live until sent or IMAGE_TTL_MS, never on disk.
  private images = new Map<string, { mime: string; data: Buffer; at: number }>();
  addImage(mime: string, data: Buffer): { id: string } | { code: string; message: string } {
    if (!IMAGE_TYPES.has(mime)) return { code: 'invalid_input', message: '只支持 PNG、JPEG、WebP、GIF 图片' };
    if (!data.length || data.length > MAX_IMAGE_BYTES) return { code: 'image_too_large', message: '图片不能超过 10 MB' };
    const now = Date.now();
    for (const [k, v] of this.images) if (now - v.at > IMAGE_TTL_MS) this.images.delete(k);
    let total = data.length;
    for (const v of this.images.values()) total += v.data.length;
    if (total > MAX_STORED_BYTES) return { code: 'busy', message: '待发送的图片太多，请先发送或稍后再试' };
    const id = randomUUID();
    this.images.set(id, { mime, data, at: now });
    return { id };
  }

  async send(input: { targetId: unknown; text: unknown; sessionId: unknown; activate?: unknown; images?: unknown }): Promise<CourierResult> {
    const fail = (code: string, message: string, sent = false): CourierResult => ({ ok: false, code, message, sent });
    if (typeof input.targetId !== 'string' || !TARGET_ID.test(input.targetId)) return fail('invalid_input', '请选择发送目标');
    if (typeof input.sessionId !== 'string' || !SESSION_ID.test(input.sessionId)) return fail('invalid_input', '缺少 BlackHole 会话');
    if (typeof input.text !== 'string' || !input.text.trim()) return fail('invalid_input', '消息内容为空');
    if (input.text.length > MAX_TEXT) return fail('text_too_long', `消息超过 ${MAX_TEXT} 个字符`);
    if (!this.conn) return fail('courier_offline', '浏览器里的 Courier 未连接');
    if (await this.denied()) return fail(SUBSCRIPTION_REQUIRED, SUBSCRIPTION_MESSAGE);
    if (this.waiters.size >= MAX_PENDING) return fail('busy', '还有消息在发送中，请稍后');
    const session = this.liveSessions().find((s) => s.id === input.sessionId);
    if (!session) return fail('session_inactive', '这个 BlackHole 会话已结束');
    const target = this.targets.find((t) => t.targetId === input.targetId);
    if (!target) return fail('unknown_target', '这个网页会话已解除绑定');
    if (target.sessionId !== input.sessionId) return fail('session_mismatch', '这个网页会话没有绑定到当前 BlackHole 会话');
    if (!SITES.has(target.site)) return fail('fill_only', '这个网站不绑定：请在网页中手动发送');
    const ids = input.images == null ? [] : input.images;
    if (!Array.isArray(ids) || ids.length > MAX_IMAGES || ids.some((x) => typeof x !== 'string')) return fail('invalid_input', `最多 ${MAX_IMAGES} 张图片`);
    const imgs = (ids as string[]).map((k) => this.images.get(k));
    if (imgs.some((x) => !x)) return fail('image_expired', '图片已过期，请重新粘贴');
    const images = imgs.map((x, i) => ({ mime: x!.mime, name: `image-${i + 1}.${x!.mime.split('/')[1]!.replace('jpeg', 'jpg')}`, data: x!.data.toString('base64') }));
    for (const k of ids as string[]) this.images.delete(k);
    const at = Date.now();
    const sendTimeoutMs = this.opts.sendTimeoutMs ?? 45000;
    const r = await this.request(
      // sessionName: Courier keeps the name on the binding current (a rename since binding) - no polling.
      { type: 'compose.send', deadline: at + Math.max(0, sendTimeoutMs - Math.min(2000, sendTimeoutMs / 10)), target: { targetId: input.targetId }, sessionId: input.sessionId, sessionName: session.name, text: input.text, ...(images.length ? { images } : {}), options: { activate: input.activate === true } },
      sendTimeoutMs,
    );
    const out = this.outcome(r, input.targetId);
    const id = this.record(input.sessionId, input.text, out, target, at, undefined, images.length);
    if (id && imgs.length) this.keepSent(id, imgs.map((x) => ({ mime: x!.mime, data: x!.data })));
    return out;
  }

  private outcome(r: Record<string, unknown>, targetId: string | undefined): CourierResult {
    const local = r.__local;
    const base = targetId ? { targetId } : {};
    if (local === 'timeout') return { ok: false, code: 'timeout', message: '浏览器没有回应，消息可能已经发出，请先看一眼页面再决定是否重发', sent: true, ...base };
    if (local === 'courier_replaced' || local === 'courier_offline') return { ok: false, code: 'courier_offline', message: 'Courier 连接中断，消息可能已经发出，请先看一眼页面', sent: true, ...base };
    const ok = r.ok === true;
    const code = str(r.code, 40) ?? undefined;
    const tid = typeof r.targetId === 'string' && TARGET_ID.test(r.targetId) ? r.targetId : targetId;
    return {
      ok,
      ...(code ? { code } : {}),
      message: str(r.message, 300) ?? (ok ? '已发送' : '发送失败'),
      sent: ok || code === 'not_confirmed',
      ...(tid ? { targetId: tid } : {}),
    };
  }

  /**
   * First message of a session that has no web chat yet: Courier opens a new chat on `site`,
   * binds it to `sessionId` and sends `text` there. Later messages go through send().
   */
  async start(input: { sessionId: unknown; text: unknown; site?: unknown; display?: unknown; template?: unknown }): Promise<CourierResult> {
    const at = Date.now(); // the thread orders by send time, not by when the page confirmed
    // `display`: what the user typed (the thread and the session name show it, never the connector prompt).
    const display = typeof input.display === 'string' && input.display.trim() ? input.display.slice(0, MAX_TEXT) : null;
    const fail = (code: string, message: string): CourierResult => ({ ok: false, code, message, sent: false });
    if (typeof input.sessionId !== 'string' || !SESSION_ID.test(input.sessionId)) return fail('invalid_input', '缺少 BlackHole 会话');
    if (typeof input.text !== 'string' || !input.text.trim()) return fail('invalid_input', '消息内容为空');
    if (input.text.length > MAX_TEXT) return fail('text_too_long', `消息超过 ${MAX_TEXT} 个字符`);
    const site = input.site == null ? 'arena' : input.site;
    if (typeof site !== 'string' || !(SITES.has(site) || this.opts.sites?.list().some((s) => s.id === site))) return fail('invalid_input', '不支持这个网站');
    if (!this.conn) return fail('courier_offline', '浏览器里的 Courier 未连接');
    if (await this.denied()) return fail(SUBSCRIPTION_REQUIRED, SUBSCRIPTION_MESSAGE);
    if (this.waiters.size >= MAX_PENDING) return fail('busy', '还有消息在发送中，请稍后');
    const session = this.liveSessions().find((s) => s.id === input.sessionId);
    if (!session) return fail('session_inactive', '这个 BlackHole 会话已结束');
    if (this.link(session.id) !== 'new') return fail('already_linked', '这个会话已经连接过网页会话，不能再新开');
    // `text` is what the user typed; the daemon builds the prompt around it. The template follows
    // the site (siteTemplate.ts: connector for ChatGPT/Claude/Manus, sandbox otherwise); a
    // `template` sent by older clients is ignored.
    let text = input.text;
    let shown = display;
    if (input.template != null && input.template !== 'connector' && input.template !== 'sandbox') return fail('invalid_input', '不支持这个模板');
    if (this.opts.initialPrompt) {
      const kind = templateForSite(site, this.opts.sites?.list().find((s) => s.id === site)?.origin);
      const p = this.opts.initialPrompt(session.id, input.text, kind);
      if ('code' in p) return fail(p.code, p.message);
      if (p.text.length > MAX_TEXT) return fail('text_too_long', `消息超过 ${MAX_TEXT} 个字符`);
      shown = input.text.slice(0, MAX_TEXT);
      text = p.text;
    }
    const r = await this.request(
      // An unnamed draft is named from this first message once it is sent (onStarted → commitDraft).
      // Courier stores the name on the binding it makes now, so send it the final name up front.
      { type: 'compose.start', site, session: { id: session.id, name: (session.status === 'draft' && session.named === false ? draftName(shown) : null) ?? session.name }, text },
      this.opts.startTimeoutMs ?? 90000,
    );
    const out = this.outcome(r, undefined);
    const target = this.targets.find((t) => t.targetId === out.targetId);
    const conversationKey = target?.conversationKey ?? str(r.conversationKey, 128);
    // A user-added site only gets the prompt filled in (the user sends it): the session is kept but
    // not paired, so it stays direct - no composer, no replies read.
    const fillOnly = !SITES.has(site);
    if (out.ok || out.sent) {
      // Sent into a new chat: the session exists for real now and is paired with that chat.
      this.opts.onStarted?.(session.id, shown ?? undefined);
      if (!fillOnly) this.opts.pairs?.set(session.id, 'paired', site, conversationKey);
    }
    this.record(session.id, shown ?? text, out, fillOnly ? { site, conversationKey: null } : target ?? { site, conversationKey }, at, fillOnly && out.ok ? out.message : undefined);
    return out;
  }

  /**
   * Ask the paired web chat to press its own stop control. Same session gate as send(): the chat must
   * be bound to the BlackHole session that asks, and it must be in the last list Courier pushed.
   * `not_running` means the page had no visible stop control - the turn may already be over.
   */
  async stop(input: { sessionId: unknown; targetId?: unknown }): Promise<CourierResult> {
    const fail = (code: string, message: string): CourierResult => ({ ok: false, code, message, sent: false });
    if (typeof input.sessionId !== 'string' || !SESSION_ID.test(input.sessionId)) return fail('invalid_input', '缺少 BlackHole 会话');
    if (input.targetId != null && (typeof input.targetId !== 'string' || !TARGET_ID.test(input.targetId))) return fail('invalid_input', '目标格式不对');
    if (!this.conn) return fail('courier_offline', '浏览器里的 Courier 未连接');
    if (!this.liveSessions().some((s) => s.id === input.sessionId)) return fail('session_inactive', '这个 BlackHole 会话已结束');
    const target = input.targetId
      ? this.targets.find((t) => t.targetId === input.targetId)
      : this.targets.find((t) => t.sessionId === input.sessionId);
    if (!target) return fail('unknown_target', '这个会话还没有配对的网页会话');
    if (target.sessionId !== input.sessionId) return fail('session_mismatch', '这个网页会话没有绑定到当前 BlackHole 会话');
    if (this.waiters.size >= MAX_PENDING) return fail('busy', '还有操作在进行中，请稍后');
    const r = await this.request({ type: 'compose.stop', target: { targetId: target.targetId }, sessionId: input.sessionId }, this.opts.stopTimeoutMs ?? 12000);
    return this.outcome(r, target.targetId);
  }

  /**
   * Force-reload the paired web chat (the web agent's task goes on); a closed chat is opened again.
   * Same session gate as stop(). Never refused because the page is generating.
   */
  async reload(input: { sessionId: unknown; targetId?: unknown }): Promise<CourierResult> {
    return this.control('tab.reload', input, this.opts.reloadTimeoutMs ?? 40000);
  }

  /** Answer the paired chat's open rating card with the auto-rate rule (Courier does the page part). */
  async rateCard(input: { sessionId: unknown; targetId?: unknown }): Promise<CourierResult> {
    return this.control('card.rate', input, this.opts.cardTimeoutMs ?? 15000);
  }

  /** A command for one paired chat (reload / rating card): same session gate as stop(). */
  private async control(type: 'tab.reload' | 'card.rate', input: { sessionId: unknown; targetId?: unknown }, timeoutMs: number): Promise<CourierResult> {
    const fail = (code: string, message: string): CourierResult => ({ ok: false, code, message, sent: false });
    if (typeof input.sessionId !== 'string' || !SESSION_ID.test(input.sessionId)) return fail('invalid_input', '缺少 BlackHole 会话');
    if (input.targetId != null && (typeof input.targetId !== 'string' || !TARGET_ID.test(input.targetId))) return fail('invalid_input', '目标格式不对');
    if (!this.conn) return fail('courier_offline', '浏览器里的 Courier 未连接');
    if (!this.liveSessions().some((s) => s.id === input.sessionId)) return fail('session_inactive', '这个 BlackHole 会话已结束');
    const target = input.targetId
      ? this.targets.find((t) => t.targetId === input.targetId)
      : this.targets.find((t) => t.sessionId === input.sessionId);
    if (!target) return fail('unknown_target', '这个会话还没有配对的网页会话');
    if (target.sessionId !== input.sessionId) return fail('session_mismatch', '这个网页会话没有绑定到当前 BlackHole 会话');
    if (this.waiters.size >= MAX_PENDING) return fail('busy', '还有操作在进行中，请稍后');
    const r = await this.request({ type, target: { targetId: target.targetId }, sessionId: input.sessionId }, timeoutMs);
    if (r.__local === 'timeout') return { ...fail('timeout', '浏览器没有回应，请看一眼页面'), targetId: target.targetId };
    if (r.__local) return { ...fail('courier_offline', 'Courier 连接中断'), targetId: target.targetId };
    return { ...this.outcome(r, target.targetId), sent: false };
  }

  close(): void {
    this.closed = true;
    this.stopBusyLoop();
    this.settleAll('courier_offline');
    this.conn?.close(1001);
    this.conn = null;
  }
}

