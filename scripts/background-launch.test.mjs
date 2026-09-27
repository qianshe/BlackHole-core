// Isolated subprocess-option regression. No actual child, daemon, or tunnel is started.
// Run after pnpm build: node --test scripts/background-launch.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

await test('background launches hide consoles without changing execution contracts', async (t) => {
  const original = { execFile: childProcess.execFile, spawnSync: childProcess.spawnSync, spawn: childProcess.spawn };
  const previousRg = process.env.BH_SEMANTIC_RG;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-background-'));
  const binary = path.join(root, 'fake-rg');
  fs.writeFileSync(binary, 'not executable: subprocesses are mocked');
  process.env.BH_SEMANTIC_RG = binary;
  const searches = [], probes = [], launches = [];
  let probeStatus = 0;
  let searchError;
  const fakeExecFile = () => { throw new Error('only promisified execFile is expected'); };
  fakeExecFile[promisify.custom] = async (bin, args, options) => {
    searches.push({ bin, args, options });
    if (searchError) throw searchError;
    return { stdout: `${path.join(root, 'match.ts')}:1:needle`, stderr: '' };
  };
  childProcess.execFile = fakeExecFile;
  childProcess.spawnSync = (bin, args, options) => {
    probes.push({ bin, args, options });
    return { status: probeStatus, stdout: 'fake version', stderr: '' };
  };
  childProcess.spawn = (bin, args, options) => {
    launches.push({ bin, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.exitCode = null;
    child.kill = () => {
      child.exitCode = 0;
      queueMicrotask(() => child.emit('exit', 0, null));
      return true;
    };
    return child;
  };
  syncBuiltinESMExports();
  try {
    const { ToolExecutor, _resetRgCache } = await import('../dist/semantic/executor.js');
    const { TunnelManager } = await import('../dist/tunnel/manager.js');
    _resetRgCache();
    await t.test('semantic rg hides windows and preserves arguments, output, cancellation and errors', async () => {
      const controller = new AbortController();
      const executor = new ToolExecutor(root, { signal: controller.signal });
      assert.equal(await executor.rg('needle', '/codebase'), '/codebase/match.ts:1:needle');
      const { bin, args, options } = searches[0];
      assert.equal(options.windowsHide, true);
      assert.equal(bin, binary);
      assert.ok(args.includes('needle'));
      assert.ok(args.includes(root));
      assert.ok(options.timeout >= 1000);
      assert.equal(options.maxBuffer, 10 * 1024 * 1024);
      assert.equal(options.encoding, 'utf-8');
      assert.equal(options.env.RIPGREP_CONFIG_PATH, '');
      assert.equal(options.signal, controller.signal);
      searchError = Object.assign(new Error('no matches'), { code: 1 });
      assert.equal(await executor.rg('missing', '/codebase'), '(no matches)');
      searchError = Object.assign(new Error('cancelled'), { name: 'AbortError' });
      assert.equal(await executor.rg('needle', '/codebase'), 'Error: aborted');
    });
    await t.test('tunnel preflight and long-running child both hide windows', async () => {
      const manager = new TunnelManager(7399, { enabled: true, bin: 'fake-cloudflared', log: () => {}, onEvent: () => {} });
      try {
        manager.start('quick');
        assert.equal(probes.length, 1);
        assert.deepEqual(probes[0].args, ['--version']);
        assert.equal(probes[0].options.windowsHide, true);
        assert.equal(probes[0].options.timeout, 8000);
        assert.equal(probes[0].options.encoding, 'utf8');
        assert.equal(launches.length, 1);
        assert.equal(launches[0].options.windowsHide, true);
        assert.deepEqual(launches[0].options.stdio, ['ignore', 'pipe', 'pipe']);
        assert.equal(manager.status, 'starting');
      } finally { await manager.stop(); }
      assert.equal(fs.existsSync(launches[0].args[2]), false, 'temporary quick config is cleaned up');
    });
    await t.test('failed hidden preflight remains unavailable and never launches a tunnel', async () => {
      probeStatus = 1;
      const count = launches.length;
      const manager = new TunnelManager(7399, { enabled: true, bin: 'fake-cloudflared', log: () => {}, onEvent: () => {} });
      try {
        manager.start('quick');
        assert.equal(probes.at(-1).options.windowsHide, true);
        assert.equal(manager.status, 'unavailable');
        assert.equal(launches.length, count);
      } finally { await manager.stop(); }
    });
    _resetRgCache();
  } finally {
    Object.assign(childProcess, original);
    syncBuiltinESMExports();
    if (previousRg === undefined) delete process.env.BH_SEMANTIC_RG;
    else process.env.BH_SEMANTIC_RG = previousRg;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
