/**
 * 会话 feed 的客户端共享模块（session-feed 计划 §7）：纯 TypeScript，没有 React 依赖，手机、Web 控制台、VS Code 三端共用。
 *
 * 客户端自己保存 offset，只向服务端要增量；请求失败、渠道断开都不清空已显示的内容，恢复后用原 offset 补齐。
 * 本地状态分两段：head（feed 维护）和 history（/history 翻出来的更早内容），显示时按时间线键合并。
 *
 * 只用可擦除的 TS 语法（不用 enum、参数属性），因为测试直接用 Node 跑 .ts。
 */

// ---------- 时间线键（与守护进程 src/feed/timeline.ts 一致，有对拍测试） ----------

export type TimelineKind = 'c' | 'm';
export interface TimelineKey { t: number; kind: TimelineKind; id: string }

export function compareKeys(a: TimelineKey, b: TimelineKey): number {
  if (a.t !== b.t) return a.t - b.t;
  if (a.kind !== b.kind) return a.kind === 'c' ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export const encodeKey = (k: TimelineKey): string => `${k.t}.${k.kind}.${k.id}`;

/** 调用的 created_at 可能是毫秒数（VS Code）或 ISO 字符串（Web/手机）。 */
export function timeOf(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Date.parse(v) || 0;
  return 0;
}

// ---------- 类型 ----------

export interface FeedCallRow { id: string; created_at: unknown }
export interface FeedMessageRow { id: string; at: number }

export interface FeedEntry<C, M> {
  /** 编码后的时间线键，翻页游标就是它。 */
  key: string;
  t: number;
  kind: TimelineKind;
  id: string;
  call?: C;
  message?: M;
}

export interface FeedSnapshot<C, M, S> {
  /** 第一次响应已到。 */
  loaded: boolean;
  /** 最近一次失败（成功后清空）；已显示的内容不会因失败被清空。 */
  error: unknown;
  /** 按时间线键升序。 */
  entries: FeedEntry<C, M>[];
  calls: C[];
  messages: M[];
  state: S | null;
  /** 还有没加载的更早内容。 */
  hasOlder: boolean;
  loadingOlder: boolean;
  /** 上一次翻页失败（显示「加载失败，点此重试」）。 */
  olderError: boolean;
  /** 循环已结束：会话已结束、一次性读取，或遇到 401/403/404。 */
  stopped: boolean;
}

export interface FeedEnv {
  now(): number;
  /** 等 ms 毫秒；`signal` 中止时立即结束（不报错）。 */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  visible(): boolean;
  /** 页面隐藏/显示、网络离线/恢复；返回取消订阅。 */
  subscribe(cb: (event: 'hide' | 'show' | 'offline' | 'online') => void): () => void;
}

export interface FeedStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export interface FeedConfig<C extends FeedCallRow, M extends FeedMessageRow> {
  sessionId: string;
  /**
   * GET 请求（`path` 从 /sessions/... 开始）。HTTP 失败时抛带数字 `status` 的错误；网络错误没有 status。
   */
  fetchJson: (path: string, signal: AbortSignal) => Promise<unknown>;
  /** feed full 的头部条数与 history 每页条数：手机 20，Web/VS Code 50。 */
  limit: number;
  /** 初始长轮询秒数（缺省 25）；0 = 只用短轮询。 */
  wait?: number;
  /** 一次性读取：只做一次 full，不进循环（已结束的会话）。 */
  once?: boolean;
  /** 自适应等待的结果保存在这里（按渠道 origin 的 key）；不提供则只在内存里。 */
  storage?: FeedStorage;
  storageKey?: string;
  env?: FeedEnv;
  /** 401/403/404：会话没了或要重新登录，交给上层的 lost()。 */
  onFatal?: (error: unknown) => void;
}

// ---------- 常量（计划 §7） ----------

export const MAX_WAIT = 25;
export const HEAD_MAX = 300;
export const TOTAL_MAX = 2000;
export const SHORT_POLL_MS = 2500;
export const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];
/** 请求已挂起这么久再被断，才算「被渠道掰断」；更快的失败（如 daemon 重启时隧道立即返回的 502）是源站故障。 */
export const CUT_MIN_HELD_MS = 5000;
export const CUT_MARGIN_MS = 3000;
export const CUT_STATUSES = [502, 504, 524];
export const RESTORE_MS = 10 * 60_000;
const ENDED = new Set(['revoked', 'archived']);

