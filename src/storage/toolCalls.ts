import type { DatabaseSync } from 'node:sqlite';
import { randomId } from '../util/token.js';
import { WORKSPACE_FILE_TOOL } from '../tool-routing.js';
import type { ApprovalScope, ToolCallRow } from './db.js';

import { activityDate, addActivity, atomicActivity, editorDelta, emptyCounts, type ActivityCounts } from './activity.js';

const PERSISTED_SUMMARY_CAP_BYTES = 32 * 1024;
const PERSISTED_NAVIGATION_CAP_BYTES = 8 * 1024;
function capPersistedSummary(text: string): string {
  if (Buffer.byteLength(text, 'utf8') <= PERSISTED_SUMMARY_CAP_BYTES) return text;
  const diff = editorDelta(WORKSPACE_FILE_TOOL, 'completed', text);
  const bytes = Buffer.from(text, 'utf8');
  const encode = (n: number) => JSON.stringify({ truncated: true, result: { diff }, preview: bytes.subarray(0, n).toString('utf8') });
  // JSON escaping itself can expand the preview. Bound the final encoded envelope.
  let low = 0, high = Math.min(bytes.length, PERSISTED_SUMMARY_CAP_BYTES);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(encode(mid), 'utf8') <= PERSISTED_SUMMARY_CAP_BYTES) low = mid;
    else high = mid - 1;
  }
  return encode(low);
}

export class ToolCallsRepo {
  constructor(private db: DatabaseSync) {}

  start(sessionId: string, tool: string, argsJson: string, argsHash: string): ToolCallRow {
    const id = randomId('call');
    const t = Date.now();
    return atomicActivity(this.db, () => {
      const day = activityDate(t);
      this.db.prepare(`INSERT INTO tool_calls
        (id, session_id, tool, args_json, args_hash, status, result_summary, created_at, updated_at, activity_day)
        VALUES (?, ?, ?, ?, ?, 'started', NULL, ?, ?, ?)`)
        .run(id, sessionId, tool, argsJson, argsHash, t, t, day);
      addActivity(this.db, day, 1, 0, 0);
      return this.get(id) as ToolCallRow;
    });
  }

  finish(
    id: string,
    status: 'completed' | 'failed' | 'denied' | 'unknown',
    resultSummary: string | null,
    navigationJson?: string,
  ): void {
    atomicActivity(this.db, () => {
      const row = this.db.prepare('SELECT tool,created_at,activity_day,diff_added,diff_removed,navigation_json FROM tool_calls WHERE id=?').get(id) as
        { tool: string; created_at: number; activity_day: string | null; diff_added: number; diff_removed: number; navigation_json: string | null } | undefined;
      if (!row) return; // A deleted/revoked call cannot resurrect activity on a late reply.
      const delta = editorDelta(row.tool, status, resultSummary);
      const capped = resultSummary === null ? null : capPersistedSummary(resultSummary);
      const navigation = navigationJson === undefined
        ? row.navigation_json
        : Buffer.byteLength(navigationJson, 'utf8') <= PERSISTED_NAVIGATION_CAP_BYTES ? navigationJson : null;
      this.db.prepare('UPDATE tool_calls SET status=?,result_summary=?,navigation_json=?,updated_at=?,diff_added=?,diff_removed=? WHERE id=?')
        .run(status, capped, navigation, Date.now(), delta.added, delta.removed, id);
      if (delta.added !== row.diff_added || delta.removed !== row.diff_removed) {
        addActivity(this.db, row.activity_day ?? activityDate(row.created_at), 0, delta.added - row.diff_added, delta.removed - row.diff_removed);
      }
    });
  }

  /**
   * The call is blocked on operator approval. A distinct status (instead of
   * 'started') lets the feed show awaiting-approval instead of a fake running.
   */
  awaitApproval(id: string): void {
    this.db.prepare("UPDATE tool_calls SET status = 'awaiting', updated_at = ? WHERE id = ?").run(Date.now(), id);
  }

