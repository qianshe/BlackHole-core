import type { DatabaseSync } from 'node:sqlite';
import { isWorkspaceFileTool } from '../tool-routing.js';

export interface ActivityCounts { total: number; diff_added: number; diff_removed: number }
export const emptyCounts = (): ActivityCounts => ({ total: 0, diff_added: 0, diff_removed: 0 });
/** The local calendar date at execution time, not a fixed 24-hour UTC bucket. */
export function activityDate(time: number): string {
  const d = new Date(time);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function editorDelta(tool: string, status: string, text: string | null): { added: number; removed: number } {
  const valid = (x: unknown): number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 ? x : 0;
  if (!isWorkspaceFileTool(tool) || status !== 'completed' || !text) return { added: 0, removed: 0 };
  try {
    const diff = JSON.parse(text)?.result?.diff;
    return { added: valid(diff?.added), removed: valid(diff?.removed) };
  } catch { return { added: 0, removed: 0 }; }
}
export function atomicActivity<T>(db: DatabaseSync, action: () => T): T {
  db.exec('SAVEPOINT activity_write');
  try { const value = action(); db.exec('RELEASE activity_write'); return value; }
  catch (error) { db.exec('ROLLBACK TO activity_write; RELEASE activity_write'); throw error; }
}
export function addActivity(db: DatabaseSync, day: string, total: number, added: number, removed: number): void {
  db.prepare(`INSERT INTO daily_activity(day,total,diff_added,diff_removed) VALUES(?,?,?,?)
    ON CONFLICT(day) DO UPDATE SET total=total+excluded.total,
      diff_added=diff_added+excluded.diff_added, diff_removed=diff_removed+excluded.diff_removed`)
    .run(day, total, added, removed);
}
/** One-time upgrade only. Display reads never scan or parse the call ledger. */
export function migrateActivity(db: DatabaseSync): void {
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='daily_activity'").get()) return;
  atomicActivity(db, () => {
    const columns = db.prepare('PRAGMA table_info(tool_calls)').all() as { name: string }[];
    for (const [name, type] of [['activity_day', 'TEXT'], ['diff_added', 'INTEGER NOT NULL DEFAULT 0'], ['diff_removed', 'INTEGER NOT NULL DEFAULT 0']]) {
      if (!columns.some(c => c.name === name)) db.exec(`ALTER TABLE tool_calls ADD COLUMN ${name} ${type}`);
    }
    db.exec(`CREATE TABLE daily_activity(day TEXT PRIMARY KEY, total INTEGER NOT NULL DEFAULT 0,
      diff_added INTEGER NOT NULL DEFAULT 0, diff_removed INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS idx_tool_calls_created_at ON tool_calls(created_at)`);
    const since = new Date(); since.setHours(0,0,0,0); since.setDate(since.getDate()-6);
    const rows = db.prepare('SELECT id,tool,status,created_at,result_summary FROM tool_calls WHERE created_at >= ?');
    const update = db.prepare('UPDATE tool_calls SET activity_day=?,diff_added=?,diff_removed=? WHERE id=?');
    for (const row of rows.iterate(since.getTime()) as Iterable<{ id: string; tool: string; status: string; created_at: number; result_summary: string | null }>) {
      const day = activityDate(row.created_at), delta = editorDelta(row.tool, row.status, row.result_summary);
      update.run(day, delta.added, delta.removed, row.id);
      addActivity(db, day, 1, delta.added, delta.removed);
    }
  });
}
