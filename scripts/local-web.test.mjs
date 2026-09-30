// Local Web: ticket login, read-only data and the local-only boundary, on an isolated daemon.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createIsolatedEnv } from './fixtures/isolated-env.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (process.argv.includes('--fixture-daemon')) {
  const { startDaemon } = await import('../dist/daemon.js');
  const daemon = await startDaemon({ port: Number(process.env.BLACKHOLE_PORT), dbPath: process.env.BLACKHOLE_DB, tunnel: 'off' }, () => {});
  process.on('message', (message) => {
    if (message === 'stop') void daemon.stop().then(() => process.exit(0), () => process.exit(1));
  });
  process.send({ ready: true });
} else {
  test('local web: ticket login, read-only data, local-only boundary', { timeout: 60_000 }, async (t) => {
    const iso = await createIsolatedEnv({ name: 'local-web' });
    const env = { ...iso.env, BLACKHOLE_WEB_DIR: path.join(ROOT, 'packages/web/dist') };
    const child = fork(fileURLToPath(import.meta.url), ['--fixture-daemon'], { env, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const exited = new Promise((resolve) => child.once('exit', resolve));
    let client;
    t.after(async () => {
      await client?.close().catch(() => {});
      if (child.connected) child.send('stop');
      let timer;
      await Promise.race([exited, new Promise((resolve) => { timer = setTimeout(() => { child.kill(); resolve(); }, 4000); })]);
      clearTimeout(timer);
      iso.cleanup();
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('isolated daemon startup timeout')), 15_000);
      child.once('exit', (code) => { clearTimeout(timer); reject(Error(`daemon exited before ready: ${code}`)); });
      child.once('message', (m) => { clearTimeout(timer); m.ready ? resolve() : reject(Error('unexpected message')); });
    });

    const base = `http://127.0.0.1:${iso.port}`;
    const origin = base;
    const control = async (route, body) => {
      const res = await fetch(base + '/api' + route, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      assert.ok(res.ok, `${route} ${res.status}`);
      return res.json();
    };

    // Tray quit: only unmarked heartbeats (VS Code) count as another client still using the daemon.
    const beat = (h = {}) => fetch(base + '/api/heartbeat', { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: '{}' });
    assert.equal((await control('/clients')).others_active, false);
    await beat({ 'x-blackhole-client': 'tray' });
    assert.equal((await control('/clients')).others_active, false, 'the tray itself does not count');
    await beat();
    assert.equal((await control('/clients')).others_active, true, 'VS Code keeps the service when the tray quits');

    // Real data: a session, recorded tool calls and a todo board written through MCP.
    const session = await control('/sessions', { workspace_path: iso.home, name: 'local web fixture' });
    assert.equal(new URL(session.mcp_url).origin, base, 'must stay on the isolated daemon');
    client = new Client({ name: 'local-web-fixture', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(session.mcp_url)));
    const sid = session.session_id;
    await client.callTool({ name: 'guide', arguments: { sessionId: sid } });
    await client.callTool({ name: 'todo', arguments: { sessionId: sid, command: 'write', todos: [{ content: 'first step', status: 'completed' }, { content: 'second step', status: 'in_progress' }] } });

    // Ticket issuance is for native callers only.
    const bootstrap = (headers = {}) => fetch(base + '/api/web/bootstrap', { method: 'POST', headers });
    assert.equal((await bootstrap({ origin })).status, 403, 'browser Origin must not mint tickets');
    assert.equal((await bootstrap({ 'sec-fetch-site': 'same-origin' })).status, 403);
    assert.equal((await bootstrap({ 'x-forwarded-for': '1.2.3.4' })).status, 403);
    const issued = await (await bootstrap()).json();
    assert.match(issued.ticket, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(issued.path, '/ui/');

    // The page lives at /: browsers on this machine get it; tunnel traffic and scripts get the banner.
    const html = { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' };
    const root = await fetch(base + '/', { headers: html });
    assert.equal(root.status, 200);
    assert.match(await root.text(), /<div id="root">/);
    assert.equal(root.headers.get('cache-control'), 'no-store');
    assert.match(await (await fetch(base + '/')).text(), /MCP endpoint/, 'non-browser callers keep the banner');
    for (const h of [{ 'cf-connecting-ip': '1.1.1.1' }, { 'x-forwarded-for': '1.1.1.1' }]) {
      assert.match(await (await fetch(base + '/', { headers: { ...html, ...h } })).text(), /MCP endpoint/, JSON.stringify(h));
    }
    {
      // fetch cannot override Host; a tunnel hostname must still get the banner.
      const { request } = await import('node:http');
      const u = new URL(base);
      const text = await new Promise((ok, no) => request({ host: u.hostname, port: u.port, path: '/', headers: { ...html, host: 'x.trycloudflare.com' } }, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => ok(d)); }).on('error', no).end());
      assert.match(text, /MCP endpoint/, 'tunnel Host gets the banner');
    }
    for (const p of ['/ui/', '/ui/index.html', '/ui/?s=1']) {
      const r = await fetch(base + p, { redirect: 'manual' });
      assert.equal(r.status, 302, p);
      assert.equal(r.headers.get('location'), p.includes('?') ? '/?s=1' : '/', p);
    }
    assert.equal((await fetch(base + '/mcp/nope', { headers: html })).headers.get('content-type')?.includes('text/html') ?? false, false, 'MCP is untouched');

    // Page is served with a strict policy, and never through a proxy hop.
    const page = await fetch(base + '/ui/index.html', { redirect: 'follow', headers: html });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<div id="root">/);
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'.*frame-ancestors 'none'/);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(page.headers.get('cache-control'), 'no-store');
    for (const h of [{ 'cf-connecting-ip': '1.1.1.1' }, { 'cf-ray': 'x' }, { forwarded: 'for=1.1.1.1' }, { 'x-forwarded-for': '1.1.1.1' }]) {
      assert.equal((await fetch(base + '/ui/', { headers: h, redirect: 'manual' })).status, 403, JSON.stringify(h));
    }

    // Data needs a session.
    const web = (route, { cookie, method = 'GET', body, headers = {} } = {}) =>
      fetch(base + '/web-api/v1' + route, {
        method,
        headers: { 'x-blackhole-web': '1', ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json', origin } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
      });
    assert.equal((await web('/sessions')).status, 401);

    // Exchange: exact Origin + client header, one use only.
    assert.equal((await web('/auth/exchange', { method: 'POST', body: { ticket: issued.ticket }, headers: { origin: 'http://evil.test' } })).status, 403);
    assert.equal((await web('/auth/exchange', { method: 'POST', body: { ticket: 'A'.repeat(43) } })).status, 401);
    const ex = await web('/auth/exchange', { method: 'POST', body: { ticket: issued.ticket } });
    assert.equal(ex.status, 200);
    const setCookie = ex.headers.get('set-cookie');
    assert.match(setCookie, /^bh_web=[A-Za-z0-9_-]{43}; Path=\/web-api; HttpOnly; SameSite=Strict; Max-Age=2592000$/);
    const cookie = setCookie.split(';')[0];
    assert.equal((await web('/auth/exchange', { method: 'POST', body: { ticket: issued.ticket } })).status, 401, 'ticket is single-use');

    // Read-only data with the cookie.
    const me = await (await web('/auth/session', { cookie })).json();
    assert.equal(me.authenticated, true);

    // Account gate: a ticket alone opens no business data until this machine's account is signed in.
    assert.equal(me.account_required, true);
    assert.equal((await (await web('/sessions', { cookie })).json()).error, 'account_required');
    assert.equal((await web('/account', { cookie })).status, 200, 'the login page can still read account state');

    assert.equal((await web('/auth/local', { method: 'POST', body: {} })).status, 401, 'no account yet: local entry refused');

    // Browser login without any session: same-origin only, rate limited, result by polling.
    const login = (headers = {}) => web('/auth/login', { method: 'POST', body: {}, headers });
    assert.equal((await login({ origin: 'http://evil.test' })).status, 403);
    const started = await login();
    assert.equal(started.status, 202);
    const { attempt } = await started.json();
    assert.match(attempt, /^[A-Za-z0-9_-]{43}$/);
    let polled;
    for (let i = 0; i < 50; i++) {
      polled = await (await web('/auth/login/' + attempt)).json();
      if (polled.state !== 'running') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(polled.state, 'failed', 'offline fixture: the cloud sign-in cannot complete');
    assert.equal((await web('/auth/login/' + attempt)).status, 404, 'attempt is single-use');
    assert.equal((await web('/auth/login/' + 'B'.repeat(43))).status, 404);
    for (let i = 0; i < 4; i++) await login();
    assert.equal((await login()).status, 429, 'at most 5 per minute');

    const earlyCred = { token: 'bhp_' + 'a'.repeat(43), userId: 'user_1', clientId: 'c'.repeat(22), sessionId: '11111111-2222-4333-8444-555555555555', expiresAt: Math.floor(Date.now() / 1000) + 3600, loginOrder: 7 };
    assert.deepEqual(await control('/account/migrate', { credential: earlyCred }), { migrated: true });
    assert.equal((await (await web('/auth/session', { cookie })).json()).account_required, false);

    // Local browser with no ticket: the machine's signed-in account lets it in; foreign origins never.
    assert.equal((await web('/auth/local', { method: 'POST', body: {}, headers: { origin: 'http://evil.test' } })).status, 403);
    assert.equal((await web('/auth/local', { method: 'POST', body: {}, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
    const local = await web('/auth/local', { method: 'POST', body: {} });
    assert.equal(local.status, 200);
    const localCookie = local.headers.get('set-cookie').split(';')[0];
    assert.equal((await web('/sessions', { cookie: localCookie })).status, 200);
    const list = await (await web('/sessions', { cookie })).json();
    const row = list.sessions.find((s) => s.id === session.id);
    assert.ok(row, 'session listed');
    assert.equal(row.name, 'local web fixture');
    assert.equal(row.todos_total, 2);
    assert.equal(row.todos_done, 1);
    assert.ok(row.calls_total >= 2);
    const text = JSON.stringify(list);
    assert.ok(!text.includes(sid), 'numeric credential never leaves');

    const calls = await (await web(`/sessions/${session.id}/calls?limit=10`, { cookie })).json();
    assert.ok(calls.calls.some((c) => c.tool === 'todo'));
    assert.ok(!JSON.stringify(calls).includes(sid), 'recorded args drop the credential');
    // page is 0-based (0 = newest, same as the VS Code sidebar); an anchor freezes deep pages.
    const p0 = await (await web(`/sessions/${session.id}/calls?page=0&limit=1`, { cookie })).json();
    assert.equal(p0.calls.length, 1);
    assert.equal(p0.calls[0].id, calls.calls[0].id, 'page 0 is the newest call');
    assert.ok(p0.max_seq > 0);
    assert.equal(p0.window_total, p0.total);
    const p1 = await (await web(`/sessions/${session.id}/calls?page=1&limit=1&anchor=${p0.max_seq}`, { cookie })).json();
    assert.equal(p1.calls[0].id, calls.calls[1].id, 'page 1 continues right after page 0');
    const below = await (await web(`/sessions/${session.id}/calls?page=0&limit=1&anchor=${p0.max_seq - 1}`, { cookie })).json();
    assert.equal(below.calls[0].id, calls.calls[1].id, 'rows newer than the anchor are left out');
    assert.equal(below.window_total, p0.total - 1);
    const todos = await (await web(`/sessions/${session.id}/todos`, { cookie })).json();
    assert.deepEqual(todos.items.map((i) => i.content), ['first step', 'second step']);
    assert.equal((await web('/sessions/nope/todos', { cookie })).status, 404);

    // Cross-origin and header-less callers are refused even with the cookie.
    assert.equal((await web('/sessions', { cookie, headers: { 'x-blackhole-web': '' } })).status, 403);
    assert.equal((await web('/sessions', { cookie, headers: { origin: 'http://127.0.0.1:1' } })).status, 403);
    assert.equal((await web('/sessions', { cookie, headers: { 'sec-fetch-site': 'same-site' } })).status, 403);
    assert.equal((await web('/sessions', { cookie, headers: { 'cf-ray': 'x' } })).status, 403);
    // fetch cannot override Host (DNS-rebinding shape), so use a raw request.
    const badHost = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: iso.port, path: '/web-api/v1/sessions', headers: { host: `evil.test:${iso.port}`, cookie, 'x-blackhole-web': '1' } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
    });
    assert.equal(badHost, 403);

    // Writes need the CSRF token bound to this cookie, exact Origin and a JSON body.
    const exBody = me; // /auth/session echoes the token for page reloads
    const csrf = exBody.csrf;
    assert.match(csrf, /^[A-Za-z0-9_-]{43}$/);
    // A stale same-named cookie sent first (longer path, older build, another port on
    // this host) must not hide the valid one; the CSRF token stays bound to the valid one.
    const staleFirst = `bh_web=${'A'.repeat(43)}; ${cookie}`;
    const staleSession = await web('/auth/session', { cookie: staleFirst });
    assert.equal(staleSession.status, 200, 'stale cookie first still signs in');
    assert.equal((await staleSession.json()).csrf, csrf);
    assert.equal((await web('/auth/session', { cookie: `bh_web=${'A'.repeat(43)}; bh_web=${'B'.repeat(43)}` })).status, 401, 'only stale cookies');
    const write = (route, body, { method = 'POST', headers = {} } = {}) => web(route, { cookie, method, body, headers: { 'x-blackhole-csrf': csrf, ...headers } });
    const fsTmp = await import('node:fs');
    const wsDir = path.join(iso.home, 'proj Ü space');
    fsTmp.mkdirSync(wsDir, { recursive: true });
    fsTmp.writeFileSync(path.join(iso.home, 'afile.txt'), 'x');
    assert.equal((await web('/sessions', { cookie, method: 'POST', body: { workspace_path: wsDir } })).status, 403, 'missing csrf');
    assert.equal((await write('/sessions', { workspace_path: wsDir }, { headers: { 'x-blackhole-csrf': 'A'.repeat(43) } })).status, 403, 'wrong csrf');
    assert.equal((await write('/sessions', { workspace_path: wsDir }, { headers: { origin: 'http://evil.test' } })).status, 403, 'cross origin');
    assert.equal((await write('/sessions', { workspace_path: wsDir }, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
    const textBody = await fetch(base + '/web-api/v1/sessions', { method: 'POST', headers: { 'x-blackhole-web': '1', cookie, origin, 'x-blackhole-csrf': csrf, 'content-type': 'text/plain' }, body: 'x' });
    assert.equal(textBody.status, 415);

    // OpenAI tunnel in the web settings: VS Code's handlers behind cookie + CSRF (loopback peer only).
    const oaRes = await web('/openai-tunnel', { cookie });
    assert.equal(oaRes.status, 200);
    const oaView = await oaRes.json();
    assert.equal(typeof oaView.status, 'string');
    assert.equal(typeof oaView.credential_revision, 'number');
    assert.equal((await web('/openai-tunnel', {})).status, 401, 'openai view needs the session cookie');
    assert.deepEqual(await (await web('/openai-tunnel/install', { cookie })).json(), { state: 'idle' }, 'install job idle (never started here)');
    assert.equal((await web('/openai-tunnel/stop', { cookie, method: 'POST', body: { daemon_id: 'x', run_id: null } })).status, 403, 'openai writes need csrf');
    assert.equal((await write('/openai-tunnel/stop', { daemon_id: 'not-this-daemon', run_id: null })).status, 409, 'stale daemon id');
    const daemonId = (await control('/health')).daemon_id;
    const badKey = await write('/openai-tunnel/credential', { daemon_id: daemonId, credential_revision: oaView.credential_revision, api_key: 'sk web secret' }, { method: 'PUT' });
    assert.equal(badKey.status, 400);
    const badKeyText = await badKey.text();
    assert.match(badKeyText, /invalid_api_key/);
    assert.ok(!badKeyText.includes('sk web secret'), 'the key is never echoed');
    assert.equal((await fetch(base + '/remote-api/v1/openai-tunnel')).ok, false, 'not on the phone surface');

    // Presence: an open Local Web page holds one long-lived response; the watchdog counts it
    // like a VS Code window, while tray quit (/clients others_active) still ignores it.
    assert.equal(typeof (await control('/health')).settings_revision, 'number', 'health carries the settings revision');
    assert.equal((await web('/presence')).status, 401, 'presence needs the session cookie');
    assert.equal((await fetch(base + '/remote-api/v1/presence')).ok, false, 'no presence on the phone surface');
    assert.equal((await control('/clients')).web_present, false);
    const presenceStop = new AbortController();
    const presence = await fetch(base + '/web-api/v1/presence', { headers: { 'x-blackhole-web': '1', cookie }, signal: presenceStop.signal });
    assert.equal(presence.status, 200);
    assert.match(presence.headers.get('content-type') ?? '', /^text\/event-stream/);
    const firstChunk = await presence.body.getReader().read();
    assert.equal(firstChunk.done, false, 'the stream stays open');
    assert.equal((await control('/clients')).web_present, true);
    presenceStop.abort();
    let present = true;
    for (let i = 0; i < 40 && present; i++) {
      await new Promise((r) => setTimeout(r, 50));
      present = (await control('/clients')).web_present;
    }
    assert.equal(present, false, 'closing the page ends its presence');
    assert.equal((await write('/sessions', { workspace_path: 'x'.repeat(70 * 1024) })).status, 413);
    assert.equal((await write('/sessions', { workspace_path: wsDir, role: 'admin' })).status, 400, 'unknown keys rejected');
    assert.equal((await write('/sessions', { workspace_path: path.join(iso.home, 'missing') })).status, 400);
    assert.equal((await write('/sessions', { workspace_path: path.join(iso.home, 'afile.txt') })).status, 400);
    assert.equal((await write('/sessions', { workspace_path: wsDir, permission_mode: 'root' })).status, 400);
    const createdRes = await write('/sessions', { workspace_path: path.join(wsDir, '..', 'proj Ü space'), name: 'from web', auto_approve: true });
    assert.equal(createdRes.status, 201);
    const created = await createdRes.json();
    assert.equal(created.session.workspace_path, fsTmp.realpathSync(wsDir), 'canonical path');
    assert.equal(created.session.auto_approve, true);
    assert.match(created.session_id, /^[0-9]+$/);
    assert.equal(new URL(created.mcp_url).origin, base);
    const listed = await (await web('/sessions', { cookie })).json();
    assert.ok(listed.sessions.some((s) => s.id === created.session.id && s.name === 'from web'));
    assert.ok(!JSON.stringify(listed).includes(created.session_id), 'credential only in the create response');

    // Folder picker lists directories only.
    const roots = await (await web('/fs/dirs', { cookie })).json();
    assert.ok(roots.dirs.length >= 1);
    const listing = await (await web('/fs/dirs?path=' + encodeURIComponent(iso.home), { cookie })).json();
    assert.ok(listing.dirs.some((d) => d.name === 'proj Ü space'));
    assert.ok(!listing.dirs.some((d) => d.name === 'afile.txt'));
    assert.equal((await web('/fs/dirs?path=' + encodeURIComponent(path.join(iso.home, 'afile.txt')), { cookie })).status, 400);

    // Projects: add, dedupe on canonical path, rename/pin, remove; session folders appear too.
    let projects = (await (await web('/projects', { cookie })).json()).projects;
    assert.ok(projects.some((p) => !p.saved && p.sessions >= 1), 'session folders listed');
    const addRes = await write('/projects', { path: wsDir, label: 'My project' });
    assert.equal(addRes.status, 201);
    const proj = (await addRes.json()).project;
    assert.equal((await write('/projects', { path: path.join(wsDir, '.') })).status, 409, 'duplicate');
    assert.equal((await write('/projects', { path: path.join(iso.home, 'afile.txt') })).status, 400);
    assert.equal((await write('/projects/' + proj.id, { pinned: true, label: 'Renamed' }, { method: 'PATCH' })).status, 200);
    projects = (await (await web('/projects', { cookie })).json()).projects;
    assert.equal(projects[0].label, 'Renamed');
    assert.equal(projects[0].pinned, true);
    assert.equal(projects.filter((p) => p.path === proj.path).length, 1, 'saved project replaces the session-derived row');
    assert.equal((await write('/projects/' + proj.id, {}, { method: 'DELETE' })).status, 200);
    assert.equal((await write('/projects/' + proj.id, {}, { method: 'DELETE' })).status, 404);

    // Settings: daemon-owned, revision-checked, strict keys.
    const st0 = await (await web('/settings', { cookie })).json();
    assert.equal(st0.migrated, false);
    assert.equal(st0.values.channelMode, 'cloudflare');
    assert.equal((await write('/settings', { values: { connectorName: 'x' } }, { method: 'PATCH' })).status, 400, 'revision required');
    assert.equal((await write('/settings', { revision: st0.revision, values: { port: 1 } }, { method: 'PATCH' })).status, 400, 'unknown key');
    assert.equal((await write('/settings', { revision: st0.revision, values: { publicBaseUrl: 'javascript:alert(1)' } }, { method: 'PATCH' })).status, 400);
    assert.equal((await web('/settings', { cookie, method: 'PATCH', body: { revision: st0.revision, values: { connectorName: 'x' } } })).status, 403, 'csrf');
    const savedRes = await write('/settings', { revision: st0.revision, values: { connectorName: '@Team', skillsDir: wsDir, channelMode: 'custom' } }, { method: 'PATCH' });
    assert.equal(savedRes.status, 200);
    const saved = await savedRes.json();
    assert.equal(saved.values.connectorName, 'Team');
    assert.equal(saved.migrated, true);
    assert.deepEqual(saved.pending_restart.sort(), ['skillsDir'], 'channelMode is a view preference, not a restart key');
    assert.equal((await write('/settings', { revision: st0.revision, values: { connectorName: 'y' } }, { method: 'PATCH' })).status, 409, 'stale revision');
    // The extension reads the same record; a later migrate never overwrites it.
    const ctl = await control('/settings');
    assert.equal(ctl.values.connectorName, 'Team');
    const mig = await (await fetch(base + '/api/settings/migrate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ values: { connectorName: 'Old' } }) })).json();
    assert.equal(mig.values.connectorName, 'Team');
    const probe = await (await write('/settings/probe', { url: 'not a url' })).json();
    assert.equal(probe.ok, false);

    // Account (plan 6.11): daemon-owned; isolated env uses a memory store and no network.
    const health = await control('/health');
    assert.equal(health.account_api_version, 1);
    assert.equal(health.account_storage, 'available');
    const post = (route, body) => fetch(base + '/api' + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const cred = { token: 'bhp_' + 'a'.repeat(43), userId: 'user_1', clientId: 'c'.repeat(22), sessionId: '11111111-2222-4333-8444-555555555555', expiresAt: Math.floor(Date.now() / 1000) + 3600, loginOrder: 7 };
    assert.equal((await post('/account/migrate', { credential: { ...cred, token: 'nope' } })).status, 400);
    assert.equal((await post('/account/migrate', { credential: { ...cred, expiresAt: 10 } })).status, 400, 'expired');
    assert.equal((await control('/account/migrate', { credential: cred })).reason, 'same_session', 'adopted earlier for the account gate');
    assert.equal((await control('/account/migrate', { credential: { ...cred, sessionId: '99999999-2222-4333-8444-555555555555', loginOrder: 8 } })).reason, 'daemon_has_account');
    const acc = await (await web('/account', { cookie })).json();
    assert.equal(acc.userId, 'user_1');
    assert.equal(acc.storage, 'available');
    assert.equal(acc.signIn.state, 'failed', 'the offline browser-login attempt above');
    assert.ok(!JSON.stringify(acc).includes('bhp_'), 'token never leaves the daemon');
    assert.ok(!JSON.stringify(await control('/account')).includes('bhp_'));
    assert.equal((await post('/account/call', { method: 'migrationCredential' })).status, 400, 'only whitelisted methods');
    assert.equal((await post('/account/call', { method: 'billingPlans', args: [1] })).status, 400, 'string args only');
    assert.equal((await web('/account/sign-out', { cookie, method: 'POST', body: {} })).status, 403, 'csrf');
    assert.equal((await write('/daemon/stop', {})).status, 400, 'stop needs explicit confirm');
    assert.equal((await write('/daemon/restart', {})).status, 400, 'restart needs explicit confirm');
    // Subscription (S4): input checked before any cloud call; the offline fixture cloud answers with an error, never 401/404.
    for (const [route, body] of [['/account/orders', {}], ['/account/orders', { sku: '' }], ['/account/orders/x/refund', {}], ['/account/redeem', { code: 7 }]]) {
      assert.equal((await write(route, body)).status, 400, route);
    }
    assert.equal((await web('/account/orders', { cookie, method: 'POST', body: { sku: 'month' } })).status, 403, 'csrf');
    assert.equal((await web('/account/refundable?cursor=' + 'x'.repeat(300), { cookie })).status, 400);
    for (const route of ['/account/plans', '/account/orders']) {
      const r = await web(route, { cookie });
      assert.ok(r.status >= 500 || r.status === 200, route + ' ' + r.status);
    }

    // Settings panel actions (plan 6.12 S3): the same handlers as /api, listed routes only.
    const ph = await web('/panel/health', { cookie });
    assert.equal(ph.status, 200);
    assert.equal((await ph.json()).ok, true);
    assert.equal((await web('/panel/health')).status, 401, 'panel needs the session');
    assert.equal((await web('/panel/tunnel', { cookie })).status, 200);
    assert.equal((await web('/panel/approvals', { cookie })).status, 200);
    assert.equal((await web('/panel/proxies', { cookie })).status, 200);
    assert.equal((await web('/panel/semantic', { cookie })).status, 200);
    assert.equal((await web('/panel/token/rotate', { cookie, method: 'POST', body: {} })).status, 403, 'panel writes need csrf');
    for (const [route, method] of [['/panel/shutdown', 'POST'], ['/panel/sessions', 'GET'], ['/panel/account/call', 'POST'], ['/panel/settings/migrate', 'POST'], ['/panel/semantic/scan', 'POST'], ['/panel/heartbeat', 'POST'], ['/panel/tunnel/start', 'GET']]) {
      const r = method === 'GET' ? await web(route, { cookie }) : await write(route, {});
      assert.equal(r.status, 404, route);
    }
    const ts = await (await write('/panel/tunnel/stop', {})).json();
    assert.equal(ts.status, 'off');
    // cloudflared initialization belongs to the daemon; the custom channel saved above refuses it.
    assert.equal((await (await web('/cloudflared/install', { cookie })).json()).state, 'idle');
    assert.equal((await write('/cloudflared/install', {})).status, 409);
    assert.equal((await web('/cloudflared/install', { cookie, method: 'POST', body: {} })).status, 403, 'csrf');

    // Routes that were never added stay 404.
    assert.equal((await write(`/sessions/${session.id}/pause`, {})).status, 404);

    // Logout revokes the session.
    // Sent behind a stale same-named cookie: the valid session is the one revoked.
    assert.equal((await web('/auth/logout', { cookie: staleFirst, method: 'POST', body: {} })).status, 200);
    assert.equal((await web('/sessions', { cookie })).status, 401);
  });

  test('channel watchdog: an open Local Web page counts as present; the grace period starts when it closes', async (t) => {
    const { startChannelWatchdog, STALE_MS } = await import('../dist/tunnel/watchdog.js');
    t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_000_000 });
    let stops = 0;
    const deps = {
      lastHeartbeatAt: Date.now(),
      tunnel: { status: 'online', stop: async () => { stops++; } },
      log: () => {},
      webPresence: new Set([{}]),
    };
    const dog = startChannelWatchdog(deps);
    t.after(() => dog.stop());
    // One watchdog tick (15 s) per step, so Date moves with each check.
    const advance = (ms) => { for (let left = ms; left > 0; left -= 15_000) t.mock.timers.tick(Math.min(15_000, left)); };
    advance(STALE_MS * 4);
    assert.equal(stops, 0, 'no VS Code heartbeat, but a page is open');
    deps.webPresence.clear();
    deps.lastHeartbeatAt = Date.now(); // what the presence route does when the page goes away
    advance(STALE_MS);
    assert.equal(stops, 0, 'grace period after the page closed');
    advance(15_000);
    assert.equal(stops, 1, 'stale without any window or page');
  });
}
