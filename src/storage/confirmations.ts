import { EventEmitter } from 'node:events';
import type { DatabaseSync } from 'node:sqlite';
import { randomId } from '../util/token.js';
import type { MachineStateRepo } from './machineState.js';
import type { ApprovalUnit } from '../workspace/risk.js';
import type { ApprovalScope, ConfirmationRow } from './db.js';

// Kept short on purpose: a web agent's MCP call has its own client-side
// timeout, so an approval card that outlives it only produces an approval the
// caller can no longer use. 90s lets the operator react while staying under
// typical MCP client timeouts.
export const CONFIRMATION_TTL_MS = 90_000;

/**
 * In-process pub/sub for synchronous approval waiting. When a tool call hits a
 * high-risk command, it creates a confirmation and awaits resolution via this
 * bus. The control API (`POST /confirmations/:id/approve|deny`) publishes here,
 * waking the blocked request so the result travels back on the same HTTP
 * response. If the HTTP connection drops first (client timeout), the
 * confirmation row survives in SQLite and the agent's retry hits
 * `takeApproved()` — the hybrid fallback.
 */
export const confirmationBus = new EventEmitter();
confirmationBus.setMaxListeners(0); // unbounded: one listener per pending confirmation

export class ConfirmationsRepo {
  /** Category grants per session ("本会话同意"), dying with the process. */
  private readonly sessionGrants = new Map<string, Set<string>>();
  /** Persistent 'always' grant keys (pattern ids / path parent-dirs). */
  private alwaysGrants = new Set<string>();

  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync, private state: MachineStateRepo) {
    this.db = db;
    this.loadAlwaysGrants();
  }

  create(sessionId: string, tool: string, argsJson: string, argsHash: string, ttlMs = CONFIRMATION_TTL_MS): ConfirmationRow {
    const id = randomId('cfrm');
    const t = Date.now();
    this.db
      .prepare(
        `INSERT INTO confirmations (id, session_id, tool, args_json, args_hash, status, created_at, expires_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, NULL)`,
      )
      .run(id, sessionId, tool, argsJson, argsHash, t, t + ttlMs);
    return this.get(id) as ConfirmationRow;
  }

  get(id: string): ConfirmationRow | undefined {
    return this.db.prepare('SELECT * FROM confirmations WHERE id = ?').get(id) as ConfirmationRow | undefined;
  }

  /** One approved confirmation is consumed by exactly one matching retry. */
  takeApproved(sessionId: string, argsHash: string): ConfirmationRow | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM confirmations
         WHERE session_id = ? AND args_hash = ? AND status = 'approved' AND expires_at > ?
         ORDER BY created_at ASC LIMIT 1`,
      )
      .get(sessionId, argsHash, Date.now()) as ConfirmationRow | undefined;
    if (!row) return undefined;
    this.resolve(row.id, 'consumed');
    return row;
  }

  /**
   * 找同会话同命令的在途确认。agent 客户端超时重试会带着相同 args_hash 在
   * 原确认仍 pending 时再次进入审批流——必须共享同一条确认，否则旧确认会在
   * 用户批准后仍以 pending 滞留到 TTL（活动栏计数不清零的根源）。
   */
  findPending(sessionId: string, argsHash: string): ConfirmationRow | undefined {
    return this.db
      .prepare(
        "SELECT * FROM confirmations WHERE session_id = ? AND args_hash = ? AND status = 'pending' AND expires_at > ? ORDER BY created_at ASC LIMIT 1",
      )
      .get(sessionId, argsHash, Date.now()) as ConfirmationRow | undefined;
  }

  /** daemon 重启时清理：等待者的 HTTP 请求已随旧进程消亡，遗留 pending 是幽灵。 */
  markAllPendingExpired(): number {
    return Number(
      this.db.prepare("UPDATE confirmations SET status = 'expired', resolved_at = ? WHERE status = 'pending'").run(Date.now())
        .changes,
    );
  }

  resolve(id: string, status: 'approved' | 'denied' | 'expired' | 'consumed', scope?: ApprovalScope): ConfirmationRow | undefined {
    if (scope) {
      this.db
        .prepare('UPDATE confirmations SET status = ?, resolved_at = ?, scope = ? WHERE id = ?')
        .run(status, Date.now(), scope, id);
    } else {
      this.db.prepare('UPDATE confirmations SET status = ?, resolved_at = ? WHERE id = ?').run(status, Date.now(), id);
    }
    const row = this.get(id);
    // Wake any synchronous waiter blocked on this confirmation.
    confirmationBus.emit('resolved', id, status, row);
    return row;
  }

  /**
   * Remember a scope grant ("本会话"/"始终" approvals) so matching
   * confirmations never ask again. Units are stable pattern identities or
   * path parent-dirs (see risk.ts approvalUnits) — a grant covers exactly
   * what the operator saw on the card. `critical` units are refused for the
   * 'always' scope (irreversible ops keep a per-boot window only). 'always'
   * grants persist in machine_state so a daemon restart no longer forgets
   * them; 'session' grants stay in memory and die with the process.
   */
  grant(sessionId: string | null, units: readonly ApprovalUnit[], scope: Exclude<ApprovalScope, 'once'>): void {
    if (units.length === 0) return;
    if (scope === 'always') {
      const next = new Set(this.alwaysGrants);
      for (const u of units) {
        if (u.level === 'critical') continue; // no-ask on irreversible ops never survives a restart
        next.add(u.key);
      }
      this.alwaysGrants = next;
      this.persistAlwaysGrants();
      return;
    }
    let set = this.sessionGrants.get(sessionId!);
    if (!set) {
      set = new Set();
      this.sessionGrants.set(sessionId!, set);
    }
    for (const u of units) set.add(u.key);
  }

  /**
   * The scope that already covers every unit, so the call can run without
   * a new confirmation: 'always' beats 'session'.
   */
  matchGrant(sessionId: string, units: readonly ApprovalUnit[]): 'session' | 'always' | undefined {
    if (units.length === 0) return undefined;
    const sess = this.sessionGrants.get(sessionId);
    const covered = units.every((u) => this.alwaysGrants.has(u.key) || sess?.has(u.key));
    if (!covered) return undefined;
    return units.every((u) => this.alwaysGrants.has(u.key)) ? 'always' : 'session';
  }

  /** All persistent 'always' units (status-bar display + audits). */
  listAlwaysGrants(): string[] {
    return [...this.alwaysGrants].sort();
  }

  /**
   * In-memory per-session grants. These are effective standing permissions for
   * the lifetime of this daemon process, so the operator UI must be able to
   * inspect them even though they are intentionally not persisted.
   */
  listSessionGrants(): { sessionId: string; grants: string[] }[] {
    return [...this.sessionGrants.entries()]
      .filter(([, grants]) => grants.size > 0)
      .map(([sessionId, grants]) => ({ sessionId, grants: [...grants].sort() }))
      .sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  }

  /** Drop one in-memory session grant key; true when it existed. */
  removeSessionGrant(sessionId: string, key: string): boolean {
    const grants = this.sessionGrants.get(sessionId);
    if (!grants?.delete(key)) return false;
    if (grants.size === 0) this.sessionGrants.delete(sessionId);
    return true;
  }

  /** Drop every persistent 'always' grant (the one-click reset valve). */
  clearAlwaysGrants(): number {
    const n = this.alwaysGrants.size;
    this.alwaysGrants = new Set();
    this.persistAlwaysGrants();
    return n;
  }

  /** Drop one grant key; true when it existed. */
  removeAlwaysGrant(key: string): boolean {
    if (!this.alwaysGrants.has(key)) return false;
    this.alwaysGrants = new Set([...this.alwaysGrants].filter((k) => k !== key));
    this.persistAlwaysGrants();
    return true;
  }

  /** machine_state row carrying the persistent always-grant keys. */
  private static ALWAYS_KEY = 'always_grants';

  private persistAlwaysGrants(): void {
    this.state.set(ConfirmationsRepo.ALWAYS_KEY, JSON.stringify([...this.alwaysGrants]));
  }

  private loadAlwaysGrants(): void {
    const raw = this.state.get(ConfirmationsRepo.ALWAYS_KEY);
    if (typeof raw !== 'string' || raw === '') return;
    try {
      const keys = JSON.parse(raw) as string[];
      if (Array.isArray(keys)) this.alwaysGrants = new Set(keys.filter((k) => typeof k === 'string'));
    } catch {
      /* corrupted row: start clean rather than fail the daemon */
    }
  }

  expireStale(): number {
    const now = Date.now();
    const stale = this.db
      .prepare("UPDATE confirmations SET status = 'expired', resolved_at = ? WHERE status = 'pending' AND expires_at <= ? RETURNING id")
      .all(now, now) as { id: string }[];
    for (const r of stale) confirmationBus.emit('resolved', r.id, 'expired', this.get(r.id));
    return stale.length;
  }

  list(sessionId?: string): ConfirmationRow[] {
    if (sessionId) {
      return this.db
        .prepare('SELECT * FROM confirmations WHERE session_id = ? ORDER BY created_at DESC LIMIT 200')
        .all(sessionId) as unknown as ConfirmationRow[];
    }
    return this.db.prepare('SELECT * FROM confirmations ORDER BY created_at DESC LIMIT 200').all() as unknown as ConfirmationRow[];
  }

  /** Today's operator-DENIED risky commands (status-bar security signal). */
  deniedSince(ts: number): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM confirmations WHERE status = 'denied' AND resolved_at >= ?")
      .get(ts) as { n: number };
    return Number(row.n);
  }

  /** 终止/归档会话的清理：确认记录 + 进程内 session grants。 */
  purgeSession(sessionId: string): number {
    this.sessionGrants.delete(sessionId);
    return Number(this.db.prepare('DELETE FROM confirmations WHERE session_id = ?').run(sessionId).changes);
  }

  /** 保留期清扫：删除截止时间之前创建的确认记录（均为终态）。 */
  purgeOlderThan(cutoff: number): number {
    return Number(this.db.prepare('DELETE FROM confirmations WHERE created_at < ?').run(cutoff).changes);
  }
}
