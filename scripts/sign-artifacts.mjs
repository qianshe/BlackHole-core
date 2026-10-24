// Signing interface for release artifacts. This tool only provides the
// interface and local verification; production keys stay with the Signing
// Owner and are never stored in the repo, CI artifacts, or this script's
// output. It signs artifact hashes from an artifact-manifest.json with a
// detached Ed25519 signature per file and writes a signature manifest.
//
//   Sign:   node scripts/sign-artifacts.mjs sign --manifest <artifact-manifest.json> --artifacts-dir <dir> --private-key <pem> --key-id <id> --environment <test|production> --output <signatures.json> [--confirm-production-signing]
//   Verify: node scripts/sign-artifacts.mjs verify --manifest <artifact-manifest.json> --artifacts-dir <dir> --signatures <signatures.json> --public-key <pem>
//
// Guards: production rejects test key ids and requires the explicit
// confirmation flag; the private key is read only from the given path and
// never copied or logged.
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [command, ...rest] = process.argv.slice(2);
const args = Object.fromEntries(rest.map((v, i, a) => v.startsWith('--') ? [v.slice(2), a[i + 1]] : null).filter(Boolean));
for (const key of ['manifest', 'artifacts-dir', 'output']) if (command === 'sign' && !args[key]) throw new Error(`missing --${key}`);
if (!['sign', 'verify'].includes(command ?? '')) throw new Error('usage: sign|verify');
const manifest = JSON.parse(fs.readFileSync(path.resolve(args.manifest), 'utf8'));
const artifactsDir = path.resolve(args['artifacts-dir']);
function artifactFiles() {
  const entries = [];
  const add = (id, relative) => { const file = path.join(artifactsDir, relative); if (!fs.existsSync(file)) throw new Error(`artifact_missing:${relative}`); const bytes = fs.readFileSync(file); entries.push({ id, file: relative.split(path.sep).join('/'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), data: bytes }); };
  add('core-seed', manifest.seed.archive);
  add('vsix', manifest.vsix.file);
  // The installer is optional in preparation manifests (e.g. CI candidates
  // that do not compile Inno); every other entry is mandatory.
  if (manifest.desktop.installer && fs.existsSync(path.join(artifactsDir, manifest.desktop.installer))) add('desktop-installer', manifest.desktop.installer);
  add('desktop-launcher', manifest.desktop.launcher);
  return entries;
}
if (command === 'sign') {
  if (!args['private-key'] || !args['key-id'] || !args.environment) throw new Error('missing signing arguments');
  if (!['test', 'production'].includes(args.environment)) throw new Error('environment_invalid');
  if (args.environment === 'production') {
    if (/^test(?:[-_]|$)/i.test(args['key-id'])) throw new Error('production_rejects_test_key');
    if (!('confirm-production-signing' in args)) throw new Error('production_signing_requires_explicit_confirmation');
  }
  const key = createPrivateKey(fs.readFileSync(path.resolve(args['private-key'])));
  const signedAt = new Date().toISOString();
  const signatures = artifactFiles().map(({ data, ...entry }) => ({ ...entry, signature: sign(null, Buffer.from(`${entry.sha256}\n${entry.file}\n`, 'utf8'), key).toString('base64') }));
  const out = { formatVersion: 1, algorithm: 'ed25519', keyId: args['key-id'], environment: args.environment, signedAt, sourceHead: manifest.sourceHead, version: manifest.version, signatures };
  fs.writeFileSync(path.resolve(args.output), JSON.stringify(out, null, 2) + '\n', { flag: 'w' });
  console.log(JSON.stringify({ ok: true, output: path.resolve(args.output), keyId: args['key-id'], environment: args.environment, signed: signatures.length }));
} else {
  if (!args.signatures || !args['public-key']) throw new Error('missing verify arguments');
  const recorded = JSON.parse(fs.readFileSync(path.resolve(args.signatures), 'utf8'));
  if (recorded.algorithm !== 'ed25519' || recorded.version !== manifest.version) throw new Error('signature_manifest_mismatch');
  const key = createPublicKey(fs.readFileSync(path.resolve(args['public-key'])));
  const current = new Map(artifactFiles().map((entry) => [entry.id, entry]));
  for (const entry of recorded.signatures) {
    const now = current.get(entry.id);
    if (!now || now.sha256 !== entry.sha256 || now.file !== entry.file) throw new Error(`signature_hash_mismatch:${entry.id}`);
    if (!verify(null, Buffer.from(`${entry.sha256}\n${entry.file}\n`, 'utf8'), key, Buffer.from(entry.signature, 'base64'))) throw new Error(`signature_invalid:${entry.id}`);
  }
  console.log(JSON.stringify({ ok: true, keyId: recorded.keyId, environment: recorded.environment, verified: recorded.signatures.length }));
}
