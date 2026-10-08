import type { DaemonDeps } from '../deps.js';
import type { ConnectionRoutesView, McpRouteCandidate, RouteKind } from '../../packages/contracts/dist/connections.js';
import { networkScope } from './scope.js';

export type { ConnectionRoutesView, McpRouteCandidate, RouteKind } from '../../packages/contracts/dist/connections.js';

function join(origin: string, path: string): string | null {
  try {
    const u = new URL(origin);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) return null;
    const basePath = u.pathname.replace(/\/+$/, '');
    u.pathname = basePath + (path.startsWith('/') ? path : '/' + path);
    u.search = '';
    u.hash = '';
    return u.href;
  } catch {
    return null;
  }
}

function originOf(raw: string): string | null {
  try { return new URL(raw).origin; } catch { return null; }
}

function candidate(id: string, kind: RouteKind, origin: string, path: string, label: string, declaredScope: 'private' | 'public' = 'private'): McpRouteCandidate | null {
  const url = join(origin, path);
  if (!url) return null;
  return { id, kind, scope: networkScope(new URL(url).hostname, declaredScope), url, label };
}

export function resolveConnectionRoutes(
  deps: Pick<DaemonDeps, 'cfg' | 'tunnel' | 'settings' | 'directAccess' | 'openaiTunnel'>,
  path: string,
): ConnectionRoutesView {
  const values = deps.settings?.get().values;
  const mode = values?.channelMode ?? 'cloudflare';
  const routePreference = values?.aiDefaultRoute ?? 'auto';
  const directIntent = values?.directAccessEnabled === true;
  const advertisedDirectOrigin = values?.directAccessUrl?.trim() || '';
  const directView = deps.directAccess?.view();
  const directRuntimeReady = directIntent && directView?.state === 'listening' && directView.listening
    && directView.mode === 'direct' && directView.port === values?.directPort
    && directView.origin === originOf(advertisedDirectOrigin);

  const direct: McpRouteCandidate[] = [];
  if (directRuntimeReady) {
    if (advertisedDirectOrigin) {
      const c = candidate('direct:configured', 'direct', advertisedDirectOrigin, path, '直连', 'public');
      if (c) direct.push(c);
    } else if (directView) {
      for (const address of directView.addresses) {
        const c = candidate(`direct:${address}`, 'direct', `http://${address}:${directView.port}`, path, address, 'private');
        if (c) direct.push(c);
      }
    }
  }

  const cfLive = deps.tunnel.status === 'online' || deps.tunnel.status === 'unverified';
  const cf = cfLive && deps.tunnel.url
    ? candidate('cloudflare', 'cloudflare', deps.tunnel.url, path, deps.tunnel.mode === 'named' ? 'Cloudflare 持久渠道' : 'Cloudflare 临时渠道', 'public')
    : null;

  const customOrigin = values ? values.publicBaseUrl?.trim() || '' : deps.cfg.publicBaseUrl?.trim() || '';
  const customReady = directView?.state === 'listening' && directView.listening
    && directView.proxy_origin === originOf(customOrigin);
  const custom = customOrigin && customReady ? candidate('custom', 'custom', customOrigin, path, '自定义公网入口', 'public') : null;

  const oaStatus = deps.openaiTunnel?.status;
  const openai = oaStatus === 'ready' || oaStatus === 'recovering' ? 'ready' : oaStatus === 'starting' ? 'starting' : 'off';
  const candidates = [...direct, ...(custom ? [custom] : []), ...(cf ? [cf] : [])];

  let selected: McpRouteCandidate | null = null;
  let needsChoice = false;
  let reason: ConnectionRoutesView['reason'] = null;

  // "auto" means one default choice, not failover: direct wins when enabled;
  // otherwise follow the selected public channel. Explicit choices never silently
  // switch just because another route happens to be available.
  const autoRoute: 'direct' | 'cloudflare' | 'custom' | 'openai' = directIntent ? 'direct' : mode;
  const effectiveRoute: 'direct' | 'cloudflare' | 'custom' | 'openai' =
    routePreference === 'auto' ? autoRoute : routePreference;

  if (effectiveRoute === 'direct') {
    if (direct.length === 1) selected = direct[0]!;
    else if (direct.length > 1) { needsChoice = true; reason = 'direct_multiple'; }
    else reason = 'direct_unavailable';
  } else if (effectiveRoute === 'custom') {
    selected = custom;
    if (!selected) reason = 'custom_unavailable';
  } else if (effectiveRoute === 'openai') {
    reason = 'openai_selected';
  } else {
    selected = cf;
    if (!selected) reason = 'cloudflare_unavailable';
  }

  const publicForSandbox = effectiveRoute === 'direct'
    ? (selected?.kind === 'direct' && selected.scope === 'public' ? selected : null)
    : effectiveRoute === 'openai' ? null
      : effectiveRoute === 'custom' ? (custom?.scope === 'public' ? custom : null)
        : cf;
  const connectorKind = effectiveRoute === 'openai'
    ? (openai === 'ready' ? 'openai' : null)
    : selected?.kind === 'direct' ? 'direct'
      : selected?.kind === 'custom' ? 'custom'
        : selected?.kind === 'cloudflare' ? 'cloudflare' : null;

  const savedTunnelId = values?.openaiTunnelId?.trim() || '';
  return {
    selected_route: effectiveRoute,
    saved_tunnel_id: /^tunnel_[0-9a-f]{32}$/.test(savedTunnelId) ? savedTunnelId : null,
    preferred_mcp_url: selected?.url ?? null,
    preferred_mcp_kind: selected?.kind ?? null,
    preferred_mcp_scope: selected?.scope ?? null,
    mcp_candidates: candidates,
    needs_choice: needsChoice,
    reason,
    sandbox_mcp_url: publicForSandbox?.url ?? null,
    sandbox_kind: publicForSandbox?.kind === 'direct' ? 'direct' : publicForSandbox?.kind === 'custom' ? 'custom' : publicForSandbox?.kind === 'cloudflare' ? 'cloudflare' : null,
    connector_ready: connectorKind !== null,
    connector_kind: connectorKind,
    openai,
  };
}
