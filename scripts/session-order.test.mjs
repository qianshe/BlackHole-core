import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDb } from '../dist/storage/db.js';
import { SessionsRepo } from '../dist/storage/sessions.js';

const make = (repo, root, name) => repo.create({ workspace_path: root, permission_mode: 'workspace-write', name });

test('session order is manual, durable, and new sessions start at the top', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-session-order-'));
  const dbPath = path.join(dir, 'blackhole.db');
  const firstStorage = openDb(dbPath);
  const repo = new SessionsRepo(firstStorage.db);
  const a = make(repo, dir, 'a');
  const b = make(repo, dir, 'b');
  const c = make(repo, dir, 'c');
  assert.deepEqual(repo.list().map((s) => s.id), [c.id, b.id, a.id]);
  repo.reorder([a.id, c.id, b.id]);
  assert.deepEqual(repo.list().map((s) => s.id), [a.id, c.id, b.id]);
  firstStorage.db.close();

  const secondStorage = openDb(dbPath);
  const reopened = new SessionsRepo(secondStorage.db);
  assert.deepEqual(reopened.list().map((s) => s.id), [a.id, c.id, b.id]);
  const d = make(reopened, dir, 'd');
  assert.deepEqual(reopened.list().map((s) => s.id), [d.id, a.id, c.id, b.id]);
  assert.throws(() => reopened.reorder([a.id, c.id]), /session_order_stale/);
  secondStorage.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
