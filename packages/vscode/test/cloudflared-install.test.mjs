import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const source = fs.readFileSync(new URL('../../../src/tunnel/cloudflared-install.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const module = { exports: {} };
// Expose internals only in this isolated test VM, without public production hooks.
vm.runInNewContext(js + '\nmodule.exports.testOnly = { installArtifact, download, ARTIFACTS, VERSION, MAX_BYTES };', {
  module, exports: module.exports, require, Buffer, process, fetch, AbortSignal,
});
const { initializeCloudflared, testOnly: { installArtifact, download, ARTIFACTS, VERSION, MAX_BYTES } } = module.exports;
const binary = Buffer.from('fixture binary, never executed');
const artifact = { name: 'cloudflared-windows-amd64.exe', sha256: createHash('sha256').update(binary).digest('hex') };

function fixture(t) {
  // Stay inside the workspace; do not depend on the host session's TEMP directory.
  const root = fs.mkdtempSync(path.join(fileURLToPath(new URL('.', import.meta.url)), '.cloudflared-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [], downloads = [];
  const env = {
    platform: process.platform, arch: 'x64', pathValue: '', root: path.join(root, 'managed'),
    run: async (file, args) => { calls.push({ file, args }); return Buffer.from('cloudflared version 2026.9.0 (fixture)\n'); },
    fetch: async (...args) => { downloads.push(args); return new Response(binary); },
  };
  const exe = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  const put = directory => {
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, exe); fs.writeFileSync(file, binary); return file;
  };
  const target = path.join(env.root, VERSION, `${env.platform}-${env.arch}`);
  return { root, env, calls, downloads, exe, put, target };
}
function noStaging(target) {
  const parent = path.dirname(target);
  assert.ok(!fs.existsSync(parent) || fs.readdirSync(parent).every(name => !name.startsWith('.install-')));
}

test('explicit usable path is reused without PATH discovery, download or environment writes', async t => {
  const f = fixture(t), configured = f.put(path.join(f.root, 'configured'));
  const before = process.env.PATH;
  f.env.pathValue = path.join(f.root, 'must-not-search');
  const result = await initializeCloudflared('  ' + configured + '  ', f.env);
  assert.equal(result.path, configured); assert.equal(result.installed, false);
  assert.equal(f.calls.length, 1); assert.deepEqual(Array.from(f.calls[0].args), ['--version']);
  assert.equal(f.downloads.length, 0); assert.equal(fs.existsSync(f.env.root), false);
  assert.equal(process.env.PATH, before);
});

test('invalid configured path only reports a hint and never falls back or replaces it', async t => {
  const f = fixture(t), configured = f.put(path.join(f.root, 'broken'));
  f.env.pathValue = path.dirname(f.put(path.join(f.root, 'otherwise-usable')));
  f.env.run = async () => { throw Error('cannot run'); };
  await assert.rejects(initializeCloudflared(configured, f.env), /路径不可用/);
  assert.deepEqual(fs.readFileSync(configured), binary);
  assert.equal(f.downloads.length, 0); assert.equal(fs.existsSync(f.env.root), false);
  await assert.rejects(initializeCloudflared('relative-executable', f.env), /完整路径/);
});

test('first usable PATH entry returns immediately, skipping later detection and artifact selection', async t => {
  const f = fixture(t), first = f.put(path.join(f.root, '已有 工具'));
  const second = f.put(path.join(f.root, 'must-not-probe'));
  f.env.pathValue = ['', '.', 'relative', '"' + path.dirname(first) + '"', path.dirname(second)].join(path.delimiter);
  f.env.arch = 'not-supported-for-download';
  const result = await initializeCloudflared('', f.env);
  assert.equal(result.path, first); assert.equal(result.installed, false);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].file, first);
  assert.equal(f.downloads.length, 0); assert.equal(fs.existsSync(f.env.root), false);
});

test('broken first PATH entry only reports a hint, not a replacement from later PATH or download', async t => {
  const f = fixture(t), first = f.put(path.join(f.root, 'broken-path'));
  const second = f.put(path.join(f.root, 'later-path'));
  f.env.pathValue = [path.dirname(first), path.dirname(second)].join(path.delimiter);
  const probes = [];
  f.env.run = async file => { probes.push(file); throw Error('bad executable'); };
  await assert.rejects(initializeCloudflared('', f.env), /未修改 PATH/);
  assert.deepEqual(probes, [first]); assert.equal(f.downloads.length, 0);
  assert.equal(fs.existsSync(f.env.root), false); assert.deepEqual(fs.readFileSync(first), binary);
});

test('supported artifact mapping is pinned and unsupported platforms do not download', async t => {
  assert.deepEqual(Object.keys(ARTIFACTS).sort(), ['darwin-arm64','darwin-x64','linux-arm64','linux-x64','win32-x64']);
  for (const item of Object.values(ARTIFACTS)) assert.match(item.sha256, /^[a-f0-9]{64}$/);
  const f = fixture(t); f.env.platform = 'freebsd';
  await assert.rejects(initializeCloudflared('', f.env), /暂不支持 freebsd-x64/);
  assert.equal(f.downloads.length, 0); assert.equal(fs.existsSync(f.env.root), false);
});

test('previous managed installation is reused and an invalid one is not repaired', async t => {
  const f = fixture(t), file = f.put(f.target);
  const result = await initializeCloudflared('', f.env);
  assert.equal(result.path, file); assert.equal(result.installed, false); assert.equal(f.downloads.length, 0);
  f.env.run = async () => { throw Error('managed file no longer runs'); };
  await assert.rejects(initializeCloudflared('', f.env), /路径不可用/);
  assert.equal(f.downloads.length, 0); assert.deepEqual(fs.readFileSync(file), binary);
});

test('missing installation uses the pinned URL and rejects untrusted content before executing', async t => {
  const f = fixture(t);
  await assert.rejects(initializeCloudflared('', f.env), /SHA-256/);
  assert.equal(f.downloads.length, 1);
  const [url, options] = f.downloads[0];
  assert.equal(url, `https://github.com/cloudflare/cloudflared/releases/download/${VERSION}/${ARTIFACTS[`${f.env.platform}-x64`].name}`);
  assert.ok(options.signal); assert.equal(options.redirect, 'follow');
  assert.equal(f.calls.length, 0); assert.equal(fs.existsSync(f.target), false); noStaging(f.target);
});

test('verified binary is staged, checked with --version and atomically installed', async t => {
  const f = fixture(t);
  const file = await installArtifact(artifact, f.target, f.env);
  assert.equal(file, path.join(f.target, f.exe)); assert.deepEqual(fs.readFileSync(file), binary);
  assert.equal(f.calls.length, 1); assert.deepEqual(Array.from(f.calls[0].args), ['--version']);
  assert.ok(f.calls[0].file.includes('.install-')); noStaging(f.target);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o700);
});

