// OpenAI Secure MCP Tunnel (plan §5): runtime manager, strict credential store and control routes.
// Uses a fake child process only — never starts tunnel-client or reaches OpenAI.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import express from 'express';
import { OpenAITunnelManager, OpenAITunnelError, classifyLog } from '../dist/tunnel/openai-manager.js';
import { CredentialStoreError, memoryEntryFactory, openAITunnelSecretFile, openOpenAITunnelCredential, strictStore } from '../dist/tunnel/openai-credential.js';
import { mountOpenAITunnel, nativeLoopbackRequest } from '../dist/control/openai-tunnel-routes.js';

const ID = 'tunnel_0123456789abcdef0123456789abcdef';
const KEY = 'sk-test-0000000000000000000000000000';
const CLIENT = path.resolve(tmpdir(), 'tunnel-client-runtime.exe');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('timeout'); await wait(5); }
}

/** Fake tunnel-client: writes its health URL, optionally prints/exits per script. */
function fakeSpawner(behave = () => ({})) {
  const calls = [];
  const spawnProcess = (file, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.exitCode = null; child.signalCode = null; child.killed = 0;
    const exit = (code) => { if (child.exitCode !== null) return; child.exitCode = code; child.emit('exit', code); };
    child.kill = () => { child.killed++; setImmediate(() => exit(0)); return true; };
    const call = { file, args, opts, child, exit };
    calls.push(call);
    const b = behave(calls.length, call);
    const urlFile = args[args.indexOf('--health.url-file') + 1];
    setImmediate(() => {
      if (b.stderr) child.stderr.write(b.stderr);
      if (b.exitCode !== undefined) { setTimeout(() => exit(b.exitCode), 5); return; }
      writeFileSync(urlFile, 'http://127.0.0.1:43210\n');
    });
    return child;
  };
  return { calls, spawnProcess };
}

function setup(over = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'bh-oa-test-'));
  const settings = { revision: 3, values: { openaiTunnelId: ID, openaiTunnelClientPath: CLIENT } };
  const credential = strictStore('memory', memoryEntryFactory());
  const fake = fakeSpawner(over.behave);
  let ready = over.ready ?? true;
  let target = 'http://127.0.0.1:7777/mcp/machine-token-abcdefghijklmnop';
  const events = [];
  const m = new OpenAITunnelManager({
    settings: () => settings,
    credential,
    target: () => target,
    log: () => {},
    onEvent: (s, d) => events.push([s, d]),
    spawnProcess: fake.spawnProcess,
    verifyClient: async () => '0.0.15',
    fetchHealth: async (url) => (url.endsWith('/readyz') ? { status: ready ? 200 : 503, body: '' } : { status: 200, body: JSON.stringify({ ok: true, key: KEY }) }),
    runDirRoot: root,
    timing: { urlFileTimeoutMs: 400, readyTimeoutMs: 400, pollMs: 5, monitorMs: 20, restartDelaysMs: [5, 5], killGraceMs: 50 },
    env: { PATH: '/bin', HTTPS_PROXY: 'http://proxy:8080', OPENAI_API_KEY: 'sk-leak', SECRET_TOKEN: 'x' },
    ...over.opts,
  });
  return { m, settings, credential, fake, events, root, setReady: (v) => { ready = v; }, setTarget: (t) => { target = t; }, done: () => rmSync(root, { recursive: true, force: true }) };
}

