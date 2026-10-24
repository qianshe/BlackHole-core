// Build one universal candidate. Never bump, install, publish, or bundle a tunnel binary.
import { execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { auditUniversalVsix } from './audit-universal-vsix.mjs';
import { verifyCoreArchive } from './core-runtime-lib.mjs';
import { parseBuildArgs, manifestForBuild, assertBundledCoreVersion } from '../packages/vscode/build-config.mjs';
import { hostCoreInputs, hostExtensionFile, stageHostCore } from './vsix-host-layout.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EXT = path.join(ROOT, 'packages', 'vscode');
const require = createRequire(path.join(EXT, 'package.json'));
const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'package.json'), 'utf8'));
const version = manifest.version;
const rootVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const daemonVersion = /export const VERSION = '([^']+)'/.exec(fs.readFileSync(path.join(ROOT, 'src/version.ts'), 'utf8'))?.[1];
// Core and extension have independent release lines. Only the source Core's
// package/daemon version must match; the VSIX version may advance on its own.
if (rootVersion !== daemonVersion) throw new Error('Core package and daemon source version drift; no automatic bump.');
const { build, out: requestedOut, corePackage, coreUrl } = parseBuildArgs(process.argv.slice(2), { packaging: true, requireEnvironment: true });
const hostProvided = corePackage !== 'legacy-test';
const suffix = build.environment === 'test' ? '-test' : '';
const seedArchive = process.env.BH_SEED_CORE_ARCHIVE?.trim() ? path.resolve(process.env.BH_SEED_CORE_ARCHIVE.trim()) : undefined;
let seedEvidence;
if (seedArchive) {
  const publicKeyPath = process.env.BH_SEED_CORE_PUBLIC_KEY?.trim();
  const keyId = process.env.BH_SEED_CORE_KEY_ID?.trim();
  if (!publicKeyPath || !keyId) throw new Error('Seed packaging requires BH_SEED_CORE_PUBLIC_KEY and BH_SEED_CORE_KEY_ID.');
  seedEvidence = await verifyCoreArchive(seedArchive, { publicKeys: { [keyId]: fs.readFileSync(path.resolve(publicKeyPath)) }, platform: 'win32', arch: 'x64', environment: build.environment });
}
// Full offline releases must bundle the exact Core runtime version printed on
// the VSIX. A host-only patch that carries older Core must use an explicit
// distribution policy instead of silently producing mismatched Test/Release bytes.
assertBundledCoreVersion(corePackage, version, seedEvidence?.descriptor.runtimeVersion);
const priorTestKey = process.env.BH_PRIOR_TEST_CORE_PUBLIC_KEY?.trim();
const priorTestId = process.env.BH_PRIOR_TEST_CORE_KEY_ID?.trim();
if ((priorTestKey || priorTestId) && (build.environment !== 'test' || !priorTestKey || !priorTestId))
  throw Error('previous_test_trust_invalid');
const priorRootsText = process.env.BH_PRIOR_TEST_CORE_PUBLIC_KEYS_JSON;
let priorRoots = priorTestKey ? [{ keyId: priorTestId, publicKey: fs.readFileSync(path.resolve(priorTestKey),'utf8') }] : [];
if (priorRootsText) {
  if (build.environment !== 'test' || priorRootsText.length > 32768 || priorRoots.length) throw Error('previous_test_trust_invalid');
  priorRoots = JSON.parse(priorRootsText);
  if (!Array.isArray(priorRoots)) throw Error('previous_test_trust_invalid');
}
const hostInput = hostProvided ? await hostCoreInputs(seedArchive,
  process.env.BH_SEED_CORE_PUBLIC_KEY?.trim() ? fs.readFileSync(path.resolve(process.env.BH_SEED_CORE_PUBLIC_KEY.trim()),'utf8') : undefined,
  process.env.BH_SEED_CORE_KEY_ID?.trim(), build, corePackage, coreUrl, priorRoots) : undefined;
const out = requestedOut ? path.resolve(requestedOut) : path.join(EXT, `blackhole-vscode-${version}${suffix}.vsix`);
if (path.extname(out).toLowerCase() !== '.vsix') throw new Error('--out must name a .vsix file.');
// Never rebuild the version VS Code already has installed (2026-10-02 incident): reinstalling the same version over the
// running extension made VS Code delete the in-use folder and leave a broken, half-extracted install. Alternate versions.
{
  const id = `${manifest.publisher}.${manifest.name}`.toLowerCase();
  const home = process.env.USERPROFILE || process.env.HOME || '';
  for (const dir of ['.vscode', '.vscode-insiders']) {
    let list = [];
    try { list = JSON.parse(fs.readFileSync(path.join(home, dir, 'extensions', 'extensions.json'), 'utf8')); } catch { continue; }
    const installed = Array.isArray(list) ? list.find(e => String(e?.identifier?.id).toLowerCase() === id)?.version : undefined;
    if (installed === version && process.env.BH_ALLOW_INSTALLED_VERSION !== '1') {
      console.error(`package-vsix: ${id} ${version} is already installed in ~/${dir}. Bump the version first (installing the same version over a running extension breaks it). Override: BH_ALLOW_INSTALLED_VERSION=1.`);
      process.exit(2);
    }
  }
}
// No ambient environment selection and no reuse of a previous flavor's build.
execSync('pnpm build', { cwd: ROOT, stdio: 'inherit' });
// Local Web page, copied beside the daemon bundle by esbuild.mjs.
execSync('pnpm --dir packages/web build', { cwd: ROOT, stdio: 'inherit' });
execFileSync(process.execPath, [path.join(ROOT, 'packages', 'host-runtime', 'build.mjs'), '--environment', build.environment], { cwd: ROOT, stdio: 'inherit' });
const buildArgs = ['esbuild.mjs', '--environment', build.environment];
if (build.environment === 'test') buildArgs.push('--cloud-origin', build.origin, '--cloud-public-key', build.entitlementPublicKey);
execFileSync(process.execPath, buildArgs, { cwd: EXT, stdio: 'inherit' });
for (const script of ['check-webview.mjs', 'proxy-sync-unit.mjs']) {
  // production minifies extension.js; check-webview reads the unminified twin esbuild.mjs writes (plan 6.14 O1)
  const extra = script === 'check-webview.mjs' && build.environment === 'production' ? [path.join(ROOT, '.tmp', 'webview-check', 'extension.js')] : [];
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', script), ...extra], { cwd: ROOT, stdio: 'inherit' });
}
const { listFiles, PackageManager } = require('@vscode/vsce');
const files = await listFiles({ cwd: EXT, packageManager: PackageManager.None });
const cache = path.join(ROOT, '.cache'); fs.mkdirSync(cache, { recursive: true });
const stage = fs.mkdtempSync(path.join(cache, 'vsix-flavor-'));

