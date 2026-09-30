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
 * The channel is user-driven: never start/stop it behind the user's back.
 * A listener attached solely for an upgrade is not ready for session writes.
 * Verify the same live daemon health that reports the channels against the
 * manager's lifecycle revision, version and launch fingerprint first. Any
 * channel that can carry a connector prompt qualifies: Cloudflare/custom URL
 * or a serving OpenAI tunnel (plan R6); an OpenAI-only setup is not blocked.
 */
async function requireChannelReady(api: ControlApi, daemon: DaemonManager): Promise<boolean> {
  if (daemon.currentState !== 'running') {
    void window.showWarningMessage(DAEMON_NOT_READY);
    return false;
  }
  const observation = daemon.captureHealthObservation();
  let h: Awaited<ReturnType<ControlApi['health']>>;
  try {
    h = await api.health(8_000, observation.port);
  } catch {
    void window.showWarningMessage(DAEMON_NOT_READY);
    return false;
  }
  if (!daemon.observeHealth(h, observation) || daemon.currentState !== 'running') {
    void window.showWarningMessage(DAEMON_NOT_READY);
    return false;
  }
  const target = connectionTarget(h);
  if (target.connector) return true;
  void window.showWarningMessage(target.openai === 'starting'
    ? 'BlackHole: OpenAI 渠道正在启动，就绪后再创建会话。'
    : 'BlackHole: 还没有可用的连接渠道。请点击右下角状态图标打开设置，启动 Cloudflare（持久或临时）或 OpenAI 渠道后再创建会话。');
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
  if (!(await requireChannelReady(api, daemon))) return;

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

/**
 * OpenAI connectors use a Tunnel ID instead of a URL. Offer the saved ID (the
 * running one if it differs) rather than a loopback link nobody remote can use.
 */
async function offerTunnelId(message: string, activeId: string | null | undefined): Promise<void> {
  const id = (activeId || getConfig().openaiTunnelId || '').trim();
  const copy = '复制 Tunnel ID';
  if ((await (id ? window.showInformationMessage(message, copy) : window.showInformationMessage(message))) !== copy) return;
  await env.clipboard.writeText(id);
  window.setStatusBarMessage('BlackHole: Tunnel ID 已复制', 3000);
}

/** Copy the machine-level MCP URL — stable, so this needs no session credential. */
export async function copySessionUrl(api: ControlApi, node: SessionInfo): Promise<void> {
  const h = await api.health().catch(() => undefined);
  const url = h?.mcp_url;
  if (!url) {
    void window.showErrorMessage('BlackHole: 无法获取 MCP 链接（daemon 未运行）');
    return;
  }
  const target = connectionTarget(h);
  if (isLoopbackUrl(url) && target.openai === 'ready') {
    await offerTunnelId(
      'BlackHole: 当前只有 OpenAI 渠道，它不使用 MCP 链接。在 ChatGPT 开发者模式应用中选择 Connection「Tunnel」并选中这个 Tunnel ID 即可；会话用复制的连接器提示词开始。',
      h?.openai_tunnel?.active_tunnel_id,
    );
    return;
  }
  await env.clipboard.writeText(url);
  if (isLoopbackUrl(url)) {
    void window.showWarningMessage('BlackHole: 已复制的 MCP 链接当前是本机回环地址——公网渠道未启动，网页 AI 无法访问。请先在设置页启动渠道（点击右下角状态图标进入）。');
    return;
  }
  window.setStatusBarMessage(`BlackHole: MCP 链接已复制（所有会话共用，${sessionLabel(node)} 用各自的 id 区分）`, 3000);
}

/**
 * Copy a prompt template for a session. The MCP URL is machine-level (from
 * /health); the numeric session id is the CURRENT credential, re-fetched from
 * the daemon each time — nothing lives in extension memory, so a rotated
 * session automatically serves its fresh id on the next copy.
 */
export async function copyTemplateSession(api: ControlApi, node: SessionInfo, kind: TemplateKind, task?: string): Promise<void> {
  const [h, s] = await Promise.all([
    api.health().catch(() => undefined),
    api.getSession(node.id).catch(() => undefined),
  ]);
  const url = h?.mcp_url;
  const sessionId = s?.session_id;
  if (!url || !sessionId) {
    void window.showErrorMessage('BlackHole: 无法获取 MCP 链接或会话 id（daemon 未运行或会话不存在）');
    return;
  }
  const connectorName = getConfig().connectorName || 'BlackHole';
  const target = connectionTarget(h);
  // A sandbox prompt embeds an HTTP bootstrap URL: never hand out a loopback one.
  if (kind === 'sandbox' && (!target.sandbox || isLoopbackUrl(url))) {
    void window.showWarningMessage(target.openai === 'ready'
      ? `BlackHole: ${SANDBOX_NEEDS_PUBLIC_URL}未复制。`
      : 'BlackHole: 沙箱直连需要公网地址，请先在设置页启动 Cloudflare 渠道或配置自定义地址（点击右下角状态图标进入）。未复制。');
    return;
  }
  // The connector prompt is URL-free: it only needs some channel to be up.
  await env.clipboard.writeText(renderPrompt(kind, url, sessionId, task ?? node.name, connectorName));
  if (!target.connector) {
    void window.showWarningMessage('BlackHole: 连接器提示词已复制，但当前没有可用的连接渠道——请先在设置页启动 Cloudflare 或 OpenAI 渠道（点击右下角状态图标进入），网页 AI 才能调用。');
    return;
  }
  window.setStatusBarMessage(
    kind === 'sandbox' ? 'BlackHole: 沙箱直连提示词已复制'
      : target.publicUrl ? 'BlackHole: 连接器提示词已复制'
        : `BlackHole: 连接器提示词已复制（经 OpenAI 渠道：ChatGPT 中需有名为 @${connectorName} 的 Tunnel 应用）`,
    4000,
  );
}
