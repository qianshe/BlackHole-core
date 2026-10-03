// Prompt templates shared by the daemon (Courier first message), VS Code and the Web console.
// packages/vscode/src/templates.ts is a copy (its tests load it standalone); scripts/prompt-sync.test.mjs keeps them identical.
export type TemplateKind = 'connector' | 'sandbox';

/** Health fields the connection-target decision reads; VS Code and Local Web health both fit. */
export interface ConnectionHealth {
  tunnel?: string | null;
  tunnel_url?: string | null;
  public_base_url?: string | null;
  openai_tunnel?: { status?: string | null } | null;
}

/**
 * One pure decision shared by create-session, copy, handoff and the sidebar
 * (plan section 6). Connector prompts carry no URL, so a public URL or a
 * serving OpenAI tunnel both qualify. Sandbox bootstrap downloads bh.py over
 * HTTP and needs a public URL; a Tunnel ID never substitutes for one. Nothing
 * here starts, stops or switches a channel.
 */
export interface ConnectionTarget {
  /** Base a web sandbox can reach: Cloudflare online, else the fixed public base. */
  publicUrl: string | null;
  /** OpenAI Secure MCP Tunnel: ready (incl. recovering), starting, or off/failed. */
  openai: 'ready' | 'starting' | 'off';
  /** URL-free connector prompts can reach this machine. */
  connector: boolean;
  /** HTTP sandbox prompts can reach this machine. */
  sandbox: boolean;
}

export function connectionTarget(h: ConnectionHealth | null | undefined): ConnectionTarget {
  const publicUrl = (h?.tunnel === 'online' && h.tunnel_url) || h?.public_base_url || null;
  const status = h?.openai_tunnel?.status;
  const openai = status === 'ready' || status === 'recovering' ? 'ready' : status === 'starting' ? 'starting' : 'off';
  return { publicUrl, openai, connector: !!publicUrl || openai === 'ready', sandbox: !!publicUrl };
}

export const SANDBOX_NEEDS_PUBLIC_URL = '沙箱直连需要公网地址（Cloudflare 渠道或自定义地址）；OpenAI 渠道只支持连接器方式，请改用连接器提示词。';

export type PromptPayload =
  | { kind: 'user'; text: string }
  | { kind: 'handoff'; text: string };

function scriptUrl(mcpUrl: string, sessionId: string): string {
  const url = new URL(mcpUrl);
  if (!['http:', 'https:'].includes(url.protocol) || !/\/mcp\/[^/]+\/?$/.test(url.pathname)) {
    throw new Error('Expected an HTTP(S) MCP URL ending in /mcp/<token>');
  }
  url.pathname = url.pathname.slice(0, url.pathname.lastIndexOf('/mcp/')) + '/bh.py';
  url.search = new URLSearchParams({ sessionid: sessionId }).toString();
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
    `Download ${scriptUrl(mcpUrl, sessionId)} to the current sandbox root as \`bh.py\`.`,
    '',
    'Read `bh.py`, then use it to read `guide` and familiarize yourself with the connected BlackHole MCP. Save concise practical usage notes beside `bh.py` as `BLACKHOLE.md` for reuse; do not copy the current task into it.',
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
