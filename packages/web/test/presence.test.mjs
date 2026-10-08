import test from 'node:test';
import assert from 'node:assert/strict';
import { PRESENCE_LOCK, PRESENCE_PATH, startPresence } from '../src/presence.ts';

const tick = () => new Promise((r) => setImmediate(r));

/** A response whose body stays open until the request is aborted or end() is called. */
function openResponse(signal) {
  let end;
  const body = new ReadableStream({
    start(ctrl) {
      ctrl.enqueue(new TextEncoder().encode(': present\n\n'));
      end = () => { try { ctrl.close(); } catch { /* closed */ } };
      signal.addEventListener('abort', () => { try { ctrl.error(new DOMException('aborted', 'AbortError')); } catch { /* closed */ } });
    },
  });
  return { res: new Response(body, { status: 200 }), end: () => end() };
}

test('holds one presence stream with the web header and stops cleanly', async () => {
  const calls = [];
  const stop = startPresence({
    fetch: async (url, init) => { calls.push({ url, init }); return openResponse(init.signal).res; },
    sleep: async () => undefined,
    now: () => 0,
  });
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, PRESENCE_PATH);
  assert.equal(calls[0].init.headers['x-blackhole-web'], '1');
  assert.equal(calls[0].init.credentials, 'same-origin');
  stop();
  await tick();
  assert.ok(calls[0].init.signal.aborted);
  assert.equal(calls.length, 1, 'no reconnect after stop');
  stop();
});

test('reconnects with 1s -> 30s backoff, reset after a stream that stayed up', async () => {
  let now = 0;
  const delays = [];
  let healthyAt = -1;
  let stop;
  stop = startPresence({
    fetch: async (_url, init) => {
      if (delays.length === healthyAt) { // this attempt stays up for 2 minutes, then the daemon restarts
        const r = openResponse(init.signal);
        setImmediate(() => { now += 120_000; r.end(); });
        return r.res;
      }
      throw new TypeError('failed to fetch');
    },
    sleep: async (ms) => { delays.push(ms); if (delays.length === 7) healthyAt = 7; if (delays.length >= 9) stop(); },
    now: () => now,
  });
  for (let i = 0; i < 50 && delays.length < 9; i++) await tick();
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000, 1000, 2000]);
});

test('a 401 (signed out) backs off instead of hammering', async () => {
  const delays = [];
  let stop;
  stop = startPresence({
    fetch: async () => new Response('{"error":"session_required"}', { status: 401 }),
    sleep: async (ms) => { delays.push(ms); if (delays.length >= 3) stop(); },
    now: () => 0,
  });
  for (let i = 0; i < 20 && delays.length < 3; i++) await tick();
  assert.deepEqual(delays, [1000, 2000, 4000]);
});

test('Web Locks: only the lock holder opens the stream; stop drops a queued request', async () => {
  const requests = [];
  const locks = { request: (name, options, fn) => { requests.push({ name, options, fn }); return new Promise(() => {}); } };
  let fetched = 0;
  const env = { fetch: async (_u, init) => { fetched++; return openResponse(init.signal).res; }, locks, sleep: async () => undefined, now: () => 0 };
  const stopA = startPresence(env);
  const stopB = startPresence(env);
  await tick();
  assert.equal(requests.length, 2);
  assert.ok(requests.every((r) => r.name === PRESENCE_LOCK));
  assert.equal(fetched, 0, 'nothing until a lock is granted');
  const held = requests[0].fn(); // tab A is granted
  await tick();
  assert.equal(fetched, 1);
  stopB();
  assert.ok(requests[1].options.signal.aborted, 'queued tab B withdraws');
  stopA();
  await held; // the lock callback settles, releasing the lock
  assert.equal(fetched, 1);
});
