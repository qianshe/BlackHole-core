import { randomUUID } from 'node:crypto';
import type { WsConnection } from './ws.js';

/**
 * The one Courier extension connected to this daemon, and the chats it has bound.
 * Courier decides whether a send is safe (strict targeting); the hub only relays.
 */
export const COURIER_PROTOCOL = 1;
export const COURIER_CLIENT = 'blackhole-courier';
export const MAX_TEXT = 20000;
const TARGET_ID = /^[A-Za-z0-9-]{1,64}$/;
const HELLO_MS = 5000;
const REFRESH_MS = 3000;
const MAX_PENDING = 8;

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
  draft: boolean | null;
  model: string | null;
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
}

type Waiter = { resolve: (v: Record<string, unknown>) => void; timer: NodeJS.Timeout };

const str = (v: unknown, max: number): string | null => (typeof v === 'string' ? v.slice(0, max) : null);
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
      draft: bool(r.draft),
      model: str(r.model, 80),
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

  constructor(private readonly opts: { sendTimeoutMs?: number; log?: (line: string) => void } = {}) {}

  attach(conn: WsConnection): void {
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
      this.targets = [];
      if (old) { this.settleAll('courier_replaced'); old.close(1000); }
      conn.send(JSON.stringify({ type: 'hello.ok', protocol: COURIER_PROTOCOL }));
      this.opts.log?.(`courier: connected (v${this.version ?? '?'})`);
    });
    conn.on('close', () => {
      clearTimeout(helloTimer);
      if (this.conn !== conn) return;
      this.conn = null;
      this.version = null;
      this.since = null;
      this.targets = [];
      this.settleAll('courier_offline');
      this.opts.log?.('courier: disconnected');
    });
  }

  private onMessage(m: Record<string, unknown>): void {
    switch (m.type) {
      case 'targets':
        this.targets = cleanTargets(m.targets);
        if (typeof m.id === 'string') this.settle(m.id, m);
        return;
      case 'compose.result':
        if (typeof m.id === 'string') this.settle(m.id, m);
        return;
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
    return { connected: this.conn !== null, targets: this.targets };
  }

  async send(input: { targetId: unknown; text: unknown; activate?: unknown }): Promise<CourierResult> {
    const fail = (code: string, message: string, sent = false): CourierResult => ({ ok: false, code, message, sent });
    if (typeof input.targetId !== 'string' || !TARGET_ID.test(input.targetId)) return fail('invalid_input', '请选择发送目标');
    if (typeof input.text !== 'string' || !input.text.trim()) return fail('invalid_input', '消息内容为空');
    if (input.text.length > MAX_TEXT) return fail('text_too_long', `消息超过 ${MAX_TEXT} 个字符`);
    if (!this.conn) return fail('courier_offline', '浏览器里的 Courier 未连接');
    if (this.waiters.size >= MAX_PENDING) return fail('busy', '还有消息在发送中，请稍后');
    const r = await this.request(
      { type: 'compose.send', target: { targetId: input.targetId }, text: input.text, options: { activate: input.activate === true } },
      this.opts.sendTimeoutMs ?? 45000,
    );
    const local = r.__local;
    if (local === 'timeout') return fail('timeout', '浏览器没有回应，消息可能已经发出，请先看一眼页面再决定是否重发', true);
    if (local === 'courier_replaced' || local === 'courier_offline') return fail('courier_offline', 'Courier 连接中断，消息可能已经发出，请先看一眼页面', true);
    const ok = r.ok === true;
    const code = str(r.code, 40) ?? undefined;
    return {
      ok,
      ...(code ? { code } : {}),
      message: str(r.message, 300) ?? (ok ? '已发送' : '发送失败'),
      sent: ok || code === 'not_confirmed',
      targetId: input.targetId,
    };
  }

  close(): void {
    this.settleAll('courier_offline');
    this.conn?.close(1001);
    this.conn = null;
  }
}
