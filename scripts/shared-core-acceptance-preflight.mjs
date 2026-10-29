// Read-only checks for the Windows x64 bridge acceptance runbook. Never starts
// a process, queries a daemon, installs a package, writes Store state or grants
// a release gate. A matching hash is not a release signature verification.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

class PreflightError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new PreflightError(code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 4096;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const port = value => Number.isInteger(value) && value > 0 && value <= 65535;
const revision = value => Number.isSafeInteger(value) && value >= 0;

function readJson(file, maxBytes) {
  const fd = fs.openSync(file, 'r');
  try {
    if (!fs.fstatSync(fd).isFile()) fail('json_file_required');
    const buffer = Buffer.alloc(maxBytes + 1);
    let size = 0, count;
    while (size < buffer.length && (count = fs.readSync(fd, buffer, size, buffer.length - size, null)) > 0) size += count;
    if (size > maxBytes) fail('json_too_large');
    try { return JSON.parse(buffer.subarray(0, size).toString('utf8').replace(/^\uFEFF/, '')); }
    catch { fail('json_invalid'); }
  } finally { fs.closeSync(fd); }
}

function memberFile(root, relative) {
  if (!text(relative) || relative.length > 512 || /[:\u0000-\u001f]/.test(relative)
    || path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative)) fail('artifact_path_invalid');
  const segments = relative.replace(/\\/g, '/').split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) fail('artifact_path_invalid');
  let current = root;
  for (let index = 0; index < segments.length; index++) {
    current = path.join(current, segments[index]);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) fail('artifact_link_rejected');
    if (index < segments.length - 1 ? !stat.isDirectory() : !stat.isFile()) fail('artifact_file_required');
  }
  const real = fs.realpathSync(current), inside = path.relative(root, real);
  if (inside === '..' || inside.startsWith('..' + path.sep) || path.isAbsolute(inside)) fail('artifact_path_escape');
  return real;
}

async function digestFile(file, expectedBytes) {
  const before = fs.statSync(file);
  if (before.size !== expectedBytes) fail('artifact_size_mismatch');
  const digest = createHash('sha256');
  let bytes = 0;
  for await (const chunk of fs.createReadStream(file)) {
    bytes += chunk.length;
    if (bytes > expectedBytes) fail('artifact_changed_during_read');
    digest.update(chunk);
  }
  const after = fs.statSync(file);
  if (bytes !== expectedBytes || after.size !== before.size || after.mtimeMs !== before.mtimeMs
    || after.ino !== before.ino) fail('artifact_changed_during_read');
  return digest.digest('hex');
}

export async function verifyCandidate(manifestPath, environment) {
  if (!['test', 'production'].includes(environment)) fail('environment_required');
  const absolute = path.resolve(manifestPath);
  const manifest = readJson(absolute, 256 * 1024);
  if (!object(manifest) || !object(manifest.seed) || !object(manifest.vsix) || !object(manifest.desktop)) fail('manifest_invalid');
  if (manifest.environment !== environment) fail('candidate_environment_mismatch');
  if (!text(manifest.version) || manifest.platform !== 'win32' || manifest.arch !== 'x64'
    || typeof manifest.sourceHead !== 'string' || !/^[a-f0-9]{40}$/.test(manifest.sourceHead)
    || !text(manifest.buildId) || manifest.seed.version !== manifest.version
    || !hash(manifest.seed.descriptorSha256) || !text(manifest.seed.signingKeyId)
    || manifest.vsix.version !== manifest.version) fail('manifest_identity_invalid');
  if (manifest.vsix.bridgeNotThin !== true || !['offline-code', 'bridge'].includes(manifest.vsix.corePackage)) fail('bridge_candidate_required');
  if (environment === 'production' && /^test[-_]/i.test(manifest.seed.signingKeyId)) fail('production_test_key_rejected');
  const entries = [
    ['core-seed', manifest.seed.archive, manifest.seed.bytes, manifest.seed.archiveSha256],
    ['vsix-bridge', manifest.vsix.file, manifest.vsix.bytes, manifest.vsix.sha256],
    ['desktop-launcher', manifest.desktop.launcher, manifest.desktop.launcherBytes, manifest.desktop.launcherSha256],
    ['desktop-installer', manifest.desktop.installer, manifest.desktop.installerBytes, manifest.desktop.installerSha256],
  ];
  const root = fs.realpathSync(path.dirname(absolute)), seen = new Set(), artifacts = [];
  for (const [role, file, bytes, sha256] of entries) {
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > 2 * 1024 ** 3 || !hash(sha256)) fail('artifact_metadata_invalid');
    const resolved = memberFile(root, file);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) fail('artifact_duplicate');
    seen.add(key);
    const actual = await digestFile(resolved, bytes);
    if (actual !== sha256) fail('artifact_hash_mismatch');
    artifacts.push({ role, file, bytes, sha256: actual });
  }
  return {
    environment,
    version: manifest.version,
    platform: manifest.platform,
    arch: manifest.arch,
    sourceHead: manifest.sourceHead,
    buildId: manifest.buildId,
    signingKeyId: manifest.seed.signingKeyId,
    descriptorHash: manifest.seed.descriptorSha256,
    artifacts,
  };
}

