// 局域网直连：开关默认关闭；打开后另起 0.0.0.0 监听器，只开放 MCP（bh.py 也不开放），控制接口和本地 Web 从外部不可达。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import net from 'node:net';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createIsolatedEnv } from './fixtures/isolated-env.mjs';
import { LanListener, lanAllowed, lanAddresses } from '../dist/lan/listener.js';

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

function request(port, method, p, { host = '127.0.0.1', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      host, port, method, path: p, agent: false, // 每次新连接：复用的 keep-alive 套接字会把「端口已关」变成连接重置
      headers: { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const refused = (port, host = '127.0.0.1') => request(port, 'GET', '/', { host }).then(() => false, (e) => e.code === 'ECONNREFUSED');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.argv.includes('--fixture-daemon')) {
  const { startDaemon } = await import('../dist/daemon.js');
  const daemon = await startDaemon({ port: Number(process.env.BLACKHOLE_PORT), dbPath: process.env.BLACKHOLE_DB, tunnel: 'off' }, () => {});
  process.on('message', (message) => {
    if (message === 'stop') void daemon.stop().then(() => process.exit(0), () => process.exit(1));
  });
  process.send({ ready: true });
} else {
  test('lanAllowed: only MCP endpoints pass the LAN listener', () => {
    for (const u of ['/mcp/abc', '/mcp/abc?x=1']) assert.equal(lanAllowed(u), true, u);
    for (const u of ['/bh.py', '/bh.py?sessionid=1', '/', '/api/health', '/api/settings', '/mcp', '/mcp/', '/mcp/a/b', '/web-api/v1/courier', '/panel/x', '/probe', '/bh.pyx', '/api/courier/ping', '/MCP/abc', undefined]) {
      assert.equal(lanAllowed(u), false, String(u));
    }
  });

  test('lanAddresses: external IPv4 addresses only, no duplicates', () => {
    const ifaces = {
      lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
      eth: [{ family: 'IPv4', internal: false, address: '192.168.1.5' }, { family: 'IPv6', internal: false, address: 'fe80::1' }, { family: 'IPv4', internal: false, address: '169.254.3.3' }],
      wg: [{ family: 'IPv4', internal: false, address: '192.168.1.5' }, { family: 'IPv4', internal: false, address: '100.64.0.7' }],
    };
    assert.deepEqual(lanAddresses(ifaces), ['192.168.1.5', '100.64.0.7']);
  });

  test('LanListener: off by default, forwards allowed paths only, toggles live, reports port errors', async (t) => {
    const hits = [];
    const app = (req, res) => { hits.push(req.url); res.end('app'); };
    const main = await freePort();
    const port = await freePort();
    const lan = new LanListener(app, main, () => {}, '127.0.0.1');
    t.after(() => lan.close());
    assert.equal(lan.view().listening, false);
    assert.equal(await refused(port), true);

    await lan.apply(true, port);
    assert.equal(lan.view().listening, true);
    assert.equal(lan.localPort(), port);
    assert.equal((await request(port, 'POST', '/mcp/tok')).text, 'app');
    const blocked = await request(port, 'GET', '/api/health');
    assert.deepEqual([blocked.status, blocked.text], [404, 'not found']);
    assert.deepEqual(hits, ['/mcp/tok'], 'the blocked path never reached the app');

    await lan.apply(false, port);
    assert.equal(lan.view().listening, false);
    assert.equal(await refused(port), true, 'switch off closes the port');

    await lan.apply(true, main);
    assert.equal(lan.view().listening, false);
    assert.match(lan.view().error, /主端口/);

    const blocker = net.createServer();
    await new Promise((r) => blocker.listen(port, '127.0.0.1', r));
    t.after(() => new Promise((r) => blocker.close(r)));
    await lan.apply(true, port);
    assert.equal(lan.view().listening, false);
    assert.match(lan.view().error, /占用/);
  });

  test('daemon: the switch exposes MCP on the LAN port only; control API and local Web stay local', { timeout: 60_000 }, async (t) => {
    const iso = await createIsolatedEnv({ name: 'lan-access' });
    const child = fork(fileURLToPath(import.meta.url), ['--fixture-daemon'], { env: iso.env, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
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

    const main = Number(iso.env.BLACKHOLE_PORT);
    const api = (method, p, body) => request(main, method, '/api' + p, { body });
    const health = async () => JSON.parse((await api('GET', '/health')).text).lan_access;
    const waitFor = async (ok) => { let v = await health(); for (let i = 0; i < 50 && !ok(v); i++) { await sleep(100); v = await health(); } return v; };

    let lan = await health();
    assert.deepEqual([lan.enabled, lan.listening], [false, false], 'off by default');

    const lanPort = await freePort();
    const on = await api('PATCH', '/settings', { values: { lanAccess: true, lanPort } });
    assert.equal(on.status, 200, on.text);
    lan = await waitFor((v) => v.listening);
    assert.equal(lan.listening, true, 'applied live, no restart: ' + JSON.stringify(lan));
    assert.equal(lan.port, lanPort);

    // 用本机的局域网地址连接：对守护进程来说来源不是回环，和另一台服务器连进来一样（没有就退回 127.0.0.1）
    const host = lan.addresses[0] ?? '127.0.0.1';
    for (const p of ['/api/health', '/api/settings', '/api/sessions', '/web-api/v1/courier', '/', '/panel/x', '/api/courier/ping', '/probe', '/bh.py']) {
      const r = await request(lanPort, 'GET', p, { host });
      assert.deepEqual([r.status, r.text], [404, 'not found'], p);
    }

    const wrong = await request(lanPort, 'POST', '/mcp/not-the-token', { host, body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, headers: { accept: 'application/json, text/event-stream' } });
    assert.equal(wrong.status, 404, 'the machine token is still required');
    assert.notEqual(wrong.text, 'not found', 'rejected by the MCP route, not the LAN filter');

    client = new Client({ name: 'lan-test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://${host}:${lanPort}${lan.mcp_path}`)));
    const tools = await client.listTools();
    assert.ok(tools.tools.some((x) => x.name === 'exec'), 'MCP works over the LAN address: ' + tools.tools.map((x) => x.name).join(','));
    await client.close();
    client = undefined;

    await api('PATCH', '/settings', { values: { lanPort: main } });
    lan = await waitFor((v) => !v.listening);
    assert.equal(lan.listening, false);
    assert.match(lan.error ?? '', /主端口/);

    await api('PATCH', '/settings', { values: { lanAccess: false, lanPort } });
    lan = await waitFor((v) => !v.enabled);
    assert.deepEqual([lan.enabled, lan.listening], [false, false]);
    assert.equal(await refused(lanPort, host), true, 'switch off closes the LAN port');
  });
}
