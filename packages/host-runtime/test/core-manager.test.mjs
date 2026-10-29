import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CoreManager, StoreLockError } from '../dist/core-manager.cjs';

const HASH_A = 'a'.repeat(64), HASH_B = 'b'.repeat(64);
const descriptor = (buildId = 'build-a') => ({
  formatVersion: 1, runtimeId: 'blackhole-core', runtimeVersion: '1.0.0', buildId,
  platform: 'win32', arch: 'x64', environment: 'test', cloudOrigin: 'https://example.test',
  coreProtocol: { min: 1, max: 1 }, capabilities: [], nodeVersion: '22.20.0',
  nodeEntry: 'node/node.exe', daemonVersion: '1.0.0', daemonEntry: 'daemon/cli.js',
  webBuildId: 'web-a', webRoot: 'web', managerEntry: 'host/bootstrap.cjs',
  dataSchema: { min: 1, max: 1 }, migrationPolicy: 'none',
  members: [{ path: 'daemon/cli.js', sha256: HASH_A, size: 1 }],
  signingKeyId: 'test-local', signatureAlgorithm: 'ed25519', signature: 'sig',
  createdAt: '2026-10-11T00:00:00.000Z',
});
const fixture = (fn) => async (t) => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-manager-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); await fn(t, root); };
const verifier = (hash = HASH_A, buildId = 'build-a') => async (_archive, destination) => { fs.mkdirSync(path.join(destination, 'daemon')); fs.writeFileSync(path.join(destination, 'daemon/cli.js'), 'x'); return { descriptor: descriptor(buildId), descriptorHash: hash }; };

test('verified staging commits once and the same Seed is idempotent', fixture(async (_t, root) => {
  const manager = new CoreManager(root);
  await manager.provision('seed.zip', 'seed', verifier());
  await manager.provision('seed.zip', 'seed', verifier());
  assert.deepEqual(fs.readdirSync(path.join(root, 'versions')), ['1.0.0-build-a']);
  const transactions = fs.readdirSync(path.join(root, 'state/transactions'));
  assert.equal(transactions.length, 2);
  for (const name of transactions) assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'state/transactions', name))).state, 'committed');
}));

test('same version/build with a different descriptor fails closed', fixture(async (_t, root) => {
  const manager = new CoreManager(root);
  await manager.provision('a.zip', 'seed', verifier(HASH_A));
  await assert.rejects(manager.provision('b.zip', 'download', verifier(HASH_B)), /core_identity_conflict/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'versions/1.0.0-build-a/core-identity.json'))).descriptorHash, HASH_A);
}));

test('live lock blocks concurrency, stale lock recovers, corrupt lock fails closed', fixture(async (_t, root) => {
  let now = new Date('2026-10-11T00:00:00.000Z');
  const manager = new CoreManager(root, () => now);
  manager.initialize();
  const lock = path.join(root, 'state/locks/install.lock'); fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ createdAt: now.toISOString() }));
  await assert.rejects(manager.withLock('install', () => undefined), (e) => e instanceof StoreLockError && e.code === 'lock_busy');
  now = new Date('2026-10-11T00:03:00.000Z'); await manager.withLock('install', () => undefined);
  fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, 'owner.json'), '{bad');
  await assert.rejects(manager.withLock('install', () => undefined), (e) => e instanceof StoreLockError && e.code === 'lock_state_unknown');
}));

test('inventory preserves firstSeen and serial revision', fixture(async (_t, root) => {
  const manager = new CoreManager(root, () => new Date('2026-10-11T00:00:00.000Z'));
  const base = { kind: 'vscode', version: '1', protocol: { min: 1, max: 1 }, capabilities: [] };
  await manager.registerClient({ ...base, clientId: 'vscode-a' });
  const result = await manager.registerClient({ ...base, clientId: 'vscode-b' });
  assert.equal(result.revision, 2); assert.deepEqual(result.clients.map((x) => x.clientId).sort(), ['vscode-a', 'vscode-b']);
}));

