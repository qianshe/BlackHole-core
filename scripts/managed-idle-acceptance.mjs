// Real signed Core+Manager end-to-end idle exit in a disposable environment.
// Never opens the user's port, profile, credentials, installed extension or network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readArchive } from './core-runtime-lib.mjs';
import { auditUniversalVsix } from './audit-universal-vsix.mjs';
import { createIsolatedEnv } from './fixtures/isolated-env.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const target = process.argv[2];
if (!target || process.argv.length !== 3) throw Error('usage: node scripts/managed-idle-acceptance.mjs OFFLINE_REVIEW_VSIX');
const archive = path.resolve(target);
const audit = await auditUniversalVsix(archive);
assert.equal(audit.coreCodeBundled, true);
assert.equal(audit.mode, 'host-node');
assert.equal(audit.buildEnvironment, 'test');
const iso = await createIsolatedEnv({ name: 'managed-idle-acceptance' });
assert.notEqual(iso.port, 7306);
const ext = path.join(iso.home, 'test-extension'), store = path.join(iso.dataDir, 'core');
fs.mkdirSync(ext, { recursive: true });
for (const [name, file] of await readArchive(archive)) {
  if (!name.startsWith('extension/')) continue;
  const relative = name.slice('extension/'.length);
  const dest = path.resolve(ext, ...relative.split('/'));
  assert.ok(dest.startsWith(ext + path.sep));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, file.bytes, { flag: 'wx' });
}
const manifest = JSON.parse(fs.readFileSync(path.join(ext, 'package.json'), 'utf8'));
const require = createRequire(path.join(repo, 'packages/vscode/package.json'));
const { buildSync } = require('esbuild');
const compiled = path.join(iso.home, 'adapter.cjs');
buildSync({
  entryPoints: [path.join(repo, 'packages/vscode/src/sharedCoreManager.ts')],
  outfile: compiled, bundle: true, format: 'cjs', platform: 'node',
  define: { __BLACKHOLE_BUILD__: JSON.stringify(manifest.blackholeBuild) }, logLevel: 'silent',
});
const { SharedCoreManager } = require(compiled);
const env = { ...iso.env, BLACKHOLE_HOME: iso.dataDir, BH_CORE_STORE: store,
  APPDATA: path.join(iso.home, 'Roaming'), LOCALAPPDATA: path.join(iso.home, 'Local'),
  BLACKHOLE_TUNNEL: 'off' };
