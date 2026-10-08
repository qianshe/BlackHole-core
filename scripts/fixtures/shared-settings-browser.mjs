// Synthetic services used by BOTH production renderer fixtures. Never calls a daemon.
export function createSettingsPreview(defaults, { controls = false } = {}) {
  let values = structuredClone(defaults), revision = 1, channelOn = controls;
  // Optional populated controls fixture: statuses only, never starts an MCP process.
  const proxyConfig = controls ? [
    { name: 'chrome', transport: 'stdio', command: 'fixture-chrome', args: [], enabled: true },
    { name: 'open-computer-use', transport: 'stdio', command: 'fixture-computer', args: [], enabled: false },
    { name: 'browser-use', transport: 'http', url: 'https://browser.example.invalid/mcp', enabled: false },
  ] : [];
  let statusCases = false;
  const proxyView = () => ({ configured: proxyConfig.length > 0, config: structuredClone(proxyConfig),
    disabled: proxyConfig.filter(p => !p.enabled).map(p => p.name),
    status: [
      ...proxyConfig.map(p => ({ name: p.name, status: p.enabled ? 'online' : 'disabled', catalogCount: p.name === 'chrome' ? 29 : 3, tools: [] })),
      ...(statusCases ? ['starting', 'offline', 'degraded', 'crashed', 'config_error'].map(status => ({ name: 'fixture-' + status + '-with-a-long-server-name-for-narrow-layout', status, catalogCount: null, tools: [] })) : []),
    ],
  });
  let requests = [], devices = [], remoteOverride = null, pairExpiryMs = 300000;
  let probeResult = { state: 'failed', checked_at: null, reason: 'unreachable' };
  const calls = [], copies = [], blocked = [];
  const origin = 'http://192.0.2.10:7307';
  const account = { state: 'verified', userId: 'fixture-user', account: { name: 'Demo User', email: 'demo@example.invalid', status: 'active', serviceExpiresAt: 2100000000, serverNow: 2098963200 }, remainingSeconds: 1036800 };
  const record = () => ({ revision, migrated: true, unseeded: [], values: structuredClone(values), pending_restart: [], updated_at: null });
  const channel = () => ({ on: channelOn, state: channelOn ? 'on' : 'off', running: channelOn ? ['quick'] : [], next: 'quick', last: 'quick', missing: null, reason: null });
  const remote = () => ({ ...(remoteOverride ?? { enabled: true, available: true, reason: null, origin, kind: 'fixed', endpoints: [{ origin, kind: 'fixed', scope: 'private', verification: { state: 'unverified', checked_at: null, reason: null } }] }), devices, requests });
  const health = () => {
    const route = values.aiDefaultRoute === 'auto' ? values.directAccessEnabled ? 'direct' : values.channelMode : values.aiDefaultRoute;
    const candidates = values.directAccessEnabled ? values.directAccessUrl ? [{ id: 'configured', kind: 'direct', scope: 'public', url: values.directAccessUrl + '/mcp/fixture', label: '直连' }] : [{ id: 'lan', kind: 'direct', scope: 'private', url: origin + '/mcp/fixture', label: 'LAN' }, { id: 'mesh', kind: 'direct', scope: 'private', url: 'http://100.80.0.2:7307/mcp/fixture', label: 'Mesh' }] : [];
    const selected = route === 'direct' && candidates.length === 1 ? candidates[0] : null;
    const needs = route === 'direct' && candidates.length > 1;
    return { ok: true, version: '0.3.196', daemon_id: 'fixture', settings_revision: revision, stats: { total: 0 }, activity_days: [], tunnel: channelOn ? 'online' : 'off', tunnel_url: null, tunnel_mode: channelOn ? 'quick' : null, mcp_url: 'http://127.0.0.1:7306/mcp/fixture',
      direct_access: { enabled: values.directAccessEnabled, port: values.directPort, state: values.directAccessEnabled ? 'listening' : 'off', listening: values.directAccessEnabled, mode: values.directAccessEnabled ? 'direct' : 'off', bind_host: values.directAccessEnabled ? '0.0.0.0' : null, target: 'http://127.0.0.1:' + values.directPort, origin: values.directAccessUrl || null, proxy_origin: null, addresses: values.directAccessEnabled ? ['192.0.2.10', '100.80.0.2'] : [], error: null },
      connection_routes: { selected_route: route, saved_tunnel_id: null, preferred_mcp_url: selected?.url ?? null, preferred_mcp_kind: selected?.kind ?? null, preferred_mcp_scope: selected?.scope ?? null, needs_choice: needs, reason: needs ? 'direct_multiple' : null, connector_ready: !!selected, connector_kind: selected?.kind ?? null, mcp_candidates: candidates, sandbox_mcp_url: selected?.url ?? null, sandbox_kind: selected?.kind ?? null, openai: 'off' } };
  };
  const run = async (method, rawPath, body) => {
    const path = rawPath.startsWith('/panel/') ? rawPath.slice(6) : rawPath;
    if (method !== 'GET') calls.push({ method, path, body: structuredClone(body ?? {}) });
    if (path === '/settings' && method === 'GET') return record();
    if (path === '/settings' && method === 'PATCH') {
      if (body.revision !== revision) throw Object.assign(Error('revision_conflict'), { status: 409 });
      Object.assign(values, body.values); revision++; return record();
    }
    if (path === '/health') return health();
    if (path === '/channel') { if (method === 'POST') channelOn = body.on; return method === 'POST' ? { ok: true, view: channel() } : channel(); }
    if (path === '/account' || path === '/account/refresh') return account;
    if (path === '/host/info') return { kind: 'vscode', version: '0.3.196', environment: 'test', cloudOrigin: 'https://fixture.example.invalid', port: 7306, pollIntervalMs: 1000, daemonEntry: '' };
    if (path === '/host/clipboard') { copies.push(body.text); return { copied: true }; }
    if (path === '/semantic') return { registered: false, would_resolve: false };
    if (path === '/approvals') return { always: [], sessions: [] };
    if (path.startsWith('/settings/skills')) return { cls: '', hint: '验证夹具，不扫描本机目录' };
    if (path === '/proxies') return proxyView();
    if (controls && path === '/proxies/config/fields') {
      await new Promise(resolve => setTimeout(resolve, 180));
      const row = proxyConfig.find(p => p.name === body.server);
      if (!row) throw Error('Unknown fixture proxy');
      Object.assign(row, body.fields); return { written: true };
    }
    if (controls && path === '/proxies/tools') return { tools: Array.from({ length: 29 }, (_, i) => ({ name: 'fixture_tool_' + i, description: 'Synthetic tool; no real MCP is connected.', enabled: true })), cachedOnly: true };
    if (controls && path === '/proxies/remove') throw Error('Fixture deletion is deliberately disabled');
    if (path === '/account/plans') return { enabled: false, plans: [] };
    if (path === '/account/orders') return [];
    if (path === '/account/refundable') return { orders: [], nextCursor: null };
    if (path === '/openai-tunnel') return { daemon_id: 'fixture', status: 'off', run_id: null, active_tunnel_id: null, credential_configured: false, credential_revision: 0, runtime_available: false, pending_restart: false };
    if (path.endsWith('/install')) return { state: 'idle' };
    if (path === '/remote') return remote();
    if (path === '/remote/probe') {
      const selected = remoteOverride?.endpoints?.find(x => x.origin === body.origin);
      if (selected) selected.verification = { ...probeResult, checked_at: Date.now() };
      return remote();
    }
    if (path === '/remote/pair') {
      const selected = remote().endpoints.find(x => x.origin === body.origin);
      return { url: (body.origin || origin) + '/#pair=FIXTURE_NOT_A_REAL_CODE', expires_at: new Date(Date.now() + pairExpiryMs).toISOString(), kind: selected?.kind ?? 'fixed' };
    }
    if (path.startsWith('/remote/requests/')) {
      const id = path.split('/').at(-1), item = requests.find(x => x.id === id); requests = requests.filter(x => x.id !== id);
      if (item && body.allow) devices.push({ id: 'device', name: item.name, created_at: new Date().toISOString(), last_seen_at: new Date().toISOString() });
      return remote();
    }
    throw Error('Fixture route is not implemented: ' + method + ' ' + path);
  };
  window.fetch = async (...args) => { blocked.push(String(args[0])); throw Error('Network disabled in fixture'); };
  return { run, calls, copies, blocked, health, record, setStatusCases: enabled => { statusCases = enabled === true; },
    setRequests: v => { requests = v; }, setRemoteView: v => { remoteOverride = v; },
    setPairExpiryMs: ms => { pairExpiryMs = ms; }, setProbeResult: v => { probeResult = v; },
    edit: patch => { Object.assign(values, patch); revision++; } };
}
