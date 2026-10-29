// Product-level upgrade verification: the REAL daemon bundle (src/cli.ts) is
// built twice with two version stamps, assembled into signed Cores, and run
// through the Manager upgrade transaction (guarded stop, pointer switch,
// candidate verify, commit) plus a rollback to the previous real daemon.
// Data continuity is proven against the real SQLite database (machine_state
// marker written while A runs, read back while B runs). This complements —
// never replaces — the synthetic-fixture suites.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const requireFromVscode = createRequire(new URL('../packages/vscode/package.json', import.meta.url));
const { build: esbuildBuild } = requireFromVscode('esbuild');
const { parseBuildArgs, daemonBuildDefines } = await import('../packages/vscode/build-config.mjs');
const { sha256, signDescriptor } = await import('./core-runtime-lib.mjs');

// Fresh Manager bundles under test.
const contractsDist = path.join(ROOT, 'packages/contracts/dist/index.js');
if (!fs.existsSync(contractsDist)) { const r = spawnSync('pnpm', ['--dir', 'packages/contracts', 'build'], { cwd: ROOT, stdio: 'inherit', shell: true }); assert.equal(r.status, 0); }
{ const r = spawnSync(process.execPath, ['packages/host-runtime/build.mjs'], { cwd: ROOT, stdio: 'inherit' }); assert.equal(r.status, 0); }
const { CoreManager } = await import('../packages/host-runtime/dist/core-manager.cjs');
const { CoreLifecycle } = await import('../packages/host-runtime/dist/core-lifecycle.cjs');
const { LeaseHandleSchema, UpgradeCoreResultSchema } = await import('../packages/contracts/dist/index.js');

