import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveConnectionRoutes as resolve } from '../dist/connection/resolve.js';
import { DEFAULT_SETTINGS } from '../dist/settings/store.js';
import { ConnectionRoutesSchema } from '../packages/contracts/dist/connections.js';
const path = '/mcp/token';
const origin = (raw) => raw ? new URL(raw).origin : null;
function fixture({ values: overrides = {}, addresses = ['192.168.1.20'], state, runtime = {}, missingListener = false, tunnelStatus = 'off', tunnelUrl = null, openaiStatus = 'off' } = {}) {
  const values = { ...DEFAULT_SETTINGS, ...overrides };
  const proxy = values.channelMode === 'custom' || values.aiDefaultRoute === 'custom' ? origin(values.publicBaseUrl) : null;
  const mode = values.directAccessEnabled ? 'direct' : proxy ? 'proxy' : 'off';
  const currentState = state ?? (mode === 'off' ? 'off' : 'listening');
  const view = { enabled: values.directAccessEnabled, port: values.directPort, state: currentState,
    listening: currentState === 'listening', mode, bind_host: values.directAccessEnabled ? '0.0.0.0' : '127.0.0.1',
    target: `http://127.0.0.1:${values.directPort}`, origin: values.directAccessEnabled ? origin(values.directAccessUrl) : proxy,
    proxy_origin: proxy, addresses, error: null, ...runtime };
  return { cfg: { host: '127.0.0.1', port: 7306 }, settings: { get: () => ({ values }) },
    directAccess: missingListener ? undefined : { view: () => view },
    tunnel: { status: tunnelStatus, url: tunnelUrl, mode: 'quick' }, openaiTunnel: { status: openaiStatus } };
}
const route = (options) => ConnectionRoutesSchema.parse(resolve(fixture(options), path));
const live = { tunnelStatus: 'online', tunnelUrl: 'https://live.trycloudflare.com' };

test('saving a direct URL alone does not enable it', () => {
  const r = route({ values: { directAccessUrl: 'https://bh.example.test' }, ...live });
  assert.equal(r.selected_route, 'cloudflare');
  assert.equal(r.preferred_mcp_url, 'https://live.trycloudflare.com/mcp/token');
  assert.equal(r.mcp_candidates.some((x) => x.kind === 'direct'), false);
});

test('one direct switch plus an advertised URL drives MCP and sandbox without a second switch', () => {
  for (const url of ['https://bh.example.test', 'http://bh.example.test:49152', 'http://1.1.1.1:49152']) {
    const r = route({ values: { directAccessEnabled: true, directAccessUrl: url }, addresses: ['192.168.1.2', '100.64.1.2'], ...live });
    assert.equal(r.selected_route, 'direct'); assert.equal(r.needs_choice, false);
    assert.equal(r.preferred_mcp_url, url + path); assert.equal(r.sandbox_mcp_url, url + path);
    assert.equal(r.connector_kind, 'direct'); assert.equal(r.connector_ready, true);
  }
});

test('no advertised URL uses the one discovered interface; no static LAN address field is needed', () => {
  const r = route({ values: { directAccessEnabled: true, directPort: 8100 }, ...live });
  assert.equal(r.preferred_mcp_url, 'http://192.168.1.20:8100/mcp/token');
  assert.equal(r.preferred_mcp_scope, 'private'); assert.equal(r.sandbox_mcp_url, null);
  assert.equal(r.connector_ready, true);
});

test('multiple interfaces expose only candidates and require a one-off selection; no fallback', () => {
  const r = route({ values: { directAccessEnabled: true }, addresses: ['192.168.1.2', '100.64.1.2'], ...live });
  assert.equal(r.selected_route, 'direct'); assert.equal(r.preferred_mcp_url, null);
  assert.equal(r.needs_choice, true); assert.equal(r.reason, 'direct_multiple');
  assert.equal(r.connector_ready, false);
  assert.deepEqual(r.mcp_candidates.filter((x) => x.kind === 'direct').map((x) => x.url), ['http://192.168.1.2:7307/mcp/token', 'http://100.64.1.2:7307/mcp/token']);
});

for (const state of ['applying', 'error', 'off']) {
  test(`direct ${state} cannot advertise a ready connection or fall back to a live channel`, () => {
    const r = route({ values: { directAccessEnabled: true, directAccessUrl: 'https://bh.example.test' }, state, ...live });
    assert.equal(r.selected_route, 'direct'); assert.equal(r.preferred_mcp_url, null);
    assert.equal(r.sandbox_mcp_url, null); assert.equal(r.connector_ready, false); assert.equal(r.reason, 'direct_unavailable');
  });
}

