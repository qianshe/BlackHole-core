import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const source = fs.readFileSync(new URL('../../../src/tunnel/openai-tunnel-install.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const module = { exports: {} };
// Internals are exposed only inside this isolated VM, never as production hooks.
vm.runInNewContext(js + '\nmodule.exports.testOnly = { installArtifact, download, readZipEntries, extract, verify, ARTIFACTS, VERSION };', {
  module, exports: module.exports, require, Buffer, process, fetch, AbortSignal, URL, Response,
});
const { initializeOpenAITunnelClient, testOnly: { installArtifact, readZipEntries, extract, verify, ARTIFACTS, VERSION } } = module.exports;
const desktopTargets = Object.keys(JSON.parse(fs.readFileSync(new URL('../../../scripts/desktop-toolchain.json', import.meta.url), 'utf8')).targets).sort();
const workflow = parseYaml(fs.readFileSync(new URL('../../../.github/workflows/vscode-extension.yml', import.meta.url), 'utf8'));
const nativeTargets = workflow.jobs['openai-runtime-native'].strategy.matrix.include.map((x) => `${x.platform}-${x.arch}`).sort();

const sha = (b) => createHash('sha256').update(b).digest('hex');
const exeBytes = Buffer.from('fixture runtime binary, never executed '.repeat(64));
const VERSION_OUT = Buffer.from('0.0.15 git sha: a390c168ff1b2d14e73a95991c186c6aba3ff5a0 go: go1.27.0 build flags: -trimpath flavor=runtime\n');
const HELP_OUT = Buffer.from('Usage of run:\n --control-plane.api-key string\n --control-plane.tunnel-id string\n --mcp.server-url stringArray\n --health.listen-addr string\n --health.url-file string\n');

/** Minimal ZIP writer for fixtures; `mode` sets the unix file type bits. */
function makeZip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const data = f.store ? f.data : deflateRawSync(f.data);
    const method = f.store ? 0 : 8;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(f.flags ?? 0, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(f.size ?? f.data.length, 22); lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(0x031e, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(f.flags ?? 0, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(f.size ?? f.data.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(((f.mode ?? 0o100644) << 16) >>> 0, 38); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const goodFiles = () => [
  { name: 'tunnel-client-runtime.exe', data: exeBytes, mode: 0o100755 },
  { name: 'LICENSE', data: Buffer.from('license') },
  { name: 'NOTICE', data: Buffer.from('notice'), store: true },
  { name: 'tunnel-client-runtime-v0.0.15-windows-amd64.spdx.json', data: Buffer.from('{}'), mode: 0o100600 },
];
const artifactFor = (zip) => ({ asset: 'tunnel-client-runtime-v0.0.15-windows-amd64.zip', size: zip.length, archiveSha256: sha(zip), exe: 'tunnel-client-runtime.exe', exeSha256: sha(exeBytes) });

function fixture(t, { responses, run } = {}) {
  // Stay inside the workspace; do not depend on the host session's TEMP directory.
  const root = fs.mkdtempSync(path.join(fileURLToPath(new URL('.', import.meta.url)), '.openai-tunnel-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [], downloads = [];
  const queue = [...(responses ?? [])];
  const env = {
    platform: 'win32', arch: 'x64', pathValue: '', root: path.join(root, 'managed'),
    run: run ?? (async (file, args) => { calls.push({ file, args }); return args[0] === '--version' ? VERSION_OUT : HELP_OUT; }),
    fetch: async (url, init) => { downloads.push({ url, redirect: init?.redirect }); const next = queue.shift(); return typeof next === 'function' ? next(url) : next; },
  };
  const target = path.join(env.root, VERSION, 'win32-x64');
  return { root, env, calls, downloads, target };
}

test('installs the pinned runtime from the mirror into the versioned managed directory', async (t) => {
  const zip = makeZip(goodFiles());
  const f = fixture(t, { responses: [new Response(zip)] });
  const file = await installArtifact(artifactFor(zip), f.target, f.env);
  assert.equal(file, path.join(f.target, 'tunnel-client-runtime.exe'));
  assert.deepEqual(fs.readFileSync(file), exeBytes);
  assert.deepEqual(fs.readdirSync(f.target).sort(), ['LICENSE', 'NOTICE', 'tunnel-client-runtime.exe']);
  assert.match(f.downloads[0].url, /^https:\/\/persistent\.oaistatic\.com\/tunnel-client\/v0\.0\.15\//);
  assert.equal(f.downloads[0].redirect, 'manual');
  assert.deepEqual(f.calls.map((c) => c.args.join(' ')), ['--version', 'run --help']);
  assert.ok(f.calls.every((c) => c.file.includes('.install-')), 'verification runs inside staging, before the rename');
  assert.deepEqual(fs.readdirSync(path.dirname(f.target)).filter((n) => n.startsWith('.install-')), []);
});

test('falls back to GitHub, following only allowlisted https redirects', async (t) => {
  const zip = makeZip(goodFiles());
  const redirect = (location) => new Response(null, { status: 302, headers: { location } });
  const f = fixture(t, { responses: [
    redirect('https://evil.example/x.zip'),
    redirect('https://release-assets.githubusercontent.com/asset?sig=1'),
    new Response(zip),
  ] });
  await installArtifact(artifactFor(zip), f.target, f.env);
  assert.match(f.downloads[1].url, /^https:\/\/github\.com\/openai\/tunnel-client\/releases\/download\/v0\.0\.15\//);
  assert.match(f.downloads[2].url, /^https:\/\/release-assets\.githubusercontent\.com\//);
  assert.equal(f.downloads.length, 3, 'the disallowed host was never requested');
});

test('hash mismatch or plaintext redirect on every source installs and executes nothing', async (t) => {
  const zip = makeZip(goodFiles());
  const f = fixture(t, { responses: [new Response(Buffer.concat([zip, Buffer.from('x')])), new Response(null, { status: 302, headers: { location: 'http://github.com/x' } })] });
  await assert.rejects(installArtifact(artifactFor(zip), f.target, f.env), /下载失败.*SHA-256|下载失败.*允许列表/s);
  assert.equal(f.calls.length, 0);
  assert.equal(fs.existsSync(f.target), false);
  assert.deepEqual(fs.readdirSync(path.dirname(f.target)).filter((n) => n.startsWith('.install-')), []);
});

for (const [label, files, pattern] of [
  ['path traversal', [...goodFiles(), { name: '../evil.exe', data: Buffer.from('x') }], /不安全条目/],
  ['backslash path', [...goodFiles(), { name: 'sub\\evil.exe', data: Buffer.from('x') }], /不安全条目/],
  ['symlink', [...goodFiles(), { name: 'link', data: Buffer.from('/etc/passwd'), mode: 0o120777 }], /非普通文件/],
  ['duplicate name', [...goodFiles(), { name: 'TUNNEL-CLIENT-RUNTIME.EXE', data: Buffer.from('x') }], /重复条目/],
  ['bundled cloudflared', [...goodFiles(), { name: 'cloudflared.exe', data: Buffer.from('x') }], /cloudflared/],
  ['encrypted entry', [{ ...goodFiles()[0], flags: 1 }], /加密/],
  ['missing executable', goodFiles().slice(1), /缺少预期的可执行文件/],
  ['inflated size lie', [{ ...goodFiles()[0], size: 10 }], /大小不符|buffer|length/i],
]) {
  test(`rejects an authenticated archive with ${label} before executing anything`, async (t) => {
    const zip = makeZip(files);
    const f = fixture(t, { responses: [new Response(zip)] });
    await assert.rejects(installArtifact(artifactFor(zip), f.target, f.env), pattern);
    assert.equal(f.calls.length, 0);
    assert.equal(fs.existsSync(f.target), false);
  });
}

test('an executable that differs from the pinned hash is never written or run', async (t) => {
  const zip = makeZip(goodFiles());
  const f = fixture(t, { responses: [new Response(zip)] });
  await assert.rejects(installArtifact({ ...artifactFor(zip), exeSha256: '0'.repeat(64) }, f.target, f.env), /可执行文件 SHA-256/);
  assert.equal(f.calls.length, 0);
});

test('verify accepts only the runtime flavor with the required flags', async () => {
  const run = (v, h) => async (_f, args) => Buffer.from(args[0] === '--version' ? v : h);
  assert.equal(await verify('C:\\x.exe', run(VERSION_OUT, HELP_OUT), 'v0.0.15'), 'v0.0.15');
  await assert.rejects(verify('C:\\x.exe', run('0.0.15 git sha: abc flavor=runtime-cloudflared\n', HELP_OUT)), /flavor=runtime/);
  await assert.rejects(verify('C:\\x.exe', run('tunnel-client 0.0.15\n', HELP_OUT)), /flavor=runtime/);
  await assert.rejects(verify('C:\\x.exe', run(VERSION_OUT, HELP_OUT), 'v0.0.16'), /版本不符/);
  await assert.rejects(verify('C:\\x.exe', run(VERSION_OUT, HELP_OUT + ' --cloudflared.managed\n')), /cloudflared/);
  await assert.rejects(verify('C:\\x.exe', run(VERSION_OUT, 'Usage of run:\n --mcp.server-url\n')), /缺少必需参数/);
});

test('unknown platforms fail closed with a manual-path hint and no download', async (t) => {
  const f = fixture(t);
  f.env.platform = 'freebsd';
  await assert.rejects(initializeOpenAITunnelClient('', f.env), /freebsd-x64.*不在 BlackHole.*一键安装支持矩阵.*https:\/\/github\.com\/openai\/tunnel-client\/releases\/tag\/v0\.0\.15 .*填写可执行文件的完整路径/s);
  assert.equal(f.downloads.length, 0);
});

test('a configured path is verified, never replaced; relative paths are refused', async (t) => {
  const f = fixture(t);
  await assert.rejects(initializeOpenAITunnelClient('tunnel-client-runtime.exe', f.env), /完整路径/);
  const r = await initializeOpenAITunnelClient('C:\\Tools\\tunnel-client-runtime.exe', f.env);
  assert.deepEqual({ ...r }, { path: 'C:\\Tools\\tunnel-client-runtime.exe', installed: false, version: 'v0.0.15' });
  assert.equal(f.downloads.length, 0);
});

test('an existing managed install is reused only when it is the pinned executable', async (t) => {
  const f = fixture(t);
  const original = ARTIFACTS['win32-x64'];
  t.after(() => { ARTIFACTS['win32-x64'] = original; });
  ARTIFACTS['win32-x64'] = { ...original, exeSha256: sha(exeBytes) };
  fs.mkdirSync(f.target, { recursive: true });
  const file = path.join(f.target, 'tunnel-client-runtime.exe');
  fs.writeFileSync(file, Buffer.from('tampered'));
  await assert.rejects(initializeOpenAITunnelClient('', f.env), /与固定版本不一致.*未覆盖/s);
  assert.deepEqual(fs.readFileSync(file), Buffer.from('tampered'));
  fs.writeFileSync(file, exeBytes);
  const r = await initializeOpenAITunnelClient('', f.env);
  assert.deepEqual({ ...r }, { path: file, installed: false, version: 'v0.0.15' });
  assert.equal(f.downloads.length, 0);
});

test('the pinned manifest covers every desktop target and names only the pure runtime flavor', () => {
  assert.equal(VERSION, 'v0.0.15');
  assert.deepEqual(Object.keys(ARTIFACTS).sort(), desktopTargets);
  assert.deepEqual(nativeTargets, desktopTargets, 'native CI verification matrix must cover every desktop target');
  const expectedAssets = {
    'win32-x64': 'tunnel-client-runtime-v0.0.15-windows-amd64.zip',
    'win32-arm64': 'tunnel-client-runtime-v0.0.15-windows-arm64.zip',
    'darwin-x64': 'tunnel-client-runtime-v0.0.15-darwin-amd64.zip',
    'darwin-arm64': 'tunnel-client-runtime-v0.0.15-darwin-arm64.zip',
    'linux-x64': 'tunnel-client-runtime-v0.0.15-linux-amd64.zip',
    'linux-arm64': 'tunnel-client-runtime-v0.0.15-linux-arm64.zip',
  };
  for (const [target, a] of Object.entries(ARTIFACTS)) {
    assert.equal(a.asset, expectedAssets[target], target);
    assert.ok(Number.isInteger(a.size) && a.size > 0, target);
    assert.match(a.archiveSha256, /^[a-f0-9]{64}$/, target);
    assert.match(a.exeSha256, /^[a-f0-9]{64}$/, target);
    assert.equal(a.exe, target.startsWith('win32-') ? 'tunnel-client-runtime.exe' : 'tunnel-client-runtime');
    assert.doesNotMatch(a.asset, /runtime-cloudflared|cloudflared/);
  }
});

// Optional: the real official archive, when a local copy is supplied (never downloaded here).
const realZip = process.env.OPENAI_TUNNEL_RUNTIME_ZIP;
test('the real v0.0.15 windows-amd64 archive yields the pinned executable', { skip: !realZip && 'set OPENAI_TUNNEL_RUNTIME_ZIP to a local copy' }, () => {
  const zip = fs.readFileSync(realZip);
  const a = ARTIFACTS['win32-x64'];
  assert.equal(sha(zip), a.archiveSha256);
  const entries = readZipEntries(zip);
  assert.deepEqual([...entries.values()].map((e) => e.name).sort(), ['LICENSE', 'NOTICE', 'tunnel-client-runtime-v0.0.15-windows-amd64-licenses.txt', 'tunnel-client-runtime-v0.0.15-windows-amd64.spdx.json', 'tunnel-client-runtime.exe']);
  assert.equal(sha(extract(zip, entries.get('tunnel-client-runtime.exe'), 128 * 1024 * 1024)), a.exeSha256);
});
