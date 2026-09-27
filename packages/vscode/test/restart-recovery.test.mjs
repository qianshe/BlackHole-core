// Regression coverage for restart omissions. Real manager, statusbar and session action code; isolated IO.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript');
const compile = name => ts.transpileModule(fs.readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
const managerJs = compile('daemonManager'), statusbarJs = compile('statusbar'), sessionActionsJs = compile('sessionActions');
const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function host(options = {}) {
  const cfg = { port: 49801, daemonEntry: '/fixture/cli.js', channelMode: 'custom', semanticMode: 'off', cloudflaredPath: '',
    namedTunnelName: 'fixture', publicBaseUrl: '', skillsDir: '', gitUsrBinPath: '', tunnelProbeProxy: '' };
  const notices = [], logs = [], store = new Map();
  const context = { extensionPath: '/fixture', extension: { packageJSON: { version: 'fixture' } },
    globalState: { get: key => store.get(key), update: async (key, value) => store.set(key, value) } };
  const vscode = {
    EventEmitter: class { inner = new EventEmitter(); event = fn => { this.inner.on('state', fn); return { dispose: () => this.inner.off('state', fn) }; }; fire(v) { this.inner.emit('state', v); } dispose() { this.inner.removeAllListeners(); } },
    ProgressLocation: { Notification: 1 }, env: { shell: '/bin/sh', appRoot: '/fixture' }, workspace: { getConfiguration: () => ({ get: () => undefined }) },
    window: { showErrorMessage: s => notices.push(s), showWarningMessage: s => notices.push(s), withProgress: (_o, fn) => fn() },
  };
  let child, spawns = 0, closes = 0;
  const api = { health: async () => { throw Error('offline'); }, shutdown: async () => ({ ok: true }) };
  const fakeFs = { existsSync: () => true, statSync: () => ({ mtimeMs: 123 }),
    openSync: () => { if (options.logFailure) throw Object.assign(Error('log unavailable'), { code: 'EACCES' }); return 1; }, closeSync: () => { closes++; } };
  const module = { exports: {} };
  vm.runInNewContext(managerJs, { module, exports: module.exports, console, setTimeout: fn => setTimeout(fn, 0), clearTimeout,
    Date: options.Date ?? Date, process: { platform: process.platform, arch: process.arch, execPath: 'fixture-node', env: {} },
    require: name => name === 'vscode' ? vscode : name === './cloudEnvironment' ? { resolveCloudEndpoint: () => ({ environment: 'test', origin: 'https://fixture.example.org' }) }
      : name === './vscodeRipgrep' ? { resolveExecutionRg: () => undefined, pathFromEnvironment: () => '', prependToolDirectory: v => v }
      : name === 'node:fs' ? fakeFs : name === 'node:child_process' ? { spawn: () => {
        spawns++; child = new EventEmitter(); child.pid = 123; child.exitCode = null; child.signalCode = null; child.unref = () => {};
        options.spawn?.(child); return child;
      } } : require(name) });
  const manager = new module.exports.DaemonManager(context, () => cfg, api, { appendLine: s => logs.push(s) });
  manager.listenerOpen = async () => false;
  return { manager, cfg, api, context, notices, logs, get child() { return child; }, get spawns() { return spawns; }, get closes() { return closes; } };
}
function barFor(h, onReady = () => {}) {
  const item = { text: '', show() {}, dispose() {} };
  class MarkdownString { constructor(value = '') { this.value = value; } appendMarkdown(v) { this.value += v; return this; } }
  const module = { exports: {} };
  vm.runInNewContext(statusbarJs, { module, exports: module.exports, require: n => n === 'vscode'
    ? { MarkdownString, StatusBarAlignment: { Right: 1 }, ThemeColor: class {}, window: { createStatusBarItem: () => item } } : require(n) });
  const bar = new module.exports.StatusBarController(h.manager, h.api, { onTick: () => ({ dispose() {} }) }, onReady);
  return { bar, item };
}

function sessionActionFor(h, task = 'fixture task', options = {}) {
  const warnings = [], errors = [], created = [], statuses = [], inputs = [], picks = [];
  const vscode = {
    env: {clipboard:{writeText:async()=>{}}},
    workspace:{workspaceFolders:options.folders ?? [{name:'fixture',uri:{fsPath:'/fixture/workspace'}}]},
    window:{showInputBox:async o=>{inputs.push(o);return options.cancelTask ? undefined : task;},
      showQuickPick:async (items,o)=>{picks.push({items,options:o});return options.cancelFolder ? undefined : items[0];},
      showWarningMessage:s=>warnings.push(s),
      showErrorMessage:s=>errors.push(s), setStatusBarMessage:s=>statuses.push(s)},
  };
  const module = {exports:{}};
  vm.runInNewContext(sessionActionsJs, {module, exports:module.exports, console,
    require:name=>name==='vscode'?vscode:name==='./config'?{getConfig:()=>({connectorName:'BlackHole'})}
      :name==='./templates'?{renderPrompt:()=>''}:require(name)});
  let after = 0;
  h.api.createSession = async (...args) => { created.push(args); return {name:task,workspace_path:args[0]}; };
  return {warnings,errors,created,statuses,inputs,picks,
    run:()=>module.exports.createSession(h.api,h.manager,()=>{after++;}), get after(){return after;}};
}
for (const activation of [true, false]) test(`concurrent replacement respects ${activation ? 'activation adoption' : 'explicit restart strictness'} through shutdown`, async t => {
  const h = host(); t.after(() => h.manager.dispose()); const wanted = h.manager.fingerprint();
  let live = { ok: true, version: 'old', daemon_id: 'old', start_fingerprint: JSON.stringify({ ...JSON.parse(wanted), version: 'old' }) };
  h.api.health = async () => live;
  h.api.shutdown = async () => { live = { ok: true, version: 'fixture', daemon_id: 'new', start_fingerprint: JSON.stringify({ ...JSON.parse(wanted), terminalShell: '/bin/bash' }) };
    throw Object.assign(Error('daemon_changed'), { status: 409 }); };
  if (activation) { await h.manager.syncConfigRestart(true); assert.deepEqual(h.notices, []); }
  else assert.equal(await h.manager.restart(), false);
  assert.equal(h.spawns, 0); assert.equal(live.daemon_id, 'new');
});
test('a real status poll repairs manager state after startup timeout, without spawning again', async t => {
  let wall = 0; class Clock extends Date { static now() { return wall += 5000; } }
  const h = host({ Date: Clock }); t.after(() => h.manager.dispose());
  assert.equal(await h.manager.ensureRunning(), false); assert.equal(h.manager.currentState, 'error');
  h.api.health = async () => ({ ok: true, version: 'fixture', daemon_id: 'late', tunnel: 'online', start_fingerprint: h.manager.fingerprint() });
  const { bar, item } = barFor(h); t.after(() => bar.dispose()); await bar.refreshHealth(false); await settle(); await settle();
  assert.equal(h.manager.currentState, 'running'); assert.doesNotMatch(item.text, /error/); assert.equal(h.spawns, 1);
});
test('health observations made before Stop or disposal cannot revive the manager', async t => {
  const h = host(); t.after(() => h.manager.dispose());
  const observation = h.manager.captureHealthObservation();
  h.manager.waitForHealthOrClosed = async () => null;
  assert.equal(await h.manager.stop(), true);
  h.manager.observeHealth({ ok: true, version: 'fixture', daemon_id: 'old' }, observation);
  assert.equal(h.manager.currentState, 'stopped');
  const fresh = h.manager.captureHealthObservation(); h.manager.dispose();
  h.manager.observeHealth({ ok: true, version: 'fixture', daemon_id: 'new' }, fresh);
  assert.equal(h.manager.currentState, 'stopped');
});
test('explicit Stop cancels a pending handoff when another window still owns the port', async t => {
  const h = host(); t.after(() => h.manager.dispose());
  h.manager.reconcileNeeded = true;
  h.manager.requireExactReconcile = true;
  h.manager.waitForHealthOrClosed = async () => null;
  assert.equal(await h.manager.stop(), true);
  let retries = 0;
  h.manager.syncConfigRestart = async () => { retries++; };
  const other = {ok:true, version:'fixture', daemon_id:'other-window',
    start_fingerprint:JSON.stringify({...JSON.parse(h.manager.fingerprint()), skillsDir:'/other'})};
  assert.equal(h.manager.observeHealth(other, h.manager.captureHealthObservation()), false);
  await settle(); assert.equal(retries, 0, 'a later passive poll cannot undo an explicit Stop');
});

test('spawn async error is consumed and produces one controlled failure', async t => {
  const h = host({ spawn: child => setImmediate(() => child.emit('error', Object.assign(Error('fixture spawn failure'), { code: 'EACCES' }))) });
  t.after(() => h.manager.dispose()); assert.equal(await h.manager.ensureRunning(), false);
  assert.equal(h.child.listenerCount('error'), 1); assert.equal(h.manager.currentState, 'error');
  assert.equal(h.notices.length, 1); assert.match(h.logs.join('\n'), /EACCES/); assert.equal(h.closes, 1);
});
test('log open failure cannot reject activation or spawn a child', async t => {
  const h = host({ logFailure: true }); t.after(() => h.manager.dispose());
  assert.equal(await h.manager.ensureRunning(), false); assert.equal(h.spawns, 0); assert.equal(h.notices.length, 1);
});
test('an early child exit fails promptly when no replacement listener exists', async t => {
  const h = host({ spawn: child => setImmediate(() => { child.exitCode = 1; child.emit('exit', 1, null); }) });
  t.after(() => h.manager.dispose()); assert.equal(await h.manager.ensureRunning(), false);
  assert.equal(h.manager.currentState, 'error'); assert.match(h.logs.join('\n'), /exit|exited/i);
});
test('failed old-port shutdown blocks a new-port spawn and leaves endpoint attached to the old port', async t => {
  const h = host(); t.after(() => h.manager.dispose());
  const oldPort = h.cfg.port; h.cfg.port++;
  h.manager.stopOnce = async () => false;
  assert.equal(await h.manager.ensureRunning(), false); assert.equal(h.spawns, 0);
  assert.equal(h.manager.captureHealthObservation().port, h.cfg.port);
  assert.equal(h.manager.managedPort, oldPort);
});

test('Stop is serialized after an in-flight startup; a subsequent explicit Start remains possible', async t => {
  const h=host(), gate=deferred(), order=[];t.after(()=>h.manager.dispose());
  h.manager.ensureRunningOnce=async()=>{order.push('start');await gate.promise;h.manager.setState('running');return true;};
  h.manager.stopOnce=async()=>{order.push('stop');h.manager.setState('stopped');return true;};
  const start=h.manager.ensureRunning();await settle();const stop=h.manager.stop();
  await settle();assert.deepEqual(order,['start']);gate.resolve();await Promise.all([start,stop]);
  assert.deepEqual(order,['start','stop']);assert.equal(h.manager.currentState,'stopped');
  assert.equal(await h.manager.ensureRunning(),true);assert.equal(h.manager.currentState,'running');
});
test('an explicit restart joining activation tightens the shared policy before completion', async t => {
  const h=host(), gate=deferred();t.after(()=>h.manager.dispose());
  const wanted=h.manager.fingerprint();
  h.manager.stopOnce=async()=>{await gate.promise;return true;};
  h.manager.ensureRunningOnce=async()=>true;
  h.api.health=async()=>({ok:true,version:'fixture',daemon_id:'replacement',start_fingerprint:JSON.stringify({...JSON.parse(wanted),terminalShell:'other-window'})});
  const automatic=h.manager.restart(true);await settle();const explicit=h.manager.restart();gate.resolve();
  assert.equal(await explicit,false);assert.equal(await automatic,false);
});
test('a replacement listener without health cannot be treated as a completed port shutdown', async t => {
  const h=host();t.after(()=>h.manager.dispose());let reads=0;
  h.manager.waitForHealthOrClosed=async()=>++reads===1?{ok:true,version:'fixture',daemon_id:'old'}:undefined;
  h.manager.waitForDaemonChange=async()=>true;
  assert.equal(await h.manager.stop(),false);assert.equal(h.manager.currentState,'error');
});
test('disposal prevents queued lifecycle work from spawning or restarting', async()=>{
  const h=host(), gate=deferred();let starts=0;
  h.manager.ensureRunningOnce=async()=>{starts++;await gate.promise;return true;};
  const first=h.manager.ensureRunning();await settle();const next=h.manager.restart();h.manager.dispose();gate.resolve();
  await first;assert.equal(await next,false);assert.equal(starts,1);
});
test('a late explicit join cannot inherit an already accepted activation-only fingerprint',async t=>{
  const h=host();t.after(()=>h.manager.dispose());const wanted=h.manager.fingerprint();let explicit;
  h.manager.stopOnce=async()=>true;h.manager.ensureRunningOnce=async()=>true;
  h.api.health=async()=>({ok:true,version:'fixture',daemon_id:'replacement',start_fingerprint:JSON.stringify({...JSON.parse(wanted),terminalShell:'other-window'})});
  const accepts=h.manager.sameInstalledCode.bind(h.manager);
  h.manager.sameInstalledCode=(...args)=>{queueMicrotask(()=>{explicit=h.manager.restart();});return accepts(...args);};
  assert.equal(await h.manager.restart(true),true);await settle();assert.equal(await explicit,false);
});


test('a losing spawn attaches to the old port owner without claiming the candidate PID or fingerprint', async t => {
  const h = host({ spawn: child => setImmediate(() => { child.exitCode = 1; child.emit('exit', 1, null); }) });
  t.after(() => h.manager.dispose());
  let reads = 0;
  h.api.health = async () => {
    if (++reads === 1) throw Error('listener not ready');
    return {ok:true, version:'0.3.165', daemon_id:'legacy-owner'};
  };
  h.manager.listenerOpen = async () => true;
  assert.equal(await h.manager.ensureRunning(), true, 'attach so activation can reconcile the old owner');
  assert.equal(h.spawns, 1);
  assert.equal(h.manager.currentState, 'starting', 'an old listener is attached for upgrade, not marked ready');
  assert.match(h.logs.join('\n'), /candidate lost port race; attached to v0\.3\.165/);
  assert.doesNotMatch(h.logs.join('\n'), /daemon healthy.*attemptedSpawnPid/);
  assert.equal(h.context.globalState.get('blackhole.daemonStartFingerprint'), undefined);
});

test('a failed handoff is reconciled again from health polls with bounded backoff', async t => {
  const h = host(); t.after(() => h.manager.dispose());
  h.manager.reconcileNeeded = true; // Model the unfinished requested handoff.
  h.manager.setState('error', 'restart failed');
  let retries = 0;
  h.manager.syncConfigRestart = async () => { retries++; };
  const observation = h.manager.captureHealthObservation();
  const legacy = {ok:true, version:'0.3.165', daemon_id:'old-owner'};
  assert.equal(h.manager.observeHealth(legacy, observation), false);
  assert.equal(h.manager.currentState, 'error', 'old health must not clear a failed restart');
  await settle(); assert.equal(retries, 1);
  h.manager.observeHealth(legacy, observation);
  await settle(); assert.equal(retries, 1, 'one-second polls do not cause a restart storm');
  assert.equal(h.manager.currentState, 'error');
  h.manager.nextReconcileAt = 0;
  h.manager.observeHealth(legacy, observation);
  await settle(); assert.equal(retries, 2, 'same old owner is retried after the backoff');
  h.manager.nextReconcileAt = 0;
  h.manager.reconcileNeeded = false;
  assert.equal(h.manager.observeHealth({ok:true, version:'fixture', daemon_id:'different-owner', start_fingerprint:h.manager.fingerprint()}, observation), true);
  await settle(); assert.equal(retries, 2, 'a compatible replacement needs no passive restart');
  assert.equal(h.manager.currentState, 'running');
});


test('an older listener found at activation stays pending until its guarded upgrade', async t => {
  const h = host(); t.after(() => h.manager.dispose());
  h.api.health = async () => ({ok:true, version:'0.3.165', daemon_id:'old-owner'});
  assert.equal(await h.manager.ensureRunning(), true, 'attached for coordination');
  assert.equal(h.manager.currentState, 'starting', 'an older daemon is not reported ready');
  assert.equal(h.spawns, 0);
  assert.equal(h.context.globalState.get('blackhole.daemonStartFingerprint'), undefined);
});

test('status polls keep an old daemon in error and notify the account bridge only after verified recovery', async t => {
  const h = host(), ready = [];
  t.after(() => h.manager.dispose());
  h.manager.setState('error', 'restart failed');
  let owner = {ok:true, version:'0.3.165', daemon_id:'old-owner'};
  h.api.health = async () => owner;
  h.manager.syncConfigRestart = async () => {};
  const {bar,item} = barFor(h, id => ready.push(id)); t.after(() => bar.dispose());
  await bar.refreshHealth(false); await settle();
  assert.equal(h.manager.currentState, 'error');
  assert.match(item.text, /error/);
  assert.deepEqual(ready, [], 'legacy health must not trigger account verification');
  owner = {ok:true, version:'fixture', daemon_id:'new-owner', start_fingerprint:h.manager.fingerprint()};
  await bar.refreshHealth(false); await settle(); await settle();
  assert.equal(h.manager.currentState, 'running');
  assert.deepEqual(ready, ['new-owner']);
  assert.doesNotMatch(item.text, /error/);
});


test('a failed explicit restart cannot be silently adopted by a later activation-style poll', async t => {
  const h = host(); t.after(() => h.manager.dispose());
  const wanted = h.manager.fingerprint(); let attempts = 0;
  const other = {ok:true, version:'fixture', daemon_id:'other-window',
    start_fingerprint:JSON.stringify({...JSON.parse(wanted), terminalShell:'/bin/bash'})};
  h.api.health = async () => other;
  h.manager.stopOnce = async () => { attempts++; h.manager.setState('error', 'blocked shutdown'); return false; };
  assert.equal(await h.manager.restart(), false);
  assert.equal(attempts, 1);
  assert.equal(h.manager.observeHealth(other, h.manager.captureHealthObservation()), false);
  if (h.manager.syncPending) await h.manager.syncPending;
  assert.equal(attempts, 2, 'poll retries the exact requested configuration instead of adopting the other terminal');
  assert.equal(h.manager.currentState, 'error');
  assert.equal(h.notices.length, 1);
  h.manager.nextReconcileAt = 0;
  h.manager.observeHealth(other, h.manager.captureHealthObservation());
  if (h.manager.syncPending) await h.manager.syncPending;
  assert.equal(attempts, 3);
  assert.equal(h.notices.length, 1, 'later bounded retries do not repeat the same failure notification');
});

test('a deliberately adopted same-build terminal preference stays usable across status polls', async t => {
  const h = host(); t.after(() => h.manager.dispose());
  const wanted = h.manager.fingerprint(); let stops = 0;
  const other = {ok:true, version:'fixture', daemon_id:'other-window',
    start_fingerprint:JSON.stringify({...JSON.parse(wanted), terminalShell:'/bin/bash'})};
  h.api.health = async () => other;
  h.manager.stopOnce = async () => { stops++; return false; };
  await h.manager.syncConfigRestart(true);
  assert.equal(h.manager.currentState, 'running');
  assert.equal(h.manager.observeHealth(other, h.manager.captureHealthObservation()), true);
  if (h.manager.syncPending) await h.manager.syncPending;
  assert.equal(stops, 0, 'machine-safe adoption must not cause windows to restart each other');
  assert.equal(h.manager.currentState, 'running');
});


test("passive polls do not reverse another window's explicit skillsDir handoff", async t => {
  const a = host(), b = host(), handoffs = [];
  t.after(() => { a.manager.dispose(); b.manager.dispose(); });
  a.cfg.skillsDir = '/fixture/skills-a';
  b.cfg.skillsDir = '/fixture/skills-b';
  let live = {ok:true, version:'fixture', daemon_id:'owner-a', start_fingerprint:a.manager.fingerprint()};
  a.api.health = async () => live;
  b.api.health = async () => live;
  const take = (h, name) => async () => {
    handoffs.push(name);
    live = {ok:true, version:'fixture', daemon_id:`owner-${name}`, start_fingerprint:h.manager.fingerprint()};
    h.manager.setState('running');
    return true;
  };
  a.manager.restart = take(a, 'a');
  b.manager.restart = take(b, 'b');
  assert.equal(await a.manager.ensureRunning(), true);
  assert.equal(await b.manager.ensureRunning(), true);
  assert.equal(b.manager.currentState, 'starting');
  await b.manager.syncConfigRestart(true);
  assert.deepEqual(handoffs, ['b'], 'the newly activated window may take over once');
  for (let i = 0; i < 3; i++) {
    a.manager.nextReconcileAt = 0;
    a.manager.observeHealth(live, a.manager.captureHealthObservation());
    if (a.manager.syncPending) await a.manager.syncPending;
  }
  assert.deepEqual(handoffs, ['b'], 'a passive old window must not undo the new owner');
  assert.equal(a.manager.currentState, 'error', 'the incompatible window remains fail-closed');
  await a.manager.syncConfigRestart(false);
  assert.deepEqual(handoffs, ['b', 'a'], 'an explicit setting change can still request a handoff');
  b.manager.nextReconcileAt = 0;
  assert.equal(b.manager.observeHealth(live, b.manager.captureHealthObservation()), false);
  if (b.manager.syncPending) await b.manager.syncPending;
  assert.deepEqual(handoffs, ['b', 'a'], 'the other window does not retaliate');
});

test('Create Session refuses an older attached listener even when its public channel is online', async t => {
  const h = host(); t.after(() => h.manager.dispose());
  let healthReads = 0;
  h.api.health = async () => { healthReads++; return {ok:true, version:'0.3.165', daemon_id:'old-owner',
    tunnel:'online', tunnel_url:'https://old.example.org/mcp'}; };
  const action = sessionActionFor(h);
  await action.run();
  assert.equal(h.manager.currentState, 'starting');
  assert.equal(h.spawns, 0);
  assert.equal(healthReads, 1, 'do not consult the older listener for a public URL');
  assert.equal(action.created.length, 0); assert.equal(action.after, 0);
  assert.match(action.warnings.join('\n'), /尚未确认就绪/);
});


test('Create Session refuses a same-version daemon launched with an older skillsDir', async t => {
  const h = host(); t.after(() => h.manager.dispose());
  h.cfg.skillsDir = '/fixture/.agents/skills';
  const wanted = h.manager.fingerprint();
  h.api.health = async () => ({ok:true, version:'fixture', daemon_id:'old-settings',
    start_fingerprint:JSON.stringify({...JSON.parse(wanted), skillsDir:'/fixture/.zcode/skills'}),
    tunnel:'online', tunnel_url:'https://old.example.org/mcp'});
  const action = sessionActionFor(h);
  await action.run();
  assert.equal(h.manager.currentState, 'starting');
  assert.equal(action.created.length, 0); assert.equal(action.after, 0);
  assert.match(action.warnings.join('\n'), /尚未确认就绪/);
});

test('Create Session rejects a daemon replaced between Start and its public-channel health read', async t => {
  const h = host(); t.after(() => h.manager.dispose());
  const expected = {ok:true, version:'fixture', daemon_id:'verified', start_fingerprint:h.manager.fingerprint()};
  const older = {ok:true, version:'0.3.165', daemon_id:'old-owner', tunnel:'online', tunnel_url:'https://old.example.org/mcp'};
  let reads = 0, channelPort;
  h.api.health = async (_timeout, port) => { if (++reads === 2) channelPort = port; return reads === 1 ? expected : older; };
  h.manager.syncConfigRestart = async () => {};
  const action = sessionActionFor(h);
  await action.run();
  assert.equal(reads, 2); assert.equal(channelPort, h.cfg.port);
  assert.equal(h.manager.currentState, 'error');
  assert.equal(action.created.length, 0); assert.equal(action.after, 0);
  assert.match(action.warnings.join('\n'), /尚未确认就绪/);
});

test('Create Session rejects a health response captured before Stop without reviving the daemon', async t => {
  const h = host(); t.after(() => h.manager.dispose());
  const late = deferred(); let reads = 0;
  const expected = () => ({ok:true, version:'fixture', daemon_id:'verified', start_fingerprint:h.manager.fingerprint(),
    public_base_url:'https://current.example.org'});
  h.api.health = async () => ++reads === 1 ? expected() : late.promise;
  const action = sessionActionFor(h), pending = action.run();
  await settle(); await settle(); assert.equal(reads, 2);
  h.manager.stopOnce = async () => { h.manager.setState('stopped'); return true; };
  assert.equal(await h.manager.stop(), true);
  late.resolve(expected()); await pending;
  assert.equal(h.manager.currentState, 'stopped');
  assert.equal(action.created.length, 0); assert.equal(action.after, 0);
  assert.match(action.warnings.join('\n'), /尚未确认就绪/);
});

test('Create Session keeps a verified daemon and user-started public channel working', async t => {
  const h = host(); t.after(() => h.manager.dispose());
  h.api.health = async () => ({ok:true, version:'fixture', daemon_id:'verified', start_fingerprint:h.manager.fingerprint(),
    public_base_url:'https://current.example.org', tunnel:'off'});
  const action = sessionActionFor(h);
  await action.run();
  assert.equal(h.manager.currentState, 'running');
  assert.equal(action.created.length, 1);
  assert.equal(action.created[0][0], '/fixture/workspace');
  assert.equal(action.created[0][1], 'fixture task');
  assert.equal(action.after, 1);
  assert.deepEqual(action.warnings, []);
});

test('Create Session reports an unreadable post-start health without creating on cached readiness', async t => {
  const h = host(); t.after(() => h.manager.dispose());
  let reads = 0;
  h.api.health = async () => {
    if (++reads === 1) return {ok:true, version:'fixture', daemon_id:'verified', start_fingerprint:h.manager.fingerprint()};
    throw Error('temporary health outage');
  };
  const action = sessionActionFor(h);
  await action.run();
  assert.equal(action.created.length, 0); assert.equal(action.after, 0);
  assert.match(action.warnings.join('\n'), /尚未确认就绪/);
  assert.deepEqual(action.errors, []);
});

test('poll between legacy attach and upgrade keeps starting, never a false error or ready callback', async t => {
  const h = host(), ready = [];
  t.after(() => h.manager.dispose());
  const legacy = {ok:true, version:'0.3.165', daemon_id:'old-owner'};
  h.api.health = async () => legacy;
  assert.equal(await h.manager.ensureRunning(), true);
  let reconciles = 0;
  h.manager.syncConfigRestart = async () => { reconciles++; };
  const {bar, item} = barFor(h, id => ready.push(id));
  t.after(() => bar.dispose());
  await bar.refreshHealth(true);
  assert.equal(h.manager.currentState, 'starting');
  assert.doesNotMatch(item.text, /error/);
  assert.deepEqual(ready, []);
  assert.equal(reconciles, 1);
  assert.deepEqual(h.notices, []);
  assert.equal(h.manager.observeHealth(legacy, h.manager.captureHealthObservation()), false);
  h.api.health = async () => ({ok:true, version:'fixture', daemon_id:'new-owner', start_fingerprint:h.manager.fingerprint()});
  await bar.refreshHealth(true); await settle();
  assert.equal(h.manager.currentState, 'running');
  assert.deepEqual(ready, ['new-owner']);
});

test('Create Session input allows focus-out cancellation without daemon or write side effects', async t => {
  const h = host(); t.after(() => h.manager.dispose());
  let starts = 0;
  h.manager.ensureRunning = async () => { starts++; return true; };
  const action = sessionActionFor(h, 'ignored', {cancelTask:true});
  await action.run();
  assert.equal(action.inputs[0].ignoreFocusOut, false);
  assert.ok(action.inputs[0].title);
  assert.equal(starts, 0); assert.deepEqual(action.created, []);
  assert.equal(action.after, 0); assert.deepEqual(action.statuses, []);
});

test('Create Session folder selection is titled and cancellation ends before task input', async t => {
  const h = host(); t.after(() => h.manager.dispose());
  let starts = 0; h.manager.ensureRunning = async () => { starts++; return true; };
  const action = sessionActionFor(h, 'ignored', {cancelFolder:true, folders:[
    {name:'one',uri:{fsPath:'/fixture/one'}},{name:'two',uri:{fsPath:'/fixture/two'}}]});
  await action.run();
  assert.equal(action.picks[0].options.ignoreFocusOut, false);
  assert.ok(action.picks[0].options.title);
  assert.deepEqual(action.inputs, []); assert.deepEqual(action.created, []);
  assert.equal(starts, 0); assert.equal(action.after, 0);
});

test('Create Session accepts an explicitly empty task, unlike cancellation', async t => {
  const h = host(); t.after(() => h.manager.dispose());
  h.api.health = async () => ({ok:true, version:'fixture', daemon_id:'verified', start_fingerprint:h.manager.fingerprint(),
    public_base_url:'https://current.example.org', tunnel:'off'});
  const action = sessionActionFor(h, ''); await action.run();
  assert.equal(action.created.length, 1); assert.equal(action.created[0][1], '');
  assert.equal(action.after, 1);
});

test('unreadable listener remains bounded and cannot authorize shutdown or spawn', async t => {
  let now = 0; const budgets = [];
  const h = host({Date:{now:()=>now}}); t.after(()=>h.manager.dispose());
  h.api.health = async budget => {budgets.push(budget);now += budget;throw Error('fixture timeout');};
  h.manager.listenerOpen = async () => true;
  let shutdowns = 0; h.api.shutdown = async () => {shutdowns++;};
  assert.equal(await h.manager.stop(true),false);
  assert.equal(now,12000);
  assert.ok(budgets.every(b=>b>0&&b<=2000));
  assert.equal(shutdowns,0);assert.equal(h.spawns,0);
  assert.equal(h.manager.currentState,'error');
});

test('disposing during an unreadable handoff stops subsequent health probes', async () => {
  const h = host(); let reads = 0;
  h.api.health = async () => {reads++;h.manager.dispose();throw Error('disposed fixture');};
  h.manager.listenerOpen = async () => true;
  assert.equal(await h.manager.waitForHealthOrClosed(),undefined);
  assert.equal(reads,1);
});
