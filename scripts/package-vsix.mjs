// Build one universal candidate. Never bump, install, publish, or bundle a tunnel binary.
import { execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { auditUniversalVsix } from './audit-universal-vsix.mjs';
import { parseBuildArgs, manifestForBuild } from '../packages/vscode/build-config.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EXT = path.join(ROOT, 'packages', 'vscode');
const require = createRequire(path.join(EXT, 'package.json'));
const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'package.json'), 'utf8'));
const version = manifest.version;
const rootVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const daemonVersion = /export const VERSION = '([^']+)'/.exec(fs.readFileSync(path.join(ROOT, 'src/version.ts'), 'utf8'))?.[1];
if (rootVersion !== version || daemonVersion !== version) throw new Error('Version drift: root, daemon and extension must match; no automatic bump.');
const { build, out: requestedOut } = parseBuildArgs(process.argv.slice(2), { packaging: true, requireEnvironment: true });
const suffix = build.environment === 'test' ? '-test' : '';
const out = requestedOut ? path.resolve(requestedOut) : path.join(EXT, `blackhole-vscode-${version}${suffix}.vsix`);
if (path.extname(out).toLowerCase() !== '.vsix') throw new Error('--out must name a .vsix file.');
// No ambient environment selection and no reuse of a previous flavor's build.
execSync('pnpm build', { cwd: ROOT, stdio: 'inherit' });
// Local Web page, copied beside the daemon bundle by esbuild.mjs.
execSync('pnpm --dir packages/web build', { cwd: ROOT, stdio: 'inherit' });
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
    const from = path.resolve(EXT, rel), to = path.resolve(contents, rel);
    if (!from.startsWith(EXT + path.sep) || !to.startsWith(contents + path.sep)) throw new Error('Invalid package member path.');
    fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to);
  }
  // Change only the staged manifest. A staging prepublish would silently rebuild as production.
  const stagedManifest = { ...manifestForBuild(manifest,build), displayName: build.environment === 'test' ? manifest.displayName + ' (Test)' : manifest.displayName,
    blackholeBuild: build };
  delete stagedManifest.scripts;
  fs.writeFileSync(path.join(contents, 'package.json'), JSON.stringify(stagedManifest, null, 2) + '\n');
  const vsce = path.join(path.dirname(require.resolve('@vscode/vsce/package.json')), 'vsce');
  const candidate = path.join(stage, 'candidate.vsix');
  execFileSync(process.execPath, [vsce, 'package', '--no-dependencies', '--no-rewrite-relative-links', '--out', candidate], { cwd: contents, stdio: 'inherit' });
  await auditUniversalVsix(candidate, build);
  // Keep an earlier deliverable intact until the new candidate has passed the audit.
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.copyFileSync(candidate, pending); fs.renameSync(pending, out);
  console.log(JSON.stringify(await auditUniversalVsix(out, build), null, 2));
} finally {
  fs.rmSync(pending, { force: true });
  fs.rmSync(stage, { recursive: true, force: true });
}
