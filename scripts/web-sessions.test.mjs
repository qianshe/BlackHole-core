// Local Web sessions: persisted across restarts, sliding expiry, tied to the machine's cloud account.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebSessionStore, WEB_SESSION_TTL_MS } from '../dist/web/web-sessions.js';

const memState = () => { const m = new Map(); return { get: (k) => m.get(k), set: (k, v) => m.set(k, v), raw: m }; };
const DAY = 24 * 60 * 60_000;

test('sessions and the CSRF key survive a restart; only hashes are stored', () => {
  const st = memState();
  const a = new WebSessionStore(st);
  const { secret } = a.issue('u1');
  assert.ok(!st.raw.get('web.sessions.v1').includes(secret), 'raw cookie never persisted');
  const b = new WebSessionStore(st);
  assert.equal(b.check(secret, 'u1').ok, true);
  assert.deepEqual(b.csrfKey, a.csrfKey);
  assert.equal(WEB_SESSION_TTL_MS, 30 * DAY);
});

test('sliding expiry: used sessions stay, idle ones lapse after 30 days', () => {
  const s = new WebSessionStore(memState());
  const t0 = 1_000_000_000_000;
  const { secret } = s.issue('u1', t0);
  assert.equal(s.check(secret, 'u1', t0 + 20 * DAY).ok, true);
  assert.equal(s.check(secret, 'u1', t0 + 45 * DAY).ok, true, 'renewed by the day-20 visit');
  assert.deepEqual(s.check(secret, 'u1', t0 + 80 * DAY), { ok: false, error: 'unauthenticated' });
});

test('lapsed login pauses; same account resumes; another account ends every session', () => {
  const s = new WebSessionStore(memState());
  const one = s.issue('u1').secret, two = s.issue('u1').secret;
  assert.deepEqual(s.check(one, null), { ok: false, error: 'account_required' });
  assert.equal(s.check(one, 'u1').ok, true, 'same account restores without a new login');
  assert.equal(s.check(one, 'u2').ok, false);
  assert.equal(s.check(two, 'u1').ok, false, 'switch revoked the others too');
  assert.equal(s.size, 0);
});

test('a session issued before any account adopts the first account', () => {
  const s = new WebSessionStore(memState());
  const { secret } = s.issue(null);
  assert.equal(s.check(secret, null).ok, true);
  assert.equal(s.check(secret, 'u1').ok, true);
  assert.equal(s.check(secret, null).ok, false, 'now bound to u1');
});

test('revoke, revokeAll, malformed input and corrupt storage', () => {
  const st = memState();
  const s = new WebSessionStore(st);
  const a = s.issue('u1').secret, b = s.issue('u1').secret;
  s.revoke(a);
  assert.equal(s.check(a, 'u1').ok, false);
  assert.equal(s.check(b, 'u1').ok, true);
  s.revokeAll();
  assert.equal(new WebSessionStore(st).check(b, 'u1').ok, false, 'revokeAll persisted');
  for (const bad of [undefined, 1, '', 'x'.repeat(43) + '!', 'a'.repeat(44)]) assert.equal(s.check(bad, 'u1').ok, false);
  st.set('web.sessions.v1', '{not json');
  st.set('web.csrf_key.v1', 'short');
  const c = new WebSessionStore(st);
  assert.equal(c.size, 0);
  assert.equal(c.csrfKey.length, 32);
});

test('at most 32 sessions; the oldest goes first', () => {
  const s = new WebSessionStore(memState());
  const first = s.issue('u1').secret;
  for (let i = 0; i < 32; i++) s.issue('u1');
  assert.equal(s.size, 32);
  assert.equal(s.check(first, 'u1').ok, false);
});