/** 25→12→6→0 */
export const halve = (w: number): number => (w <= 6 ? 0 : Math.floor(w / 2));
/** 恢复时往回走一档：0→6→12→25 */
export const grow = (w: number, max: number): number => Math.min(max, w === 0 ? 6 : w < 12 ? 12 : max);

interface Segment<C, M> { calls: Map<string, C>; messages: Map<string, M> }
const emptySegment = <C, M>(): Segment<C, M> => ({ calls: new Map(), messages: new Map() });

interface FeedResponse {
  boot: string;
  offset: number;
  wait?: number;
  retry_ms?: number;
  full: boolean;
  more?: boolean;
  older?: string | null;
  calls: unknown[];
  messages: unknown[];
  state?: unknown;
}

function isFeedResponse(v: unknown): v is FeedResponse {
  const r = v as Partial<FeedResponse> | null;
  return !!r && typeof r === 'object' && typeof r.boot === 'string' && typeof r.offset === 'number' && typeof r.full === 'boolean'
    && Array.isArray(r.calls) && Array.isArray(r.messages);
}

/** 等 ms 毫秒；`signal` 中止时立即结束（不报错）。浏览器和 VS Code 扩展宿主共用。 */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const done = (): void => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

// 只用到的最小 DOM 形状：VS Code 扩展的编译环境没有 DOM 类型库，这里不能直接写 document / window。
interface DomTarget {
  hidden?: boolean;
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
}

/** 默认环境：浏览器。没有 document 时（Node）一直可见、不订阅任何事件。 */
export function browserEnv(): FeedEnv {
  const g = globalThis as { document?: DomTarget; window?: DomTarget };
  const doc = g.document;
  const win = g.window;
  return {
    now: () => Date.now(),
    sleep: abortableSleep,
    visible: () => !doc?.hidden,
    subscribe: (cb) => {
      if (!doc || !win) return () => undefined;
      const vis = (): void => cb(doc.hidden ? 'hide' : 'show');
      const off = (): void => cb('offline');
      const on = (): void => cb('online');
      doc.addEventListener('visibilitychange', vis);
      win.addEventListener('offline', off);
      win.addEventListener('online', on);
      return () => {
        doc.removeEventListener('visibilitychange', vis);
        win.removeEventListener('offline', off);
        win.removeEventListener('online', on);
      };
    },
  };
}

/**
 * 一个会话的客户端 feed。`start()` 开始循环，`stop()` 结束；`subscribe()` + `snapshot()` 给 UI 用。
 */
export class SessionFeed<C extends FeedCallRow = FeedCallRow, M extends FeedMessageRow = FeedMessageRow, S = unknown> {
  private readonly cfg: FeedConfig<C, M>;
  private readonly env: FeedEnv;
  private head: Segment<C, M> = emptySegment();
  private history: Segment<C, M> = emptySegment();
  private state: S | null = null;
  private offset: number | null = null;
  private boot: string | null = null;
  private loaded = false;
  private error: unknown = null;
  private hasOlder = false;
  private loadingOlder = false;
  private olderError = false;
  /** history 被丢弃或重置时 +1，让飞行中的翻页结果作废。 */
  private generation = 0;

  private wait: number;
  private readonly maxWait: number;
  private restoreAt = 0;
  private cuts = 0;
  private failures = 0;

  private loopId = 0;
  private stopped = true;
  private halted = false; // 循环已自行结束（once / 会话结束 / 致命错误）
  private fatalSent = false;
  private nextAt = 0;
  private lastStart = 0;
  private retryMs = 0;
  private lastMore = false;
  private inflight: { ctrl: AbortController; reason: 'hide' | 'kick' | 'stop' | null; startedAt: number } | null = null;
  private sleeper: AbortController | null = null;
  private visibleWaiter: (() => void) | null = null;
  private unreliableAt = 0;
  private unsubscribe: (() => void) | null = null;
  private readonly listeners = new Set<() => void>();
  private cached: FeedSnapshot<C, M, S> | null = null;
  private lastSnap: FeedSnapshot<C, M, S> | null = null;
  private historyCtrl: AbortController | null = null;

