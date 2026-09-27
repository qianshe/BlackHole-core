// Real DaemonManager -> child process -> HTTP health/shutdown. Only VS Code is
// simulated; every process, DB, log and environment is private to this fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url), ts = require('typescript');
const root = fileURLToPath(new URL('../../../', import.meta.url));
const source = fs.readFileSync(new URL('../src/daemonManager.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const apiSource = fs.readFileSync(new URL('../src/controlApi.ts', import.meta.url), 'utf8');
const apiModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(apiSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
  { module: apiModule, exports: apiModule.exports, fetch, AbortSignal, require: name => name === './config'
    ? { apiBase: port => `http://127.0.0.1:${port}/api` } : require(name) });
const { ControlApi } = apiModule.exports;

test('real manager upgrades a 0.3.165 listener, protects it from old hosts, then preserves shared-window and port handoffs', { timeout: 60000 }, async t => {
  fs.mkdirSync(path.join(root, '.cache/tests'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, '.cache/tests/manager-live-'));
  const reservation = net.createServer();
  await new Promise((resolve, reject) => reservation.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const entry = process.env.BH_MANAGER_TEST_ENTRY ? path.resolve(process.env.BH_MANAGER_TEST_ENTRY) : path.join(root, 'dist/cli.js');
  assert.ok(fs.existsSync(entry), 'build the daemon before running the fixture');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['PATH','SYSTEMROOT','WINDIR','COMSPEC','PATHEXT','LANG'].includes(key.toUpperCase())));
  Object.assign(env, { HOME:dir, USERPROFILE:dir, APPDATA:dir, LOCALAPPDATA:dir, TEMP:dir, TMP:dir, TMPDIR:dir,
    BLACKHOLE_DB:path.join(dir,'fixture.db'), BLACKHOLE_SEMANTIC:'off', BLACKHOLE_PROXY_CONFIG:path.join(dir,'absent.yaml') });
  const children = [], managers = [], notices = [], logs = [];
  let legacy;
  const api = {
    async request(route, body, timeout = 8000) {
      const res = await fetch(`http://127.0.0.1:${port}/api${route}`, { method:body===undefined?'GET':'POST',
        headers:{'Content-Type':'application/json'}, body:body===undefined?undefined:JSON.stringify(body), signal:AbortSignal.timeout(timeout) });
      const value = await res.json();
      if (!res.ok) { const error = Error(value.error ?? `HTTP ${res.status}`); error.status = res.status; throw error; }
      return value;
    },
    health(timeout) { return this.request('/health', undefined, timeout); },
    shutdown(id, fingerprint) { return this.request('/shutdown', { daemon_id:id, start_fingerprint:fingerprint ?? null }); },
  };
  t.after(async () => {
    for (const manager of managers) manager.dispose();
    if (legacy?.listening) await new Promise(resolve => legacy.close(resolve));
    // Kill only children returned by this fixture; never inspect or stop the user's daemon.
    for (const {child,closed} of children) {
      child.ref();
      if (child.exitCode===null && child.signalCode===null) child.kill('SIGKILL');
      let timer;
      try { await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('fixture cleanup timeout')), 5000); })]); }
      finally { clearTimeout(timer); }
    }
    fs.rmSync(dir, { recursive:true, force:true, maxRetries:5, retryDelay:100 });
  });
  function manager(shell, overrides = {}) {
    const cfg = { port, daemonEntry:entry, cloudflaredPath:'', channelMode:'custom', namedTunnelName:'fixture',
      publicBaseUrl:'', gitUsrBinPath:'', tunnelProbeProxy:'', skillsDir:'', semanticMode:'off', ...overrides };
    const store = new Map();
    const context = { extensionPath:root, extension:{packageJSON:{version}}, globalState:{get:key=>store.get(key),update:async(key,value)=>{store.set(key,value)}} };
    const vscode = {
      EventEmitter:class { inner=new EventEmitter(); event=fn=>{this.inner.on('state',fn);return{dispose:()=>this.inner.off('state',fn)}}; fire(value){this.inner.emit('state',value)} dispose(){this.inner.removeAllListeners()} },
      ProgressLocation:{Notification:1}, env:{appRoot:root,shell}, workspace:{getConfiguration:()=>({get:()=>undefined})},
      window:{showErrorMessage:text=>notices.push(text),showWarningMessage:text=>notices.push(text),withProgress:(_options,task)=>task()},
    };
    const module = {exports:{}};
    vm.runInNewContext(js, { module,exports:module.exports,console,setTimeout,clearTimeout,
      process:{env,platform:process.platform,arch:process.arch,execPath:process.env.BH_MANAGER_TEST_RUNTIME ?? process.execPath},
      require:name=>name==='vscode'?vscode
        :name==='./cloudEnvironment'?{resolveCloudEndpoint:()=>({environment:'test',origin:'https://fixture.example.org'})}
        :name==='./vscodeRipgrep'?{resolveExecutionRg:()=>undefined,pathFromEnvironment:()=>'',prependToolDirectory:value=>value}
        :name==='node:os'?{tmpdir:()=>dir}
        :name==='node:child_process'?{spawn:(...args)=>{const child=spawn(...args);const closed=new Promise(resolve=>child.once('close',resolve));children.push({child,closed});return child}}
        :require(name),
    });
    const control = new ControlApi(() => cfg);
    const value = new module.exports.DaemonManager(context,()=>cfg,control,{appendLine:line=>logs.push(line)});
    managers.push(value);return {value,cfg,control};
  }
  // Model the still-running 0.3.165 daemon after a VS Code reinstall. Its
  // shutdown accepts the new client's extra precondition fields; its health
  // has neither the new live fingerprint nor this extension's version.
  legacy = http.createServer((req,res) => {
    res.setHeader('content-type','application/json');
    if (req.url === '/api/health') { res.end(JSON.stringify({ok:true,version:'0.3.165',daemon_id:'legacy-165'})); return; }
    if (req.url === '/api/shutdown' && req.method === 'POST') {
      res.end(JSON.stringify({ok:true})); setTimeout(() => legacy.close(), 50).unref(); return;
    }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise((resolve,reject) => legacy.once('error',reject).listen(port,'127.0.0.1',resolve));
  const a = manager(process.platform==='win32'?'powershell.exe':'/bin/sh');
  const start = a.value.ensureRunning(), duplicate = a.value.ensureRunning();
  assert.equal(start,duplicate);assert.equal(await start,true);
  assert.equal(children.length,0,'activation attaches before the guarded upgrade');
  assert.equal((await api.health()).version,'0.3.165');
  await a.value.syncConfigRestart(true);
  assert.equal(children.length,1);
  const initial = await api.health();
  assert.equal(initial.version,version);
  assert.equal(initial.start_fingerprint,a.value.fingerprint());
  assert.equal(initial.tunnel,'off','local readiness must not start a public channel');
  for (const body of [{}, {daemon_id:initial.daemon_id}]) {
    const oldWindow = await fetch(`http://127.0.0.1:${port}/api/shutdown`, {
      method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body),
    });
    assert.equal(oldWindow.status,409,'neither 0.3.165 nor 0.3.167 may shut down this daemon');
    assert.equal((await api.health()).daemon_id,initial.daemon_id);
  }
  const b = manager(process.platform==='win32'?'cmd.exe':'/bin/bash');
  await b.value.ensureRunning();await b.value.syncConfigRestart(true);
  assert.equal(children.length,1,'opening another window must reuse a matching machine configuration');
  assert.equal((await api.health()).daemon_id,initial.daemon_id);
  b.cfg.namedTunnelName='explicitly-updated';
  await b.value.syncConfigRestart();
  const updated = await api.health();
  assert.notEqual(updated.daemon_id,initial.daemon_id);
  assert.equal(updated.start_fingerprint,b.value.fingerprint());
  assert.equal(children.length,2);
  assert.equal(updated.tunnel,'off');assert.deepEqual(notices,[]);
  assert.doesNotMatch(logs.join('\n'),/different configuration fingerprint|did not stop|未就绪/);
  const nextReservation = net.createServer();
  await new Promise(resolve => nextReservation.listen(0, '127.0.0.1', resolve));
  const nextPort = nextReservation.address().port;
  await new Promise(resolve => nextReservation.close(resolve));
  b.cfg.port = nextPort;
  await b.value.syncConfigRestart();
  assert.equal(await b.value.ensureRunning(), true);
  const moved = await b.control.health();
  assert.equal(moved.db_path, updated.db_path);
  assert.notEqual(moved.daemon_id, updated.daemon_id);
  await assert.rejects(api.health(), 'old port must be closed before the new daemon can serve');
  assert.equal(children.filter(({child}) => child.exitCode === null && child.signalCode === null).length, 1);
  assert.equal(moved.start_fingerprint, b.value.fingerprint());
  // Both hosts observe stale configuration and upgrade concurrently. This is
  // deliberately not the easier sequential 'open B after A is ready' case.
  const c = manager(process.platform==='win32'?'powershell.exe':'/bin/sh', {port:nextPort,namedTunnelName:'concurrent-upgrade'});
  const d = manager(process.platform==='win32'?'cmd.exe':'/bin/bash', {port:nextPort,namedTunnelName:'concurrent-upgrade'});
  await Promise.all([c.value.syncConfigRestart(true),d.value.syncConfigRestart(true)]);
  const concurrent = await b.control.health();
  assert.notEqual(concurrent.daemon_id,moved.daemon_id);
  assert.ok(c.value.sameInstalledCode(c.value.fingerprint(),concurrent));
  assert.ok(d.value.sameInstalledCode(d.value.fingerprint(),concurrent));
  assert.deepEqual(notices,[],'neither upgrading window may report a false failure');
  await Promise.all([c.value.syncConfigRestart(true),d.value.syncConfigRestart(true)]);
  assert.equal((await b.control.health()).daemon_id,concurrent.daemon_id,'settled hosts must not restart each other');
  // B previously ran another machine-wide configuration. A passive status poll
  // must reject C/D's owner without restarting it back to B's stale settings.
  b.value.nextReconcileAt = 0;
  assert.equal(b.value.observeHealth(concurrent,b.value.captureHealthObservation()),false);
  if (b.value.syncPending) await b.value.syncPending;
  assert.equal((await b.control.health()).daemon_id,concurrent.daemon_id,'passive old host must not reverse the handoff');
  assert.equal(await b.value.stop(),true);
  t.diagnostic(`PASS legacy upgrade, guarded shutdown, shared-window adoption, explicit restart, port handoff ${port}->${nextPort} and shutdown; private DB; no login or tunnel`);
});
