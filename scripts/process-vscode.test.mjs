import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startFixture, until } from './fixtures/process-harness.mjs';
const require = createRequire(import.meta.url), esbuild = createRequire(new URL('../packages/vscode/package.json', import.meta.url))('esbuild');
const candidates = process.platform === 'win32'
  ? [path.join(process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || os.homedir(), 'AppData', 'Local'), 'Programs', 'Microsoft VS Code', 'Code.exe')]
  : process.platform === 'darwin' ? ['/Applications/Visual Studio Code.app/Contents/MacOS/Electron'] : ['/usr/share/code/code', '/usr/share/code-insiders/code-insiders'];
const binary = process.env.BH_VSCODE_TEST_EXECUTABLE || candidates.find(file => fs.existsSync(file)) || candidates[0];
const soakMs = Number(process.env.BH_PROCESS_TEST_SOAK_MS ?? 2000);
if (!Number.isSafeInteger(soakMs) || soakMs < 0 || soakMs > 600000) throw Error('Invalid bounded soak duration');
import { processSupported as supported } from '../dist/process/backend.js';
const source = fileURLToPath(new URL('../packages/vscode/src/processTerminals.ts', import.meta.url));
const liveTest = fileURLToPath(new URL('../packages/vscode/test/process-terminal-live.cjs', import.meta.url));

test('real isolated VS Code renders three daemon-managed processes, ACKs opens, preserves views and stops only one', { skip: !supported, timeout: soakMs + 180000 }, async t => {
  assert.ok(fs.existsSync(binary), 'VS Code executable required; set BH_VSCODE_TEST_EXECUTABLE to its exact path');
  const f = await startFixture(t), session = await f.session(), client = await f.connect(session);
  const rows = await Promise.all(['http-A', 'http-B', 'watch-C'].map(name => f.call(client, session, 'start', { requestId: name, name, script: f.fixtureScript(name === 'watch-C' ? 'watch' : 'server') })));
  const getPort = row => { for (const line of row.output?.stdout?.split(/\r?\n/) ?? []) { try { const data = JSON.parse(line); if (data.port) return data.port; } catch { } } };
  const ready = await Promise.all(rows.map(row => until(() => f.call(client, session, 'status', { processId: row.processId }), row => Boolean(getPort(row)) || row.state === 'failed')));
  assert.ok(ready.every(row => row.state === 'running'), JSON.stringify(ready));
  const extension = path.join(f.root, 'test-extension'); fs.mkdirSync(extension);
  fs.writeFileSync(path.join(extension, 'package.json'), JSON.stringify({ name: 'blackhole-process-fixture', publisher: 'local-test', version: '0.0.0', engines: { vscode: '^1.107.0' }, main: './entry.cjs' }));
  fs.writeFileSync(path.join(extension, 'entry.cjs'), 'exports.activate=()=>{};');
  const controller = path.join(extension, 'process-controller.cjs');
  await esbuild.build({ entryPoints: [source], outfile: controller, bundle: true, platform: 'node', format: 'cjs', external: ['vscode'] });
  const receipt = path.join(f.root, 'vscode-receipt.json'), input = path.join(f.root, 'vscode-input.json');
  fs.writeFileSync(input, JSON.stringify({ controller, receipt, base: f.base, project: f.project, mcpUrl: session.mcp_url, credential: session.session_id,
    ids: rows.map(row => row.processId), ports: ready.map(getPort), soakMs,
    sdkClient: require.resolve('@modelcontextprotocol/sdk/client/index.js'), sdkTransport: require.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js') }));
  const settings = path.join(f.root, 'vscode-data', 'User'); fs.mkdirSync(settings, { recursive: true });
  fs.writeFileSync(path.join(settings, 'settings.json'), JSON.stringify({ 'security.workspace.trust.enabled': false, 'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'extensions.autoCheckUpdates': false, 'extensions.autoUpdate': false, 'workbench.startupEditor': 'none', 'terminal.integrated.confirmOnExit': 'never' }));
  fs.mkdirSync(path.join(f.root, 'empty-extensions'));
  const env = { ...f.env, BH_PROCESS_VSCODE_INPUT: input };
  // Isolate VS Code with its explicit data/extensions directories, not a fake Windows GUI profile:
  // system IME brokers may outlive Code and keep log files open in a redirected USERPROFILE.
  for (const key of ['USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]; else delete env[key];
  }
  delete env.ELECTRON_RUN_AS_NODE;
  const args = ['--new-window', '--disable-gpu', '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
    '--user-data-dir=' + path.join(f.root, 'vscode-data'), '--extensions-dir=' + path.join(f.root, 'empty-extensions'),
    '--extensionDevelopmentPath=' + extension, '--extensionTestsPath=' + liveTest, f.project];
  const child = spawn(binary, args, { env, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; child.stdout.on('data', b => { logs = (logs + b).slice(-40000); }); child.stderr.on('data', b => { logs = (logs + b).slice(-40000); });
  t.after(async () => {
    if (child.exitCode === null && child.pid) await new Promise(resolve => {
      if (process.platform === 'win32') {
        const kill = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); kill.once('exit', resolve); kill.once('error', resolve);
      } else { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* isolated test window already gone */ } resolve(); }
    });
  });
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('VS Code fixture exceeded deadline: ' + logs)), soakMs + 150000);
    child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
  const result = fs.existsSync(receipt) ? JSON.parse(fs.readFileSync(receipt, 'utf8')) : { ok: false, error: 'No VS Code test receipt', logs };
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(code, 0, logs);
  const listed = await f.call(client, session, 'list'); assert.equal(listed.items.length, 3, 'terminal lifecycle must never restart scripts');
  for (const row of rows) assert.equal((await f.call(client, session, 'status', { processId: row.processId })).state, 'exited');
  for (const port of ready.map(getPort)) await assert.rejects(fetch('http://127.0.0.1:' + port));
  t.diagnostic(JSON.stringify({ ...result, allOwnedServersStopped: true, isolatedDaemonPort: new URL(f.base).port, currentExtensionNotLoaded: true }));
});
