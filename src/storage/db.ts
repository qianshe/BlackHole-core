import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrateActivity } from './activity.js';

export type SessionStatus = 'active' | 'paused' | 'revoked' | 'archived';

/**
 * How an operator approved a confirmation: `once` (this call only),
 * `session` (this category within the session) or `always` (this category
 * for the daemon's lifetime, every session).
 */
export type ApprovalScope = 'once' | 'session' | 'always';

export interface SessionRow {
  id: string;
  /**
   * Legacy column from the activation-value era (hash of the old session key).
   * Nothing routes on it anymore; new rows store sha256(credential_id) purely
   * to satisfy the UNIQUE NOT NULL constraint.
   */
  token_hash: string;
  /**
   * The numeric id agents pass as `sessionId` on every work-tool call — the
   * single credential of the single-layer model. `rotate` replaces it (the old
   * id stops resolving immediately) while the primary key stays put, so audit
   * rows stay attached to one session across resets.
   */
  credential_id: string;
  /** Optional task text: shown as the session name, interpolated into prompt templates. */
  name: string | null;
  workspace_path: string;
  status: SessionStatus;
  permission_mode: string;
  /** 额外内核写授权目录（M4.6 writableDirs）；JSON 数组存 TEXT，空 = 未配置。 */
  writable_dirs: string[];
  /** M4.6 auto_approve：confirm 级操作跳过审批卡直接执行（存 '1'/'0' TEXT）。 */
  auto_approve: string | number | boolean;
  cwd: string | null;
  created_at: number;
  last_active_at: number;
  /** Operator-defined sidebar order; lower values render first. */
  sort_order: number;
  expires_at: number | null;
}

export interface EventRow {
  id: number;
  session_id: string | null;
  seq: number;
  event_type: string;
  payload: string;
  created_at: number;
}

export interface ToolCallRow {
  id: string;
  session_id: string;
  tool: string;
  args_json: string;
  args_hash: string;
  status: 'started' | 'awaiting' | 'completed' | 'failed' | 'denied' | 'unknown';
  result_summary: string | null;
  /** Local UI navigation metadata for resource-bearing calls; never exposed to the agent. */
  navigation_json: string | null;
  approval_scope: ApprovalScope | null;
  created_at: number;
  updated_at: number;
}

export interface ConfirmationRow {
  id: string;
  session_id: string;
  tool: string;
  args_json: string;
  args_hash: string;
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'consumed';
  /** The scope the operator chose at approval time; NULL until resolved. */
  scope: ApprovalScope | null;
  created_at: number;
  expires_at: number;
  resolved_at: number | null;
}

