import type { DatabaseSync } from 'node:sqlite';
import { normalizePermissionMode, type PermissionMode } from '../config.js';
import { randomSessionId, sha256 } from '../util/token.js';
import type { SessionRow, SessionStatus } from './db.js';
import { draftName } from './draftName.js';

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

/** Drafts live in memory only: a daemon restart or a day without a tool call drops them. */
export const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
export type DraftRow = SessionRow & { draft: true };

export class SessionsRepo {
  /**
   * Reserved sessions nobody has used yet (id + credential already handed out in a prompt).
   * The first tool call carrying the credential stores the row for real; closing the draft in
   * the UI, a restart or the TTL simply forgets it. Keyed by primary id.
   */
  private drafts = new Map<string, DraftRow>();
  /** Called after a draft was stored because its credential was used (events, UI refresh). */
  onDraftStored?: (row: SessionRow) => void;
  /** Called when the draft set changes without a DB write (reserve/discard), so UIs refresh. */
  onDraftsChanged?: () => void;
  /** Called when a session ends for good (revoked/archived, or a draft discarded). */
  /**
   * The session stopped being live. `reason` is what the caller did: 'revoked' = deleted for good,
   * 'archived' = put away (the row stays), 'discarded' = a draft that never ran. Courier uses it to
   * tell a delete from an archive — deleting a chat cannot be undone, archiving can.
   */
  onSessionEnded?: (id: string, reason?: 'revoked' | 'archived' | 'discarded') => void;
  /**
   * 名称或状态变化后调用（草稿也算），供 feed 重建会话 state。钩子在方法层而不是 SQL 层，否则会漏掉内存草稿分支；
   * 回调抛错不影响调用方。草稿被丢弃走 onSessionEnded('discarded')，不在此通知。
   */
  onStateChange?: (id: string) => void;

  constructor(private db: DatabaseSync) {}

  private notifyState(id: string): void {
    try { this.onStateChange?.(id); } catch { /* 只是通知，不能打断已完成的写入 */ }
  }

  private pruneDrafts(): void {
    const cut = now() - DRAFT_TTL_MS;
    for (const [id, d] of this.drafts) if (d.created_at < cut) this.drafts.delete(id);
  }

  /** Reserve a session without storing it. Same fields as create(). */
  createDraft(input: Parameters<SessionsRepo['create']>[0]): DraftRow {
    this.pruneDrafts();
    const t = now();
    const row: DraftRow = {
      id: randomSessionId(), credential_id: randomSessionId(), token_hash: '',
      name: input.name ?? null, workspace_path: input.workspace_path, status: 'active',
      permission_mode: normalizePermissionMode(input.permission_mode), writable_dirs: input.writable_dirs ?? [],
      auto_approve: !!input.auto_approve, cwd: null, created_at: t, last_active_at: t,
      sort_order: -Infinity, expires_at: input.expires_at ?? null, draft: true,
    };
    row.token_hash = sha256(row.credential_id);
    this.drafts.set(row.id, row);
    this.onDraftsChanged?.();
    return { ...row };
  }

  draft(id: string): DraftRow | undefined {
    this.pruneDrafts();
    const d = this.drafts.get(id);
    return d ? { ...d } : undefined;
  }

  /** Forget a draft (the UI closed it before any tool call). False when it is not a draft. */
  discardDraft(id: string): boolean {
    const had = this.drafts.delete(id);
    if (had) { this.onDraftsChanged?.(); this.onSessionEnded?.(id, 'discarded'); }
    return had;
  }

  /** Store a draft for real (its first message reached a web chat); undefined when not a draft. */
  commitDraft(id: string, firstMessage?: string): SessionRow | undefined {
    // The first message names a draft that has no name yet (first line, 60 characters).
    const pending = this.draft(id);
    const name = draftName(firstMessage);
    if (pending && !pending.name?.trim() && name) this.drafts.get(id)!.name = name;
    const d = this.draft(id);
    return d ? this.storeDraft(d) : undefined;
  }

