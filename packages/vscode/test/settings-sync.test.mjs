// SettingsSync: first-copy migration, daemon→VS Code mirroring, VS Code edits pushed back, rejects reverted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const source = fs.readFileSync(new URL('../src/settingsSync.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;

function setup(daemon) {
  const conf = new Map(Object.entries({ connectorName: '', publicBaseUrl: '', cloudflaredPath: '', skillsDir: '', channelMode: 'cloudflare', semanticMode: 'explicit' }));
  const listeners = [];
  const warnings = [];
  const calls = [];
  const fire = (key) => listeners.forEach((l) => l({ affectsConfiguration: (s) => s === `blackhole.${key}` || s === 'blackhole' }));
  const vscode = {
    ConfigurationTarget: { Global: 1 },
    workspace: {
      getConfiguration: () => ({
        get: (k) => conf.get(k),
        update: async (k, v) => { conf.set(k, v); fire(k); },
      }),
      onDidChangeConfiguration: (l) => { listeners.push(l); return { dispose() {} }; },
    },
    window: { onDidChangeWindowState: () => ({ dispose() {} }), showWarningMessage: (m) => warnings.push(m) },
  };
  const api = {
    settings: async () => { calls.push(['get']); return structuredClone(daemon); },
    migrateSettings: async (values) => { calls.push(['migrate', values]); Object.assign(daemon, { migrated: true, revision: 1, values: { ...daemon.values, ...values } }); if (daemon.unseeded) daemon.unseeded = daemon.unseeded.filter((k) => !(k in values)); return structuredClone(daemon); },
    patchSettings: async (values, revision) => {
      calls.push(['patch', values, revision]);
      if (revision !== undefined && revision !== daemon.revision) throw Object.assign(new Error('revision_conflict'), { status: 409 });
      if (values.publicBaseUrl === 'bad') throw new Error('invalid_input');
      Object.assign(daemon, { revision: daemon.revision + 1, values: { ...daemon.values, ...values } });
      return structuredClone(daemon);
    },
    onHealth: (fn) => { healthWatchers.push(fn); return { dispose() {} }; },
  };
  const healthWatchers = [];
  const health = (h) => healthWatchers.forEach((fn) => fn(h));
  const module = { exports: {} };
  vm.runInNewContext(js, { module, exports: module.exports, setInterval: () => 0, clearInterval() {}, require: (n) => (n === 'vscode' ? vscode : require(n)) });
  const sync = new module.exports.SettingsSync(api, { appendLine() {} });
  return { sync, conf, calls, warnings, fire, daemon, health, mod: module.exports };
}
const flush = () => new Promise((r) => setTimeout(r, 20));
const defaults = { connectorName: '', publicBaseUrl: '', cloudflaredPath: '', skillsDir: '', channelMode: 'cloudflare', semanticMode: 'explicit' };

test('unmigrated daemon receives the current VS Code values once', async () => {
  const t = setup({ revision: 0, migrated: false, values: { ...defaults }, pending_restart: [] });
  t.conf.set('connectorName', '@Me');
  t.conf.set('publicBaseUrl', 'https://x.example.com/');
  await t.sync.sync();
  const mig = t.calls.find((c) => c[0] === 'migrate');
  assert.equal(mig[1].connectorName, 'Me');
  assert.equal(mig[1].publicBaseUrl, 'https://x.example.com');
  await t.sync.sync();
  assert.equal(t.calls.filter((c) => c[0] === 'migrate').length, 1);
  assert.equal(t.calls.filter((c) => c[0] === 'patch').length, 0, 'normalized equal values never ping-pong');
});

test('daemon values are mirrored into VS Code without echoing back', async () => {
  const t = setup({ revision: 3, migrated: true, values: { ...defaults, skillsDir: '/web', channelMode: 'custom' }, pending_restart: [] });
  await t.sync.sync();
  await flush();
  assert.equal(t.conf.get('skillsDir'), '/web');
  assert.equal(t.conf.get('channelMode'), 'custom');
  assert.equal(t.calls.filter((c) => c[0] === 'patch').length, 0);
});

test('a VS Code edit is pushed; a rejected edit is reverted with a warning', async () => {
  const t = setup({ revision: 1, migrated: true, values: { ...defaults }, pending_restart: [] });
  await t.sync.sync();
  t.conf.set('connectorName', 'Team');
  t.fire('connectorName');
  await flush();
  assert.equal(JSON.stringify(t.calls.find((c) => c[0] === 'patch')[1]), JSON.stringify({ connectorName: 'Team' }), 'only the changed key');
  assert.equal(t.daemon.values.connectorName, 'Team');

  t.conf.set('publicBaseUrl', 'bad');
  t.fire('publicBaseUrl');
  await flush();
  assert.equal(t.warnings.length, 1);
  assert.equal(t.conf.get('publicBaseUrl'), '', 'reverted to the daemon value');
});

test('unrelated settings are ignored', async () => {
  const t = setup({ revision: 1, migrated: true, values: { ...defaults }, pending_restart: [] });
  await t.sync.sync();
  t.fire('pollIntervalMs');
  await flush();
  assert.equal(t.calls.filter((c) => c[0] === 'patch').length, 0);
});

