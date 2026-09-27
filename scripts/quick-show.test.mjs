import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { registerTools } from '../dist/mcp/tools.js';
import { mountMcp } from '../dist/mcp/router.js';
import { setAccessTokenOverride } from '../dist/util/token.js';
import { PANEL_RESOURCE_URI, RESOURCE_MIME_TYPE } from '../dist/panel/appHtml.js';

const appsCapabilities = { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: [RESOURCE_MIME_TYPE] } } };
const sid = '123456789012345678901234567890123456789';

async function fixture(t, capabilities = appsCapabilities) {
  const server = new McpServer({ name: 'show-fixture', version: '1' });
  const client = new Client({ name: 'show-fixture-client', version: '1' }, { capabilities });
  let mounts = 0, resolved = 0;
  registerTools(server, () => {
    resolved++;
    return { session: { id: 'fixture-workspace' } };
  }, {
    cfg: {}, events: { append() {} },
    toolCalls: { maxSeqForSession: () => 7 }, panelBase: () => 'https://fixed.example.test',
    panels: { mountFresh: () => { mounts++; return 'fixture-panel'; }, startSeqFor: () => 7, appTokenFor: () => 'fixture-token' },
  }, { execDescription: 'Fixture only; never execute shell commands.' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport); await client.connect(clientTransport);
  return { server, client, get mounts() { return mounts; }, get resolved() { return resolved; } };
}

test('Apps clients discover show as a presentation-only panel action', async t => {
  const f = await fixture(t);
  const show = (await f.client.listTools()).tools.find(tool => tool.name === 'show');
  assert.ok(show);
  assert.match(show.description, /presentation-only/i);
  assert.match(show.description, /does not read or modify workspace files, run commands, or approve actions/i);
  assert.match(show.description, /at most once after each new user message/i);
  assert.doesNotMatch(show.description, /before other work tools/i);

  const guide = await f.client.callTool({ name: 'guide', arguments: {} });
  assert.match(guide.structuredContent.manual, /When a live progress view would help, call `show` at most once/);
  assert.match(guide.structuredContent.manual, /only opens BlackHole's progress panel/);
  assert.match(guide.structuredContent.manual, /does not read or modify workspace files, run commands, or approve actions/);

  const result = await f.client.callTool({ name: 'show', arguments: { sessionId: sid } });
  assert.equal(result.structuredContent.status, 'mounted');
  assert.equal(result.structuredContent.panel_base, 'https://fixed.example.test');
  assert.ok(result._meta?.ui?.resourceUri);
  assert.equal(f.mounts, 1); assert.equal(f.resolved, 1);
});

test('clients without MCP Apps support still do not discover or mount show', async t => {
  const f = await fixture(t, {});
  assert.equal((await f.client.listTools()).tools.some(tool => tool.name === 'show'), false);
  const guide = await f.client.callTool({ name: 'guide', arguments: {} });
  assert.doesNotMatch(guide.structuredContent.manual, /\bshow\b/i);
  const stale = await f.server._registeredTools.show.handler({ sessionId: sid }, {});
  assert.equal(stale.isError, true); assert.equal(stale._meta, undefined);
  assert.equal(f.mounts, 0); assert.equal(f.resolved, 0);
});

test('quick, fixed and local ingress all keep show for Apps clients with the correct panel origin', async t => {
  const app = express(); app.use(express.json());
  const http = createServer(app), clients = [];
  const tunnel = { mode: 'quick', status: 'online', url: 'https://fixture.trycloudflare.com' };
  const row = { id: 'fixture-row', status: 'active', expires_at: null };
  const runtime = { session: row };
  let mounts = 0;
  setAccessTokenOverride('quick-show-fixture');
  const cleaner = mountMcp(app, {
    cfg: { host: '127.0.0.1', port: 7306, publicBaseUrl: 'https://fixed.example.test' },
    tunnel, log() {}, runtimes: new Map([[row.id, runtime]]),
    sessions: { byCredential: value => value === sid ? row : undefined, get: () => row, touch() {} },
    events: { append() {} }, toolCalls: { maxSeqForSession: () => 11 },
    execution: { exec: { state: 'cwd-only', shell: { syntax: 'bash', executable: 'bash', version: 'fixture' }, helpers: { rg: false, grep: false } }, process: { available: false } },
    panels: {
      mountFresh: () => { mounts++; return `fixture-panel-${mounts}`; },
      startSeqFor: () => 11,
      appTokenFor: () => 'fixture-token',
    },
  });
  t.after(async () => {
    for (const client of clients) await client.close().catch(() => {});
    await cleaner.closeAll(); http.closeAllConnections();
    if (http.listening) await new Promise(resolve => http.close(resolve));
    setAccessTokenOverride(undefined);
  });
  await new Promise((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve); });
  const endpoint = new URL(`http://127.0.0.1:${http.address().port}/mcp/quick-show-fixture`);
  const connect = async (headers = {}, capabilities = appsCapabilities) => {
    const client = new Client({ name: 'apps-channel-fixture', version: '1' }, { capabilities });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(endpoint, { requestInit: { headers } }));
    return client;
  };

  const local = await connect();
  assert.ok(local.getServerCapabilities().extensions?.['io.modelcontextprotocol/ui']);
  assert.ok((await local.listTools()).tools.some(tool => tool.name === 'show'));
  const localResource = await local.readResource({ uri: PANEL_RESOURCE_URI });
  assert.deepEqual(localResource.contents[0]._meta.ui.csp.connectDomains, [endpoint.origin]);
  assert.equal(localResource.contents[0]._meta.ui.domain, undefined);
  assert.equal(localResource.contents[0]._meta['openai/widgetDomain'], undefined);

  const quick = await connect({ 'x-forwarded-host': 'fixture.trycloudflare.com', 'cf-ray': 'fixture-ray' });
  assert.ok(quick.getServerCapabilities().extensions?.['io.modelcontextprotocol/ui']);
  assert.ok((await quick.listTools()).tools.some(tool => tool.name === 'show'));
  const quickResource = await quick.readResource({ uri: PANEL_RESOURCE_URI });
  assert.deepEqual(quickResource.contents[0]._meta.ui.csp.connectDomains, ['https://fixture.trycloudflare.com']);
  assert.equal(quickResource.contents[0]._meta.ui.domain, undefined);
  assert.equal(quickResource.contents[0]._meta['openai/widgetDomain'], undefined);
  const quickGuide = (await quick.callTool({ name: 'guide', arguments: {} })).structuredContent.manual;
  assert.match(quickGuide, /only opens BlackHole's progress panel/);
  assert.doesNotMatch(quickGuide, /quick tunnel/i);
  const quickShow = await quick.callTool({ name: 'show', arguments: { sessionId: sid } });
  assert.equal(quickShow.structuredContent.status, 'mounted');
  assert.equal(quickShow.structuredContent.panel_base, 'https://fixture.trycloudflare.com');

  const fixed = await connect({ 'x-forwarded-host': 'fixed.example.test', 'cf-ray': 'fixture-ray-fixed' });

  const rewrittenQuick = await connect({ 'cf-ray': 'fixture-ray-rewritten-host' });
  assert.ok((await rewrittenQuick.listTools()).tools.some(tool => tool.name === 'show'));
  const rewrittenResource = await rewrittenQuick.readResource({ uri: PANEL_RESOURCE_URI });
  assert.deepEqual(rewrittenResource.contents[0]._meta.ui.csp.connectDomains, ['https://fixture.trycloudflare.com'], 'Cloudflare requests with a rewritten local Host must still poll the active tunnel origin');
  assert.ok((await fixed.listTools()).tools.some(tool => tool.name === 'show'));
  const fixedResource = await fixed.readResource({ uri: PANEL_RESOURCE_URI });
  assert.deepEqual(fixedResource.contents[0]._meta.ui.csp.connectDomains, ['https://fixed.example.test']);
  assert.equal(fixedResource.contents[0]._meta.ui.domain, 'https://fixed.example.test');
  assert.equal(fixedResource.contents[0]._meta['openai/widgetDomain'], 'https://fixed.example.test');

  const quickWithoutApps = await connect({ 'x-forwarded-host': 'fixture.trycloudflare.com', 'cf-ray': 'fixture-ray-script' }, {});
  assert.equal((await quickWithoutApps.listTools()).tools.some(tool => tool.name === 'show'), false, 'client capability, not channel type, controls show discovery');
  assert.equal(mounts, 1);
});
