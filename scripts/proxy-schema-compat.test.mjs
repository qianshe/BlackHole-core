import test from 'node:test';
import assert from 'node:assert/strict';
import { validateServerEntry } from '../dist/proxy/config.js';

const base = { name: 'schema-fixture', transport: 'stdio', command: 'node' };
test('omitted and empty environment blocks retain the minimal inherited allowlist', () => {
  for (const raw of [base, {...base, env: {}}]) {
    const result = validateServerEntry(raw, new Set());
    assert.equal(result.error, undefined);
    assert.deepEqual(result.server.env, {
      inherit: ['PATH', 'TEMP', 'TMP', 'SYSTEMROOT', 'HOME', 'USERPROFILE'],
      set: {},
    });
    assert.equal(result.server.enabled, true);
    assert.equal(result.server.scope, 'shared');
    assert.equal(result.server.prewarm, 'never');
  }
});
test('an explicit empty inherit list replaces defaults and keeps named string values', () => {
  const result = validateServerEntry({...base, env: {inherit: [], set: {FIXTURE: 'value'}}}, new Set());
  assert.equal(result.error, undefined);
  assert.deepEqual(result.server.env, {inherit: [], set: {FIXTURE: 'value'}});
});
test('invalid environment values and undeclared fields remain rejected', () => {
  for (const raw of [{...base, env: {set: {FIXTURE: 42}}}, {...base, arbitraryField: true}]) {
    const result = validateServerEntry(raw, new Set());
    assert.equal(result.server, undefined);
    assert.equal(typeof result.error, 'string');
  }
});
