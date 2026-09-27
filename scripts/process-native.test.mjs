import { SandboxedPersistentShell } from '../dist/workspace/sandboxed-shell.js';
import { PersistentShell, detectPwshBin } from '../dist/workspace/pwsh.js';
import { managedPowerShellPath, startWindowsProcess, powerShellArgs } from '../dist/process/windows.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fork, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ProcessManager } from '../dist/process/manager.js';
import { loadProcessBackend, processSupported } from '../dist/process/backend.js';
const startProcessBackend = await loadProcessBackend();
const childFile = fileURLToPath(new URL('./fixtures/process-child.mjs', import.meta.url));
const quote = s => "'" + s.replaceAll("'", "''") + "'";
import { spawnSandboxed } from '../dist/win32/acl-sandbox.js';
import { win32, decodeUint32At, decodeUint16At } from '../dist/win32/ffi.js';
const script = (...args) => ['&', quote(process.execPath), quote(childFile), ...args.map(x => quote(String(x)))].join(' ');
const wait = async (read, accept, timeout = 12000) => { const until = Date.now() + timeout; for (;;) { const value = await read(); if (accept(value)) return value; if (Date.now() >= until) throw Error('Condition timed out: ' + JSON.stringify(value)); await new Promise(r => setTimeout(r, 50)); } };
const servers = row => row.output.stdout.split(/\r?\n/).filter(x => x.startsWith('{')).map(x => { try { return JSON.parse(x); } catch { return null; } }).filter(x => x?.port);
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
function fixture(t, mode = 'workspace-write') {
  fs.mkdirSync('.cache/tests', { recursive: true });
  const root = fs.realpathSync(fs.mkdtempSync('.cache/tests/process-native-'));
  const manager = new ProcessManager({ daemonId: 'native-test', backend: startProcessBackend });
  const owner = { sessionId: 'native-session', workspace: root, mode, writableDirs: [] };
  t.after(async () => { await manager.dispose(); await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const start = (name, args) => manager.start(owner, { requestId: name, name, script: script(...args) }, async () => {});
  const status = id => manager.status(owner.sessionId, id);
  return { root, manager, owner, start, status, ready: id => wait(() => status(id), x => servers(x).length > 0 || ['exited', 'failed', 'unknown'].includes(x.state)) };
}
if (process.env.BH_PROCESS_CRASH_CHILD === '1') {
  const root = process.env.BH_PROCESS_FIXTURE_ROOT;
  const manager = new ProcessManager({ daemonId: 'crash-child', backend: startProcessBackend });
  const owner = { sessionId: 's', workspace: root, mode: 'workspace-write', writableDirs: [] };
  const row = await manager.start(owner, { requestId: 'crash', script: script('tree') }, async () => {});
  const ready = await wait(() => manager.status('s', row.processId), x => servers(x).length === 2 || x.state === 'failed');
  process.send?.({ row: ready, servers: servers(ready) });
} else {
  test('matching PowerShell core modules do not discard configured custom modules', { timeout: 18000 }, async t => {
    const f = fixture(t), moduleRoot = path.join(f.root, 'module-library');
    const custom = path.join(moduleRoot, 'BlackHoleFixture');
    fs.mkdirSync(custom, { recursive: true });
    fs.writeFileSync(path.join(custom, 'BlackHoleFixture.psm1'), "function Get-BlackHoleFixture { 'custom-module-ok' }\nExport-ModuleMember -Function Get-BlackHoleFixture\n", 'utf8');
    // A conflicting host's built-in module must not shadow this interpreter.
    const shadow = path.join(moduleRoot, 'Microsoft.PowerShell.Utility');
    fs.mkdirSync(shadow);
    fs.writeFileSync(path.join(shadow, 'Microsoft.PowerShell.Utility.psm1'), "throw 'wrong-shell-module-was-imported'", 'utf8');
    const saved = process.env.PSModulePath;
    try {
      process.env.PSModulePath = moduleRoot;
      // Import by module NAME (not an absolute path) to prove PSModulePath was
      // retained. Discovering an unknown command first scans unrelated modules
      // installed on the runner, which is not part of this environment contract.
      const row = await f.manager.start(f.owner, { requestId: 'module-path', script: "Write-Output 'core-module-ok'; Import-Module BlackHoleFixture -ErrorAction Stop; Get-BlackHoleFixture; exit 7" }, async () => {});
      const ended = await wait(() => f.status(row.processId), value => ['exited', 'failed', 'unknown'].includes(value.state));
      assert.equal(ended.exitCode, 7, JSON.stringify(ended));
      assert.match(ended.output.stdout, /core-module-ok/);
      assert.match(ended.output.stdout, /custom-module-ok/);
      assert.doesNotMatch(ended.output.stderr, /wrong-shell-module/);
    } finally {
      if (saved === undefined) delete process.env.PSModulePath; else process.env.PSModulePath = saved;
    }
  });
  test('PowerShell startup configures UTF-8 without a blocking console utility', () => {
    const args = powerShellArgs("Write-Output 'fixture'");
    const decoded = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    assert.match(decoded, /OutputEncoding/);
    assert.match(decoded, /UTF8/);
    assert.doesNotMatch(decoded, /chcp\.com/i, 'the wrapper must not run a shared-console mutation before user code');
  });
  for (const mode of ['read-only', 'workspace-write', 'danger-full-access']) test('PowerShell text remains UTF-8 without chcp: ' + mode, { timeout: 15000 }, async t => {
    const f = fixture(t, mode);
    const row = await f.manager.start(f.owner, { requestId: 'unicode-powershell', script: "Write-Output '中文-output'; Write-Error -ErrorAction Continue '中文-error'; exit 7" }, async () => {});
    const ended = await wait(() => f.status(row.processId), value => ['exited', 'failed', 'unknown'].includes(value.state));
    assert.equal(ended.exitCode, 7, JSON.stringify(ended));
    assert.match(ended.output.stdout, /中文-output/);
    assert.match(ended.output.stderr, /中文-error/);
  });
  test('restricted native startup hides appearance without isolating its console', () => {
    let observed;
    const api = { ...win32(),
      createProcessAsUserW(...args) {
        // Intercept at the OS boundary: no user child is launched by this contract check.
        observed = { creation: args[6], flags: decodeUint32At(args[9], 60), show: decodeUint16At(args[9], 64) };
        return 0;
      },
      getLastError() { return 5; },
    };
    assert.throws(() => spawnSandboxed(api, 0n, { command: 'never-executed-fixture', args: [], cwd: process.cwd() }), /CreateProcessAsUserW/);
    assert.ok(observed);
    assert.equal(observed.creation & 0x08000000, 0, 'CREATE_NO_WINDOW can fail restricted-token DLL initialization');
    assert.equal(observed.creation & 0x10, 0, 'do not create an isolated console');
    assert.equal(observed.creation & 0x4, 0x4, 'retain CREATE_SUSPENDED until Job assignment');
    assert.equal(observed.flags & 0x100, 0x100, 'retain STARTF_USESTDHANDLES');
    assert.equal(observed.flags & 0x1, 0x1, 'use STARTF_USESHOWWINDOW for presentation only');
    assert.equal(observed.show, 0, 'SW_HIDE');
  });
  test('managed processes reject Store-brokered shell paths before creating a Job or child', () => {
    const forbidden = [String.raw`C:\Users\fixture\AppData\Local\Microsoft\WindowsApps\pwsh.exe`, String.raw`C:\Program Files\WindowsApps\Microsoft.PowerShell_fixture\pwsh.exe`];
    for (const executable of forbidden) {
      let called = false;
      assert.throws(() => startWindowsProcess({}, { output() { called = true; }, exit() { called = true; }, fault() { called = true; } },
        { executable, syntax: 'powershell', version: null }), error => error.code === 'shell_unavailable' && /Job ownership/.test(error.message));
      assert.equal(called, false);
    }
  });
  // Run both native pipe implementations against inbox Windows PowerShell and pwsh.
  for (const bin of new Set([managedPowerShellPath(), detectPwshBin()].filter(Boolean))) {
    for (const confined of [false, true]) test(`finite stderr stays with its command: ${bin}, confined=${confined}`, { timeout: 30000 }, async t => {
      const f = fixture(t);
      const options = { bin, cwd: f.root, workspaceRoot: f.root, mode: 'workspace-write' };
      const shell = confined ? new SandboxedPersistentShell(options) : new PersistentShell(options);
      let shellPid;
      try {
        const ready = await shell.run('Write-Output $PID', 5000);
        assert.equal(ready.exit_code, 0, JSON.stringify(ready)); shellPid = Number(ready.stdout.trim());
        assert.ok(Number.isSafeInteger(shellPid) && shellPid > 0);
        for (let i = 0; i < 12; i++) {
          const out = `BH_OUT_${i}_END`, err = `BH_ERR_${i}_END`;
          const code = `process.stdout.write('${out}');process.stderr.write('${err}');process.exit(${i % 2 ? 7 : 0})`;
          const result = await shell.run(`& ${quote(process.execPath)} -e ${quote(code)}`, 5000);
          assert.equal(result.exit_code, i % 2 ? 7 : 0, JSON.stringify(result));
          assert.equal(result.stdout, out); assert.ok(result.stderr.includes(err), JSON.stringify(result));
          assert.ok(!result.stdout.includes(err)); assert.doesNotMatch(result.stderr, /BH_END_/);
          const next = await shell.run("Write-Output 'next-command'", 5000);
          assert.equal(next.exit_code, 0, JSON.stringify(next)); assert.equal(next.stdout.trim(), 'next-command');
          assert.equal(next.stderr, '', 'previous stderr must not spill into a quiet command');
        }
      } finally {
        shell.dispose();
        if (Number.isSafeInteger(shellPid) && shellPid > 0) await wait(() => alive(shellPid), value => !value, 5000);
      }
    });
  }
  test('shared native plumbing preserves the existing persistent-shell contract', { skip: !processSupported, timeout: 15000 }, async t => {
    const f = fixture(t);
    const shell = new SandboxedPersistentShell({ bin: managedPowerShellPath(), cwd: f.root, workspaceRoot: f.root, mode: 'workspace-write' });
    // dispose() closes the native Job synchronously; Windows releases its cwd after process exit.
    let shellPid;
    try {
      const first = await shell.run("$env:BH_SYNTHETIC_MARK = 'legacy-state'; Write-Output 'first-result'; Write-Output $PID", 5000);
      shellPid = Number(first.stdout.trim().split(/\r?\n/).at(-1));
      assert.equal(first.exit_code, 0, JSON.stringify(first)); assert.match(first.stdout, /first-result/);
      assert.ok(Number.isSafeInteger(shellPid) && shellPid > 0, 'Owned shell PID must be observable');
      const second = await shell.run('Write-Output $env:BH_SYNTHETIC_MARK', 5000);
      assert.equal(second.exit_code, 0, JSON.stringify(second)); assert.match(second.stdout, /legacy-state/);
    } finally {
      shell.dispose();
      if (Number.isSafeInteger(shellPid) && shellPid > 0) await wait(() => alive(shellPid), value => !value, 5000);
    }
  });
  test('configured Git usr/bin PATH is shared by finite exec and managed process shells', { skip: !processSupported, timeout: 20000 }, async t => {
    const f = fixture(t), tools = path.join(f.root, 'git-usr-bin'); fs.mkdirSync(tools);
    fs.writeFileSync(path.join(tools, 'bh-path-probe.cmd'), '@echo configured-path\r\n');
    const previous = process.env.BLACKHOLE_GIT_USR_BIN; process.env.BLACKHOLE_GIT_USR_BIN = tools;
    t.after(() => { if (previous === undefined) delete process.env.BLACKHOLE_GIT_USR_BIN; else process.env.BLACKHOLE_GIT_USR_BIN = previous; });
    const shell = new SandboxedPersistentShell({ bin: managedPowerShellPath(), cwd: f.root, workspaceRoot: f.root, mode: 'workspace-write' });
    try {
      const finite = await shell.run('bh-path-probe.cmd', 5000);
      assert.equal(finite.exit_code, 0, JSON.stringify(finite)); assert.match(finite.stdout, /configured-path/);
    } finally { shell.dispose(); }
    const row = await f.manager.start(f.owner, { requestId: 'configured-path', script: 'bh-path-probe.cmd' }, async () => {});
    const ended = await wait(() => f.status(row.processId), value => ['exited', 'failed', 'unknown'].includes(value.state));
    assert.equal(ended.exitCode, 0, JSON.stringify(ended)); assert.match(ended.output.stdout, /configured-path/);
  });

  test('Windows exec and process repair a VS Code-style PATH without System32', { skip: !processSupported, timeout: 30000 }, async t => {
    const f = fixture(t), emptyPath = path.join(f.root, 'vscode-helper-only'); fs.mkdirSync(emptyPath);
    const keys = ['PATH', 'Path', 'path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'ComSpec', 'BLACKHOLE_RG', 'BLACKHOLE_GIT_USR_BIN'];
    const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    const root = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
    try {
      process.env.PATH = emptyPath; delete process.env.Path; delete process.env.path;
      process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD'; process.env.SystemRoot = root; process.env.WINDIR = root;
      process.env.ComSpec = path.join(root, 'System32', 'cmd.exe'); delete process.env.BLACKHOLE_RG; delete process.env.BLACKHOLE_GIT_USR_BIN;
      const shell = new SandboxedPersistentShell({ bin: managedPowerShellPath(), cwd: f.root, workspaceRoot: f.root, mode: 'workspace-write' });
      try {
        const finite = await shell.run("chcp.com 65001 > $null; Write-Output 'exec-system32-ok'", 5000);
        assert.equal(finite.exit_code, 0, JSON.stringify(finite)); assert.match(finite.stdout, /exec-system32-ok/);
      } finally { shell.dispose(); }
      const row = await f.manager.start(f.owner, { requestId: 'system32-path', script: "Get-Command chcp.com -ErrorAction Stop | Out-Null; cmd.exe /d /c ver; Write-Output 'process-system32-ok'" }, async () => {});
      let ended;
      try {
        ended = await wait(() => f.status(row.processId), value => ['exited', 'failed', 'unknown'].includes(value.state));
      } catch (error) {
        // Observe only this synthetic task before teardown; do not relax its deadline.
        // Restore the observer's environment first; the child keeps its own launch snapshot.
        for (const key of keys) { const value = previous[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }
        const command = `Get-CimInstance Win32_Process -Filter 'ProcessId=${row.pid} OR ParentProcessId=${row.pid}' | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress`;
        const diagnostic = spawnSync(managedPowerShellPath(), ['-NoProfile', '-NonInteractive', '-Command', command], {
          env: process.env, windowsHide: true, encoding: 'utf8', timeout: 5000,
        });
        t.diagnostic('synthetic PATH task snapshot: ' + (diagnostic.stdout || diagnostic.stderr || diagnostic.error?.message || '').slice(-8192));
        throw error;
      }
      assert.equal(ended.exitCode, 0, JSON.stringify(ended)); assert.match(ended.output.stdout, /process-system32-ok/);
    } finally {
      for (const key of keys) { const value = previous[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  });
  for (const mode of ['read-only', 'workspace-write', 'danger-full-access']) test('native independent Job and output lifecycle: ' + mode, { skip: !processSupported, timeout: 30000 }, async t => {
    const f = fixture(t, mode), row = await f.start('server', ['tree']);
    const ready = await wait(() => f.status(row.processId), x => servers(x).length === 2 || ['failed', 'exited', 'unknown'].includes(x.state));
    assert.equal(ready.state, 'running', JSON.stringify(ready)); assert.match(ready.output.stdout, /Ready 中文/);
    const records = servers(ready); assert.equal(records.length, 2);
    for (const x of records) assert.equal(await (await fetch('http://127.0.0.1:' + x.port)).text(), 'process fixture ' + x.pid);
    const stopped = await f.manager.stop(f.owner.sessionId, row.processId); assert.equal(stopped.state, 'exited', JSON.stringify(stopped));
    await wait(() => records.some(x => alive(x.pid)), value => !value, 5000);
    for (const x of records) await assert.rejects(fetch('http://127.0.0.1:' + x.port));
  });
  test('three native tasks run together; stopping A leaves B/C reachable', { skip: !processSupported, timeout: 30000 }, async t => {
    const f = fixture(t); const rows = await Promise.all(['a', 'b', 'c'].map(name => f.start(name, ['server'])));
    const ready = await Promise.all(rows.map(r => f.ready(r.processId)));
    assert.ok(ready.every(x => x.state === 'running'), JSON.stringify(ready));
    const ports = ready.map(r => servers(r)[0].port); assert.equal(new Set(ports).size, 3);
    await f.manager.stop(f.owner.sessionId, rows[0].processId);
    await assert.rejects(fetch('http://127.0.0.1:' + ports[0]));
    for (const port of ports.slice(1)) assert.equal((await fetch('http://127.0.0.1:' + port)).status, 200);
  });
  test('native immediate failure, tail stderr and port conflict remain queryable', { skip: !processSupported, timeout: 30000 }, async t => {
    const f = fixture(t), failed = await f.start('exit7', ['exit']);
    const ended = await wait(() => f.status(failed.processId), r => r.state !== 'running' && r.state !== 'starting');
    assert.equal(ended.exitCode, 7, JSON.stringify(ended)); assert.match(ended.output.stderr, /最后错误/);
    const a = await f.start('a', ['server']), ready = await f.ready(a.processId), port = servers(ready)[0].port;
    const b = await f.start('b', ['server', port]); const conflict = await wait(() => f.status(b.processId), r => r.state === 'exited' || r.state === 'failed');
    assert.equal(conflict.exitCode, 1); assert.match(conflict.output.stderr, /EADDRINUSE/);
    assert.equal((await fetch('http://127.0.0.1:' + port)).status, 200);
  });
  test('native child receives minimal environment, and read-only denies workspace writes', { skip: !processSupported, timeout: 30000 }, async t => {
    const f = fixture(t, 'read-only'); process.env.BH_PROCESS_TEST_SECRET = 'must-not-inherit'; t.after(() => delete process.env.BH_PROCESS_TEST_SECRET);
    const a = await f.start('env', ['environment']), environment = await wait(() => f.status(a.processId), r => r.state === 'exited' || r.state === 'failed');
    assert.equal(environment.exitCode, 0, JSON.stringify(environment)); const values = JSON.parse(environment.output.stdout.trim());
    assert.equal(values.secret, null); assert.equal(values.nodeOptions, null); assert.equal(values.electron, null); assert.equal(values.cwd, f.root);
    const target = path.join(f.root, 'not-allowed.txt'), b = await f.start('write', ['write', target]);
    const write = await wait(() => f.status(b.processId), r => r.state === 'exited' || r.state === 'failed');
    assert.equal(write.exitCode, 13, JSON.stringify(write)); assert.equal(fs.existsSync(target), false);
  });
  test('killing only the owning daemon test process closes its Job and descendants', { skip: !processSupported, timeout: 30000 }, async t => {
    fs.mkdirSync('.cache/tests', { recursive: true }); const root = fs.realpathSync(fs.mkdtempSync('.cache/tests/process-crash-'));
    const child = fork(fileURLToPath(import.meta.url), [], { env: { ...process.env, BH_PROCESS_CRASH_CHILD: '1', BH_PROCESS_FIXTURE_ROOT: root }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
    t.after(() => { child.kill(); fs.rmSync(root, { recursive: true, force: true }); });
    let error = ''; child.stderr.on('data', b => { error += b; });
    const result = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error(error || 'crash fixture timeout')), 15000); child.once('message', value => { clearTimeout(timer); resolve(value); }); child.once('error', e => { clearTimeout(timer); reject(e); }); });
    assert.equal(result.servers.length, 2, JSON.stringify(result)); child.kill();
    await wait(() => result.servers.some(x => alive(x.pid)), x => !x, 5000);
    for (const x of result.servers) await assert.rejects(fetch('http://127.0.0.1:' + x.port));
  });
}