function windowsPath(value) {
  if (!text(value) || /[\u0000-\u001f]/.test(value)) fail('database_path_invalid');
  const normalized = value.replace(/\//g, '\\');
  // A current-drive root (\\data) and device namespaces are ambiguous evidence.
  const driveRooted = /^[A-Za-z]:\\/.test(normalized);
  const uncRooted = /^\\\\[^\\?.][^\\]*\\[^\\]+\\/.test(normalized);
  if ((!driveRooted && !uncRooted) || normalized.slice(driveRooted ? 2 : 0).includes(':')) fail('database_path_invalid');
  // Lexical comparison only; do not claim junction/symlink equivalence.
  return path.win32.normalize(normalized).toLowerCase();
}
function snapshot(input, environment, managed) {
  if (!object(input) || !object(input.health) || !port(input.port)) fail('snapshot_invalid');
  if (input.environment !== environment) fail('snapshot_environment_mismatch');
  // Release identity is checked separately. All channels now default to 7306;
  // observations remain read-only and do not authorize starting that port.
  const capturedAt = typeof input.capturedAt === 'string' ? Date.parse(input.capturedAt) : NaN;
  if (!Number.isFinite(capturedAt)) fail('snapshot_time_required');
  const h = input.health;
  if (h.ok !== true || !text(h.version) || !text(h.daemon_id) || !text(h.start_fingerprint)
    || !text(h.cloud_origin)) fail('snapshot_health_incomplete');
  windowsPath(h.db_path);
  try {
    const origin = new URL(h.cloud_origin);
    if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== h.cloud_origin) fail('cloud_origin_invalid');
  } catch { fail('cloud_origin_invalid'); }
  if (managed) {
    if (h.lifecycle_state !== 'managed' || h.core_environment !== environment
      || h.core_cloud_origin !== h.cloud_origin || !hash(h.descriptor_hash) || !hash(h.data_root_id)
      || !text(h.runtime_id) || !text(h.runtime_version) || !text(h.build_id) || !text(h.web_build_id)
      || !object(h.core_protocol) || !Number.isInteger(h.core_protocol.min) || !Number.isInteger(h.core_protocol.max)
      || h.core_protocol.min < 1 || h.core_protocol.max < h.core_protocol.min) fail('managed_identity_incomplete');
  } else if (h.lifecycle_state !== undefined || h.core_environment !== undefined || h.descriptor_hash !== undefined) {
    fail('legacy_baseline_required');
  }
  // Never echo arbitrary health fields, connection URLs, tokens or tickets.
  return { capturedAt: input.capturedAt, environment, port: input.port,
    version: h.version, daemonId: h.daemon_id, startFingerprint: h.start_fingerprint,
    dbPath: h.db_path, cloudOrigin: h.cloud_origin,
    ...(managed ? { runtimeId: h.runtime_id, runtimeVersion: h.runtime_version, buildId: h.build_id,
      coreProtocol: { min: h.core_protocol.min, max: h.core_protocol.max },
      descriptorHash: h.descriptor_hash, dataRootId: h.data_root_id, webBuildId: h.web_build_id } : {}),
    ...(revision(h.settings_revision) ? { settingsRevision: h.settings_revision } : {}),
    ...(revision(h.started_settings_revision) ? { startedSettingsRevision: h.started_settings_revision } : {}) };
}

