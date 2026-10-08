import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/**
 * 全会话共用的一个递增变更号：工具调用、网页回复、会话状态的每次变化都取一个新 rev。
 * daemon 是唯一写入方，单个计数器即全序；各端只带自己的 offset 取 `rev > offset` 的增量，
 * 这里不记任何读取方的位置。
 *
 * 与 ChangeTracker 不是一回事：后者是 VS Code 侧栏「没变就不拉明细」的粗粒度门控，
 * 不能随流式回复的每次更新而变；这里则每次记录变化都要前进。
 */

/** `wait()` 返回的原因。只有 `changed` 表示可能有新内容。 */
export type WaitResult = 'changed' | 'timeout' | 'closed' | 'shutdown' | 'degraded' | 'aborted';

export const MAX_WAIT_SECONDS = 25;
export const MAX_WAITERS_PER_SESSION = 16;
export const MAX_WAITERS_TOTAL = 128;

interface Waiter {
  settle: (result: WaitResult) => void;
}

export interface FeedStateEntry<S> {
  rev: number;
  state: S;
  json: string;
}

function maxRev(db: DatabaseSync, table: 'tool_calls' | 'courier_messages'): number {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) return 0;
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === 'rev')) return 0;
  const row = db.prepare(`SELECT MAX(rev) AS m FROM ${table}`).get() as { m: number | null };
  return Number(row.m ?? 0);
}

export class FeedLog<S = unknown> {
  /** 每次 daemon 启动都不同：客户端带来的 boot 与它不符，就必须从头部重新同步。 */
  readonly bootId = randomBytes(6).toString('hex');
  private rev: number;
  private readonly waiters = new Map<string, Set<Waiter>>();
  private waiterTotal = 0;
  private readonly states = new Map<string, FeedStateEntry<S>>();
  private stateProvider: ((sessionId: string) => S | null) | null = null;

  constructor(seed: number) {
    this.rev = Math.max(0, Math.floor(seed));
  }

  /**
   * 起始 rev：高于库里已存的所有 rev，也高于旧进程可能发出过的任何 rev（墙钟走得比计数器快），
   * 所以客户端手里的旧 offset 不会被当成「未来」；取已存最大值是为了系统时钟被拨回时不倒退。
   */
  static seedFromDb(db: DatabaseSync, now: number = Date.now()): number {
    return Math.max(maxRev(db, 'tool_calls'), maxRev(db, 'courier_messages'), now);
  }

  static open<S = unknown>(db: DatabaseSync, now: number = Date.now()): FeedLog<S> {
    return new FeedLog<S>(FeedLog.seedFromDb(db, now));
  }

  /**
   * 为 `sessionId` 的一条记录取下一个 rev。要与它所标记的写入放在同一个同步代码块里；
   * 等待者在微任务里才被唤醒，保证唤醒时行已写入、内存状态已更新。
   */
  next(sessionId: string): number {
    const rev = ++this.rev;
    queueMicrotask(() => this.wake(sessionId, 'changed'));
    return rev;
  }

  /** 目前发出的最新 rev。 */
  current(): number {
    return this.rev;
  }

  /** 提供会话的 state 快照（名称、状态、配对、Courier 目标）；会话不存在时返回 null。 */
  setStateProvider(provider: ((sessionId: string) => S | null) | null): void {
    this.stateProvider = provider;
  }

  /**
   * 重建该会话的 state 快照并与缓存比较：真的变了才取新 rev 并唤醒等待者。
   * 多调用无害，漏调用才是缺陷。返回新 rev；没变（或没有 provider / 会话不存在）返回 null。
   */
  touchState(sessionId: string): number | null {
    const provider = this.stateProvider;
    if (!provider) return null;
    let state: S | null;
    try { state = provider(sessionId); } catch { return null; }
    if (state === null) {
      this.states.delete(sessionId);
      return null;
    }
    const json = JSON.stringify(state);
    if (this.states.get(sessionId)?.json === json) return null;
    const rev = this.next(sessionId);
    this.states.set(sessionId, { rev, state, json });
    return rev;
  }

  /** 缓存的 state 及其 rev；首次使用时现建（state 只在内存里，重启后为空）。 */
  stateOf(sessionId: string): FeedStateEntry<S> | null {
    if (!this.states.has(sessionId)) this.touchState(sessionId);
    return this.states.get(sessionId) ?? null;
  }

  /**
   * 挂起，直到该会话有变化、`seconds` 秒到（上限 MAX_WAIT_SECONDS）、会话被关闭、daemon 关闭或 `signal` 中止。
   * 超过等待者上限时立即返回 `degraded`，调用方据此退回普通短轮询，而不是报错。
   * 调用方必须在同一个同步段里先查数据再调用本方法，否则会丢失唤醒。
   */
  wait(sessionId: string, seconds: number, signal?: AbortSignal): Promise<WaitResult> {
    if (signal?.aborted) return Promise.resolve('aborted');
    const set = this.waiters.get(sessionId);
    if ((set?.size ?? 0) >= MAX_WAITERS_PER_SESSION || this.waiterTotal >= MAX_WAITERS_TOTAL) return Promise.resolve('degraded');
    const ms = Math.min(Math.max(0, Number.isFinite(seconds) ? seconds : 0), MAX_WAIT_SECONDS) * 1000;
    return new Promise<WaitResult>((resolve) => {
      let done = false;
      const waiter: Waiter = {
        settle: (result) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          this.removeWaiter(sessionId, waiter);
          resolve(result);
        },
      };
      const onAbort = (): void => waiter.settle('aborted');
      const timer = setTimeout(() => waiter.settle('timeout'), ms);
      timer.unref();
      signal?.addEventListener('abort', onAbort, { once: true });
      const own = this.waiters.get(sessionId) ?? new Set<Waiter>();
      own.add(waiter);
      this.waiters.set(sessionId, own);
      this.waiterTotal += 1;
    });
  }

  /** 当前挂起的请求数：指定会话或全局（诊断与测试用）。 */
  waiting(sessionId?: string): number {
    return sessionId === undefined ? this.waiterTotal : this.waiters.get(sessionId)?.size ?? 0;
  }

  /** 会话行已不存在：丢弃它缓存的 state，并立即答复所有挂起的请求。 */
  close(sessionId: string): void {
    this.states.delete(sessionId);
    this.wake(sessionId, 'closed');
  }

  /** daemon 关闭：放走所有挂起的请求，HTTP 服务才能关闭。 */
  shutdown(): void {
    for (const id of [...this.waiters.keys()]) this.wake(id, 'shutdown');
  }

  private wake(sessionId: string, result: WaitResult): void {
    const set = this.waiters.get(sessionId);
    if (!set) return;
    for (const waiter of [...set]) waiter.settle(result);
  }

  private removeWaiter(sessionId: string, waiter: Waiter): void {
    const set = this.waiters.get(sessionId);
    if (!set || !set.delete(waiter)) return;
    this.waiterTotal -= 1;
    if (set.size === 0) this.waiters.delete(sessionId);
  }
}
