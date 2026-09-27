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
    patchSettings: async (values) => {
      calls.push(['patch', values]);
      if (values.publicBaseUrl === 'bad') throw new Error('invalid_input');
      Object.assign(daemon, { revision: daemon.revision + 1, values: { ...daemon.values, ...values } });
      return structuredClone(daemon);
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(js, { module, exports: module.exports, setInterval: () => 0, clearInterval() {}, require: (n) => (n === 'vscode' ? vscode : require(n)) });
  const sync = new module.exports.SettingsSync(api, { appendLine() {} });
  return { sync, conf, calls, warnings, fire, daemon, mod: module.exports };
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
