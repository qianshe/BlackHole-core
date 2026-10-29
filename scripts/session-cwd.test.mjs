import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionRuntime } from '../dist/runtime.js';

// A persisted cwd that no longer resolves (deleted, or a mis-decoded non-ASCII
// path) must not be handed to CreateProcess; the session falls back to its root.
test('a stale persisted cwd falls back to the workspace root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-cwd-'));
  try {
    const sub = path.join(root, 'sub');
    fs.mkdirSync(sub);
    const row = (cwd) => ({ id: 's', workspace_path: root, cwd, auto_approve: false });
    assert.equal(new SessionRuntime(row(sub), null).cwd, sub);
    assert.equal(new SessionRuntime(row(path.join(root, 'Python\u03bf', 'x')), null).cwd, root);
    assert.equal(new SessionRuntime(row(null), null).cwd, root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
