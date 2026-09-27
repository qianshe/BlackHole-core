import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { ProcessManager } from '../../../dist/process/manager.js';
const require = createRequire(import.meta.url), ts = require('typescript');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function harness(t, options = {}) {
  fs.mkdirSync('.cache/tests', { recursive: true }); const root = fs.realpathSync(fs.mkdtempSync('.cache/tests/process-terminal-'));
  const terminals = [], stops = [], children = [], notices = [], requests = [];
  class Emitter { listeners = new Set(); event = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; }; fire(value) { for (const f of this.listeners) f(value); } dispose() { this.listeners.clear(); } }
  const vscode = { EventEmitter: Emitter, env: { remoteName: options.remoteName }, workspace: { workspaceFolders: [] }, window: {
    createTerminal(config) {
      if (options.failCreate) throw Error('Synthetic VS Code failure');
      const terminal = { config, output: '', shows: 0, disposed: false,
        show() { this.shows++; }, open() { config.pty.open({ columns: 100, rows: 30 }); },
        dispose() { if (this.disposed) return; this.disposed = true; config.pty.close(); } };
      config.pty.onDidWrite(text => { terminal.output += text; }); terminals.push(terminal); return terminal;
    },
    showInformationMessage: async msg => notices.push(msg), showWarningMessage: async msg => notices.push(msg), showQuickPick: async choices => choices[0],
  } };
  const source = fs.readFileSync(new URL('../src/processTerminals.ts', import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = { exports: {} }; vm.runInNewContext(js, { module: mod, exports: mod.exports, require: name => name === 'vscode' ? vscode : require(name), process: { ...process, platform: options.platform ?? process.platform }, console, setInterval, clearInterval });
  let manager = new ProcessManager({ daemonId: 'daemon-one', now: options.now, backend: (spec, cb) => { children.push({ spec, cb }); return { pid: children.length, stop: async () => { stops.push(spec.processId); cb.exit({ exitCode: 1, cleanupConfirmed: true }); } }; } });
  const owner = { sessionId: 'session-a', workspace: root, mode: 'workspace-write', writableDirs: [] };
  const api = { processSync: async input => { requests.push(input); return manager.syncView(input.clientId, input.workspaces, input.cursors, input.acknowledgements, input.reopen); },
    processStop: async input => manager.stopFromView(input.clientId, input.workspaces, input.processId) };
  const controller = new mod.exports.ProcessTerminalController(api, { roots: () => [root], ...(options.useDefaults ? {} : { enabled: options.enabled ?? true }) });
  t.after(async () => { controller.dispose(); await manager.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return { controller, api, root, owner, terminals, stops, children, requests, notices, get manager() { return manager; },
    start: async name => manager.start(owner, { requestId: name, name, script: 'fixture' }, async () => {}),
    changeDaemon: next => { manager = next; }, Constructor: mod.exports.ProcessTerminalController };
}
for (const platform of ['win32', 'darwin', 'linux']) test('local desktop terminal accepts daemon capability on ' + platform, async t => {
  const h = harness(t, { platform, useDefaults: true }), row = await h.start('desktop');
  await h.controller.poll(); assert.equal(h.terminals.length, 1);
  h.terminals[0].open(); await h.controller.poll();
  assert.equal(h.manager.status('session-a', row.processId).terminal.state, 'open');
});
test('remote windows remain disabled until their daemon transport is explicitly supported', async t => {
  const h = harness(t, { platform: 'linux', remoteName: 'ssh-remote', useDefaults: true });
  await h.start('remote'); await h.controller.poll();
  assert.equal(h.requests.length, 0); assert.equal(h.terminals.length, 0);
});
test('extension exposes distinct stop and stop-and-close commands', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const commands = new Map(manifest.contributes.commands.map(entry => [entry.command, entry.title]));
  assert.equal(commands.get('blackhole.stopProcess'), '停止后台进程');
  assert.equal(commands.get('blackhole.stopAndCloseProcess'), '停止并关闭后台进程');
  const extension = fs.readFileSync(new URL('../src/extension.ts', import.meta.url), 'utf8');
  assert.match(extension, /blackhole\.stopProcess[^\n]+stopSelected/);
  assert.match(extension, /blackhole\.stopAndCloseProcess[^\n]+stopAndCloseSelected/);
});

test('three processes use three independent Pseudoterminals; only open callback acknowledges display', async t => {
  const h = harness(t), rows = await Promise.all(['A', 'B', 'C'].map(h.start));
  await h.controller.poll(); assert.equal(h.terminals.length, 3); assert.equal(new Set(h.terminals.map(t => t.config.pty)).size, 3);
  assert.ok(rows.every(r => h.manager.status('session-a', r.processId).terminal.state === 'pending'));
  h.terminals.forEach(terminal => terminal.open()); await h.controller.poll();
  assert.ok(rows.every(r => h.manager.status('session-a', r.processId).terminal.state === 'open'));
  for (let i = 0; i < 3; i++) { h.children[i].cb.output('stdout', Buffer.from('unique-' + i + '\n')); h.children[i].cb.output('stderr', Buffer.from('error-' + i + '\n')); }
  await h.controller.poll();
  h.terminals.forEach((terminal, i) => { assert.match(terminal.output, new RegExp('unique-' + i)); assert.match(terminal.output, new RegExp('error-' + i)); assert.equal(terminal.shows, 1); });
  h.terminals[1].config.pty.handleInput('ignored arbitrary command\r'); assert.equal(h.stops.length, 0);
  h.terminals[1].config.pty.handleInput('\x03'); await tick(); assert.deepEqual(h.stops, [rows[1].processId]);
});
test('logs produced before delayed terminal open are retained and only emitted after open', async t => {
  const h = harness(t); await h.start('A'); h.children[0].cb.output('stderr', Buffer.from('initial failure\n'));
  await h.controller.poll(); assert.equal(h.terminals[0].output, '');
  h.terminals[0].open(); assert.match(h.terminals[0].output, /initial failure/); assert.match(h.terminals[0].output, /关闭终端都会停止此任务/);
  await h.controller.poll(); assert.equal((h.terminals[0].output.match(/initial failure/g) ?? []).length, 1);
});
test('manually closing a process terminal stops that task instead of leaving it hidden', async t => {
  const h = harness(t), row = await h.start('A'); await h.controller.poll(); h.terminals[0].open(); await h.controller.poll();
  h.terminals[0].dispose(); await new Promise(resolve => setTimeout(resolve, 0)); await h.controller.poll();
  assert.deepEqual(h.stops, [row.processId]); assert.equal(h.manager.status('session-a', row.processId).state, 'exited');
  assert.equal(h.terminals.length, 1); assert.equal(h.children.length, 1);
});
test('exit keeps the terminal and final stderr; no false automatic restart', async t => {
  const h = harness(t); await h.start('fail'); await h.controller.poll(); h.terminals[0].open();
  h.children[0].cb.output('stderr', Buffer.from('fatal\n')); h.children[0].cb.exit({ exitCode: 7, cleanupConfirmed: true });
  await h.controller.poll(); assert.match(h.terminals[0].output, /fatal/); assert.match(h.terminals[0].output, /exited · exit 7/); assert.equal(h.terminals[0].disposed, false); assert.equal(h.children.length, 1);
});
test('stop-and-close disposes only the selected terminal after confirmed cleanup; normal stop keeps logs visible', async t => {
  const h = harness(t), rows = await Promise.all(['keep-log', 'close-log'].map(h.start));
  await h.controller.poll(); h.terminals.forEach(terminal => terminal.open()); await h.controller.poll();
  await h.controller.stopSelected();
  assert.deepEqual(h.stops, [rows[0].processId]); assert.equal(h.terminals[0].disposed, false);
  assert.equal(h.manager.status('session-a', rows[1].processId).state, 'running');
  await h.controller.stopAndCloseSelected();
  assert.deepEqual(h.stops, [rows[0].processId, rows[1].processId]);
  assert.equal(h.terminals[0].disposed, false); assert.equal(h.terminals[1].disposed, true);
});
test('agent closeTerminal request closes only the confirmed target terminal on the next sync', async t => {
  const h = harness(t), rows = await Promise.all(['agent-close', 'keep-open'].map(h.start));
  await h.controller.poll(); h.terminals.forEach(terminal => terminal.open()); await h.controller.poll();
  await h.manager.stop('session-a', rows[0].processId, 'operator_stop', true); await h.controller.poll(); await h.controller.poll();
  assert.equal(h.terminals[0].disposed, true); assert.equal(h.terminals[1].disposed, false);
  assert.equal(h.manager.status('session-a', rows[1].processId).state, 'running');
});
test('stop-and-close keeps the terminal when cleanup is not confirmed', async t => {
  const h = harness(t); await h.start('unknown'); await h.controller.poll(); h.terminals[0].open(); await h.controller.poll();
  h.api.processStop = async () => ({ state: 'unknown', reason: 'stop_failed' });
  await h.controller.stopAndCloseSelected();
  assert.equal(h.terminals[0].disposed, false); assert.match(h.terminals[0].output, /停止未确认/);
});
test('disconnect/reconnect does not duplicate logs or terminals, and polling cannot overlap', async t => {
  const h = harness(t); await h.start('A'); await h.controller.poll(); h.terminals[0].open(); await h.controller.poll();
  const original = h.api.processSync, d = deferred(); h.api.processSync = async input => { await d.promise; return original(input); };
  const polling = h.controller.poll(); await h.controller.poll(); const count = h.requests.length; d.resolve(); await polling; assert.equal(h.requests.length, count + 1);
  h.api.processSync = async () => { throw Error('offline'); }; await h.controller.poll(); await h.controller.poll();
  assert.equal((h.terminals[0].output.match(/连接中断/g) ?? []).length, 1);
  h.api.processSync = original; h.children[0].cb.output('stdout', Buffer.from('after-reconnect\n')); await h.controller.poll(); await h.controller.poll();
  assert.equal((h.terminals[0].output.match(/after-reconnect/g) ?? []).length, 1); assert.equal(h.terminals.length, 1);
});
test('a late reply after dispose cannot create a terminal or stop a process', async t => {
  const h = harness(t); await h.start('A'); const original = h.api.processSync, d = deferred();
  h.api.processSync = async input => { await d.promise; return original(input); };
  const poll = h.controller.poll(); h.controller.dispose(); d.resolve(); await poll;
  assert.equal(h.terminals.length, 0); assert.equal(h.stops.length, 0);
});
test('daemon identity changes retire old views; reused names never imply shared identity', async t => {
  const h = harness(t); await h.start('A'); await h.controller.poll(); h.terminals[0].open();
  const next = new ProcessManager({ daemonId: 'daemon-two', backend: (spec, cb) => ({ pid: 77, stop: async () => cb.exit({ exitCode: 0, cleanupConfirmed: true }) }) });
  await h.manager.dispose(); h.changeDaemon(next); await h.start('A'); await h.controller.poll();
  assert.equal(h.terminals[0].disposed, true); assert.equal(h.terminals.length, 2); assert.notEqual(h.terminals[0].config.name, h.terminals[1].config.name);
});
test('VS Code failure returns unavailable, and disabled/remote controllers never create terminals', async t => {
  const h = harness(t, { failCreate: true }), row = await h.start('A'); await h.controller.poll(); await h.controller.poll();
  assert.equal(h.manager.status('session-a', row.processId).terminal.state, 'unavailable'); assert.equal(h.stops.length, 0);
  const remote = harness(t, { enabled: false }); await remote.start('A'); await remote.controller.poll(); assert.equal(remote.terminals.length, 0); assert.equal(remote.requests.length, 0);
});

test('reconnecting the same window after lease expiry preserves its acknowledged open view', async t => {
  let now = Date.now(); const h = harness(t, { now: () => now }), row = await h.start('A');
  await h.controller.poll(); h.terminals[0].open(); await h.controller.poll();
  now += 6000;
  assert.equal(h.manager.status('session-a', row.processId).terminal.state, 'unavailable');
  await h.controller.poll(); await h.controller.poll();
  assert.equal(h.manager.status('session-a', row.processId).terminal.state, 'open');
  assert.equal(h.terminals.length, 1); assert.equal(h.children.length, 1);
});
test('a view closed during a disconnect stops its task after the delayed acknowledgement', async t => {
  let now = Date.now(); const h = harness(t, { now: () => now }), row = await h.start('A');
  await h.controller.poll(); h.terminals[0].open(); await h.controller.poll();
  now += 6000; h.terminals[0].dispose();
  await h.controller.poll(); await h.controller.poll();
  assert.equal(h.manager.status('session-a', row.processId).terminal.state, 'closed');
  assert.equal(h.terminals.length, 1); assert.deepEqual(h.stops, [row.processId]);
});
