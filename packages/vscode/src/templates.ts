export type TemplateKind = 'connector' | 'sandbox';

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
