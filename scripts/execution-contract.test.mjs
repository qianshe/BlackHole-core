import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startFixture } from './fixtures/process-harness.mjs';

import { resolveWindowsCommandShell } from '../dist/workspace/windows-env.js';
const supported = ['win32', 'linux', 'darwin'].includes(process.platform);
const data = reply => reply.structuredContent ?? JSON.parse(reply.content[0].text);

test('exec is the only finite-command tool and preserves platform execution semantics', { skip: !supported, timeout: 30000 }, async t => {
  const f = await startFixture(t), session = await f.session(), client = await f.connect(session);
  const catalog = (await client.listTools()).tools;
  const exec = catalog.find(tool => tool.name === 'exec');
  assert.ok(exec, 'canonical exec tool must be registered');
  assert.equal(catalog.filter(tool => ['pwsh', 'bash', 'cmd'].includes(tool.name)).length, 0, 'platform shell names must not be separate MCP tools');
  assert.match(exec.description, /Shell:/); assert.doesNotMatch(exec.description, /alias/i);
  const manual = data(await client.callTool({ name: 'guide', arguments: { sessionId: session.session_id } })).manual;
  assert.match(manual, /commands\/tests\/build\/Git → exec/);
  assert.doesNotMatch(manual, /commands\/tests\/build\/Git → (pwsh|bash|cmd)/);
  const sub = path.join(f.project, 'sub'); fs.mkdirSync(sub);
  const call = async command => data(await client.callTool({ name: 'exec', arguments: { sessionId: session.session_id, command, timeout_ms: 5000 } }));
  const windows = process.platform === 'win32';
  const first = await call(windows ? "$env:BH_EXEC_TEST='shared'; Set-Location sub; Write-Output 'first'" : "export BH_EXEC_TEST=shared; cd sub; printf 'first\\n'");
  assert.equal(first.exit_code, 0, JSON.stringify(first)); assert.match(first.stdout, /first/);
  const second = await call(windows ? 'Write-Output $env:BH_EXEC_TEST; Get-Location' : 'printf "value=%s\\n" "$BH_EXEC_TEST"; pwd');
  assert.equal(second.exit_code, 0, JSON.stringify(second)); assert.equal(fs.realpathSync(second.cwd), fs.realpathSync(sub));
  if (windows) assert.match(second.stdout, /shared/); else assert.match(second.stdout, /value=\n/);
  const third = await call(windows ? "Write-Output 'still-alive'" : "printf 'still-alive\\n'");
  assert.equal(third.exit_code, 0); assert.match(third.stdout, /still-alive/);
  if (windows) for (let i = 0; i < 4; i++) {
    const err = `BH_MCP_STDERR_${i}_END`;
    const result = await call(`node -e "console.log('native-output');console.error('${err}');process.exit(7)"`);
    assert.equal(result.exit_code, 7, JSON.stringify(result)); assert.match(result.stdout, /native-output/);
    assert.ok(result.stderr.includes(err), JSON.stringify(result)); assert.doesNotMatch(result.stderr, /BH_END_/);
    const quiet = await call("Write-Output 'quiet-command'");
    assert.equal(quiet.exit_code, 0); assert.equal(quiet.stdout.trim(), 'quiet-command'); assert.equal(quiet.stderr, '');
  }
});

test('execution environment describes actual interpreter/state separately for finite and background work', async () => {
  const { detectExecutionEnvironment } = await import('../dist/execution.js');
  const environment = detectExecutionEnvironment();
  assert.equal(environment.platform, process.platform); assert.equal(environment.arch, process.arch);
  assert.ok(environment.exec.shell.executable); assert.ok(environment.exec.shell.syntax);
  assert.ok(environment.process.shell.executable); assert.ok(environment.process.shell.syntax);
  assert.equal(environment.exec.state, process.platform === 'win32' && environment.exec.shell.syntax === 'powershell' ? 'session' : 'cwd-only');
  assert.equal(environment.process.state, 'independent');
  if(process.platform==='win32'){
    assert.deepEqual(environment.sandbox,{backend:'windows-acl',status:'deferred',reason:'checked_per_launch',detail:null});
  }else{
    assert.equal(environment.sandbox.backend,process.platform==='darwin'?'seatbelt':'bubblewrap');
    assert.ok(['available','unavailable'].includes(environment.sandbox.status));
    assert.equal(environment.sandbox.status==='available',environment.sandbox.reason===null);
  }
  if (process.platform !== 'win32') {
    assert.ok(['bash', 'zsh', 'sh'].includes(environment.exec.shell.syntax));
    assert.equal(environment.exec.shell.syntax, environment.exec.adapter.name);
    assert.ok(path.isAbsolute(environment.exec.shell.executable));
    assert.deepEqual(environment.process.shell, environment.exec.shell);
  }
});


