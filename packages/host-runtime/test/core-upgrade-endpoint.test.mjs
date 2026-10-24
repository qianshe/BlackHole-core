import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { CoreManager } from '../dist/core-manager.cjs';
import { CoreLifecycle } from '../dist/core-lifecycle.cjs';
import { CoreUpgradeRecordSchema } from '../../contracts/dist/index.js';

// No daemon, installer, registry or client is started. Only these disposable
// Store files and two OS-assigned loopback ports are used by the real Manager.
async function closedPorts() {
  const servers = [net.createServer(), net.createServer()];
  try {
    for (const server of servers) {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
    }
    const ports = servers.map(server => server.address().port);
    assert.ok(ports.every(port => port !== 7306));
    return ports;
  } finally {
    await Promise.all(servers.map(server => server.listening
      ? new Promise(resolve => server.close(resolve)) : Promise.resolve()));
  }
}

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-upgrade-endpoint-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), data = path.join(home, '.blackhole');
  fs.mkdirSync(data, { recursive: true });
  const [port, nextPort] = await closedPorts();
  const manager = new CoreManager(path.join(root, 'Core'));
  const lifecycle = new CoreLifecycle(manager, { environment: 'test', publicKeys: {} }, {
    ...process.env, HOME: home, USERPROFILE: home,
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'), APPDATA: path.join(home, 'AppData', 'Roaming'),
    BLACKHOLE_HOME: data, BLACKHOLE_DB: path.join(data, 'blackhole.db'), BLACKHOLE_TUNNEL: 'off',
  });
  const endpoint = await lifecycle.resolveEndpoint({ fallbackPort: port });
  const endpointFile = path.join(manager.state, 'endpoints', endpoint.dataRootId + '.json');
  fs.mkdirSync(path.dirname(endpointFile), { recursive: true });
  fs.writeFileSync(endpointFile, JSON.stringify(endpoint));
  const receipt = {
    protocolVersion: 1, instanceKey: endpoint.dataRootId, daemonId: 'fixture-stopped-daemon', daemonVersion: '1.0.0',
    runtimeKind: 'standalone-node', uiVersion: 'web-a', configRevision: 0,
    localUrl: `http://127.0.0.1:${port}/ui/`, webApiBase: '../web-api/v1/', capabilities: ['web-ui'],
    runtimeId: 'blackhole-core', runtimeVersion: '1.0.0', buildId: 'a', descriptorHash: 'a'.repeat(64),
    dataRootId: endpoint.dataRootId, webBuildId: 'web-a', coreProtocol: { min: 1, max: 1 },
    environment: 'test', cloudOrigin: 'https://fixture.invalid', lifecycleState: 'managed', startFingerprint: 'fixture-old',
  };
  const record = state => CoreUpgradeRecordSchema.parse({
    schemaVersion: 1, requestId: randomUUID(), requestHash: 'c'.repeat(64),
    from: { schemaVersion: 1, status: 'ready', versionName: '1.0.0-a', descriptorHash: receipt.descriptorHash,
      dataRootId: endpoint.dataRootId, dbPath: path.join(data, 'blackhole.db'), port,
      startFingerprint: receipt.startFingerprint, receipt },
    targetVersionName: '1.1.0-b', targetDescriptorHash: 'b'.repeat(64),
    state, updatedAt: new Date().toISOString(),
  });
  const writeJournal = value => {
    const file = path.join(manager.state, 'upgrade', (value.requestId ?? randomUUID()) + '.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
    return file;
  };
  return { lifecycle, manager, endpoint, endpointFile, record, writeJournal,
    request: { confirmed: true, expectedPort: port, expectedRevision: endpoint.revision, port: nextPort } };
}

