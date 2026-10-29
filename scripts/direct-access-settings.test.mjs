import test from 'node:test';
import assert from 'node:assert/strict';
import { SettingsStore, DEFAULT_SETTINGS, SETTING_KEYS, DAEMON_ONLY_KEYS, normalizeSettingsPatch } from '../dist/settings/store.js';
import { patchSettings } from '../dist/settings/service.js';
import { directAccessConfig } from '../dist/direct-access/listener.js';

function fixture() {
  const rows = new Map();
  const store = new SettingsStore({ get: (key) => rows.get(key) ?? null, set: (key, value) => rows.set(key, value) });
  const calls = [];
  const deps = { settings: store, startedSettings: { ...DEFAULT_SETTINGS }, cfg: { port: 7306 }, events: { append() {} }, directAccess: { apply(config) { calls.push(config); return Promise.resolve(); } } };
  return { store, calls, deps, patch: (values) => patchSettings(deps, { values }, 'test', false) };
}

test('only the three canonical direct settings exist; unpublished aliases are rejected', () => {
  assert.equal(DEFAULT_SETTINGS.directAccessEnabled, false);
  assert.equal(DEFAULT_SETTINGS.directPort, 7307);
  assert.equal(DEFAULT_SETTINGS.directAccessUrl, '');
  for (const key of ['directAccessEnabled', 'directPort', 'directAccessUrl']) {
    assert.ok(SETTING_KEYS.includes(key), key);
    assert.ok(DAEMON_ONLY_KEYS.includes(key), key);
  }
  for (const key of ['lanAccess', 'lanPort', 'lanUrl', 'publicDirectEnabled', 'directGatewayUrl']) {
    assert.ok(!SETTING_KEYS.includes(key), key);
    assert.ok('error' in normalizeSettingsPatch({ [key]: true }), key);
  }
});

test('URL validation permits optional HTTP(S) bare origins without confusing listening and advertising', () => {
  for (const url of ['', 'http://192.168.1.20:7307', 'http://203.0.113.20:49152', 'https://bh.example.test', 'https://[2001:db8::1]']) {
    const r = normalizeSettingsPatch({ directAccessUrl: url });
    assert.ok('values' in r, JSON.stringify(r));
  }
  for (const url of ['ftp://host', 'https://host/path', 'https://u:p@host', 'https://host/?token=x', 'https://host/#x']) {
    assert.ok('error' in normalizeSettingsPatch({ directAccessUrl: url }), url);
  }
  for (const port of [0, 80, 65536, 7307.5, '7307']) assert.ok('error' in normalizeSettingsPatch({ directPort: port }));
});

test('saving an address stays off; enabling needs no URL; turning off has no hidden alias', () => {
  const f = fixture();
  assert.equal(f.patch({ directAccessUrl: 'https://bh.example.test/' }).status, 200);
  assert.equal(f.store.get().values.directAccessEnabled, false);
  assert.equal(f.calls.at(-1).enabled, false);
  assert.equal(f.patch({ directAccessUrl: '', directAccessEnabled: true }).status, 200);
  assert.equal(f.calls.at(-1).enabled, true);
  assert.equal(f.calls.at(-1).advertisedUrl, '');
  assert.equal(f.patch({ directAccessEnabled: false }).status, 200);
  assert.equal(f.calls.at(-1).enabled, false);
});

test('direct and reverse-proxy mode share a stable configured port', () => {
  const f = fixture();
  assert.equal(f.patch({ directPort: 18081, directAccessEnabled: true }).status, 200);
  assert.equal(f.patch({ channelMode: 'custom', publicBaseUrl: 'https://proxy.example.test', directAccessEnabled: false }).status, 200);
  assert.equal(f.calls.at(-1).port, 18081);
  assert.equal(f.calls.at(-1).proxyOrigin, 'https://proxy.example.test');
  assert.equal(f.patch({ directAccessEnabled: true }).status, 200);
  assert.equal(f.calls.at(-1).port, 18081);
  const count = f.calls.length;
  assert.equal(f.patch({ connectorName: 'Unrelated' }).status, 200);
  assert.equal(f.calls.length, count, 'unrelated settings do not disrupt the listener');
  const config = directAccessConfig(f.store.get().values);
  assert.deepEqual(config, f.calls.at(-1));
});