test('checksum failure preserves existing files and never executes downloaded data', async t => {
  const f = fixture(t), existing = f.put(path.join(f.root, 'user-install'));
  await assert.rejects(installArtifact({ ...artifact, sha256: '0'.repeat(64) }, f.target, f.env), /SHA-256/);
  assert.equal(f.calls.length, 0); assert.equal(fs.existsSync(f.target), false); noStaging(f.target);
  assert.deepEqual(fs.readFileSync(existing), binary);
});

test('HTTP errors and network rejection leave no installed file or staging directory', async t => {
  const f = fixture(t);
  f.env.fetch = async () => new Response('not found', { status: 404 });
  await assert.rejects(installArtifact(artifact, f.target, f.env), /HTTP 404/); noStaging(f.target);
  f.env.fetch = async () => { throw Error('network unavailable'); };
  await assert.rejects(installArtifact(artifact, f.target, f.env), /network unavailable/); noStaging(f.target);
  assert.equal(f.calls.length, 0); assert.equal(fs.existsSync(f.target), false);
});

test('oversized headers and streaming overflow cancel the response without execution', async t => {
  const f = fixture(t);
  f.env.fetch = async () => new Response('small', { headers: { 'content-length': String(MAX_BYTES + 1) } });
  await assert.rejects(installArtifact(artifact, f.target, f.env), /大小限制/); noStaging(f.target);
  let cancelled = 0, released = 0;
  const fetchFile = async () => ({ ok: true, headers: new Headers(), body: { getReader: () => ({
    read: async () => ({ done: false, value: { byteLength: MAX_BYTES + 1 } }),
    cancel: async () => { cancelled++; }, releaseLock: () => { released++; },
  }) } });
  await assert.rejects(download(artifact, fetchFile), /大小限制/);
  assert.equal(cancelled, 1); assert.equal(released, 1); assert.equal(f.calls.length, 0);
});

