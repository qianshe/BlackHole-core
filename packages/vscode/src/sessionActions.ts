import { realpathSync } from 'node:fs';
import path from 'node:path';
import { env, window, workspace } from 'vscode';
import type { ControlApi, SessionAction, SessionInfo } from './controlApi';
import type { DaemonManager } from './daemonManager';
import { getConfig } from './config';
import { connectionTarget, renderPrompt, SANDBOX_NEEDS_PUBLIC_URL, type TemplateKind } from './templates';

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** Display label for a session: the task text typed at creation, else folder name. */
export const sessionLabel = (s: Pick<SessionInfo, 'name' | 'workspace_path'>): string =>
  s.name?.trim() || path.basename(s.workspace_path) || s.workspace_path;

async function pickFolder(): Promise<string | undefined> {
  const folders = workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    void window.showErrorMessage('BlackHole: 当前没有打开的工作区文件夹');
    return undefined;
  }
  if (folders.length === 1) return real(folders[0]!.uri.fsPath);
  const pick = await window.showQuickPick(
    folders.map((f) => ({ label: f.name, description: f.uri.fsPath, fsPath: f.uri.fsPath })),
    { title: '创建会话：选择项目', placeHolder: '选择要交给远程 AI 的项目文件夹', ignoreFocusOut: false },
  );
  return pick ? real(pick.fsPath) : undefined;
}

const DAEMON_NOT_READY = 'BlackHole: daemon 正在启动或配置交接中，尚未确认就绪。请稍后重试；如持续失败，请查看输出面板。';

/**
 * Session creation is local state and must not be gated by a public channel.
 * We still verify that the manager and /health describe the same live daemon so
 * an upgrade/restart race cannot write into the wrong process.
 */
async function requireDaemonReady(api: ControlApi, daemon: DaemonManager): Promise<boolean> {
  if (daemon.currentState !== 'running') {
    void window.showWarningMessage(DAEMON_NOT_READY);
    return false;
  }
  const observation = daemon.captureHealthObservation();
  try {
    const h = await api.health(8_000, observation.port);
    if (daemon.observeHealth(h, observation) && daemon.currentState === 'running') return true;
  } catch { /* reported below */ }
  void window.showWarningMessage(DAEMON_NOT_READY);
  return false;
}

/**
 * New session = a draft: the daemon only reserves id + credential. It is stored once the web AI
 * makes its first tool call; closing the draft in the sidebar discards it. `after` opens it.
 */
export async function createSession(api: ControlApi, daemon: DaemonManager, after: (created?: SessionInfo) => void): Promise<void> {
  const folder = await pickFolder();
  if (!folder) return;
  if (!(await daemon.ensureRunning())) return;
  if (!(await requireDaemonReady(api, daemon))) return;

  let created;
  try {
    created = await api.createSession(folder, undefined, true);
  } catch (e) {
    void window.showErrorMessage(`BlackHole: 创建会话失败 — ${msg(e)}`);
    return;
  }
  after(created);
  if (created.draft) {
    window.setStatusBarMessage(`BlackHole: 新会话（${sessionLabel(created)}）：复制提示词，或在输入框发送新开网页 AI 会话`, 5000);
    return;
  }
  // 纯反馈走状态栏：几秒自动消失，不再堆常驻通知
  window.setStatusBarMessage(
    `BlackHole: 会话已创建（${sessionLabel(created)}）— 右键或点 ⋯ 复制提示词`,
    5000,
  );
}

export async function sessionAction(
  api: ControlApi,
  node: SessionInfo,
  action: SessionAction,
  after: () => void,
): Promise<void> {
  try {
    if (action === 'revoke') {
      const confirm = await window.showWarningMessage(
        `BlackHole: 删除会话后其 id 立即永久失效，且不可恢复（${sessionLabel(node)}）。确认删除？`,
        '删除',
      );
      if (confirm !== '删除') return;
    }
    const updated = await api.sessionAction(node.id, action);
    if (action === 'rotate') {
      const copy = '复制新会话 ID';
      const choice = await window.showInformationMessage('BlackHole: 会话 ID 已重置（旧 id 立即失效，MCP 链接不变）—— 请把新 id 转发给 agent', copy);
      if (choice === copy) await env.clipboard.writeText(updated.session_id);
    }
    after();
  } catch (e) {
    void window.showErrorMessage(`BlackHole: ${action} 失败 — ${msg(e)}`);
  }
}

