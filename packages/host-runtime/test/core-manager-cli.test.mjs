import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { CoreManager } from '../dist/core-manager.cjs';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-manager-cli-'));
  t.after(() => fs.promises.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const data = path.join(home, '.blackhole'), store = path.join(data, 'core');
  const trustFile = path.join(home, 'trust.json');
  fs.writeFileSync(trustFile, JSON.stringify({ environment: 'test', publicKeys: { 'test-cli': 'unused by state reads' } }));
  const manager = new CoreManager(store);
  manager.initialize();
  const env = { ...process.env, HOME: home, USERPROFILE: home, BLACKHOLE_HOME: data,
    BLACKHOLE_DB: path.join(data, 'blackhole.db'), BH_CORE_STORE: store, BH_CORE_TRUST_CONFIG: trustFile };
  for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'BLACKHOLE_SHARED_BIN',
    'BLACKHOLE_PROXY_CONFIG', 'BLACKHOLE_SEMANTIC_KEY_FILE']) delete env[key];
  const invoke = request => {
    const entry = process.env.BH_MANAGER_CLI_TEST_ENTRY ?? fileURLToPath(new URL('../dist/core-manager-cli.mjs', import.meta.url));
    assert.ok(path.isAbsolute(entry));
    const child = spawn(process.execPath, [entry],
      { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const result = new Promise((resolve, reject) => {
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', code => {
        try { resolve({ code, response: JSON.parse(stdout), stderr }); }
        catch (error) { reject(error); }
      });
    });
    child.stdin.end(JSON.stringify(request));
    return result;
  };
  return { data, store, manager, invoke };
}

for (const command of ['resolve-endpoint', 'inspect-start']) {
  for (const lock of ['install', 'lifecycle']) {
    test(`${command} waits for a competing ${lock} lock without changing Core state`, async t => {
      const f = fixture(t);
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      const held = f.manager.withLock(lock, () => gate);
      const result = f.invoke({ command, request: { fallbackPort: 7306 } });
      const timer = setTimeout(release, 700);
      t.after(async () => { clearTimeout(timer); release(); await held; });
      const actual = await result;
      assert.equal(actual.code, 0, JSON.stringify(actual));
      if (command === 'resolve-endpoint') {
        assert.equal(actual.response.result.port, 7306);
        assert.equal(actual.response.result.revision, 0);
      } else assert.equal(actual.response.result, null);
      assert.equal(fs.existsSync(path.join(f.store, 'active.json')), false);
      assert.equal(fs.existsSync(path.join(f.manager.state, 'running')), false);
      assert.equal(fs.existsSync(path.join(f.data, 'blackhole.db')), false);
    });
  }
}

test('state reads reject corrupt locks and do not replace them', async t => {
  const f = fixture(t), lock = path.join(f.manager.locks, 'install.lock');
  fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, 'owner.json'), '{bad');
  const actual = await f.invoke({ command: 'resolve-endpoint', request: { fallbackPort: 7306 } });
  assert.equal(actual.code, 1);
  assert.equal(actual.response.error.code, 'lock_state_unknown');
  assert.equal(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'), '{bad');
});

test('first-install endpoint read waits through a startup longer than fifteen seconds', async t => {
  const f = fixture(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const held = f.manager.withLock('install', () => gate);
  const result = f.invoke({ command: 'resolve-endpoint', request: { fallbackPort: 7306 } });
  const timer = setTimeout(release, 17_000);
  t.after(async () => { clearTimeout(timer); release(); await held; });
  const actual = await result;
  assert.equal(actual.code, 0, JSON.stringify(actual));
  assert.equal(actual.response.result.port, 7306);
  assert.equal(fs.existsSync(path.join(f.store, 'active.json')), false);
});

test('endpoint read stops waiting without stealing a lock that stays held', async t => {
  const f = fixture(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const held = f.manager.withLock('install', () => gate);
  t.after(async () => { release(); await held; });
  const ownerFile = path.join(f.manager.locks, 'install.lock', 'owner.json');
  const owner = fs.readFileSync(ownerFile, 'utf8');
  const started = Date.now();
  const actual = await f.invoke({ command: 'resolve-endpoint', request: { fallbackPort: 7306 } });
  assert.equal(actual.code, 1);
  assert.equal(actual.response.error.code, 'lock_busy');
  assert.ok(Date.now() - started >= 45_000, 'the query must allow the full startup wait budget');
  assert.ok(Date.now() - started < 55_000, 'the wait must remain bounded');
  assert.equal(fs.readFileSync(ownerFile, 'utf8'), owner);
  assert.equal(fs.existsSync(path.join(f.manager.state, 'endpoints')), false);
});

test('endpoint mutation still refuses a competing lock without retrying', async t => {
  const f = fixture(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const held = f.manager.withLock('install', () => gate);
  t.after(async () => { release(); await held; });
  const actual = await f.invoke({ command: 'configure-endpoint', request: {
    confirmed: true, expectedPort: 7306, expectedRevision: 0, port: 7307,
  } });
  assert.equal(actual.code, 1);
  assert.equal(actual.response.error.code, 'lock_busy');
  assert.equal(fs.existsSync(path.join(f.manager.state, 'endpoints')), false);
});
