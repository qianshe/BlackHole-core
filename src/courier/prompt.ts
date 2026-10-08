// Prompt templates shared by the daemon (Courier first message), VS Code and the Web console.
// packages/vscode/src/templates.ts is a copy (its tests load it standalone); scripts/prompt-sync.test.mjs keeps them identical.
import type { ConnectionHealth as WireHealth, McpRouteCandidate, RouteKind, SelectedRoute } from '../../packages/contracts/dist/connections.js';
export type TemplateKind = 'connector' | 'sandbox';
export type ConnectionHealth = WireHealth;
export type ConnectionRouteCandidate = McpRouteCandidate;

/** Pure projection. Configuration, selection and running-channel state stay separate. */
export interface ConnectionTarget {
  publicUrl: string | null;
  mcpUrl: string | null;
  mcpKind: RouteKind | null;
  sandboxMcpUrl: string | null;
  mcpCandidates: McpRouteCandidate[];
  selectedRoute: SelectedRoute | null;
  /** Saved daemon value for the selected OpenAI route, usable while offline. */
  tunnelId: string | null;
  needsChoice: boolean;
  reason: string | null;
  openai: 'ready' | 'starting' | 'off';
  connector: boolean;
  sandbox: boolean;
}

function originOf(url: string | null): string | null {
  if (!url) return null;
  try { return new URL(url).origin; } catch { return null; }
}

export function connectionTarget(h: ConnectionHealth | null | undefined): ConnectionTarget {
  const routes = h?.connection_routes;
  if (routes) {
    const sandboxMcpUrl = routes.sandbox_mcp_url ?? null;
    const status = routes.openai;
    const kind = routes.preferred_mcp_kind;
    const selectedRoute = routes.selected_route ?? (routes.reason === 'openai_selected' ? 'openai' : kind && kind !== 'loopback' ? kind : null);
    return {
      publicUrl: originOf(sandboxMcpUrl),
      mcpUrl: routes.preferred_mcp_url ?? null,
      mcpKind: kind ?? null,
      sandboxMcpUrl,
      mcpCandidates: Array.isArray(routes.mcp_candidates) ? routes.mcp_candidates : [],
      selectedRoute,
      tunnelId: selectedRoute === 'openai' ? routes.saved_tunnel_id ?? null : null,
      needsChoice: routes.needs_choice === true,
      reason: routes.reason ?? null,
      openai: status === 'ready' || status === 'starting' ? status : 'off',
      connector: routes.connector_ready === true,
      sandbox: !!sandboxMcpUrl,
    };
  }
  // Compatibility for older daemons only; never override a modern route snapshot.
  const publicUrl = (h?.tunnel === 'online' && h.tunnel_url) || h?.public_base_url || null;
  const status = h?.openai_tunnel?.status;
  const openai = status === 'ready' || status === 'recovering' ? 'ready' : status === 'starting' ? 'starting' : 'off';
  return {
    publicUrl,
    mcpUrl: h?.mcp_url ?? null,
    mcpKind: null,
    sandboxMcpUrl: publicUrl ? h?.mcp_url ?? null : null,
    mcpCandidates: [],
    selectedRoute: publicUrl ? (h?.tunnel === 'online' ? 'cloudflare' : 'custom') : openai === 'ready' ? 'openai' : null,
    tunnelId: h?.openai_tunnel?.active_tunnel_id ?? null,
    needsChoice: false,
    reason: null,
    openai,
    connector: !!publicUrl || openai === 'ready',
    sandbox: !!publicUrl,
  };
}

export const SANDBOX_NEEDS_PUBLIC_URL = '沙箱提示词需要能同时提供 /bh.md 与 MCP 的公网地址；局域网 MCP 直连和 OpenAI Tunnel 不能直接用于沙箱提示词，请选择 Cloudflare 或自定义公网入口。';

export type PromptPayload =
  | { kind: 'user'; text: string }
  | { kind: 'handoff'; text: string };

function manualUrl(mcpUrl: string): string {
  const url = new URL(mcpUrl);
  if (!['http:', 'https:'].includes(url.protocol) || !/\/mcp\/[^/]+\/?$/.test(url.pathname)) {
    throw new Error('Expected an HTTP(S) MCP URL ending in /mcp/<token>');
  }
  url.pathname = url.pathname.slice(0, url.pathname.lastIndexOf('/mcp/')) + '/bh.md';
  url.search = '';
  url.hash = '';
  return url.href;
}

/**
 * Connection bootstrap only. It identifies the BlackHole transport and session;
 * the operating manual and project instructions live in guide.
 */
export function renderBootstrap(
  kind: TemplateKind,
  mcpUrl: string,
  sessionId: string,
  connectorName = 'BlackHole',
): string {
  if (kind === 'connector') {
    return [
      `@${connectorName.trim() || 'BlackHole'}`,
      `sessionId: ${sessionId}`,
      'Call `guide` with this sessionId before workspace work and follow it.',
    ].join('\n');
  }
  return [
    `BlackHole MCP Manual: ${manualUrl(mcpUrl)}`,
    `sessionId: ${sessionId}`,
    '',
    'Read this Manual, familiarize yourself with the BlackHole MCP, and prepare to use it with this sessionId for the work that follows. Refer back to it whenever needed.',
  ].join('\n');
}

/**
 * First-message composition. A copied prompt has no payload; a real user message
 * or saved Handoff is appended explicitly and is never inferred from session metadata.
 */
export function renderPrompt(
  kind: TemplateKind,
  mcpUrl: string,
  sessionId: string,
  payload?: PromptPayload,
  connectorName = 'BlackHole',
): string {
  const bootstrap = renderBootstrap(kind, mcpUrl, sessionId, connectorName);
  if (!payload) return bootstrap;
  const body = payload.kind === 'handoff' ? `Handoff context:\n${payload.text}` : payload.text;
  return `${bootstrap}\n\n${body}`;
}
