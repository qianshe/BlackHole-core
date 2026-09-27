// Native HTTP discovery against the shipped bundle. No SDK install is needed
// on the target OS, and no account, user DB, public tunnel or command is used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../packages/vscode/dist/daemon/cli.js', import.meta.url));
const posix = ['linux', 'darwin'].includes(process.platform);
const cases = [
  ['native environment', {}],
  ...(posix ? [
    ['GUI PATH without system shells', { PATH: '/__blackhole_missing_gui_path__', SHELL: '/bin/sh' }],
    ['removed terminal profile', { BLACKHOLE_PROCESS_SHELL: '/__blackhole_removed_profile__/zsh', SHELL: '/bin/sh' }],
  ] : []),
];

for (const [label, extra] of cases) test('packed execution discovery: ' + label, { timeout: 35000 }, async t => {
  assert.ok(fs.existsSync(entry), 'Build the VS Code extension before running this check');
  fs.mkdirSync('.cache/tests', { recursive: true });
  const root = fs.realpathSync(fs.mkdtempSync('.cache/tests/packed-execution-'));
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ['PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'LANG'].includes(key.toUpperCase())));
  Object.assign(env, { HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root,
    TEMP: root, TMP: root, TMPDIR: root, ELECTRON_RUN_AS_NODE: '1', BLACKHOLE_TUNNEL: 'off',
    BLACKHOLE_SEMANTIC: 'off', BLACKHOLE_SKILLS_DIR: '',
    BLACKHOLE_PROXY_CONFIG: path.join(root, 'missing-proxies.yaml'), ...extra });
  const child = spawn(process.execPath, [entry, 'serve', '--port', String(port), '--db', path.join(root, 'fixture.db'), '--tunnel', 'off'],
    { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stderr = '', spawnError;
  child.stdout.resume();
  child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-8192); });
  child.on('error', error => { spawnError = error; });
  const closed = new Promise(resolve => child.once('close', resolve));
  let mcpUrl, connection, protocolVersion = '2025-03-26', sequence = 0;
  t.after(async () => {
    if (mcpUrl && connection) await fetch(mcpUrl, { method: 'DELETE',
      headers: { 'Mcp-Session-Id': connection, 'MCP-Protocol-Version': protocolVersion }, signal: AbortSignal.timeout(1000) }).catch(() => {});
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      const force = setTimeout(() => child.kill('SIGKILL'), 3000);
      await closed; clearTimeout(force);
    } else await closed;
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  let health;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null) throw Error('Fixture exited before health: ' + stderr);
    try {
      const response = await fetch(base + '/api/health', { signal: AbortSignal.timeout(600) });
      if (response.ok) { health = await response.json(); break; }
    } catch { /* bounded startup wait */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(health?.ok, true, stderr);
  const runtime=health.execution_runtime;
  assert.ok(runtime,'health must expose execution runtime diagnostics');
  assert.equal(runtime.platform,process.platform);assert.equal(runtime.arch,process.arch);
  assert.deepEqual(runtime.execution_tools,['exec','process']);assert.equal(runtime.process_available,true);
  assert.equal(runtime.sandbox.fail_closed,true);
  if(process.platform==='win32'){
    assert.deepEqual(runtime.sandbox,{backend:'windows-acl',status:'deferred',reason:'checked_per_launch',detail:null,fail_closed:true});
    assert.deepEqual(runtime.process_management,{owner:'job-object',cleanup_guarantee:'kernel-owned'});
  }else{
    assert.equal(runtime.sandbox.backend,process.platform==='darwin'?'seatbelt':'bubblewrap');
    assert.ok(['available','unavailable'].includes(runtime.sandbox.status));
    assert.ok(path.isAbsolute(runtime.exec_shell));assert.ok(path.isAbsolute(runtime.process_shell));
    assert.deepEqual(runtime.process_management,{owner:'process-group-supervisor',cleanup_guarantee:'confirmed-or-unknown'});
  }
  mcpUrl = new URL(health.mcp_url);
  assert.equal(mcpUrl.origin, base, 'never follow a public or user MCP endpoint');
  async function rpc(method, params, notify = false, expectedStatus = 200) {
    const id = notify ? undefined : ++sequence;
    const response = await fetch(mcpUrl, { method: 'POST', signal: AbortSignal.timeout(5000),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
        ...(connection ? { 'Mcp-Session-Id': connection, 'MCP-Protocol-Version': protocolVersion } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params }) });
    if (expectedStatus !== 200) {
      assert.equal(response.status, expectedStatus, `${method}: HTTP ${response.status}`);
      return response.json();
    }
    assert.ok(response.ok, `${method}: HTTP ${response.status}`);
    connection = response.headers.get('mcp-session-id') ?? connection;
    if (notify) { await response.body?.cancel(); return; }
    const text = await response.text();
    const messages = response.headers.get('content-type')?.includes('text/event-stream')
      ? text.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5).trim()))
      : [JSON.parse(text)];
    const reply = messages.find(value => value.id === id);
    assert.ok(reply, method + ': response missing');
    assert.equal(reply.error, undefined, JSON.stringify(reply.error));
    return reply.result;
  }
  const initialized = await rpc('initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'packed-execution-fixture', version: '1' } });
  protocolVersion = initialized.protocolVersion;
  await rpc('notifications/initialized', {}, true);
  const names = [], tools = [];
  let cursor;
  const seen = new Set();
  do {
    const catalog = await rpc('tools/list', cursor ? { cursor } : {});
    tools.push(...catalog.tools);
    names.push(...catalog.tools.map(tool => tool.name));
    cursor = catalog.nextCursor;
    assert.ok(!cursor || !seen.has(cursor), 'discovery cursor must advance');
    if (cursor) seen.add(cursor);
  } while (cursor);
  // The packed daemon must expose the COMPLETE native tool surface, not just
  // exec/process. show stays hidden for script clients (Apps-only), and
  // context_search is legitimately absent with BLACKHOLE_SEMANTIC=off; every
  // other tool missing here means users lose it after installing the VSIX.
  assert.deepEqual([...names].sort(), ['editor', 'exec', 'guide', 'process', 'proxy', 'skill', 'todo'],
    'bundled daemon tool surface drifted: ' + JSON.stringify(names));
  assert.equal(initialized.serverInfo.version, health.version);
  const exec = tools.find(tool => tool.name === 'exec'), background = tools.find(tool => tool.name === 'process');
  assert.match(exec.description, /Shell:/);
  if (extra.SHELL === '/bin/sh') {
    assert.match(exec.description, /Shell: sh\./);
    assert.match(background.description, /Shell: sh;/);
  }
  // The shipped CLI requires a verified subscription for ALL calls, including
  // guide. This account-free fixture verifies that discovery remains available
  // without weakening that gate; positive execution is tested by native fixtures.
  const sessionId = '123456789012345678901234567890123456789';
  for (const [name, args] of [['guide', {}], ['exec', { sessionId, command: 'echo must-not-run' }], ['process', { sessionId, command: 'list' }]]) {
    const reply = await rpc('tools/call', { name, arguments: args }, false, 403);
    assert.match(reply.error.message, /^entitlement_verification_required:/);
  }
  t.diagnostic(JSON.stringify({ platform: process.platform, arch: process.arch, daemon_version: health.version,
    execution_tools: ['exec', 'process'].filter(name => names.includes(name)), subscriptionGatePreserved: true }));
});