  /** Approved and executing again: flip back to 'started'. */
  resume(id: string): void {
    this.db.prepare("UPDATE tool_calls SET status = 'started', updated_at = ? WHERE id = ? AND status = 'awaiting'").run(Date.now(), id);
  }

  /** Record how the call was approved: once / session / always. */
  setApprovalScope(id: string, scope: ApprovalScope): void {
    this.db.prepare('UPDATE tool_calls SET approval_scope = ?, updated_at = ? WHERE id = ?').run(scope, Date.now(), id);
  }

  get(id: string): ToolCallRow | undefined {
    return this.db.prepare('SELECT * FROM tool_calls WHERE id = ?').get(id) as ToolCallRow | undefined;
  }

  listForSession(sessionId: string, limit = 100): ToolCallRow[] {
    return this.db
      .prepare('SELECT * FROM tool_calls WHERE session_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(sessionId, limit) as unknown as ToolCallRow[];
  }

  /**
   * Incremental feed for polling UIs: rows strictly after `afterSeq`, oldest
   * first, PLUS already-sent rows whose status changed after `updatedSince`
   * (a pure rowid cursor never re-flows status updates, leaving the UI stuck
   * on a stale badge). `seq` is the stable rowid cursor callers pass back as
   * `after`.
   */
  listForSessionSince(
    sessionId: string,
    afterSeq: number,
    limit = 200,
    updatedSince = 0,
    minSeq = 0,
  ): (ToolCallRow & { seq: number })[] {
    return this.db
      .prepare(
        'SELECT rowid AS seq, * FROM tool_calls WHERE session_id = ? AND rowid > ? AND (rowid > ? OR updated_at > ?) ORDER BY rowid ASC LIMIT ?',
      )
      .all(sessionId, minSeq, afterSeq, updatedSince, limit) as unknown as (ToolCallRow & { seq: number })[];
  }

  /** 当前会话的实际最大 seq（rowid）。浏览分页的锚点初始化用。 */
  maxSeqForSession(sessionId: string): number {
    const row = this.db.prepare('SELECT MAX(rowid) AS m FROM tool_calls WHERE session_id = ?').get(sessionId) as { m: number | null };
    return Number(row.m ?? 0);
  }

  countForSession(sessionId: string, upToSeq?: number): number {
    // upToSeq：分页窗口口径（rowid <= upToSeq）。全量口径把 anchor 之后的新写入
    // 也计入页数，但窗口 SQL 取不到那些行 → 深页返回空 → 客户端误判"页码越界"
    // 钳回末页（翻历史时被反复拽回末页的根源）。
    const row = upToSeq === undefined
      ? (this.db.prepare('SELECT COUNT(*) AS n FROM tool_calls WHERE session_id = ?').get(sessionId) as { n: number | null })
      : (this.db.prepare('SELECT COUNT(*) AS n FROM tool_calls WHERE session_id = ? AND rowid <= ?').get(sessionId, upToSeq) as { n: number | null });
    return Number(row.n ?? 0);
  }

  /** Count only calls created after a panel's initial session cursor. */
  countForSessionAfter(sessionId: string, afterSeq: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM tool_calls WHERE session_id = ? AND rowid > ?')
      .get(sessionId, afterSeq) as { n: number | null };
    return Number(row.n ?? 0);
  }

  /**
   * 浏览分页：以 anchorSeq 为锚的固定 seq 窗口（倒序，配合 total 做分页器）。
   * page=0 的上界放开——锚定之后新写入的调用全部落在第 0 页，feed 头部始终
   * 是最新记录；page>0 是锚定期内的固定区间，新写入不会让深页内容漂移，
   * 用户翻历史时不会看到条目来回滑动。窗口为空（页码越出总量）返回空数组，
   * 由调用方 clamp。
   */
  listForSessionWindow(sessionId: string, anchorSeq: number, page: number, limit: number): (ToolCallRow & { seq: number })[] {
    // COUNT-based paging (LIMIT/OFFSET), not a rowid-width window. rowid is a
    // shared autoincrement across sessions, so one session's rowids are sparse.
    // The old `anchorSeq - page*limit` math treated `limit` as a rowid SPAN,
    // which under gaps yields fewer than `limit` real rows per page (first page
    // showed ~9/20 while the pager counts by ROWS, so page count never matched).
    // ALL pages share one cap (the anchor) so LIMIT/OFFSET stays continuous:
    // mixing an open cap on page 0 with an anchored cap on deep pages skipped
    // exactly the rows written after anchoring (a real gap between page 0 and
    // page 1). The client re-anchors while on page 0 so live writes still show;
    // deep pages keep the frozen anchor so history never drifts. anchor=0 (first
    // load) falls back to MAX, and being count-based it matches the re-anchored
    // refresh - no more "two extra rows that vanish a moment later".
    const cap = anchorSeq > 0 ? anchorSeq : Number.MAX_SAFE_INTEGER;
    return this.db
      .prepare(
        'SELECT rowid AS seq, * FROM tool_calls WHERE session_id = ? AND rowid <= ? ORDER BY rowid DESC LIMIT ? OFFSET ?',
      )
      .all(sessionId, cap, limit, Math.max(0, page) * limit) as unknown as (ToolCallRow & { seq: number })[];
  }

  /**
   * On daemon boot, calls that were in flight when the process died have an
   * unknowable outcome: they may have side effects on disk. Mark them
   * `unknown` so callers never blindly repeat them.
   */
  markStaleStartedAsUnknown(): number {
    const info = this.db
      .prepare("UPDATE tool_calls SET status = 'unknown', result_summary = 'interrupted by daemon restart', updated_at = ? WHERE status IN ('started', 'awaiting')")
      .run(Date.now());
    return Number(info.changes);
  }

  /** Read daily numeric counters; never deserialize audit payloads while polling. */
  dailyStats(dayTs: number): ActivityCounts {
    if (!Number.isFinite(dayTs) || !Number.isFinite(new Date(dayTs).getTime())) return emptyCounts();
    const row = this.db.prepare('SELECT total,diff_added,diff_removed FROM daily_activity WHERE day=?')
      .get(activityDate(dayTs)) as ActivityCounts | undefined;
    return row ? { ...row } : emptyCounts();
  }

  /** Local-calendar activity buckets for compact settings-page contribution cells. */
  activityDays(starts: number[]): { start: number; total: number; diff_added: number; diff_removed: number }[] {
    const normalized = [...new Set(starts.filter(start => Number.isFinite(start) && Number.isFinite(new Date(start).getTime()))
      .map(start => { const d = new Date(start); d.setHours(0,0,0,0); return d.getTime(); }))].sort((a,b) => a-b);
    if (normalized.length === 0) return [];
    const rows = this.db.prepare('SELECT day,total,diff_added,diff_removed FROM daily_activity WHERE day>=? AND day<=?')
      .all(activityDate(normalized[0]!), activityDate(normalized[normalized.length - 1]!)) as unknown as (ActivityCounts & { day: string })[];
    const byDay = new Map(rows.map(({ day, ...counts }) => [day, counts]));
    return normalized.map(start => ({ start, ...(byDay.get(activityDate(start)) ?? emptyCounts()) }));
  }

  /** 终止/归档会话的账本清理：该会话的全部调用记录（UI 已不可达，无界存储的源头）。 */
  purgeSession(sessionId: string): number {
    return Number(this.db.prepare('DELETE FROM tool_calls WHERE session_id = ?').run(sessionId).changes);
  }

  /** 保留期清扫：删除截止时间之前的所有调用记录。 */
  purgeOlderThan(cutoff: number): number {
    return Number(this.db.prepare('DELETE FROM tool_calls WHERE created_at < ?').run(cutoff).changes);
  }
}
