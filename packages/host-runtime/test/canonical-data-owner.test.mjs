import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { assertNoLegacyDataOwner } from '../dist/core-lifecycle.cjs';

const db = path.resolve('isolated-canonical-profile/.blackhole/blackhole.db');
const reply = database => async (port, route) => {
  assert.equal(port, 7306);
  assert.equal(route, '/api/health');
  return { status: 200, body: JSON.stringify({ version: '0.3.200', db_path: database }) };
};

test('v200 on 7306 owning the same database blocks a Test Core on another port', async () => {
  await assert.rejects(assertNoLegacyDataOwner(db, 17306, reply(db)), /data_root_in_use/);
});

test('Windows path casing cannot evade the existing database owner', { skip: process.platform !== 'win32' }, async () => {
  await assert.rejects(assertNoLegacyDataOwner(db, 17306, reply(db.toUpperCase())), /data_root_in_use/);
});

test('a disposable profile with a different database does not adopt the real user profile', async () => {
  await assertNoLegacyDataOwner(db, 18342, reply(path.resolve('other-profile/.blackhole/blackhole.db')));
});

test('only positive connection refusal proves that the legacy endpoint is absent', async () => {
  await assertNoLegacyDataOwner(db, 17306, async () => { throw Object.assign(new Error('closed'), { code: 'ECONNREFUSED' }); });
  for (const code of ['ETIMEDOUT', 'ECONNRESET', 'EACCES']) {
    await assert.rejects(assertNoLegacyDataOwner(db, 17306, async () => { throw Object.assign(new Error('unknown'), { code }); }), /data_owner_state_unknown/);
  }
});

test('malformed or foreign responses never grant permission to open the database', async () => {
  for (const result of [
    { status: 200, body: '{' },
    { status: 302, body: '{}' },
    { status: 200, body: JSON.stringify({ db_path: '../relative.db' }) },
    { status: 200, body: '{}' },
  ]) await assert.rejects(assertNoLegacyDataOwner(db, 17306, async () => result), /data_owner_state_unknown/);
});

test('the target port itself remains subject to normal Manager startup validation', async () => {
  await assertNoLegacyDataOwner(db, 7306, async () => { assert.fail('do not duplicate the target-port probe'); });
});
