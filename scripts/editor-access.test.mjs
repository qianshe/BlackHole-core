// editor reach per permission mode: full access goes anywhere, workspace-write adds granted dirs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceEditor } from '../dist/workspace/editor.js';

function dirs(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bh-editor-access-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const ws = path.join(base, 'ws'); const other = path.join(base, 'other'); const granted = path.join(base, 'granted');
  for (const d of [ws, other, granted]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(other, 'a.txt'), 'hello other\n');
  return { ws, other, granted };
}

test('workspace-write without grants: outside paths are still refused (unchanged)', (t) => {
  const { ws, other } = dirs(t);
  const ed = new WorkspaceEditor(ws, () => ({ mode: 'workspace-write' }));
  const r = ed.view(path.join(other, 'a.txt'));
  assert.equal(r.isError, true);
  assert.equal(r.code, 'INVALID_PATH');
  assert.equal(new WorkspaceEditor(ws).view('../other/a.txt').code, 'INVALID_PATH', 'default stays workspace-only');
});

test('danger-full-access: view, create, replace and delete in another workspace', (t) => {
  const { ws, other } = dirs(t);
  const ed = new WorkspaceEditor(ws, () => ({ mode: 'danger-full-access' }));
  assert.match(ed.view(path.join(other, 'a.txt')).message, /hello other/);
  assert.match(ed.view('../other/a.txt').message, /hello other/, 'relative paths resolve against the workspace');
  const target = path.join(other, 'sub', 'new.txt');
  assert.equal(ed.create(target, 'x1\n').isError, false);
  assert.equal(fs.readFileSync(target, 'utf8'), 'x1\n');
  assert.equal(ed.strReplace(target, 'x1', 'x2').isError, false);
  assert.equal(fs.readFileSync(target, 'utf8'), 'x2\n');
  assert.equal(ed.delete(target).isError, false);
  assert.equal(fs.existsSync(target), false);
});

test('workspace-write with granted dirs: granted dir writable, other dirs still refused', (t) => {
  const { ws, other, granted } = dirs(t);
  const ed = new WorkspaceEditor(ws, () => ({ mode: 'workspace-write', writableDirs: [granted] }));
  const f = path.join(granted, 'g.txt');
  assert.equal(ed.create(f, 'ok\n').isError, false);
  assert.equal(fs.readFileSync(f, 'utf8'), 'ok\n');
  assert.equal(ed.view(path.join(other, 'a.txt')).code, 'INVALID_PATH');
});

test('access is read live: switching the mode applies to the same editor at once', (t) => {
  const { ws, other } = dirs(t);
  let mode = 'workspace-write';
  const ed = new WorkspaceEditor(ws, () => ({ mode }));
  assert.equal(ed.view(path.join(other, 'a.txt')).code, 'INVALID_PATH');
  mode = 'danger-full-access';
  assert.match(ed.view(path.join(other, 'a.txt')).message, /hello other/);
  mode = 'read-only';
  assert.equal(ed.view(path.join(other, 'a.txt')).code, 'INVALID_PATH', 'read-only stays inside the workspace');
});