test('missing listener, stale origin and stale port never appear ready from saved intent alone', () => {
  const values = { directAccessEnabled: true, directAccessUrl: 'https://new.example.test' };
  for (const option of [{ missingListener: true }, { runtime: { origin: 'https://old.example.test' } }, { runtime: { port: 8100 } }, { runtime: { mode: 'proxy' } }]) {
    assert.equal(route({ values, ...option }).preferred_mcp_url, null);
  }
  const r = route({ values: { directAccessEnabled: true }, addresses: [], ...live });
  assert.equal(r.reason, 'direct_unavailable'); assert.equal(r.preferred_mcp_url, null);
});

test('private, loopback, ULA, link-local and mapped addresses cannot be promoted to public by a URL', () => {
  for (const host of ['10.1.2.3', '172.31.2.3', '192.168.2.3', '100.64.1.2', '169.254.1.2', '[fc00::1]', '[fd00::1]', '[fe80::1]', '[::ffff:10.1.2.3]', '[::ffff:a01:203]', '127.0.0.1', '[::1]', '[::ffff:127.0.0.1]', 'nas.lan']) {
    const r = route({ values: { directAccessEnabled: true, directAccessUrl: `https://${host}` } });
    assert.notEqual(r.preferred_mcp_scope, 'public', host); assert.equal(r.sandbox_mcp_url, null, host);
  }
});

for (const choice of ['cloudflare', 'custom', 'openai']) {
  test(`explicit ${choice} is not displaced by enabled direct access`, () => {
    const r = route({ values: { aiDefaultRoute: choice, directAccessEnabled: true, directAccessUrl: 'https://direct.example.test', publicBaseUrl: 'https://custom.example.test' }, ...live, openaiStatus: 'ready' });
    assert.equal(r.selected_route, choice); assert.equal(r.connector_kind, choice);
    assert.equal(r.connector_ready, true);
    assert.equal(r.preferred_mcp_url, choice === 'openai' ? null : choice === 'custom' ? 'https://custom.example.test/mcp/token' : 'https://live.trycloudflare.com/mcp/token');
  });
}

test('explicit unavailable direct does not switch to a live Cloudflare/OpenAI channel', () => {
  const r = route({ values: { aiDefaultRoute: 'direct' }, ...live, openaiStatus: 'ready' });
  assert.equal(r.reason, 'direct_unavailable'); assert.equal(r.connector_ready, false); assert.equal(r.sandbox_mcp_url, null);
});

for (const channel of ['cloudflare', 'custom', 'openai']) {
  test(`auto with direct off follows ${channel}, not whichever other channel is online`, () => {
    const r = route({ values: { channelMode: channel, publicBaseUrl: 'https://custom.example.test' }, ...live, openaiStatus: 'ready' });
    assert.equal(r.selected_route, channel);
  });
}

test('offline selected Cloudflare never silently uses a saved custom URL', () => {
  const r = route({ values: { publicBaseUrl: 'https://custom.example.test' } });
  assert.equal(r.selected_route, 'cloudflare'); assert.equal(r.reason, 'cloudflare_unavailable'); assert.equal(r.preferred_mcp_url, null);
});

test('custom route requires the shared listener and the currently applied proxy origin', () => {
  const values = { aiDefaultRoute: 'custom', publicBaseUrl: 'https://custom.example.test' };
  assert.equal(route({ values }).preferred_mcp_url, 'https://custom.example.test/mcp/token');
  for (const option of [{ state: 'applying' }, { missingListener: true }, { runtime: { proxy_origin: 'https://stale.example.test' } }]) assert.equal(route({ values, ...option }).reason, 'custom_unavailable');
  const d = fixture({ values: { aiDefaultRoute: 'custom', publicBaseUrl: '' } });
  d.cfg.publicBaseUrl = 'https://old-startup.example.test';
  assert.equal(resolve(d, path).preferred_mcp_url, null, 'clearing the saved URL does not resurrect a startup value');
});

test('OpenAI keeps the saved Tunnel ID while off, starting or ready and remains connector-only', () => {
  const saved = 'tunnel_' + 'a'.repeat(32);
  for (const status of ['off', 'starting', 'ready']) {
    const d = fixture({ values: { aiDefaultRoute: 'openai', openaiTunnelId: saved }, openaiStatus: status });
    d.openaiTunnel.active_tunnel_id = 'tunnel_' + 'b'.repeat(32);
    const r = ConnectionRoutesSchema.parse(resolve(d, path));
    assert.equal(r.saved_tunnel_id, saved); assert.equal(r.preferred_mcp_url, null); assert.equal(r.sandbox_mcp_url, null);
    assert.equal(r.connector_ready, status === 'ready');
  }
});
