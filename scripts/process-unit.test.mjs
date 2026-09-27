import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ProcessOutput } from '../dist/process/output.js';
import { ProcessManager } from '../dist/process/manager.js';


const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(r => setImmediate(r));
function fixture(t, options = {}) {
  fs.mkdirSync('.cache/tests', { recursive: true });
  const root = fs.realpathSync(fs.mkdtempSync('.cache/tests/process-'));
  const children = [];
  const backend = (spec, cb) => {
    const item = { spec, cb, stops: 0 }; children.push(item);
    return { pid: 1000 + children.length, stop: async () => { item.stops++; cb.exit({ exitCode: 1, cleanupConfirmed: true }); } };
  };
  const manager = new ProcessManager({ daemonId: 'unit-daemon', backend, ...options });
  const owner = { sessionId: 'session-a', workspace: root, mode: 'workspace-write', writableDirs: [] };
  t.after(async () => { await manager.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return { manager, owner, children, root, start: (id, extra = {}, authorize = async () => {}) => manager.start(owner, { requestId: id, script: 'echo test', ...extra }, authorize) };
}
test('recent output streams decode split UTF-8 and sanitize split terminal controls', () => {
  const out = new ProcessOutput(['private-secret']);
  const bytes = Buffer.from('涓枃杈撳嚭\n'); for (const b of bytes) out.push('stdout', Buffer.from([b]));
  out.push('stderr', Buffer.from('warn\n'));
  out.push('stdout', Buffer.from('\x1b]52;c;do-not-copy')); out.push('stdout', Buffer.from('\x1b\\safe\x1b[31mred\x1b[0m'));
  out.push('stdout', Buffer.from('private-')); out.push('stdout', Buffer.from('secret!')); out.end();
  const snap = out.snapshot(); assert.equal(snap.stdout, '涓枃杈撳嚭\nsafered[redacted]!'); assert.equal(snap.stderr, 'warn\n');
  assert.ok(!snap.stdout.includes('\x1b')); assert.ok(!snap.stdout.includes('private-secret'));
});
test('known-secret protection does not hide a complete ready line until exit', () => {
  const out = new ProcessOutput(['synthetic-session-credential-0123456789']);
  out.push('stdout', Buffer.from('Ready on http://127.0.0.1:8794\n'));
  assert.match(out.snapshot().stdout, /Ready on/);
});
test('output is bounded, retains stderr during stdout floods and exposes cursor gaps', () => {
  const out = new ProcessOutput([], 1024); out.push('stderr', Buffer.from('important failure'));
  for (let i = 0; i < 5000; i++) out.push('stdout', Buffer.from('涓枃 ' + i + '\n'));
  const snap = out.snapshot(1024); assert.ok(snap.truncated); assert.equal(snap.stderr, 'important failure');
  assert.ok(Buffer.byteLength(snap.stdout) <= 512); assert.ok(!snap.stdout.includes('\ufffd'));
  const first = out.read(0, 128); assert.ok(first.gap); assert.ok(first.events.length > 0);
  const next = out.read(first.next, 128); assert.ok(next.events.every(e => e.seq > first.next));
});
test('Windows execution PATH repairs MSYS/hybrid input and resolves managed/system tools', async () => {
  const { windowsExecutionPath, resolveWindowsCommandShell, resolveWindowsExecutable } = await import('../dist/workspace/windows-env.js');
  const configured = 'F:\\Git\\usr\\bin', rg = 'C:\\VSCode\\rg\\rg.exe', root = 'C:\\Windows', cmd = root + '\\System32\\cmd.exe';
  const host = { Path: '/usr/bin:/d/tools/bin:/e/node/bin', PATHEXT: '.COM;.EXE;.BAT;.CMD', SystemRoot: root, ComSpec: cmd,
    BLACKHOLE_GIT_USR_BIN: configured, BLACKHOLE_RG: rg };
  assert.equal(windowsExecutionPath(host.Path, host), configured + ';C:\\VSCode\\rg;d:\\tools\\bin;e:\\node\\bin;C:\\Windows\\System32;C:\\Windows');
  const hybrid = 'C:\\VSCode\\rg;/d/tools/bin:/e/node/bin';
  assert.equal(windowsExecutionPath(hybrid, host), configured + ';C:\\VSCode\\rg;d:\\tools\\bin;e:\\node\\bin;C:\\Windows\\System32;C:\\Windows');
  const files = new Set([cmd, rg, configured + '\\grep.exe'].map(value => value.toLowerCase()));
  const exists = file => files.has(file.toLowerCase());
  assert.equal(resolveWindowsCommandShell(host, exists), cmd);
  assert.equal(resolveWindowsExecutable('rg', host, exists), rg);
  assert.equal(resolveWindowsExecutable('grep', host, exists), configured + '\\grep.exe');
});

test('Windows executable resolver accepts addressable aliases without weakening missing-path checks', async () => {
  const { resolveWindowsExecutable } = await import('../dist/workspace/windows-env.js');
  const alias = 'C:\\Users\\test\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe';
  const normal = 'C:\\Tools\\tool.exe';
  const host = { Path: 'C:\\Users\\test\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Tools', PATHEXT: '.COM;.EXE;.BAT;.CMD' };
  const addressable = file => file.toLowerCase() === alias.toLowerCase() || file.toLowerCase() === normal.toLowerCase();
  assert.equal(resolveWindowsExecutable('pwsh.exe', host, addressable), alias);
  assert.equal(resolveWindowsExecutable('tool.exe', host, addressable), normal);
  assert.equal(resolveWindowsExecutable('missing.exe', host, addressable), null);
});
test('native environment is explicit and excludes host secrets and loader hooks', { skip: process.platform !== 'win32' }, async () => {
  const { processEnvironment, powerShellArgs } = await import('../dist/process/windows.js');
  const { powerShellEnvironment } = await import('../dist/workspace/pwsh.js');
  const { shellEnvironment } = await import('../dist/workspace/posix-sandbox.js');
  const { encodeEnvironment } = await import('../dist/win32/acl-sandbox.js');
  const host = { Path: 'bin', PATHEXT: '.COM;.EXE;.BAT;.CMD', SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    BLACKHOLE_RG: 'C:\\VSCode\\rg\\rg.exe', BLACKHOLE_GIT_USR_BIN: 'C:\\Git\\usr\\bin', SECRET_TOKEN: 'secret', NODE_OPTIONS: '--bad', ELECTRON_RUN_AS_NODE: '1' };
  const env = processEnvironment('C:\\private-temp', host);
  const finite = powerShellEnvironment({}, host), generic = shellEnvironment(host);
  const expectedPath = 'C:\\Git\\usr\\bin;C:\\VSCode\\rg;bin;C:\\Windows\\System32;C:\\Windows';
  assert.equal(env.PATH, expectedPath); assert.equal(finite.PATH, expectedPath); assert.equal(generic.PATH, expectedPath); assert.equal(env.TEMP, 'C:\\private-temp');
  for (const key of ['BLACKHOLE_RG', 'BLACKHOLE_GIT_USR_BIN', 'SECRET_TOKEN', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE']) {
    assert.ok(!(key in env)); assert.ok(!(key in finite));
  }
  const encoded = encodeEnvironment({ Z: '涓枃', A: 'value' }).toString('utf16le'); assert.equal(encoded, 'A=value\0Z=涓枃\0\0');
  assert.throws(() => encodeEnvironment({ PATH: 'a', Path: 'b' }));
  assert.throws(() => encodeEnvironment({ VALUE: 'a\0b' }));
  const args = powerShellArgs('node app.js'); assert.ok(args.includes('-NonInteractive')); assert.ok(args.includes('-EncodedCommand'));
  const encodedCommand = args.at(-1); assert.equal(typeof encodedCommand, 'string');
  const script = Buffer.from(encodedCommand, 'base64').toString('utf16le');
  assert.match(script, /OutputEncoding.*UTF8/);
  assert.doesNotMatch(script, /chcp\.com/i, 'encoding setup must not launch a blocking console utility');
  assert.ok(script.includes('node app.js'));
});
test('managed PowerShell preserves module configuration and prioritizes its own core modules', { skip: process.platform !== 'win32' }, async () => {
  const { processEnvironment, powerShellArgs } = await import('../dist/process/windows.js');
  const env = processEnvironment('C:\\fixture-temp', { SystemRoot: 'C:\\Windows', PSModulePath: 'C:\\fixture-modules', BLACKHOLE_CLOUD_TOKEN: 'must-not-leak' });
  assert.equal(env.PSModulePath, 'C:\\fixture-modules');
  assert.equal(env.BLACKHOLE_CLOUD_TOKEN, undefined);
  const script = Buffer.from(powerShellArgs('Write-Output fixture').at(-1), 'base64').toString('utf16le');
  assert.match(script, /\$PSHOME.*Modules/);
  assert.ok(script.indexOf('$env:PSModulePath =') < script.indexOf('Write-Output fixture'));
});
test('three simultaneous processes have distinct identities/output/stop objects', async t => {
  const f = fixture(t); const rows = await Promise.all(['a', 'b', 'c'].map(id => f.start(id)));
  assert.equal(new Set(rows.map(r => r.processId)).size, 3); assert.equal(f.children.length, 3);
  f.children.forEach((item, i) => item.cb.output('stdout', Buffer.from('task-' + i)));
  assert.equal(f.manager.status(f.owner.sessionId, rows[1].processId).output.stdout, 'task-1');
  await f.manager.stop(f.owner.sessionId, rows[0].processId);
  assert.deepEqual(f.children.map(c => c.stops), [1, 0, 0]); assert.equal(f.manager.status(f.owner.sessionId, rows[2].processId).state, 'running');
});
test('same start intention including concurrent retries launches exactly once', async t => {
  const f = fixture(t), approval = deferred();
  const a = f.start('once', {}, () => approval.promise), b = f.start('once');
  assert.equal(f.manager.list(f.owner.sessionId).length, 1); approval.resolve();
  const [x, y] = await Promise.all([a, b]); assert.equal(x.processId, y.processId); assert.equal(f.children.length, 1);
  await assert.rejects(f.start('once', { script: 'different' }), { code: 'idempotency_conflict' });
  await f.manager.stop(f.owner.sessionId, x.processId); assert.equal((await f.start('once')).state, 'exited'); assert.equal(f.children.length, 1);
});
test('completed history is pruned without ever permitting an accepted requestId to execute again', async t => {
  let now = 1_000;
  const f = fixture(t, { now: () => now, limits: { sessionRecords: 2, records: 3, sessionHistory: 1, history: 2, historyRetentionMs: 60_000,
    sessionRequestHistory: 16, requestHistory: 32 } });
  const a = await f.start('a'); await f.manager.stop(f.owner.sessionId, a.processId); now += 1;
  const b = await f.start('b'); await f.manager.stop(f.owner.sessionId, b.processId); now += 1;
  const c = await f.start('c');
  assert.throws(() => f.manager.status(f.owner.sessionId, a.processId), { code: 'process_not_found' });
  assert.equal(f.manager.status(f.owner.sessionId, b.processId).state, 'exited');
  await assert.rejects(f.start('a'), { code: 'idempotency_history_expired' });
  now += 365 * 24 * 60 * 60 * 1000;
  await assert.rejects(f.start('a'), { code: 'idempotency_history_expired' });
  assert.equal(f.children.length, 3, 'elapsed time must not turn an accepted request into a new launch');
  await f.manager.stop(f.owner.sessionId, c.processId);
});
test('history pruning preserves an actively leased terminal and removes another completed record instead', async t => {
  let now = 2_000;
  const f = fixture(t, { now: () => now, limits: { sessionRecords: 2, records: 3, sessionHistory: 0, history: 1, historyRetentionMs: 0,
    sessionRequestHistory: 16, requestHistory: 32 } });
  const visible = await f.start('visible');
  f.manager.syncView('window-a', [f.root], {});
  f.manager.syncView('window-a', [f.root], {}, [{ processId: visible.processId, state: 'open' }]);
  await f.manager.stop(f.owner.sessionId, visible.processId);
  const removable = await f.start('removable'); await f.manager.stop(f.owner.sessionId, removable.processId); now += 1;
  const next = await f.start('next');
  assert.equal(f.manager.status(f.owner.sessionId, visible.processId).terminal.state, 'open');
  assert.throws(() => f.manager.status(f.owner.sessionId, removable.processId), { code: 'process_not_found' });
  assert.equal(next.state, 'running');
});
test('purging a session removes completed records and their request tombstones', async t => {
  const f = fixture(t, { limits: { sessionRecords: 1, records: 2, sessionHistory: 0, history: 0, historyRetentionMs: 0,
    sessionRequestHistory: 16, requestHistory: 32 } });
  const first = await f.start('same'); await f.manager.stop(f.owner.sessionId, first.processId);
  const second = await f.start('other');
  await assert.rejects(f.start('same'), { code: 'idempotency_history_expired' });
  assert.deepEqual(await f.manager.stopSession(f.owner.sessionId, 'session_revoked', true), []);
  const restarted = await f.start('same');
  assert.equal(restarted.state, 'running'); assert.notEqual(restarted.processId, first.processId); assert.notEqual(restarted.processId, second.processId);
});
test('request ledger is count-bounded by rejecting new intentions without forgetting accepted IDs', async t => {
  const f = fixture(t, { limits: { sessionRecords: 1, records: 1, sessionHistory: 0, history: 0, historyRetentionMs: 0,
    sessionRequestHistory: 2, requestHistory: 2 } });
  const a = await f.start('a'); await f.manager.stop(f.owner.sessionId, a.processId);
  const b = await f.start('b'); await f.manager.stop(f.owner.sessionId, b.processId);
  await assert.rejects(f.start('c'), { code: 'idempotency_capacity_reached' });
  await assert.rejects(f.start('a'), { code: 'idempotency_history_expired' });
  assert.equal(f.children.length, 2, 'capacity pressure must never replay or dispatch a rejected launch');
});
test('concurrent quota reservation counts pending approval without serializing running tasks', async t => {
  const f = fixture(t, { limits: { sessionRunning: 1 } }), approval = deferred();
  const pending = f.start('first', {}, () => approval.promise);
  await assert.rejects(f.start('second'), { code: 'process_limit_reached' });
  approval.resolve(); const row = await pending; await f.manager.stop(f.owner.sessionId, row.processId);
  assert.equal((await f.start('third')).state, 'running');
});
test('cross-session identifiers expose neither metadata nor stop authority', async t => {
  const f = fixture(t), row = await f.start('a');
  assert.throws(() => f.manager.status('other', row.processId), { code: 'process_not_found' });
  await assert.rejects(f.manager.stop('other', row.processId), { code: 'process_not_found' });
  assert.deepEqual(f.manager.list('other'), []); assert.equal(f.children[0].stops, 0);
});
test('stop during approval completes without spawning, even if approval resolves later', async t => {
  const f = fixture(t), approval = deferred(), starting = f.start('a', {}, () => approval.promise);
  const row = f.manager.list(f.owner.sessionId)[0]; await f.manager.stop(f.owner.sessionId, row.processId);
  assert.equal((await starting).state, 'exited'); approval.resolve(); await tick(); assert.equal(f.children.length, 0);
});
test('spawn errors and immediate nonzero exits remain inspectable with exact semantics', async t => {
  const f = fixture(t, { backend: () => { throw new Error('ENOENT synthetic'); } });
  const failed = await f.start('bad'); assert.equal(failed.state, 'failed'); assert.match(failed.output.stderr, /ENOENT/); assert.equal(failed.pid, null);
  const g = fixture(t, { backend: (spec, cb) => { cb.output('stderr', Buffer.from('last error')); cb.exit({ exitCode: 7, cleanupConfirmed: true }); return { pid: 123, stop: async () => {} }; } });
  const exited = await g.start('exit'); assert.equal(exited.state, 'exited'); assert.equal(exited.exitCode, 7); assert.equal(exited.output.stderr, 'last error');
});
test('sandbox runner failures are failed launches while policy denials are command exits', async t => {
  const runner=fixture(t,{backend:(spec,cb)=>{cb.output('stderr',Buffer.from('sandbox-exec: sandbox_apply: Operation not permitted'));cb.exit({exitCode:71,reason:'sandbox_runner_nested',cleanupConfirmed:true});return {pid:321,stop:async()=>{}};}});
  const failed=await runner.start('runner');assert.equal(failed.state,'failed');assert.equal(failed.reason,'sandbox_runner_nested');assert.equal(failed.exitCode,71);
  const policy=fixture(t,{backend:(spec,cb)=>{cb.output('stderr',Buffer.from('operation not permitted'));cb.exit({exitCode:1,reason:'execution_policy_denied',cleanupConfirmed:true});return {pid:322,stop:async()=>{}};}});
  const exited=await policy.start('policy');assert.equal(exited.state,'exited');assert.equal(exited.reason,'execution_policy_denied');assert.equal(exited.exitCode,1);
});
test('warnings do not imply failure; repeated stop never targets another process', async t => {
  const f = fixture(t), row = await f.start('a'); f.children[0].cb.output('stderr', Buffer.from('warning only'));
  assert.equal(f.manager.status(f.owner.sessionId, row.processId).state, 'running');
  await f.manager.stop(f.owner.sessionId, row.processId); await f.manager.stop(f.owner.sessionId, row.processId); assert.equal(f.children[0].stops, 1);
});
test('permission/session invalidation stops live tasks and denies pending spawns', async t => {
  const f = fixture(t), row = await f.start('live'), pending = deferred();
  const start = f.start('pending', {}, () => pending.promise);
  f.manager.reconcile(() => 'session_paused'); await tick();
  assert.equal((await start).state, 'exited'); assert.equal(f.manager.status(f.owner.sessionId, row.processId).state, 'exited');
});
test('terminal lease requires real acknowledgement and does not duplicate across windows', async t => {
  let now = 1000; const f = fixture(t, { now: () => now }), row = await f.start('a');
  assert.equal(row.terminal.state, 'unavailable');
  const a = f.manager.syncView('a', [f.root], {}); assert.equal(a.items[0].owned, true); assert.equal(a.items[0].terminal.state, 'pending');
  assert.equal(f.manager.syncView('b', [f.root], {}).items[0].owned, false);
  f.manager.syncView('a', [f.root], {}, [{ processId: row.processId, state: 'open' }]);
  assert.equal(f.manager.status(f.owner.sessionId, row.processId).terminal.state, 'open');
  now += 6000; assert.equal(f.manager.status(f.owner.sessionId, row.processId).terminal.state, 'unavailable');
  assert.equal(f.manager.syncView('b', [f.root], {}).items[0].owned, false); await tick();
  assert.equal(f.manager.status(f.owner.sessionId, row.processId).state, 'exited'); assert.equal(f.children[0].stops, 1);
});
test('agent stop can request closing only its confirmed terminal, and closed ACK clears the request', async t => {
  const f = fixture(t), row = await f.start('a');
  f.manager.syncView('a', [f.root], {}); f.manager.syncView('a', [f.root], {}, [{ processId: row.processId, state: 'open' }]);
  await f.manager.stop(f.owner.sessionId, row.processId, 'operator_stop', true);
  let item = f.manager.syncView('a', [f.root], {}).items[0]; assert.equal(item.closeTerminal, true); assert.equal(item.state, 'exited');
  f.manager.syncView('a', [f.root], {}, [{ processId: row.processId, state: 'closed' }]);
  item = f.manager.syncView('a', [f.root], {}).items[0]; assert.equal(item.closeTerminal, undefined); assert.equal(item.owned, false);
});
test('closeTerminal never hides an unconfirmed stop failure', async t => {
  let stops = 0;
  const f = fixture(t, { backend: (spec, cb) => ({ pid: 123, stop: async () => { if (++stops === 1) throw new Error('synthetic stop failure'); cb.exit({ exitCode: 1, cleanupConfirmed: true }); } }) });
  const row = await f.start('a'); f.manager.syncView('a', [f.root], {}); f.manager.syncView('a', [f.root], {}, [{ processId: row.processId, state: 'open' }]);
  const stopped = await f.manager.stop(f.owner.sessionId, row.processId, 'operator_stop', true); assert.equal(stopped.state, 'unknown');
  assert.equal(f.manager.syncView('a', [f.root], {}).items[0].closeTerminal, undefined);
});
test('closing a view stops its process and never recreates hidden work', async t => {
  const f = fixture(t), row = await f.start('a'); f.manager.syncView('a', [f.root], {});
  f.manager.syncView('a', [f.root], {}, [{ processId: row.processId, state: 'closed' }]); await tick();
  assert.equal(f.manager.syncView('a', [f.root], {}).items[0].owned, false); assert.equal(f.children[0].stops, 1);
  assert.equal(f.manager.status(f.owner.sessionId, row.processId).state, 'exited');
});
test('unmatched workspaces and expired view leases cannot stop tasks', async t => {
  const f = fixture(t), row = await f.start('a');
  assert.deepEqual(f.manager.syncView('a', [], {}).items, []);
  await assert.rejects(f.manager.stopFromView('a', [], row.processId), { code: 'process_not_found' });
});

test('all sixteen running processes receive a fair bounded bridge output share', async t => {
  const f = fixture(t, { limits: { sessionRunning: 16 } });
  await Promise.all(Array.from({ length: 16 }, (_, i) => f.start('task-' + i)));
  f.children.forEach((child, i) => child.cb.output('stdout', Buffer.from(('task-' + i + ' ').repeat(4000))));
  const reply = f.manager.syncView('view', [f.root], {});
  assert.equal(reply.items.length, 16); assert.ok(reply.items.every(item => item.output.events.length > 0));
  const bytes = reply.items.reduce((sum, item) => sum + item.output.events.reduce((n, e) => n + Buffer.byteLength(e.text), 0), 0);
  assert.ok(bytes <= 128 * 1024);
});
test('failed cleanup remains unknown, blocks new-policy launches and prevents false successful shutdown', async t => {
  let callbacks;
  const f = fixture(t, { backend: (spec, cb) => { callbacks = cb; return { pid: 123, stop: async () => { throw Error('synthetic termination failure'); } }; } });
  const row = await f.start('a');
  const stopped = await f.manager.stop(f.owner.sessionId, row.processId); assert.equal(stopped.state, 'unknown'); assert.equal(stopped.reason, 'stop_failed');
  assert.deepEqual(await f.manager.stopSession(f.owner.sessionId, 'permission_changed'), [row.processId]);
  await assert.rejects(f.manager.start({ ...f.owner, mode: 'read-only' }, { requestId: 'new-policy', script: 'echo safe' }, async () => {}), { code: 'process_cleanup_pending' });
  await assert.rejects(f.manager.dispose(), { code: 'cleanup_unconfirmed' });
  callbacks.exit({ exitCode: 1, cleanupConfirmed: true });
});
test('lifecycle audit correlates to the originating call without storing output contents', async t => {
  const events = [], f = fixture(t, { event: (id, type, data) => events.push({ id, type, data }) });
  const row = await f.manager.start(f.owner, { requestId: 'audit', script: 'echo fixture' }, async () => {}, [], 'synthetic-call-id');
  f.children[0].cb.output('stdout', Buffer.from('not-an-audit-payload'));
  await f.manager.stop(f.owner.sessionId, row.processId);
  assert.ok(events.length >= 2); assert.ok(events.every(e => e.data.call_id === 'synthetic-call-id'));
  assert.ok(!JSON.stringify(events).includes('not-an-audit-payload'));
});