test('explicit start: key and machine URL only in child env, private profile dir, ready then stop cleans up', async (t) => {
  const s = setup(); t.after(s.done);
  await s.credential.set(KEY);
  const rev = s.m.credentialRevision;
  const v = await s.m.start({ settingsRevision: 3, credentialRevision: rev });
  assert.equal(v.status, 'starting');
  await until(() => s.m.status === 'ready');
  const { args, opts, file } = s.fake.calls[0];
  assert.equal(file, CLIENT);
  assert.equal(opts.shell, false); assert.equal(opts.windowsHide, true);
  assert.deepEqual(args.slice(0, 7), ['run', '--control-plane.tunnel-id', ID, '--control-plane.api-key', 'env:CONTROL_PLANE_API_KEY', '--health.listen-addr', '127.0.0.1:0']);
  assert.ok(!args.join(' ').includes(KEY) && !args.join(' ').includes('/mcp/'), 'argv never carries secrets');
  const runDir = path.dirname(args[args.indexOf('--health.url-file') + 1]);
  assert.equal(args[args.indexOf('--profile-dir') + 1], path.join(runDir, 'profiles'));
  assert.equal(opts.env.CONTROL_PLANE_API_KEY, KEY);
  assert.match(opts.env.MCP_SERVER_URL, /^http:\/\/127\.0\.0\.1:7777\/mcp\//);
  assert.equal(opts.env.HTTPS_PROXY, 'http://proxy:8080');
  assert.equal(opts.env.OPENAI_API_KEY, undefined, 'unrelated secrets are not inherited');
  assert.equal(opts.env.SECRET_TOKEN, undefined);
  const view = s.m.view();
  assert.equal(view.active_tunnel_id, ID); assert.equal(view.client_version, '0.0.15'); assert.ok(view.ready_at);
  assert.ok(!JSON.stringify(view).includes(KEY));
  // Same request again is idempotent (no second process).
  await s.m.start({ settingsRevision: 3, credentialRevision: rev });
  assert.equal(s.fake.calls.length, 1);
  await assert.rejects(s.m.stop('someone-else'), (e) => e instanceof OpenAITunnelError && e.code === 'run_changed');
  const off = await s.m.stop(view.run_id);
  assert.equal(off.status, 'off'); assert.equal(off.run_id, null);
  assert.ok(s.fake.calls[0].child.killed >= 1);
  assert.ok(!existsSync(runDir), 'private run dir removed');
});

test('preconditions: fixed codes, stale revisions rejected, nothing spawned', async (t) => {
  const s = setup(); t.after(s.done);
  const code = async (p, c) => assert.rejects(p, (e) => e instanceof OpenAITunnelError && e.code === c);
  await code(s.m.start({ settingsRevision: 3, credentialRevision: s.m.credentialRevision }), 'credential_missing');
  await s.credential.set(KEY);
  await code(s.m.start({ settingsRevision: 2, credentialRevision: s.m.credentialRevision }), 'settings_changed');
  await code(s.m.start({ settingsRevision: 3, credentialRevision: 99 }), 'credential_changed');
  s.settings.values.openaiTunnelId = 'tun_abc-123';
  await code(s.m.start({ settingsRevision: 3, credentialRevision: s.m.credentialRevision }), 'tunnel_id_invalid');
  s.settings.values.openaiTunnelId = '';
  await code(s.m.start({ settingsRevision: 3, credentialRevision: s.m.credentialRevision }), 'tunnel_id_missing');
  s.settings.values.openaiTunnelId = ID; s.settings.values.openaiTunnelClientPath = '';
  await code(s.m.start({ settingsRevision: 3, credentialRevision: s.m.credentialRevision }), 'client_missing');
  assert.equal(s.m.status, 'error'); assert.equal(s.m.view().reason_code, 'client_missing');
  assert.equal(s.fake.calls.length, 0);
});

test('client verification failure and unreadable keychain are reported, not guessed', async (t) => {
  const s = setup({ opts: { verifyClient: async () => { throw new Error('not a plain runtime'); } } }); t.after(s.done);
  await assert.rejects(s.m.start({ settingsRevision: 3, credentialRevision: s.m.credentialRevision }), (e) => e.code === 'client_invalid');
  const u = setup({ opts: { credential: await openOpenAITunnelCredential('unavailable') } }); t.after(u.done);
  await assert.rejects(u.m.start({ settingsRevision: 3, credentialRevision: u.m.credentialRevision }), (e) => e.status === 503 && e.code === 'credential_store_unavailable');
  assert.equal(u.m.view().credential_configured, null, 'unknown, never "not set"');
  assert.equal(u.fake.calls.length, 0);
});

test('deterministic auth failure stops without restart; transient exits restart then give up', async (t) => {
  const a = setup({ behave: () => ({ stderr: 'control plane: 401 Unauthorized\n', exitCode: 1 }) }); t.after(a.done);
  await a.credential.set(KEY);
  await a.m.start({ settingsRevision: 3, credentialRevision: a.m.credentialRevision });
  await until(() => a.m.status === 'error');
  assert.equal(a.m.view().reason_code, 'auth_failed');
  await wait(40);
  assert.equal(a.fake.calls.length, 1, 'no restart loop on 401');

  const b = setup({ behave: () => ({ exitCode: 2 }) }); t.after(b.done);
  await b.credential.set(KEY);
  await b.m.start({ settingsRevision: 3, credentialRevision: b.m.credentialRevision });
  await until(() => b.m.status === 'error');
  assert.equal(b.fake.calls.length, 3, 'initial + 2 bounded restarts');
  assert.equal(b.m.view().reason_code, 'exited');
  assert.ok(b.events.some(([st]) => st === 'recovering'));
});

test('readiness timeout gives up with a code; recovery after a crash reaches ready again', async (t) => {
  const s = setup({ ready: false }); t.after(s.done);
  await s.credential.set(KEY);
  await s.m.start({ settingsRevision: 3, credentialRevision: s.m.credentialRevision });
  await until(() => s.m.status === 'error');
  assert.equal(s.m.view().reason_code, 'not_ready_timeout');
  assert.ok(s.fake.calls[0].child.killed >= 1);

  const r = setup(); t.after(r.done);
  await r.credential.set(KEY);
  await r.m.start({ settingsRevision: 3, credentialRevision: r.m.credentialRevision });
  await until(() => r.m.status === 'ready');
  r.fake.calls[0].exit(1);
  await until(() => r.fake.calls.length === 2 && r.m.status === 'ready');
  await r.m.stop(null);
});

test('credential replaced while running: pending restart, never revived with the old key', async (t) => {
  const s = setup(); t.after(s.done);
  await s.credential.set(KEY);
  await s.m.start({ settingsRevision: 3, credentialRevision: s.m.credentialRevision });
  await until(() => s.m.status === 'ready');
  const before = s.m.credentialRevision;
  const v = await s.m.setCredential(before, 'sk-test-1111111111111111111111111111');
  assert.equal(v.credential_revision, before + 1);
  assert.equal(v.pending_restart, true);
  await assert.rejects(s.m.setCredential(before, KEY), (e) => e.code === 'credential_changed');
  s.fake.calls[0].exit(1);
  await until(() => s.m.status === 'error');
  assert.equal(s.m.view().reason_code, 'credential_pending_restart');
  assert.equal(s.fake.calls.length, 1);
  // Unrelated settings revisions do not flag a restart.
  const r = setup(); t.after(r.done);
  await r.credential.set(KEY);
  await r.m.start({ settingsRevision: 3, credentialRevision: r.m.credentialRevision });
  r.settings.revision = 9;
  assert.equal(r.m.view().pending_restart, false);
  r.settings.values.openaiTunnelId = 'tunnel_ffffffffffffffffffffffffffffffff';
  assert.equal(r.m.view().pending_restart, true);
  await r.m.stop(null);
});

test('clearing the key stops the run first and confirms deletion', async (t) => {
  const s = setup(); t.after(s.done);
  await s.credential.set(KEY);
  await s.m.start({ settingsRevision: 3, credentialRevision: s.m.credentialRevision });
  await until(() => s.m.status === 'ready');
  const v = await s.m.removeCredential(s.m.credentialRevision);
  assert.equal(v.status, 'off'); assert.equal(v.credential_configured, false);
  assert.equal(await s.credential.get(), undefined);
});

test('machine token rotation rebuilds only a live run with the new local target', async (t) => {
  const s = setup(); t.after(s.done);
  await s.m.targetChanged();
  assert.equal(s.fake.calls.length, 0, 'nothing running: no-op');
  await s.credential.set(KEY);
  await s.m.start({ settingsRevision: 3, credentialRevision: s.m.credentialRevision });
  await until(() => s.m.status === 'ready');
  s.setTarget('http://127.0.0.1:7777/mcp/rotated-token-zyxwvutsrqponm');
  await s.m.targetChanged();
  assert.equal(s.fake.calls.length, 2);
  assert.match(s.fake.calls[1].opts.env.MCP_SERVER_URL, /rotated-token/);
  assert.ok(s.fake.calls[0].child.killed >= 1);
  await until(() => s.m.status === 'ready');
  await s.m.stop(null);
});

test('diagnostics are local, bounded and redacted', async (t) => {
  const s = setup({ behave: () => ({ stderr: `using key ${KEY} for http://127.0.0.1:7777/mcp/machine-token-abcdefghijklmnop\n` }) }); t.after(s.done);
  await s.credential.set(KEY);
  await s.m.start({ settingsRevision: 3, credentialRevision: s.m.credentialRevision });
  await until(() => s.m.status === 'ready');
  const d = await s.m.diagnostics();
  const text = JSON.stringify(d);
  assert.ok(!text.includes(KEY), 'API key redacted');
  assert.ok(!text.includes('machine-token-abcdefghijklmnop'), 'machine token redacted');
  assert.equal(d.readyz_status, 200);
  assert.equal(d.tunnel_id_saved, ID);
  assert.equal(d.credential_store, 'memory');
  await s.m.stop(null);
});

test('log classification', () => {
  assert.equal(classifyLog('HTTP 401 Unauthorized'), 'auth_failed');
  assert.equal(classifyLog('403 Forbidden: missing tunnels.use'), 'permission_denied');
  assert.equal(classifyLog('tunnel not found'), 'tunnel_not_found');
  assert.equal(classifyLog('proxyconnect tcp: dial tcp 10.0.0.1:8080: i/o timeout'), 'network_failed');
  assert.equal(classifyLog('all good'), null);
});

test('strict credential store: set reads back, delete is confirmed, failures are coded', async () => {
  const s = strictStore('memory', memoryEntryFactory());
  assert.equal(await s.remove(), 'absent');
  await s.set(KEY);
  assert.equal(await s.has(), true);
  assert.equal(await s.remove(), 'deleted');
  const lying = strictStore('file', () => ({ setPassword: async () => {}, getPassword: async () => 'other', deletePassword: async () => true }));
  await assert.rejects(lying.set(KEY), (e) => e instanceof CredentialStoreError && e.code === 'credential_store_failed');
  await assert.rejects(lying.remove(), (e) => e.code === 'credential_delete_unconfirmed');
  const hung = strictStore('file', () => ({ setPassword: () => new Promise(() => {}), getPassword: () => new Promise(() => {}), deletePassword: async () => true }), 20);
  const keepAlive = setInterval(() => {}, 5); // the store's timer is unref'd (the daemon keeps the loop alive)
  try { await assert.rejects(hung.get(), (e) => e.code === 'credential_store_timeout'); } finally { clearInterval(keepAlive); }
  const broken = strictStore('file', () => ({ setPassword: async () => { throw new Error(`boom ${KEY}`); }, getPassword: async () => undefined, deletePassword: async () => true }));
  await assert.rejects(broken.set(KEY), (e) => e.code === 'credential_store_failed' && !e.message.includes(KEY));
  assert.equal((await openOpenAITunnelCredential(undefined)).kind, 'unavailable', 'no data dir, no store');
  const blocker = path.join(mkdtempSync(path.join(tmpdir(), 'bh-oa-')), 'not-a-dir');
  writeFileSync(blocker, 'x');
  assert.equal((await openOpenAITunnelCredential(undefined, path.join(blocker, 'secrets', 'openai-tunnel.json'))).kind, 'unavailable', 'unwritable dir');
  rmSync(path.dirname(blocker), { recursive: true, force: true });
  assert.equal((await openOpenAITunnelCredential('memory')).kind, 'memory');
});

test('file credential store: survives a restart, sealed on Windows, delete removes the file', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bh-oa-file-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = openAITunnelSecretFile(dir);
  const a = await openOpenAITunnelCredential(undefined, file);
  assert.equal(a.kind, 'file');
  assert.equal(await a.has(), false);
  await a.set(KEY);
  assert.ok(!readFileSync(file, 'utf8').includes(KEY) || process.platform !== 'win32', 'Windows seals the key with DPAPI');
  const b = await openOpenAITunnelCredential(undefined, file); // a restarted daemon
  assert.equal(await b.get(), KEY);
  assert.equal(await b.remove(), 'deleted');
  assert.equal(existsSync(file), false, 'nothing left on disk');
  assert.equal(await a.has(), false);
});

