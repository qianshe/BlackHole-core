import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceEditor } from '../dist/workspace/editor.js';
import { openDb } from '../dist/storage/db.js';
import { ToolCallsRepo } from '../dist/storage/toolCalls.js';

const temp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blackhole-editor-nav-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const publicResult = (result) => {
  const { navigation, ...rest } = result;
  return rest;
};

test('workspace editor records bounded navigation facts only for mutating commands', (t) => {
  const root = temp(t), editor = new WorkspaceEditor(root);
  let result = editor.create('created.ts', 'one\ntwo\n');
  assert.deepEqual(result.navigation && { ...result.navigation, afterSha256: '<hash>' }, {
    version: 1, kind: 'create', path: 'created.ts', startLine: 1, endLine: 2, afterSha256: '<hash>',
  });
  assert.equal(result.navigation.afterSha256.length, 64);

  result = editor.view('created.ts', [2, 99]);
  assert.equal(result.navigation, undefined, 'read-only view does not allocate navigation metadata');

  result = editor.strReplace('created.ts', 'two', 'second\nthird');
  assert.equal(result.navigation.kind, 'str_replace');
  assert.equal(result.navigation.startLine, 2);
  assert.equal(result.navigation.endLine, 3);
  assert.equal(result.navigation.beforeSha256.length, 64);
  assert.equal(result.navigation.afterSha256.length, 64);
  assert.notEqual(result.navigation.beforeSha256, result.navigation.afterSha256);

  result = editor.insert('created.ts', 1, 'alpha\nbeta');
  assert.equal(result.navigation.kind, 'insert');
  assert.equal(result.navigation.startLine, 2);
  assert.equal(result.navigation.endLine, 3);

  result = editor.delete('created.ts');
  assert.equal(result.navigation.kind, 'delete');
  assert.equal(result.navigation.deleted, true);
  assert.equal(result.navigation.beforeSha256.length, 64);
  assert.equal(fs.existsSync(path.join(root, 'created.ts')), false);
  assert.equal('navigation' in publicResult(result), false);
});

test('directory views remain read-only and do not allocate navigation metadata', (t) => {
  const root = temp(t), editor = new WorkspaceEditor(root);
  const result = editor.view('.');
  assert.equal(result.navigation, undefined);
});


test('navigation metadata stays small regardless of edited content size', (t) => {
  const root = temp(t), editor = new WorkspaceEditor(root), content = 'x'.repeat(200_000);
  const result = editor.create('large.txt', content);
  const encoded = JSON.stringify(result.navigation);
  assert.ok(Buffer.byteLength(encoded, 'utf8') < 512);
  assert.equal(encoded.includes(content.slice(0, 100)), false);
});
test('tool call navigation metadata migrates, persists, and is purged with its call row', (t) => {
  const root = temp(t), dbPath = path.join(root, 'old.sqlite');
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`CREATE TABLE tool_calls (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, tool TEXT NOT NULL,
    args_json TEXT NOT NULL, args_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('started','completed','failed')),
    result_summary TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`);
  legacy.close();

  const storage = openDb(dbPath);
  try {
    const columns = storage.db.prepare('PRAGMA table_info(tool_calls)').all().map((row) => row.name);
    assert.ok(columns.includes('navigation_json'));
    const repo = new ToolCallsRepo(storage.db);
    const call = repo.start('session', 'editor', '{}', 'hash');
    const navigation = JSON.stringify({ version: 1, kind: 'create', path: 'src/a.ts', startLine: 1, endLine: 3 });
    repo.finish(call.id, 'completed', JSON.stringify({ result: { message: 'ok', isError: false } }), navigation);
    assert.equal(repo.get(call.id).navigation_json, navigation);
    repo.finish(call.id, 'completed', JSON.stringify({ result: { message: 'still ok', isError: false } }));
    assert.equal(repo.get(call.id).navigation_json, navigation, 'later status/result refreshes preserve navigation metadata');
    const oversized = repo.start('session', 'editor', '{}', 'oversized');
    repo.finish(oversized.id, 'completed', '{}', 'x'.repeat(8 * 1024 + 1));
    assert.equal(repo.get(oversized.id).navigation_json, null, 'oversized metadata is dropped instead of bloating storage');
    storage.db.prepare('UPDATE tool_calls SET created_at=? WHERE id=?').run(1, call.id);
    assert.equal(repo.purgeOlderThan(2), 1);
    assert.equal(repo.get(call.id), undefined);
  } finally {
    storage.close();
  }
});