for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'BLACKHOLE_CORE_IDLE_SHUTDOWN']) delete env[name];
const previous = { ...process.env };
let adapter, reopenedAdapter, attached = false, stopped = false, reopenedAndStopped = false;
const sleep = ms => new Promise(r => setTimeout(r, ms));
try {
  try {
    for (const name of Object.keys(process.env)) delete process.env[name];
    Object.assign(process.env, env);
    adapter = new SharedCoreManager(
      { extensionPath: ext, extension: { id: 'qianshe.blackhole-vscode', packageJSON: manifest } },
      { appendLine() {} }, () => { throw Error('offline_must_not_download'); });
  } finally {
    for (const name of Object.keys(process.env)) delete process.env[name];
    Object.assign(process.env, previous);
  }
  const session = adapter.createSession(() => { throw Error('unexpected_lease_lost'); });
  const receipt = await session.attach(iso.port); attached = true;
  const origin = 'http://127.0.0.1:' + iso.port;
  const health = await fetch(origin + '/api/health', { signal: AbortSignal.timeout(3000) }).then(r => r.json());
  assert.equal(health.version, audit.coreVersion);
  assert.equal(health.daemon_id, receipt.daemonId);
  assert.equal(health.lifecycle_state, 'managed');
  assert.equal(health.maintenance_idle, true);
  assert.equal(path.resolve(health.db_path), path.resolve(iso.dbPath));
  assert.equal(fs.existsSync(path.join(store, 'state', 'client-leases')), true);
  // Exercise the ACTUAL packaged MCP transport and route, not only health.
  // A signed Core without a logged-in test user must fail with the account
  // gate (403), never the former false "install_corrupted" 503 from Web files.
  const created = await fetch(origin + '/api/sessions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspace_path: iso.home, permission_mode: 'read-only',
      name: 'packaged MCP integrity acceptance' }),
  });
  assert.equal(created.status, 201, 'session creation on isolated signed Core');
  const fixtureSession = await created.json();
  assert.ok(fixtureSession.session_id && fixtureSession.mcp_url);
  const mcpClient = new Client({ name: 'blackhole-packaged-gate-check', version: '1' });
  try {
    await mcpClient.connect(new StreamableHTTPClientTransport(new URL(fixtureSession.mcp_url)));
    const tools = await mcpClient.listTools();
    assert.ok(tools.tools.some(tool => tool.name === 'guide'));
    assert.ok(tools.tools.some(tool => tool.name === 'exec'));
    for (const [name, args] of [
      ['guide', { sessionId: fixtureSession.session_id }],
      ['exec', { sessionId: fixtureSession.session_id, command: 'Write-Output MCP_OK' }],
    ]) {
      await assert.rejects(() => mcpClient.callTool({ name, arguments: args }), e => {
        const message = String(e?.message ?? e);
        assert.match(message, /entitlement_verification_required/, name + ': reached account guard');
        assert.doesNotMatch(message, /install_corrupted|integrity check failed/i,
          name + ': no false integrity refusal');
        return true;
      });
    }
  } finally { await mcpClient.close(); }
  const afterMcp = await fetch(origin + '/api/health', { signal: AbortSignal.timeout(3000) }).then(r => r.json());
  // SDK close commonly leaves a valid but idle protocol pair in Core's TTL
  // cache. That is diagnostics data, not ongoing execution.
  if ((afterMcp.stats?.mcp_live_pipes ?? 0) > 0)
    assert.equal(afterMcp.maintenance_idle, true, 'cached protocol cannot pin Core without work');
  await adapter.close();
  const start = Date.now(), deadline = start + 95_000;
  const stateRoot = path.join(store, 'state');
  const runGuard = path.join(stateRoot, 'running', receipt.dataRootId + '.json');
  const maintenanceDir = path.join(stateRoot, 'maintenance');
  let lastHealth = true, lastTrace = 0;
  while (Date.now() < deadline) {
    lastHealth = await fetch(origin + '/api/health', { signal: AbortSignal.timeout(1500) })
      .then(r => r.ok, () => false);
    if (!lastHealth && !fs.existsSync(runGuard)) { stopped = true; break; }
    const since = Date.now() - start;
    if (since - lastTrace > 12_000) {
      lastTrace = since;
      const all = fs.existsSync(maintenanceDir) ? fs.readdirSync(maintenanceDir).filter(n => n.endsWith('.json')) : [];
      const state = all.map(name => {
        try { return JSON.parse(fs.readFileSync(path.join(maintenanceDir, name), 'utf8')).state; }
        catch { return 'unreadable'; }
      });
      const leases = fs.readdirSync(path.join(stateRoot, 'client-leases')).filter(n => n.endsWith('.json')).length;
      console.log(JSON.stringify({ diagnostic: true, since, lastHealth, runGuard: fs.existsSync(runGuard), maintenance: state, leaseCount: leases }));
    }
    await sleep(1000);
  }
  assert.equal(stopped, true, 'signed Manager must confirm idle Stop and archive running record');
  assert.equal(await adapter.inspectStart(), null, 'Manager start record is archived');
  const db = new DatabaseSync(iso.dbPath);
  try { assert.equal(Object.values(db.prepare('PRAGMA integrity_check').get())[0], 'ok'); }
  finally { db.close(); }
  // A newly launched window must reuse the signed installed code and persistent
  // database but start a NEW daemon after the previous idle exit.
  try {
    for (const name of Object.keys(process.env)) delete process.env[name];
    Object.assign(process.env, env);
    reopenedAdapter = new SharedCoreManager(
      { extensionPath: ext, extension: { id: 'qianshe.blackhole-vscode', packageJSON: manifest } },
      { appendLine() {} }, () => { throw Error('reopen_must_not_download'); });
  } finally {
    for (const name of Object.keys(process.env)) delete process.env[name];
    Object.assign(process.env, previous);
  }
  const reSession = reopenedAdapter.createSession(() => { throw Error('reopened_lease_lost'); });
  const newReceipt = await reSession.attach(iso.port);
  assert.notEqual(newReceipt.daemonId, receipt.daemonId, 'new window starts a new daemon after idle exit');
  assert.equal(newReceipt.descriptorHash, receipt.descriptorHash, 'reopen must use same signed code');
  const reopenedHealth = await fetch(origin + '/api/health', { signal: AbortSignal.timeout(3000) }).then(r => r.json());
  assert.equal(reopenedHealth.daemon_id, newReceipt.daemonId);
  assert.equal(path.resolve(reopenedHealth.db_path), path.resolve(iso.dbPath));
  assert.equal((await reSession.maintain('stop', true)).operation, 'stop',
    'isolation cleanup uses the same Manager signed stop path');
  assert.equal(await reopenedAdapter.inspectStart(), null);
  await reopenedAdapter.close();
  reopenedAndStopped = true;
  const result = { ok: true, source: 'actual signed 0.4.x package', version: audit.version,
    runtimeVersion: audit.coreVersion, detachedHosts: 1, quietMs: Date.now() - start,
    autoStoppedBySignedManager: true, portGone: true, runGuardArchived: true, sqliteIntegrity: 'ok',
    reopenedSameCode: true, reopenedSameDatabase: true, reopenedNewDaemon: true, secondStopVerified: true,
    noPublicChannel: true, realCredentialsUsed: false, mainProfileUsed: false };
  try { iso.cleanup(); result.cleanup = 'complete'; }
  catch (error) {
    if (!['EBUSY','EPERM','ENOTEMPTY'].includes(error?.code)) throw error;
    result.cleanup = 'deferred_external_file_lock';
  }
  console.log(JSON.stringify(result));
} catch (e) {
  await adapter?.close().catch(() => {});
  await reopenedAdapter?.close().catch(() => {});
  console.error(JSON.stringify({ ok: false, attached, stopped, reopenedAndStopped, fixtureKept: iso.home,
    code: e instanceof Error ? e.message : String(e), mainProfileUsed: false }));
  process.exitCode = 1;
}
