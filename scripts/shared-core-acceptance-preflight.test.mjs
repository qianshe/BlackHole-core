import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { compareObservations, runPreflight, verifyCandidate } from './shared-core-acceptance-preflight.mjs';

const script = fileURLToPath(new URL('./shared-core-acceptance-preflight.mjs', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const candidate = { environment: 'test', version: '0.3.201', descriptorHash: 'a'.repeat(64) };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-acceptance-preflight-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = ['core.zip', 'bridge.vsix', 'desktop/blackhole.exe', 'desktop/installer/setup.exe'];
  const entries = files.map((file, index) => {
    const bytes = Buffer.from(`non-executable fixture ${index}\n`), absolute = path.join(root, file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true }); fs.writeFileSync(absolute, bytes);
    return { file, bytes: bytes.length, sha256: digest(bytes) };
  });
  const [core, vsix, launcher, installer] = entries;
  const manifest = {
    environment: candidate.environment, version: candidate.version,
    seed: { archive: core.file, bytes: core.bytes, archiveSha256: core.sha256, descriptorSha256: candidate.descriptorHash, signingKeyId: 'test-fixture' },
    vsix: { ...vsix, bridgeNotThin: true },
    desktop: { launcher: launcher.file, launcherBytes: launcher.bytes, launcherSha256: launcher.sha256,
      installer: installer.file, installerBytes: installer.bytes, installerSha256: installer.sha256 },
  };
  const manifestPath = path.join(root, 'artifact-manifest.json');
  const save = () => fs.writeFileSync(manifestPath, JSON.stringify(manifest)); save();
  return { root, manifest, manifestPath, files, save };
}

function observation(scenario = 'reuse') {
  const health = { ok: true, version: '0.3.201', daemon_id: 'daemon-a', start_fingerprint: 'start-a',
    db_path: 'C:\\Fixture\\Data\\blackhole.db', cloud_origin: 'https://fixture.invalid',
    lifecycle_state: 'managed', core_environment: 'test', core_cloud_origin: 'https://fixture.invalid',
    runtime_id: 'blackhole-core', runtime_version: '0.3.201', build_id: 'fixture-a',
    descriptor_hash: candidate.descriptorHash, data_root_id: 'b'.repeat(64), web_build_id: 'web-a',
    core_protocol: { min: 1, max: 1 }, settings_revision: 4, started_settings_revision: 3 };
  const input = { schemaVersion: 1, scenario,
    before: { environment: 'test', port: 17306, capturedAt: '2026-10-13T16:00:00Z', health: structuredClone(health) },
    after: { environment: 'test', port: 17306, capturedAt: '2026-10-13T16:02:00Z', health: structuredClone(health) } };
  if (scenario !== 'reuse') Object.assign(input.after.health, { daemon_id: 'daemon-b', start_fingerprint: 'start-b' });
  if (scenario === 'apply-settings') { input.expectedSettingsRevision = 4; input.after.health.started_settings_revision = 4; }
  if (scenario === 'migration') {
    for (const key of ['lifecycle_state', 'core_environment', 'core_cloud_origin', 'runtime_id', 'runtime_version', 'build_id', 'descriptor_hash', 'data_root_id', 'web_build_id', 'core_protocol']) delete input.before.health[key];
    input.before.health.version = '0.3.200';
  }
  return input;
}

function assertCode(fn, code) { assert.throws(fn, error => error.code === code); }

// These files are deliberately not runnable packages. Passing proves hash and
// observation checks only, never actual Core trust, GUI behavior or installation.
test('candidate preflight hashes four files without changing any input or granting acceptance', async t => {
  const f = fixture(t), paths = [f.manifestPath, ...f.files.map(file => path.join(f.root, file))];
  const before = paths.map(file => fs.readFileSync(file));
  const result = await runPreflight({ manifestPath: f.manifestPath, environment: 'test' });
  assert.equal(result.ok, true); assert.equal(result.artifacts.length, 4);
  assert.equal(result.manualAcceptance, 'not_evaluated');
  assert.equal(result.signatureVerification, 'not_performed');
  assert.equal(result.sourceFreshness, 'not_verified');
  assert.equal(result.observations, null);
  paths.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), before[index]));
});

test('environment must be explicit and match the candidate; production rejects test key labels', async t => {
  const f = fixture(t);
  await assert.rejects(verifyCandidate(f.manifestPath), /environment_required/);
  await assert.rejects(verifyCandidate(f.manifestPath, 'production'), /candidate_environment_mismatch/);
  f.manifest.environment = 'production'; f.save();
  await assert.rejects(verifyCandidate(f.manifestPath, 'production'), /production_test_key_rejected/);
});

