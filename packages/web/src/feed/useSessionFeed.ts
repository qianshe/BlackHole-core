/**
 * 会话 feed 的 React 接入（session-feed 计划 §7.6）：按 `范围|会话|条数|once` 登记，同一个会话的多个组件
 * （时间线、输入框……）共用一条长轮询；最后一个组件卸载后才停。
 */
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { SessionFeed, type FeedCallRow, type FeedMessageRow, type FeedSnapshot, type FeedStorage } from '../../../vscode/src/sessionFeed';
import { FeedRegistry, type RegistrySlot } from './registry';

/** 请求失败：带数字 status，SessionFeed 据此判断 401/403/404（致命）和 502/504/524（渠道掰断）。 */
export class FeedHttpError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

/** feed 的 state：名称、状态、配对类型、Courier 是否在线、绑定的网页会话（与 daemon.ts 的 state provider 一致）。 */
export interface FeedTarget {
  targetId: string;
  site: string;
  label: string;
  busy: boolean | null;
  ready: boolean | null;
  open: boolean;
  draft: boolean | null;
  model?: string | null;
  /** 开着的 Arena 评价卡标题，没有则为 null。 */
  card?: string | null;
}
export interface FeedState {
  name: string | null;
  status: string;
  /** new / paired / unpaired / direct */
  link: string;
  connected: boolean;
  target: FeedTarget | null;
}

/** Web 控制台（时间线与输入框共用同一条 feed）的头部条数与 history 每页条数。 */
export const WEB_FEED_LIMIT = 50;

export type FeedScope = 'web' | 'remote';

const BASES: Record<FeedScope, string> = { web: '/web-api/v1', remote: '/remote-api/v1' };

async function fetchFeed(scope: FeedScope, path: string, signal: AbortSignal): Promise<unknown> {
  const res = await fetch(BASES[scope] + path, {
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'x-blackhole-web': '1' },
    signal,
  });
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const code = (data as { error?: string } | null)?.error;
    throw new FeedHttpError(res.status, code ?? `http_${res.status}`);
  }
  // 手机链路上被截断或不是 JSON 的响应是一次失败的轮询，不是空结果
  if (!data || typeof data !== 'object') throw new FeedHttpError(res.status, 'bad_response');
  return data;
}

/** 自适应等待的结果记在 localStorage 里；不可用时（隐私模式等）只在内存里。 */
const storage: FeedStorage = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* 无痕模式等：不记 */ }},
};

export interface UseSessionFeedOptions {
  scope: FeedScope;
  sessionId: string;
  /** feed full 的头部条数与 history 每页条数：手机 20，Web 50。 */
  limit: number;
  /** 已结束的会话：只读一次，不进循环。 */
  once?: boolean;
  /** 401/403/404：会话没了或要重新登录。 */
  onFatal?: (error: unknown) => void;
}

interface FeedEntry {
  feed: SessionFeed<FeedCallRow & Record<string, unknown>, FeedMessageRow & Record<string, unknown>, unknown>;
  fatal: Set<(e: unknown) => void>;
}

// 按 `范围|会话|条数|once` 登记并引用计数（逻辑在 registry.ts，有单测）：同一会话的组件共用一条 feed，最后一个卸载后才停。
const registry = new FeedRegistry<FeedEntry>({
  start: (e) => e.feed.start(),
  stop: (e) => e.feed.stop(),
});

function slotFor(o: UseSessionFeedOptions): [string, RegistrySlot<FeedEntry>] {
  const key = `${o.scope}|${o.sessionId}|${o.limit}|${o.once ? 1 : 0}`;
  return [key, registry.slot(key, () => {
    const fatal = new Set<(e: unknown) => void>();
    const feed = new SessionFeed<FeedCallRow & Record<string, unknown>, FeedMessageRow & Record<string, unknown>, unknown>({
      sessionId: o.sessionId,
      fetchJson: (path, signal) => fetchFeed(o.scope, path, signal),
      limit: o.limit,
      once: o.once,
      storage,
      // 自适应等待按渠道（页面 origin）记，换一条隧道就重新学
      storageKey: `bh.feed.wait.${typeof location === 'undefined' ? '' : location.origin}`,
      onFatal: (e) => { for (const fn of [...fatal]) fn(e); },
    });
    return { feed, fatal };
  })];
}

export interface SessionFeedHandle<C, M, S> {
  snap: FeedSnapshot<C, M, S>;
  loadOlder: () => Promise<boolean>;
  /** 刚发过消息等：立即再读一次，不等长轮询。 */
  kick: () => void;
}

const EMPTY: FeedSnapshot<never, never, never> = {
  loaded: false, error: null, entries: [], calls: [], messages: [], state: null,
  hasOlder: false, loadingOlder: false, olderError: false, stopped: false,
};

export function useSessionFeed<C extends FeedCallRow, M extends FeedMessageRow, S>(opts: UseSessionFeedOptions): SessionFeedHandle<C, M, S> {
  const { scope, sessionId, limit, once } = opts;
  const fatalRef = useRef(opts.onFatal);
  fatalRef.current = opts.onFatal;
  const [key, slot] = useMemo(() => slotFor({ scope, sessionId, limit, once }), [scope, sessionId, limit, once]);
  useEffect(() => {
    const onFatal = (e: unknown): void => fatalRef.current?.(e);
    slot.item.fatal.add(onFatal);
    const release = registry.acquire(key, slot);
    return () => { slot.item.fatal.delete(onFatal); release(); };
  }, [key, slot]);
  const { feed } = slot.item;
  const subscribe = useCallback((fn: () => void) => feed.subscribe(fn), [feed]);
  const snap = useSyncExternalStore(subscribe, () => feed.snapshot(), () => EMPTY) as unknown as FeedSnapshot<C, M, S>;
  const loadOlder = useCallback(() => feed.loadOlder(), [feed]);
  const kick = useCallback(() => feed.kick(), [feed]);
  return { snap, loadOlder, kick };
}
