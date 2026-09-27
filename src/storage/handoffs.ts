import type { DatabaseSync } from 'node:sqlite';
import { randomId } from '../util/token.js';

export const HANDOFF_MAX_BYTES = 64 * 1024;

export interface PendingHandoff {
  id: string;
  content: string;
  created_at: number;
}

export type HandoffSummary = Pick<PendingHandoff, 'id' | 'created_at'>;

/** One pending document, not an audit history. IDs protect replacement races. */
export class HandoffsRepo {
  constructor(
    private readonly db: DatabaseSync,
    private readonly onChange?: () => void,
  ) {}

  get(sessionId: string): PendingHandoff | null {
    const row = this.db.prepare('SELECT id, content, created_at FROM session_handoffs WHERE session_id = ?')
      .get(sessionId) as PendingHandoff | undefined;
    return row ? { id: row.id, content: row.content, created_at: row.created_at } : null;
  }

  getSummary(sessionId: string): HandoffSummary | null {
    const row = this.db.prepare('SELECT id, created_at FROM session_handoffs WHERE session_id = ?')
      .get(sessionId) as HandoffSummary | undefined;
    return row ? { id: row.id, created_at: row.created_at } : null;
  }

  listSummaries(): Map<string, HandoffSummary> {
    const rows = this.db.prepare('SELECT session_id, id, created_at FROM session_handoffs').all() as unknown as Array<HandoffSummary & { session_id: string }>;
    return new Map(rows.map(row => [row.session_id, { id: row.id, created_at: row.created_at }]));
  }

  /** Capture only the revision before work; do not load the document on every call. */
  pendingId(sessionId: string): string | undefined {
    return (this.db.prepare('SELECT id FROM session_handoffs WHERE session_id = ?')
      .get(sessionId) as { id: string } | undefined)?.id;
  }

  set(sessionId: string, content: string): PendingHandoff {
    if (typeof content !== 'string' || !content.trim()) throw new Error('handoff content must not be empty');
    if (Buffer.byteLength(content, 'utf8') > HANDOFF_MAX_BYTES) throw new Error('handoff content exceeds 64 KiB');
    const record: PendingHandoff = { id: randomId('handoff'), content: content.trim(), created_at: Date.now() };
    // Admission and replacement are one statement: a terminated/missing session
    // must never gain a pending document, even after an earlier async admission.
    const result = this.db.prepare(`
      INSERT INTO session_handoffs (session_id, id, content, created_at)
      SELECT id, ?, ?, ? FROM sessions
      WHERE id = ? AND status = 'active' AND (expires_at IS NULL OR expires_at >= ?)
      ON CONFLICT(session_id) DO UPDATE SET
        id = excluded.id, content = excluded.content, created_at = excluded.created_at
    `).run(record.id, record.content, record.created_at, sessionId, record.created_at);
    if (Number(result.changes) !== 1) throw new Error('handoff session is not active');
    this.changed();
    return record;
  }

  /** Delete only the document captured when successful work began. */
  consume(sessionId: string, expectedId: string): boolean {
    const result = this.db.prepare(`
      DELETE FROM session_handoffs WHERE session_id = ? AND id = ?
      AND EXISTS (SELECT 1 FROM sessions WHERE id = ? AND status = 'active'
        AND (expires_at IS NULL OR expires_at >= ?))
    `).run(sessionId, expectedId, sessionId, Date.now());
    const removed = Number(result.changes) === 1;
    if (removed) this.changed();
    return removed;
  }

  purgeSession(sessionId: string): number {
    const removed = Number(this.db.prepare('DELETE FROM session_handoffs WHERE session_id = ?').run(sessionId).changes);
    if (removed) this.changed();
    return removed;
  }

  private changed(): void {
    try { this.onChange?.(); } catch { /* A presentation notification cannot undo durable state. */ }
  }
}
