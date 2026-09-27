import { realpathSync } from 'node:fs';
import path from 'node:path';
import { env, window, workspace } from 'vscode';
import type { ControlApi, SessionAction, SessionInfo } from './controlApi';
import type { DaemonManager } from './daemonManager';
import { getConfig } from './config';
import { renderPrompt, type TemplateKind } from './templates';

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

/**
 * Optional task text: doubles as the session's display name and is inserted
 * into the copied prompt templates. Empty keeps the default behavior.
 */
async function askTask(): Promise<string | undefined> {
  const task = await window.showInputBox({
    title: '任务内容（可选）',
    prompt: '一句话描述要交给远程 AI 的任务；留空则稍后在提示词里手动填写',
    placeHolder: '例：修复 src/api.ts 里登录接口的空指针并补一个测试',
    ignoreFocusOut: false,
  });
  // undefined = cancelled the whole creation; '' = no task (default behavior)
  return task;
}

const DAEMON_NOT_READY = 'BlackHole: daemon 正在启动或配置交接中，尚未确认就绪。请稍后重试；如持续失败，请查看输出面板。';

/**
 * The channel is user-driven: never start/stop it behind the user's back.
 * A listener attached solely for an upgrade is not ready for session writes.
 * Verify the same live daemon health that provides the public URL against the
 * manager's lifecycle revision, version and launch fingerprint first.
 */
async function requireChannelReady(api: ControlApi, daemon: DaemonManager): Promise<string | undefined> {
  if (daemon.currentState !== 'running') {
    void window.showWarningMessage(DAEMON_NOT_READY);
    return undefined;
  }
  const observation = daemon.captureHealthObservation();
  let h: Awaited<ReturnType<ControlApi['health']>>;
  try {
    h = await api.health(8_000, observation.port);
  } catch {
    void window.showWarningMessage(DAEMON_NOT_READY);
    return undefined;
  }
  if (!daemon.observeHealth(h, observation) || daemon.currentState !== 'running') {
    void window.showWarningMessage(DAEMON_NOT_READY);
    return undefined;
  }
  if (h.tunnel === 'online' && h.tunnel_url) return h.tunnel_url;
  if (h.public_base_url) return h.public_base_url;
  void window.showWarningMessage(
    'BlackHole: 公网渠道未启动。请点击右下角状态图标打开设置，启动「持久」或「临时」渠道后再创建会话。',
  );
  return undefined;
}

export async function createSession(api: ControlApi, daemon: DaemonManager, after: () => void): Promise<void> {
  const folder = await pickFolder();
  if (!folder) return;
  const task = await askTask();
  if (task === undefined) return;
  if (!(await daemon.ensureRunning())) return;
  const publicUrl = await requireChannelReady(api, daemon);
  if (!publicUrl) return;

  let created;
  try {
    created = await api.createSession(folder, task);
  } catch (e) {
    void window.showErrorMessage(`BlackHole: 创建会话失败 — ${msg(e)}`);
    return;
  }
  after();
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

/** Copy the machine-level MCP URL — stable, so this needs no session credential. */
export async function copySessionUrl(api: ControlApi, node: SessionInfo): Promise<void> {
  const h = await api.health().catch(() => undefined);
  const url = h?.mcp_url;
  if (!url) {
    void window.showErrorMessage('BlackHole: 无法获取 MCP 链接（daemon 未运行）');
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
export async function copyTemplateSession(api: ControlApi, node: SessionInfo, kind: TemplateKind): Promise<void> {
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
  await env.clipboard.writeText(renderPrompt(kind, url, sessionId, node.name, connectorName));
  if (isLoopbackUrl(url)) {
    void window.showWarningMessage('BlackHole: 提示词已复制，但其中的 MCP 链接当前是本机回环地址——公网渠道未启动，网页 AI 无法访问。请先在设置页启动渠道（点击右下角状态图标进入）后再复制。');
    return;
  }
  window.setStatusBarMessage(
    kind === 'connector' ? 'BlackHole: 连接器提示词已复制' : 'BlackHole: 沙箱直连提示词已复制',
    3000,
  );
}
