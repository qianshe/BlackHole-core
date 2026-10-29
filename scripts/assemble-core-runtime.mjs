import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyCoreBundleFreshness } from './core-runtime-freshness.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const value = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const output = value('output');
const nodeExe = value('node-exe');
const nodeLicense = value('node-license');
const hostProvided = argv.includes('--without-node');
// The signed Core descriptor is platform-bound; the default keeps the
// established Windows candidate behavior. Cross-platform CI passes the
// runner's native pair so handoff and layout metadata match the descriptor.
const platform = value('platform') ?? 'win32';
const arch = value('arch') ?? 'x64';
const goosMap = { win32: 'windows', darwin: 'darwin', linux: 'linux' };
const goarchMap = { x64: 'amd64', arm64: 'arm64' };
if (!goosMap[platform] || !goarchMap[arch]) throw new Error(`unsupported platform/arch: ${platform}/${arch}`);
if (!output || (!hostProvided && (!nodeExe || !nodeLicense)) || (hostProvided && (nodeExe || nodeLicense))) throw new Error('usage: --output DIR [--without-node | --node-exe FILE --node-license FILE] [--platform win32|darwin|linux] [--arch x64|arm64]');
const destination = path.resolve(output);
if (fs.existsSync(destination)) throw new Error(`output_already_exists:${destination}`);
if (!hostProvided) for (const [label, file] of [['node executable', nodeExe], ['Node license', nodeLicense]]) if (!fs.statSync(path.resolve(file)).isFile()) throw new Error(`${label}_missing:${file}`);

const vscodeDist = path.join(ROOT, 'packages', 'vscode', 'dist');
const daemonDist = path.join(vscodeDist, 'daemon');
const hostDist = path.join(ROOT, 'packages', 'host-runtime', 'dist');
const required = [
  path.join(daemonDist, 'cli.js'), path.join(daemonDist, 'process-supervisor.cjs'),
  path.join(daemonDist, 'web', 'index.html'), path.join(hostDist, 'bootstrap.cjs'), path.join(hostDist, 'core-manager-cli.mjs'),
  path.join(vscodeDist, 'workspace'), path.join(vscodeDist, 'win32'), path.join(vscodeDist, 'node_modules'),
];
for (const file of required) if (!fs.existsSync(file)) throw new Error(`build_output_missing:${path.relative(ROOT, file)}`);
// Existence and a new signed buildId cannot establish freshness. In particular,
// an old dist/daemon/web must not replace the Web build just tested by the user.
const buildInputs = verifyCoreBundleFreshness(ROOT);

const copyFile = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); };
const copyTree = (from, to) => fs.cpSync(from, to, { recursive: true, force: false, errorOnExist: true });
fs.mkdirSync(destination, { recursive: false });
// The Windows handoff executable is a member of the signed candidate Core.
// It is only meaningful on Windows: the legacy handoff path refuses other
// platforms before touching the helper, so non-Windows archives omit it.
// Never fetch an external helper or reuse one from an unverified location.
if (platform === 'win32') {
  const handoff = path.join(destination, 'host', 'core-handoff.exe');
  fs.mkdirSync(path.dirname(handoff), { recursive: true });
  execFileSync('go', ['-C', path.join(ROOT, 'packages', 'desktop-launcher'), 'build', '-trimpath', '-ldflags=-s -w', '-o', handoff, './cmd/core-handoff'], {
    cwd: ROOT, windowsHide: true, timeout: 120_000, stdio: 'pipe',
    env: { ...process.env, GOOS: goosMap[platform], GOARCH: goarchMap[arch], CGO_ENABLED: '0' },
  });
}
if (!hostProvided) {
  copyFile(path.resolve(nodeExe), path.join(destination, 'node', 'node.exe'));
  copyFile(path.resolve(nodeLicense), path.join(destination, 'licenses', 'node-LICENSE'));
}
for (const name of ['cli.js', 'process-supervisor.cjs', 'bh.py', 'LICENSE-MIT', 'semantic-NOTICE.md']) {
  const source = path.join(daemonDist, name); if (fs.existsSync(source)) copyFile(source, path.join(destination, 'daemon', name));
}
copyTree(path.join(daemonDist, 'web'), path.join(destination, 'web'));
copyFile(path.join(hostDist, 'bootstrap.cjs'), path.join(destination, 'host', 'bootstrap.cjs'));
copyFile(path.join(hostDist, 'core-manager-cli.mjs'), path.join(destination, 'host', 'core-manager-cli.mjs'));
copyFile(path.join(hostDist, 'cloud-build.json'), path.join(destination, 'host', 'cloud-build.json'));
// Preserve the VSIX bundle-relative layout used by dynamic requires in daemon/cli.js.
for (const name of ['workspace', 'win32', 'node_modules']) copyTree(path.join(vscodeDist, name), path.join(destination, name));
for (const [source, name] of [[path.join(ROOT, 'LICENSE'), 'blackhole-LICENSE'], [path.join(vscodeDist, 'mermaid-LICENSE'), 'mermaid-LICENSE']]) if (fs.existsSync(source)) copyFile(source, path.join(destination, 'licenses', name));

const forbidden = /(?:^|[\\/])(?:blackhole\.db|cloud-auth-v1|mcp-proxies\.yaml|semantic-key|secrets?|credentials?)(?:$|[\\/])/i;
const files = [];
const visit = (dir) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const absolute = path.join(dir, entry.name); if (entry.isDirectory()) visit(absolute); else files.push(path.relative(destination, absolute)); } };
visit(destination);
const leaked = files.filter((file) => forbidden.test(file)); if (leaked.length) throw new Error(`mutable_data_in_core:${leaked.join(',')}`);
// Establish the same CommonJS package boundary as the VSIX extension root.
fs.writeFileSync(path.join(destination, 'package.json'), JSON.stringify({ private: true, type: 'commonjs' }, null, 2) + '\n');
fs.writeFileSync(path.join(destination, 'layout-build.json'), JSON.stringify({ formatVersion: 1, nodeVersion: process.version.replace(/^v/, ''), runtimeProvider: hostProvided ? 'host-node' : 'bundled-node', platform, arch, files: files.length + 1, buildInputs }, null, 2) + '\n');
const bytes = files.reduce((sum, file) => sum + fs.statSync(path.join(destination, file)).size, 0);
console.log(JSON.stringify({ ok: true, output: destination, files: files.length + 1, bytes }));
