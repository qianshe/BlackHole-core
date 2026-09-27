import type { ControlApi } from './controlApi';
import { renderPrompt, type TemplateKind } from './templates';

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
  let endpoint: URL;
  try { endpoint = new URL(snapshot.mcp_url); }
  catch { throw new Error('当前连接地址不可用，请检查 BlackHole 渠道。'); }
  if (!['https:', 'http:'].includes(endpoint.protocol)) throw new Error('当前连接地址必须使用 HTTP(S)。');
  if (/^(localhost|127\..*|\[::1\])$/i.test(endpoint.hostname)) {
    throw new Error('当前地址仅本机可达，请先启动公网渠道再复制Handoff 提示词。');
  }
  return renderPrompt(kind, snapshot.mcp_url, snapshot.session.session_id, snapshot.handoff.content, connectorName, 'handoff');
}
