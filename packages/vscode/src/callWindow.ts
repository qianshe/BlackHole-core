/**
 * Chat-style call timeline shared by the VS Code sidebar and the Web console.
 *
 * Newest calls sit at the bottom; older ones are loaded on demand (scrolling up).
 * Every refresh fetches the head (newest rows, no anchor) so status changes show up;
 * older pages are read once under a frozen anchor seq, so calls written meanwhile
 * never shift them. The daemon caps one request at WINDOW_MAX rows: if more calls
 * arrived since the anchor than one head request can cover, the window restarts.
 */
export const WINDOW_MAX = 200;

export interface WindowRow { id: string; seq?: number; created_at: number | string | null }

export interface WindowPage<T> { calls: T[]; total: number; window_total?: number; max_seq?: number }

export interface CallWindow<T extends WindowRow> {
  /** max seq when the window started (0 = not started). */
  anchor: number;
  /** Older pages read under the anchor (page 0 is covered by the head). */
  older: number;
  /** Rows by id, any order; use rowsOf() for display order. */
  rows: Map<string, T>;
  /** All calls in the session. */
  total: number;
  /** Calls with seq <= anchor. */
  windowTotal: number;
}

export function emptyWindow<T extends WindowRow>(): CallWindow<T> {
  return { anchor: 0, older: 0, rows: new Map(), total: 0, windowTotal: 0 };
}

/** Row limit for the next head request; restart = the window must start over first. */
export function headRequest<T extends WindowRow>(w: CallWindow<T>, size: number): { limit: number; restart: boolean } {
  if (!w.anchor) return { limit: size, restart: false };
  const limit = size + Math.max(0, w.total - w.windowTotal);
  return limit > WINDOW_MAX ? { limit: size, restart: true } : { limit, restart: false };
}

const seqOf = (r: WindowRow) => (typeof r.seq === 'number' ? r.seq : 0);

/** Apply a head response (page 0, anchor 0). */
export function applyHead<T extends WindowRow>(w: CallWindow<T>, page: WindowPage<T>): CallWindow<T> {
  const rows = new Map(w.rows);
  for (const r of page.calls) rows.set(r.id, r);
  if (!w.anchor) {
    const anchor = page.max_seq ?? page.calls.reduce((m, r) => Math.max(m, seqOf(r)), 0);
    return { anchor, older: 0, rows, total: page.total, windowTotal: page.total };
  }
  // History trimmed below the anchor: forget rows the daemon no longer counts.
  const windowTotal = Math.min(w.windowTotal, page.total);
  return { ...w, rows, total: page.total, windowTotal };
}

/** Apply an older page (page = w.older + 1, under w.anchor). */
export function applyOlder<T extends WindowRow>(w: CallWindow<T>, page: WindowPage<T>): CallWindow<T> {
  const rows = new Map(w.rows);
  for (const r of page.calls) rows.set(r.id, r);
  const windowTotal = page.calls.length ? (page.window_total ?? w.windowTotal) : below(w.anchor, rows);
  return { ...w, rows, older: w.older + 1, windowTotal };
}

function below<T extends WindowRow>(anchor: number, rows: Map<string, T>): number {
  let n = 0;
  for (const r of rows.values()) if (seqOf(r) <= anchor) n++;
  return n;
}

/** Whether older calls exist that are not loaded yet. */
export function hasOlder<T extends WindowRow>(w: CallWindow<T>): boolean {
  return !!w.anchor && below(w.anchor, w.rows) < w.windowTotal;
}

/** Rows oldest first. */
export function rowsOf<T extends WindowRow>(w: CallWindow<T>): T[] {
  return [...w.rows.values()].sort((a, b) => seqOf(a) - seqOf(b));
}

export const timeOf = (t: number | string | null): number => (typeof t === 'number' ? t : t ? Date.parse(t) || 0 : 0);

/**
 * Chat messages belonging to the loaded part of the timeline: all of them once the
 * oldest call is loaded, otherwise those at or after the oldest loaded call.
 */
export function messagesInWindow<T extends WindowRow, M extends { at: number }>(w: CallWindow<T>, messages: M[]): M[] {
  if (!hasOlder(w)) return messages;
  let oldest = Infinity;
  for (const r of w.rows.values()) oldest = Math.min(oldest, timeOf(r.created_at));
  return oldest === Infinity ? messages : messages.filter((m) => m.at >= oldest);
}
