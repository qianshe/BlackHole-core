// Credentials as user-only files (replaces the OS keyring): account + OpenAI key share util/secret-file.
// Never touches the real ~/.blackhole: every case uses its own temp dir.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AccountService } from '../dist/account/service.js';
import { accountSecretFile, openSecretBackend } from '../dist/account/secret-store.js';
import { defaultSealer, openSecretFile } from '../dist/util/secret-file.js';

const posix = process.platform !== 'win32';
const tmp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-secret-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const mode = (p) => fs.statSync(p).mode & 0o777;
const TOKEN = 'bhp_' + 'z'.repeat(43);

test('round trip, restart, delete removes the file', (t) => {
  const file = path.join(tmp(t), 'secrets', 'x.json');
  const a = openSecretFile(file);
  assert.equal(a.get('k'), undefined);
  a.set('k', TOKEN);
  a.set('other', 'v');
  assert.equal(openSecretFile(file).get('k'), TOKEN, 'a new instance (restarted daemon) reads it back');
  a.delete('k');
  assert.equal(a.get('other'), 'v', 'deleting one key keeps the rest');
  a.delete('other');
  assert.equal(fs.existsSync(file), false, 'empty map leaves no file behind');
  a.delete('missing'); // no throw
});

test('permissions: dir 0700, file 0600 (macOS/Linux); Windows seals the content with DPAPI', (t) => {
  const file = path.join(tmp(t), 'secrets', 'x.json');
  const s = openSecretFile(file);
  s.set('k', TOKEN);
  const env = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(env.v, 1);
  if (posix) {
    assert.equal(mode(path.dirname(file)), 0o700);
    assert.equal(mode(file), 0o600);
    // A pre-existing looser mode is tightened on the next write.
    fs.chmodSync(file, 0o644); fs.chmodSync(path.dirname(file), 0o755);
    s.set('k2', 'v');
    assert.equal(mode(file), 0o600);
    assert.equal(mode(path.dirname(file)), 0o700);
    assert.equal(env.enc, 'none');
  } else {
    assert.equal(defaultSealer()?.name, 'dpapi', 'the dev machine has koffi, so DPAPI must be active');
    assert.equal(env.enc, 'dpapi');
    assert.ok(!fs.readFileSync(file, 'utf8').includes(TOKEN));
    assert.ok(!Buffer.from(env.data, 'base64').toString('latin1').includes(TOKEN));
  }
});

test('atomic write: no temp files left, a failed write keeps the previous content', (t) => {
  const dir = path.join(tmp(t), 'secrets');
  const file = path.join(dir, 'x.json');
  const s = openSecretFile(file);
  for (let i = 0; i < 20; i++) s.set('k', `v${i}`);
  assert.deepEqual(fs.readdirSync(dir), ['x.json']);
  const failing = openSecretFile(file, { name: 'dpapi', seal: () => { throw new Error('boom'); }, unseal: (b) => b });
  assert.throws(() => failing.set('k', 'new'));
  assert.deepEqual(fs.readdirSync(dir), ['x.json'], 'temp file cleaned up');
  assert.equal(s.get('k'), 'v19', 'old content intact');
});

test('corrupt or foreign files read as empty (signed out), and the next write replaces them', (t) => {
  const file = path.join(tmp(t), 'secrets', 'x.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const junk of ['', '{', 'null', '[]', '{"v":2,"enc":"none","data":""}', '{"v":1,"enc":"rot13","data":"e30="}',
    JSON.stringify({ v: 1, enc: 'none', data: Buffer.from('[1,2]').toString('base64') }),
    JSON.stringify({ v: 1, enc: 'dpapi', data: Buffer.from('sealed elsewhere').toString('base64') })]) {
    fs.writeFileSync(file, junk);
    assert.equal(openSecretFile(file).get('k'), undefined, junk);
  }
  // Non-string values are ignored rather than trusted.
  fs.writeFileSync(file, JSON.stringify({ v: 1, enc: 'none', data: Buffer.from(JSON.stringify({ k: 1, ok: 'y' })).toString('base64') }));
  const plain = openSecretFile(file, null);
  assert.equal(plain.get('k'), undefined);
  assert.equal(plain.get('ok'), 'y');
  plain.set('k', 'fresh');
  assert.equal(plain.get('k'), 'fresh');
});

test('account file is per cloud origin; invalid origins throw', (t) => {
  const dir = tmp(t);
  const prod = accountSecretFile(dir, 'https://cloud.blackhole-fixture.org');
  const test2 = accountSecretFile(dir, 'https://staging.blackhole-fixture.org');
  assert.notEqual(prod, test2);
  assert.equal(path.dirname(prod), path.join(dir, 'secrets'));
  assert.equal(accountSecretFile(dir, 'https://cloud.blackhole-fixture.org'), prod, 'stable');
  assert.throws(() => accountSecretFile(dir, 'not a url'));
});

test('backend selection: file by default, memory/unavailable only when asked, unwritable dir = unavailable', async (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'secrets', 'a.json');
  assert.equal(openSecretBackend(file, 'memory').kind, 'memory');
  assert.equal(openSecretBackend(file, 'unavailable').kind, 'unavailable');
  const b = openSecretBackend(file, undefined);
  assert.equal(b.kind, 'file');
  await b.port.store('k', 'v');
  assert.equal(await openSecretBackend(file, undefined).port.get('k'), 'v');
  await b.port.delete('k');
  assert.equal(fs.existsSync(file), false);
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'x');
  const u = openSecretBackend(path.join(blocker, 'secrets', 'a.json'), undefined);
  assert.equal(u.kind, 'unavailable');
  assert.match(u.reason, /^storage_unwritable/);
});

test('account survives a daemon restart with the file backend; sign-out deletes the file', async (t) => {
  const ORIGIN = 'https://cloud.blackhole-fixture.org';
  const dataDir = tmp(t);
  const state = new Map();
  const machineState = { get: (k) => state.get(k), set: (k, v) => state.set(k, v) };
  // Cloud reachable only for logout (sign-out keeps the credential when the server cannot confirm it).
  const offline = async (input) => new URL(String(input)).pathname.endsWith('/logout')
    ? new Response(null, { status: 204 })
    : new Response(JSON.stringify({ error: 'unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } });
  const file = accountSecretFile(dataDir, ORIGIN);
  const make = () => new AccountService({ origin: ORIGIN, dataDir, machineState, secrets: openSecretBackend(file, undefined), openExternal: async () => true, fetch: offline, log: () => {} });
  const now = Math.floor(Date.now() / 1000);
  const cred = { token: TOKEN, userId: 'user_9', clientId: 'vscode-client-id-009', sessionId: '99999999-2222-4333-8444-555555555555', expiresAt: now + 3600, loginOrder: 7 };

  const first = make();
  assert.equal(first.storageKind, 'file');
  assert.deepEqual(await first.migrate(cred), { migrated: true });
  assert.ok(fs.existsSync(file));
  if (!posix) assert.ok(!fs.readFileSync(file, 'utf8').includes(TOKEN), 'token sealed on Windows');

  const second = make(); // restarted daemon, same data dir
  await second.start();
  assert.equal((await second.view()).userId, 'user_9');

  await second.call('signOut', []);
  const afterOut = await make().view();
  assert.notEqual(afterOut.userId, 'user_9', 'signed out after restart too');
  assert.equal(fs.existsSync(file), false, 'sign-out leaves no credential file');
});
