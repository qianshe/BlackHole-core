import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteProbeRegistry, probePhoneSurface } from '../dist/web/remote-probe.js';
import { PhoneVerificationSchema } from '../packages/contracts/dist/connections.js';
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const ok = () => new Response('{"error":"unpaired"}', { status: 401, headers: { 'content-type': 'application/json' } });

test('probe verifies the phone surface without credentials or following redirects', async () => {
  const result = await probePhoneSurface('https://phone.example.test', '', async (url, init) => {
    assert.equal(url, 'https://phone.example.test/remote-api/v1/session');
    assert.deepEqual(init.headers, { 'x-blackhole-web': '1' });
    assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
    assert.ok(init.signal instanceof AbortSignal);
    return ok();
  });
  assert.deepEqual(result, { state: 'passed', reason: null });
});

test('a web homepage, wrong service, malformed or oversized JSON is never a phone success', async () => {
  for (const response of [
    new Response('homepage'),
    new Response('{"ok":true}', { status: 401, headers: { 'content-type': 'application/json' } }),
    new Response('{', { status: 401, headers: { 'content-type': 'application/json' } }),
    new Response('x'.repeat(4097), { status: 401, headers: { 'content-type': 'application/json' } }),
    new Response('', { status: 302, headers: { location: 'https://other.example.test' } }),
  ]) assert.deepEqual(await probePhoneSurface('https://phone.test', '', async () => response), { state: 'failed', reason: 'unexpected_response' });
});

test('timeout, TLS and network errors stay classified and do not expose error contents', async () => {
  for (const [error, reason] of [
    [Object.assign(new Error('secret URL'), { name: 'TimeoutError' }), 'timeout'],
    [Object.assign(new Error('secret URL'), { cause: { code: 'CERT_HAS_EXPIRED' } }), 'tls'],
    [Object.assign(new Error('secret URL'), { cause: { code: 'ECONNREFUSED' } }), 'unreachable'],
  ]) assert.deepEqual(await probePhoneSurface('https://phone.test', '', async () => { throw error; }), { state: 'failed', reason });
});

test('reading endpoint state never probes; same entry deduplicates and other entries are independent', async () => {
  const gate = deferred(); let calls = 0;
  const entries = [{ origin: 'https://a.test', key: 'a1', proxy: '' }, { origin: 'https://b.test', key: 'b1', proxy: '' }];
  const registry = new RemoteProbeRegistry(() => entries, async (origin) => { calls++; return origin.endsWith('a.test') ? gate.promise : { state: 'failed', reason: 'tls' }; });
  assert.equal(registry.view('https://a.test').state, 'unverified'); assert.equal(calls, 0);
  assert.equal(await registry.probe('https://not-configured.test'), null); assert.equal(calls, 0);
  const a = registry.probe('https://a.test'); assert.equal(a, registry.probe('https://a.test'));
  assert.equal(registry.view('https://a.test').state, 'checking');
  await registry.probe('https://b.test'); assert.equal(registry.view('https://b.test').reason, 'tls');
  gate.resolve({ state: 'passed', reason: null }); await a;
  assert.equal(calls, 2);
  assert.equal(registry.view('https://a.test').state, 'passed');
  assert.equal(registry.view('https://b.test').state, 'failed');
  PhoneVerificationSchema.parse(registry.view('https://a.test'));
});

test('configuration changes discard in-flight results and cached successes expire', async () => {
  let entries = [{ origin: 'https://a.test', key: 'revision1', proxy: '' }], now = 1000;
  const gate = deferred();
  const registry = new RemoteProbeRegistry(() => entries, () => gate.promise, () => now, 100);
  const pending = registry.probe('https://a.test');
  entries = [{ ...entries[0], key: 'revision2' }];
  gate.resolve({ state: 'passed', reason: null });
  assert.equal(await pending, null); assert.equal(registry.view('https://a.test').state, 'unverified');
  await registry.probe('https://a.test'); assert.equal(registry.view('https://a.test').state, 'passed');
  now += 100; assert.equal(registry.view('https://a.test').state, 'unverified');
  await registry.probe('https://a.test'); now -= 1;
  assert.equal(registry.view('https://a.test').state, 'unverified', 'clock rollback does not keep green status');
  entries = []; assert.equal(await registry.probe('https://a.test'), null);
});