const build = parseBuildArgs(['--environment', 'test']).build;
const INTEGRITY_SLOT = '<<BHI:' + ' '.repeat(8192) + ':BHI>>';
const daemonExternals = ['../workspace/sandboxed-shell.js', '../workspace/pwsh.js', '../workspace/shell-codepage.js', '../workspace/windows-env.js', '../win32/acl-sandbox.js', '../win32/ffi.js', 'koffi'];
const currentVersion = /export const VERSION = '([^']+)'/.exec(fs.readFileSync(path.join(ROOT, 'src/version.ts'), 'utf8'))[1];
const bumpedVersion = currentVersion.replace(/(\d+)$/, (n) => String(Number(n) + 1));
async function daemonBundle(version) {
  const plugin = { name: 'version-stamp', setup(b) { b.onLoad({ filter: /src[\\/]version\.ts$/ }, () => ({ contents: `export const VERSION = '${version}';`, loader: 'ts' })); } };
  const result = await esbuildBuild({ entryPoints: [path.join(ROOT, 'src/cli.ts')], bundle: true, platform: 'node', format: 'cjs', target: 'node22', write: false, external: daemonExternals, define: { ...daemonBuildDefines(build), __BLACKHOLE_INTEGRITY__: JSON.stringify(INTEGRITY_SLOT) }, plugins: [plugin] });
  return result.outputFiles[0].text;
}
const client = () => ({ clientId: 'desktop', clientInstanceId: randomUUID(), kind: 'desktop', version: '1.0.0', protocol: { min: 1, max: 1 }, capabilities: ['web-ui'] });
const handle = (lease) => LeaseHandleSchema.parse(Object.fromEntries(['leaseId', 'clientInstanceId', 'daemonId', 'dataRootId', 'descriptorHash'].map((key) => [key, lease[key]])));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function freePort() { const s = net.createServer(); await new Promise((res, rej) => { s.once('error', rej); s.listen(0, '127.0.0.1', res); }); const p = s.address().port; await new Promise((res) => s.close(res)); assert.notEqual(p, 7306); return p; }
function marker(dbPath, value) {
  const db = new DatabaseSync(dbPath);
  try { db.exec('PRAGMA busy_timeout = 5000'); if (value !== undefined) db.prepare("INSERT INTO machine_state(key,value,updated_at) VALUES('upgrade-smoke-marker',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(value, Date.now()); const row = db.prepare("SELECT value FROM machine_state WHERE key='upgrade-smoke-marker'").get(); return row?.value; } finally { db.close(); }
}

test('real product daemon upgrades A -> B with data preserved, then rolls back from a bad C', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-product-upgrade-'));
  const home = path.join(temp, 'home'), store = path.join(temp, 'Core'), data = path.join(home, '.blackhole');
  fs.mkdirSync(data, { recursive: true });
  const port = await freePort();
  const env = { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: path.join(home, 'AppData', 'Local'), BLACKHOLE_HOME: data, BLACKHOLE_DB: path.join(data, 'blackhole.db'), BLACKHOLE_PORT: String(port), BLACKHOLE_TUNNEL: 'off' };
  const pair = generateKeyPairSync('ed25519');
  const trust = { environment: 'test', publicKeys: { 'test-product': pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() } };
  const manager = new CoreManager(store);
  const lifecycle = new CoreLifecycle(manager, trust, env);
  const clientRequest = { client: client(), port, readyTimeoutMs: 60_000 };
  const distDaemon = path.join(ROOT, 'packages/vscode/dist/daemon');
  const distRoot = path.join(ROOT, 'packages/vscode/dist');
  for (const required of [path.join(distDaemon, 'cli.js'), path.join(distDaemon, 'web/index.html'), path.join(distRoot, 'workspace'), path.join(distRoot, 'win32')]) assert.ok(fs.existsSync(required), `vscode dist prerequisite missing: ${required} (run pnpm --dir packages/vscode build first)`);
  let daemonPid;
  t.after(async () => {
    try { const runDir = path.join(store, 'state', 'running'); for (const name of fs.readdirSync(runDir)) { const record = JSON.parse(fs.readFileSync(path.join(runDir, name), 'utf8')); if (record.pid) try { process.kill(record.pid); } catch {} } } catch {}
    await pause(300);
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  });
  async function addProductCore({ version, buildId, bundle }) {
    const installed = await manager.provision('product.zip', 'seed', async (_archive, destination) => {
      const nodeEntry = process.platform === 'win32' ? 'node/node.exe' : 'node/node';
      const put = (relative, source) => { const file = path.join(destination, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.copyFileSync(source, file); };
      put(nodeEntry, process.execPath);
      fs.mkdirSync(path.join(destination, 'daemon'), { recursive: true });
      fs.writeFileSync(path.join(destination, 'daemon/cli.cjs'), bundle);
      for (const name of ['process-supervisor.cjs', 'bh.py', 'LICENSE-MIT', 'semantic-NOTICE.md']) { const source = path.join(distDaemon, name); if (fs.existsSync(source)) put(path.join('daemon', name), source); }
      for (const tree of ['workspace', 'win32', 'node_modules']) { const source = path.join(distRoot, tree); if (fs.existsSync(source)) fs.cpSync(source, path.join(destination, tree), { recursive: true }); }
      fs.cpSync(path.join(distDaemon, 'web'), path.join(destination, 'web'), { recursive: true });
      fs.mkdirSync(path.join(destination, 'host'), { recursive: true });
      fs.writeFileSync(path.join(destination, 'host/manager.mjs'), '// product smoke manager member\n');
      const members = [];
      const visit = (dir) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const absolute = path.join(dir, entry.name); if (entry.isDirectory()) visit(absolute); else { const relative = path.relative(destination, absolute).split(path.sep).join('/'); const bytes = fs.readFileSync(absolute); members.push({ path: relative, sha256: sha256(bytes), size: bytes.length }); } } };
      visit(destination);
      const unsigned = { formatVersion: 1, runtimeId: 'blackhole-core', runtimeVersion: version, buildId, platform: process.platform, arch: process.arch, environment: 'test', cloudOrigin: build.origin, coreProtocol: { min: 1, max: 1 }, capabilities: ['web-ui'], nodeVersion: process.version, nodeEntry, daemonVersion: version, daemonEntry: 'daemon/cli.cjs', webBuildId: 'product-web-' + buildId, webRoot: 'web', managerEntry: 'host/manager.mjs', dataSchema: { min: 1, max: 1 }, migrationPolicy: 'none', members, signingKeyId: 'test-product', signatureAlgorithm: 'ed25519', createdAt: new Date().toISOString() };
      const descriptor = { ...unsigned, signature: signDescriptor(unsigned, pair.privateKey) };
      const bytes = Buffer.from(JSON.stringify(descriptor, null, 2) + '\n');
      fs.writeFileSync(path.join(destination, 'core-descriptor.json'), bytes);
      return { descriptor, descriptorHash: sha256(bytes) };
    });
    return { versionName: `${version}-${buildId}`, descriptorHash: installed.descriptorHash };
  }
  const a = await addProductCore({ version: currentVersion, buildId: 'product-a', bundle: await daemonBundle(currentVersion) });
  await manager.activate(a.versionName);
  const first = await lifecycle.attachOrStart(clientRequest);
  assert.equal(first.receipt.runtimeVersion, currentVersion);
  assert.equal(first.receipt.daemonVersion, currentVersion);
  daemonPid = JSON.parse(fs.readFileSync(path.join(store, 'state', 'running', fs.readdirSync(path.join(store, 'state', 'running'))[0]), 'utf8')).pid;
  assert.equal(marker(env.BLACKHOLE_DB, 'product-upgrade-preserved'), 'product-upgrade-preserved');
  const b = await addProductCore({ version: bumpedVersion, buildId: 'product-b', bundle: await daemonBundle(bumpedVersion) });
  assert.equal(manager.select().versionName, a.versionName);
  const upgraded = UpgradeCoreResultSchema.parse(await lifecycle.upgradeCore({ handle: handle(first.lease), client: clientRequest.client, port, confirmed: true, requestId: randomUUID(), targetVersionName: b.versionName, readyTimeoutMs: 60_000 }));
  assert.equal(upgraded.state, 'committed');
  assert.equal(upgraded.attachment.receipt.runtimeVersion, bumpedVersion);
  assert.equal(upgraded.attachment.receipt.daemonVersion, bumpedVersion);
  assert.notEqual(upgraded.attachment.receipt.daemonId, first.receipt.daemonId);
  assert.equal(upgraded.attachment.receipt.dataRootId, first.receipt.dataRootId);
  assert.equal(manager.select().versionName, b.versionName);
  assert.equal(manager.select('known-good.json').versionName, b.versionName);
  assert.equal(marker(env.BLACKHOLE_DB), 'product-upgrade-preserved');
  // A bad real-bundle candidate (exits immediately) must roll back to B.
  const badVersion = bumpedVersion.replace(/(\d+)$/, (n) => String(Number(n) + 1));
  const bad = await addProductCore({ version: badVersion, buildId: 'product-bad', bundle: 'process.exit(17);\n' });
  const rolled = UpgradeCoreResultSchema.parse(await lifecycle.upgradeCore({ handle: handle(upgraded.attachment.lease), client: clientRequest.client, port, confirmed: true, requestId: randomUUID(), targetVersionName: bad.versionName, readyTimeoutMs: 60_000 }));
  assert.equal(rolled.state, 'rolled_back');
  assert.equal(rolled.attachment.receipt.runtimeVersion, bumpedVersion);
  assert.notEqual(rolled.attachment.receipt.daemonId, upgraded.attachment.receipt.daemonId);
  assert.equal(manager.select().versionName, b.versionName);
  assert.equal(marker(env.BLACKHOLE_DB), 'product-upgrade-preserved');
  const stopped = await lifecycle.maintainCore({ handle: handle(rolled.attachment.lease), client: clientRequest.client, port, confirmed: true, requestId: randomUUID(), operation: 'stop' });
  assert.equal(stopped.stopped, true);
});