test('Windows shell discovery survives a VS Code-style PATH without System32', { skip: process.platform !== 'win32' }, () => {
  const root = process.env.SystemRoot ?? process.env.WINDIR;
  const comSpec = process.env.ComSpec ?? (root ? path.join(root, 'System32', 'cmd.exe') : '');
  assert.ok(root && fs.existsSync(comSpec), 'Windows system shell fixture must exist');
  fs.mkdirSync('.cache/tests', { recursive: true });
  const emptyPath = fs.realpathSync(fs.mkdtempSync('.cache/tests/execution-empty-path-'));
  try {
    // Node deduplicates Windows environment names case-insensitively. Remove
    // all host spellings before adding fixture overrides, otherwise PROGRAMFILES
    // can win over ProgramFiles and accidentally discover the runner's Git Bash.
    const overridden = new Set(['path', 'pathext', 'systemroot', 'windir', 'comspec', 'programfiles', 'programfiles(x86)', 'localappdata', 'blackhole_process_shell', 'blackhole_pwsh', 'blackhole_bash', 'blackhole_rg', 'blackhole_git_usr_bin']);
    const isolatedHost = Object.fromEntries(Object.entries(process.env).filter(([key]) => !overridden.has(key.toLowerCase())));
    const env = { ...isolatedHost, PATH: emptyPath, PATHEXT: '.COM;.EXE;.BAT;.CMD', SystemRoot: root, WINDIR: root, ComSpec: comSpec,
      ProgramFiles: emptyPath, 'ProgramFiles(x86)': emptyPath, LOCALAPPDATA: emptyPath,
      BLACKHOLE_PROCESS_SHELL: path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') };
    assert.equal(new Set(Object.keys(env).map(key => key.toLowerCase())).size, Object.keys(env).length, 'fixture environment keys must not collide');
    const script = `
      import { detectExecutionEnvironment } from './dist/execution.js';
      import { detectShell } from './dist/workspace/shell.js';
      const execution = detectExecutionEnvironment();
      const adapter = detectShell();
      const command = adapter.toArgv('echo ok');
      console.log(JSON.stringify({ execution, adapter: { name: adapter.name, executable: adapter.executable }, argv0: command.argv[0] }));
      command.cleanup?.();
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: process.cwd(), env, encoding: 'utf8', timeout: 15000 });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    const result = JSON.parse(child.stdout.trim());
    assert.equal(result.execution.exec.shell.syntax, 'powershell');
    assert.ok(path.isAbsolute(result.execution.exec.shell.executable));
    // A separately discoverable Git Bash remains a valid preference. Verify
    // the absolute Windows fallback itself instead of requiring it to outrank Bash.
    assert.ok(['bash', 'cmd'].includes(result.adapter.name), JSON.stringify(result));
    const fallback = resolveWindowsCommandShell(env);
    assert.ok(fallback, 'absolute command processor fallback must remain available');
    assert.equal(fallback.toLowerCase(), comSpec.toLowerCase());
    const fallbackRun = spawnSync(fallback, ['/d', '/c', 'echo cmd-fallback-ok'], { env, encoding: 'utf8', timeout: 5000 });
    assert.equal(fallbackRun.status, 0, fallbackRun.error?.message || fallbackRun.stderr);
    assert.match(fallbackRun.stdout, /cmd-fallback-ok/);
    assert.equal(result.argv0, result.adapter.executable, 'adapter argv must use its verified interpreter');
    if (result.adapter.name === 'cmd') assert.equal(result.argv0.toLowerCase(), comSpec.toLowerCase());
  } finally { fs.rmSync(emptyPath, { recursive: true, force: true }); }
});

for (const preference of ['absent', 'unrunnable', 'store']) test('Windows background execution chooses a directly managed shell when preference is ' + preference, { skip: process.platform !== 'win32' }, t => {
  fs.mkdirSync('.cache/tests', { recursive: true });
  const root = fs.realpathSync(fs.mkdtempSync('.cache/tests/execution-preference-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fake = path.join(root, 'pwsh.exe');
  fs.writeFileSync(fake, 'not an executable');
  const store = path.join(root, 'WindowsApps', 'pwsh.exe');
  fs.mkdirSync(path.dirname(store)); fs.copyFileSync(fake, store);
  const env = { ...process.env, BLACKHOLE_PROCESS_SHELL: preference === 'store' ? store : preference === 'unrunnable' ? fake : '' };
  const script = `import { detectExecutionEnvironment } from './dist/execution.js'; const e=detectExecutionEnvironment(); console.log(JSON.stringify({exec:e.exec.shell,process:e.process}));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8', timeout: 20000 });
  assert.equal(child.status, 0, child.error?.message || child.stderr);
  const result = JSON.parse(child.stdout.trim());
  assert.equal(result.process.available, true, JSON.stringify(result));
  assert.doesNotMatch(result.process.shell.executable, /[\\/]WindowsApps[\\/]/i, 'a runnable Store alias is not sufficient proof of Job ownership');
  assert.notEqual(result.process.shell.executable, fake);
  assert.ok(path.isAbsolute(result.process.shell.executable));
});


test('semantic search reuses the separately injected BlackHole rg helper', () => {
  fs.mkdirSync('.cache/tests', { recursive: true });
  const root = fs.realpathSync(fs.mkdtempSync('.cache/tests/semantic-rg-env-'));
  const rg = path.join(root, process.platform === 'win32' ? 'rg.exe' : 'rg'); fs.writeFileSync(rg, 'fixture');
  try {
    const script = `import { resolveRg } from './dist/semantic/executor.js'; console.log(JSON.stringify(resolveRg(process.env)));`;
    const env = { ...process.env, BLACKHOLE_RG: rg, BH_SEMANTIC_RG: '', PATH: '' };
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: process.cwd(), env, encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    const result = JSON.parse(child.stdout.trim()); assert.equal(path.resolve(result.bin), path.resolve(rg)); assert.equal(result.source, 'env');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
