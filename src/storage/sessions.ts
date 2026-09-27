import type { DatabaseSync } from 'node:sqlite';
import { normalizePermissionMode, type PermissionMode } from '../config.js';
import { randomSessionId, sha256 } from '../util/token.js';
import type { SessionRow, SessionStatus } from './db.js';

const now = () => Date.now();

/** 行读取后的归一：writable_dirs TEXT → string[]（旧库/空值 → []）+ 模式归一。 */
function hydrateSessionRow(row: SessionRow | undefined): SessionRow | undefined {
  if (!row) return row;
  row.permission_mode = normalizePermissionMode(row.permission_mode);
  try {
    const parsed = row.writable_dirs === null || row.writable_dirs === undefined
      ? []
      : JSON.parse(row.writable_dirs as unknown as string);
    row.writable_dirs = Array.isArray(parsed) ? parsed.filter((d): d is string => typeof d === 'string') : [];
  } catch {
    row.writable_dirs = [];
  }
  row.auto_approve = String(row.auto_approve) === '1' || row.auto_approve === true;
  return row;
}

export class SessionsRepo {
  constructor(private db: DatabaseSync) {}

  create(input: {
    workspace_path: string;
    permission_mode: PermissionMode;
    /** Task text the operator typed at creation; doubles as the display name. */
    name?: string | null;
    expires_at?: number | null;
    /** 额外内核写授权目录（M4.6 writableDirs）；存 JSON TEXT。 */
    writable_dirs?: string[];
    /** M4.6 auto_approve：confirm 级操作跳过审批卡。 */
    auto_approve?: boolean;
  }): SessionRow {
    // Primary key and credential are two independent random numbers: rotate
    // swaps only the credential (what agents see), audit rows keep pointing at
    // the stable primary key. token_hash is legacy — kept UNIQUE-valued with
    // sha256(credential) purely to satisfy the old constraint.
    const id = randomSessionId();
    const credentialId = randomSessionId();
    const t = now();
    const sortOrder = Number((this.db.prepare('SELECT MIN(sort_order) AS n FROM sessions').get() as { n: number | null }).n ?? 0) - 1;
    this.db
      .prepare(
        `INSERT INTO sessions (id, token_hash, credential_id, name, workspace_path, status, permission_mode, writable_dirs, auto_approve, cwd, created_at, last_active_at, sort_order, expires_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id, sha256(credentialId), credentialId, input.name ?? null, input.workspace_path,
        input.permission_mode, JSON.stringify(input.writable_dirs ?? []), input.auto_approve ? '1' : '0', null, t, t, sortOrder, input.expires_at ?? null,
      );
    return this.get(id) as SessionRow;
  }

  get(id: string): SessionRow | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
    return hydrateSessionRow(row);
  }

  /**
   * Resolve a work-tool `sessionId` argument. The numeric credential is the
   * only thing that routes: pre-migration rows adopted their primary key as
   * credential, so both spellings resolve here.
   */
  byCredential(credentialId: string): SessionRow | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE credential_id = ?').get(credentialId) as SessionRow | undefined;
    return hydrateSessionRow(row);
  }

  list(): SessionRow[] {
    const rows = this.db.prepare('SELECT * FROM sessions ORDER BY sort_order ASC, created_at DESC').all() as unknown as SessionRow[];
    for (const row of rows) hydrateSessionRow(row);
    return rows;
  }

  /** Persist the complete visible-session order atomically. */
  reorder(ids: string[]): SessionRow[] {
    const live = this.db.prepare("SELECT id FROM sessions WHERE status NOT IN ('revoked','archived') ORDER BY sort_order ASC, created_at DESC").all() as { id: string }[];
    const expected = new Set(live.map((row) => row.id));
    if (ids.length !== expected.size || new Set(ids).size !== ids.length || ids.some((id) => !expected.has(id))) {
      throw new Error('session_order_stale');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const update = this.db.prepare('UPDATE sessions SET sort_order = ? WHERE id = ?');
      ids.forEach((id, index) => update.run(index, id));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.list();
  }

  /** M4.6：替换会话的额外写授权目录（设置页/路由变更后 respawn shell 生效）。 */
  setWritableDirs(id: string, dirs: string[]): SessionRow | undefined {
    this.db.prepare('UPDATE sessions SET writable_dirs = ?, last_active_at = ? WHERE id = ?').run(JSON.stringify(dirs), now(), id);
    return this.get(id);
  }

  /** M4.6：启停 auto_approve（confirm 级操作跳过审批卡）。 */
  setAutoApprove(id: string, value: boolean): SessionRow | undefined {
    // 存 TEXT '1'/'0'，与 create 的写入一致（读取端 String() 归一，避免 INTEGER/TEXT 混用）
    this.db.prepare('UPDATE sessions SET auto_approve = ?, last_active_at = ? WHERE id = ?').run(value ? '1' : '0', now(), id);
    return this.get(id);
  }

  setStatus(id: string, status: SessionStatus): SessionRow | undefined {
    this.db.prepare('UPDATE sessions SET status = ?, last_active_at = ? WHERE id = ?').run(status, now(), id);
    return this.get(id);
  }

  /**
   * Reset the session id after a suspected leak: the old credential stops
   * resolving on the very next call, while the session (shell, todos, audit
   * trail) lives on under the stable primary key. Returns the row carrying the
   * fresh credential for the operator to hand the agent.
   */
  rotateCredential(id: string): SessionRow | undefined {
    const credentialId = randomSessionId();
    this.db
      .prepare('UPDATE sessions SET credential_id = ?, token_hash = ?, last_active_at = ? WHERE id = ?')
      .run(credentialId, sha256(credentialId), now(), id);
    return this.get(id);
  }

  /** Runtime mode switch (the dsh `sandbox/mode` precedent, folded by read). */
  setPermissionMode(id: string, mode: PermissionMode): SessionRow | undefined {
    this.db.prepare('UPDATE sessions SET permission_mode = ?, last_active_at = ? WHERE id = ?').run(mode, now(), id);
    return this.get(id);
  }

  setCwd(id: string, cwd: string): void {
    this.db.prepare('UPDATE sessions SET cwd = ?, last_active_at = ? WHERE id = ?').run(cwd, now(), id);
  }

  touch(id: string): void {
    this.db.prepare('UPDATE sessions SET last_active_at = ? WHERE id = ?').run(now(), id);
  }
}