// ---- control routes ------------------------------------------------------

function request(port, method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: data, json: (() => { try { return JSON.parse(data); } catch { return null; } })() }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

test('control routes: native loopback only, strict JSON, fixed codes, key never echoed', async (t) => {
  const s = setup(); t.after(s.done);
  const logs = [];
  const deps = { openaiTunnel: s.m, log: (l) => logs.push(l), lastHeartbeatAt: 0 };
  const app = express();
  const api = express.Router();
  mountOpenAITunnel(api, deps, 'daemon-1');
  api.use(express.json());
  api.use((req, res) => res.status(418).json({ error: 'fell_through' }));
  app.use('/api', api);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = server.address().port;
  const json = (o) => { const body = JSON.stringify(o); return { headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, body }; };

  const status = await request(port, 'GET', '/api/openai-tunnel');
  assert.equal(status.status, 200); assert.equal(status.json.status, 'off');
  assert.equal(status.headers['cache-control'], 'no-store');
  for (const h of [{ origin: 'http://127.0.0.1:1' }, { 'sec-fetch-site': 'same-origin' }, { 'x-forwarded-for': '1.2.3.4' }, { cookie: 'a=b' }, { host: 'evil.example:80' }]) {
    const r = await request(port, 'GET', '/api/openai-tunnel', { headers: h });
    assert.equal(r.status, 403, JSON.stringify(h)); assert.equal(r.json.error, 'native_loopback_required');
  }
  assert.equal((await request(port, 'PUT', '/api/openai-tunnel/credential', { headers: { 'content-type': 'text/plain' }, body: KEY })).status, 415);
  const big = await request(port, 'PUT', '/api/openai-tunnel/credential', json({ daemon_id: 'daemon-1', credential_revision: 1, api_key: 'x'.repeat(20_000) }));
  assert.equal(big.status, 413); assert.equal(big.json.error, 'body_too_large');
  const bad = await request(port, 'PUT', '/api/openai-tunnel/credential', { headers: { 'content-type': 'application/json' }, body: `{"api_key":"${KEY}"` });
  assert.equal(bad.status, 400); assert.equal(bad.json.error, 'invalid_json'); assert.ok(!bad.text.includes(KEY));
  const other = await request(port, 'PUT', '/api/openai-tunnel/credential', json({ daemon_id: 'daemon-0', credential_revision: s.m.credentialRevision, api_key: KEY }));
  assert.equal(other.status, 409); assert.equal(other.json.error, 'daemon_changed');
  const weak = await request(port, 'PUT', '/api/openai-tunnel/credential', json({ daemon_id: 'daemon-1', credential_revision: s.m.credentialRevision, api_key: 'has space inside' }));
  assert.equal(weak.status, 400); assert.equal(weak.json.error, 'invalid_api_key');
  const saved = await request(port, 'PUT', '/api/openai-tunnel/credential', json({ daemon_id: 'daemon-1', credential_revision: s.m.credentialRevision, api_key: ` ${KEY} ` }));
  assert.equal(saved.status, 200); assert.equal(saved.json.credential_configured, true); assert.ok(!saved.text.includes(KEY));
  assert.equal(await s.credential.get(), KEY, 'trimmed key stored');
  const started = await request(port, 'POST', '/api/openai-tunnel/start', json({ daemon_id: 'daemon-1', settings_revision: 3, credential_revision: s.m.credentialRevision }));
  assert.equal(started.status, 200); assert.ok(started.json.run_id);
  assert.ok(deps.lastHeartbeatAt > 0, 'explicit start feeds the watchdog');
  await until(() => s.m.status === 'ready');
  const diag = await request(port, 'GET', '/api/openai-tunnel/diagnostics');
  assert.equal(diag.status, 200); assert.ok(!diag.text.includes(KEY));
  const stale = await request(port, 'POST', '/api/openai-tunnel/stop', json({ daemon_id: 'daemon-1', run_id: 'old' }));
  assert.equal(stale.status, 409); assert.equal(stale.json.error, 'run_changed'); assert.equal(stale.json.openai_tunnel.status, 'ready');
  const stopped = await request(port, 'POST', '/api/openai-tunnel/stop', json({ daemon_id: 'daemon-1', run_id: started.json.run_id }));
  assert.equal(stopped.json.status, 'off');
  const cleared = await request(port, 'DELETE', '/api/openai-tunnel/credential', json({ daemon_id: 'daemon-1', credential_revision: s.m.credentialRevision }));
  assert.equal(cleared.status, 200); assert.equal(cleared.json.credential_configured, false);
  assert.equal((await request(port, 'GET', '/api/openai-tunnel/nope')).json.error, 'not_found', 'never falls through to other routes');
  assert.ok(!logs.join('\n').includes(KEY));
});

test('native loopback predicate', () => {
  const req = (host, extra = {}, addr = '127.0.0.1') => ({ headers: { host, ...extra }, socket: { remoteAddress: addr } });
  assert.equal(nativeLoopbackRequest(req('127.0.0.1:7777')), true);
  assert.equal(nativeLoopbackRequest(req('localhost:7777', {}, '::1')), true);
  assert.equal(nativeLoopbackRequest(req('127.0.0.1:7777', { 'sec-fetch-mode': 'cors' })), true, 'Node fetch sends sec-fetch-mode');
  assert.equal(nativeLoopbackRequest(req('127.0.0.1.evil.com')), false);
  assert.equal(nativeLoopbackRequest(req('127.0.0.1:7777', {}, '10.0.0.2')), false);
  assert.equal(nativeLoopbackRequest(req('127.0.0.1:7777', { 'cf-connecting-ip': '1.1.1.1' })), false);
});

