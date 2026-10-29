// Independent integration checks for the managed lifecycle. Builds an immutable
// source snapshot outside shared dist/ and starts only test-signed fixture cores.
// No installer, VS Code GUI, production Store, user data, registry or network feed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { randomUUID, createHash, generateKeyPairSync } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../packages/vscode/package.json', import.meta.url));
const { build } = require('esbuild');
const snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-independent-code-'));
const sourceHashes = new Map();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const entries = {
  manager: 'packages/host-runtime/src/core-manager.ts',
  lifecycle: 'packages/host-runtime/src/core-lifecycle.ts',
  control: 'src/lifecycle/managed-control.ts',
  session: 'packages/vscode/src/managedCoreSession.ts',
  archive: 'scripts/core-runtime-lib.mjs',
};
try {
  for (const [name, relative] of Object.entries(entries)) {
    await build({
      entryPoints: [path.join(root, relative)], outfile: path.join(snapshotDir, name + '.cjs'),
      bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent',
      plugins: [{ name: 'isolated-source-snapshot', setup(builder) {
        // Do not consume another session's mutable contracts/dist output.
        builder.onResolve({ filter: /contracts[\\/]dist[\\/]/ }, args => {
          const resolved = path.resolve(args.resolveDir, args.path).replace(/([\\/]contracts[\\/])dist([\\/])/, '$1src$2').replace(/\.js$/, '.ts');
          return fs.existsSync(resolved) ? { path: resolved } : undefined;
        });
        builder.onLoad({ filter: /\.(?:ts|tsx|js|mjs)$/ }, args => {
          const relativePath = path.relative(root, args.path).replaceAll('\\', '/');
          if (relativePath.startsWith('../') || relativePath.includes('node_modules/')) return;
          const contents = fs.readFileSync(args.path, 'utf8');
          const digest = hash(contents), prior = sourceHashes.get(relativePath);
          if (prior && prior !== digest) throw new Error('source_changed_during_snapshot:' + relativePath);
          sourceHashes.set(relativePath, digest);
          return { contents, loader: args.path.endsWith('.tsx') ? 'tsx' : args.path.endsWith('.ts') ? 'ts' : 'js' };
        });
      } }],
    });
  }
} catch (error) {
  fs.rmSync(snapshotDir, { recursive: true, force: true });
  throw error;
}
const { CoreManager } = require(path.join(snapshotDir, 'manager.cjs'));
const { CoreLifecycle } = require(path.join(snapshotDir, 'lifecycle.cjs'));
const { ManagedCoreSession } = require(path.join(snapshotDir, 'session.cjs'));
const { signDescriptor } = require(path.join(snapshotDir, 'archive.cjs'));
const controllerBytes = fs.readFileSync(path.join(snapshotDir, 'control.cjs'));
const nodeBytes = fs.readFileSync(process.execPath);
const nodeDigest = hash(nodeBytes);
const snapshotIdentity = hash(JSON.stringify([...sourceHashes].sort(([a], [b]) => a.localeCompare(b))));
console.log('# independent-source-snapshot ' + snapshotIdentity);
console.log('# source-hashes ' + JSON.stringify(Object.fromEntries(sourceHashes)));
after(() => {
  const changed = [...sourceHashes].filter(([relative, expected]) => {
    try { return hash(fs.readFileSync(path.join(root, relative))) !== expected; } catch { return true; }
  }).map(([relative]) => relative);
  console.log('# source-changed-after-snapshot ' + JSON.stringify(changed));
  fs.rmSync(snapshotDir, { recursive: true, force: true });
});

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const handle = lease => Object.fromEntries(['leaseId', 'clientInstanceId', 'daemonId', 'dataRootId', 'descriptorHash'].map(k => [k, lease[k]]));
const client = kind => ({ clientId: 'independent-' + kind, clientInstanceId: randomUUID(), kind, version: '0.3.201', protocol: { min: 1, max: 1 }, capabilities: ['web-ui'] });
function request(port, route, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, path: route, method: payload ? 'POST' : 'GET', agent: false,
      headers: payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {} }, res => {
      let text = ''; res.on('data', b => { text += b; if (text.length > 256 * 1024) res.destroy(new Error('fixture_response_too_large')); });
      res.on('error', reject); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(text || '{}') }); } catch (e) { reject(e); } });
    });
    const timer = setTimeout(() => req.destroy(new Error('fixture_request_timeout')), 2500);
    req.once('close', () => clearTimeout(timer)); req.once('error', reject); req.end(payload);
  });
}
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; }
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  assert.notEqual(port, 7306); assert.notEqual(port, 17306); return port;
}

