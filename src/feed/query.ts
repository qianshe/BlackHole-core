import type { CourierMessage, CourierMessages } from '../courier/messages.js';
import type { ToolCallRow } from '../storage/db.js';
import type { FeedLog } from '../storage/feedLog.js';
import type { ToolCallsRepo } from '../storage/toolCalls.js';
import { compareKeys, encodeKey, type TimelineKey } from './timeline.js';

/**
 * 会话时间线的读取（session-feed 计划 §5）：全量的头部窗口、增量、往上翻页。
 * 全部是同步函数：调用方在同一个同步段里先读、再挂起，才不会丢唤醒。
 */

export const PAGE_DEFAULT = 50;
export const PAGE_MIN = 10;
export const PAGE_MAX = 100;
/** 增量一次最多返回的记录数（调用 + 回复 + state），超过即截断并让客户端立即再拉。 */
export const INCREMENT_MAX = 200;

export type CallRow = ToolCallRow & { seq: number };

export interface TimelineSources {
  toolCalls: ToolCallsRepo;
  /** 没有 Courier（单元测试的依赖子集）时为 undefined，回复线程视为空。 */
  messages: CourierMessages | undefined;
}

export interface TimelinePage<C> {
  /** 按时间线键升序。 */
  calls: C[];
  messages: CourierMessage[];
  /** 下一页（更早的内容）的游标，没有更早的内容时为 null。 */
  older: string | null;
}

/** `limit` 参数：缺省 50，夹到 10–100。 */
export function clampLimit(raw: unknown): number {
  if (raw === undefined || raw === '') return PAGE_DEFAULT;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return PAGE_DEFAULT;
  return Math.min(PAGE_MAX, Math.max(PAGE_MIN, n));
}

const callKey = (r: CallRow): TimelineKey => ({ t: r.created_at, kind: 'c', id: r.id });
const messageKey = (m: CourierMessage): TimelineKey => ({ t: m.at, kind: 'm', id: m.id });

/**
 * 严格早于 `before`（null = 从最新开始）的最新 `limit` 条时间线条目，调用与回复一起按时间线键合并。
 * 两路各取 limit+1 条，开销与会话长度无关；多出来的那一条只用来判断还有没有更早的内容。
 */
export function pageTimeline<C>(
  src: TimelineSources,
  sessionId: string,
  before: TimelineKey | null,
  limit: number,
  mapCall: (row: CallRow) => C,
): TimelinePage<C> {
  const n = limit + 1;
  const items: { key: TimelineKey; call?: CallRow; message?: CourierMessage }[] = [
    ...src.toolCalls.pageBefore(sessionId, before, n).map((call) => ({ key: callKey(call), call })),
    ...(src.messages?.pageBefore(sessionId, before, n) ?? []).map((message) => ({ key: messageKey(message), message })),
  ];
  items.sort((a, b) => compareKeys(b.key, a.key)); // 倒序：最新的在前
  const hasMore = items.length > limit;
  const taken = items.slice(0, limit);
  const older = hasMore ? encodeKey(taken[taken.length - 1]!.key) : null;
  taken.reverse();
  return {
    calls: taken.flatMap((i) => (i.call ? [mapCall(i.call)] : [])),
    messages: taken.flatMap((i) => (i.message ? [i.message] : [])),
    older,
  };
}

export interface FeedRead<C> {
  full: boolean;
  more: boolean;
  /** 客户端下次要带回来的 offset。 */
  offset: number;
  /** 只在 full 时有意义。 */
  older: string | null;
  calls: C[];
  messages: CourierMessage[];
  state: unknown | undefined;
}

export interface FeedQuery {
  offset: number | null;
  boot: string | null;
  limit: number;
}

export const hasData = (r: FeedRead<unknown>): boolean => r.calls.length > 0 || r.messages.length > 0 || r.state !== undefined;

interface Stamped {
  rev: number;
  call?: CallRow;
  message?: CourierMessage;
  state?: boolean;
}

/**
 * 读一次 feed。
 * - full：offset 或 boot 缺失、offset 超前、或 boot 与当前 daemon 不符。返回头部窗口 + state + `older`。
 * - 增量：调用、回复、state 三路按 rev 归并，取前 `incrementMax` 条。截断时 `more=true`，offset = 已返回记录中最大的
 *   rev（绝不能返回 current()，否则会跳过未返回的记录）；未截断时 offset = 读取时的 current()，同步读取期间没有写入，安全。
 */
export function readFeed<C>(
  src: TimelineSources & { feed: FeedLog },
  sessionId: string,
  q: FeedQuery,
  mapCall: (row: CallRow) => C,
  incrementMax: number = INCREMENT_MAX,
): FeedRead<C> {
  const { feed } = src;
  // 先取 state：首次使用时它会现建并取一个 rev，必须在读 current() 之前
  const entry = feed.stateOf(sessionId);
  const full = q.offset === null || q.boot !== feed.bootId || q.offset > feed.current();
  if (full) {
    const page = pageTimeline(src, sessionId, null, q.limit, mapCall);
    return { full: true, more: false, offset: feed.current(), older: page.older, calls: page.calls, messages: page.messages, state: entry?.state };
  }
  const offset = q.offset as number;
  const items: Stamped[] = [
    ...src.toolCalls.changedSince(sessionId, offset, incrementMax + 1).map((call) => ({ rev: call.rev ?? 0, call })),
    ...(src.messages?.changedSince(sessionId, offset, incrementMax + 1) ?? []).map((message) => ({ rev: message.rev ?? 0, message })),
    ...(entry && entry.rev > offset ? [{ rev: entry.rev, state: true }] : []),
  ];
  items.sort((a, b) => a.rev - b.rev);
  const more = items.length > incrementMax;
  const taken = more ? items.slice(0, incrementMax) : items;
  return {
    full: false,
    more,
    offset: more ? taken[taken.length - 1]!.rev : feed.current(),
    older: null,
    calls: taken.flatMap((i) => (i.call ? [mapCall(i.call)] : [])),
    messages: taken.flatMap((i) => (i.message ? [i.message] : [])),
    state: taken.some((i) => i.state) ? entry?.state : undefined,
  };
}
