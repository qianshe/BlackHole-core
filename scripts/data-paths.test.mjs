import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveDataPaths } from '../dist/data-paths.js';

const home = path.resolve('D:/isolated-user');

test('default paths preserve the legacy ~/.blackhole layout', () => {
  const actual = resolveDataPaths({ env: {}, homeDir: home, platform: 'win32' });
  const root = path.resolve(home, '.blackhole');
  assert.equal(actual.root, root);
  assert.equal(actual.db, path.join(root, 'blackhole.db'));
  assert.equal(actual.semanticKey, path.join(root, 'semantic-key'));
  assert.equal(actual.proxyConfig, path.join(root, 'mcp-proxies.yaml'));
  assert.match(actual.dataRootId, /^[a-f0-9]{64}$/);
});

test('a database-only override cannot split account and session storage', () => {
  const db = path.resolve('D:/legacy-db/custom.db');
  assert.throws(() => resolveDataPaths({ env: { BLACKHOLE_DB: db }, homeDir: home, platform: 'win32' }), /noncanonical_storage_path:BLACKHOLE_DB/);
});

test('an alternative BLACKHOLE_HOME is rejected, not used as another profile', () => {
  const root = path.resolve('D:/private/blackhole-data');
  assert.throws(() => resolveDataPaths({ env: { BLACKHOLE_HOME: root }, homeDir: home, platform: 'win32' }), /noncanonical_storage_path:BLACKHOLE_HOME/);
});

test('data-root identity is stable across Windows profile path casing', () => {
  const upper = resolveDataPaths({ env: {}, homeDir: home.toUpperCase(), platform: 'win32' });
  const lower = resolveDataPaths({ env: {}, homeDir: home.toLowerCase(), platform: 'win32' });
  assert.equal(upper.dataRootId, lower.dataRootId);
});

test('a user profile inside Core versions or staging is rejected', () => {
  const core = path.resolve('D:/local/BlackHole/Core');
  for (const isolatedHome of [path.join(core, 'versions', '0.4.0'), path.join(core, 'staging', 'tx-1')]) {
    assert.throws(() => resolveDataPaths({ env: {}, homeDir: isolatedHome, platform: 'win32', coreStoreRoot: core }), /data_root_inside_core_store/);
  }
});
