import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { resolveDataPaths, resolveHostDataEnvironment } from '../dist/data-paths.js';
import { accountSecretFile } from '../dist/account/secret-store.js';

const home = path.resolve('storage-fixture/user');
const root = path.join(home, '.blackhole');
const base = { USERPROFILE: home, HOME: home, LOCALAPPDATA: path.join(home, 'AppData', 'Local') };
const resolve = (environment, overrides = {}) => {
  const env = resolveHostDataEnvironment({ environment, env: { ...base, ...overrides }, homeDir: home, platform: 'win32' });
  return { env, data: resolveDataPaths({ env, homeDir: home, platform: 'win32' }) };
};

for (const environment of ['test', 'production']) {
  test(`${environment}: every persisted path derives from the only .blackhole root`, () => {
    const { data } = resolve(environment);
    assert.equal(data.root, root);
    assert.equal(data.db, path.join(root, 'blackhole.db'));
    assert.equal(data.proxyConfig, path.join(root, 'mcp-proxies.yaml'));
    assert.equal(data.semanticKey, path.join(root, 'semantic-key'));
    assert.equal(data.accountSecrets, path.join(root, 'secrets'));
    assert.equal(data.accountReceipts, path.join(root, 'cloud-auth-v1'));
    assert.equal(data.coreStore, path.join(root, 'core'));
    assert.equal(data.bin, path.join(root, 'bin'));
    assert.equal(data.updates, path.join(root, 'updates'));
    assert.equal(Object.hasOwn(data, 'sharedBin'), false, 'no second tool-storage root');
  });
}

test('release channel and installation directory cannot fork the profile or Manager store', () => {
  const a = resolve('production', { BLACKHOLE_INSTALL_DIR: 'F:/Apps/A', VSCODE_EXTENSIONS: 'G:/VSCode/A' });
  const b = resolve('test', { BLACKHOLE_INSTALL_DIR: 'D:/Apps/B', VSCODE_EXTENSIONS: 'E:/VSCode/B' });
  assert.deepEqual(a.data, b.data);
  assert.equal(b.env.BLACKHOLE_TUNNEL, 'off', 'storage unification never starts a public tunnel');
});

test('Test hosts forbid tunnels by default but explicitly authorized manual starts preserve the identical user root', () => {
  const blocked = resolve('test', { BLACKHOLE_TUNNEL: 'off' });
  const manual = resolve('test', { BLACKHOLE_TUNNEL: 'manual' });
  const unknown = resolve('test', { BLACKHOLE_TUNNEL: 'auto' });
  assert.equal(blocked.env.BLACKHOLE_TUNNEL,'off');
  assert.equal(manual.env.BLACKHOLE_TUNNEL,'manual');
  assert.equal(unknown.env.BLACKHOLE_TUNNEL,'off', 'a test host cannot enable automatic public tunnels');
  assert.deepEqual(manual.data,blocked.data);
});

test('data-root identity and account filename match the existing v200 layout', () => {
  const { data } = resolve('production');
  const normalized = path.normalize(path.resolve(root)).toLowerCase();
  assert.equal(data.dataRootId, createHash('sha256').update(`blackhole-data-root-v1\0${normalized}`).digest('hex'));
  const origin = 'https://same-account.example.com';
  assert.equal(accountSecretFile(data.accountRoot, origin), accountSecretFile(root, origin));
  assert.notEqual(accountSecretFile(root, origin), accountSecretFile(root, 'https://other-origin.example.com'), 'origin trust isolation stays intact');
});

for (const [key, value] of [
  ['BLACKHOLE_HOME', path.join(home, 'AppData', 'Local', 'BlackHole-Test', 'Data')],
  ['BLACKHOLE_DB', path.join(home, 'other', 'blackhole.db')],
  ['BLACKHOLE_SHARED_BIN', path.join(home, 'other-bin')],
  ['BH_CORE_STORE', path.join(home, 'AppData', 'Local', 'BlackHole', 'Core')],
]) {
  test(`${key}: reject a conflicting old path instead of using a fallback`, () => {
    for (const environment of ['test', 'production']) assert.throws(() => resolve(environment, { [key]: value }), /noncanonical_storage_path/);
  });
}

test('canonical inherited values are accepted without changing the supplied environment', () => {
  const input = { ...base, BLACKHOLE_HOME: root, BLACKHOLE_DB: path.join(root, 'blackhole.db'), BH_CORE_STORE: path.join(root, 'core') };
  const snapshot = { ...input };
  const result = resolveHostDataEnvironment({ environment: 'test', env: input, homeDir: home, platform: 'win32' });
  assert.deepEqual(input, snapshot);
  assert.equal(result.BLACKHOLE_HOME, root);
  assert.equal(result.BLACKHOLE_DB, path.join(root, 'blackhole.db'));
});

test('disposable HOME uses the identical layout; resolution never touches existing data', t => {
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-sole-root-'));
  t.after(() => fs.rmSync(isolatedHome, { recursive: true, force: true }));
  const isolatedRoot = path.join(isolatedHome, '.blackhole');
  fs.mkdirSync(isolatedRoot);
  const file = path.join(isolatedRoot, 'blackhole.db');
  fs.writeFileSync(file, 'existing session marker; this resolver must not open or rewrite it');
  const before = fs.readFileSync(file);
  for (const environment of ['test', 'production']) {
    const env = resolveHostDataEnvironment({ environment, env: { HOME: isolatedHome, USERPROFILE: isolatedHome } });
    const data = resolveDataPaths({ env });
    assert.equal(data.db, file);
    assert.equal(data.bin, path.join(isolatedRoot, 'bin'));
  }
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fs.existsSync(path.join(isolatedHome, 'AppData')), false);
});
