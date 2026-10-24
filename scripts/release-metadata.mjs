// Generates platform/channel download metadata from a matched
// artifact-manifest.json. This prepares data only: it does not upload,
// deploy, or publish. Production channel metadata additionally requires a
// production signature manifest whose hashes match the artifacts.
//
//   node scripts/release-metadata.mjs --manifest <artifact-manifest.json> --channel <test|production> --base-url <url> --output <download-metadata.json> [--signatures <signatures.json>]
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((v, i, a) => v.startsWith('--') ? [v.slice(2), a[i + 1]] : null).filter(Boolean));
for (const key of ['manifest', 'channel', 'base-url', 'output']) if (!args[key]) throw new Error(`missing --${key}`);
if (!['test', 'production'].includes(args.channel)) throw new Error('channel_invalid');
const manifest = JSON.parse(fs.readFileSync(path.resolve(args.manifest), 'utf8'));
const base = args['base-url'].replace(/\/$/, '');
let signatureStatus = { signed: false, keyId: null };
if (args.signatures) {
  const recorded = JSON.parse(fs.readFileSync(path.resolve(args.signatures), 'utf8'));
  if (recorded.environment !== args.channel) throw new Error('signature_channel_mismatch');
  signatureStatus = { signed: true, keyId: recorded.keyId };
}
if (args.channel === 'production' && !signatureStatus.signed) throw new Error('production_metadata_requires_signatures');
if (args.channel === 'production' && manifest.environment !== 'production') throw new Error('production_metadata_requires_production_artifacts');
const entry = (id, file, sha256, bytes, kind) => ({ id, kind, platform: 'win32', arch: 'x64', channel: args.channel, version: manifest.version, file: path.basename(file), bytes, sha256, url: `${base}/${manifest.version}/${path.basename(file)}`, signed: signatureStatus.signed, signingKeyId: signatureStatus.keyId });
const metadata = {
  formatVersion: 1,
  generatedAt: new Date().toISOString(),
  sourceHead: manifest.sourceHead,
  version: manifest.version,
  channel: args.channel,
  artifacts: [
    ...(manifest.desktop.installer ? [entry('desktop-installer', manifest.desktop.installer, manifest.desktop.installerSha256, manifest.desktop.installerBytes, 'installer')] : []),
    entry('desktop-launcher', manifest.desktop.launcher, manifest.desktop.launcherSha256, manifest.desktop.launcherBytes, 'executable'),
    entry('vsix-bridge', manifest.vsix.file, manifest.vsix.sha256, manifest.vsix.bytes, 'vsix'),
    entry('core-seed', manifest.seed.archive, manifest.seed.archiveSha256, manifest.seed.bytes, 'core-archive'),
  ],
  notes: [
    'Metadata preparation only; publishing requires the release gates in RELEASE-GATES.md.',
    ...(args.channel === 'test' ? ['Test channel artifacts use the test signing root and must never be served as production downloads.'] : []),
  ],
};
fs.writeFileSync(path.resolve(args.output), JSON.stringify(metadata, null, 2) + '\n', { flag: 'w' });
console.log(JSON.stringify({ ok: true, output: path.resolve(args.output), channel: args.channel, artifacts: metadata.artifacts.length, signed: signatureStatus.signed }));
