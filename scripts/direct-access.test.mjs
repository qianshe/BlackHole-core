import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { DirectAccessListener, directAccessAllowed, directAddresses } from '../dist/direct-access/listener.js';
import { DirectAccessViewSchema } from '../packages/contracts/dist/connections.js';
import { createIsolatedEnv, freeLoopbackPort } from './fixtures/isolated-env.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function request(port, path, { host = `127.0.0.1:${port}`, method = 'GET', body, headers = {}, address = '127.0.0.1', agent = false } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ hostname: address, port, path, method, agent, headers: { host, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      let text = '';
      res.setEncoding('utf8'); res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, text, json }); });
    });
    req.setTimeout(5000, () => req.destroy(new Error('request timeout')));
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
const config = (port, extra = {}) => ({ enabled: true, port, advertisedUrl: '', proxyOrigin: '', ...extra });

if (process.argv.includes('--fixture-daemon')) {
  const { startDaemon } = await import('../dist/daemon.js');
  const daemon = await startDaemon({ port: Number(process.env.BLACKHOLE_PORT), dbPath: process.env.BLACKHOLE_DB, tunnel: 'off' }, () => {});
  process.on('message', (message) => { if (message === 'stop') void daemon.stop().then(() => process.exit(0), () => process.exit(1)); });
  process.send({ ready: true });
} else {
  test('complete direct data plane, no management paths or encoded routing escape', () => {
    for (const url of ['/', '/probe', '/bh.md', '/bh.py?sessionid=x', '/mcp/token', '/panel/key/', '/panel/key/data', '/remote-api/v1/session', '/ui/assets/app.js']) assert.equal(directAccessAllowed(url), true, url);
    for (const url of [undefined, '/api/health', '/api/settings', '/web-api/v1/sessions', '/api/courier', '/courier', '/openai-tunnel', '//other/mcp/tok', 'http://other/mcp/tok', '/ui/../api/health', '/ui/%2e%2e/api/health', '/mcp/token%2f..%2fapi', '/ui\\..\\api', '/bh.md#x']) assert.equal(directAccessAllowed(url), false, String(url));
  });

  test('interface discovery is deduplicated IPv4, excluding loopback and link-local', () => {
    assert.deepEqual(directAddresses({ lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }], eth: [{ family: 'IPv4', internal: false, address: '192.168.1.2' }, { family: 'IPv4', internal: false, address: '169.254.2.1' }], mesh: [{ family: 'IPv4', internal: false, address: '100.64.1.2' }, { family: 'IPv4', internal: false, address: '192.168.1.2' }] }), ['192.168.1.2', '100.64.1.2']);
  });

  test('one listener opens without a URL, validates Host/Origin, strips proxy identity and closes', async (t) => {
    const port = await freeLoopbackPort(); const seen = [];
    let listener;
    listener = new DirectAccessListener((req, res) => {
      seen.push(req.url);
      res.end(JSON.stringify({ origin: listener.requestOrigin(req), headers: req.headers }));
    }, port + 1, () => {}, () => ['192.168.1.2']);
    t.after(() => listener.close());
    assert.equal(listener.view().state, 'off');
    const applying = listener.apply(config(port));
    assert.equal(listener.view().state, 'applying');
    assert.equal(listener.view().listening, false);
    await applying;
    const view = DirectAccessViewSchema.parse(listener.view());
    assert.deepEqual([view.state, view.enabled, view.mode, view.port, view.bind_host], ['listening', true, 'direct', port, '0.0.0.0']);
    assert.equal(view.target, `http://127.0.0.1:${port}`, 'the proxy target is a usable loopback URL, not 0.0.0.0');
    for (const path of ['/api/health', '/web-api/v1/sessions', '/api/courier']) assert.equal((await request(port, path)).status, 404);
    assert.equal(seen.length, 0);
    assert.equal((await request(port, '/bh.md', { host: 'foreign.example.test' })).status, 421, 'arbitrary DNS aliases are not an authorized origin');
    assert.equal((await request(port, '/mcp/token', { headers: { origin: 'https://foreign.example.test' } })).status, 403);
    const r = await request(port, '/probe', { host: `203.0.113.12:49152`, headers: { 'cf-ray': 'fake', 'x-real-ip': '1.2.3.4', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'foreign.example.test', 'x-blackhole-public-gateway': '1' } });
    assert.equal(r.status, 200);
    assert.equal(r.json.origin, 'http://203.0.113.12:49152', 'a NAT port need not equal the listening port');
    for (const key of ['cf-ray', 'x-real-ip', 'x-forwarded-proto', 'x-forwarded-host', 'x-blackhole-public-gateway']) assert.equal(r.json.headers[key], undefined, key);
    assert.equal(listener.requestOrigin({ headers: { 'x-blackhole-direct-access': '1' } }), null, 'a forged marker is never trusted');
    await listener.apply(config(port, { enabled: false }));
    assert.equal(listener.view().state, 'off');
    await assert.rejects(request(port, '/probe'), (e) => e.code === 'ECONNREFUSED');
  });

  test('advertised HTTPS and raw IP coexist; URL edits stay hot; stale aliases are rejected', async (t) => {
    const port = await freeLoopbackPort();
    let listener;
    listener = new DirectAccessListener((req, res) => res.end(JSON.stringify({ origin: listener.requestOrigin(req), peer: req.socket.remotePort })), port + 1);
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    t.after(async () => { agent.destroy(); await listener.close(); });
    await listener.apply(config(port, { advertisedUrl: 'https://first.example.test' }));
    const first = await request(port, '/probe', { agent });
    assert.equal((await request(port, '/bh.md', { host: 'first.example.test' })).json.origin, 'https://first.example.test');
    await listener.apply(config(port, { advertisedUrl: 'https://next.example.test' }));
    const second = await request(port, '/probe', { agent });
    assert.equal(first.json.peer, second.json.peer, 'changing only an advertised URL does not kill an existing socket');
    assert.equal((await request(port, '/probe', { host: 'first.example.test' })).status, 421);
    assert.equal((await request(port, '/probe', { host: 'next.example.test' })).json.origin, 'https://next.example.test');
    assert.equal(listener.view().port, port);
    assert.equal(listener.view().mode, 'direct');
  });

  test('reverse proxy and direct access reuse one stable port; rapid updates settle on the last intent', async (t) => {
    const port = await freeLoopbackPort();
    const listener = new DirectAccessListener((_req, res) => res.end('ok'), port + 1);
    t.after(() => listener.close());
    const proxy = config(port, { enabled: false, proxyOrigin: 'https://proxy.example.test' });
    await listener.apply(proxy);
    assert.equal(listener.view().mode, 'proxy');
    assert.equal(listener.view().bind_host, '127.0.0.1');
    assert.equal((await request(port, '/probe')).status, 421);
    assert.equal((await request(port, '/probe', { host: 'proxy.example.test' })).status, 200);
    await listener.apply({ ...proxy, enabled: true });
    assert.equal(listener.view().port, port);
    assert.equal(listener.view().bind_host, '0.0.0.0');
    await Promise.all([listener.apply(proxy), listener.apply(config(port)), listener.apply(config(port, { enabled: false }))]);
    assert.equal(listener.view().state, 'off');
    await assert.rejects(request(port, '/probe'), (e) => e.code === 'ECONNREFUSED');
  });

  test('port conflicts and main-port collisions are reported, not silently replaced', async (t) => {
    const port = await freeLoopbackPort(); const main = await freeLoopbackPort();
    const blocker = net.createServer();
    await new Promise((resolve) => blocker.listen(port, '0.0.0.0', resolve));
    const listener = new DirectAccessListener((_req, res) => res.end('ok'), main);
    t.after(async () => { await listener.close(); await new Promise((resolve) => blocker.close(resolve)); });
    await listener.apply(config(port));
    assert.equal(listener.view().state, 'error');
    assert.match(listener.view().error, /占用/);
    assert.equal(listener.localPort(), null);
    await listener.apply(config(main));
    assert.equal(listener.view().state, 'error');
    assert.match(listener.view().error, /主端口/);
  });

  test('isolated daemon: expanded direct surface, correct manual/client origins, authenticated MCP, no control API', { timeout: 60_000 }, async (t) => {
    const iso = await createIsolatedEnv({ name: 'direct-access' });
    const port = await freeLoopbackPort();
    const child = fork(fileURLToPath(import.meta.url), ['--fixture-daemon'], { env: iso.env, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const exited = new Promise((resolve) => child.once('exit', resolve));
    let client;
    t.after(async () => {
      await client?.close().catch(() => {});
      if (child.connected) child.send('stop');
      let timer; await Promise.race([exited, new Promise((resolve) => { timer = setTimeout(() => { child.kill(); resolve(); }, 4000); })]);
      clearTimeout(timer); iso.cleanup();
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('isolated daemon startup timeout')), 15_000);
      child.once('exit', (code) => { clearTimeout(timer); reject(Error(`daemon exited before ready: ${code}`)); });
      child.once('message', (m) => { clearTimeout(timer); m.ready ? resolve() : reject(Error('unexpected message')); });
    });
    const api = (path, method = 'GET', body) => request(iso.port, '/api' + path, { method, body });
    const wait = async (predicate) => {
      for (let i = 0; i < 100; i++) { const h = (await api('/health')).json; if (predicate(h)) return h; await sleep(25); }
      assert.fail('direct listener did not reach the requested state');
    };
    const initial = (await api('/health')).json;
    assert.equal(initial.direct_access.state, 'off');
    assert.equal(initial.lan_access, undefined); assert.equal(initial.public_gateway, undefined);
    assert.equal((await api('/settings', 'PATCH', { values: { directAccessEnabled: true, directPort: port } })).status, 200);
    const h = await wait((h) => h.direct_access.state === 'listening' && h.direct_access.port === port);
    const view = DirectAccessViewSchema.parse(h.direct_access);
    const address = view.addresses[0] ?? '127.0.0.1';
    const origin = `http://${address}:${port}`;
    const mcpPath = new URL(h.mcp_url).pathname;
    for (const path of ['/api/health', '/api/settings', '/api/sessions', '/web-api/v1/sessions', '/api/courier/ping']) assert.equal((await request(port, path, { address, host: `${address}:${port}` })).status, 404, path);
    for (const path of ['/bh.md', '/bh.py']) {
      const r = await request(port, path, { address, host: `${address}:${port}` });
      assert.equal(r.status, 200, path);
      assert.ok(r.text.includes(origin + mcpPath), `${path} must embed the address actually used, not the control port or another channel`);
    }
    const bad = await request(port, '/mcp/not-the-token', { method: 'POST', body: {}, headers: { accept: 'application/json, text/event-stream' } });
    assert.equal(bad.status, 404, 'the machine MCP credential is still required');
    client = new Client({ name: 'direct-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(origin + mcpPath)));
    assert.ok((await client.listTools()).tools.some((x) => x.name === 'exec'));
    await client.close(); client = undefined;
    assert.equal((await api('/settings', 'PATCH', { values: { directAccessUrl: 'https://direct.example.test' } })).status, 200);
    const configured = await wait((h) => h.direct_access.state === 'listening' && h.connection_routes.preferred_mcp_url === 'https://direct.example.test' + mcpPath);
    assert.equal(configured.connection_routes.sandbox_mcp_url, 'https://direct.example.test' + mcpPath);
    const manual = await request(port, '/bh.md', { host: 'direct.example.test' });
    assert.equal(manual.status, 200); assert.ok(manual.text.includes('https://direct.example.test' + mcpPath));
    assert.equal((await api('/settings', 'PATCH', { values: { directAccessEnabled: false } })).status, 200);
    await wait((h) => h.direct_access.state === 'off');
    await assert.rejects(request(port, '/probe'), (e) => e.code === 'ECONNREFUSED');
  });
}
