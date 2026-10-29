import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listWorkspaceEntries, readWorkspacePreview, WorkspaceBrowseError, MAX_PREVIEW_BYTES } from '../dist/web/workspace-browser.js';

test('session workspace browser: confined read-only listings and text preview', (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-workspace-browser-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-browser-outside-'));
  t.after(() => { fs.rmSync(workspace, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(workspace, 'src'));
  fs.writeFileSync(path.join(workspace, 'src', 'test.ts'), 'const hello = "世界";\n');
  fs.writeFileSync(path.join(workspace, 'binary.png'), Buffer.from([0, 1, 255]));
  fs.writeFileSync(path.join(workspace, 'oversize.txt'), 'x'.repeat(MAX_PREVIEW_BYTES + 1));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside');

  const root = listWorkspaceEntries(workspace);
  assert.equal(root.path, '');
  assert.ok(root.entries.some((item) => item.name === 'src' && item.type === 'dir'));
  assert.deepEqual(readWorkspacePreview(workspace, 'src/test.ts'), { path: 'src/test.ts', content: 'const hello = "世界";\n' });
  assert.ok(listWorkspaceEntries(workspace, 'src').entries.some((item) => item.path === 'src/test.ts'));
  const fails = (fn, status, code) => assert.throws(fn, (error) =>
    error instanceof WorkspaceBrowseError && error.status === status && error.code === code);
  fails(() => readWorkspacePreview(workspace, '../secret.txt'), 403, 'outside_workspace');
  fails(() => readWorkspacePreview(workspace, 'binary.png'), 415, 'workspace_file_binary');
  fails(() => readWorkspacePreview(workspace, 'oversize.txt'), 413, 'workspace_file_too_large');
  fails(() => readWorkspacePreview(workspace, '/etc/passwd'), 400, 'invalid_workspace_path');
  fails(() => readWorkspacePreview(workspace, '..\\test.txt'), process.platform === 'win32' ? 403 : 404,
    process.platform === 'win32' ? 'outside_workspace' : 'workspace_entry_not_found');
  const escapeLink = path.join(workspace, 'escape');
  try {
    fs.symlinkSync(outside, escapeLink, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(root.entries.some((item) => item.name === 'escape'), false);
    fails(() => listWorkspaceEntries(workspace, 'escape'), 403, 'outside_workspace');
  } catch (e) {
    if (e?.code !== 'EPERM' && e?.code !== 'EACCES') throw e;
  }
});
