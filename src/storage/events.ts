import type { DatabaseSync } from 'node:sqlite';
import type { EventRow } from './db.js';

export type EventInput =
  | { sessionId: string; type: string; payload: unknown }
  | { sessionId: null; type: string; payload: unknown };

export class EventsRepo {
  constructor(
    private db: DatabaseSync,
    private payloadCapBytes: number,
    /** 变更门控回调：任何事件落库即通知（扩展侧 epoch +1），异常不得中断写入。 */
    private onChange?: (sessionId: string | null) => void,
  ) {}

  append(sessionId: string | null, type: string, payload: unknown): EventRow {
    const t = Date.now();
    let text = JSON.stringify(payload ?? {});
    if (Buffer.byteLength(text, 'utf8') > this.payloadCapBytes) {
      text = JSON.stringify({ truncated: true, preview: text.slice(0, this.payloadCapBytes) });
    }
    const seq =
      sessionId === null
        ? 0
        : (
            this.db
              .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM session_events WHERE session_id = ?')
              .get(sessionId) as { seq: number }
          ).seq;
    const info = this.db
      .prepare('INSERT INTO session_events (session_id, seq, event_type, payload, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(sessionId, seq, type, text, t);
    if (this.onChange) {
      try {
        this.onChange(sessionId);
      } catch {
        /* 变更通知是附属品，绝不影响事件写入 */
      }
    }
    return {
      id: Number(info.lastInsertRowid),
      session_id: sessionId,
      seq,
      event_type: type,
      payload: text,
      created_at: t,
    };
  }

  listForSession(sessionId: string, afterId = 0, limit = 200): EventRow[] {
    return this.db
      .prepare(
        'SELECT * FROM session_events WHERE session_id = ? AND id > ? ORDER BY id ASC LIMIT ?',
      )
      .all(sessionId, afterId, limit) as unknown as EventRow[];
  }

  /**
   * The `confirmation_created` event that carries a given confirmation's
   * pre-computed risk matches. Scans the WHOLE session (newest first, LIKE on
   * the id substring) rather than a bounded page: the approval card must find
   * the matches no matter how many events the session has accumulated. Returns
   * null when no such event exists (e.g. its payload was truncated).
   */
  findConfirmationCreated(sessionId: string, confirmationId: string): EventRow | null {
    const row = this.db
      .prepare(
        "SELECT * FROM session_events WHERE session_id = ? AND event_type = 'confirmation_created' AND payload LIKE ? ORDER BY id DESC LIMIT 1",
      )
      .get(sessionId, `%${confirmationId}%`) as unknown as EventRow | undefined;
    return row ?? null;
  }

  /**
   * 当日机器级事件计数（状态栏协议统计）。session_id IS NULL 限定机器级：
   * mcp_initialize / mcp_delete 只以机器事件落库，同名的会话级事件（不存在
   * 的防御位）不会被误计。
   */
  countMachineSince(type: string, sinceTs: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM session_events WHERE session_id IS NULL AND event_type = ? AND created_at >= ?')
      .get(type, sinceTs) as { n: number };
    return Number(row.n);
  }

  /** 终止/归档会话的清理：该会话的全部事件。 */
  purgeSession(sessionId: string): number {
    return Number(this.db.prepare('DELETE FROM session_events WHERE session_id = ?').run(sessionId).changes);
  }

  /**
   * 保留期清扫：只清会话级事件。机器级事件（session_id 为空，如 token 轮换、
   * skill 查询）数量极少且是机器审计痕迹，保留。
   */
  purgeSessionScopedOlderThan(cutoff: number): number {
    return Number(
      this.db.prepare('DELETE FROM session_events WHERE session_id IS NOT NULL AND created_at < ?').run(cutoff).changes,
    );
  }

  /**
   * 高频协议计数事件（mcp_initialize / mcp_session_reused / mcp_delete）例外：
   * reuse 每次调用一行，量级与调用数同水位——按同一保留期清理。当日计数只读
   * 当天，历史行仅作短期审计。低频机器审计（daemon_started、token 轮换、
   * tunnel 状态）仍永久保留。
   */
  purgeMachineProtocolCountersOlderThan(cutoff: number): number {
    return Number(
      this.db
        .prepare(
          "DELETE FROM session_events WHERE session_id IS NULL AND event_type IN ('mcp_initialize', 'mcp_session_reused', 'mcp_call_rejected', 'mcp_delete') AND created_at < ?",
        )
        .run(cutoff).changes,
    );
  }
}
