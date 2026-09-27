// Web console data flow (plan 6.15 W1): approvals on this computer and the
// session header controls. Isolated daemon; confirmations are seeded through
// the fixture's IPC so no agent or cloud is involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createIsolatedEnv } from './fixtures/isolated-env.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (process.argv.includes('--fixture-daemon')) {
  const { startDaemon } = await import('../dist/daemon.js');
  const daemon = await startDaemon({ port: Number(process.env.BLACKHOLE_PORT), dbPath: process.env.BLACKHOLE_DB, tunnel: 'off' }, () => {});
  process.on('message', (m) => {
    if (m === 'stop') { void daemon.stop().then(() => process.exit(0), () => process.exit(1)); return; }
    if (m?.seed) {
      const c = daemon.deps.confirmations.create(m.seed, 'exec', JSON.stringify({ command: 'Remove-Item -Recurse -Force .\\dist' }), 'h' + Math.random());
      daemon.deps.events.append(m.seed, 'confirmation_created', { confirmation_id: c.id, command: 'Remove-Item -Recurse -Force .\\dist', categories: ['delete'], matches: [{ label: '文件删除', level: 'critical', tone: 'red', range: [0, 11] }] });
      process.send({ seeded: c.id });
    }
  });
  process.send({ ready: true });
} else {
  test('web console: approvals and session controls', { timeout: 60_000 }, async (t) => {
    const iso = await createIsolatedEnv({ name: 'web-console' });
    const child = fork(fileURLToPath(import.meta.url), ['--fixture-daemon'], { env: { ...iso.env, BLACKHOLE_WEB_DIR: path.join(ROOT, 'packages/web/dist') }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const exited = new Promise((r) => child.once('exit', r));
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-console-'));
    t.after(async () => {
      if (child.connected) child.send('stop');
      await Promise.race([exited, new Promise((r) => setTimeout(() => { child.kill(); r(); }, 4000))]);
      iso.cleanup();
      fs.rmSync(work, { recursive: true, force: true });
    });
    const nextMessage = () => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('fixture timeout')), 15_000);
      child.once('message', (m) => { clearTimeout(timer); resolve(m); });
    });
    await nextMessage();
    const seed = async (sessionId) => { child.send({ seed: sessionId }); return (await nextMessage()).seeded; };

    const local = `127.0.0.1:${iso.port}`;
    const req = (p, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body);
      const r = http.request({ host: '127.0.0.1', port: iso.port, path: p, method, headers: { host: local, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(text); } catch { /* not json */ }
          resolve({ status: res.statusCode, text, json, headers: res.headers });
        });
      });
      r.on('error', reject);
      if (data) r.write(data);
      r.end();
    });

    const cred = { token: 'bhp_' + 'a'.repeat(43), userId: 'user_1', clientId: 'c'.repeat(22), sessionId: '11111111-2222-4333-8444-555555555555', expiresAt: Math.floor(Date.now() / 1000) + 3600, loginOrder: 7 };
    assert.equal((await req('/api/account/migrate', { method: 'POST', body: { credential: cred } })).status, 200);
    const origin = `http://${local}`;
    const login = await req('/web-api/v1/auth/local', { method: 'POST', body: {}, headers: { origin, 'x-blackhole-web': '1' } });
    assert.equal(login.status, 200);
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    const csrf = login.json.csrf;
    const web = (p, method = 'GET', body, { noCsrf = false } = {}) => req('/web-api/v1' + p, { method, body, headers: { cookie, 'x-blackhole-web': '1', ...(method === 'GET' ? {} : { origin, ...(noCsrf ? {} : { 'x-blackhole-csrf': csrf }) }) } });

    const created = await web('/sessions', 'POST', { workspace_path: work });
    assert.equal(created.status, 201, created.text);
    const sid = created.json.session.id;

    // Approvals: listed with risk tags, never with the approval pin.
    const c1 = await seed(sid);
    const list = await web(`/confirmations?session_id=${encodeURIComponent(sid)}`);
    assert.equal(list.status, 200);
    const row = list.json.confirmations.find((c) => c.id === c1);
    assert.ok(row, 'seeded confirmation listed');
    assert.equal(row.status, 'pending');
    assert.equal(row.tool, 'exec');
    assert.deepEqual(row.risk_matches, [{ label: '文件删除', level: 'critical', tone: 'red', range: [0, 11] }]);
    assert.equal(row.command, 'Remove-Item -Recurse -Force .\\dist');
    assert.deepEqual(row.categories, ['delete']);
    assert.ok(!('approval_pin' in row) && !list.text.includes('approval_pin'), 'approval pin stays on the control API');
    assert.equal((await req('/web-api/v1/confirmations', { headers: { 'x-blackhole-web': '1' } })).status, 401, 'needs the web session');

    assert.equal((await web(`/confirmations/${c1}/approve`, 'POST', { scope: 'once' }, { noCsrf: true })).status, 403, 'CSRF required');
    assert.equal((await web(`/confirmations/${c1}/approve`, 'POST', { scope: 'forever' })).status, 400);
    const ok = await web(`/confirmations/${c1}/approve`, 'POST', { scope: 'session' });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.status, 'approved');
    assert.equal((await web(`/confirmations/${c1}/approve`, 'POST', { scope: 'once' })).status, 409, 'closed once resolved');
    const c2 = await seed(sid);
    const denied = await web(`/confirmations/${c2}/deny`, 'POST', {});
    assert.equal(denied.status, 200);
    assert.equal(denied.json.status, 'denied');
    assert.equal((await web('/confirmations/missing/deny', 'POST', {})).status, 404);

    // Session controls go through the panel allowlist to the control API.
    const detail = await web(`/panel/sessions/${sid}`);
    assert.equal(detail.status, 200, detail.text);
    assert.ok(detail.json.session_id, 'credential for the copied prompt');
    const status = async () => (await web('/sessions')).json.sessions.find((x) => x.id === sid).status;
    assert.equal((await web(`/panel/sessions/${sid}/pause`, 'POST', {})).status, 200);
    assert.equal(await status(), 'paused');
    assert.equal((await web(`/panel/sessions/${sid}/resume`, 'POST', {})).status, 200);
    assert.equal(await status(), 'active');
    const before = detail.json.session_id;
    assert.equal((await web(`/panel/sessions/${sid}/rotate`, 'POST', {})).status, 200);
    assert.notEqual((await web(`/panel/sessions/${sid}`)).json.session_id, before, 'rotate issues a new id');
    assert.equal((await web(`/panel/sessions/${sid}/pause`, 'POST', {}, { noCsrf: true })).status, 403);
    assert.equal((await web(`/panel/sessions/${sid}/mode`, 'PATCH', { mode: 'danger-full-access' })).status, 404, 'only listed actions pass');
    assert.equal((await web(`/panel/sessions/${sid}/revoke`, 'POST', {})).status, 200);
    assert.equal(await status(), 'revoked');
  });
}