function daemonCode(version, failStart) {
  return `
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {randomUUID}=require('node:crypto');
const identity=JSON.parse(process.env.BLACKHOLE_MANAGED_RUNTIME_IDENTITY);
const home=process.env.BLACKHOLE_HOME,port=Number(process.env.BLACKHOLE_PORT);
fs.mkdirSync(home,{recursive:true});
fs.appendFileSync(path.join(home,'fixture-starts.jsonl'),JSON.stringify({pid:process.pid,port,version:${JSON.stringify(version)},fingerprint:process.env.BLACKHOLE_START_FINGERPRINT})+'\\n');
if(${JSON.stringify(failStart)})process.exit(37);
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(process.env.BLACKHOLE_DB);
db.exec('CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
const {ManagedControl,MaintenanceGate}=require('./managed-control.cjs');
const daemonId=randomUUID();
const control=new ManagedControl({publicKeyPem:process.env.BLACKHOLE_MANAGER_PUBLIC_KEY,identity,daemonId,startFingerprint:process.env.BLACKHOLE_START_FINGERPRINT,gate:new MaintenanceGate(),assertIdle(){}});
const health={ok:true,version:${JSON.stringify(version)},daemon_id:daemonId,settings_revision:0,
start_fingerprint:process.env.BLACKHOLE_START_FINGERPRINT,db_path:process.env.BLACKHOLE_DB,
runtime_id:identity.runtimeId,runtime_version:identity.runtimeVersion,build_id:identity.buildId,
descriptor_hash:identity.descriptorHash,data_root_id:identity.dataRootId,web_build_id:identity.webBuildId,
core_protocol:identity.coreProtocol,core_environment:identity.environment,core_cloud_origin:identity.cloudOrigin,
cloud_origin:identity.cloudOrigin,lifecycle_state:'managed',lifecycle_control_version:1,lifecycle_manager_key_hash:control.publicKeyHash,
fixture_id:process.env.BH_INDEPENDENT_FIXTURE_ID};
const stop=()=>setTimeout(()=>{db.close();process.exit(0)},40);
http.createServer((req,res)=>{
res.setHeader('content-type','application/json');
if(req.url==='/api/health'){res.end(JSON.stringify({...health,lifecycle_state:identity.lifecycleState}));return;}
if(req.url==='/ui/'){res.statusCode=302;res.end('{}');return;}
if(req.url==='/fixture/notes'&&req.method==='GET'){res.end(JSON.stringify(db.prepare('SELECT value FROM notes ORDER BY id').all()));return;}
let text='';req.on('data',b=>{text+=b;if(text.length>16384)req.destroy()});req.on('end',()=>{
try{const body=JSON.parse(text||'{}');
if(req.url==='/api/core/stop'){
fs.appendFileSync(path.join(home,'fixture-stop-requests.log'),'stop\\n');
const receipt=control.acceptStop(body.token);res.end(JSON.stringify({ok:true,...receipt}));stop();return;}
if(req.url==='/fixture/write'){db.prepare('INSERT INTO notes(value) VALUES (?)').run(body.value);res.end('{"ok":true}');return;}
if(req.url==='/fixture/cleanup'&&body.nonce===process.env.BH_INDEPENDENT_CLEANUP_NONCE){res.end('{"ok":true}');stop();return;}
res.statusCode=404;res.end('{}');
}catch(e){res.statusCode=409;res.end(JSON.stringify({error:/^[a-z_]+$/.test(e.message)?e.message:'fixture_invalid'}));}
});
}).listen(port,'127.0.0.1');
`;
}

