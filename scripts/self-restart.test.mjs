// Daemon self-restart (plan 6.12 S3b): same port, new process, settings applied, channel intent kept.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createIsolatedEnv } from './fixtures/isolated-env.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('daemon restarts itself on the same port', { timeout: 60_000 }, async (t) => {
  const iso = await createIsolatedEnv({ name: 'self-restart' });
  const base = `http://127.0.0.1:${iso.port}`;
  const health = async () => { try { const r = await fetch(base + '/api/health'); return r.ok ? await r.json() : null; } catch { return null; } };
  const first = spawn(process.execPath, [path.join(ROOT, 'dist/cli.js'), 'serve', '--port', String(iso.port), '--tunnel', 'off'], { env: iso.env, stdio: 'ignore', detached: true });
  first.unref();
  let pids = [first.pid];
  t.after(async () => {
    const h = await health();
    if (h) await fetch(base + '/api/shutdown', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ daemon_id: h.daemon_id, start_fingerprint: h.start_fingerprint ?? null }) }).catch(() => {});
    await sleep(500);
    for (const pid of pids) { try { process.kill(pid); } catch {} }
    iso.cleanup();
  });
  let h0 = null;
  for (let i = 0; i < 100 && !h0; i++) { h0 = await health(); if (!h0) await sleep(150); }
  assert.ok(h0, 'daemon came up');

  const post = (route, body) => fetch(base + '/api' + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post('/restart', {})).status, 400, 'explicit confirm required');
  const r = await post('/restart', { confirm: true });
  assert.equal(r.status, 200);

  let h1 = null;
  for (let i = 0; i < 150; i++) {
    const h = await health();
    if (h && h.daemon_id !== h0.daemon_id) { h1 = h; break; }
    await sleep(150);
  }
  assert.ok(h1, 'a new daemon answers on the same port');
  assert.equal(h1.version, h0.version);
  assert.equal(h1.start_fingerprint ?? null, h0.start_fingerprint ?? null, 'same start fingerprint: VS Code keeps treating it as its daemon');
  pids.push(Number(h1.daemon_id.split('-').at(-1)));
  assert.notEqual(pids.at(-1), first.pid);
  await sleep(300);
  assert.throws(() => process.kill(first.pid, 0), 'the old process exited');
});