test('non-bridge metadata cannot masquerade as the bridge candidate', async t => {
  const f = fixture(t); f.manifest.vsix.bridgeNotThin = false; f.save();
  await assert.rejects(verifyCandidate(f.manifestPath, 'test'), /bridge_candidate_required/);
});

test('changed artifact bytes are rejected even when the size is unchanged', async t => {
  const f = fixture(t), file = path.join(f.root, f.files[0]);
  const bytes = fs.readFileSync(file); bytes[0] ^= 1; fs.writeFileSync(file, bytes);
  await assert.rejects(verifyCandidate(f.manifestPath, 'test'), /artifact_hash_mismatch/);
});

test('incorrect size and missing artifacts fail the preflight', async t => {
  const f = fixture(t); f.manifest.seed.bytes++; f.save();
  await assert.rejects(verifyCandidate(f.manifestPath, 'test'), /artifact_size_mismatch/);
  f.manifest.seed.bytes--; f.save(); fs.unlinkSync(path.join(f.root, f.files[0]));
  await assert.rejects(verifyCandidate(f.manifestPath, 'test'), { code: 'ENOENT' });
});

for (const invalid of ['../outside.zip', 'C:\\outside.zip', '/outside.zip', 'desktop/../outside.zip', 'desktop//core.zip', 'core.zip:stream']) {
  test(`artifact path is confined: ${invalid}`, async t => {
    const f = fixture(t); f.manifest.seed.archive = invalid; f.save();
    await assert.rejects(verifyCandidate(f.manifestPath, 'test'), /artifact_path_invalid/);
  });
}

test('duplicate artifact paths are not counted as independent matching artifacts', async t => {
  const f = fixture(t);
  Object.assign(f.manifest.vsix, { file: f.manifest.seed.archive, bytes: f.manifest.seed.bytes, sha256: f.manifest.seed.archiveSha256 }); f.save();
  await assert.rejects(verifyCandidate(f.manifestPath, 'test'), /artifact_duplicate/);
});

test('artifact symlinks are refused rather than followed', async t => {
  const f = fixture(t), target = path.join(f.root, 'real.zip'), link = path.join(f.root, f.files[0]);
  fs.renameSync(link, target);
  try { fs.symlinkSync(target, link, 'file'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip(`fixture symlink unavailable: ${error.code}`); return; } throw error; }
  await assert.rejects(verifyCandidate(f.manifestPath, 'test'), /artifact_link_rejected/);
});

test('JSON inputs are size-bounded', async t => {
  const f = fixture(t); fs.writeFileSync(f.manifestPath, ' '.repeat(256 * 1024 + 1));
  await assert.rejects(verifyCandidate(f.manifestPath, 'test'), /json_too_large/);
});

for (const scenario of ['reuse', 'restart', 'migration', 'apply-settings']) {
  test(`consistent ${scenario} observations pass without claiming data preservation`, () => {
    const result = compareObservations(observation(scenario), candidate);
    assert.equal(result.scenario, scenario);
    assert.equal(result.dataPreservation, 'requires_manual_content_check');
    if (scenario === 'migration') assert.equal(result.legacyDataRootIdentity, 'unavailable_database_path_only');
  });
}

test('Windows path comparison normalizes case and separators, but rejects a different database', () => {
  const input = observation(); input.after.health.db_path = 'c:/fixture/data/blackhole.db';
  assert.equal(compareObservations(input, candidate).scenario, 'reuse');
  input.after.health.db_path = 'C:\\Fixture\\Other\\blackhole.db';
  assertCode(() => compareObservations(input, candidate), 'database_path_changed');
});

for (const invalid of ['relative.db', '\\current-drive\\blackhole.db', 'C:relative.db', '\\\\?\\C:\\data\\blackhole.db', 'C:\\data\\blackhole.db:stream']) {
  test(`ambiguous database path is rejected: ${invalid}`, () => {
    const input = observation(); input.after.health.db_path = invalid;
    assertCode(() => compareObservations(input, candidate), 'database_path_invalid');
  });
}

