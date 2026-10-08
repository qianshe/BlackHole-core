import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteAccess } from '../dist/web/remote-access.js';

const repo = () => {
  const map = new Map();
  return { get: (k) => map.get(k), set: (k, v) => map.set(k, v) };
};

function pair(remote, channel, name = 'Phone', user = 'user_1', now = 1_000) {
  const { code } = remote.issueCode(channel, now);
  const req = remote.requestPair(code, channel, name, user, now + 1);
  assert.ok(req);
  assert.equal(remote.decide(req.id, true, now + 2), true);
  const claim = remote.claim(req.token, channel, now + 3);
  assert.equal(claim.state, 'approved');
  return claim;
}

test('fixed-origin devices survive switching preferred fixed entry and remain origin-bound', () => {
  const remote = new RemoteAccess(repo());
  const a = { origin: 'https://a.example.test', kind: 'fixed' };
  const b = { origin: 'https://b.example.test', kind: 'fixed' };
  const paired = pair(remote, a);
  remote.prune(b, 2_000);
  assert.equal(remote.list().length, 1, 'switching fixed entry must not revoke another fixed device');
  assert.equal(remote.check(paired.secret, b, 2_001), null, 'credential never works on a different origin');
  assert.ok(remote.check(paired.secret, a, 2_002), 'credential works again on its bound origin');
});

test('quick-origin devices are revoked when the ephemeral quick origin changes', () => {
  const remote = new RemoteAccess(repo());
  const a = { origin: 'https://a.trycloudflare.com', kind: 'quick' };
  const b = { origin: 'https://b.trycloudflare.com', kind: 'quick' };
  pair(remote, a);
  remote.prune(b, 2_000);
  assert.equal(remote.list().length, 0);
});
