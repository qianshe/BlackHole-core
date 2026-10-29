/**
 * 会话时间线的排序键 `(t, kind, id)`：工具调用的 t 是 created_at，回复的 t 是 at；同一毫秒里调用在前、回复在后，
 * 再按 id 排。服务端用它把调用与回复合并后按「条目数」切窗口（feed 头部、history 翻页），
 * 客户端用同一个键把头部与翻出来的历史拼成一条线。
 *
 * 翻页游标 `older` 对客户端是不透明字符串，编码就是这个键。
 */
export type TimelineKind = 'c' | 'm';

export interface TimelineKey {
  t: number;
  kind: TimelineKind;
  id: string;
}

const RANK: Record<TimelineKind, number> = { c: 0, m: 1 };

/** 升序比较。id 按字节序比较，与 SQLite 的 BINARY 排序一致（id 都是 ASCII）。 */
export function compareKeys(a: TimelineKey, b: TimelineKey): number {
  if (a.t !== b.t) return a.t - b.t;
  if (a.kind !== b.kind) return RANK[a.kind] - RANK[b.kind];
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function encodeKey(k: TimelineKey): string {
  return `${k.t}.${k.kind}.${k.id}`;
}

/** 解析游标；格式不对返回 null。 */
export function parseKey(value: unknown): TimelineKey | null {
  if (typeof value !== 'string' || value.length > 200) return null;
  const m = /^(\d{1,16})\.([cm])\.([^\s]{1,128})$/.exec(value);
  if (!m) return null;
  return { t: Number(m[1]), kind: m[2] as TimelineKind, id: m[3]! };
}
