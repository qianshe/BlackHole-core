import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ProcessManager } from '../dist/process/manager.js';
import { loadProcessBackend } from '../dist/process/backend.js';
import { probeRunner } from '../dist/workspace/posix-sandbox.js';

const posix = ['linux', 'darwin'].includes(process.platform);
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const childFile = fileURLToPath(new URL('./fixtures/process-child.mjs', import.meta.url));
const script = (...args) => [process.execPath, childFile, ...args.map(String)].map(quote).join(' ');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (read, accept, ms = 10000) => {
  const deadline = Date.now() + ms;
  for (;;) { const r = await read(); if (accept(r)) return r; if (Date.now() > deadline) throw Error('Timed out: ' + JSON.stringify(r)); await delay(40); }
};
const ports = row => row.output.stdout.split(/\r?\n/).flatMap(line => { try { const value = JSON.parse(line); return value.port ? [value.port] : []; } catch { return []; } });
async function fixture(t, mode = 'danger-full-access') {
  fs.mkdirSync('.cache/tests', { recursive: true });
  const root = fs.realpathSync(fs.mkdtempSync('.cache/tests/process-posix-'));
  const manager = new ProcessManager({ daemonId: 'posix-fixture', backend: await loadProcessBackend() });
  const owner = { sessionId: 'posix-session', workspace: root, mode, writableDirs: [] };
  const close = async () => { await manager.dispose(); fs.rmSync(root, { recursive: true, force: true }); };
  t?.after(close);
  const start = (requestId, command) => manager.start(owner, { requestId, script: command }, async () => {});
  const status = processId => manager.status(owner.sessionId, processId);
  return { root, manager, owner, close, start, status };
}

