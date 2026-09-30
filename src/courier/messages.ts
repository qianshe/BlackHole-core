import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * The chat thread of each BlackHole session as the Chat page shows it: what was sent to the
 * web chat, and the web agent's replies. Kept in one JSON file next to the database.
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

const PER_SESSION = 200;
const MAX_SESSIONS = 500;
const SAVE_MS = 400;

export class CourierMessages {
  private readonly bySession = new Map<string, CourierMessage[]>();
  private timer: NodeJS.Timeout | null = null;
  private readonly listeners = new Set<CourierMessageListener>();

  constructor(private readonly file: string | null, private readonly log?: (line: string) => void) {
    if (!file) return;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { sessions?: Record<string, CourierMessage[]> };
      for (const [id, list] of Object.entries(raw.sessions ?? {})) {
        if (Array.isArray(list)) this.bySession.set(id, list.filter((m) => m && typeof m.text === 'string').slice(-PER_SESSION));
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') log?.(`courier: message log unreadable, starting empty (${(e as Error).message})`);
    }
  }

  list(sessionId: string): CourierMessage[] {
    return this.bySession.get(sessionId) ?? [];
  }

  /** The session is gone (deleted/ended): drop its whole thread. */
  drop(sessionId: string): boolean {
    if (!this.bySession.delete(sessionId)) return false;
    this.schedule();
    return true;
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
    const list = this.bySession.get(m.sessionId);
    // Same segment, or the same page message seen again after a reload (the segment is per page
    // load, the page's message id is not). A final reply stored before message ids were sent is
    // matched once by its text and gets the id.
    const old = list?.find((x) => x.segment === m.segment && x.conversationKey === m.conversationKey)
      ?? (m.messageId ? list?.find((x) => x.kind === 'agent' && x.messageId === m.messageId && x.conversationKey === m.conversationKey) : undefined)
      ?? (m.messageId && m.status === 'reply' ? list?.find((x) => x.kind === 'agent' && !x.messageId && x.status === 'reply' && x.conversationKey === m.conversationKey && x.text === m.text) : undefined);
    if (!old) return this.add(m);
    if (m.messageId && old.messageId !== m.messageId) { old.messageId = m.messageId; this.schedule(); }
    if (old.status === 'reply' && m.status === 'streaming') return null; // a late partial after the final one
    const next: CourierMessage = { ...old, text: m.text, status: m.status, ...(m.model ? { model: m.model } : {}), ...(m.turn != null ? { turn: m.turn } : {}), ...(m.question ? { question: m.question } : {}) };
    if (next.text === old.text && next.status === old.status && next.model === old.model && next.turn === old.turn
      && JSON.stringify(next.question) === JSON.stringify(old.question)) return null;
    Object.assign(old, next);
    this.schedule();
    this.notify(old);
    return old;
  }

  /** Courier went away mid-reply: segments still streaming are as complete as they will get. */
  finishStreaming(): void {
    for (const list of this.bySession.values()) {
      for (const m of list) {
        if (m.status !== 'streaming') continue;
        m.status = 'reply';
        this.notify(m);
        this.schedule();
      }
    }
  }

  add(m: Omit<CourierMessage, 'id' | 'at'> & { at?: number }): CourierMessage | null {
    const list = this.bySession.get(m.sessionId) ?? [];
    if (m.kind === 'agent' && m.turn != null && !m.segment && list.some((x) => x.kind === 'agent' && x.conversationKey === m.conversationKey && x.turn === m.turn)) return null;
    const full: CourierMessage = { ...m, id: randomUUID(), at: m.at ?? Date.now() };
    // A send is recorded once the page confirms it, often after the reply started: keep time order.
    let i = list.length;
    while (i > 0 && list[i - 1]!.at > full.at) i--;
    list.splice(i, 0, full);
    if (list.length > PER_SESSION) list.splice(0, list.length - PER_SESSION);
    this.bySession.delete(m.sessionId); // re-insert: Map order = most recently active last
    this.bySession.set(m.sessionId, list);
    while (this.bySession.size > MAX_SESSIONS) this.bySession.delete(this.bySession.keys().next().value as string);
    this.schedule();
    this.notify(full);
    return full;
  }

  private schedule(): void {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, SAVE_MS);
    this.timer.unref();
  }

  flush(): void {
    if (!this.file) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, sessions: Object.fromEntries(this.bySession) }));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      this.log?.(`courier: message log not saved (${(e as Error).message})`);
    }
  }
}