  /** Store a draft for real, keeping its id and credential. */
  private storeDraft(d: DraftRow): SessionRow {
    this.drafts.delete(d.id);
    const t = now();
    const sortOrder = Number((this.db.prepare('SELECT MIN(sort_order) AS n FROM sessions').get() as { n: number | null }).n ?? 0) - 1;
    this.db
      .prepare(
        `INSERT INTO sessions (id, token_hash, credential_id, name, workspace_path, status, permission_mode, writable_dirs, auto_approve, cwd, created_at, last_active_at, sort_order, expires_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        d.id, d.token_hash, d.credential_id, d.name, d.workspace_path, d.permission_mode,
        JSON.stringify(d.writable_dirs ?? []), d.auto_approve ? '1' : '0', null, t, t, sortOrder, d.expires_at,
      );
    const row = this.get(d.id) as SessionRow;
    this.onDraftStored?.(row);
    return row;
  }

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

  /** A stored session, or a draft (flagged `draft: true`). */
  get(id: string): SessionRow | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
    return hydrateSessionRow(row) ?? this.draft(id);
  }

  /**
   * Resolve a work-tool `sessionId` argument. The numeric credential is the
   * only thing that routes: pre-migration rows adopted their primary key as
   * credential, so both spellings resolve here.
   */
  byCredential(credentialId: string): SessionRow | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE credential_id = ?').get(credentialId) as SessionRow | undefined;
    if (row) return hydrateSessionRow(row);
    // First use of a reserved credential: this is the moment the session really exists.
    this.pruneDrafts();
    for (const d of this.drafts.values()) if (d.credential_id === credentialId) return this.storeDraft(d);
    return undefined;
  }

  list(): SessionRow[] {
    const rows = this.db.prepare('SELECT * FROM sessions ORDER BY sort_order ASC, created_at DESC').all() as unknown as SessionRow[];
    for (const row of rows) hydrateSessionRow(row);
    this.pruneDrafts();
    // Drafts first (newest first), like a freshly created session.
    const drafts = [...this.drafts.values()].sort((a, b) => b.created_at - a.created_at).map((d) => ({ ...d }));
    return [...drafts, ...rows];
  }

  /** Persist the complete visible-session order atomically. */
  reorder(ids: string[]): SessionRow[] {
    ids = ids.filter((id) => !this.drafts.has(id)); // drafts always render first and have no stored order
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
  /** Apply a change to a draft in memory; undefined when `id` is not a draft. */
  private patchDraft(id: string, patch: Partial<SessionRow>): SessionRow | undefined {
    const d = this.drafts.get(id);
    if (!d) return undefined;
    Object.assign(d, patch);
    this.onDraftsChanged?.();
    return { ...d };
  }

  setWritableDirs(id: string, dirs: string[]): SessionRow | undefined {
    if (this.drafts.has(id)) return this.patchDraft(id, { writable_dirs: dirs });
    this.db.prepare('UPDATE sessions SET writable_dirs = ?, last_active_at = ? WHERE id = ?').run(JSON.stringify(dirs), now(), id);
    return this.get(id);
  }

  /** M4.6：启停 auto_approve（confirm 级操作跳过审批卡）。 */
  setAutoApprove(id: string, value: boolean): SessionRow | undefined {
    if (this.drafts.has(id)) return this.patchDraft(id, { auto_approve: value });
    // 存 TEXT '1'/'0'，与 create 的写入一致（读取端 String() 归一，避免 INTEGER/TEXT 混用）
    this.db.prepare('UPDATE sessions SET auto_approve = ?, last_active_at = ? WHERE id = ?').run(value ? '1' : '0', now(), id);
    return this.get(id);
  }

  setStatus(id: string, status: SessionStatus): SessionRow | undefined {
    if (this.drafts.has(id)) {
      // Ending a draft just forgets it; pause/resume only make sense once it exists.
      if (status === 'revoked' || status === 'archived') { const d = this.draft(id)!; this.discardDraft(id); return { ...d, status }; }
      const patched = this.patchDraft(id, { status });
      this.notifyState(id);
      return patched;
    }
    this.db.prepare('UPDATE sessions SET status = ?, last_active_at = ? WHERE id = ?').run(status, now(), id);
    if (status === 'revoked' || status === 'archived') this.onSessionEnded?.(id, status);
    this.notifyState(id);
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
    if (this.drafts.has(id)) return this.patchDraft(id, { credential_id: credentialId, token_hash: sha256(credentialId) });
    this.db
      .prepare('UPDATE sessions SET credential_id = ?, token_hash = ?, last_active_at = ? WHERE id = ?')
      .run(credentialId, sha256(credentialId), now(), id);
    return this.get(id);
  }

  /** Rename (null/empty clears it back to the default title). */
  setName(id: string, name: string | null): SessionRow | undefined {
    const value = name && name.trim() ? name.trim().slice(0, 500) : null;
    if (this.drafts.has(id)) {
      const patched = this.patchDraft(id, { name: value });
      this.notifyState(id);
      return patched;
    }
    this.db.prepare('UPDATE sessions SET name = ? WHERE id = ?').run(value, id);
    this.notifyState(id);
    return this.get(id);
  }

  /** Runtime mode switch (the dsh `sandbox/mode` precedent, folded by read). */
  setPermissionMode(id: string, mode: PermissionMode): SessionRow | undefined {
    if (this.drafts.has(id)) return this.patchDraft(id, { permission_mode: mode });
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