  constructor(config: FeedConfig<C, M>) {
    this.cfg = config;
    this.env = config.env ?? browserEnv();
    this.maxWait = Math.max(0, config.wait ?? MAX_WAIT);
    this.wait = this.maxWait;
    const saved = this.readSaved();
    if (saved) { this.wait = Math.min(this.maxWait, saved.wait); this.restoreAt = saved.at + RESTORE_MS; }
  }

  // ---------- 对外接口 ----------

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  snapshot(): FeedSnapshot<C, M, S> {
    if (this.cached) return this.cached;
    const fresh = this.entries();
    // 只是 loadingOlder、error 这类状态变了、条目没变时复用上一份的数组：UI 用 entries 的引用变化判断「内容真的变了」
    // （翻页后保持滚动位置、跟随到底部），翻页过程中的「正在加载」翻转不能触发它。
    const prev = this.lastSnap;
    const same = prev !== null && prev.entries.length === fresh.length
      && prev.entries.every((e, i) => e.key === fresh[i]!.key && e.call === fresh[i]!.call && e.message === fresh[i]!.message);
    const entries = same ? prev.entries : fresh;
    this.cached = {
      loaded: this.loaded,
      error: this.error,
      entries,
      calls: same ? prev.calls : entries.flatMap((e) => (e.call ? [e.call] : [])),
      messages: same ? prev.messages : entries.flatMap((e) => (e.message ? [e.message] : [])),
      state: this.state,
      hasOlder: this.hasOlder,
      loadingOlder: this.loadingOlder,
      olderError: this.olderError,
      stopped: this.halted,
    };
    this.lastSnap = this.cached;
    return this.cached;
  }

  /** 现在生效的长轮询秒数（自适应后可能比配置的小）。 */
  currentWait(): number {
    return this.wait;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.halted = false;
    this.fatalSent = false;
    this.unsubscribe = this.env.subscribe((e) => this.onEnv(e));
    void this.loop(++this.loopId);
  }

