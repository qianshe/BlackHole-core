// Real isolated-daemon phone regression: HTTP/HTTPS, origin-bound credentials,
// single-use pairing with explicit computer approval, and phone-only permissions.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createIsolatedEnv, freeLoopbackPort } from './fixtures/isolated-env.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (process.argv.includes('--fixture-daemon')) {
  const { startDaemon } = await import('../dist/daemon.js');
  const daemon = await startDaemon({ port: Number(process.env.BLACKHOLE_PORT), dbPath: process.env.BLACKHOLE_DB, tunnel: 'off' }, () => {});
  process.on('message', (m) => { if (m === 'stop') void daemon.stop().then(() => process.exit(0), () => process.exit(1)); });
  process.send({ ready: true });
} else {
  test('phone access: one listener, origin-bound single-use pairing, computer approval and phone-only routes', { timeout: 60_000 }, async (t) => {
    const iso = await createIsolatedEnv({ name: 'remote-access' });
    const directPort = await freeLoopbackPort();
    const child = fork(fileURLToPath(import.meta.url), ['--fixture-daemon'], { env: { ...iso.env, BLACKHOLE_WEB_DIR: path.join(ROOT, 'packages/web/dist') }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const exited = new Promise((r) => child.once('exit', r));
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-remote-'));
    t.after(async () => {
      if (child.connected) child.send('stop');
      let timer;
      await Promise.race([exited, new Promise((r) => { timer = setTimeout(() => { child.kill(); r(); }, 4000); })]);
      clearTimeout(timer);
      iso.cleanup();
      fs.rmSync(work, { recursive: true, force: true });
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('startup timeout')), 15_000);
      child.once('exit', (code) => { clearTimeout(timer); reject(Error(`daemon exited before ready: ${code}`)); });
      child.once('message', () => { clearTimeout(timer); resolve(); });
    });

    const local = `127.0.0.1:${iso.port}`;
    const req = (p, { method = 'GET', host = local, headers = {}, body, port = iso.port } = {}) => new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body);
      const r = http.request({ host: '127.0.0.1', port, path: p, method, agent: false, headers: { host, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(text); } catch { /* not json */ }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      });
      r.setTimeout(5000, () => r.destroy(new Error('HTTP fixture timeout')));
      r.on('error', reject);
      if (data) r.write(data);
      r.end();
    });

    // Sign in only the isolated machine, then open its local Web session.
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
      // PATCH acknowledges persistence; await the actual listener transition.
      for (let i = 0; i < 100; i++) {
        const listener = (await req('/api/health')).json.direct_access;
        if (listener.state !== 'applying' && listener.enabled === r.json.values.directAccessEnabled && listener.port === r.json.values.directPort) {
          assert.notEqual(listener.state, 'error', JSON.stringify(listener)); return;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.fail('listener did not settle after settings PATCH');
    };

    const PUB = 'phone.example.test';
    const origin = `https://${PUB}`;
    const phone = (p, { method = 'GET', body, cookie: c, host = PUB, headers = {}, port = directPort } = {}) => req('/remote-api/v1' + p, { method, host, body, port, headers: { 'x-blackhole-web': '1', 'cf-connecting-ip': '203.0.113.9', ...(method === 'GET' ? {} : { origin }), ...(c ? { cookie: c } : {}), ...headers } });

    // One independent data-plane port, never the user's live service port.
    await settings({ channelMode: 'cloudflare', publicBaseUrl: '', directAccessEnabled: true, directAccessUrl: origin, directPort });
    let directView = (await web('/remote')).json;
    assert.equal(directView.available, true);
    assert.equal(directView.origin, origin);
    assert.equal(directView.kind, 'fixed');
    const listener = (await req('/api/health')).json.direct_access;
    assert.equal(listener.state, 'listening');
    assert.equal(listener.bind_host, '0.0.0.0');
    assert.equal(listener.port, directPort);
    assert.equal(listener.target, `http://127.0.0.1:${directPort}`);
    const interfaceOrigins = listener.addresses.map((address) => `http://${address}:${directPort}`);
    assert.deepEqual(directView.endpoints.map((x) => x.origin), [origin, ...interfaceOrigins]);
    for (const p of ['/api/health', '/web-api/v1/sessions', '/api/courier']) assert.equal((await req(p, { port: directPort })).status, 404, p);
    assert.equal((await phone('/session')).status, 401, 'direct phone access still requires pairing');
    assert.equal((await phone('/session', { host: local })).status, 404, 'local management origin is not a phone origin');
    assert.equal((await req('/api/health', { host: PUB })).status, 403);

    // An optional advertised URL is not the direct-access on/off switch.
    await settings({ directAccessUrl: '' });
    directView = (await web('/remote')).json;
    assert.equal(directView.available, interfaceOrigins.length > 0);
    assert.deepEqual(directView.endpoints.map((x) => x.origin), interfaceOrigins);
    for (const entry of interfaceOrigins) assert.equal((await phone('/session', { host: new URL(entry).host })).status, 401);

    // Reverse proxy mode keeps the exact same port, bound only to loopback.
    await settings({ directAccessEnabled: false, channelMode: 'custom', publicBaseUrl: origin });
    assert.equal((await req('/api/health')).json.direct_access.port, directPort);
    assert.equal((await req('/api/health')).json.direct_access.mode, 'proxy');
    await settings({ channelMode: 'custom', publicBaseUrl: origin });
    assert.equal((await phone('/session')).status, 401, 'pairing is required');
    assert.equal((await web('/remote')).json.available, true);
    await settings({ remoteAccess: false });
    assert.equal((await web('/remote')).json.available, true, 'stored false does not hide the pairing UI');

    await settings({ publicBaseUrl: `http://${PUB}` });
    assert.equal((await web('/remote')).json.origin, `http://${PUB}`);
    assert.equal((await phone('/session')).status, 401, 'HTTP still requires pairing');
    await settings({ publicBaseUrl: origin });
    const view = (await web('/remote')).json;
    assert.equal(view.available, true); assert.equal(view.origin, origin);
    assert.equal((await phone('/session', { host: 'evil.test' })).status, 421, 'proxy listener rejects undeclared Host before phone routing');
    assert.equal((await phone('/session', { host: local })).status, 421, 'proxy-only mode does not accept an arbitrary loopback Host');
    assert.equal((await phone('/session')).status, 401, 'unpaired');
    assert.equal((await phone('/session', { headers: { 'x-blackhole-web': '0' } })).status, 403, 'own page only');
    assert.equal((await req('/web-api/v1/sessions', { host: PUB, headers: { cookie, 'cf-connecting-ip': '1.2.3.4' } })).status, 403);
    assert.equal((await req('/api/health', { host: PUB, headers: { 'cf-connecting-ip': '1.2.3.4' } })).status, 403);
    assert.equal((await req('/probe', { host: PUB })).status, 200);

    const page = await req('/', { host: PUB, headers: { accept: 'text/html' }, port: directPort });
    assert.equal(page.status, 200);
    assert.match(page.text, /<div id="root">|<!doctype html>/i);
    assert.match((await req('/', { host: PUB, headers: { accept: '*/*' } })).text, /daemon/);
    assert.equal((await req('/ui/index.html', { host: 'evil.test' })).status, 403, 'main listener assets reject an unknown public origin');

    const pairDevice = async (code, { host = PUB, headers = {}, allowVia = 'web', port = directPort, expectSecure = true } = {}) => {
      const scan = await phone('/pair', { method: 'POST', body: { code }, host, headers, port });
      assert.equal(scan.status, 202, scan.text);
      const id = (await web('/remote')).json.requests.at(-1).id;
      const ok = allowVia === 'control'
        ? await req(`/api/remote/requests/${id}`, { method: 'POST', body: { allow: true } })
        : await web(`/remote/requests/${id}`, 'POST', { allow: true });
      assert.equal(ok.status, 200, ok.text);
      const claim = await phone('/pair/claim', { method: 'POST', body: { token: scan.json.token }, host, headers, port });
      assert.equal(claim.status, 200, claim.text);
      const rawCookie = String(claim.headers['set-cookie']);
      assert.ok(rawCookie.includes('HttpOnly'));
      assert.ok(rawCookie.includes('SameSite=Strict'));
      assert.ok(rawCookie.includes('Path=/remote-api'));
      assert.equal(/(?:^|;\s*)Secure(?:;|$)/i.test(rawCookie), expectSecure);
      return rawCookie.split(';')[0];
    };

    const cv = await req('/api/remote');
    assert.equal(cv.status, 200); assert.equal(cv.json.enabled, true); assert.equal(cv.json.available, true);
    const cp = await req('/api/remote/pair', { method: 'POST', body: {} });
    assert.equal(cp.status, 200); assert.match(cp.json.url, /#pair=/);
    assert.equal((await req('/api/remote/devices/nope/revoke', { method: 'POST', body: {} })).status, 404);
    assert.equal((await req('/api/remote', { host: PUB })).status, 403);
    const pair = (await web('/remote/pair', 'POST', {})).json;
    assert.equal(new URL(pair.url).origin, origin);
    assert.match(new URL(pair.url).hash, /^#pair=[A-Za-z0-9_-]{22}$/);
    const code = pair.url.split('#pair=')[1];
    assert.equal((await phone('/pair', { method: 'POST', body: { code }, headers: { origin: 'https://evil.test' } })).status, 403, 'cross-origin pairing');
    const scanned = await phone('/pair', { method: 'POST', body: { code }, headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1' } });
    assert.equal(scanned.status, 202, scanned.text);
    assert.equal(scanned.headers['set-cookie'], undefined, 'the QR code alone grants nothing');
    const token = scanned.json.token;
    assert.equal((await phone('/pair/claim', { method: 'POST', body: { token } })).json.state, 'pending');
    const waiting = (await web('/remote')).json.requests;
    assert.equal(waiting.length, 1); assert.equal(waiting[0].name, 'iPhone Safari');
    assert.equal((await phone('/pair/claim', { method: 'POST', body: { token: 'A'.repeat(43) } })).status, 401);
    assert.equal((await web(`/remote/requests/${waiting[0].id}`, 'POST', { allow: 'yes' })).status, 400);
    assert.equal((await web(`/remote/requests/${waiting[0].id}`, 'POST', { allow: true })).status, 200);
    assert.equal((await web(`/remote/requests/${waiting[0].id}`, 'POST', { allow: false })).status, 404, 'answered once');
    const paired = await phone('/pair/claim', { method: 'POST', body: { token } });
    assert.equal(paired.status, 200, paired.text); assert.equal(paired.json.state, 'approved');
    assert.equal((await phone('/pair/claim', { method: 'POST', body: { token } })).status, 401, 'single-use claim');
    const setCookie = String(paired.headers['set-cookie']);
    for (const part of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/remote-api']) assert.ok(setCookie.includes(part), part);
    const dev = setCookie.split(';')[0];

    let limited = null;
    for (let i = 0; i < 21; i++) limited = await phone('/pair', { method: 'POST', body: { code: 'B'.repeat(22) }, headers: { 'x-real-ip': '198.51.100.' + i } });
    assert.equal(limited.status, 429, 'spoofed forwarding identities do not bypass capability rate limiting');
    assert.equal((await phone('/pair', { method: 'POST', body: { code } })).status, 401, 'single-use QR');
    assert.equal((await phone('/pair', { method: 'POST', body: { code: 'A'.repeat(22) } })).status, 401);
    const devices = (await web('/remote')).json.devices;
    assert.equal(devices.length, 1); assert.equal(devices[0].name, 'iPhone Safari');

    // Existing custom ingress and the direct origin remain independently usable.
    const DIRECT = 'direct.example.test';
    const directOrigin = `https://${DIRECT}`;
    await settings({ directAccessEnabled: true, directAccessUrl: directOrigin, publicBaseUrl: origin });
    const directOnly = (await web('/remote')).json;
    assert.equal(directOnly.origin, directOrigin);
    assert.ok(directOnly.endpoints.some((x) => x.origin === origin));
    assert.equal((await phone('/session', { cookie: dev, host: PUB })).status, 200);
    const directPair = (await web('/remote/pair', 'POST', { origin: directOrigin })).json;
    assert.equal(new URL(directPair.url).origin, directOrigin);
    assert.match(new URL(directPair.url).hash, /^#pair=[A-Za-z0-9_-]{22}$/);
    const devDirect = await pairDevice(directPair.url.split('#pair=')[1], { host: DIRECT, headers: { origin: directOrigin }, allowVia: 'control' });
    assert.equal((await phone('/session', { cookie: devDirect, host: DIRECT })).status, 200);
    assert.equal((await phone('/session', { cookie: devDirect, host: PUB })).status, 401, 'device cannot migrate to another origin');
    const bothDevices = (await web('/remote')).json.devices;
    assert.equal(bothDevices.length, 2);
    const directDevice = bothDevices.find((x) => x.id !== devices[0].id);
    const httpDirectOrigin = `http://${DIRECT}:${directPort}`;
    await settings({ directAccessUrl: httpDirectOrigin });
    const httpListener = (await req('/api/health')).json.direct_access;
    assert.equal(httpListener.mode, 'direct'); assert.equal(httpListener.bind_host, '0.0.0.0'); assert.equal(httpListener.port, directPort);
    const httpView = (await web('/remote')).json;
    assert.equal(httpView.origin, httpDirectOrigin); assert.ok(httpView.endpoints.some((x) => x.origin === origin));
    const httpPair = (await web('/remote/pair', 'POST', { origin: httpDirectOrigin })).json;
    const devHttp = await pairDevice(httpPair.url.split('#pair=')[1], { host: `${DIRECT}:${directPort}`, headers: { origin: httpDirectOrigin }, allowVia: 'control', expectSecure: false });
    assert.equal((await phone('/session', { cookie: devHttp, host: `${DIRECT}:${directPort}` })).status, 200);
    assert.ok(directDevice);
    assert.equal((await web(`/remote/devices/${directDevice.id}/revoke`, 'POST', {})).status, 200);
    await settings({ directAccessEnabled: false, directAccessUrl: '' });
    assert.equal((await phone('/session', { cookie: dev, host: PUB })).status, 200, 'custom ingress continues on the same port');

    // Phone permissions, known-project session creation, and timeline access.
    const s = await phone('/session', { cookie: dev });
    assert.equal(s.status, 200); assert.equal(s.json.device, 'iPhone Safari');
    assert.equal((await phone('/sessions', { cookie: dev })).status, 200);
    assert.equal((await phone('/confirmations', { cookie: dev })).status, 200);
    for (const p of ['/settings', '/fs/dirs', '/account', '/panel/health', '/remote']) assert.equal((await phone(p, { cookie: dev })).status, 404, p);
    for (const p of ['/daemon/stop', '/daemon/restart', '/account/sign-out', '/remote/pair']) assert.equal((await phone(p, { cookie: dev, method: 'POST', body: {} })).status, 404, p);
    assert.equal((await phone('/confirmations/nope/approve', { cookie: dev, method: 'POST', body: { scope: 'once' } })).status, 404);
    const created = await web('/sessions', 'POST', { workspace_path: work });
    assert.equal(created.status, 201, created.text);
    const projects = (await phone('/projects', { cookie: dev })).json.projects;
    assert.ok(projects.length >= 1);
    assert.equal((await phone('/sessions', { cookie: dev, method: 'POST', body: { project_id: projects[0].id, auto_approve: true } })).status, 400, 'no auto_approve');
    assert.equal((await phone('/sessions', { cookie: dev, method: 'POST', body: { workspace_path: work } })).status, 400, 'no free paths');
    const made = await phone('/sessions', { cookie: dev, method: 'POST', body: { project_id: projects[0].id } });
    assert.equal(made.status, 201, made.text); assert.equal(made.json.session.auto_approve, false);
    assert.equal((await phone('/sessions', { cookie: dev, method: 'POST', body: { project_id: 'missing' } })).status, 400);
    const feedPath = `/sessions/${made.json.session.id}/feed`;
    assert.equal((await phone(feedPath)).status, 401, 'unpaired: no timeline');
    const phoneFeed = await phone(`${feedPath}?limit=20`, { cookie: dev });
    assert.equal(phoneFeed.status, 200, phoneFeed.text);
    assert.equal(phoneFeed.json.full, true); assert.equal(phoneFeed.json.retry_ms, 750);
    assert.equal(typeof phoneFeed.json.state.status, 'string');
    const phoneQuiet = await phone(`${feedPath}?offset=${phoneFeed.json.offset}&boot=${phoneFeed.json.boot}`, { cookie: dev });
    assert.deepEqual([phoneQuiet.json.full, phoneQuiet.json.calls, phoneQuiet.json.messages, phoneQuiet.json.retry_ms], [false, [], [], 0]);
    assert.equal((await phone(`/sessions/${made.json.session.id}/history?limit=10`, { cookie: dev })).status, 200);
    assert.equal((await phone('/sessions/nope/feed', { cookie: dev })).status, 404);
    const revoked = await req(`/api/sessions/${made.json.session.id}/revoke`, { method: 'POST', body: {} });
    assert.equal(revoked.status, 200, revoked.text);
    assert.ok(!(await phone('/sessions', { cookie: dev })).json.sessions.some((x) => x.id === made.json.session.id));

    // Denial never issues a device cookie or silently pairs the phone.
    const devicesBeforeDenied = (await web('/remote')).json.devices.length;
    const codeD = (await web('/remote/pair', 'POST', {})).json.url.split('#pair=')[1];
    const scanD = await phone('/pair', { method: 'POST', body: { code: codeD } });
    const idD = (await web('/remote')).json.requests.at(-1).id;
    assert.equal((await web(`/remote/requests/${idD}`, 'POST', { allow: false })).status, 200);
    const denied = await phone('/pair/claim', { method: 'POST', body: { token: scanD.json.token } });
    assert.equal(denied.status, 403); assert.equal(denied.json.error, 'pair_denied');
    assert.equal(denied.headers['set-cookie'], undefined);
    assert.equal((await web('/remote')).json.devices.length, devicesBeforeDenied);
    assert.equal((await web(`/remote/devices/${devices[0].id}/revoke`, 'POST', {})).status, 200);
    assert.equal((await phone('/session', { cookie: dev })).status, 401, 'revoked');

    // Changing an entry preserves device records but not cross-origin authority.
    const code2 = (await web('/remote/pair', 'POST', {})).json.url.split('#pair=')[1];
    const dev2 = await pairDevice(code2, { allowVia: 'control' });
    assert.equal((await phone('/session', { cookie: dev2 })).status, 200);
    const fixedCountBeforeSwitch = (await web('/remote')).json.devices.length;
    await settings({ publicBaseUrl: 'https://other.example.test' });
    assert.equal((await phone('/session', { cookie: dev2, host: 'other.example.test', headers: { origin: 'https://other.example.test' } })).status, 401);
    assert.equal((await web('/remote')).json.devices.length, fixedCountBeforeSwitch);

    // Explicit legacy revoke-all API behavior remains; no UI toggle is added.
    await settings({ remoteAccess: true });
    const code3 = (await web('/remote/pair', 'POST', {})).json.url.split('#pair=')[1];
    const other = 'https://other.example.test';
    const dev3 = await pairDevice(code3, { host: 'other.example.test', headers: { origin: other } });
    assert.equal((await phone('/session', { cookie: dev3, host: 'other.example.test' })).status, 200);
    await settings({ remoteAccess: false });
    assert.equal((await phone('/session', { cookie: dev3, host: 'other.example.test' })).status, 401);
    assert.equal((await web('/remote')).json.available, true);
    await settings({ remoteAccess: true });
    assert.equal((await phone('/session', { cookie: dev3, host: 'other.example.test' })).status, 401, 'revoked devices never return');

    const code4 = (await web('/remote/pair', 'POST', {})).json.url.split('#pair=')[1];
    const dev4 = await pairDevice(code4, { host: 'other.example.test', headers: { origin: other } });
    assert.equal((await phone('/session', { cookie: dev4, host: 'other.example.test' })).status, 200);
    const switched = await req('/api/account/migrate', { method: 'POST', body: { credential: { ...cred, userId: 'user_2', sessionId: '22222222-3333-4444-8555-666666666666', loginOrder: 8 } } });
    const nowUser = (await req('/api/account')).json?.userId;
    if (switched.json?.migrated === true && nowUser === 'user_2') assert.equal((await phone('/session', { cookie: dev4, host: 'other.example.test' })).status, 401, 'other account');
    else t.diagnostic(`account switch not possible in this fixture: ${switched.status} ${switched.text}`);
  });
}