test('a push is bound to its base revision; a conflict resends only the keys edited here', async () => {
  const t = setup({ revision: 1, migrated: true, values: { ...defaults, openaiTunnelId: '' }, pending_restart: [] });
  await t.sync.sync();
  // Web settings saved a Tunnel ID after this window's last pull.
  Object.assign(t.daemon, { revision: 2, values: { ...t.daemon.values, openaiTunnelId: 'tunnel_web' } });
  t.conf.set('connectorName', 'Team');
  t.fire('connectorName');
  await t.sync.flush();
  const patches = t.calls.filter((c) => c[0] === 'patch');
  assert.equal(patches.length, 2);
  assert.equal(patches[0][2], 1, 'first attempt carries the base revision');
  assert.equal(JSON.stringify(patches[1][1]), JSON.stringify({ connectorName: 'Team' }), 'retry sends only the edited key');
  assert.equal(patches[1][2], 2, 'retry is bound to the fresh revision');
  assert.equal(t.daemon.values.openaiTunnelId, 'tunnel_web', 'the Web value is not overwritten');
  assert.equal(t.daemon.values.connectorName, 'Team');
  assert.equal(t.conf.get('openaiTunnelId'), 'tunnel_web', 'and it is mirrored into VS Code');
  assert.equal(t.warnings.length, 0);
  assert.equal(t.sync.baseline().openaiTunnelId, 'tunnel_web');
});

test('a health answer with a new settings revision pulls at once; the same revision does not', async () => {
  const t = setup({ revision: 3, migrated: true, values: { ...defaults }, pending_restart: [] });
  await t.sync.sync();
  const gets = () => t.calls.filter((c) => c[0] === 'get').length;
  const before = gets();
  t.health({ ok: true, settings_revision: 3 });
  t.health({ ok: true }); // an older daemon reports no revision
  await flush();
  assert.equal(gets(), before);
  Object.assign(t.daemon, { revision: 4, values: { ...t.daemon.values, skillsDir: '/web' } });
  t.health({ ok: true, settings_revision: 4 });
  await t.sync.flush();
  assert.equal(gets(), before + 1);
  assert.equal(t.conf.get('skillsDir'), '/web');
  assert.equal(t.calls.filter((c) => c[0] === 'patch').length, 0, 'mirroring never echoes back');
});

test('flush waits for an in-flight push', async () => {
  const t = setup({ revision: 1, migrated: true, values: { ...defaults }, pending_restart: [] });
  assert.equal(t.sync.baseline(), null, 'no baseline before first contact');
  await t.sync.sync();
  t.conf.set('skillsDir', '/vs');
  t.fire('skillsDir');
  await t.sync.flush();
  assert.equal(t.daemon.values.skillsDir, '/vs');
  assert.equal(t.sync.baseline().skillsDir, '/vs');
});

const newKeys = { gitUsrBinPath: '', namedTunnelName: 'blackhole', tunnelProbeProxy: '', webAgents: ['ChatGPT', 'WorkBuddy', 'Manus', 'Trae CN', 'Trae AI', 'Arena'], customWebAgents: [] };

test('older daemon (six keys) never receives the new keys', async () => {
  const t = setup({ revision: 0, migrated: false, values: { ...defaults }, pending_restart: [] });
  t.conf.set('namedTunnelName', 'mine');
  t.conf.set('webAgents', ['Arena']);
  await t.sync.sync();
  assert.deepEqual(Object.keys(t.calls.find((c) => c[0] === 'migrate')[1]).sort(), Object.keys(defaults).sort());
  t.conf.set('gitUsrBinPath', 'C:/git/usr/bin');
  t.fire('gitUsrBinPath');
  await flush();
  assert.equal(t.calls.filter((c) => c[0] === 'patch').length, 0);
});

test('newer daemon: unseeded keys are handed over once, never overwritten by daemon defaults', async () => {
  const t = setup({ revision: 4, migrated: true, values: { ...defaults, skillsDir: '/db', ...newKeys }, unseeded: Object.keys(newKeys), pending_restart: [] });
  t.conf.set('skillsDir', '/local');
  t.conf.set('namedTunnelName', 'mine');
  t.conf.set('webAgents', [' Arena ', 'Arena', 'Manus']);
  t.conf.set('customWebAgents', [{ name: 'X', url: 'https://x.example.com' }]);
  await t.sync.sync();
  await flush();
  const mig = t.calls.filter((c) => c[0] === 'migrate');
  assert.equal(mig.length, 1);
  assert.deepEqual(Object.keys(mig[0][1]).sort(), Object.keys(newKeys).sort(), 'only unseeded keys');
  assert.equal(JSON.stringify(t.daemon.values.webAgents), JSON.stringify(['Arena', 'Manus']));
  assert.equal(t.daemon.values.namedTunnelName, 'mine');
  assert.equal(t.conf.get('skillsDir'), '/db', 'seeded key: daemon wins');
  await t.sync.sync();
  assert.equal(t.calls.filter((c) => c[0] === 'migrate').length, 1);
  assert.equal(t.calls.filter((c) => c[0] === 'patch').length, 0, 'arrays compare by value, no ping-pong');

  t.conf.set('customWebAgents', []);
  t.fire('customWebAgents');
  await flush();
  assert.equal(JSON.stringify(t.calls.find((c) => c[0] === 'patch')[1]), JSON.stringify({ customWebAgents: [] }));
});
