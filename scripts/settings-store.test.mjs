// Daemon-owned settings: validation, revisions, first-copy migration and the startup overlay.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { MachineStateRepo } from '../dist/storage/machineState.js';
import { applySettingsToConfig, normalizeSettingsPatch, pendingRestartKeys, unseededKeys, SettingsStore, DEFAULT_SETTINGS, DEFAULT_WEB_AGENTS, V1_SETTING_KEYS, SETTINGS_KEY } from '../dist/settings/store.js';
import { readFileSync } from 'node:fs';
import { migrateSettings, patchSettings, putCourierSite, removeCourierSite } from '../dist/settings/service.js';

const repo = () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE machine_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  return new MachineStateRepo(db);
};
const deps = (store) => ({ settings: store, startedSettings: { ...DEFAULT_SETTINGS }, events: { append() {} } });

test('validation: allowed values, normalization and rejects', () => {
  assert.deepEqual(normalizeSettingsPatch({ connectorName: ' @@Me ', publicBaseUrl: 'https://x.example.com/' }).values, { connectorName: 'Me', publicBaseUrl: 'https://x.example.com' });
  for (const bad of [
    { unknown: 'x' },
    { publicBaseUrl: 'ftp://x' },
    { publicBaseUrl: 'https://u:p@x.example.com' },
    { publicBaseUrl: 'https://x.example.com/path' },
    { publicBaseUrl: 'https://x.example.com/?a=1' },
    { channelMode: 'tailscale' },
    { openaiTunnelId: 'https://api.openai.com/v1/tunnels/x' },
    { openaiTunnelId: 'tun 1' },
    { openaiTunnelId: 'tun_abc-123' },
    { openaiTunnelId: 'tunnel_0123456789ABCDEF0123456789ABCDEF' },
    { semanticMode: 'always' },
    { skillsDir: 'a\u0000b' },
    { connectorName: 5 },
  ]) assert.ok('error' in normalizeSettingsPatch(bad), JSON.stringify(bad));
  assert.deepEqual(normalizeSettingsPatch({ publicBaseUrl: '' }).values, { publicBaseUrl: '' });
  assert.deepEqual(normalizeSettingsPatch({ channelMode: 'openai', openaiTunnelId: ' tunnel_0123456789abcdef0123456789abcdef ', openaiTunnelClientPath: ' C:\\x\\tunnel-client-runtime.exe ' }).values,
    { channelMode: 'openai', openaiTunnelId: 'tunnel_0123456789abcdef0123456789abcdef', openaiTunnelClientPath: 'C:\\x\\tunnel-client-runtime.exe' });
});

test('store: revisions, conflicts and no-op saves', () => {
  const s = new SettingsStore(repo());
  assert.equal(s.get().migrated, false);
  const a = s.update({ connectorName: 'A' }, 0);
  assert.equal(a.record.revision, 1);
  assert.deepEqual(a.changed, ['connectorName']);
  assert.ok('conflict' in s.update({ connectorName: 'B' }, 0), 'stale revision');
  const same = s.update({ connectorName: 'A' }, 1);
  assert.equal(same.record.revision, 1, 'no-op keeps revision');
  assert.equal(s.get().values.connectorName, 'A');
});

test('migration is a one-time first copy and skips invalid old values', () => {
  const s = new SettingsStore(repo());
  const r = migrateSettings(deps(s), { values: { connectorName: 'Old', publicBaseUrl: 'https://x.example.com/with/path', semanticMode: 'auto' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.values.connectorName, 'Old');
  assert.equal(r.body.values.publicBaseUrl, '', 'invalid value skipped, default kept');
  assert.equal(r.body.values.semanticMode, 'auto');
  const again = migrateSettings(deps(s), { values: { connectorName: 'Other' } });
  assert.equal(again.body.values.connectorName, 'Old', 'never overwrites daemon-owned values');
});

test('patch service: revision required for Web, 409 carries current values, pending restart keys', () => {
  const s = new SettingsStore(repo());
  const d = deps(s);
  assert.equal(patchSettings(d, { values: { connectorName: 'x' } }, 'local_web', true).status, 400);
  assert.equal(patchSettings(d, { values: {}, revision: 0, extra: 1 }, 'local_web', true).status, 400);
  const ok = patchSettings(d, { values: { skillsDir: '/s', connectorName: 'n' }, revision: 0 }, 'local_web', true);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.pending_restart, ['skillsDir'], 'connectorName applies live');
  const conflict = patchSettings(d, { values: { connectorName: 'y' }, revision: 0 }, 'local_web', true);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.current.revision, 1);
  assert.deepEqual(pendingRestartKeys(DEFAULT_SETTINGS, DEFAULT_SETTINGS), []);
});