export function compareObservations(input, candidate) {
  if (!object(input) || input.schemaVersion !== 1
    || !['reuse', 'restart', 'migration', 'apply-settings'].includes(input.scenario)) fail('scenario_invalid');
  const before = snapshot(input.before, candidate.environment, input.scenario !== 'migration');
  const after = snapshot(input.after, candidate.environment, true);
  if (Date.parse(after.capturedAt) <= Date.parse(before.capturedAt)) fail('snapshot_order_invalid');
  if (before.port !== after.port) fail('endpoint_changed');
  if (before.cloudOrigin !== after.cloudOrigin) fail('cloud_origin_changed');
  if (windowsPath(before.dbPath) !== windowsPath(after.dbPath)) fail('database_path_changed');
  if (after.descriptorHash !== candidate.descriptorHash || after.runtimeVersion !== candidate.version) fail('selected_core_not_candidate');
  if (input.scenario !== 'migration') {
    for (const key of ['runtimeId', 'runtimeVersion', 'buildId', 'descriptorHash', 'dataRootId', 'webBuildId']) {
      if (before[key] !== after[key]) fail('shared_core_identity_changed');
    }
    if (before.coreProtocol.min !== after.coreProtocol.min || before.coreProtocol.max !== after.coreProtocol.max) fail('shared_core_identity_changed');
  }
  if (input.scenario === 'reuse') {
    if (before.daemonId !== after.daemonId || before.startFingerprint !== after.startFingerprint) fail('daemon_replaced_during_reuse');
  } else if (before.daemonId === after.daemonId || before.startFingerprint === after.startFingerprint) {
    fail('new_daemon_not_proven');
  }
  if (input.scenario === 'apply-settings') {
    const expected = input.expectedSettingsRevision;
    if (!revision(expected) || before.settingsRevision !== expected || after.settingsRevision !== expected
      || after.startedSettingsRevision !== expected) fail('settings_application_not_proven');
  }
  return { scenario: input.scenario, before, after,
    dataPreservation: 'requires_manual_content_check',
    ...(input.scenario === 'migration' ? { legacyDataRootIdentity: 'unavailable_database_path_only' } : {}) };
}

export async function runPreflight({ manifestPath, environment, observationsPath }) {
  const candidate = await verifyCandidate(manifestPath, environment);
  const observations = observationsPath
    ? compareObservations(readJson(path.resolve(observationsPath), 64 * 1024), candidate) : null;
  return { schemaVersion: 1, ok: true, phase: 'preflight', ...candidate, observations,
    manualAcceptance: 'not_evaluated', signatureVerification: 'not_performed', sourceFreshness: 'not_verified',
    notes: ['Read-only: no process, daemon request, install, migration or Store mutation was performed.',
      'Hashes match the supplied manifest; trust/signature verification and manual acceptance remain separate.',
      'Snapshots are supplied observations, not proof of GUI behavior, absence of a second daemon, data contents or physical path identity.'] };
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const args = {};
    for (let index = 0; index < argv.length; index += 2) {
      const key = argv[index], value = argv[index + 1];
      if (!['--manifest', '--environment', '--observations'].includes(key) || key in args
        || !value || value.startsWith('--')) fail('arguments_invalid');
      args[key] = value;
    }
    if (!args['--manifest']) fail('manifest_required');
    const report = await runPreflight({ manifestPath: args['--manifest'], environment: args['--environment'], observationsPath: args['--observations'] });
    console.log(JSON.stringify(report, null, 2));
    return 0;
  } catch (error) {
    // No raw filesystem errors, argument contents or parser excerpts in logs.
    console.error(JSON.stringify({ ok: false, phase: 'preflight', code: error instanceof PreflightError ? error.code : 'input_unreadable', manualAcceptance: 'not_evaluated' }));
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
