// End-to-end proof of the Windows reboot / PID-recycle recovery, using the real
// signed Manager and the real bundled Core in a disposable environment.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readArchive } from './core-runtime-lib.mjs';
import { auditUniversalVsix } from './audit-universal-vsix.mjs';
import { createIsolatedEnv } from './fixtures/isolated-env.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const target = process.argv[2];
if (!target || process.argv.length !== 3) throw Error('usage: node scripts/reboot-recovery-acceptance.mjs VSIX');
const audit = await auditUniversalVsix(path.resolve(target));
assert.equal(audit.coreCodeBundled, true);
assert.equal(audit.buildEnvironment, 'test');
const iso = await createIsolatedEnv({ name: 'reboot-recovery' });
assert.notEqual(iso.port, 7306);
const ext = path.join(iso.home, 'test-extension'), store = path.join(iso.dataDir, 'core');
fs.mkdirSync(ext, { recursive: true });
for (const [name, file] of await readArchive(path.resolve(target))) {
  if (!name.startsWith('extension/')) continue;
  const dest = path.resolve(ext, ...name.slice('extension/'.length).split('/'));
  assert.ok(dest.startsWith(ext + path.sep));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, file.bytes, { flag: 'wx' });
}
const manifest = JSON.parse(fs.readFileSync(path.join(ext, 'package.json'), 'utf8'));
const require = createRequire(path.join(repo, 'packages/vscode/package.json'));
const compiled = path.join(iso.home, 'adapter.cjs');
require('esbuild').buildSync({
  entryPoints: [path.join(repo, 'packages/vscode/src/sharedCoreManager.ts')],
  outfile: compiled, bundle: true, format: 'cjs', platform: 'node',
  define: { __BLACKHOLE_BUILD__: JSON.stringify(manifest.blackholeBuild) }, logLevel: 'silent',
});
const { SharedCoreManager } = require(compiled);
const env = { ...iso.env, BLACKHOLE_HOME: iso.dataDir, BH_CORE_STORE: store,
  APPDATA: path.join(iso.home, 'Roaming'), LOCALAPPDATA: path.join(iso.home, 'Local'), BLACKHOLE_TUNNEL: 'off' };
for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'BLACKHOLE_CORE_IDLE_SHUTDOWN']) delete env[name];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const runDir = path.join(store, 'state', 'running'), aliveDir = path.join(store, 'state', 'alive');
const recordFile = id => path.join(runDir, id + '.json');
const liveRecords = () => fs.existsSync(runDir) ? fs.readdirSync(runDir).filter(n => n.endsWith('.json')) : [];
const foreign = [];
let adapter;
const realEnv = { ...process.env };

async function withAdapter(run) {
  try {
    for (const name of Object.keys(process.env)) delete process.env[name];
    Object.assign(process.env, env);
    adapter = new SharedCoreManager(
      { extensionPath: ext, extension: { id: 'qianshe.blackhole-vscode', packageJSON: manifest } },
      { appendLine() {} }, () => { throw Error('offline_must_not_download'); });
    return await run(adapter);
  } finally {
    for (const name of Object.keys(process.env)) delete process.env[name];
    Object.assign(process.env, realEnv);
  }
}
async function attachOnce() {
  return withAdapter(async a => {
    const session = a.createSession(() => { throw Error('unexpected_lease_lost'); });
    const receipt = await session.attach(iso.port);
    await a.close();
    return receipt;
  });
}
async function waitClosed(port) {
  for (let i = 0; i < 200; i++) {
    try { await fetch('http://127.0.0.1:' + port + '/api/health', { signal: AbortSignal.timeout(500) }); }
    catch { return; }
    await sleep(50);
  }
  throw Error('core_did_not_stop');
}
function spawnForeign() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},120000)'], { stdio: 'ignore', windowsHide: true, detached: true });
  child.unref();
  foreign.push(child.pid);
  return child.pid;
}
/** Exactly what a user hits after a power cut: the Core is gone, its record
 *  survives, and Windows has handed the recorded PID to an unrelated process. */
function simulateRecycledPid(opts) {
  const [name] = liveRecords();
  assert.ok(name, 'a stale running record must exist');
  const id = path.basename(name, '.json');
  const record = JSON.parse(fs.readFileSync(recordFile(id), 'utf8'));
  const pid = spawnForeign();
  fs.writeFileSync(recordFile(id), JSON.stringify({ ...record, pid, bootId: opts.bootId }, null, 2) + '\n');
  assert.notEqual(pid, record.pid);
  fs.rmSync(path.join(aliveDir, id + '.json'), { force: true });
  if (opts.heartbeatAt !== undefined) {
    fs.mkdirSync(aliveDir, { recursive: true });
    fs.writeFileSync(path.join(aliveDir, id + '.json'), JSON.stringify({ schemaVersion: 1,
      dataRootId: record.dataRootId, startFingerprint: record.startFingerprint,
      daemonId: record.receipt.daemonId, pid, at: opts.heartbeatAt }));
  }
  return { record, pid };
}