/** True when the URL the daemon reports is only reachable from this machine. */
function isLoopbackUrl(url: string): boolean {
  try {
    return /^127\.|^\[::1\]|^localhost$/.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Copy the resolved identifier; never consult a second settings source here. */
async function offerTunnelId(message: string, resolvedId: string | null | undefined): Promise<void> {
  const id = (resolvedId || '').trim();
  const copy = '复制 Tunnel ID';
  if ((await (id ? window.showInformationMessage(message, copy) : window.showInformationMessage(message))) !== copy) return;
  await env.clipboard.writeText(id);
  window.setStatusBarMessage('BlackHole: Tunnel ID 已复制', 3000);
}

/** Copy the operator-selected MCP route — stable, so this needs no session credential. */
export async function copySessionUrl(api: ControlApi, node: SessionInfo): Promise<void> {
  return copyCurrentConnection(api, node);
}

export async function copyCurrentConnection(api: ControlApi, node?: SessionInfo): Promise<void> {
  const h = await api.health().catch(() => undefined);
  if (!h?.mcp_url) {
    void window.showErrorMessage('BlackHole: 无法获取 MCP 链接（daemon 未运行）');
    return;
  }
  const target = connectionTarget(h);
  if (target.needsChoice) {
    const directCandidates = target.mcpCandidates.filter((c) => c.kind === 'direct');
    const pick = await window.showQuickPick(
      directCandidates.map((c) => ({ label: c.label, description: new URL(c.url).origin, url: c.url })),
      { title: '选择直连地址', placeHolder: '仅用于本次复制；选择目标 Agent 能访问的地址，不会修改设置或切换渠道' },
    );
    if (!pick) return;
    const current = (await api.health().catch(() => undefined))?.connection_routes;
    if (current?.selected_route !== 'direct' || !current.mcp_candidates?.some((c) => c.kind === 'direct' && c.url === pick.url)) {
      void window.showWarningMessage('BlackHole: 连接状态已变化，未复制旧地址，请重新选择。'); return;
    }
    await env.clipboard.writeText(pick.url);
    window.setStatusBarMessage('BlackHole: 直连 MCP 链接已复制', 3000);
    return;
  }
  const url = !h.connection_routes && target.openai === 'ready' && isLoopbackUrl(h.mcp_url) ? null : target.mcpUrl;
  if (!url) {
    if (target.selectedRoute === 'openai') {
      const id = h.connection_routes ? target.tunnelId : target.tunnelId || getConfig().openaiTunnelId;
      if (!id) { void window.showWarningMessage('BlackHole: daemon 尚未保存 Tunnel ID；请到“连接与渠道”填写并保存。'); return; }
      await offerTunnelId(
        'BlackHole: 当前选择的是 OpenAI Tunnel。复制 daemon 保存的 Tunnel ID；渠道停止时也可配置连接器，实际调用前仍需启动。',
        id,
      );
      return;
    }
    if (target.reason === 'direct_unavailable') {
      void window.showWarningMessage('BlackHole: 已选择局域网直连，但直连监听当前不可用。请到“直连”检查端口/监听状态；不会改用 Cloudflare。');
      return;
    }
    if (target.reason === 'custom_unavailable') {
      void window.showWarningMessage('BlackHole: 当前选择自定义地址，但尚未配置可用地址；不会改用其它渠道。');
      return;
    }
    // Legacy/local-only fallback remains available for same-machine clients.
    if (!h.connection_routes && isLoopbackUrl(h.mcp_url)) {
      await env.clipboard.writeText(h.mcp_url);
      void window.showWarningMessage('BlackHole: 已复制本机回环 MCP 链接；它只能供这台电脑上的客户端使用。');
      return;
    }
    void window.showWarningMessage('BlackHole: 当前选择的连接方式没有可复制的 MCP 地址。');
    return;
  }
  if (isLoopbackUrl(url)) {
    await env.clipboard.writeText(url);
    void window.showWarningMessage('BlackHole: 已复制本机回环 MCP 链接；它只能供这台电脑上的客户端使用。');
    return;
  }
  await env.clipboard.writeText(url);
  window.setStatusBarMessage(
    `BlackHole: ${target.mcpKind === 'direct' ? '直连 ' : ''}MCP 链接已复制${node ? `（${sessionLabel(node)}）` : ''}`,
    3000,
  );
}

/**
 * Copy a prompt template for a session. The MCP URL is machine-level (from
 * /health); the numeric session id is the CURRENT credential, re-fetched from
 * the daemon each time — nothing lives in extension memory, so a rotated
 * session automatically serves its fresh id on the next copy.
 */
export async function copyTemplateSession(api: ControlApi, node: SessionInfo, kind: TemplateKind, message?: string): Promise<void> {
  const [h, s] = await Promise.all([
    api.health().catch(() => undefined),
    api.getSession(node.id).catch(() => undefined),
  ]);
  let sessionId = s?.session_id;
  if (!h?.mcp_url || !sessionId) {
    void window.showErrorMessage('BlackHole: 无法获取连接状态或会话 id（daemon 未运行或会话不存在）');
    return;
  }
  const connectorName = getConfig().connectorName || 'BlackHole';
  const target = connectionTarget(h);
  let url = kind === 'sandbox' ? target.sandboxMcpUrl : (target.mcpUrl ?? h.mcp_url);
  if (kind === 'sandbox' && target.needsChoice) {
    const pick = await window.showQuickPick(target.mcpCandidates.filter(c => c.kind === 'direct').map(c => ({ label: c.label, description: new URL(c.url).origin, url: c.url })),
      { title: '选择直连地址', placeHolder: '仅用于本次复制；通用云沙箱需要可从公网访问的地址' });
    if (!pick) return;
    const current = (await api.health().catch(() => undefined))?.connection_routes;
    const candidate = current?.mcp_candidates?.find(c => c.kind === 'direct' && c.url === pick.url);
    if (current?.selected_route !== 'direct' || !candidate) { void window.showWarningMessage('BlackHole: 连接状态已变化，未复制旧地址。'); return; }
    if (candidate.scope !== 'public') { void window.showWarningMessage('BlackHole: 所选地址仅限私网；通用云沙箱需要它能访问的对外地址。未复制。'); return; }
    url = candidate.url;
    sessionId = (await api.getSession(node.id).catch(() => undefined))?.session_id;
    if (!sessionId) { void window.showWarningMessage('BlackHole: 会话已不可用，未复制。'); return; }
  }

  if (kind === 'sandbox' && !url) {
    const extra = target.needsChoice
      ? '存在多个直连地址，需要选择云沙箱实际能访问的地址。'
      : target.reason === 'direct_unavailable'
        ? '当前选择的是直连且监听不可用。'
        : '';
    void window.showWarningMessage(`BlackHole: ${SANDBOX_NEEDS_PUBLIC_URL}${extra ? ' ' + extra : ''} 未复制。`);
    return;
  }

  // Connector bootstrap is URL-free; it can be prepared before the selected route
  // becomes ready. The URL argument is ignored for connector rendering.
  await env.clipboard.writeText(renderPrompt(kind, url ?? h.mcp_url, sessionId, message?.trim() ? { kind: 'user', text: message } : undefined, connectorName));

  if (kind === 'connector' && target.needsChoice) {
    void window.showWarningMessage('BlackHole: 连接器提示词已复制；检测到多个直连地址，请在配置连接器/MCP 地址时选择目标 Agent 能访问的那个地址。不会改用 Cloudflare。');
    return;
  }
  if (kind === 'connector' && !target.connector) {
    const note = target.openai === 'starting'
      ? 'OpenAI Tunnel 正在启动。'
      : target.reason === 'direct_unavailable'
        ? '局域网直连当前不可用；不会改用 Cloudflare。'
        : target.reason === 'custom_unavailable'
          ? '自定义地址尚未配置；不会改用其它渠道。'
          : '当前选择的连接方式尚未就绪。';
    void window.showWarningMessage(`BlackHole: 连接器提示词已复制，但 ${note}`);
    return;
  }
  window.setStatusBarMessage(
    kind === 'sandbox' ? 'BlackHole: 沙箱提示词已复制'
      : target.mcpKind === 'direct' ? 'BlackHole: 连接器提示词已复制（直连）'
        : target.openai === 'ready' && (!target.mcpUrl || isLoopbackUrl(target.mcpUrl)) ? `BlackHole: 连接器提示词已复制（OpenAI Tunnel · @${connectorName}）`
          : 'BlackHole: 连接器提示词已复制',
    4000,
  );
}
