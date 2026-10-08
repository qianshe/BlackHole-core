// Prove the real MCP presentation path through the real direct listener.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { mountMcp } from '../dist/mcp/router.js';
import { setAccessTokenOverride } from '../dist/util/token.js';
import { PANEL_RESOURCE_URI, RESOURCE_MIME_TYPE } from '../dist/panel/appHtml.js';
import { DEFAULT_SETTINGS } from '../dist/settings/store.js';
import { DirectAccessListener, directAccessConfig } from '../dist/direct-access/listener.js';
import { freeLoopbackPort } from './fixtures/isolated-env.mjs';

const appsCapabilities = { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: [RESOURCE_MIME_TYPE] } } };
const sid = '123456789012345678901234567890123456789';

test('MCP panel origin comes from direct ingress, not spoofed forwarding headers or the control port', async (t) => {
  const app = express(); app.use(express.json());
  const port = await freeLoopbackPort();
  const mainPort = await freeLoopbackPort();
  const directAccess = new DirectAccessListener(app, mainPort);
  const row = { id: 'fixture-row', status: 'active', expires_at: null };
  const values = { ...DEFAULT_SETTINGS, directAccessEnabled: true, directPort: port, directAccessUrl: 'https://mcp.example.test' };
  setAccessTokenOverride('direct-panel-fixture');
  const cleaner = mountMcp(app, {
    cfg: { host: '127.0.0.1', port: mainPort },
    tunnel: { status: 'off' }, log() {}, runtimes: new Map([[row.id, { session: row }]]),
    sessions: { byCredential: (v) => v === sid ? row : undefined, get: () => row, touch() {} },
    events: { append() {} }, toolCalls: { maxSeqForSession: () => 0 },
    execution: { exec: { state: 'cwd-only', shell: { syntax: 'bash', executable: 'bash', version: 'fixture' }, helpers: { rg: false, grep: false } }, process: { available: false } },
    panels: { mountFresh: () => 'fixture-panel', startSeqFor: () => 0, appTokenFor: () => 'fixture-token' },
    directAccess, settings: { get: () => ({ values }) },
  });
  t.after(async () => {
    await cleaner.closeAll(); await directAccess.close(); setAccessTokenOverride(undefined);
  });
  await directAccess.apply(directAccessConfig(values));
  // Raw HTTP deliberately models a TLS proxy's preserved Host. Native fetch
  // derives Host from its URL, so overriding requestInit.headers would not test it.
  const rpc = (headers, body, session) => new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const request = http.request({ hostname: '127.0.0.1', port, path: '/mcp/direct-panel-fixture', method: 'POST', agent: false,
      headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers, ...(session ? { 'mcp-session-id': session, 'mcp-protocol-version': LATEST_PROTOCOL_VERSION } : {}) } }, (response) => {
      let text = ''; response.on('data', (c) => { text += c; });
      response.on('end', () => { let json; try { json = JSON.parse(text); } catch {} resolve({ status: response.statusCode, headers: response.headers, json }); });
    });
    request.setTimeout(5000, () => request.destroy(new Error('RPC timeout')));
    request.on('error', reject); request.end(data);
  });
  const panelOrigin = async (headers) => {
    const initialized = await rpc(headers, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: appsCapabilities, clientInfo: { name: 'direct-panel', version: '1' } } });
    assert.equal(initialized.status, 200);
    const session = initialized.headers['mcp-session-id'];
    await rpc(headers, { jsonrpc: '2.0', method: 'notifications/initialized' }, session);
    const resource = await rpc(headers, { jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: PANEL_RESOURCE_URI } }, session);
    assert.equal(resource.status, 200);
    return resource.json.result.contents[0]._meta.ui.csp.connectDomains;
  };
  assert.deepEqual(await panelOrigin({ host: 'mcp.example.test' }), ['https://mcp.example.test']);
  assert.deepEqual(await panelOrigin({ host: `127.0.0.1:${port}`, 'x-forwarded-host': 'foreign.example.test', 'x-forwarded-proto': 'https', 'cf-ray': 'fake' }), [`http://127.0.0.1:${port}`]);
  assert.deepEqual(await panelOrigin({ host: '203.0.113.20:49152', 'x-forwarded-proto': 'https' }), ['http://203.0.113.20:49152']);
});