test('startup overlay: daemon values win, explicit overrides win, tunnel is never switched on', () => {
  const base = () => ({ publicBaseUrl: 'https://env.example.com', cloudflaredBin: '/bundled/cloudflared', skillsDir: '/env', semantic: 'explicit', tunnel: 'off' });
  const unmigrated = { revision: 0, migrated: false, seeded: [], values: { ...DEFAULT_SETTINGS, skillsDir: '/db' } };
  const cfg0 = base();
  applySettingsToConfig(cfg0, unmigrated);
  assert.deepEqual(cfg0, base(), 'unmigrated store leaves the environment alone');

  const rec = { revision: 1, migrated: true, seeded: [...V1_SETTING_KEYS], values: { ...DEFAULT_SETTINGS, publicBaseUrl: '', skillsDir: '/db', semanticMode: 'auto', channelMode: 'cloudflare' } };
  const cfg = base();
  applySettingsToConfig(cfg, rec);
  assert.equal(cfg.publicBaseUrl, undefined);
  assert.equal(cfg.cloudflaredBin, '/bundled/cloudflared', 'empty path keeps the launcher binary');
  assert.equal(cfg.skillsDir, '/db');
  assert.equal(cfg.semantic, 'auto');
  assert.equal(cfg.tunnel, 'off', 'cloudflare mode does not switch an off tunnel on');

  const custom = base();
  custom.tunnel = 'auto';
  applySettingsToConfig(custom, { ...rec, values: { ...rec.values, channelMode: 'custom' } });
  assert.equal(custom.tunnel, 'auto', 'tabs never gate a channel: custom no longer switches Cloudflare off');
  const openai = base();
  openai.tunnel = 'auto';
  applySettingsToConfig(openai, { ...rec, values: { ...rec.values, channelMode: 'openai' } });
  assert.equal(openai.tunnel, 'auto', 'the OpenAI tab does not stop Cloudflare from running');

  const explicit = base();
  applySettingsToConfig(explicit, rec, new Set(['skillsDir', 'semantic']));
  assert.equal(explicit.skillsDir, '/env');
  assert.equal(explicit.semantic, 'explicit');
});

test('new keys: arrays validated, defaults match the extension', () => {
  const pkg = JSON.parse(readFileSync(new URL('../packages/vscode/package.json', import.meta.url), 'utf8'));
  assert.deepEqual(DEFAULT_WEB_AGENTS, pkg.contributes.configuration.properties?.['blackhole.webAgents']?.default
    ?? pkg.contributes.configuration.flatMap?.((c) => Object.entries(c.properties)).find(([k]) => k === 'blackhole.webAgents')[1].default);
  assert.ok('values' in normalizeSettingsPatch({ webAgents: ['ChatGPT'], customWebAgents: [{ name: 'X', url: 'https://x.example.com' }] }));
  for (const bad of [{ webAgents: 'ChatGPT' }, { webAgents: [1] }, { customWebAgents: [{ name: '' , url: 'https://x' }] },
    { customWebAgents: [{ name: 'x'.repeat(65), url: 'https://x' }] }, { webAgents: Array.from({ length: 51 }, (_, i) => 'a' + i) }]) {
    assert.ok('error' in normalizeSettingsPatch(bad), JSON.stringify(bad).slice(0, 80));
  }
});

test('seeding: legacy record seeds v1 keys only; migrate fills unseeded keys once', () => {
  const r = repo();
  r.set(SETTINGS_KEY, JSON.stringify({ revision: 3, migrated: true, values: { ...DEFAULT_SETTINGS, skillsDir: '/db' } }));
  const s = new SettingsStore(r);
  assert.deepEqual(s.get().seeded, [...V1_SETTING_KEYS]);
  assert.deepEqual(unseededKeys(s.get()), ['gitUsrBinPath', 'namedTunnelName', 'tunnelProbeProxy', 'webAgents', 'customWebAgents', 'openaiTunnelClientPath', 'openaiTunnelId']);
  const res = migrateSettings(deps(s), { values: { skillsDir: '/ext', namedTunnelName: 'mine', webAgents: ['Arena'], tunnelProbeProxy: 'not a url ::' } });
  assert.equal(res.status, 200);
  const rec = s.get();
  assert.equal(rec.values.skillsDir, '/db', 'seeded key is not overwritten');
  assert.equal(rec.values.namedTunnelName, 'mine');
  assert.deepEqual(rec.values.webAgents, ['Arena']);
  assert.ok(!rec.seeded.includes('tunnelProbeProxy'), 'invalid value stays unseeded');
  migrateSettings(deps(s), { values: { namedTunnelName: 'other' } });
  assert.equal(s.get().values.namedTunnelName, 'mine', 'second hand-over is ignored');

  const cfg = { tunnelName: 'env', tunnelProbeProxy: 'http://env:1' }, env = { BLACKHOLE_GIT_USR_BIN: 'C:/env' };
  applySettingsToConfig(cfg, s.get(), new Set(), env);
  assert.equal(cfg.tunnelName, 'mine');
  assert.equal(cfg.tunnelProbeProxy, 'http://env:1', 'unseeded key keeps the launcher value');
  assert.equal(env.BLACKHOLE_GIT_USR_BIN, 'C:/env');
});

