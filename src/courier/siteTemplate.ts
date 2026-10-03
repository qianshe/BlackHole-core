import type { TemplateKind } from './prompt.js';

/**
 * Which prompt template the first message to a web agent carries. Web agents that can add a
 * BlackHole MCP connector get the connector prompt; every other site (Arena, Trae, sites added in
 * Courier…) runs its own sandbox and gets the sandbox bootstrap. A new connector site = one line here.
 * Sites added in Courier are matched by origin (`www.` ignored), so binding Claude or Manus with
 * 检测此页面 picks the connector prompt without further changes.
 */
export const CONNECTOR_HOSTS: readonly string[] = ['chatgpt.com', 'claude.ai', 'manus.im'];
const BUILTIN_HOSTS: Readonly<Record<string, string>> = { chatgpt: 'chatgpt.com', arena: 'arena.ai' };

export function templateForSite(site: string, origin?: string | null): TemplateKind {
  let host = BUILTIN_HOSTS[site] ?? null;
  if (!host && origin) {
    try { host = new URL(origin).hostname.toLowerCase().replace(/^www\./, ''); } catch { host = null; }
  }
  return host && CONNECTOR_HOSTS.includes(host) ? 'connector' : 'sandbox';
}
