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

/** POSIX quoting for the remote sandbox bootstrap, including apostrophes. */
const shellQuote = (value: string): string => "'" + value.replace(/'/g, "'\\''") + "'";

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
 * Two transport adapters, one operating manual. The copy action supplies kind;
 * never infer it from the platform name, URL or presence of a show tool.
 * The connector needs only an @mention and sessionId to reach guide. The
 * script download embeds both endpoint and sessionId, so no duplicate MCP URL
 * or full operating instructions belong in the template. Startup lives in guide.
 */
export function renderPrompt(
  kind: TemplateKind,
  mcpUrl: string,
  sessionId: string,
  task?: string | null,
  connectorName = 'BlackHole',
  purpose: 'task' | 'handoff' = 'task',
): string {
  const taskText = typeof task === 'string' && task.trim() ? task.trim() : '<paste your task here>';
  // Handoff contains its own final task field. Label the envelope as context,
  // without parsing/rewording the saved text or changing ordinary task prompts.
  const body = purpose === 'handoff' ? `Handoff context:\n${taskText}` : `Task: ${taskText}`;
  if (kind === 'connector') {
    return [
      `@${connectorName.trim() || 'BlackHole'}`,
      `sessionId: ${sessionId}`,
      'Read guide with this sessionId. Comply with its instructions throughout the session.',
      body,
    ].join('\n');
  }
  return [
    'bh.py provides access to the BlackHole workspace from this sandbox.',
    `sessionId: ${sessionId}`,
    `Bootstrap once: curl -fsSL ${shellQuote(scriptUrl(mcpUrl, sessionId))} -o bh.py && python3 bh.py call guide '{}'`,
    'Comply with the instructions returned by guide throughout the session.',
    body,
  ].join('\n');
}
