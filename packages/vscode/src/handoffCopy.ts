import type { ControlApi } from './controlApi';
import { connectionTarget, renderPrompt, SANDBOX_NEEDS_PUBLIC_URL, type TemplateKind } from './templates';

/** Read one fresh control-plane snapshot; never accept context or credentials from the webview. */
export async function prepareHandoffPrompt(
  api: Pick<ControlApi, 'handoff'>,
  sessionId: string,
  expectedId: string,
  kind: TemplateKind,
  connectorName: string,
): Promise<string> {
  if (kind !== 'connector' && kind !== 'sandbox') throw new Error('请选择连接器或沙箱直连。');
  const snapshot = await api.handoff(sessionId);
  if (snapshot.session.id !== sessionId) throw new Error('会话归属不一致，请刷新后重试。');
  if (!snapshot.handoff) throw new Error('Handoff 内容已清除，请刷新会话。');
  if (snapshot.handoff.id !== expectedId) throw new Error('Handoff 已更新，请重试复制。');
  if (!snapshot.available || snapshot.session.status !== 'active') throw new Error('会话已暂停、过期或终止，暂时不能Handoff 。');
  if (!snapshot.session.session_id || !snapshot.handoff.content.trim()) throw new Error('Handoff 信息不完整，请刷新后重试。');
  let legacyPublic: string | null = null;
  if (!snapshot.connection_routes) {
    try {
      const endpoint = new URL(snapshot.mcp_url);
      const loopback = /^(localhost|127\..*|\[::1\])$/i.test(endpoint.hostname);
      if (['https:', 'http:'].includes(endpoint.protocol) && !loopback) legacyPublic = snapshot.mcp_url;
    } catch { /* invalid legacy URL stays unavailable */ }
  }
  const target = connectionTarget({
    mcp_url: snapshot.mcp_url,
    public_base_url: legacyPublic,
    connection_routes: snapshot.connection_routes ?? null,
    openai_tunnel: snapshot.openai_tunnel ?? null,
  });
  // Connector bootstrap is URL-free, so copying a handoff must not be blocked by
  // channel runtime state. Sandbox handoff is stricter because it embeds /bh.md.
  if (kind === 'sandbox' && !target.sandboxMcpUrl) throw new Error(SANDBOX_NEEDS_PUBLIC_URL);
  const endpoint = kind === 'sandbox' ? target.sandboxMcpUrl! : (target.mcpUrl ?? snapshot.mcp_url);
  return renderPrompt(kind, endpoint, snapshot.session.session_id, { kind: 'handoff', text: snapshot.handoff.content }, connectorName);
}