  stop(): void {
    this.stopped = true;
    this.loopId += 1; // 让还没退出的旧循环在下一次唤醒时自己结束，即使马上又 start()
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.inflight) { this.inflight.reason = 'stop'; this.inflight.ctrl.abort(); this.inflight = null; }
    this.historyCtrl?.abort();
    this.sleeper?.abort();
    this.visibleWaiter?.();
  }

  /** 发送消息等操作后：立即拉一次（打断挂起中的长轮询并跳过等待）。 */
  kick(): void {
    if (this.stopped) return;
    this.nextAt = 0;
    this.sleeper?.abort();
    if (this.inflight) { this.inflight.reason = 'kick'; this.inflight.ctrl.abort(); }
  }

  /** 往上翻一页（同一时刻只一个）。返回是否加载到了内容。 */
  async loadOlder(): Promise<boolean> {
    if (this.loadingOlder || !this.hasOlder) return false;
    const first = this.earliestKey();
    if (!first) return false;
    const generation = this.generation;
    const ctrl = new AbortController();
    this.historyCtrl = ctrl;
    this.loadingOlder = true;
    this.olderError = false;
    this.touch();
    try {
      const res = await this.cfg.fetchJson(`/sessions/${encodeURIComponent(this.cfg.sessionId)}/history?before=${encodeURIComponent(encodeKey(first))}&limit=${this.cfg.limit}`, ctrl.signal) as
        { items?: { calls?: unknown[]; messages?: unknown[] }; older?: string | null } | null;
      if (generation !== this.generation || this.stopped && ctrl.signal.aborted) return false;
      const calls = (res?.items?.calls ?? []) as C[];
      const messages = (res?.items?.messages ?? []) as M[];
      for (const c of calls) if (!this.head.calls.has(c.id)) this.history.calls.set(c.id, c);
      for (const m of messages) if (!this.head.messages.has(m.id)) this.history.messages.set(m.id, m);
      this.hasOlder = !!res && res.older !== null && res.older !== undefined;
      this.trimTotal();
      return calls.length + messages.length > 0;
    } catch (e) {
      if (generation === this.generation && !ctrl.signal.aborted) {
        this.olderError = true;
        this.fatalIfAuth(e);
      }
      return false;
    } finally {
      if (this.historyCtrl === ctrl) this.historyCtrl = null;
      if (generation === this.generation) this.loadingOlder = false;
      this.touch();
    }
  }

  // ---------- 循环 ----------

  private onEnv(event: 'hide' | 'show' | 'offline' | 'online'): void {
    if (event === 'hide') {
      this.unreliableAt = this.env.now();
      // 隐藏：中止当前请求并暂停，显示时用原 offset 立即拉一次
      if (this.inflight) { this.inflight.reason = 'hide'; this.inflight.ctrl.abort(); }
    } else if (event === 'offline') {
      this.unreliableAt = this.env.now();
    } else {
      this.nextAt = 0;
      this.sleeper?.abort();
      this.visibleWaiter?.();
    }
  }

  private async sleepUntil(at: number): Promise<void> {
    const ms = at - this.env.now();
    if (ms <= 0 || this.stopped) return;
    const ctrl = new AbortController();
    this.sleeper = ctrl;
    try { await this.env.sleep(ms, ctrl.signal); } finally { if (this.sleeper === ctrl) this.sleeper = null; }
  }

  private async waitVisible(): Promise<void> {
    while (!this.stopped && !this.env.visible()) {
      await new Promise<void>((resolve) => { this.visibleWaiter = resolve; });
      this.visibleWaiter = null;
    }
  }

  private feedPath(): string {
    const q = new URLSearchParams();
    if (this.offset !== null && this.boot !== null) { q.set('offset', String(this.offset)); q.set('boot', this.boot); }
    q.set('wait', String(this.wait));
    q.set('limit', String(this.cfg.limit));
    return `/sessions/${encodeURIComponent(this.cfg.sessionId)}/feed?${q.toString()}`;
  }

  private async loop(id: number): Promise<void> {
    const alive = (): boolean => id === this.loopId && !this.stopped;
    while (alive() && !this.halted) {
      if (!this.env.visible()) { await this.waitVisible(); continue; }
      await this.sleepUntil(this.nextAt);
      if (!alive()) break;
      if (!this.env.visible()) continue;

      const ctrl = new AbortController();
      const startedAt = this.env.now();
      const wait = this.wait;
      this.inflight = { ctrl, reason: null, startedAt };
      this.lastStart = startedAt;
      let res: unknown;
      try {
        res = await this.cfg.fetchJson(this.feedPath(), ctrl.signal);
      } catch (e) {
        if (!alive()) break; // 旧循环：不碰 inflight（可能已属于新循环）
        const reason = this.inflight?.reason ?? null;
        this.inflight = null;
        if (reason) continue; // 自己中止的（隐藏、kick）：不计数、不退避
        if (this.onFailure(e, startedAt, wait)) break;
        continue;
      }
      if (!alive()) break;
      this.inflight = null;
      if (!isFeedResponse(res)) { if (this.onFailure(Object.assign(new Error('bad_response'), { status: 200 }), startedAt, wait)) break; continue; }
      let done: boolean;
      try {
        done = this.onSuccess(res);
      } catch (e) {
        // 响应里有条目缺字段之类的异常：当作一次失败退避重试，不能让循环静默死掉
        done = this.onFailure(Object.assign(e instanceof Error ? e : new Error(String(e)), { status: 200 }), startedAt, wait);
      }
      if (done) break;
    }
  }

  /** 返回 true = 循环应结束。 */
  private onFailure(e: unknown, startedAt: number, wait: number): boolean {
    this.error = e;
    const status = (e as { status?: unknown } | null)?.status;
    if (status === 401 || status === 403 || status === 404) {
      this.halt(e);
      return true;
    }
    const held = this.env.now() - startedAt;
    const networkError = typeof status !== 'number';
    const cutLike = wait > 0 && held >= CUT_MIN_HELD_MS && held < wait * 1000 - CUT_MARGIN_MS && (networkError || CUT_STATUSES.includes(status as number));
    // 请求期间页面隐藏、离线（unreliableAt）的不计数
    if (cutLike && this.unreliableAt < startedAt) {
      this.cuts += 1;
      if (this.cuts >= 2) {
        this.cuts = 0;
        this.setWait(halve(this.wait));
      }
    }
    this.failures += 1;
    this.nextAt = this.env.now() + (BACKOFF_MS[Math.min(this.failures, BACKOFF_MS.length) - 1] ?? 15000);
    this.touch();
    return false;
  }

  private onSuccess(res: FeedResponse): boolean {
    this.failures = 0;
    this.cuts = 0;
    this.error = null;
    const wasLoaded = this.loaded;
    if (res.full) this.applyFull(res, wasLoaded);
    else this.applyIncrement(res);
    if (res.state !== undefined && res.state !== null) this.state = res.state as S;
    this.offset = res.offset;
    this.boot = res.boot;
    this.loaded = true;
    this.retryMs = typeof res.retry_ms === 'number' ? res.retry_ms : 0;
    this.lastMore = res.more === true;
    // 服务端降级（响应 wait:0）不计「被掰」、也不改存储的 wait，只按 retry_ms 退让（下面的 nextAt）

    // 每 10 分钟尝试恢复更长的 wait
    const now = this.env.now();
    if (this.wait < this.maxWait && now >= this.restoreAt) this.setWait(grow(this.wait, this.maxWait));

    // 下一次请求的下限：距上一次请求开始至少 retry_ms；短轮询模式（wait=0）再加 2.5s 间隔（续拉除外）
    let at = this.lastStart + this.retryMs;
    if (this.wait === 0 && !this.lastMore) at = Math.max(at, this.lastStart + SHORT_POLL_MS);
    this.nextAt = at;

    const state = this.state as { status?: unknown } | null;
    const endedNow = !!state && typeof state.status === 'string' && ENDED.has(state.status);
    if (this.cfg.once || endedNow) {
      this.halted = true;
      this.touch();
      return true;
    }
    this.touch();
    return false;
  }

  // ---------- 合并 ----------

  private keyOfCall(c: C): TimelineKey { return { t: timeOf(c.created_at), kind: 'c', id: c.id }; }
  private keyOfMessage(m: M): TimelineKey { return { t: m.at, kind: 'm', id: m.id }; }

  private earliestKey(): TimelineKey | null {
    let best: TimelineKey | null = null;
    for (const seg of [this.head, this.history]) {
      for (const c of seg.calls.values()) { const k = this.keyOfCall(c); if (!best || compareKeys(k, best) < 0) best = k; }
      for (const m of seg.messages.values()) { const k = this.keyOfMessage(m); if (!best || compareKeys(k, best) < 0) best = k; }
    }
    return best;
  }

  private headEarliest(): TimelineKey | null {
    let best: TimelineKey | null = null;
    for (const c of this.head.calls.values()) { const k = this.keyOfCall(c); if (!best || compareKeys(k, best) < 0) best = k; }
    for (const m of this.head.messages.values()) { const k = this.keyOfMessage(m); if (!best || compareKeys(k, best) < 0) best = k; }
    return best;
  }

  /** full 只替换 head（R37）：已翻出的历史保留；新 head 与历史之间出现断档才丢弃 history。 */
  private applyFull(res: FeedResponse, wasLoaded: boolean): void {
    const oldEarliest = this.headEarliest();
    const head = emptySegment<C, M>();
    for (const c of res.calls as C[]) head.calls.set(c.id, c);
    for (const m of res.messages as M[]) head.messages.set(m.id, m);
    this.head = head;
    const newEarliest = this.headEarliest();
    const gap = oldEarliest !== null && newEarliest !== null && compareKeys(newEarliest, oldEarliest) > 0;
    if (!wasLoaded || gap) {
      this.history = emptySegment();
      this.generation += 1;
      this.loadingOlder = false;
      this.olderError = false;
      this.hasOlder = res.older !== null && res.older !== undefined;
    } else {
      // 保留历史：已在 head 里的条目以 head 为准
      for (const id of head.calls.keys()) this.history.calls.delete(id);
      for (const id of head.messages.keys()) this.history.messages.delete(id);
    }
    this.trimHead();
  }

  private applyIncrement(res: FeedResponse): void {
    const floor = this.earliestKey();
    const put = <T extends { id: string }>(key: TimelineKey, item: T, inHead: Map<string, T>, inHistory: Map<string, T>): void => {
      if (inHead.has(item.id)) inHead.set(item.id, item);
      else if (inHistory.has(item.id)) inHistory.set(item.id, item);
      else if (floor === null || compareKeys(key, floor) >= 0) inHead.set(item.id, item);
      // 其他：早于已加载范围的新条目丢弃（R6），不往头部插孤立的旧行
    };
    for (const c of res.calls as C[]) put(this.keyOfCall(c), c, this.head.calls, this.history.calls);
    for (const m of res.messages as M[]) put(this.keyOfMessage(m), m, this.head.messages, this.history.messages);
    this.trimHead();
  }

  /** head 超过 300 条：最早的部分移入 history（不丢）；总量超过 2000 才裁 history。 */
  private trimHead(): void {
    const size = this.head.calls.size + this.head.messages.size;
    if (size > HEAD_MAX) {
      const items = this.sortedItems(this.head).slice(0, size - HEAD_MAX);
      for (const it of items) {
        if (it.kind === 'c') { this.history.calls.set(it.id, it.call as C); this.head.calls.delete(it.id); }
        else { this.history.messages.set(it.id, it.message as M); this.head.messages.delete(it.id); }
      }
    }
    this.trimTotal();
  }

  private trimTotal(): void {
    const total = this.head.calls.size + this.head.messages.size + this.history.calls.size + this.history.messages.size;
    if (total <= TOTAL_MAX) return;
    const drop = this.sortedItems(this.history).slice(0, total - TOTAL_MAX);
    for (const it of drop) {
      if (it.kind === 'c') this.history.calls.delete(it.id);
      else this.history.messages.delete(it.id);
    }
    // 裁掉的部分用户再往上翻时可以重新加载
    this.hasOlder = true;
  }

  private sortedItems(seg: Segment<C, M>): { key: TimelineKey; kind: TimelineKind; id: string; call?: C; message?: M }[] {
    const out: { key: TimelineKey; kind: TimelineKind; id: string; call?: C; message?: M }[] = [];
    for (const c of seg.calls.values()) out.push({ key: this.keyOfCall(c), kind: 'c', id: c.id, call: c });
    for (const m of seg.messages.values()) out.push({ key: this.keyOfMessage(m), kind: 'm', id: m.id, message: m });
    return out.sort((a, b) => compareKeys(a.key, b.key));
  }

  private entries(): FeedEntry<C, M>[] {
    const calls = new Map([...this.history.calls, ...this.head.calls]);
    const messages = new Map([...this.history.messages, ...this.head.messages]);
    const out: FeedEntry<C, M>[] = [];
    for (const c of calls.values()) { const k = this.keyOfCall(c); out.push({ key: encodeKey(k), t: k.t, kind: 'c', id: c.id, call: c }); }
    for (const m of messages.values()) { const k = this.keyOfMessage(m); out.push({ key: encodeKey(k), t: k.t, kind: 'm', id: m.id, message: m }); }
    return out.sort((a, b) => compareKeys({ t: a.t, kind: a.kind, id: a.id }, { t: b.t, kind: b.kind, id: b.id }));
  }

  // ---------- 其他 ----------

  /** 401/403/404：结束循环并交给上层（onFatal 只调一次）。 */
  private halt(e: unknown): void {
    if (this.fatalSent) return;
    this.fatalSent = true;
    this.halted = true;
    if (this.inflight) { this.inflight.reason = 'stop'; this.inflight.ctrl.abort(); }
    this.touch();
    this.cfg.onFatal?.(e);
  }

  private fatalIfAuth(e: unknown): void {
    const status = (e as { status?: unknown } | null)?.status;
    if (status === 401 || status === 403 || status === 404) this.halt(e);
  }

  private setWait(next: number): void {
    if (next === this.wait) return;
    this.wait = next;
    this.restoreAt = this.env.now() + RESTORE_MS;
    this.save();
  }

  private readSaved(): { wait: number; at: number } | null {
    const { storage, storageKey } = this.cfg;
    if (!storage || !storageKey) return null;
    try {
      const v = JSON.parse(storage.get(storageKey) ?? 'null') as { wait?: unknown; at?: unknown } | null;
      if (v && typeof v.wait === 'number' && typeof v.at === 'number' && v.wait >= 0) return { wait: v.wait, at: v.at };
    } catch { /* 存储不可用或内容损坏：当作没有 */ }
    return null;
  }

  private save(): void {
    const { storage, storageKey } = this.cfg;
    if (!storage || !storageKey) return;
    try { storage.set(storageKey, JSON.stringify({ wait: this.wait, at: this.env.now() })); } catch { /* 只是便利，失败不影响读取 */ }
  }

  private touch(): void {
    this.cached = null;
    for (const fn of [...this.listeners]) {
      try { fn(); } catch { /* 监听者出错不能拖垮循环 */ }
    }
  }
}