async function fixture(t, { badB = false } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-independent-versions-'));
  // The lifecycle now enforces the single canonical user root (~/.blackhole).
  // Keep the fixture isolated by changing HOME/USERPROFILE, rather than
  // injecting a second BLACKHOLE_HOME layout.
  const data = path.join(temp, '.blackhole'), store = path.join(temp, 'Core');
  fs.mkdirSync(data, { recursive: true });
  const fixtureId = randomUUID(), cleanupNonce = randomUUID(), port = await freePort();
  const env = { ...process.env, HOME: temp, USERPROFILE: temp, LOCALAPPDATA: path.join(temp, 'Local'), APPDATA: path.join(temp, 'Roaming'),
    BLACKHOLE_HOME: data, BLACKHOLE_DB: path.join(data, 'blackhole.db'), BLACKHOLE_PORT: String(port), BLACKHOLE_TUNNEL: 'off',
    BH_INDEPENDENT_FIXTURE_ID: fixtureId, BH_INDEPENDENT_CLEANUP_NONCE: cleanupNonce };
  const pair = generateKeyPairSync('ed25519');
  const trust = { environment: 'test', publicKeys: { 'test-independent': pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() } };
  const manager = new CoreManager(store), lifecycle = new CoreLifecycle(manager, trust, env);
  const spawns = () => {
    const file = path.join(data, 'fixture-starts.jsonl');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  };
  t.after(async () => {
    // Never blindly terminate a PID. The live endpoint, fixture id, recorded
    // fingerprint and test-only cleanup nonce must all bind this owned child.
    for (const record of spawns()) {
      if (!pidAlive(record.pid)) continue;
      const response = await request(port, '/api/health');
      assert.equal(response.body.fixture_id, fixtureId, 'cleanup must bind the isolated fixture');
      assert.equal(response.body.start_fingerprint, record.fingerprint, 'cleanup must bind the owned incarnation');
      await request(port, '/fixture/cleanup', { nonce: cleanupNonce });
      for (let i = 0; i < 100 && pidAlive(record.pid); i++) await pause(50);
      assert.equal(pidAlive(record.pid), false, 'unknown cleanup: preserve fixture, do not kill a PID');
    }
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  async function install(version, buildId, failStart = false) {
    const result = await manager.provision('independent-fixture.zip', 'seed', async (_archive, destination) => {
      const nodeEntry = process.platform === 'win32' ? 'node/node.exe' : 'node/node';
      const files = { [nodeEntry]: nodeBytes, 'daemon/cli.cjs': Buffer.from(daemonCode(version, failStart)),
        'daemon/managed-control.cjs': controllerBytes, 'web/index.html': Buffer.from('<!doctype html>Version ' + version),
        'host/manager.mjs': Buffer.from('// synthetic packaging entry; test uses the snapshotted real Manager\n') };
      const members = [];
      for (const [name, bytes] of Object.entries(files)) {
        const file = path.join(destination, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
        if (name === nodeEntry && process.platform !== 'win32') fs.chmodSync(file, 0o700);
        members.push({ path: name, sha256: name === nodeEntry ? nodeDigest : hash(bytes), size: bytes.length });
      }
      const unsigned = { formatVersion: 1, runtimeId: 'blackhole-core', runtimeVersion: version, buildId, platform: process.platform, arch: process.arch,
        environment: 'test', cloudOrigin: 'https://fixture.invalid', coreProtocol: { min: 1, max: 1 }, capabilities: ['web-ui'],
        nodeVersion: process.version, nodeEntry, daemonVersion: version, daemonEntry: 'daemon/cli.cjs', webBuildId: 'web-' + version,
        webRoot: 'web', managerEntry: 'host/manager.mjs', dataSchema: { min: 1, max: 1 }, migrationPolicy: 'none', members,
        signingKeyId: 'test-independent', signatureAlgorithm: 'ed25519', createdAt: new Date().toISOString() };
      const descriptor = { ...unsigned, signature: signDescriptor(unsigned, pair.privateKey) };
      const bytes = Buffer.from(JSON.stringify(descriptor, null, 2) + '\n'); fs.writeFileSync(path.join(destination, 'core-descriptor.json'), bytes);
      return { descriptor, descriptorHash: hash(bytes) };
    });
    return { ...result, versionName: version + '-' + buildId };
  }
  const a = await install('1.0.0', 'independent-a'), b = await install('1.1.0', badB ? 'independent-b-fails' : 'independent-b', badB);
  await manager.activate(a.versionName);
  const actor = client('vscode'), attach = () => lifecycle.attachOrStart({ client: actor, port, readyTimeoutMs: 6000 });
  const maintain = (attachment, operation = 'stop') => lifecycle.maintainCore({ operation, confirmed: true, requestId: randomUUID(), client: actor, handle: handle(attachment.lease), port });
  return { temp, data, port, manager, lifecycle, actor, a, b, spawns, attach, maintain };
}

test('different-version staged update does not turn an ordinary restart into an upgrade', { timeout: 60000 }, async t => {
  const f = await fixture(t), first = await f.attach();
  await request(f.port, '/fixture/write', { value: 'before-restart' });
  await f.manager.activate(f.b.versionName);
  const result = await f.maintain(first, 'restart');
  assert.equal(result.attachment.receipt.runtimeVersion, '1.0.0');
  assert.notEqual(result.attachment.receipt.daemonId, first.receipt.daemonId);
  assert.equal(result.attachment.receipt.descriptorHash, first.receipt.descriptorHash);
  assert.equal(f.manager.select().versionName, f.b.versionName, 'restart must not rewrite the staged active pointer');
  assert.deepEqual((await request(f.port, '/fixture/notes')).body, [{ value: 'before-restart' }]);
  assert.deepEqual(f.spawns().map(s => s.version), ['1.0.0', '1.0.0']);
});

test('explicit cold version A to B activation preserves SQLite data, endpoint and root identity', { timeout: 60000 }, async t => {
  const f = await fixture(t), first = await f.attach();
  await request(f.port, '/fixture/write', { value: 'keep-across-upgrade' });
  const stopped = await f.maintain(first); assert.equal(stopped.stopped, true);
  await f.lifecycle.activateColdCore({ versionName: f.b.versionName, port: f.port });
  const second = await f.attach();
  assert.equal(second.receipt.runtimeVersion, '1.1.0'); assert.equal(second.receipt.daemonVersion, '1.1.0');
  assert.equal(second.receipt.dataRootId, first.receipt.dataRootId); assert.equal(second.receipt.localUrl, first.receipt.localUrl);
  assert.notEqual(second.receipt.descriptorHash, first.receipt.descriptorHash); assert.notEqual(second.receipt.daemonId, first.receipt.daemonId);
  assert.deepEqual((await request(f.port, '/fixture/notes')).body, [{ value: 'keep-across-upgrade' }]);
  assert.deepEqual(f.spawns().map(s => s.version), ['1.0.0', '1.1.0']);
});

test('failed version B is not blindly respawned; explicit dead-start recovery permits A without restoring stale data', { timeout: 60000 }, async t => {
  const f = await fixture(t, { badB: true }), first = await f.attach();
  await request(f.port, '/fixture/write', { value: 'latest-user-write' });
  await f.maintain(first);
  await f.lifecycle.activateColdCore({ versionName: f.b.versionName, port: f.port });
  await assert.rejects(f.attach(), /kernel_exited|ready_timeout/);
  const recorded = await f.lifecycle.inspectStart(); assert.ok(recorded?.pid);
  await assert.rejects(f.attach(), /daemon_state_unknown/);
  assert.equal(f.spawns().filter(s => s.version === '1.1.0').length, 1);
  for (let i = 0; i < 100 && pidAlive(recorded.pid); i++) await pause(50);
  assert.equal(pidAlive(recorded.pid), false);
  await assert.rejects(f.lifecycle.recoverStart({ confirmed: true, dataRootId: recorded.dataRootId, descriptorHash: '0'.repeat(64), startFingerprint: recorded.startFingerprint }), /recovery_target_mismatch/);
  const repaired = await f.lifecycle.recoverStart({ confirmed: true, dataRootId: recorded.dataRootId, descriptorHash: recorded.descriptorHash, startFingerprint: recorded.startFingerprint });
  assert.equal(repaired.recovered, true);
  await f.lifecycle.activateColdCore({ versionName: f.a.versionName, port: f.port });
  const restored = await f.attach(); assert.equal(restored.receipt.runtimeVersion, '1.0.0');
  assert.deepEqual((await request(f.port, '/fixture/notes')).body, [{ value: 'latest-user-write' }]);
});

test('another live lease refuses Stop; a foreign listener during the cold window refuses activation without pointer changes', { timeout: 60000 }, async t => {
  const f = await fixture(t), first = await f.attach();
  const second = await f.lifecycle.attachOrStart({ client: client('desktop'), port: f.port, readyTimeoutMs: 6000 });
  await assert.rejects(f.maintain(first), /active_clients/);
  assert.equal(fs.existsSync(path.join(f.data, 'fixture-stop-requests.log')), false, 'busy rejection must occur before sending a stop grant');
  await f.lifecycle.detach(handle(second.lease)); await f.maintain(first);
  const foreign = http.createServer((_q, r) => { r.setHeader('content-type', 'application/json'); r.end('{"ok":true}'); });
  await new Promise((resolve, reject) => { foreign.once('error', reject); foreign.listen(f.port, '127.0.0.1', resolve); });
  try {
    await assert.rejects(f.lifecycle.activateColdCore({ versionName: f.b.versionName, port: f.port }), /foreign_listener|managed_core_required/);
    assert.equal(f.manager.select().versionName, f.a.versionName);
    assert.equal(f.spawns().length, 1);
  } finally { await new Promise(resolve => foreign.close(resolve)); }
});

test('an explicit active-handler refusal remains a known refusal in the real VSIX session adapter', async t => {
  const actor = client('vscode'), now = Date.now(); let lost = 0;
  const receipt = { protocolVersion: 1, instanceKey: 'a'.repeat(64), daemonId: 'fixture-daemon', daemonVersion: '1.0.0', runtimeKind: 'standalone-node', uiVersion: 'web-a', configRevision: 0,
    localUrl: 'http://127.0.0.1:17307/ui/', webApiBase: '../web-api/v1/', capabilities: ['web-ui'], runtimeId: 'blackhole-core', runtimeVersion: '1.0.0', buildId: 'a',
    descriptorHash: 'b'.repeat(64), dataRootId: 'a'.repeat(64), webBuildId: 'web-a', coreProtocol: { min: 1, max: 1 }, environment: 'test', cloudOrigin: 'https://fixture.invalid', lifecycleState: 'managed', startFingerprint: randomUUID() };
  const lease = { schemaVersion: 1, leaseId: randomUUID(), clientId: actor.clientId, clientInstanceId: actor.clientInstanceId, kind: actor.kind,
    runtimeId: receipt.runtimeId, buildId: receipt.buildId, descriptorHash: receipt.descriptorHash, dataRootId: receipt.dataRootId, daemonId: receipt.daemonId,
    issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 45000).toISOString() };
  const calls = [];
  const session = new ManagedCoreSession({ client: actor, seedArchive: 'fixture.zip', environment: 'test', cloudOrigin: receipt.cloudOrigin, onLost() { lost++; },
    async invoke(q) { calls.push(q.command); if (q.command === 'attach-or-start') return { receipt, lease, spawned: false }; if (q.command === 'maintain-core') throw new Error('active_handlers'); if (q.command === 'heartbeat') return lease; return {}; } });
  t.after(() => session.close());
  await session.attach(17307);
  await assert.rejects(session.maintain('restart', true), /^Error: active_handlers$/);
  assert.equal(session.receipt?.daemonId, receipt.daemonId); assert.equal(lost, 0);
  await session.renew(); assert.equal(calls.filter(c => c === 'maintain-core').length, 1); assert.ok(calls.includes('heartbeat'));
});
