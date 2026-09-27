import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const source = fs.readFileSync(new URL('../src/daemonManager.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };

function makeManager() {
  const notices = [], logs = [], store = new Map([['blackhole.daemonStartFingerprint', 'old']]);
  const context = {
    extensionPath: process.cwd(),
    extension: { packageJSON: { version: 'fixture' } },
    globalState: { get: key => store.get(key), update: async (key, value) => { store.set(key, value); } },
  };
  const api = {
    health: async () => ({ ok: true, version: 'fixture', daemon_id: 'fixture-daemon' }),
    shutdown: async () => ({ ok: true }),
  };
  const vscode = {
    EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
    ProgressLocation: { Notification: 1 },
    env: { appRoot: process.cwd(), shell: '' },
    workspace: { getConfiguration: () => ({ get: () => undefined }) },
    window: {
      withProgress: (_options, task) => task(),
      showErrorMessage: text => notices.push(text),
      showWarningMessage() {},
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(js, {
    module, exports: module.exports, process, console, setTimeout, clearTimeout,
    require: name => name === 'vscode' ? vscode
      : name === './cloudEnvironment' ? { resolveCloudEndpoint: () => ({ environment: 'test' }) }
      : name === './vscodeRipgrep' ? { pathFromEnvironment: () => '', prependToolDirectory: value => value, resolveExecutionRg: () => undefined }
      : require(name),
  });
  const manager = new module.exports.DaemonManager(context, () => ({}), api, { appendLine: line => logs.push(line) });
  manager.fingerprint = () => 'new';
  return { manager, context, api, store, notices, logs };
}

function harness() {
  const h = makeManager();
  // The live daemon is independent from per-window globalState. Persisting an
  // intended fingerprint is not proof that a new process actually owns the port.
  let liveFingerprint = 'old';
  h.manager.health = async () => ({ ok: true, version: 'fixture', daemon_id: 'fixture-daemon', start_fingerprint: liveFingerprint });
  let stops = 0, starts = 0;
  // Keep the real public lifecycle queue; replace only the external IO stages.
  h.manager.stopOnce = async () => { stops++; return true; };
  h.manager.ensureRunningOnce = async () => {
    starts++; liveFingerprint = h.manager.fingerprint();
    await h.context.globalState.update('blackhole.daemonStartFingerprint', liveFingerprint);
    return true;
  };
  return { ...h, setLive: value => { liveFingerprint = value; }, get stops() { return stops; }, get starts() { return starts; } };
}

test('manual restart and delayed config watcher share one stop/start through fingerprint persistence', async () => {
  const h = harness(), commit = deferred();
  h.context.globalState.update = async (key, value) => { await commit.promise; h.store.set(key, value); };
  const manual = h.manager.restart(); await settle();
  const watcher = h.manager.syncConfigRestart(); await settle();
  assert.equal(h.stops, 1); assert.equal(h.starts, 1);
  commit.resolve(); await Promise.all([manual, watcher]);
  await h.manager.syncConfigRestart();
  assert.equal(h.stops, 1); assert.equal(h.starts, 1);
});

test('a watcher health read that finishes after the manual restart does not restart again', async () => {
  const h = harness(), probe = deferred(); let reads = 0;
  h.manager.health = () => ++reads === 1
    ? probe.promise
    : Promise.resolve({ ok: true, version: 'fixture', daemon_id: 'fixture-daemon', start_fingerprint: 'new' });
  const watcher = h.manager.syncConfigRestart(); await settle();
  const manual = h.manager.restart(); await manual;
  probe.resolve({ ok: true, version: 'fixture', daemon_id: 'fixture-daemon', start_fingerprint: 'new' }); await watcher;
  assert.equal(h.stops, 1); assert.equal(h.starts, 1);
});

test('concurrent restart requests share the same result and a later explicit restart remains possible', async () => {
  const h = harness(), gate = deferred(); let run = 0;
  h.manager.ensureRunningOnce = async () => { run++; if (run === 1) await gate.promise; h.setLive('new'); h.store.set('blackhole.daemonStartFingerprint', 'new'); return true; };
  const first = h.manager.restart(), duplicate = h.manager.restart();
  assert.equal(first, duplicate); await settle(); assert.equal(run, 1);
  gate.resolve(); assert.equal(await first, true);
  const later = h.manager.restart(); assert.equal(await later, true);
  assert.equal(h.stops, 2); assert.equal(run, 2);
});

test('a failed restart does not mark a new configuration as successfully applied', async () => {
  const h = harness(); h.manager.ensureRunningOnce = async () => false;
  await h.manager.syncConfigRestart();
  assert.equal(h.store.get('blackhole.daemonStartFingerprint'), 'old');
  assert.equal(h.notices.length, 1);
  h.manager.ensureRunningOnce = async () => { h.setLive('new'); h.store.set('blackhole.daemonStartFingerprint', 'new'); return true; };
  await h.manager.syncConfigRestart();
  assert.equal(h.store.get('blackhole.daemonStartFingerprint'), 'new');
});

test('a thrown restart failure is reported and releases the lifecycle queue for a retry', async () => {
  const h = harness(); h.manager.ensureRunningOnce = async () => { throw Error('fixture failure'); };
  assert.equal(await h.manager.restart(), false);
  assert.match(h.logs.join('\n'), /fixture failure/);
  h.manager.ensureRunningOnce = async () => { h.setLive('new'); h.store.set('blackhole.daemonStartFingerprint', 'new'); return true; };
  assert.equal(await h.manager.restart(), true);
});

test('a newer configuration arriving during startup is applied after the in-flight restart', async () => {
  const h = harness(), ready = deferred(); let desired = 'new', starts = 0;
  h.manager.fingerprint = () => desired;
  h.manager.ensureRunningOnce = async () => {
    const spawned = desired; starts++;
    if (starts === 1) await ready.promise;
    h.setLive(spawned); h.store.set('blackhole.daemonStartFingerprint', spawned); return true;
  };
  const manual = h.manager.restart(); await settle();
  desired = 'newer'; const watcher = h.manager.syncConfigRestart();
  ready.resolve(); await Promise.all([manual, watcher]);
  assert.equal(h.store.get('blackhole.daemonStartFingerprint'), 'newer');
  assert.equal(h.stops, 2, 'two different configurations require two serial restarts');
  assert.equal(starts, 2);
});

test('concurrent ensureRunning calls share one startup operation and later retries are possible', async () => {
  const h = makeManager(), gate = deferred(); let starts = 0;
  h.manager.ensureRunningOnce = async () => { starts++; await gate.promise; return true; };
  const first = h.manager.ensureRunning(), duplicate = h.manager.ensureRunning();
  assert.equal(first, duplicate); await settle(); assert.equal(starts, 1);
  gate.resolve(); assert.equal(await first, true);
  h.manager.ensureRunningOnce = async () => { starts++; return true; };
  assert.equal(await h.manager.ensureRunning(), true); assert.equal(starts, 2);
});

test('a live matching startup fingerprint repairs stale per-window state without another restart', async () => {
  const h = harness();
  h.manager.health = async () => ({ ok: true, version: 'fixture', daemon_id: 'fresh', start_fingerprint: 'new' });
  await h.manager.syncConfigRestart();
  assert.equal(h.store.get('blackhole.daemonStartFingerprint'), 'new');
  assert.equal(h.stops, 0); assert.equal(h.starts, 0);
});

test('restart shutdown targets one daemon identity and waits for its teardown', async () => {
  const h = makeManager(), released = deferred(); let shutdownId, settled = false;
  h.manager.health = async () => ({ ok: true, version: 'fixture', daemon_id: 'old-daemon' });
  h.manager.waitForDaemonChange = () => released.promise;
  h.api.shutdown = async id => { shutdownId = id; return { ok: true }; };
  const pending = h.manager.stop(true).then(value => { settled = true; return value; });
  await settle(); assert.equal(shutdownId, 'old-daemon'); assert.equal(settled, false);
  released.resolve(true); assert.equal(await pending, true);
});

test('a stale shutdown request preserves a daemon another window already replaced', async () => {
  const h = makeManager();
  h.manager.health = async () => ({ ok: true, version: 'fixture', daemon_id: 'old-daemon' });
  h.api.shutdown = async () => { const error = Error('daemon_changed'); error.status = 409; throw error; };
  assert.equal(await h.manager.stop(true), true);
  assert.match(h.logs.join('\n'), /preserving the replacement/);
});

test('restart does not spawn when the old daemon fails to stop', async () => {
  const h = makeManager(); let starts = 0;
  h.manager.stopOnce = async () => false;
  h.manager.ensureRunningOnce = async () => { starts++; return true; };
  assert.equal(await h.manager.restart(), false); assert.equal(starts, 0);
});


test('shutdown wait does not treat a slow health request as stopped while the listener is open', async () => {
  const h = makeManager(); let listenerChecks = 0;
  h.manager.health = async () => undefined;
  h.manager.listenerOpen = async () => ++listenerChecks === 1;
  assert.equal(await h.manager.waitForDaemonChange('old-daemon'), true);
  assert.equal(listenerChecks, 2, 'one missed health response is not enough to declare shutdown complete');
});


test('stop does not report success while the daemon listener is still occupied but health never becomes readable', async () => {
  const h = makeManager(); let shutdowns = 0;
  h.manager.waitForHealthOrClosed = async () => undefined;
  h.api.shutdown = async () => { shutdowns++; return { ok: true }; };
  assert.equal(await h.manager.stop(true), false);
  assert.equal(shutdowns, 0);
  assert.match(h.logs.join('\n'), /listener stayed open.*health was unavailable/i);
});

test('health-unavailable startup waits for the listener to close instead of assuming stopped immediately', async () => {
  const h = makeManager(); let listenerChecks = 0;
  h.manager.health = async () => undefined;
  h.manager.listenerOpen = async () => ++listenerChecks === 1;
  assert.equal(await h.manager.waitForHealthOrClosed(), null);
  assert.equal(listenerChecks, 2);
});

test('restart fails when another window replaces the daemon with a different fingerprint', async () => {
  const h = makeManager(); let shutdowns = 0;
  h.manager.fingerprint = () => 'wanted';
  h.manager.health = async () => ({ ok: true, version: 'fixture', daemon_id: 'replacement', start_fingerprint: 'other' });
  h.api.shutdown = async () => { shutdowns++; const error = Error('daemon_changed'); error.status = 409; throw error; };
  h.manager.ensureRunningOnce = async () => true;
  assert.equal(await h.manager.restart(), false);
  assert.equal(shutdowns, 3, 'a competing old window is retried with bounded guarded handoffs');
  assert.match(h.logs.join('\n'), /did not confirm the requested daemon fingerprint/);
});


test('activation adopts a same-build daemon from another window instead of restarting for window-local config', async () => {
  const h = harness();
  const live = JSON.stringify({ version: 'fixture', bundleMtime: 123, terminalShell: 'window-a' });
  const wanted = JSON.stringify({ version: 'fixture', bundleMtime: 123, terminalShell: 'window-b' });
  h.manager.fingerprint = () => wanted;
  h.setLive(live);
  await h.manager.syncConfigRestart(true);
  assert.equal(h.stops, 0); assert.equal(h.starts, 0);
  await h.manager.syncConfigRestart(false);
  assert.equal(h.stops, 1); assert.equal(h.starts, 1, 'an explicit config change still applies the full fingerprint');
});


test('restart validates the configuration actually applied after settings change during shutdown', async () => {
  const h = makeManager(), stopped = deferred(); let desired = 'before-stop', live = 'old';
  h.manager.fingerprint = () => desired;
  h.manager.stopOnce = () => stopped.promise;
  h.manager.health = async () => ({ok:true, version:'fixture', daemon_id:'new-daemon', start_fingerprint:live});
  h.manager.ensureRunningOnce = async () => { live = desired; return true; };
  const pending = h.manager.restart(); await settle();
  desired = 'after-stop'; stopped.resolve(true);
  assert.equal(await pending, true, 'a successfully applied newer setting must not be compared with the stale pre-stop snapshot');
  assert.doesNotMatch(h.logs.join('\n'), /different configuration fingerprint/);
});

for (const key of ['cloudflaredPath', 'skillsDir', 'daemonEntry', 'cloudOrigin', 'tunnelProbeProxy']) {
  test(`activation must not silently ignore changed ${key} merely because the version/mtime match`, async () => {
    const h = harness();
    const live = JSON.stringify({version:'fixture', bundleMtime:123, [key]:'old'});
    const wanted = JSON.stringify({version:'fixture', bundleMtime:123, [key]:'new'});
    h.manager.fingerprint = () => wanted;
    h.setLive(live);
    await h.manager.syncConfigRestart(true);
    assert.equal(h.stops, 1, 'real configuration changes require reconciliation');
  });
}


test('a cached fingerprint never certifies a daemon that omits live proof or runs older code', async () => {
  const h = makeManager();
  h.store.set('blackhole.daemonStartFingerprint', 'new');
  assert.equal(await h.manager.liveFingerprintMatches('new', {ok:true, version:'fixture', daemon_id:'legacy'}), false);
  assert.equal(await h.manager.liveFingerprintMatches('new', {ok:true, version:'0.3.165', daemon_id:'legacy', start_fingerprint:'new'}), false);
  assert.equal(h.store.get('blackhole.daemonStartFingerprint'), 'new', 'cache is not cleared or mistaken for live proof');
});

test('stop refuses to send an unbound shutdown when legacy health has no identity', async () => {
  const h = makeManager(); let requests = 0;
  h.manager.waitForHealthOrClosed = async () => ({ok:true, version:'legacy'});
  h.api.shutdown = async () => { requests++; return {ok:true}; };
  assert.equal(await h.manager.stop(true), false);
  assert.equal(requests, 0);
  assert.match(h.manager.error, /no identity/);
});

test('restart tolerates a single missed post-start health response before confirming the new daemon', async () => {
  const h = makeManager(); let reads = 0;
  h.manager.stopOnce = async () => true;
  h.manager.ensureRunningOnce = async () => true;
  h.manager.health = async () => ++reads === 1 ? undefined
    : {ok:true, version:'fixture', daemon_id:'new-daemon', start_fingerprint:'new'};
  assert.equal(await h.manager.restart(), true);
  assert.equal(reads, 2);
  assert.equal(h.store.get('blackhole.daemonStartFingerprint'), 'new');
  assert.doesNotMatch(h.logs.join('\n'), /health=unavailable/);
});

test('an old window reclaiming the port triggers a bounded second handoff instead of a false success', async () => {
  const h = makeManager(); let stops = 0, starts = 0;
  let owner = {ok:true, version:'0.3.165', daemon_id:'old-window'};
  h.manager.health = async () => owner;
  h.manager.stopOnce = async () => { stops++; return true; };
  h.manager.ensureRunningOnce = async () => {
    if (++starts === 2) owner = {ok:true, version:'fixture', daemon_id:'new-window', start_fingerprint:'new'};
    return true;
  };
  assert.equal(await h.manager.restart(), true);
  assert.equal(stops, 2); assert.equal(starts, 2);
  assert.match(h.logs.join('\n'), /retrying handoff/);
});

test('a persistent competing owner fails visibly after three attempts, never staying falsely running', async () => {
  const h = makeManager(); let stops = 0;
  h.manager.health = async () => ({ok:true, version:'0.3.165', daemon_id:'old-window'});
  h.manager.stopOnce = async () => { stops++; return true; };
  h.manager.ensureRunningOnce = async () => { h.manager.setState('running'); return true; };
  assert.equal(await h.manager.restart(), false);
  assert.equal(stops, 3);
  assert.equal(h.manager.currentState, 'error');
  assert.match(h.logs.join('\n'), /fields=missing; health=available/);
});

// Real loopback HTTP: repeated short AbortSignals must not starve a healthy
// control endpoint whose replies arrive after 750ms during extension activation.
test('handoff reads a slow healthy listener instead of aborting every response', {timeout:20000}, async t => {
  const h = makeManager(); t.after(() => h.manager.dispose());
  let reads = 0;
  let owner = {ok:true,version:'fixture',daemon_id:'slow-owner',start_fingerprint:'new'};
  const server = http.createServer((_req,res) => {
    reads++;
    const timer = setTimeout(() => { res.setHeader('Content-Type','application/json');
      res.end(JSON.stringify(owner)); }, 750);
    res.on('close',()=>clearTimeout(timer));
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(async () => {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const url = `http://127.0.0.1:${server.address().port}/api/health`;
  h.api.health = async timeout => (await fetch(url,{signal:AbortSignal.timeout(timeout)})).json();
  h.manager.listenerOpen = async () => true;
  const live = await h.manager.waitForHealthOrClosed();
  assert.equal(live?.daemon_id, 'slow-owner');
  assert.equal(await h.manager.waitForDaemonChange('retired-owner'),true);
  assert.ok(reads <= 4, 'bounded slow probes, not a storm of guaranteed aborts');
  owner = {...owner, daemon_id:'old-owner', start_fingerprint:'old'};
  let shutdowns = 0;
  h.api.shutdown = async (id, fingerprint) => {
    assert.equal(id,'old-owner');assert.equal(fingerprint,'old');shutdowns++;
    owner = {...owner,daemon_id:'replacement',start_fingerprint:'new'};
    return {ok:true};
  };
  // Same public config-sync path as the reported notification, not only helpers.
  await h.manager.syncConfigRestart(true);
  assert.equal(shutdowns,1);assert.equal(h.manager.currentState,'running');
  assert.deepEqual(h.notices, []);
});