if (process.env.BH_POSIX_CRASH_FIXTURE === '1') {
  const f = await fixture();
  const row = await f.start('tree', script('tree'));
  const ready = await until(() => f.status(row.processId), r => ports(r).length === 2 || ['failed', 'exited', 'unknown'].includes(r.state));
  process.send?.({ row: ready, ports: ports(ready), root: f.root });
} else {
  test('backend selection supports the desktop platform matrix without importing Windows natives', async () => {
    const { processPlatformSupported, processRuntimeCapability } = await import('../dist/process/backend.js');
    for (const os of ['linux', 'darwin']) for (const arch of ['x64', 'arm64']) assert.equal(processPlatformSupported(os, arch), true);
    assert.equal(processPlatformSupported('win32', 'x64'), true);
    assert.equal(processPlatformSupported('aix', 'x64'), false);
    assert.equal(processPlatformSupported('win32', 'arm64'), false, 'do not claim an unverified native ABI');
    assert.deepEqual(await processRuntimeCapability('aix','x64'),{available:false,reason:'unsupported_platform'});
    assert.deepEqual(await processRuntimeCapability('darwin','arm64',()=>false),{available:false,reason:'runtime_asset_missing'});
    assert.deepEqual(await processRuntimeCapability('linux','x64',()=>true),{available:true});
  });

  test('POSIX starts three independent tasks and stops only the requested process group', { skip: !posix, timeout: 30000 }, async t => {
    const f = await fixture(t), rows = await Promise.all(['a', 'b', 'c'].map(name => f.start(name, script('tree'))));
    const ready = await Promise.all(rows.map(row => until(() => f.status(row.processId), r => ports(r).length === 2 || ['failed', 'exited', 'unknown'].includes(r.state))));
    assert.ok(ready.every(r => r.state === 'running'), JSON.stringify(ready));
    const all = ready.flatMap(ports); assert.equal(new Set(all).size, 6);
    const stopped = await f.manager.stop(f.owner.sessionId, rows[0].processId); assert.equal(stopped.state, 'exited', JSON.stringify(stopped));
    for (const port of ports(ready[0])) await assert.rejects(fetch('http://127.0.0.1:' + port));
    for (const port of ready.slice(1).flatMap(ports)) assert.equal((await fetch('http://127.0.0.1:' + port)).status, 200);
    assert.equal((await f.manager.stop(f.owner.sessionId, rows[0].processId)).state, 'exited');
  });

  test('POSIX failures preserve the last stderr and root exit code, including invalid executables', { skip: !posix, timeout: 20000 }, async t => {
    const f = await fixture(t);
    for (const [name, command, code, message] of [['exit', script('exit'), 7, /最后错误/], ['missing', 'blackhole_missing_executable_428133', 127, /not found/]]) {
      const row = await f.start(name, command);
      const ended = await until(() => f.status(row.processId), r => ['failed', 'exited', 'unknown'].includes(r.state));
      assert.equal(ended.state, 'exited', JSON.stringify(ended)); assert.equal(ended.exitCode, code); assert.match(ended.output.stderr, message);
    }
  });

  test('successful POSIX tasks keep success even when stderr quotes sandbox errors', { skip: !posix, timeout: 20000 }, async t => {
    try { probeRunner(process.platform); } catch (error) {
      if (process.env.BH_REQUIRE_SANDBOX === '1') throw error;
      t.skip('requires the native sandbox for the restricted success case'); return;
    }
    const f = await fixture(t, 'workspace-write');
    const message = process.platform === 'darwin' ? 'sandbox-exec: sandbox_apply: Operation not permitted' : 'bwrap: sample error message';
    const row = await f.start('stderr-example', `printf '%s\\n' ${quote(message)} >&2; exit 0`);
    const ended = await until(() => f.status(row.processId), r => ['exited', 'failed', 'unknown'].includes(r.state));
    assert.equal(ended.state, 'exited', JSON.stringify(ended));
    assert.equal(ended.exitCode, 0);
    assert.equal(ended.reason, 'command_exited');
    assert.ok(ended.output.stderr.includes(message));
  });

  test('POSIX supervisor cleans its task when only the parent daemon fixture is killed', { skip: !posix, timeout: 20000 }, async t => {
    const child = fork(fileURLToPath(import.meta.url), [], { env: { ...process.env, BH_POSIX_CRASH_FIXTURE: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let stderr = ''; child.stderr.on('data', b => { stderr = (stderr + b).slice(-8192); }); child.stdout.resume();
    t.after(() => { if (child.exitCode === null) child.kill(); });
    const reply = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error(stderr || 'crash fixture timeout')), 12000);
      child.once('message', r => { clearTimeout(timer); resolve(r); }); child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(Error('fixture exited: ' + code + ' ' + stderr)); });
    });
    assert.equal(reply.row.state, 'running', JSON.stringify(reply)); assert.equal(reply.ports.length, 2);
    child.kill('SIGKILL');
    await until(async () => Promise.all(reply.ports.map(port => fetch('http://127.0.0.1:' + port).then(() => true, () => false))), rows => rows.every(v => !v));
    fs.rmSync(reply.root, { recursive: true, force: true });
  });

  test('POSIX escalates a stubborn foreground task and reaps children after their root exits', { skip: !posix, timeout: 20000 }, async t => {
    const f = await fixture(t);
    const stubborn = await f.start('stubborn', script('stubborn'));
    const live = await until(() => f.status(stubborn.processId), r => ports(r).length === 1);
    const stopped = await f.manager.stop(f.owner.sessionId, stubborn.processId);
    assert.equal(stopped.state, 'exited', JSON.stringify(stopped));
    await assert.rejects(fetch('http://127.0.0.1:' + ports(live)[0]));
    const parent = await f.start('parent', script('parent-exit'));
    const ended = await until(() => f.status(parent.processId), r => ['exited', 'failed', 'unknown'].includes(r.state));
    assert.equal(ended.state, 'exited', JSON.stringify(ended)); assert.equal(ended.exitCode, 23);
    assert.equal(ports(ended).length, 2);
    for (const port of ports(ended)) await assert.rejects(fetch('http://127.0.0.1:' + port));
  });

  test('POSIX restricted modes preserve write policy and fail closed if the sandbox cannot start', { skip: !posix, timeout: 30000 }, async t => {
    let available = true;
    try { probeRunner(process.platform); } catch (error) {
      available = false;
      if (process.env.BH_REQUIRE_SANDBOX === '1') throw error;
      t.diagnostic('Sandbox unavailable here: checking rejection, not claiming restricted execution passed.');
    }
    const f = await fixture(t, 'read-only');
    const deniedPath = path.join(f.root, 'denied.txt'), row = await f.start('write', script('write', deniedPath));
    const result = await until(() => f.status(row.processId), r => ['exited', 'failed', 'unknown'].includes(r.state));
    assert.equal(fs.existsSync(deniedPath), false);
    if (!available) { assert.equal(result.state, 'failed'); assert.match(result.output.stderr, /SANDBOX_UNAVAILABLE/); return; }
    assert.equal(result.exitCode, 13, JSON.stringify(result));
    const permitted = await fixture(t, 'workspace-write'), target = path.join(permitted.root, 'allowed.txt');
    const write = await permitted.start('write', script('write', target));
    const ended = await until(() => permitted.status(write.processId), r => ['exited', 'failed', 'unknown'].includes(r.state));
    assert.equal(ended.exitCode, 0, JSON.stringify(ended)); assert.equal(fs.readFileSync(target, 'utf8'), 'written');
    const server = await permitted.start('tree', script('tree'));
    const ready = await until(() => permitted.status(server.processId), r => ports(r).length === 2 || ['failed', 'exited', 'unknown'].includes(r.state));
    assert.equal(ready.state, 'running', JSON.stringify(ready));
    await permitted.manager.stop(permitted.owner.sessionId, server.processId);
    for (const port of ports(ready)) await assert.rejects(fetch('http://127.0.0.1:' + port));
  });
}
