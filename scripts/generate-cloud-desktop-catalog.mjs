// Generates and verifies BlackHole-cloud's desktop-release-catalog.ts from
// signed per-platform update-feed outputs (latest.json + latest.json.sig).
// Enforces the exact same Ed25519 signature, schema and GitHub Release URL
// rules as BlackHole-cloud/packages/cloud-api/src/desktop-downloads.ts.
//
// Usage:
//   node scripts/generate-cloud-desktop-catalog.mjs --feeds-dir <dir> --public-key <public.pem> --key-id <id> [--channel stable|preview] --output <desktop-release-catalog.ts>
import { createPublicKey, verify } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const semver = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
const identity = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const expectedFields = [
  'schemaVersion', 'environment', 'platform', 'arch',
  'version', 'buildId', 'coreVersion', 'coreBuildId',
  'installerUrl', 'installerSha256', 'installerBytes',
].sort().join(',');

export function extractRawEd25519PublicKeyBase64(publicKeyPem) {
  const key = createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('catalog_public_key_not_ed25519');
  const der = key.export({ format: 'der', type: 'spki' });
  const prefix = Buffer.from('302a300506032b6570032100', 'hex');
  if (!der.subarray(0, prefix.length).equals(prefix) || der.length !== prefix.length + 32) {
    throw new Error('catalog_public_key_invalid_spki');
  }
  return der.subarray(prefix.length).toString('base64');
}

export function verifyCatalogFeedEntry(manifestJson, signatureText, publicKeyPem) {
  const key = createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('catalog_public_key_not_ed25519');
  const sigTrimmed = String(signatureText ?? '').trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(sigTrimmed)) throw new Error('catalog_signature_encoding_invalid');
  const sigBytes = Buffer.from(sigTrimmed, 'base64');
  if (sigBytes.length !== 64) throw new Error('catalog_signature_length_invalid');
  if (!verify(null, Buffer.from(manifestJson, 'utf8'), key, sigBytes)) {
    throw new Error('catalog_signature_verification_failed');
  }
  const value = JSON.parse(manifestJson);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== expectedFields
    || value.schemaVersion !== 1
    || value.environment !== 'production'
    || !['windows', 'macos', 'linux'].includes(value.platform)
    || !['x64', 'arm64'].includes(value.arch)
    || !semver.test(value.version)
    || !semver.test(value.coreVersion)
    || !identity.test(value.buildId)
    || !identity.test(value.coreBuildId)
    || !/^[a-f0-9]{64}$/.test(value.installerSha256)
    || !Number.isSafeInteger(value.installerBytes)
    || value.installerBytes < 1024 * 1024
    || value.installerBytes > 1024 ** 3) {
    throw new Error('catalog_manifest_schema_invalid');
  }
  const url = new URL(value.installerUrl);
  if (url.href !== value.installerUrl) throw new Error('catalog_installer_url_normalized_mismatch');
  const prefix = `/qianshe/BlackHole-core/releases/download/v${value.version}/`;
  const filename = url.pathname.slice(prefix.length);
  const ext = value.platform === 'windows' ? /\.exe$/ : value.platform === 'macos' ? /\.(dmg|zip)$/ : /\.(AppImage|deb|rpm)$/;
  if (url.origin !== 'https://github.com' || url.username || url.password || url.search || url.hash
    || !url.pathname.startsWith(prefix) || !/^BlackHole-[A-Za-z0-9._-]+$/.test(filename)
    || !ext.test(filename) || /unsigned|test|candidate/i.test(filename)) {
    throw new Error(`catalog_installer_url_rejected:${value.installerUrl}`);
  }
  return { manifest: value, manifestJson, signature: sigTrimmed };
}