test('leases are per instance and expiry determines liveness', fixture(async (_t, root) => {
  const manager = new CoreManager(root, () => new Date('2026-10-11T00:01:00.000Z')); manager.initialize();
  const base = { schemaVersion: 1, clientId: 'vscode-a', kind: 'vscode', runtimeId: 'blackhole-core', buildId: 'build-a', descriptorHash: HASH_A, dataRootId: HASH_B, daemonId: 'daemon-a', issuedAt: '2026-10-11T00:00:00.000Z' };
  manager.writeLease({ ...base, leaseId: '11111111-1111-4111-8111-111111111111', clientInstanceId: '22222222-2222-4222-8222-222222222222', expiresAt: '2026-10-11T00:02:00.000Z' });
  manager.writeLease({ ...base, leaseId: '33333333-3333-4333-8333-333333333333', clientInstanceId: '44444444-4444-4444-8444-444444444444', expiresAt: '2026-10-11T00:00:30.000Z' });
  assert.deepEqual(manager.liveLeases().map((x) => x.clientInstanceId), ['22222222-2222-4222-8222-222222222222']);
}));


test('activation keeps known-good and broken pointers fail closed', fixture(async (_t, root) => {
  const manager = new CoreManager(root);
  await manager.provision('a.zip', 'seed', verifier(HASH_A, 'build-a')); await manager.provision('b.zip', 'seed', verifier(HASH_B, 'build-b'));
  await manager.activate('1.0.0-build-a'); await manager.activate('1.0.0-build-b');
  assert.equal(manager.select().versionName, '1.0.0-build-b'); assert.equal(manager.select('known-good.json').versionName, '1.0.0-build-a');
  fs.writeFileSync(path.join(root, 'active.json'), JSON.stringify({ schemaVersion: 1, versionName: 'missing', descriptorHash: HASH_A }));
  assert.throws(() => manager.select(), /broken_pointer/);
}));

test('recovery commits response-loss transaction and rolls back incomplete staging', fixture(async (_t, root) => {
  const manager = new CoreManager(root); manager.initialize(); await manager.provision('a.zip', 'seed', verifier());
  const committedTx = fs.readdirSync(path.join(root, 'state/transactions'))[0]; const committedFile = path.join(root, 'state/transactions', committedTx);
  const record = JSON.parse(fs.readFileSync(committedFile)); record.state = 'verified'; fs.writeFileSync(committedFile, JSON.stringify(record));
  const lost = '55555555-5555-4555-8555-555555555555'; fs.mkdirSync(path.join(root, 'staging', lost));
  fs.writeFileSync(path.join(root, 'state/transactions', `${lost}.json`), JSON.stringify({ ...record, transactionId: lost, buildId: 'never-committed', descriptorHash: HASH_B, state: 'verified' }));
  const result = await manager.recoverTransactions(); assert.deepEqual(result.committed, [record.transactionId]); assert.deepEqual(result.rolledBack, [lost]);
  assert.equal(JSON.parse(fs.readFileSync(committedFile)).state, 'committed'); assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'state/transactions', `${lost}.json`))).state, 'rolled_back');
}));

test('GC protects active, known-good, live lease and caller running set; corrupt state blocks deletion', fixture(async (_t, root) => {
  const manager = new CoreManager(root, () => new Date('2026-10-11T00:01:00.000Z'));
  for (const [hash, build] of [[HASH_A, 'a'], [HASH_B, 'b'], ['c'.repeat(64), 'c'], ['d'.repeat(64), 'd']]) await manager.provision(`${build}.zip`, 'seed', verifier(hash, build));
  await manager.activate('1.0.0-a'); await manager.activate('1.0.0-b');
  manager.writeLease({ schemaVersion: 1, leaseId: '66666666-6666-4666-8666-666666666666', clientId: 'desktop', clientInstanceId: '77777777-7777-4777-8777-777777777777', kind: 'desktop', runtimeId: 'blackhole-core', buildId: 'c', descriptorHash: 'c'.repeat(64), dataRootId: HASH_A, daemonId: 'daemon-c', issuedAt: '2026-10-11T00:00:00.000Z', expiresAt: '2026-10-11T00:02:00.000Z' });
  assert.deepEqual(await manager.garbageCollect(['1.0.0-d']), []);
  fs.rmSync(path.join(root, 'state/client-leases'), { recursive: true }); fs.mkdirSync(path.join(root, 'state/client-leases'));
  assert.deepEqual((await manager.garbageCollect()).sort(), ['1.0.0-c', '1.0.0-d']);
  fs.writeFileSync(path.join(root, 'state/client-leases/bad.json'), '{bad'); await manager.provision('e.zip', 'seed', verifier('e'.repeat(64), 'e'));
  await assert.rejects(manager.garbageCollect(), /trusted store state/); assert.ok(fs.existsSync(path.join(root, 'versions/1.0.0-e')));
}));