test('a pending Core upgrade journal blocks cold activation before moving the pointer', async t => {
  const f = await fixture(t);
  const existing = f.record('recovery_required');
  const journal = f.writeJournal(existing);
  const before = fs.readFileSync(journal);
  await assert.rejects(
    f.lifecycle.activateColdCore({ versionName: '1.1.0-b', port: f.endpoint.port, expectedVersionName: null, expectedDescriptorHash: null }),
    /upgrade_recovery_required/
  );
  assert.deepEqual(fs.readFileSync(journal), before);
  assert.equal(f.manager.select(), undefined);
});

for (const state of ['staged', 'stopping', 'switching', 'starting', 'verifying', 'rolling_back', 'recovery_required']) {
  test(`cold port change preserves endpoint and unresolved upgrade ${state}`, async t => {
    const f = await fixture(t);
    const journal = f.writeJournal(f.record(state));
    const beforeEndpoint = fs.readFileSync(f.endpointFile), beforeJournal = fs.readFileSync(journal);
    await assert.rejects(f.lifecycle.configureEndpoint(f.request), /upgrade_recovery_required/);
    assert.deepEqual(fs.readFileSync(f.endpointFile), beforeEndpoint);
    assert.deepEqual(fs.readFileSync(journal), beforeJournal);
    assert.equal(fs.existsSync(path.join(f.manager.state, 'running')), false);
    // A no-op port request must not be mistaken for successful recovery either.
    await assert.rejects(f.lifecycle.configureEndpoint({ ...f.request, port: f.request.expectedPort }), /upgrade_recovery_required/);
  });
}

for (const state of ['committed', 'rolled_back', 'refused']) {
  test(`terminal upgrade ${state} does not block a legitimate cold port change`, async t => {
    const f = await fixture(t);
    const journal = f.writeJournal(f.record(state));
    const before = fs.readFileSync(journal);
    const result = await f.lifecycle.configureEndpoint(f.request);
    assert.equal(result.port, f.request.port);
    assert.equal(result.revision, f.endpoint.revision + 1);
    assert.equal(result.dataRootId, f.endpoint.dataRootId);
    assert.deepEqual(fs.readFileSync(journal), before);
  });
}

test('corrupt upgrade journal fails closed without overwriting the endpoint', async t => {
  const f = await fixture(t);
  const file = f.writeJournal(f.record('recovery_required'));
  fs.writeFileSync(file, '{');
  const before = fs.readFileSync(f.endpointFile);
  await assert.rejects(f.lifecycle.configureEndpoint(f.request), /lifecycle_state_unknown/);
  assert.deepEqual(fs.readFileSync(f.endpointFile), before);
  assert.equal(fs.readFileSync(file, 'utf8'), '{');
});

test('invalid upgrade state is not treated as a completed transaction', async t => {
  const f = await fixture(t);
  f.writeJournal({ ...f.record('recovery_required'), state: 'unknown' });
  const before = fs.readFileSync(f.endpointFile);
  await assert.rejects(f.lifecycle.configureEndpoint(f.request));
  assert.deepEqual(fs.readFileSync(f.endpointFile), before);
});


test('two Managers cannot both commit a cold port change from the same revision', async t => {
  const f = await fixture(t);
  f.writeJournal(f.record('committed'));
  const other = new CoreLifecycle(new CoreManager(f.manager.root), f.lifecycle.trust, f.lifecycle.env);
  const results = await Promise.allSettled([
    f.lifecycle.configureEndpoint(f.request), other.configureEndpoint(f.request),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected');
  // The Store lock is non-waiting: the concurrent loser is explicitly busy.
  assert.equal(rejected.reason.code, 'lock_busy');
  // Once it is free, an old observation still cannot overwrite the winner.
  await assert.rejects(other.configureEndpoint(f.request), /endpoint_revision_conflict/);
  const saved = JSON.parse(fs.readFileSync(f.endpointFile, 'utf8'));
  assert.equal(saved.port, f.request.port);
  assert.equal(saved.revision, f.endpoint.revision + 1);
  assert.equal(fs.existsSync(path.join(f.manager.state, 'running')), false);
});