export function renderDesktopReleaseCatalog({ keyId, publicKeyPem, channel = 'stable', feeds }) {
  if (!identity.test(keyId) || /^test(?:[-_]|$)/i.test(keyId)) throw new Error('catalog_key_id_invalid');
  if (!['stable', 'preview'].includes(channel)) throw new Error('catalog_channel_invalid');
  if (!Array.isArray(feeds) || feeds.length === 0 || feeds.length > 16) throw new Error('catalog_feeds_required');
  const pubBase64 = extractRawEd25519PublicKeyBase64(publicKeyPem);
  const seenTargets = new Set();
  let version = null;
  const verifiedEntries = feeds.map(({ manifestJson, signature }) => {
    const verified = verifyCatalogFeedEntry(manifestJson, signature, publicKeyPem);
    const target = `${verified.manifest.platform}-${verified.manifest.arch}`;
    if (seenTargets.has(target)) throw new Error(`catalog_duplicate_platform_target:${target}`);
    seenTargets.add(target);
    if (version === null) version = verified.manifest.version;
    else if (verified.manifest.version !== version) throw new Error('catalog_version_mismatch');
    return {
      keyId,
      channel,
      status: 'published',
      manifestJson: verified.manifestJson,
      signature: verified.signature,
      target,
    };
  });
  verifiedEntries.sort((a, b) => a.target.localeCompare(b.target));
  const catalogItems = verifiedEntries.map(({ target: _target, ...entry }) => `  ${JSON.stringify(entry, null, 2).replace(/\n/g, '\n  ')}`).join(',\n');
  const source = [
    '// Production publishing inputs, generated from verified signed release feeds.',
    '// Keys are pinned separately: a catalog entry cannot supply its own trust root.',
    'export type DesktopCatalogEntry = {',
    '  keyId: string;',
    "  channel: 'stable' | 'preview';",
    "  status: 'published' | 'withdrawn';",
    '  manifestJson: string;',
    '  signature: string;',
    '};',
    `export const desktopReleaseKeys: Readonly<Record<string, string>> = Object.freeze(${JSON.stringify({ [keyId]: pubBase64 }, null, 2)});`,
    'export const desktopReleaseCatalog: readonly DesktopCatalogEntry[] = Object.freeze([',
    catalogItems,
    ']);',
    '',
  ].join('\n');
  return { source, version, targets: [...seenTargets].sort(), publicKeyBase64: pubBase64, entries: verifiedEntries.length,
    catalog: verifiedEntries.map(({target: _target,...entry})=>entry) };
}

/** Public, data-only index. Cloud pins its own key and verifies every exact
 * manifest; neither JavaScript nor trust roots are downloaded from a Release. */
export function renderDesktopReleaseIndex(options) {
  if (options.channel && options.channel !== 'stable') throw Error('release_index_stable_only');
  const rendered = renderDesktopReleaseCatalog({...options,channel:'stable'});
  const expected = ['linux-arm64','linux-x64','macos-arm64','macos-x64','windows-x64'];
  if (rendered.targets.join(',') !== expected.join(',')) throw Error('release_index_requires_five_targets');
  return JSON.stringify({schemaVersion:1,version:rendered.version,entries:rendered.catalog},null,2)+'\n';
}

export function collectFeedsFromDirectory(feedsDir) {
  const root = path.resolve(feedsDir);
  const feeds = [];
  const directJson = path.join(root, 'latest.json');
  const directSig = path.join(root, 'latest.json.sig');
  if (fs.existsSync(directJson) && fs.existsSync(directSig)) {
    feeds.push({
      manifestJson: fs.readFileSync(directJson, 'utf8'),
      signature: fs.readFileSync(directSig, 'utf8'),
    });
    return feeds;
  }
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const jsonFile = path.join(root, entry.name, 'latest.json');
    const sigFile = path.join(root, entry.name, 'latest.json.sig');
    if (fs.existsSync(jsonFile) && fs.existsSync(sigFile)) {
      feeds.push({
        manifestJson: fs.readFileSync(jsonFile, 'utf8'),
        signature: fs.readFileSync(sigFile, 'utf8'),
      });
    }
  }
  return feeds;
}

export function main(argv = process.argv.slice(2)) {
  const { values: a } = parseArgs({
    args: argv,
    options: {
      'feeds-dir': { type: 'string' },
      'public-key': { type: 'string' },
      'key-id': { type: 'string' },
      channel: { type: 'string' },
      output: { type: 'string' },
      'index-output': { type: 'string' },
    },
  });
  for (const field of ['feeds-dir', 'public-key', 'key-id', 'output']) {
    if (!a[field]) throw new Error(`catalog_argument_required:${field}`);
  }
  const feeds = collectFeedsFromDirectory(a['feeds-dir']);
  const publicKeyPem = fs.readFileSync(path.resolve(a['public-key']), 'utf8');
  const rendered = renderDesktopReleaseCatalog({
    keyId: a['key-id'],
    publicKeyPem,
    channel: a.channel ?? 'stable',
    feeds,
  });
  if (a['index-output']) {
    const pins = JSON.parse(fs.readFileSync(new URL('../release/production-public-keys.json',import.meta.url),'utf8'));
    if(a['key-id'] !== pins.updateKeyId || rendered.publicKeyBase64 !== extractRawEd25519PublicKeyBase64(pins.updatePublicKey)) throw Error('release_index_production_key_mismatch');
    const index = renderDesktopReleaseIndex({keyId:a['key-id'],publicKeyPem,channel:a.channel??'stable',feeds});
    const indexPath = path.resolve(a['index-output']);fs.mkdirSync(path.dirname(indexPath),{recursive:true});fs.writeFileSync(indexPath,index,'utf8');
  }
  const outPath = path.resolve(a.output);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, rendered.source, { encoding: 'utf8' });
  console.log(JSON.stringify({
    ok: true,
    output: outPath,
    version: rendered.version,
    targets: rendered.targets,
    entries: rendered.entries,
    keyId: a['key-id'],
  }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