function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      token_hash TEXT UNIQUE NOT NULL,
      name TEXT,
      workspace_path TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active','paused','revoked','archived')),
      permission_mode TEXT NOT NULL CHECK (permission_mode IN ('read-only','workspace-write','danger-full-access')),
      cwd TEXT,
      created_at INTEGER NOT NULL,
      last_active_at INTEGER NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS session_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      seq INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_events_session_seq ON session_events(session_id, seq);
    CREATE INDEX IF NOT EXISTS idx_events_session_id ON session_events(session_id, id);
    -- /api/health counts today's machine-level events four times per poll; without
    -- this they scan every machine event (tens of thousands on long-lived installs).
    CREATE INDEX IF NOT EXISTS idx_events_machine_type_time ON session_events(event_type, created_at) WHERE session_id IS NULL;

    CREATE TABLE IF NOT EXISTS tool_calls (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      tool TEXT NOT NULL,
      args_json TEXT NOT NULL,
      args_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('started','awaiting','completed','failed','denied','unknown')),
      result_summary TEXT,
      navigation_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id, created_at);

    CREATE TABLE IF NOT EXISTS confirmations (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      tool TEXT NOT NULL,
      args_json TEXT NOT NULL,
      args_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending','approved','denied','expired','consumed')),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      resolved_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_confirmations_session ON confirmations(session_id, status);

    -- one task board per session (the MCP "todo" tool): a single JSON document
    -- row per session — full-replace protocol, bounded size, dies with the session
    CREATE TABLE IF NOT EXISTS session_todos (
      session_id TEXT PRIMARY KEY,
      items_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- machine-scoped key/value rows (e.g. the operator-set MCP access token
    -- override); single logical row with fixed key 'machine'
    CREATE TABLE IF NOT EXISTS machine_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  // `name` (the task text doubling as the session's display name) was added
  // after the first release: backfill existing DBs with a guarded ALTER.
  const cols = db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
  if (!cols.some((c) => c.name === 'name')) db.exec('ALTER TABLE sessions ADD COLUMN name TEXT');
  // confirmations record the approval scope the operator chose (once /
  // session / always). Plain nullable column, guarded ALTER.
  const confCols = db.prepare('PRAGMA table_info(confirmations)').all() as { name: string }[];
  if (!confCols.some((c) => c.name === 'scope')) db.exec('ALTER TABLE confirmations ADD COLUMN scope TEXT');

  // tool_calls gained the 'awaiting' / 'denied' statuses (approval flow).
  // SQLite cannot alter a CHECK constraint in place: rebuild the table when
  // the pre-existing DDL is still there. Fresh databases already create the
  // new CHECK above, so the rebuild runs at most once per old database.
  const tcSql = (
    db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tool_calls'").get() as
      | { sql: string }
      | undefined
  )?.sql;
  if (tcSql && !tcSql.includes("'awaiting'")) {
    db.exec(`
      CREATE TABLE tool_calls_rebuild (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        args_json TEXT NOT NULL,
        args_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('started','awaiting','completed','failed','denied','unknown')),
        result_summary TEXT,
        navigation_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO tool_calls_rebuild
        SELECT id, session_id, tool, args_json, args_hash, status, result_summary, NULL, created_at, updated_at FROM tool_calls;
      DROP TABLE tool_calls;
      ALTER TABLE tool_calls_rebuild RENAME TO tool_calls;
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id, created_at)');
  }


  // Normalize the sessions row shape before any permission CHECK rebuild so a
  // mode migration never drops newer per-session state.
  let sessCols = db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
  if (!sessCols.some((c) => c.name === 'credential_id')) {
    db.exec('ALTER TABLE sessions ADD COLUMN credential_id TEXT');
    db.exec('UPDATE sessions SET credential_id = id WHERE credential_id IS NULL');
  }
  if (!sessCols.some((c) => c.name === 'writable_dirs')) db.exec('ALTER TABLE sessions ADD COLUMN writable_dirs TEXT');
  if (!sessCols.some((c) => c.name === 'auto_approve')) db.exec('ALTER TABLE sessions ADD COLUMN auto_approve TEXT');
  if (!sessCols.some((c) => c.name === 'sort_order')) db.exec('ALTER TABLE sessions ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0');
  // sessions permission modes now include explicit operator-selected full host
  // access. SQLite cannot alter a CHECK in place, so rebuild any older schema.
  // Preserve every current per-session field during the swap. Legacy
  // trusted/guarded spellings remain conservative: they become workspace-write.
  const sessSql = (
    db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").get() as
      | { sql: string }
      | undefined
  )?.sql;
  if (sessSql && !sessSql.includes("'danger-full-access'")) {
    db.exec(`
      CREATE TABLE sessions_rebuild (
        id TEXT PRIMARY KEY,
        token_hash TEXT UNIQUE NOT NULL,
        credential_id TEXT,
        name TEXT,
        workspace_path TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active','paused','revoked','archived')),
        permission_mode TEXT NOT NULL CHECK (permission_mode IN ('read-only','workspace-write','danger-full-access')),
        writable_dirs TEXT,
        auto_approve TEXT,
        cwd TEXT,
        created_at INTEGER NOT NULL,
        last_active_at INTEGER NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        expires_at INTEGER
      );
      INSERT INTO sessions_rebuild
        SELECT id, token_hash, credential_id, name, workspace_path, status,
          CASE
            WHEN permission_mode = 'read-only' THEN 'read-only'
            WHEN permission_mode = 'danger-full-access' THEN 'danger-full-access'
            ELSE 'workspace-write'
          END,
          writable_dirs, auto_approve, cwd, created_at, last_active_at, sort_order, expires_at
        FROM sessions;
      DROP TABLE sessions;
      ALTER TABLE sessions_rebuild RENAME TO sessions;
    `);
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash)');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_credential ON sessions(credential_id)');

  // tool_calls record the approval scope the call ran under (once / session /
  // always). Must run after the CHECK-constraint rebuild above — the rebuild
  // copies a fixed column list and would drop the column otherwise.
  const tcCols = db.prepare('PRAGMA table_info(tool_calls)').all() as { name: string }[];
  if (!tcCols.some((c) => c.name === 'approval_scope')) db.exec('ALTER TABLE tool_calls ADD COLUMN approval_scope TEXT');
  if (!tcCols.some((c) => c.name === 'navigation_json')) db.exec('ALTER TABLE tool_calls ADD COLUMN navigation_json TEXT');

  // Create after legacy session-table rebuilds. Pending handoffs are not history.
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_handoffs (
      session_id TEXT PRIMARY KEY,
      id TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS handoff_session_terminated
      AFTER UPDATE OF status ON sessions
      WHEN NEW.status IN ('revoked', 'archived')
      BEGIN DELETE FROM session_handoffs WHERE session_id = NEW.id; END;
    CREATE TRIGGER IF NOT EXISTS handoff_session_deleted
      AFTER DELETE ON sessions
      BEGIN DELETE FROM session_handoffs WHERE session_id = OLD.id; END;
  `);
}

export function maintainDb(db: DatabaseSync, dbPath: string): { checkpointed: boolean; reclaimed: boolean; freeRatio: number } {
  let checkpointed = false;
  try { db.exec('PRAGMA wal_checkpoint(PASSIVE);'); checkpointed = true; } catch { /* busy readers/writers: skip */ }
  const pages = Number((db.prepare('PRAGMA page_count').get() as { page_count?: number }).page_count ?? 0);
  const free = Number((db.prepare('PRAGMA freelist_count').get() as { freelist_count?: number }).freelist_count ?? 0);
  const freeRatio = pages > 0 ? free / pages : 0;
  let reclaimed = false;
  try {
    if (fs.statSync(dbPath).size >= 64 * 1024 * 1024 && freeRatio >= 0.25) {
      db.exec('VACUUM;');
      reclaimed = true;
    }
  } catch { /* maintenance must never block daemon startup */ }
  return { checkpointed, reclaimed, freeRatio };
}

export interface Storage {
  db: DatabaseSync;
  close(): void;
}

export function openDb(dbPath: string): Storage {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  // Extension upgrades can briefly overlap the retiring and replacement daemon.
  // Wait for short-lived SQLite writers instead of aborting startup immediately.
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  migrateActivity(db);
  return {
    db,
    close: () => db.close(),
  };
}