const contents = path.join(stage, 'extension');
const pending = out + '.' + randomUUID() + '.tmp';
try {
  fs.mkdirSync(contents);
  for (const rel of files) {
    if (hostProvided && !hostExtensionFile(rel)) continue;
    const from = path.resolve(EXT, rel), to = path.resolve(contents, rel);
    if (!from.startsWith(EXT + path.sep) || !to.startsWith(contents + path.sep)) throw new Error('Invalid package member path.');
    fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to);
  }
  const managerDir = path.join(contents, 'dist', 'manager'); fs.mkdirSync(managerDir, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'packages', 'host-runtime', 'dist', 'core-manager-cli.mjs'), path.join(managerDir, 'core-manager-cli.mjs'));
  if (!hostProvided && seedArchive && seedEvidence) {
    const seedDir = path.join(contents, 'dist', 'seed-core'); fs.mkdirSync(seedDir, { recursive: true });
    fs.copyFileSync(seedArchive, path.join(seedDir, 'core-win32-x64.zip'));
    fs.writeFileSync(path.join(seedDir, 'seed-core.json'), JSON.stringify({ formatVersion: 1, platform: 'win32', arch: 'x64', archiveSha256: seedEvidence.archiveHash, descriptorSha256: seedEvidence.descriptorHash, runtimeId: seedEvidence.descriptor.runtimeId, runtimeVersion: seedEvidence.descriptor.runtimeVersion, buildId: seedEvidence.descriptor.buildId, signingKeyId: seedEvidence.descriptor.signingKeyId }, null, 2) + '\n');
    fs.writeFileSync(path.join(seedDir, 'trust.json'), JSON.stringify({ schemaVersion: 1, environment: build.environment, publicKeys: { [seedEvidence.descriptor.signingKeyId]: fs.readFileSync(path.resolve(process.env.BH_SEED_CORE_PUBLIC_KEY.trim()), 'utf8') } }, null, 2) + '\n');
  }
  // Change only the staged manifest. A staging prepublish would silently rebuild as production.
  const stagedManifest = { ...manifestForBuild(manifest,build), displayName: build.environment === 'test' ? manifest.displayName + ' (Test)' : manifest.displayName,
    blackholeBuild: build };
  if (hostInput) {
    stagedManifest.blackholeSharedCore = stageHostCore(contents, path.join(ROOT,'packages/host-runtime/dist/core-manager-cli.mjs'), hostInput);
    delete stagedManifest.contributes.configuration.properties['blackhole.daemonEntry'];
    stagedManifest.files = ['dist/**','media/**','licenses/**','LICENSE','NOTICE','README.md','CHANGELOG.md','SUPPORT.md','THIRD_PARTY_LICENSES.md','THIRD_PARTY_NOTICES.md'];
  } else if(seedEvidence) stagedManifest.blackholeSharedCore = { mode: 'bridge', platform: 'win32', arch: 'x64', seedDescriptorHash: seedEvidence.descriptorHash };
  else delete stagedManifest.blackholeSharedCore;
  delete stagedManifest.scripts;
  fs.writeFileSync(path.join(contents, 'package.json'), JSON.stringify(stagedManifest, null, 2) + '\n');
  const vsce = path.join(path.dirname(require.resolve('@vscode/vsce/package.json')), 'vsce');
  const candidate = path.join(stage, 'candidate.vsix');
  execFileSync(process.execPath, [vsce, 'package', '--no-dependencies', '--no-rewrite-relative-links', ...(hostInput?['--target',hostInput.reference.platform+'-'+hostInput.reference.arch]:[]), '--out', candidate], { cwd: contents, stdio: 'inherit' });
  await auditUniversalVsix(candidate, build);
  // Keep an earlier deliverable intact until the new candidate has passed the audit.
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.copyFileSync(candidate, pending); fs.renameSync(pending, out);
  console.log(JSON.stringify(await auditUniversalVsix(out, build), null, 2));
} finally {
  fs.rmSync(pending, { force: true });
  fs.rmSync(stage, { recursive: true, force: true });
}
