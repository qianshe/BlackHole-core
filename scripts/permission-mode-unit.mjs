import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { normalizePermissionMode } from '../dist/config.js';
import { openDb } from '../dist/storage/db.js';
import { SessionsRepo } from '../dist/storage/sessions.js';
import { assessCommand } from '../dist/workspace/risk.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-permission-mode-'));
const dbPath = path.join(tmp, 'db.sqlite');

try {
  // Model the already-shipped two-mode schema, including newer session fields
  // that must survive a CHECK-constraint rebuild.
  const old = new DatabaseSync(dbPath);
  old.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      token_hash TEXT UNIQUE NOT NULL,
      credential_id TEXT,
      name TEXT,
      workspace_path TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active','paused','revoked','archived')),
      permission_mode TEXT NOT NULL CHECK (permission_mode IN ('workspace-write','read-only')),
      writable_dirs TEXT,
      auto_approve TEXT,
      cwd TEXT,
      created_at INTEGER NOT NULL,
      last_active_at INTEGER NOT NULL,
      expires_at INTEGER
    );
  `);
  old.prepare(`
    INSERT INTO sessions
      (id, token_hash, credential_id, name, workspace_path, status, permission_mode, writable_dirs, auto_approve, cwd, created_at, last_active_at, expires_at)
    VALUES (?, ?, ?, ?, ?, 'active', 'workspace-write', ?, '1', ?, 1, 2, NULL)
  `).run('sess-1', 'hash-1', '1234567890', 'existing', tmp, JSON.stringify([tmp]), tmp);
  old.close();

  const storage = openDb(dbPath);
  const schema = storage.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='sessions'").get().sql;
  assert.match(schema, /danger-full-access/, 'sessions CHECK must include danger-full-access');
  const row = storage.db.prepare('SELECT * FROM sessions WHERE id = ?').get('sess-1');
  assert.equal(row.credential_id, '1234567890', 'credential_id survives mode migration');
  assert.equal(row.writable_dirs, JSON.stringify([tmp]), 'writable_dirs survives mode migration');
  assert.equal(row.auto_approve, '1', 'auto_approve survives mode migration');
  storage.db.prepare('UPDATE sessions SET permission_mode = ? WHERE id = ?').run('danger-full-access', 'sess-1');
  assert.equal(storage.db.prepare('SELECT permission_mode FROM sessions WHERE id = ?').get('sess-1').permission_mode, 'danger-full-access');
  const sessions = new SessionsRepo(storage.db);
  assert.equal(sessions.get('sess-1')?.permission_mode, 'danger-full-access', 'repo hydration preserves danger-full-access');
  const created = sessions.create({ workspace_path: tmp, permission_mode: 'danger-full-access', name: 'full access' });
  assert.equal(created.permission_mode, 'danger-full-access', 'repo create persists danger-full-access');
  storage.close();

  assert.equal(normalizePermissionMode('danger-full-access'), 'danger-full-access');
  assert.equal(normalizePermissionMode('trusted'), 'workspace-write', 'legacy trusted must not silently escalate');

  const ctx = { workspaceRoot: tmp, cwd: tmp };
  const destructiveOutside = `Remove-Item -Recurse -Force ${path.parse(tmp).root}outside-danger-test`;
  assert.equal(assessCommand('danger-full-access', destructiveOutside, ctx), 'allow', 'full access bypasses normal approval gate');
  assert.equal(assessCommand('workspace-write', destructiveOutside, ctx), 'confirm', 'workspace-write keeps approval gate');
  assert.equal(assessCommand('read-only', destructiveOutside, ctx), 'deny', 'read-only remains hard denied');

  const sidebarSource = fs.readFileSync(path.join(process.cwd(), 'packages', 'vscode', 'src', 'sidebar.ts'), 'utf8');
  assert.match(sidebarSource, /\{ mode: 'read-only', label: '只读' \}/, 'VS Code menu exposes read-only');
  assert.match(sidebarSource, /\{ mode: 'workspace-write', label: '工作区可写' \}/, 'VS Code menu exposes workspace-write');
  assert.match(sidebarSource, /\{ mode: 'danger-full-access', label: '完全访问', danger: true \}/, 'VS Code menu exposes full access');
  assert.match(sidebarSource, /showWarningMessage[\s\S]*启用完全访问/, 'entering full access requires operator confirmation');
  const routerSource = fs.readFileSync(path.join(process.cwd(), 'src', 'mcp', 'router.ts'), 'utf8');
  assert.match(routerSource, /process\.platform === 'win32' && mode !== 'danger-full-access'[\s\S]*makeSandboxedShell/, 'Windows full access must bypass the ACL shell');

  console.log('PERMISSION MODE UNIT PASS');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