test('two clients racing the same Seed serialize without duplicate commit', fixture(async (_t, root) => {
  const first = new CoreManager(root), second = new CoreManager(root);
  let release; const gate = new Promise((resolve) => { release = resolve; }); let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const slow = async (archive, destination) => { entered(); await gate; return verifier()(archive, destination); };
  const pending = first.provision('seed.zip', 'seed', slow); await started;
  await assert.rejects(second.provision('seed.zip', 'seed', verifier()), (error) => error instanceof StoreLockError && error.code === 'lock_busy');
  release(); await pending; await second.provision('seed.zip', 'seed', verifier());
  assert.deepEqual(fs.readdirSync(path.join(root, 'versions')), ['1.0.0-build-a']);
}));

test('automatic seed staging waits only before entering a competing install lock', fixture(async (_t, root) => {
 const first=new CoreManager(root),second=new CoreManager(root);
 let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
 const a=first.provision('seed.zip','seed',async(...args)=>{entered();await gate;return verifier()(...args)});
 await started;
 const b=second.provision('seed.zip','seed',verifier(),3000);
 release();await Promise.all([a,b]);
 assert.deepEqual(fs.readdirSync(path.join(root,'versions')),['1.0.0-build-a']);
 let calls=0;
 await assert.rejects(second.provision('seed.zip','seed',async()=>{calls++;throw new StoreLockError('lock_busy','failure inside verifier')},3000),/failure inside verifier/);
 assert.equal(calls,1,'a failure after staging began must never be automatically replayed');
}));

test('an old lock owned by this live process is not stolen', fixture(async (_t, root) => {
  const now = new Date('2026-10-11T00:03:00.000Z'); const manager = new CoreManager(root, () => now); manager.initialize();
  const lock = path.join(root, 'state/locks/install.lock'); fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, createdAt: '2026-10-11T00:00:00.000Z' }));
  await assert.rejects(manager.withLock('install', () => undefined), (error) => error instanceof StoreLockError && error.code === 'lock_busy');
}));


test('lifecycle token is signed, target-bound, short-lived and single-use', fixture(async (_t, root) => {
  let now = new Date('2026-10-11T00:00:00.000Z'); const manager = new CoreManager(root, () => now);
  const expected = { operation: 'stop', daemonId: 'daemon-a', startFingerprint: 'fp-a', runtimeId: 'blackhole-core', buildId: 'a', dataRootId: HASH_A, transactionId: '88888888-8888-4888-8888-888888888888' };
  const issued = await manager.issueLifecycleToken(expected, 5_000); assert.match(issued.publicKeyPem, /BEGIN PUBLIC KEY/);
  await assert.rejects(manager.consumeLifecycleToken(issued.token, { ...expected, daemonId: 'daemon-b' }), /target_mismatch/);
  assert.equal((await manager.consumeLifecycleToken(issued.token, expected)).nonce, issued.claims.nonce);
  await assert.rejects(manager.consumeLifecycleToken(issued.token, expected));
  const expiring = await manager.issueLifecycleToken(expected, 1_000); now = new Date('2026-10-11T00:00:02.000Z');
  await assert.rejects(manager.consumeLifecycleToken(expiring.token, expected), /expired/);
}));

test('transaction query rejects path-shaped ids and returns strict state', fixture(async (_t, root) => {
  const manager = new CoreManager(root); await manager.provision('a.zip', 'seed', verifier());
  const id = fs.readdirSync(path.join(root, 'state/transactions'))[0].replace('.json', '');
  assert.equal(manager.queryTransaction(id).state, 'committed');
  assert.throws(() => manager.queryTransaction('../clients'), /transaction_id_invalid/);
}));
