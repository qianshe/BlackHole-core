import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url), repository = fileURLToPath(new URL('../', import.meta.url));
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('test extension and daemon build in an isolated output tree without touching loaded native binaries', { timeout: 120000 }, t => {
  const cache = path.join(repository, '.cache/tests'); fs.mkdirSync(cache, { recursive: true });
  const root = fs.mkdtempSync(path.join(cache, 'process-build-')), plugin = path.join(root, 'packages/vscode');
  const links = [];
  t.after(() => { for (const link of links) fs.rmSync(link, { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  // Core carries its own public build profiles; private deployment config must not be required.
  for (const directory of ['src', 'scripts', 'client']) fs.cpSync(path.join(repository, directory), path.join(root, directory), { recursive: true });
  assert.equal(fs.existsSync(path.join(root, 'config')), false, 'isolated Core build must not copy private deployment configuration');
  for (const file of ['package.json', 'tsconfig.json']) fs.copyFileSync(path.join(repository, file), path.join(root, file));
  fs.mkdirSync(plugin, { recursive: true });
  for (const directory of ['src', 'test']) fs.cpSync(path.join(repository, 'packages/vscode', directory), path.join(plugin, directory), { recursive: true });
  for (const file of ['package.json', 'tsconfig.json', 'esbuild.mjs', 'build-config.mjs']) fs.copyFileSync(path.join(repository, 'packages/vscode', file), path.join(plugin, file));
  for (const [source, target] of [[path.join(repository, 'node_modules'), path.join(root, 'node_modules')], [path.join(repository, 'packages/vscode/node_modules'), path.join(plugin, 'node_modules')]]) {
    fs.symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir'); links.push(target);
  }
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const run = (script, args, cwd = root) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 90000, maxBuffer: 2 * 1024 * 1024 });
    assert.equal(result.status, 0, (result.error?.message ?? '') + result.stdout + result.stderr); return result;
  };
  run(require.resolve('typescript/bin/tsc'), ['-p', 'tsconfig.json']);
  run(require.resolve('typescript/bin/tsc'), ['-p', 'tsconfig.json', '--noEmit'], plugin);
  const built = run(path.join(plugin, 'esbuild.mjs'), ['--environment', 'test'], plugin);
  assert.match(built.stdout, /Cloud build: test/);
  const metadata = JSON.parse(fs.readFileSync(path.join(plugin, 'dist/cloud-build.json'), 'utf8'));
  assert.equal(metadata.environment, 'test'); assert.notEqual(metadata.origin, 'https://blackhole.stellarbridge.dpdns.org');
  assert.equal(sha(path.join(plugin, 'dist/extension.js')), metadata.extensionSha256);
  assert.equal(sha(path.join(plugin, 'dist/daemon/cli.js')), metadata.daemonSha256);
  for (const rel of ['dist/workspace/windows-env.js', 'dist/workspace/shell-codepage.js', 'dist/workspace/sandboxed-shell.js', 'dist/win32/ffi.js', 'dist/node_modules/koffi/package.json']) {
    assert.ok(fs.existsSync(path.join(plugin, rel)), `shared Windows execution environment must ship at ${rel}`);
  }
  for (const rel of ['dist/daemon/workspace', 'dist/daemon/win32', 'dist/daemon/node_modules']) {
    assert.ok(!fs.existsSync(path.join(plugin, rel)), `the Windows sandbox chain and koffi ship once; ${rel} is a duplicate`);
  }
  const supervisor = path.join(plugin, 'dist/daemon/process-supervisor.cjs');
  assert.ok(fs.existsSync(supervisor), 'POSIX supervisor must ship beside the bundled daemon');
  assert.equal(sha(supervisor), metadata.processSupervisorSha256);
  run(supervisor, [], plugin); // without the private IPC parent it must exit without executing anything
  assert.match(fs.readFileSync(path.join(plugin, 'dist/daemon/cli.js'), 'utf8'), /Background Process/);
  run(path.join(root, 'scripts/check-webview.mjs'), []);
  run(path.join(root, 'scripts/proxy-sync-unit.mjs'), []);
  const bundle = path.join(plugin, 'dist/daemon/cli.js');
  run(bundle, ['--help'], plugin);
  // An unsupported process platform must still be able to start the existing daemon/CLI.
  run('-e', [String.raw`const Module = require('node:module');
    Object.defineProperty(process, 'platform', {value: 'linux'});
    const load = Module._load;
    Module._load = function(id, ...args) { if (id === 'koffi') throw Error('unexpected Windows native import on POSIX'); return load.call(this, id, ...args); };
    process.argv = [process.execPath, process.argv[1], '--help']; require(process.argv[1]);`, bundle], plugin);
  t.diagnostic(JSON.stringify({ buildEnvironment: metadata.environment, extensionHashMatched: true, daemonHashMatched: true, webviewChecks: true, sharedDistUntouched: true, warnings: (built.stderr.match(/\[WARNING\]/g) ?? []).length }));
});
