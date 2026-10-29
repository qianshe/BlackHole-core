// Generates and validates matched artifact-manifest.json and platform/channel
// download-metadata.json. This prepares data only: it does not upload,
// deploy, or publish. Production channel metadata additionally requires a
// production signature manifest whose hashes, sizes and files match every
// artifact in artifact-manifest.json.
//
//   Write manifest:
//     node scripts/release-metadata.mjs --write-manifest <artifact-manifest.json> --artifacts-dir <dir> --environment <test|production> --version <semver> --source-head <40-hex> --build-id <id> --seed-archive <rel> --descriptor-sha256 <64-hex> --signing-key-id <id> --vsix-file <rel> [--vsix-core-package offline-code|bridge] --desktop-launcher <rel> --desktop-installer <rel>
//   Generate download metadata:
//     node scripts/release-metadata.mjs --manifest <artifact-manifest.json> --channel <test|production> --base-url <url> --output <download-metadata.json> [--signatures <signatures.json>] [--public-key <public.pem>]
import { createHash, createPublicKey, verify } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const isText = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 4096;
const isBytes = value => Number.isSafeInteger(value) && value > 0 && value <= 2 * 1024 ** 3;
const normalizeRel = value => String(value ?? '').replace(/\\/g, '/');

function fileDigest(rootDir, relative) {
  const rel = normalizeRel(relative);
  if (!isText(rel) || path.posix.isAbsolute(rel) || path.win32.isAbsolute(rel)
    || rel.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`artifact_path_invalid:${relative}`);
  }
  const full = path.join(path.resolve(rootDir), ...rel.split('/'));
  const stat = fs.lstatSync(full);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`artifact_file_required:${relative}`);
  const bytes = fs.readFileSync(full);
  return {
    file: rel,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

export function buildArtifactManifest({
  artifactsDir,
  environment,
  version,
  platform = 'win32',
  arch = 'x64',
  sourceHead,
  buildId,
  seedArchive,
  descriptorSha256,
  signingKeyId,
  vsixFile,
  vsixCorePackage = 'offline-code',
  desktopLauncher,
  desktopInstaller,
  date = new Date().toISOString().slice(0, 10),
}) {
  if (!['test', 'production'].includes(environment)) throw new Error('environment_invalid');
  if (!isText(version) || platform !== 'win32' || arch !== 'x64') throw new Error('manifest_identity_invalid');
  if (typeof sourceHead !== 'string' || !/^[a-f0-9]{40}$/.test(sourceHead)) throw new Error('manifest_source_head_invalid');
  if (!isText(buildId) || !isHash(descriptorSha256) || !isText(signingKeyId)) throw new Error('manifest_identity_invalid');
  if (environment === 'production' && /^test(?:[-_]|$)/i.test(signingKeyId)) throw new Error('production_test_key_rejected');
  if (!['offline-code', 'bridge'].includes(vsixCorePackage)) throw new Error('bridge_candidate_required');

  const seed = fileDigest(artifactsDir, seedArchive);
  const vsix = fileDigest(artifactsDir, vsixFile);
  const launcher = fileDigest(artifactsDir, desktopLauncher);
  const installer = fileDigest(artifactsDir, desktopInstaller);

  return {
    schemaVersion: 1,
    kind: environment === 'production' ? 'matched-release-artifacts' : 'matched-test-artifacts',
    date,
    environment,
    version,
    platform,
    arch,
    sourceHead,
    buildId,
    seed: {
      archive: seed.file,
      version,
      versionName: `${version}-${buildId}`,
      descriptorSha256,
      archiveSha256: seed.sha256,
      bytes: seed.bytes,
      signingKeyId,
    },
    vsix: {
      file: vsix.file,
      version,
      sha256: vsix.sha256,
      bytes: vsix.bytes,
      bridgeNotThin: true,
      corePackage: vsixCorePackage,
    },
    desktop: {
      launcher: launcher.file,
      launcherBytes: launcher.bytes,
      launcherSha256: launcher.sha256,
      installer: installer.file,
      installerBytes: installer.bytes,
      installerSha256: installer.sha256,
    },
  };
}

export function expectedManifestArtifacts(manifest) {
  if (!manifest || typeof manifest !== 'object' || !manifest.seed || !manifest.vsix || !manifest.desktop) {
    throw new Error('manifest_invalid');
  }
  if (!['test', 'production'].includes(manifest.environment) || !isText(manifest.version)
    || manifest.platform !== 'win32' || manifest.arch !== 'x64'
    || typeof manifest.sourceHead !== 'string' || !/^[a-f0-9]{40}$/.test(manifest.sourceHead)
    || !isText(manifest.buildId)
    || manifest.seed.version !== manifest.version || !isHash(manifest.seed.descriptorSha256) || !isText(manifest.seed.signingKeyId)
    || manifest.vsix.version !== manifest.version || manifest.vsix.bridgeNotThin !== true
    || !['offline-code', 'bridge'].includes(manifest.vsix.corePackage)) {
    throw new Error('manifest_identity_invalid');
  }
  if (manifest.environment === 'production' && /^test(?:[-_]|$)/i.test(manifest.seed.signingKeyId)) {
    throw new Error('production_test_key_rejected');
  }
  const items = [
    ...(manifest.desktop.installer
      ? [{ id: 'desktop-installer', sigIds: ['desktop-installer'], file: manifest.desktop.installer, sha256: manifest.desktop.installerSha256, bytes: manifest.desktop.installerBytes, kind: 'installer' }]
      : []),
    { id: 'desktop-launcher', sigIds: ['desktop-launcher'], file: manifest.desktop.launcher, sha256: manifest.desktop.launcherSha256, bytes: manifest.desktop.launcherBytes, kind: 'executable' },
    { id: 'vsix-bridge', sigIds: ['vsix', 'vsix-bridge'], file: manifest.vsix.file, sha256: manifest.vsix.sha256, bytes: manifest.vsix.bytes, kind: 'vsix' },
    { id: 'core-seed', sigIds: ['core-seed'], file: manifest.seed.archive, sha256: manifest.seed.archiveSha256, bytes: manifest.seed.bytes, kind: 'core-archive' },
  ];
  for (const item of items) {
    if (!isText(item.file) || !isHash(item.sha256) || !isBytes(item.bytes)) {
      throw new Error(`manifest_artifact_invalid:${item.id}`);
    }
  }
  return items;
}

export function verifySignatureManifest(manifest, recorded, { channel, publicKeyPem } = {}) {
  const required = expectedManifestArtifacts(manifest);
  if (!recorded || typeof recorded !== 'object') throw new Error('signature_manifest_invalid');
  if (recorded.formatVersion !== 1 || recorded.algorithm !== 'ed25519') throw new Error('signature_manifest_invalid');
  if (recorded.environment !== channel) throw new Error('signature_channel_mismatch');
  if (!isText(recorded.keyId)) throw new Error('signature_key_id_invalid');
  if (channel === 'production' && /^test(?:[-_]|$)/i.test(recorded.keyId)) throw new Error('production_rejects_test_key');
  if (recorded.version !== manifest.version) throw new Error('signature_version_mismatch');
  if (recorded.sourceHead !== manifest.sourceHead) throw new Error('signature_source_mismatch');
  if (!Array.isArray(recorded.signatures) || recorded.signatures.length !== required.length) {
    throw new Error('signature_records_incomplete');
  }
  const publicKey = publicKeyPem ? createPublicKey(publicKeyPem) : null;
  if (publicKey && publicKey.asymmetricKeyType !== 'ed25519') throw new Error('signature_public_key_invalid');
  const matchedByArtifact = new Map();
  const usedIndices = new Set();
  for (const item of required) {
    const index = recorded.signatures.findIndex((sig, idx) => !usedIndices.has(idx) && item.sigIds.includes(sig?.id));
    if (index < 0) throw new Error(`signature_missing:${item.id}`);
    usedIndices.add(index);
    const sig = recorded.signatures[index];
    const expectedFile = normalizeRel(item.file);
    if (normalizeRel(sig.file) !== expectedFile || sig.sha256 !== item.sha256 || sig.bytes !== item.bytes) {
      throw new Error(`signature_hash_mismatch:${item.id}`);
    }
    if (typeof sig.signature !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(sig.signature.trim())) {
      throw new Error(`signature_invalid:${item.id}`);
    }
    const rawSig = Buffer.from(sig.signature.trim(), 'base64');
    if (rawSig.length !== 64) throw new Error(`signature_invalid:${item.id}`);
    if (publicKey) {
      const payload = Buffer.from(`${sig.sha256}\n${expectedFile}\n`, 'utf8');
      if (!verify(null, payload, publicKey, rawSig)) throw new Error(`signature_invalid:${item.id}`);
    }
    matchedByArtifact.set(item.id, sig.signature.trim());
  }
  return { signed: true, keyId: recorded.keyId, signaturesByArtifact: matchedByArtifact };
}

export function buildReleaseMetadata({ manifest, channel, baseUrl, signatures, publicKeyPem }) {
  if (!['test', 'production'].includes(channel)) throw new Error('channel_invalid');
  if (channel === 'production' && manifest?.environment !== 'production') {
    throw new Error('production_metadata_requires_production_artifacts');
  }
  const items = expectedManifestArtifacts(manifest);
  const base = String(baseUrl ?? '').replace(/\/$/, '');
  if (!base) throw new Error('missing --base-url');
  let signatureStatus = { signed: false, keyId: null, signaturesByArtifact: new Map() };
  if (signatures) {
    signatureStatus = verifySignatureManifest(manifest, signatures, { channel, publicKeyPem });
  }
  if (channel === 'production' && !signatureStatus.signed) {
    throw new Error('production_metadata_requires_signatures');
  }
  const entry = item => ({
    id: item.id,
    kind: item.kind,
    platform: manifest.platform,
    arch: manifest.arch,
    channel,
    version: manifest.version,
    buildId: manifest.buildId,
    file: path.posix.basename(normalizeRel(item.file)),
    bytes: item.bytes,
    sha256: item.sha256,
    url: `${base}/${manifest.version}/${path.posix.basename(normalizeRel(item.file))}`,
    signed: signatureStatus.signed,
    signingKeyId: signatureStatus.keyId,
    ...(signatureStatus.signed ? { signature: signatureStatus.signaturesByArtifact.get(item.id) } : {}),
  });
  return {
    formatVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceHead: manifest.sourceHead,
    version: manifest.version,
    buildId: manifest.buildId,
    platform: manifest.platform,
    arch: manifest.arch,
    channel,
    descriptorSha256: manifest.seed.descriptorSha256,
    artifacts: items.map(entry),
    notes: [
      'Metadata preparation only; publishing requires the release gates in RELEASE-GATES.md.',
      ...(channel === 'test' ? ['Test channel artifacts use the test signing root and must never be served as production downloads.'] : []),
    ],
  };
}

export function main(argv = process.argv.slice(2)) {
  const args = Object.fromEntries(argv.map((v, i, a) => v.startsWith('--') ? [v.slice(2), a[i + 1]] : null).filter(Boolean));
  if (args['write-manifest']) {
    for (const key of ['artifacts-dir', 'environment', 'version', 'source-head', 'build-id', 'seed-archive', 'descriptor-sha256', 'signing-key-id', 'vsix-file', 'desktop-launcher', 'desktop-installer']) {
      if (!args[key]) throw new Error(`missing --${key}`);
    }
    const manifest = buildArtifactManifest({
      artifactsDir: args['artifacts-dir'],
      environment: args.environment,
      version: args.version,
      platform: args.platform ?? 'win32',
      arch: args.arch ?? 'x64',
      sourceHead: args['source-head'],
      buildId: args['build-id'],
      seedArchive: args['seed-archive'],
      descriptorSha256: args['descriptor-sha256'],
      signingKeyId: args['signing-key-id'],
      vsixFile: args['vsix-file'],
      vsixCorePackage: args['vsix-core-package'] ?? 'offline-code',
      desktopLauncher: args['desktop-launcher'],
      desktopInstaller: args['desktop-installer'],
    });
    const outPath = path.resolve(args['write-manifest']);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'w' });
    console.log(JSON.stringify({ ok: true, manifest: outPath, version: manifest.version, buildId: manifest.buildId, environment: manifest.environment }));
    return 0;
  }
  for (const key of ['manifest', 'channel', 'base-url', 'output']) if (!args[key]) throw new Error(`missing --${key}`);
  const manifest = JSON.parse(fs.readFileSync(path.resolve(args.manifest), 'utf8'));
  const signatures = args.signatures ? JSON.parse(fs.readFileSync(path.resolve(args.signatures), 'utf8')) : undefined;
  const publicKeyPem = args['public-key'] ? fs.readFileSync(path.resolve(args['public-key']), 'utf8') : undefined;
  const metadata = buildReleaseMetadata({
    manifest,
    channel: args.channel,
    baseUrl: args['base-url'],
    signatures,
    publicKeyPem,
  });
  fs.writeFileSync(path.resolve(args.output), JSON.stringify(metadata, null, 2) + '\n', { flag: 'w' });
  console.log(JSON.stringify({ ok: true, output: path.resolve(args.output), channel: args.channel, artifacts: metadata.artifacts.length, signed: metadata.artifacts[0]?.signed ?? false }));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