for (const [name, mutate, code] of [
  ['cross environment', x => { x.after.environment = 'production'; }, 'snapshot_environment_mismatch'],
  ['uncoordinated switch to default port', x => { x.after.port = 7306; }, 'endpoint_changed'],
  ['changed port', x => { x.after.port = 17307; }, 'endpoint_changed'],
  ['same capture time', x => { x.after.capturedAt = x.before.capturedAt; }, 'snapshot_order_invalid'],
  ['missing capture time', x => { delete x.after.capturedAt; }, 'snapshot_time_required'],
  ['invalid cloud origin', x => { x.after.health.cloud_origin = 'not-an-origin'; }, 'cloud_origin_invalid'],
  ['changed cloud origin', x => { x.after.health.cloud_origin = x.after.health.core_cloud_origin = 'https://other.invalid'; }, 'cloud_origin_changed'],
  ['wrong descriptor', x => { x.after.health.descriptor_hash = 'c'.repeat(64); }, 'selected_core_not_candidate'],
  ['different data root', x => { x.after.health.data_root_id = 'c'.repeat(64); }, 'shared_core_identity_changed'],
  ['different build', x => { x.after.health.build_id = 'different'; }, 'shared_core_identity_changed'],
  ['different protocol', x => { x.after.health.core_protocol.max = 2; }, 'shared_core_identity_changed'],
  ['missing managed field', x => { delete x.after.health.build_id; }, 'managed_identity_incomplete'],
  ['replaced daemon while reusing', x => { x.after.health.daemon_id = 'other'; }, 'daemon_replaced_during_reuse'],
]) {
  test(`observation rejects ${name}`, () => {
    const input = observation(); mutate(input);
    assertCode(() => compareObservations(input, candidate), code);
  });
}

test('restart requires both a new daemon ID and a new fingerprint', () => {
  const input = observation('restart'); input.after.health.start_fingerprint = input.before.health.start_fingerprint;
  assertCode(() => compareObservations(input, candidate), 'new_daemon_not_proven');
});

test('migration cannot start from an already-managed baseline or a different default data directory', () => {
  const input = observation('restart'); input.scenario = 'migration';
  assertCode(() => compareObservations(input, candidate), 'legacy_baseline_required');
  const migration = observation('migration'); migration.after.health.db_path = 'C:\\Fixture\\BlackHole-Test\\Data\\blackhole.db';
  assertCode(() => compareObservations(migration, candidate), 'database_path_changed');
});

test('a changed daemon ID alone never proves settings application', () => {
  const input = observation('apply-settings'); input.after.health.started_settings_revision = 3;
  assertCode(() => compareObservations(input, candidate), 'settings_application_not_proven');
  input.after.health.started_settings_revision = 4; input.after.health.settings_revision = 5;
  assertCode(() => compareObservations(input, candidate), 'settings_application_not_proven');
});

test('unknown health fields are omitted from reports', () => {
  const input = observation();
  input.after.health.token = input.after.health.mcp_url = input.after.health.core_protocol.extra = 'SENSITIVE_SENTINEL';
  assert.ok(!JSON.stringify(compareObservations(input, candidate)).includes('SENSITIVE_SENTINEL'));
});

test('CLI reads observations and PowerShell-style BOM without writing files', t => {
  const f = fixture(t), observationsPath = path.join(f.root, 'observations.json');
  fs.writeFileSync(observationsPath, '\uFEFF' + JSON.stringify(observation('restart')));
  const result = spawnSync(process.execPath, [script, '--manifest', f.manifestPath, '--environment', 'test', '--observations', observationsPath], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  assert.equal(report.observations.scenario, 'restart'); assert.equal(report.manualAcceptance, 'not_evaluated');
});

test('CLI errors are bounded and never echo parser excerpts or raw input paths', t => {
  const f = fixture(t), observationsPath = path.join(f.root, 'SENSITIVE_SENTINEL.json');
  fs.writeFileSync(observationsPath, '{SENSITIVE_SENTINEL');
  const args = [script, '--manifest', f.manifestPath, '--environment', 'test', '--observations', observationsPath];
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 1); assert.equal(result.stdout, '');
  assert.equal(JSON.parse(result.stderr).code, 'json_invalid'); assert.ok(!result.stderr.includes('SENSITIVE_SENTINEL'));
  const invalid = spawnSync(process.execPath, [script, '--manifest', f.manifestPath, '--force', 'SENSITIVE_SENTINEL'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(invalid.status, 1); assert.equal(JSON.parse(invalid.stderr).code, 'arguments_invalid');
  assert.ok(!invalid.stderr.includes('SENSITIVE_SENTINEL'));
});
