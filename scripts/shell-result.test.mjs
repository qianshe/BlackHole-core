import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { detectShell, runShell } from '../dist/workspace/shell.js';

const adapter = detectShell();
const supported = adapter && ['bash', 'zsh', 'sh'].includes(adapter.name);
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
function fixture(t) {
  fs.mkdirSync('.cache/tests', { recursive: true });
  const root = fs.realpathSync(fs.mkdtempSync('.cache/tests/shell-result-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // This fixture checks shell result transport, not sandbox enforcement (covered separately).
  const run = (command, outputCapBytes = 128) => runShell({ command, mode: 'danger-full-access',
    cwd: root, workspace: root, timeoutMs: 5000, outputCapBytes }, adapter);
  return { root, run };
}

test('POSIX shell result tests require a runnable POSIX shell', () => {
  if (process.platform !== 'win32') assert.ok(supported, 'native POSIX gate must not skip shell execution');
});

test('stdout truncation never changes a failed command into success', { skip: !supported }, async t => {
  const { run } = fixture(t);
  const result = await run('printf %4096s x; false');
  assert.equal(result.exit_code, 1, JSON.stringify(result));
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.stdout) <= 128);
});

test('cwd metadata survives a full stdout buffer and quoted Unicode paths', { skip: !supported }, async t => {
  const { root, run } = fixture(t);
  const name = "space and ' quote 中文", sub = path.join(root, name);
  fs.mkdirSync(sub);
  const result = await run(`cd ${quote(sub)}; printf %4096s x; false`);
  assert.equal(result.exit_code, 1, JSON.stringify(result));
  assert.equal(result.truncated, true);
  assert.equal(result.cwd.replaceAll('\\', '/').split('/').at(-1), name);
});

test('user output resembling the old control marker cannot forge exit status or cwd', { skip: !supported }, async t => {
  const { root, run } = fixture(t);
  const result = await run("printf '__BH_END__ 0 /not-the-workspace'; exit 9");
  assert.equal(result.exit_code, 9, JSON.stringify(result));
  assert.equal(result.cwd, root);
  assert.equal(result.stdout, '__BH_END__ 0 /not-the-workspace');
});

test('a footer split by the output cap is removed, not exposed as partial control text', { skip: !supported }, async t => {
  const { run } = fixture(t);
  const result = await run('printf %120s x; false', 128);
  assert.equal(result.exit_code, 1, JSON.stringify(result));
  assert.equal(result.stdout, ' '.repeat(119) + 'x');
  assert.doesNotMatch(result.stdout, /__BH_/);
});

test('stderr, explicit exits and syntax failures retain their native result', { skip: !supported }, async t => {
  const { run } = fixture(t);
  const result = await run("printf 'failure-中文\\n' >&2; exit 7");
  assert.equal(result.exit_code, 7);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), 'failure-中文');
  const syntax = await run('if then');
  assert.notEqual(syntax.exit_code, 0);
  assert.ok(syntax.stderr.length > 0);
});