test('downloaded executable that cannot run is removed without committing an installation', async t => {
  const f = fixture(t); f.env.run = async () => { throw Error('wrong architecture'); };
  await assert.rejects(installArtifact(artifact, f.target, f.env), /未完成安装/);
  assert.equal(fs.existsSync(f.target), false); noStaging(f.target);
});

test('macOS tgz extracts only the executable to stdout, never archive paths', async t => {
  const f = fixture(t); f.env.platform = 'darwin';
  const packed = Buffer.from('archive bytes are deliberately different from the executable');
  const archive = { ...artifact, name: 'cloudflared-darwin-arm64.tgz', archiveSha256: createHash('sha256').update(packed).digest('hex') };
  f.env.fetch = async () => new Response(packed);
  const commands = [];
  f.env.run = async (file, args) => {
    commands.push({ file, args });
    return file === '/usr/bin/tar' ? binary : Buffer.from('cloudflared version 2026.9.0');
  };
  const file = await installArtifact(archive, f.target, f.env);
  assert.equal(commands[0].file, '/usr/bin/tar');
  assert.equal(commands[0].args[0], '-xOzf'); assert.equal(commands[0].args[2], 'cloudflared');
  assert.equal(commands[1].args[0], '--version');
  assert.deepEqual(fs.readFileSync(file), binary); assert.deepEqual(fs.readdirSync(f.target), ['cloudflared']);
  noStaging(f.target);
});

test('macOS tgz checksum failure rejects the extracted executable before writing or execution', async t => {
  const f = fixture(t); f.env.platform = 'darwin';
  const archive = { ...artifact, name: 'cloudflared-darwin-arm64.tgz', archiveSha256: artifact.sha256, sha256: '0'.repeat(64) };
  const commands = [];
  f.env.run = async (file, args) => {
    commands.push({ file, args });
    return file === '/usr/bin/tar' ? binary : Buffer.from('cloudflared version 2026.9.0');
  };
  await assert.rejects(installArtifact(archive, f.target, f.env), /SHA-256/);
  assert.equal(commands.length, 1); // tar extraction only; --version never ran
  assert.equal(fs.existsSync(f.target), false); noStaging(f.target);
});

test('competing installations cannot overwrite a completed target', async t => {
  const f = fixture(t);
  const results = await Promise.allSettled([
    installArtifact(artifact, f.target, f.env), installArtifact(artifact, f.target, f.env),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected').length, 1);
  assert.deepEqual(fs.readFileSync(path.join(f.target, f.exe)), binary); noStaging(f.target);
});


test('macOS archives have independent pinned digests and fail before tar when corrupt', async t => {
  for (const key of ['darwin-x64', 'darwin-arm64']) {
    assert.match(ARTIFACTS[key].archiveSha256, /^[a-f0-9]{64}$/);
    assert.notEqual(ARTIFACTS[key].archiveSha256, ARTIFACTS[key].sha256);
  }
  const f = fixture(t);
  for (const archiveSha256 of [undefined, '0'.repeat(64)]) {
    await assert.rejects(installArtifact({ ...artifact, name: 'fixture.tgz', archiveSha256 }, f.target, f.env), /SHA-256/);
    assert.equal(f.calls.length, 0, 'unverified archive must never reach tar or --version');
    assert.equal(fs.existsSync(f.target), false); noStaging(f.target);
  }
});

test('execution errors retain their code and cause through both validation layers', async t => {
  const f = fixture(t);
  const failure = Object.assign(new Error('execution denied'), { code: 'EPERM' });
  f.env.run = async () => { throw failure; };
  await assert.rejects(initializeCloudflared(f.put(path.join(f.root, 'configured')), f.env), error => {
    assert.match(error.message, /EPERM.*execution denied/);
    assert.equal(error.cause, failure); return true;
  });
  await assert.rejects(installArtifact(artifact, f.target, f.env), error => {
    assert.match(error.message, /EPERM.*execution denied/);
    assert.equal(error.cause.cause, failure); return true;
  });
  assert.equal(fs.existsSync(f.target), false); noStaging(f.target);
});
