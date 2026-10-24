import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startRunHeartbeat } from '../dist/lifecycle/run-heartbeat.js';

const managed = () => ({ runtimeIdentity: { lifecycleState: 'managed', dataRootId: 'a'.repeat(64), descriptorHash: 'b'.repeat(64) }, startFingerprint: 'fp-1', daemonId: 'daemon-1' });

function withEnv(value, run) {
  const prior = process.env.BLACKHOLE_RUN_HEARTBEAT;
  if (value === undefined) delete process.env.BLACKHOLE_RUN_HEARTBEAT; else process.env.BLACKHOLE_RUN_HEARTBEAT = value;
  try { return run(); }
  finally { if (prior === undefined) delete process.env.BLACKHOLE_RUN_HEARTBEAT; else process.env.BLACKHOLE_RUN_HEARTBEAT = prior; }
}

test('a managed Core publishes its liveness lease and removes it on shutdown', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-heartbeat-'));
  const file = path.join(dir, 'alive', 'a'.repeat(64) + '.json');
  try {
    const before = Date.now();
    const beat = withEnv(file, () => startRunHeartbeat(managed()));
    const lease = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(lease.schemaVersion, 1);
    assert.equal(lease.startFingerprint, 'fp-1');
    assert.equal(lease.daemonId, 'daemon-1');
    assert.equal(lease.dataRootId, 'a'.repeat(64));
    assert.equal(lease.pid, process.pid);
    assert.ok(lease.at >= before && lease.at <= Date.now(), 'lease timestamp must be fresh');
    beat.stop();
    assert.equal(fs.existsSync(file), false, 'a clean shutdown must not leave a stale lease');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('no lease is written without a Manager-supplied path or a managed lifecycle', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-heartbeat-'));
  try {
    const file = path.join(dir, 'alive', 'a'.repeat(64) + '.json');
    withEnv(undefined, () => startRunHeartbeat(managed())).stop();
    withEnv('relative/path.json', () => startRunHeartbeat(managed())).stop();
    withEnv(file, () => startRunHeartbeat({ ...managed(), runtimeIdentity: { ...managed().runtimeIdentity, lifecycleState: 'stopping' } })).stop();
    assert.equal(fs.existsSync(file), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
