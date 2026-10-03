// Session drafts: reserved in memory, stored on the first credential use, discarded on revoke.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';
import { openDb } from '../dist/storage/db.js';
import { SessionsRepo } from '../dist/storage/sessions.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-drafts-'));
const storage = openDb(path.join(dir, 'db.sqlite'));
after(() => { try { storage.db.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
const input = { workspace_path: dir, permission_mode: 'workspace-write', name: 'Draft task' };

test('draft is listed and readable but not stored', () => {
  const repo = new SessionsRepo(storage.db);
  let changed = 0; repo.onDraftsChanged = () => changed++;
  const d = repo.createDraft(input);
  assert.equal(d.draft, true);
  assert.equal(changed, 1);
  assert.equal(repo.get(d.id)?.draft, true);
  assert.equal(repo.list()[0].id, d.id);
  assert.equal(storage.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE id = ?').get(d.id).n, 0);
  assert.equal(repo.discardDraft(d.id), true);
  assert.equal(repo.get(d.id), undefined);
  assert.equal(repo.byCredential(d.credential_id), undefined, 'a discarded credential never resolves');
});

test('first credential use stores the draft with the same id and credential', () => {
  const repo = new SessionsRepo(storage.db);
  const stored = []; repo.onDraftStored = (row) => stored.push(row.id);
  const d = repo.createDraft(input);
  repo.setPermissionMode(d.id, 'read-only');
  const row = repo.byCredential(d.credential_id);
  assert.equal(row?.id, d.id);
  assert.equal(row?.credential_id, d.credential_id);
  assert.equal(row?.permission_mode, 'read-only');
  assert.equal(row?.draft, undefined);
  assert.deepEqual(stored, [d.id]);
  assert.equal(repo.list().filter((s) => s.id === d.id).length, 1);
  assert.equal(repo.byCredential(d.credential_id)?.id, d.id);
  assert.equal(stored.length, 1);
});

test('revoking a draft forgets it; reorder ignores drafts', () => {
  const repo = new SessionsRepo(storage.db);
  const d = repo.createDraft(input);
  const live = repo.list().filter((s) => !s.draft && s.status !== 'revoked' && s.status !== 'archived').map((s) => s.id);
  assert.doesNotThrow(() => repo.reorder([d.id, ...live]));
  assert.equal(repo.setStatus(d.id, 'revoked')?.status, 'revoked');
  assert.equal(repo.get(d.id), undefined);
});