test('courierSites: daemon-owned, validated like Courier profiles, one per origin, at most 20', () => {
  const site = (o = {}) => ({ id: 'c-kimi-com', name: 'Kimi', origin: 'https://kimi.com', newChatPath: '/', dom: { editor: 'div.editor', send: 'div.send', stop: null }, key: { prefix: '/chat/' }, detectedAt: 5, v: 1, ...o });
  assert.deepEqual(DEFAULT_SETTINGS.courierSites, []);
  const ok = normalizeSettingsPatch({ courierSites: [site()] });
  assert.ok('values' in ok);
  assert.deepEqual(ok.values.courierSites[0].dom, { editor: 'div.editor', send: 'div.send', stop: null, model: null });
  for (const bad of [site({ origin: 'http://kimi.com' }), site({ origin: 'https://chatgpt.com' }), site({ id: 'kimi' }), site({ dom: { editor: '', send: 'x' } }),
    site({ newChatPath: 'chat' }), site({ key: { prefix: '/chat' } }), site({ origin: 'https://kimi.com/path' }), site({ name: '' })]) {
    assert.ok('error' in normalizeSettingsPatch({ courierSites: [bad] }), JSON.stringify(bad).slice(0, 90));
  }
  assert.ok('error' in normalizeSettingsPatch({ courierSites: [site(), site({ id: 'c-other' })] }), 'same origin twice');
  assert.ok('error' in normalizeSettingsPatch({ courierSites: Array.from({ length: 21 }, (_, i) => site({ id: `c-s${i}`, origin: `https://s${i}.example.com` })) }));
  const s = new SettingsStore(repo());
  s.update({ connectorName: 'x' });
  assert.ok(!unseededKeys(s.get()).includes('courierSites'), 'the VS Code extension never hands courierSites over');
});

test('courierSites from Courier: put keeps one entry per origin, remove deletes, every change is pushed back', () => {
  const s = new SettingsStore(repo());
  let pushed = 0;
  const d = { ...deps(s), courier: { pushSites: () => { pushed++; } } };
  const site = (o = {}) => ({ id: 'c-kimi-com', name: 'Kimi', origin: 'https://kimi.com', newChatPath: '/', dom: { editor: 'div.editor', send: 'div.send', stop: null }, key: null, detectedAt: 1, v: 1, ...o });
  assert.deepEqual(putCourierSite(d, site()), { ok: true });
  assert.equal(pushed, 1);
  assert.deepEqual(putCourierSite(d, site({ id: 'c-kimi-2', dom: { editor: 'div.editor', send: 'div.send', stop: 'div.stop' }, detectedAt: 2 })), { ok: true });
  assert.deepEqual(s.get().values.courierSites.map((x) => [x.id, x.dom.stop]), [['c-kimi-com', 'div.stop']], 'same origin: updated in place, id kept');
  assert.equal(putCourierSite(d, site({ origin: 'http://kimi.com' })).ok, false);
  assert.deepEqual(removeCourierSite(d, 'c-kimi-com'), { ok: true });
  assert.deepEqual(s.get().values.courierSites, []);
  assert.equal(pushed, 3);
  assert.deepEqual(removeCourierSite(d, 'c-gone'), { ok: true }, 'removing an unknown site is a no-op');
  assert.equal(pushed, 3);
  // The Web settings delete path: a plain PATCH also reaches Courier.
  putCourierSite(d, site());
  const r = patchSettings(d, { values: { courierSites: [] }, revision: s.get().revision }, 'web', true);
  assert.equal(r.status, 200);
  assert.equal(pushed, 5);
});
