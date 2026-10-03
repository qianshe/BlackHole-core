// 局域网直连的域名访问（用户 2026-10-03）：直连域名设置的校验，以及经直连端口进来的请求生成的面板地址
// （配置的域名优先，其次按 X-Forwarded-Proto，默认 http）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mountMcp } from '../dist/mcp/router.js';
import { setAccessTokenOverride } from '../dist/util/token.js';
import { PANEL_RESOURCE_URI, RESOURCE_MIME_TYPE } from '../dist/panel/appHtml.js';
import { normalizeSettingsPatch, DEFAULT_SETTINGS, DAEMON_ONLY_KEYS } from '../dist/settings/store.js';

const appsCapabilities = { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: [RESOURCE_MIME_TYPE] } } };
const sid = '123456789012345678901234567890123456789';

test('lanUrl 只接受 http(s)://主机[:端口]，默认为空，由守护进程持有', () => {
  assert.equal(DEFAULT_SETTINGS.lanUrl, '');
  assert.ok(DAEMON_ONLY_KEYS.includes('lanUrl'));
  const ok = (v) => normalizeSettingsPatch({ lanUrl: v }).values?.lanUrl;
  assert.equal(ok(''), '');
  assert.equal(ok('https://mcp.example.com/'), 'https://mcp.example.com');
  assert.equal(ok('http://nas.lan:7307'), 'http://nas.lan:7307');
  assert.equal(ok('HTTPS://MCP.Example.com:443'), 'https://mcp.example.com', '规范化为 origin');
  for (const bad of ['mcp.example.com', 'ftp://x.example', 'https://x.example/mcp/abc', 'https://u:p@x.example', 'https://x.example/?a=1']) {
    assert.match(normalizeSettingsPatch({ lanUrl: bad }).error ?? '', /lanUrl/, bad);
  }
});

test('经直连端口的请求：配置的域名优先（含 https），其次按 X-Forwarded-Proto，默认 http', async (t) => {
  const app = express(); app.use(express.json());
  const http = createServer(app), clients = [];
  const row = { id: 'fixture-row', status: 'active', expires_at: null };
  let port = 0;
  setAccessTokenOverride('lan-domain-fixture');
  const cleaner = mountMcp(app, {
    cfg: { host: '127.0.0.1', port: 7306 },
    tunnel: { status: 'off' }, log() {}, runtimes: new Map([[row.id, { session: row }]]),
    sessions: { byCredential: (v) => (v === sid ? row : undefined), get: () => row, touch() {} },
    events: { append() {} }, toolCalls: { maxSeqForSession: () => 0 },
    execution: { exec: { state: 'cwd-only', shell: { syntax: 'bash', executable: 'bash', version: 'fixture' }, helpers: { rg: false, grep: false } }, process: { available: false } },
    panels: { mountFresh: () => 'fixture-panel', startSeqFor: () => 0, appTokenFor: () => 'fixture-token' },
    // 测试服务器本身充当直连端口：请求的本地端口等于 localPort()。
    lan: { localPort: () => port },
    settings: { get: () => ({ values: { lanUrl: 'https://mcp.example.test' } }) },
  });
  t.after(async () => {
    for (const c of clients) await c.close().catch(() => {});
    await cleaner.closeAll(); http.closeAllConnections();
    if (http.listening) await new Promise((r) => http.close(r));
    setAccessTokenOverride(undefined);
  });
  await new Promise((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve); });
  port = http.address().port;
  const endpoint = new URL(`http://127.0.0.1:${port}/mcp/lan-domain-fixture`);
  const panelOrigin = async (headers) => {
    const client = new Client({ name: 'lan-domain', version: '1' }, { capabilities: appsCapabilities });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(endpoint, { requestInit: { headers } }));
    return (await client.readResource({ uri: PANEL_RESOURCE_URI })).contents[0]._meta.ui.csp.connectDomains;
  };
  // 反向代理没传协议头，但访问的正是配置的域名：用配置里的 https。
  assert.deepEqual(await panelOrigin({ 'x-forwarded-host': 'mcp.example.test' }), ['https://mcp.example.test']);
  // 其他域名：按反向代理传来的协议。
  assert.deepEqual(await panelOrigin({ 'x-forwarded-host': 'other.example.test', 'x-forwarded-proto': 'https' }), ['https://other.example.test']);
  // 没有协议头：默认 http（局域网直连本身是明文）；不认识的协议值也当 http。
  assert.deepEqual(await panelOrigin({ 'x-forwarded-host': 'nas.lan:7307' }), ['http://nas.lan:7307']);
  assert.deepEqual(await panelOrigin({ 'x-forwarded-host': 'nas.lan:7307', 'x-forwarded-proto': 'javascript' }), ['http://nas.lan:7307']);
});