let result;
try {
  // 1. A real managed Core writes a boot-stamped record and a live heartbeat lease.
  const first = await attachOnce();
  const bootId = JSON.parse(fs.readFileSync(path.join(store, 'state', 'boot.json'), 'utf8')).bootId;
  const [firstName] = liveRecords();
  const dataRootId = path.basename(firstName, '.json');
  const firstRecord = JSON.parse(fs.readFileSync(recordFile(dataRootId), 'utf8'));
  assert.equal(firstRecord.status, 'ready');
  assert.equal(firstRecord.receipt.daemonId, first.daemonId);
  assert.match(firstRecord.bootId, /^[A-Za-z0-9-]{8,100}$/, 'the record must carry its OS boot generation');
  const lease = JSON.parse(fs.readFileSync(path.join(aliveDir, dataRootId + '.json'), 'utf8'));
  assert.equal(lease.startFingerprint, firstRecord.startFingerprint, 'the live Core must publish a heartbeat lease');
  assert.equal(lease.pid, firstRecord.pid);
  assert.ok(Date.now() - lease.at < 60000, 'the heartbeat must be fresh while the Core runs');

  // 2. Power cut: the Core is terminated with no chance to clean up.
  process.kill(firstRecord.pid);
  await waitClosed(iso.port);
  assert.equal(liveRecords().length, 1, 'a killed Core leaves its running record behind');

  // 3. Reboot + PID recycle: an earlier boot stamp must be conclusive.
  simulateRecycledPid({ bootId: 'boot-generation-before-this-one' });
  const afterReboot = await attachOnce();
  assert.notEqual(afterReboot.daemonId, first.daemonId, 'a stale record must not block a new Core');
  assert.equal(fs.readdirSync(path.join(store, 'state', 'recovered-starts')).length, 1);
  const afterRebootRecord = JSON.parse(fs.readFileSync(recordFile(dataRootId), 'utf8'));
  assert.equal(afterRebootRecord.receipt.daemonId, afterReboot.daemonId);
  assert.equal(afterRebootRecord.bootId, bootId, 'a fresh record is stamped with the current boot');

  // 4. Same boot, recycled PID, heartbeat stopped refreshing: lease expiry is conclusive.
  process.kill(afterRebootRecord.pid);
  await waitClosed(iso.port);
  simulateRecycledPid({ bootId, heartbeatAt: Date.now() - 120000 });
  const afterLeaseExpiry = await attachOnce();
  assert.notEqual(afterLeaseExpiry.daemonId, afterReboot.daemonId);
  assert.equal(fs.readdirSync(path.join(store, 'state', 'recovered-starts')).length, 2);

  // 5. The guard is NOT weakened: a live PID with a fresh heartbeat stays ambiguous.
  const thirdRecord = JSON.parse(fs.readFileSync(recordFile(dataRootId), 'utf8'));
  process.kill(thirdRecord.pid);
  await waitClosed(iso.port);
  simulateRecycledPid({ bootId, heartbeatAt: Date.now() });
  let refused;
  try { await attachOnce(); } catch (error) { refused = error; }
  assert.ok(refused, 'an ambiguous record must still refuse to start a second Core');
  assert.match(String(refused && refused.message ? refused.message : refused), /daemon_state_unknown/);
  assert.equal(liveRecords().length, 1, 'the refused record is preserved for inspection');

  result = { ok: true, artifactSha256: audit.sha256, coreVersion: audit.coreVersion,
    bootStamp: 'record carries the OS boot generation', heartbeatLease: 'live Core refreshed it; killed Core did not',
    rebootWithRecycledPid: 'recovered', sameBootStaleLease: 'recovered', freshLeaseStillRefuses: true,
    archivedRecords: 2, secondCoreOnSameDatabase: false, realProfileUsed: false };
  fs.writeFileSync(path.join(iso.home, 'summary.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: String(error && error.message ? error.message : error), isolatedHome: iso.home }));
  process.exitCode = 1;
} finally {
  for (const pid of foreign) { try { process.kill(pid); } catch {} }
  for (const name of liveRecords()) {
    try { const record = JSON.parse(fs.readFileSync(recordFile(path.basename(name, '.json')), 'utf8')); if (record.pid) process.kill(record.pid); } catch {}
  }
  await (adapter ? adapter.close().catch(() => {}) : Promise.resolve());
  await sleep(300);
  try { iso.cleanup(); } catch {}
}
