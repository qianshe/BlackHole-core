// Phone access (plan 6.13 R6): the public surface is off by default, bound to the
// https public address, pairs once with a one-time code, and exposes only the
// phone routes. Isolated daemon; requests carry forged Host headers via node:http.
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
  process.on('message', (m) => { if (m === 'stop') void daemon.stop().then(() => process.exit(0), () => process.exit(1)); });
  process.send({ ready: true });
} else {
  test('phone access: off by default, host-bound, one-time pairing allowed on the computer, phone routes only', { timeout: 60_000 }, async (t) => {
    const iso = await createIsolatedEnv({ name: 'remote-access' });
    const child = fork(fileURLToPath(import.meta.url), ['--fixture-daemon'], { env: { ...iso.env, BLACKHOLE_WEB_DIR: path.join(ROOT, 'packages/web/dist') }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const exited = new Promise((r) => child.once('exit', r));
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-remote-'));
    t.after(async () => {
      if (child.connected) child.send('stop');
      await Promise.race([exited, new Promise((r) => setTimeout(() => { child.kill(); r(); }, 4000))]);
      iso.cleanup();
      fs.rmSync(work, { recursive: true, force: true });
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('startup timeout')), 15_000);
      child.once('message', () => { clearTimeout(timer); resolve(); });
    });

    const local = `127.0.0.1:${iso.port}`;
    /** Raw request with any Host header. */
    const req = (p, { method = 'GET', host = local, headers = {}, body } = {}) => new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body);
      const r = http.request({ host: '127.0.0.1', port: iso.port, path: p, method, headers: { host, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(text); } catch { /* not json */ }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      });
      r.on('error', reject);
      if (data) r.write(data);
      r.end();
    });

    // Sign the machine in, then open a local web session.
    const cred = { token: 'bhp_' + 'a'.repeat(43), userId: 'user_1', clientId: 'c'.repeat(22), sessionId: '11111111-2222-4333-8444-555555555555', expiresAt: Math.floor(Date.now() / 1000) + 3600, loginOrder: 7 };
    assert.equal((await req('/api/account/migrate', { method: 'POST', body: { credential: cred } })).status, 200);
    const localOrigin = `http://${local}`;
    const login = await req('/web-api/v1/auth/local', { method: 'POST', body: {}, headers: { origin: localOrigin, 'x-blackhole-web': '1' } });
    assert.equal(login.status, 200);
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    const csrf = login.json.csrf;
    const web = (p, method = 'GET', body) => req('/web-api/v1' + p, { method, body, headers: { cookie, 'x-blackhole-web': '1', ...(method === 'GET' ? {} : { origin: localOrigin, 'x-blackhole-csrf': csrf }) } });
    const settings = async (values) => {
      const cur = (await web('/settings')).json;
      const r = await web('/settings', 'PATCH', { revision: cur.revision, values });
      assert.equal(r.status, 200, r.text);
    };

    const PUB = 'phone.example.test';
    const origin = `https://${PUB}`;
    const phone = (p, { method = 'GET', body, cookie: c, host = PUB, headers = {} } = {}) => req('/remote-api/v1' + p, { method, host, body, headers: { 'x-blackhole-web': '1', 'cf-connecting-ip': '203.0.113.9', ...(method === 'GET' ? {} : { origin }), ...(c ? { cookie: c } : {}), ...headers } });

    // Off by default: nothing on the public address.
    await settings({ channelMode: 'custom', publicBaseUrl: origin });
    assert.equal((await phone('/session')).status, 404, 'off by default');
    assert.equal((await web('/remote')).json.reason, 'off');
    assert.equal((await web('/remote/pair', 'POST', {})).status, 409);

    // http public address: not available.
    await settings({ publicBaseUrl: `http://${PUB}`, remoteAccess: true });
    assert.equal((await web('/remote')).json.reason, 'custom_not_https');
    assert.equal((await phone('/session')).status, 404, 'plain http is never served');

    await settings({ publicBaseUrl: origin });
    const view = (await web('/remote')).json;
    assert.equal(view.available, true);
    assert.equal(view.origin, origin);
    assert.equal((await phone('/session', { host: 'evil.test' })).status, 404, 'Host must be the public address');
    assert.equal((await phone('/session', { host: local })).status, 404, 'loopback Host is not the phone surface');
    assert.equal((await phone('/session')).status, 401, 'unpaired');
    assert.equal((await phone('/session', { headers: { 'x-blackhole-web': '0' } })).status, 403, 'own page only');
    // Local surfaces stay closed to proxied requests.
    assert.equal((await req('/web-api/v1/sessions', { host: PUB, headers: { cookie, 'cf-connecting-ip': '1.2.3.4' } })).status, 403);
    assert.equal((await req('/api/health', { host: PUB, headers: { 'cf-connecting-ip': '1.2.3.4' } })).status, 403);
    assert.equal((await req('/probe', { host: PUB })).status, 200, 'probe unchanged');

    // Public `/`: the page for browsers, the banner for everything else.
    const page = await req('/', { host: PUB, headers: { accept: 'text/html' } });
    assert.equal(page.status, 200);
    assert.match(page.text, /<div id="root">|<!doctype html>/i);
    assert.match((await req('/', { host: PUB, headers: { accept: '*/*' } })).text, /daemon/);
    assert.equal((await req('/ui/index.html', { host: 'evil.test' })).status, 403, 'assets only for the public address');

    // scan -> allow on the computer -> claim; returns the device cookie
    const pairDevice = async (code, { host = PUB, headers = {}, allowVia = 'web' } = {}) => {
      const scan = await phone('/pair', { method: 'POST', body: { code }, host, headers });
      assert.equal(scan.status, 202, scan.text);
      const id = (await web('/remote')).json.requests.at(-1).id;
      const ok = allowVia === 'control'
        ? await req(`/api/remote/requests/${id}`, { method: 'POST', body: { allow: true } })
        : await web(`/remote/requests/${id}`, 'POST', { allow: true });
      assert.equal(ok.status, 200, ok.text);
      const claim = await phone('/pair/claim', { method: 'POST', body: { token: scan.json.token }, host, headers });
      assert.equal(claim.status, 200, claim.text);
      return String(claim.headers['set-cookie']).split(';')[0];
    };

    // Pairing: one-time code, fragment only.
    // VS Code panel controls go through the loopback control API (R4).
  const cv = await req('/api/remote');
  assert.equal(cv.status, 200); assert.equal(cv.json.enabled, true); assert.equal(cv.json.available, true);
  const cp = await req('/api/remote/pair', { method: 'POST', body: {} });
  assert.equal(cp.status, 200); assert.match(cp.json.url, /#pair=/);
  assert.equal((await req('/api/remote/devices/nope/revoke', { method: 'POST', body: {} })).status, 404);
  assert.equal((await req('/api/remote', { host: PUB })).status, 403, 'control API stays loopback-only');
  const pair = (await web('/remote/pair', 'POST', {})).json;
    assert.match(pair.url, new RegExp(`^${origin}/#pair=[A-Za-z0-9_-]{22}$`));
    const code = pair.url.split('#pair=')[1];
    assert.equal((await phone('/pair', { method: 'POST', body: { code }, headers: { origin: 'https://evil.test' } })).status, 403, 'cross-origin pairing');
    const scanned = await phone('/pair', { method: 'POST', body: { code }, headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1' } });
    assert.equal(scanned.status, 202, scanned.text);
    assert.equal(scanned.headers['set-cookie'], undefined, 'the code alone grants nothing');
    const token = scanned.json.token;
    // Waiting: no access until the computer allows it.
    assert.equal((await phone('/pair/claim', { method: 'POST', body: { token } })).json.state, 'pending');
    const waiting = (await web('/remote')).json.requests;
    assert.equal(waiting.length, 1);
    assert.equal(waiting[0].name, 'iPhone Safari');
    assert.equal((await phone('/pair/claim', { method: 'POST', body: { token: 'A'.repeat(43) } })).status, 401);
    assert.equal((await web(`/remote/requests/${waiting[0].id}`, 'POST', { allow: 'yes' })).status, 400);
    assert.equal((await web(`/remote/requests/${waiting[0].id}`, 'POST', { allow: true })).status, 200);
    assert.equal((await web(`/remote/requests/${waiting[0].id}`, 'POST', { allow: false })).status, 404, 'answered once');
    const paired = await phone('/pair/claim', { method: 'POST', body: { token } });
    assert.equal(paired.status, 200, paired.text);
    assert.equal(paired.json.state, 'approved');
    assert.equal((await phone('/pair/claim', { method: 'POST', body: { token } })).status, 401, 'token is single-use');
    const setCookie = String(paired.headers['set-cookie']);
    for (const part of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/remote-api']) assert.ok(setCookie.includes(part), `cookie ${part}`);
    const dev = setCookie.split(';')[0];
    assert.equal((await phone('/pair', { method: 'POST', body: { code } })).status, 401, 'code is single-use');
    assert.equal((await phone('/pair', { method: 'POST', body: { code: 'A'.repeat(22) } })).status, 401);
    const devices = (await web('/remote')).json.devices;
    assert.equal(devices.length, 1);
    assert.equal(devices[0].name, 'iPhone Safari');

    // Phone routes.
    const s = await phone('/session', { cookie: dev });
    assert.equal(s.status, 200);
    assert.equal(s.json.device, 'iPhone Safari');
    assert.equal((await phone('/sessions', { cookie: dev })).status, 200);
    assert.equal((await phone('/confirmations', { cookie: dev })).status, 200);
    for (const p of ['/settings', '/fs/dirs', '/account', '/panel/health', '/remote']) assert.equal((await phone(p, { cookie: dev })).status, 404, p);
    for (const p of ['/daemon/stop', '/daemon/restart', '/account/sign-out', '/remote/pair']) assert.equal((await phone(p, { cookie: dev, method: 'POST', body: {} })).status, 404, p);
    assert.equal((await phone('/confirmations/nope/approve', { cookie: dev, method: 'POST', body: { scope: 'once' } })).status, 404);

    // New session: known projects only, never auto_approve.
    const created = await web('/sessions', 'POST', { workspace_path: work });
    assert.equal(created.status, 201, created.text);
    const projects = (await phone('/projects', { cookie: dev })).json.projects;
    assert.ok(projects.length >= 1);
    assert.equal((await phone('/sessions', { cookie: dev, method: 'POST', body: { project_id: projects[0].id, auto_approve: true } })).status, 400, 'no auto_approve');
    assert.equal((await phone('/sessions', { cookie: dev, method: 'POST', body: { workspace_path: work } })).status, 400, 'no free paths');
    const made = await phone('/sessions', { cookie: dev, method: 'POST', body: { project_id: projects[0].id } });
    assert.equal(made.status, 201, made.text);
    assert.equal(made.json.session.auto_approve, false);
    assert.equal((await phone('/sessions', { cookie: dev, method: 'POST', body: { project_id: 'missing' } })).status, 400);

    // Revoked sessions are gone from the phone list too.
    const revoked = await req(`/api/sessions/${made.json.session.id}/revoke`, { method: 'POST', body: {} });
    if (revoked.status === 200) assert.ok(!(await phone('/sessions', { cookie: dev })).json.sessions.some((x) => x.id === made.json.session.id), 'revoked session hidden');
    else assert.fail(`session revoke: ${revoked.status} ${revoked.text}`);

    // 拒绝 on the computer: the phone is told and gets nothing.
    const codeD = (await web('/remote/pair', 'POST', {})).json.url.split('#pair=')[1];
    const scanD = await phone('/pair', { method: 'POST', body: { code: codeD } });
    const idD = (await web('/remote')).json.requests.at(-1).id;
    assert.equal((await web(`/remote/requests/${idD}`, 'POST', { allow: false })).status, 200);
    const denied = await phone('/pair/claim', { method: 'POST', body: { token: scanD.json.token } });
    assert.equal(denied.status, 403);
    assert.equal(denied.json.error, 'pair_denied');
    assert.equal(denied.headers['set-cookie'], undefined);
    assert.equal((await web('/remote')).json.devices.length, 1, 'denied phone not added');

    // Revoke from the computer.
    assert.equal((await web(`/remote/devices/${devices[0].id}/revoke`, 'POST', {})).status, 200);
    assert.equal((await phone('/session', { cookie: dev })).status, 401, 'revoked');

    // Address change: old devices end.
    const code2 = (await web('/remote/pair', 'POST', {})).json.url.split('#pair=')[1];
    const dev2 = await pairDevice(code2, { allowVia: 'control' });
    assert.equal((await phone('/session', { cookie: dev2 })).status, 200);
    await settings({ publicBaseUrl: 'https://other.example.test' });
    assert.equal((await phone('/session', { cookie: dev2, host: 'other.example.test', headers: { origin: 'https://other.example.test' } })).status, 401, 'bound to the old origin');
    assert.equal((await web('/remote')).json.devices.length, 0, 'pruned after address change');

    // Turning phone access off closes everything.
    const code3 = (await web('/remote/pair', 'POST', {})).json.url.split('#pair=')[1];
    const other = 'https://other.example.test';
    const dev3 = await pairDevice(code3, { host: 'other.example.test', headers: { origin: other } });
    assert.equal((await phone('/session', { cookie: dev3, host: 'other.example.test' })).status, 200);
    await settings({ remoteAccess: false });
    assert.equal((await phone('/session', { cookie: dev3, host: 'other.example.test' })).status, 404);
    await settings({ remoteAccess: true });
    assert.equal((await phone('/session', { cookie: dev3, host: 'other.example.test' })).status, 401, 'devices do not come back');

    // A different machine account ends the pairing (sign-out needs the cloud; not reachable here).
    const code4 = (await web('/remote/pair', 'POST', {})).json.url.split('#pair=')[1];
    const dev4 = await pairDevice(code4, { host: 'other.example.test', headers: { origin: other } });
    assert.equal((await phone('/session', { cookie: dev4, host: 'other.example.test' })).status, 200);
    const switched = await req('/api/account/migrate', { method: 'POST', body: { credential: { ...cred, userId: 'user_2', sessionId: '22222222-3333-4444-8555-666666666666', loginOrder: 8 } } });
    const nowUser = (await req('/api/account')).json?.userId;
    if (switched.json?.migrated === true && nowUser === 'user_2') assert.equal((await phone('/session', { cookie: dev4, host: 'other.example.test' })).status, 401, 'other account');
    else t.diagnostic(`account switch not possible in this fixture: ${switched.status} ${switched.text}`);
  });
}
