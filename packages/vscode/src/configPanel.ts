import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { commands, ConfigurationTarget, ViewColumn, Uri, env, window, workspace, type Disposable, type Memento, type WebviewPanel } from 'vscode';
import type { AuthView } from './cloudAuthClient';
import type { ApprovalGrantsInfo, ControlApi, ProxiesInfo, ProxiesRevalidateReport, ProxyToolsResult } from './controlApi';
import type { DaemonManager } from './daemonManager';
import type { Poller } from './poller';
import { addCustomAgent, AGENTS, customAgents, removeCustomAgent } from './webAgents';
import { decideSyncAction, EMPTY_ANCHORS, mergeAnchors, readAnchors, type SyncAnchors } from './proxySync';
import { PRODUCTION_CLOUD_ORIGIN, resolveCloudEndpoint } from './cloudEnvironment';

import qrcode from 'qrcode-generator';
import type { RemoteView } from './controlApi';
import type { SettingsSync } from './settingsSync';

/** Configuration preview only. The daemon's session-scoped skill catalog owns
 * validity, precedence and diagnostics; this count is never a usable-skill count. */
export function skillDirectoryStatus(configured: string, home = os.homedir()): { directory: string; hint: string; cls: string } {
  const custom = configured.trim();
  const directory = custom
    ? path.resolve(custom === '~' ? home : /^~[\\/]/.test(custom) ? path.join(home, custom.slice(2).replace(/[\\/]/g, path.sep)) : custom)
    : path.join(home, '.agents', 'skills');
  const scope = custom ? '自定义目录' : '默认用户目录';
  try {
    let existing = directory;
    for (;;) {
      try { fs.lstatSync(existing); break; }
      catch (error) {
        const parent = path.dirname(existing);
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === existing) throw error;
        existing = parent;
      }
    }
    if (!fs.statSync(existing).isDirectory()) return { directory, cls: 'bad', hint: `${scope}路径或父路径不是目录；请修正配置。` };
    if (existing !== directory) return { directory, cls: custom ? 'bad' : '',
      hint: custom ? '自定义目录不存在，不会回退到默认用户目录；会话仍会检查项目 Skill。'
        : `默认目录尚未创建：${directory}；会话仍会检查项目 Skill。` };
    let count = 0;
    for (const name of fs.readdirSync(directory)) {
      try {
        const dir = path.join(directory, name);
        if (fs.statSync(dir).isDirectory() && fs.statSync(path.join(dir, 'SKILL.md')).isFile()) count++;
      } catch { /* This is only a structural preview, not skill validation. */ }
    }
    return { directory, cls: count ? 'ok' : '',
      hint: `${scope}有 ${count} 个 Skill。` };
  } catch { return { directory, cls: 'bad', hint: `${scope}无法读取或链接失效；完整 Skill 发现可能失败，请修正配置。` }; }
}

interface Field {
  key: string;
  label: string;
  desc: string;
  type: 'string' | 'number' | 'select';
  options?: readonly { value:string; label:string }[];
  advanced?: boolean;
}

const ALL_FIELDS: Field[] = [
  { key: 'cloudflaredPath', label: 'cloudflared 路径', desc: '公网渠道需要 cloudflared。安装后填写可执行文件的完整路径。', type: 'string' },
  { key: 'publicBaseUrl', label: '公网地址', desc: '填写 HTTP(S) Base URL；BlackHole 会自动生成 MCP 链接。HTTP 为明文传输。', type: 'string' },
  { key: 'openaiTunnelClientPath', label: 'tunnel-client 路径', desc: 'OpenAI 官方 tunnel-client（纯 runtime 版）可执行文件的完整路径。启动 OpenAI 渠道只使用这里保存的路径；留空时「一键安装」会依次查找 PATH 与一键安装目录，验证后自动保存，无需重启 daemon。', type: 'string' },
  { key: 'openaiTunnelId', label: 'Tunnel ID', desc: '在 OpenAI Platform 的隧道设置中复制的 Tunnel ID（不是 URL，也不是密钥）。', type: 'string' },
  { key: 'tunnelProbeProxy', label: '公网连通性检测代理（排障用）', desc: '通常留空。仅当提示“公网地址已在线，但本机无法完成检测”，并且电脑正在使用 Clash、mihomo 等本机代理时，填写该代理的本机 HTTP 地址（例如 http://127.0.0.1:7897）。这里只影响公网地址检测，不会修改其他网络连接；修改后需重启本地服务。', type: 'string', advanced: true },
  { key: 'gitUsrBinPath', label: 'GNU 工具目录 (Git usr/bin)', desc: 'grep/sed/awk/find 所在目录（Git for Windows 安装目录下的 usr/bin）。会加入 BlackHole exec/process 的 PATH，但不会把 shell 切换为 Bash；留空则不改 PATH。', type: 'string', advanced: true },
  { key: 'skillsDir', label: '自定义 Skill 目录', desc: '留空使用 ~/.agents/skills。填写后替代这个默认库；项目里的 .agents/skills 仍然有效且优先。建议填绝对路径或 ~/ 开头的路径。', type: 'string' },
  { key: 'connectorName', label: '连接器名称', desc: '复制连接器提示词时 @提及的名字。多人共用一个网页 AI 账号时，各自起名区分自己的连接器。留空 = BlackHole。', type: 'string' },
  { key: 'port', label: 'daemon 端口', desc: '本地 daemon 监听端口（仅 127.0.0.1）。', type: 'number', advanced: true },
  { key: 'namedTunnelName', label: 'named tunnel 名称', desc: '持久渠道执行的 cloudflared tunnel run <名称>。', type: 'string', advanced: true },
  { key: 'daemonEntry', label: '自定义本地服务入口（开发用）', desc: '开发时指向仓库编译后的 dist/cli.js；需先 pnpm build，再重启 daemon。只替换本地后端，不更新插件界面或切换云端服务；正常使用留空。', type: 'string', advanced: true },
  { key: 'pollIntervalMs', label: '轮询间隔（毫秒）', desc: '窗口聚焦时轮询 daemon 的频率。', type: 'number', advanced: true },
];

const FIELDS = ALL_FIELDS.filter(f => f.key !== 'daemonEntry' || resolveCloudEndpoint().environment === 'test');
const KEYS = FIELDS.map((f) => f.key);
/** Settings the daemon only reads at spawn: a change must restart it. */
const RESTART_KEYS = new Set(['port', 'publicBaseUrl', 'tunnelProbeProxy', 'cloudflaredPath', 'gitUsrBinPath', 'daemonEntry', 'namedTunnelName', 'skillsDir']);
/**
 * 改完就生效、不在 daemon 启动指纹里的设置：选中或离开输入框即自动保存（用户 2026-10-03）。
 * 会触发 daemon 重启的设置仍由「保存」按钮提交，避免每改一个字段就重启一次。
 */
const AUTO_SAVE_KEYS = new Set(['channelMode', 'connectorName', 'openaiTunnelClientPath', 'openaiTunnelId', 'pollIntervalMs']);
/** 渠道总开关缺前提时的提示：告诉用户在本页哪里补上。 */
const CHANNEL_SWITCH_ERRORS: Record<string, string> = {
  cloudflared: '还没有 cloudflared：在下方「公网渠道 → Cloudflare」点「一键初始化安装」。',
  named_url: '持久渠道还没有填公网地址：在下方「公网渠道 → Cloudflare」填写。',
  openai_setup: 'OpenAI 渠道还没配置完：在下方「公网渠道 → OpenAI」填写 Tunnel ID、tunnel-client 和密钥。',
  openai_unavailable: '当前 daemon 不支持 OpenAI 渠道。',
  start_failed: '渠道没有启动，原因见下方公网渠道卡片。',
};
/** Same rule as the daemon's settings store: a Tunnel ID, never a URL. */
const OPENAI_TUNNEL_ID = /^tunnel_[0-9a-f]{32}$/;
/** OpenAI onboarding pages the panel may open (developers.openai.com secure-mcp-tunnels guide). */
const OPENAI_LINKS = new Map([
  ['platform', 'https://platform.openai.com/settings/organization/tunnels'],
  ['chatgpt', 'https://chatgpt.com/plugins'],
]);
type OpenAIAction = 'start' | 'stop' | 'saveKey' | 'clearKey' | 'diagnostics';
/** Fixed daemon codes → copy; anything else falls back to the daemon's own reason text. */
const OPENAI_ERRORS: Record<string, string> = {
  openai_tunnel_unsupported: '当前 daemon 不支持 OpenAI 渠道；请重启 daemon 以加载新版本。',
  openai_tunnel_unavailable: '当前 daemon 不支持 OpenAI 渠道；请重启 daemon 以加载新版本。',
  unsaved_settings: 'Tunnel ID 或 tunnel-client 路径有未保存的修改；请先点击保存。',
  empty_api_key: '请先输入 Runtime API Key。',
  invalid_api_key: 'Runtime API Key 格式不正确（8–1024 个可见字符，不能含空格）。',
  settings_changed: '设置刚刚发生变化；请重试。',
  settings_changed_elsewhere: 'Tunnel ID 或 tunnel-client 路径刚在别处（如 Web 设置页）修改，已显示最新值；请确认后再启动。',
  revision_conflict: '设置刚刚发生变化；请重试。',
  settings_unavailable: 'daemon 设置暂不可用；请稍后重试。',
  credential_changed: '密钥刚刚在别处被修改；请重试。',
  already_running: 'OpenAI 渠道正以不同的配置运行；请先停止再启动。',
  run_changed: '渠道已被其他窗口重新启动；请刷新状态后重试。',
  daemon_changed: 'daemon 已重启；请重试。',
  cancelled: '启动已被取消。',
  native_loopback_required: '请求被拒绝：仅允许本机扩展调用。',
  credential_store_unavailable: '无法读写本机保存的 Runtime API Key。',
  credential_store_timeout: '读写 Runtime API Key 超时；请稍后重试。',
  credential_store_failed: '保存 Runtime API Key 失败；密钥状态已重新读取。',
  credential_delete_unconfirmed: '无法确认密钥已删除；请稍后重试。',
};
type ChannelMode = 'cloudflare' | 'openai' | 'custom';
const normalizeChannelMode = (v: unknown): ChannelMode => (v === 'custom' || v === 'openai' ? v : 'cloudflare');

import { SETTINGS_PAGES, SETTINGS_LABELS, renderSettingsIcon, renderSettingsNavItems, type SettingsPage } from '../../contracts/src/settings-navigation';
import { copyCurrentConnection } from './sessionActions';
const LEGACY_SETTINGS_PAGE: Readonly<Record<string, SettingsPage>> = {
  overview: 'home', channel: 'connections', mcp: 'connections', common: 'agents',
  proxies: 'agents', grants: 'security', account: 'account', advanced: 'advanced',
};
function settingsPageOf(value: unknown, fallback: SettingsPage = 'home'): SettingsPage {
  const raw = typeof value === 'string'
    ? value
    : value && typeof value === 'object' && 'page' in value ? (value as { page?: unknown }).page : undefined;
  if (typeof raw !== 'string') return fallback;
  if ((SETTINGS_PAGES as readonly string[]).includes(raw)) return raw as SettingsPage;
  return LEGACY_SETTINGS_PAGE[raw] ?? fallback;
}
function accountSummaryForPanel(view: AuthView): {
  authState: AuthView['state']; displayName: string; email: string | null; accountStatus: string | null;
  remainingSeconds: number | null; serviceExpiresAt: number | null; checkedAt: number | null; canSignOut: boolean;
} {
  const userId = view.state !== 'logged_out' ? view.userId?.trim() || '' : '';
  const a = userId ? view.account : undefined;
  const name = a?.name?.trim() || '';
  const email = a?.email?.trim() || null;
  const remaining = userId && typeof view.remainingSeconds === 'number' && Number.isFinite(view.remainingSeconds)
    ? Math.max(0, Math.floor(view.remainingSeconds)) : null;
  return {
    authState: view.state,
    displayName: name || email || (userId ? (userId.length > 14 ? userId.slice(0, 8) + '…' + userId.slice(-4) : userId) : view.state === 'logged_out' ? '未登录' : '账号状态待确认'),
    email,
    accountStatus: a?.status ?? null,
    remainingSeconds: remaining,
    serviceExpiresAt: typeof a?.serviceExpiresAt === 'number' && Number.isFinite(a.serviceExpiresAt) ? Math.max(0, Math.floor(a.serviceExpiresAt)) : null,
    checkedAt: userId && typeof view.checkedAt === 'number' && Number.isFinite(view.checkedAt) ? view.checkedAt : null,
    canSignOut: !!userId,
  };
}
function formatRemainingForPanel(seconds: number | null): string {
  if (seconds === null) return '时长待确认';
  if (seconds <= 0) return '订阅已到期';
  if (seconds < 60) return '剩余不足 1 分钟';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `剩余 ${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  if (hours < 24) return `剩余 ${hours} 小时${remMin ? ` ${remMin} 分钟` : ''}`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return `剩余 ${days} 天${remHours ? ` ${remHours} 小时` : ''}`;
}

type PanelMessage =
  | { type: 'ready' }
  | { type: 'settingsUi'; page?: string; collapsed?: boolean }
  | { type: 'cloudAccount'; action: 'signIn' | 'redeem' | 'signOut' | 'refresh' | 'buyCard' | 'orders' | 'refund'; sku?: 'pro_day'|'pro_week'|'pro_month' }
  | { type: 'copyUserId'; userId: string }
  | { type: 'save'; values: Record<string, string>; webAgents?: string[] }
  | { type: 'autosave'; values: Record<string, string>; webAgents?: string[] }
  | { type: 'channelToggle'; on: boolean }
  | { type: 'restart' }
  | { type: 'tunnel'; action: 'quick' | 'named' | 'stop' | 'copy' }
  | { type: 'installCloudflared'; path: string; channelMode: 'cloudflare' | 'openai' | 'custom' }
  | { type: 'installOpenaiTunnel'; path: string }
  | { type: 'openaiTunnel'; action: OpenAIAction; key?: string; tunnelId?: string; clientPath?: string }
  | { type: 'customProbe'; url: string }
  | { type: 'rotateToken' }
  | { type: 'grantRemove'; scope: 'always' | 'session'; key: string; sessionId?: string }
  | { type: 'remote'; action: 'pair' | 'revoke' | 'probe'; id?: string; name?: string; origin?: string; requestId?: number }
  | { type: 'grantsClear' }
  | { type: 'courierSiteRemove'; id: string }
  | { type: 'directAccessToggle'; on: boolean; url?: string }
  | { type: 'directPort'; port: number }
  | { type: 'directAccessUrl'; url: string }
  | { type: 'channelProxyUrl'; url: string }
  | { type: 'aiDefaultRoute'; route: 'auto' | 'direct' | 'cloudflare' | 'custom' | 'openai' }
  | { type: 'copyConnection' }
  | { type: 'copyUrl'; url: string }
  | { type: 'copyConnectorDesc' }
  | { type: 'copyTunnelId' }
  | { type: 'openLink'; target: string }
  | { type: 'addCustomAgent'; name: string; url: string }
  | { type: 'removeCustomAgent'; name: string }
  | { type: 'semanticSave'; key: string }
  | { type: 'semanticClear' }
  | { type: 'proxiesRevalidate' }
  | { type: 'proxiesEdit'; server: string; fields: Record<string, unknown> }
  | { type: 'proxiesAdd'; server: Record<string, unknown> }
  | { type: 'proxiesImport'; json: string }
  | { type: 'proxiesTools'; server: string; refresh?: boolean }
  | { type: 'proxiesRemove'; server: string }
  | { type: 'proxiesToggleForm'; form: 'add' | 'import' };
/** Middle-workspace configuration page: channel controls + overview + fields. */
export class ConfigPanel {
  private static panel: ConfigPanel | undefined;

  static open(api: ControlApi, daemon: DaemonManager, poller: Poller, settingsSync?: SettingsSync, uiState?: Memento, route?: unknown): void {
    const page = route === undefined ? null : settingsPageOf(route);
    if (ConfigPanel.panel) {
      ConfigPanel.panel.reveal();
      if (page) void ConfigPanel.panel.navigate(page);
      return;
    }
    ConfigPanel.panel = new ConfigPanel(api, daemon, poller, settingsSync, uiState, page);
  }

  private webview: WebviewPanel;
  private readonly tick: Disposable;
  private lastUrl: string | null = null;
  private readonly daemonTick: Disposable;
  /**
   * v2.6 daemon 同步锚点：工具列表必须属于"当前实际连接的 daemon"。
   * 判定逻辑抽到 ./proxySync（纯函数，可单测）；这里只持有锚点状态。
   * daemonId / surfaceGen / connGen 三条都由 1s 状态轮询驱动，不依赖任何手动按钮。
   */
  private anchors: SyncAnchors = { ...EMPTY_ANCHORS };
  private disposed = false;
  private pollBusy = false;
  private cloudflaredInstallBusy = false;
  private openaiInstallBusy = false;
  private openaiBusy = false;
  private channelBusy = false;
  private lastProxies: ProxiesInfo | null = null;
  private proxySignature = '';
  private projectionGeneration = 0;
  private toolRequests = new Map<string, Promise<void>>();
  private toolVersions = new Map<string, number>();
  /** Browser-side message listener has announced readiness. */
  private webviewReady = false;
  private remoteTick = 0;
  private remoteIds: Set<string> | null = null;
  /** pairing requests already shown as a notification */
  private remoteAsked = new Set<string>();
  /** Semantic state is fetched once per daemon lifetime; false retries after startup races. */
  private semanticSynced = false;

  private constructor(
    private readonly api: ControlApi,
    private readonly daemon: DaemonManager,
    poller: Poller,
    /** Knows which side changed a setting; absent in older wiring (then VS Code values win, as before). */
    private readonly settingsSync?: SettingsSync,
    private readonly uiState?: Memento,
    private requestedPage: SettingsPage | null = null,
  ) {
    this.webview = window.createWebviewPanel('blackholeSettings', 'BlackHole 设置', ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    // keep the channel section live while the page is open; 'status' messages
    // only touch the overview/buttons, never the form being edited
    this.tick = poller.onTick(() => void this.poll());
    // The panel may open while extension activation is still starting the daemon.
    // Refresh semantic state as soon as that startup completes instead of leaving
    // the first offline snapshot visible until the operator saves something.
    this.daemonTick = daemon.onDidChangeState((state) => {
      this.semanticSynced = false;
      if (state === 'running' && this.webviewReady && !this.disposed) void this.postSemantic();
    });
    this.webview.onDidDispose(() => {
      this.disposed = true;
      this.webviewReady = false;
      if (ConfigPanel.panel === this) ConfigPanel.panel = undefined;
      this.tick.dispose();
      this.daemonTick.dispose();
    });
    // Register the host listener BEFORE loading the HTML. The webview sends a
    // `ready` handshake after its own message listener/buttons are installed;
    // only then do we publish init/proxy state. Posting immediately after
    // assigning html races the first page load and can leave an old offline
    // proxy frame visible until a later manual toggle.
    this.webview.webview.onDidReceiveMessage((m: PanelMessage) => {
      // All actions report their own failure: void'd promises swallow throws,
      // which used to make 保存/添加 fail completely silently.
      void this.dispatch(m).catch((e) => {
        if (this.disposed) return;
        const msg = e instanceof Error ? e.message : String(e);
        // 新增配置项要等扩展宿主重启才会进 VS Code 的配置注册表；窗口运行中
        // 升级扩展时写入会被 "没有注册配置" 拒绝 —— 指向完全重启。
        const hint = /没有注册|not registered/i.test(msg) ? ' —— 该配置项为本版本新增，请完全退出并重新打开 VS Code 后重试' : '';
        void window.showErrorMessage(`BlackHole: 操作失败 — ${msg}${hint}`);
      });
    });
    this.webview.webview.html = this.html();
  }

  /** Async replies belong to this panel instance; a closed panel is not an error. */
  private async post(message: unknown): Promise<boolean> {
    if (this.disposed || !this.webviewReady) return false;
    try { return await this.webview.webview.postMessage(message); }
    catch (error) {
      if (!this.disposed) console.error('BlackHole: could not update settings view', error);
      return false;
    }
  }

  private async poll(): Promise<void> {
    if (this.disposed || !this.webviewReady || !this.webview.visible || this.pollBusy) return;
    this.pollBusy = true;
    try { await Promise.all([this.status(), this.accountStatus()]); }
    catch (error) { if (!this.disposed) console.error('BlackHole: settings refresh failed', error); }
    finally { this.pollBusy = false; }
  }

  private async dispatch(m: PanelMessage): Promise<void> {
    if (this.disposed) return;
    if (m.type === 'settingsUi') {
      const page = settingsPageOf(m.page, this.uiState?.get<SettingsPage>('blackhole.settingsLastPage.v1', 'home') ?? 'home');
      if (typeof m.page === 'string') await this.uiState?.update('blackhole.settingsLastPage.v1', page);
      if (typeof m.collapsed === 'boolean') await this.uiState?.update('blackhole.settingsNavCollapsed.v1', m.collapsed);
      return;
    }
    if(m.type==='cloudAccount'){
      const actions={signIn:'blackhole.accountSignIn',redeem:'blackhole.accountRedeemCard',signOut:'blackhole.accountSignOut',refresh:'blackhole.accountRefresh',buyCard:'blackhole.accountBuyCard',orders:'blackhole.accountOrders',refund:'blackhole.accountRefund'};
      if(Object.hasOwn(actions,m.action))await commands.executeCommand(actions[m.action],...(m.action==='buyCard'?[m.sku,true]:[]));await this.accountStatus();return;
    }
    if(m.type==='copyUserId'){
      await env.clipboard.writeText(m.userId);
      void window.showInformationMessage('BlackHole：用户 ID 已复制。');
      return;
    }
    if (m.type === 'ready') {
      if (this.webviewReady) return;
      this.webviewReady = true;
      await this.refresh();
      const page = this.requestedPage ?? this.uiState?.get<SettingsPage>('blackhole.settingsLastPage.v1', 'home') ?? 'home';
      const collapsed = this.uiState?.get<boolean>('blackhole.settingsNavCollapsed.v1', false) ?? false;
      if (this.requestedPage) await this.uiState?.update('blackhole.settingsLastPage.v1', page);
      await this.post({ type: 'settingsUiRestore', page, collapsed });
    }
    else if (m.type === 'save') await this.save(m.values, m.webAgents);
    else if (m.type === 'autosave') await this.autosave(m.values, m.webAgents);
    else if (m.type === 'channelToggle' && typeof m.on === 'boolean') await this.channelToggle(m.on);
    else if (m.type === 'restart') {
      try { await this.daemon.restart(); void window.showInformationMessage('BlackHole：daemon 已重启。'); }
      catch (e) { void window.showErrorMessage(`BlackHole：重启 daemon 失败 — ${e instanceof Error ? e.message : String(e)}`); }
      await this.status();
    }
    else if (m.type === 'tunnel') await this.tunnelAction(m.action);
    else if (m.type === 'installCloudflared') await this.installCloudflared(m.path, m.channelMode);
    else if (m.type === 'installOpenaiTunnel') await this.installOpenaiTunnel(m.path);
    else if (m.type === 'openaiTunnel') await this.openaiTunnel(m);
    else if (m.type === 'customProbe') await this.customProbe(m.url);
    else if (m.type === 'rotateToken') await this.rotateToken();
    else if (m.type === 'grantRemove') await this.grantRemove(m.scope, m.key, m.sessionId);
    else if (m.type === 'remote') await this.remoteAction(m);
    else if (m.type === 'grantsClear') await this.grantsClear();
    else if (m.type === 'courierSiteRemove' && typeof m.id === 'string') await this.courierSiteRemove(m.id);
    else if (m.type === 'directAccessToggle' && typeof m.on === 'boolean') await this.directToggle(m.on, m.url);
    else if (m.type === 'directPort' && Number.isInteger(m.port)) await this.saveDaemonSettings({ directPort: m.port });
    else if (m.type === 'directAccessUrl' && typeof m.url === 'string') await this.saveDaemonSettings({ directAccessUrl: m.url.trim() });
    else if (m.type === 'channelProxyUrl' && typeof m.url === 'string') await this.saveDaemonSettings({ channelProxyUrl: m.url.trim() });
    else if (m.type === 'aiDefaultRoute') await this.saveDaemonSettings({ aiDefaultRoute: m.route });
    else if (m.type === 'copyConnection') await copyCurrentConnection(this.api);
    else if (m.type === 'copyUrl' && m.url) { await env.clipboard.writeText(m.url); void window.showInformationMessage('BlackHole：MCP 链接已复制。'); }
    else if (m.type === 'copyConnectorDesc') await this.copyConnectorDesc();
    else if (m.type === 'copyTunnelId') await this.copyTunnelId();
    else if (m.type === 'openLink') await this.openLink(m.target);
    else if (m.type === 'addCustomAgent') await this.addCustomAgent(m.name, m.url);
    else if (m.type === 'removeCustomAgent') await this.removeCustomAgent(m.name);
    else if (m.type === 'semanticSave') await this.semanticSave(m.key);
    else if (m.type === 'semanticClear') await this.semanticClear();
    else if (m.type === 'proxiesRevalidate') await this.proxiesRevalidate();
    else if (m.type === 'proxiesEdit') await this.proxiesEdit(m.server, m.fields);
    else if (m.type === 'proxiesAdd') await this.proxiesAdd(m.server);
    else if (m.type === 'proxiesImport') await this.proxiesImport(m.json);
    else if (m.type === 'proxiesTools') await this.proxiesTools(m.server, m.refresh === true);
    else if (m.type === 'proxiesRemove') await this.proxiesRemove(m.server);
    else if (m.type === 'proxiesToggleForm') await this.togglePxForm(m.form);
  }

  private reveal(): void {
    this.webview.reveal(ViewColumn.One);
  }

  private async navigate(page: SettingsPage): Promise<void> {
    this.requestedPage = page;
    await this.uiState?.update('blackhole.settingsLastPage.v1', page);
    if (this.webviewReady) await this.post({ type: 'settingsNavigate', page });
  }

  /** Full reload: form values + overview (open, after save, after custom-agent edits). */
  private async accountStatus():Promise<void> {
    const view=await commands.executeCommand<AuthView>('blackhole.accountSnapshot');
    const safe=view??{state:'unavailable' as const};
    const summary=accountSummaryForPanel(safe);
    await this.post({type:'cloudAccount',view:safe,summary:{...summary,remainingLabel:formatRemainingForPanel(summary.remainingSeconds)}});
  }

  private async refresh(): Promise<void> {
    if (this.disposed || !this.webviewReady) return;
    await this.accountStatus();
    if (this.disposed) return;
    const values: Record<string, string> = {};
    const c = workspace.getConfiguration('blackhole');
    for (const k of KEYS) values[k] = String(c.get(k) ?? '');
    values.channelMode = normalizeChannelMode(c.get<string>('channelMode'));
    const enabled = new Set(c.get<string[]>('webAgents') ?? AGENTS.map((a) => a.name));
    const webAgents = AGENTS.filter((a) => enabled.has(a.name)).map((a) => a.name);
    const custom = customAgents().map((a) => ({ name: a.name, url: a.url }));
    const semanticMode = c.get<string>('semanticMode') ?? 'explicit';
    // Preview the chosen user library; project discovery happens per session.
    const skillsDir = (c.get<string>('skillsDir') ?? '').trim();
    const { hint: skillsHint, cls: skillsCls } = skillDirectoryStatus(skillsDir);
    // GET /semantic 的 would_resolve 在 auto 模式下会真的去快照本机 Devin/Windsurf
    // 凭据库（毫秒级但不是免费的）：只在整页刷新时取一次，不跟 1s 状态轮询
    const ov = await this.overview(true);
    this.syncAnchors(ov); // 整页重读 = 以当前 daemon 为准，重置同步锚点
    if (this.disposed) return;
    await this.post({ type: 'init', values, agents: AGENTS.map((a) => ({ name: a.name, description: a.description })), webAgents, custom, skillsHint, skillsCls, semanticMode, overview: ov });
    // Viewing settings must not start upstreams or download packages.
    await this.pushProxies();
    await this.pushGrants();
    await this.pushCourierSites();
    await this.pushDirect();
    await this.pushRemote();
  }

  /** 把 overview 里的 daemon 身份/代次写进本地锚点（整页重读 = 以当前 daemon 为准）。 */
  private syncAnchors(ov: Record<string, unknown>): void {
    this.anchors = readAnchors(ov);
  }

  /** Periodic refresh: overview + channel buttons only, form untouched. */
  private async status(): Promise<void> {
    if (this.disposed || !this.webviewReady) return;
    const overview = await this.overview();
    if (this.disposed) return;
    await this.post({ type: 'status', overview });
    if (++this.remoteTick % 3 === 0) { void this.pushRemote(); void this.pushCourierSites(); void this.pushDirect(); }
    if (!this.semanticSynced && overview.daemon === 'running' && overview.version) void this.postSemantic();
    const next = readAnchors(overview);
    const action = decideSyncAction(this.anchors, next);
    this.anchors = mergeAnchors(this.anchors, next);
    if (action === 'reload') {
      // Invalidate old instance data, not the operator's unsaved form.
      this.lastProxies = null;
      this.proxySignature = '';
      this.projectionGeneration++;
      this.toolRequests.clear();
      for (const name of this.toolVersions.keys()) this.toolVersions.set(name, this.toolVersions.get(name)! + 1);
      await this.post({ type: 'proxiesReset' });
    }
    // Metadata is cheap and side-effect-free. This also reflects a lazy upstream's
    // first connection without requiring an MCP reconnect or restarting the daemon.
    await this.pushProxies();
  }

  private async overview(includeSemantic = false): Promise<Record<string, unknown>> {
    // 渠道总开关是可选的：旧版 daemon 没有 /channel 时为 null（驾驶舱不显示开关）。
    const [health, channel] = await Promise.all([
      this.api.health().catch(() => undefined),
      Promise.resolve().then(() => this.api.channel()).catch(() => null),
    ]);
    if (!health) {
      this.lastUrl = null;
      return { daemon: this.daemon.currentState, version: null, daemon_id: null, proxy_surface_gen: null, mcp_conn_gen: null, openai_tunnel: null, openai_tunnel_id: this.savedTunnelId(), tunnel: 'unreachable', tunnel_mode: null, tunnel_url: null, tunnel_reason: null, public_base_url: null, mcp_url: null, mcp_path: null, semantic: null, channel: null };
    }
    this.lastUrl = health.tunnel_url;
    // Devin Key 卡片随状态轮询自愈：保存/重启后无需手动刷新页面
    const semantic = includeSemantic
      ? await this.api.semanticInfo().then(
          (s) => ({ registered: s.registered, registered_source: s.registered_source, registered_preview: s.registered_preview, would_resolve: s.would_resolve }),
          () => null,
        )
      : undefined;
    return {
      daemon: this.daemon.currentState,
      version: health.version,
      daemon_id: health.daemon_id ?? null,
      proxy_surface_gen: health.proxy_surface_gen ?? null,
      mcp_conn_gen: health.mcp_conn_gen ?? null,
      tunnel: health.tunnel,
      tunnel_mode: health.tunnel_mode,
      tunnel_url: health.tunnel_url,
      tunnel_reason: health.tunnel_reason,
      public_base_url: health.public_base_url,
      mcp_url: health.mcp_url,
      connection_routes: health.connection_routes ?? null,
      mcp_path: health.mcp_path ?? null,
      openai_tunnel: health.openai_tunnel ?? null,
      openai_tunnel_id: health.connection_routes ? health.connection_routes.saved_tunnel_id ?? null : this.savedTunnelId(),
      stats: health.stats ?? null,
      activity_days: health.activity_days ?? [],
      channel,
      ...(semantic !== undefined ? { semantic } : {}),
    };
  }

  /** 驾驶舱里的渠道总开关：和侧边栏同一个 daemon 接口；缺前提时把页面切到对应渠道并提示。 */
  private async channelToggle(on: boolean): Promise<void> {
    if (this.channelBusy) return;
    this.channelBusy = true;
    let code = '';
    let message = '';
    try {
      const r = await this.api.channelSwitch(on);
      if (!r.ok) { code = r.error; message = CHANNEL_SWITCH_ERRORS[r.error] ?? `渠道没有启动（${r.error}）。`; }
    } catch (e) {
      message = `操作失败：${e instanceof Error ? e.message : String(e)}`;
    } finally {
      this.channelBusy = false;
    }
    if (this.disposed) return;
    await this.post({ type: 'channelToggleResult', ok: !message, code, message });
    await this.status();
  }

  /**
   * Rotate the machine-level MCP token: a NEW machine URL takes effect
   * immediately and persists across daemon restarts; connectors configured
   * with the old URL stop working until re-configured.
   */
  /** Drop ONE standing grant key from either the machine-wide or session scope. */
  private async grantRemove(scope: 'always' | 'session', key: string, sessionId?: string): Promise<void> {
    const pick = await window.showWarningMessage(`BlackHole：删除这条${scope === 'session' ? '会话' : '全局'}授权后，相关操作会重新询问。`, { modal: true }, '删除授权');
    if (pick !== '删除授权' || this.disposed) return;
    try {
      if (scope === 'session') {
        if (!sessionId) throw new Error('missing session id');
        await this.api.removeSessionGrant(sessionId, key);
      } else {
        await this.api.removeAlwaysGrant(key);
      }
      await this.pushGrants();
      void window.showInformationMessage('BlackHole：授权已删除。');
    } catch (e) {
      void window.showErrorMessage(`BlackHole: 删除授权失败 — ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Drop every persistent always-grant (settings-page button). */
  private async grantsClear(): Promise<void> {
    const pick = await window.showWarningMessage('BlackHole：清除全部全局授权后，相关操作会重新询问。', { modal: true }, '清除全部');
    if (pick !== '清除全部' || this.disposed) return;
    try {
      await this.api.clearAlwaysGrants();
      await this.pushGrants();
      void window.showInformationMessage('BlackHole：全部全局授权已清除。');
    } catch (e) {
      void window.showErrorMessage(`BlackHole: 清除授权失败 — ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Publish every effective standing grant to the webview. */
  /** Phone access section (plan 6.13 R4): state, new-device notice. */
  private async pushRemote(): Promise<void> {
    let view: RemoteView | null = null;
    try { view = await this.api.remoteView(); } catch { view = null; }
    if (this.disposed) return;
    let paired: string | undefined;
    if (view) {
      const ids = new Set(view.devices.map((d) => d.id));
      if (this.remoteIds) {
        const fresh = view.devices.find((d) => !this.remoteIds!.has(d.id));
        if (fresh) {
          paired = fresh.name;
          void window.showInformationMessage(`BlackHole：新手机已配对 — ${fresh.name}`);
        }
      }
      this.remoteIds = ids;
      for (const r of view.requests ?? []) if (!this.remoteAsked.has(r.id)) void this.askPair(r);
    }
    await this.post({ type: 'remote', view, paired });
  }

  /** A phone scanned the QR code: it only gets in after 允许 here (or in the Web UI). */
  private async askPair(r: { id: string; name: string }): Promise<void> {
    this.remoteAsked.add(r.id);
    const pick = await window.showWarningMessage(`BlackHole：手机「${r.name}」请求访问。不是你本人扫的码，请点「拒绝」。`, '允许', '拒绝');
    if (this.disposed || (pick !== '允许' && pick !== '拒绝')) return; // dismissed: the request expires by itself
    try {
      await this.api.remoteDecide(r.id, pick === '允许');
    } catch {
      void window.showWarningMessage('BlackHole：这个请求已经处理过或已过期');
    }
    if (!this.disposed) await this.pushRemote();
  }

  private remotePairBusy = false;
  private async remoteAction(m: { action: 'pair' | 'revoke' | 'probe'; id?: string; name?: string; origin?: string; requestId?: number }): Promise<void> {
    if (this.disposed) return;
    if (m.action === 'pair' && this.remotePairBusy) { await this.post({ type: 'remotePairDone', requestId: m.requestId }); return; }
    if (m.action === 'pair') this.remotePairBusy = true;
    try {
      if (m.action === 'probe') {
        if (!m.origin) throw new Error('请选择仍在配置中的手机入口');
        await this.api.remoteProbe(m.origin);
      } else if (m.action === 'pair') {
        const r = await this.api.remotePair(m.origin);
        if (this.disposed) return;
        const qr = qrcode(0, 'M'); qr.addData(r.url); qr.make();
        const n = qr.getModuleCount(); let path = '';
        for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.isDark(y, x)) path += `M${x} ${y}h1v1h-1z`;
        await this.post({ type: 'remoteQr', requestId: m.requestId, url: r.url, expiresAt: r.expires_at, kind: r.kind, n, path });
      } else if (m.action === 'revoke' && m.id) {
        const pick = await window.showWarningMessage(`撤销「${m.name ?? '该设备'}」的访问？`, { modal: true }, '撤销');
        if (pick !== '撤销' || this.disposed) return;
        await this.api.remoteRevoke(m.id); this.remoteIds?.delete(m.id);
      }
    } catch (e) {
      if (!this.disposed) void window.showErrorMessage(`BlackHole：手机访问 — ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (m.action === 'pair') { this.remotePairBusy = false; await this.post({ type: 'remotePairDone', requestId: m.requestId }); }
      if (m.action === 'probe') await this.post({ type: 'remoteProbeDone', origin: m.origin });
    }
    if (!this.disposed) await this.pushRemote();
  }

  /** Sites added in the Courier browser extension (daemon setting courierSites): list only, deleted here. */
  private async pushCourierSites(): Promise<void> {
    try {
      const s = await this.api.settings();
      const raw = Array.isArray(s.values.courierSites) ? (s.values.courierSites as Record<string, unknown>[]) : [];
      const sites = raw.map((x) => ({ id: String(x.id ?? ''), name: String(x.name ?? ''), origin: String(x.origin ?? ''), stop: !!(x.dom as { stop?: unknown } | undefined)?.stop }));
      await this.post({ type: 'courierSites', sites });
    } catch {
      /* daemon down (or older, without courierSites) — the list keeps its last snapshot */
    }
  }

  /** Delete one Courier site; the daemon pushes the new list and Courier unbinds it, stops injecting and drops the permission. */
  private async courierSiteRemove(id: string): Promise<void> {
    try {
      const listed = await this.api.settings();
      const site = (Array.isArray(listed.values.courierSites) ? (listed.values.courierSites as { id?: unknown; name?: unknown; origin?: unknown }[]) : []).find((x) => x.id === id);
      if (!site) { await this.pushCourierSites(); return; }
      const pick = await window.showWarningMessage(`BlackHole：删除 Courier 网页站点「${String(site.name)}」？浏览器里的 Courier 会解除它的绑定、停止接管 ${String(site.origin)} 并收回访问权限。`, { modal: true }, '删除');
      if (pick !== '删除' || this.disposed) return;
      // Conditional write on a fresh read; one retry covers a revision bump from another client.
      for (let attempt = 0; ; attempt++) {
        const s = await this.api.settings();
        const all = Array.isArray(s.values.courierSites) ? (s.values.courierSites as { id?: unknown }[]) : [];
        if (!all.some((x) => x.id === id)) break;
        try {
          await this.api.patchSettings({ courierSites: all.filter((x) => x.id !== id) }, s.revision);
          break;
        } catch (e) {
          if (attempt > 0) throw e;
        }
      }
      await this.pushCourierSites();
      void window.showInformationMessage(`BlackHole：已删除「${String(site.name)}」。`);
    } catch (e) {
      void window.showErrorMessage(`BlackHole: 删除 Courier 网页站点失败 — ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private directVersion = 0;
  private directBusy = false;
  private directSaveChain: Promise<void> = Promise.resolve();

  /** Canonical settings plus current listener state; late reads never replace an acknowledged edit. */
  private async pushDirect(): Promise<void> {
    const version = ++this.directVersion;
    try {
      const [s, h] = await Promise.all([this.api.settings(), this.api.health()]);
      if (this.disposed || version !== this.directVersion) return;
      await this.post({ type: 'directAccess', revision: s.revision,
        on: s.values.directAccessEnabled === true,
        port: typeof s.values.directPort === 'number' ? s.values.directPort : 7307,
        url: typeof s.values.directAccessUrl === 'string' ? s.values.directAccessUrl : '',
        proxyUrl: typeof s.values.channelProxyUrl === 'string' ? s.values.channelProxyUrl : '',
        aiDefaultRoute: typeof s.values.aiDefaultRoute === 'string' ? s.values.aiDefaultRoute : 'auto',
        listener: h.direct_access ?? null });
    } catch {
      if (!this.disposed && version === this.directVersion) await this.post({ type: 'directUnavailable' });
    }
  }

  /** One confirmed switch; empty advertised URL is valid and disabling preserves it. */
  private async directToggle(on: boolean, formUrl?: string): Promise<void> {
    if (this.directBusy || this.disposed) return;
    this.directBusy = true;
    await this.post({ type: 'directBusy', busy: true });
    try {
      await this.directSaveChain;
      const before = await this.api.settings();
      let confirmed = before;
      let url = typeof formUrl === 'string' ? formUrl.trim() : String(before.values.directAccessUrl ?? '');
      if (on && url) {
        let parsed: URL;
        try { parsed = new URL(url); } catch { throw new Error('请填写 HTTP(S) 地址，或留空使用本机地址。'); }
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('请填写不带路径、凭据或查询参数的 HTTP(S) 地址。');
        url = parsed.origin;
      }
      if (on) {
        const pick = await window.showWarningMessage('BlackHole：开启直连？可到达本机直连端口的设备将能使用 MCP、引导页、手机与面板。HTTP 不加密；HTTPS 需自行配置 TLS 入口。MCP 和设备仍需认证，手机扫码后仍须在电脑上允许；本地管理接口不会开放。', { modal: true }, '开启');
        if (pick !== '开启' || this.disposed) return;
        const fresh = await this.api.settings();
        if (fresh.values.directAccessEnabled !== before.values.directAccessEnabled || fresh.values.directAccessUrl !== before.values.directAccessUrl || fresh.values.directPort !== before.values.directPort) {
          throw new Error('直连设置已在别处修改，本次未覆盖。请核对最新值后重试。');
        }
        confirmed = fresh;
      }
      if (this.disposed) return;
      await this.saveDaemonSettings(on ? { directAccessEnabled: true, directAccessUrl: url } : { directAccessEnabled: false }, confirmed);
    } catch (e) {
      if (!this.disposed) void window.showWarningMessage(`BlackHole: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.directBusy = false;
      if (!this.disposed) { await this.post({ type: 'directBusy', busy: false }); await this.pushDirect(); }
    }
  }

  /** Serialize conditional patches and do not overwrite the same field changed elsewhere. */
  private saveDaemonSettings(values: Record<string, unknown>, expected?: Awaited<ReturnType<ControlApi['settings']>>): Promise<void> {
    const task = async (): Promise<void> => {
      if (this.disposed) return;
      const keys = Object.keys(values);
      this.directVersion++;
      await this.post({ type: 'directSaveState', keys, state: 'saving' });
      try {
        let base = expected ?? await this.api.settings();
        for (let attempt = 0; ; attempt++) {
          if (this.disposed) return;
          try { await this.api.patchSettings(values, base.revision); break; }
          catch (error) {
            if (expected || attempt > 0) throw error;
            const fresh = await this.api.settings();
            if (fresh.revision === base.revision || keys.some((key) => JSON.stringify(fresh.values[key]) !== JSON.stringify(base.values[key]))) throw error;
            base = fresh;
          }
        }
        if (this.disposed) return;
        await this.post({ type: 'directSaveState', keys, state: 'saved', values });
        await Promise.all([this.pushDirect(), this.pushRemote(), this.status()]);
      } catch (e) {
        if (!this.disposed) {
          const message = `保存失败：${e instanceof Error ? e.message : String(e)}`;
          await this.post({ type: 'directSaveState', keys, state: 'error', message });
          void window.showErrorMessage(`BlackHole: ${message}`);
        }
      }
    };
    const result = this.directSaveChain.then(task, task);
    this.directSaveChain = result;
    return result;
  }

  private async pushGrants(): Promise<void> {
    try {
      const grants: ApprovalGrantsInfo = await this.api.approvalGrants();
      await this.post({ type: 'grants', grants });
    } catch {
      /* daemon down — the list keeps its last snapshot until it is back */
    }
  }

  private async rotateToken(): Promise<void> {
    // the old link dies immediately and every configured connector/sandbox
    // script breaks until updated — confirm before doing that behind a misclick
    const confirm = await window.showWarningMessage(
      'BlackHole: 重置后旧 MCP 链接立即失效，连接器/沙箱脚本里配置的旧地址全部要换成新链接（会话 ID 不受影响）。确认重置？',
      '重置',
    );
    if (confirm !== '重置') return;
    try {
      const result = await this.api.rotateMcpToken();
      const next = result.connection_routes?.preferred_mcp_url ?? (!result.connection_routes ? result.mcp_url : null);
      if (next) {
        await env.clipboard.writeText(next);
        void window.showInformationMessage('BlackHole：MCP 链接已重置，当前选中入口的新链接已复制；请更新已配置的客户端。');
      } else {
        void window.showInformationMessage('BlackHole：MCP 链接已重置。当前入口需要选择或没有 URL，请在“连接与渠道”确认后再复制。');
      }
    } catch (e) {
      void window.showErrorMessage(`BlackHole: 刷新 token 失败 — ${e instanceof Error ? e.message : String(e)}`);
    }
    await this.status();
  }

  /**
   * Copy a ready-to-paste connector Description for MCP platforms (ChatGPT
   * custom connectors, etc.) — summarizes the tool surface and key discipline
   * so the operator doesn't have to compose it from scratch.
   */
  private async copyConnectorDesc(): Promise<void> {
    const desc = [
      'BlackHole provides access to the current workspace through MCP.',
      'Use the supplied sessionId on every BlackHole call. Call guide before workspace work and follow it.',
    ].join('\n');
    await env.clipboard.writeText(desc);
    void window.showInformationMessage('BlackHole：连接器描述已复制。');
  }

  /** Saved Tunnel ID: an identifier (not a URL or secret), so the card may show and copy it offline. */
  private savedTunnelId(): string | null {
    return (workspace.getConfiguration('blackhole').get<string>('openaiTunnelId') ?? '').trim() || null;
  }

  private async copyTunnelId(): Promise<void> {
    const health = await this.api.health(4000).catch(() => null);
    if (!health) { void window.showWarningMessage('BlackHole: 无法确认 daemon 当前保存的 Tunnel ID；未复制。'); return; }
    const id = health.connection_routes ? health.connection_routes.saved_tunnel_id ?? null : this.savedTunnelId();
    if (!id) {
      void window.showWarningMessage('BlackHole: 尚未保存 Tunnel ID，请先在 OpenAI 页签填写并保存。');
      return;
    }
    await env.clipboard.writeText(id);
    void window.showInformationMessage('BlackHole：daemon 保存的 Tunnel ID 已复制；渠道停止时也可配置连接器。');
  }

  /** Only the fixed OpenAI onboarding pages; the webview cannot open arbitrary URLs. */
  private async openLink(target: string): Promise<void> {
    const url = OPENAI_LINKS.get(target);
    if (url) await env.openExternal(Uri.parse(url));
  }

  private async installCloudflared(currentPath: string, channelMode: string): Promise<void> {
    if (channelMode !== 'cloudflare' || typeof currentPath !== 'string' || this.cloudflaredInstallBusy) return;
    this.cloudflaredInstallBusy = true;
    const initial = workspace.getConfiguration('blackhole');
    const initialPath = initial.get<string>('cloudflaredPath') ?? '';
    const initialMode = initial.get<string>('channelMode') ?? 'cloudflare';
    let result: { path: string; installed: boolean } | undefined;
    let saved = false;
    try {
      result = await this.api.installRuntime('cloudflared', currentPath);
      if (this.disposed) return;
      if (initialMode === 'custom') {
        await this.post({ type: 'cloudflaredInstallResult', previousPath: currentPath, ...result, note: '当前使用自定义渠道，仅回填路径，不保存或重启 daemon。' });
        return;
      }
      await this.post({ type: 'cloudflaredInstallResult', phase: 'confirming' });
      const confirm = await window.showInformationMessage(
        'BlackHole：cloudflared 验证通过。保存该路径并重启 daemon 使其生效？',
        { modal: true, detail: `${result.path}\n重启会短暂中断本地服务；不会自动启动公网渠道。` },
        '保存并重启',
        '仅回填路径',
      );
      if (this.disposed) return;
      if (confirm === '保存并重启') {
        // Another window can change persisted settings even while this panel's
        // controls are locked. Never apply an obsolete result to that state.
        const current = workspace.getConfiguration('blackhole');
        if ((current.get<string>('channelMode') ?? 'cloudflare') !== initialMode ||
            (current.get<string>('cloudflaredPath') ?? '') !== initialPath) {
          await this.post({ type: 'cloudflaredInstallResult', previousPath: currentPath, error: `渠道配置已变化，未保存路径或重启 daemon。已验证文件：${result.path}` });
          return;
        }
        await current.update('cloudflaredPath', result.path, ConfigurationTarget.Global);
        saved = true;
        await this.post({ type: 'cloudflaredInstallResult', phase: 'applying' });
        // restart() coalesces the configuration watcher's concurrent restart.
        const restarted = await this.daemon.restart();
        await this.post({ type: 'cloudflaredInstallResult', previousPath: currentPath, ...result, saved, restarted });
        if (!this.disposed) {
          if (restarted) void window.showInformationMessage('BlackHole：cloudflared 路径已保存，daemon 已重启；尚未启动渠道。');
          else void window.showErrorMessage('BlackHole：cloudflared 路径已保存，但 daemon 重启失败。');
        }
        return;
      }
      await this.post({ type: 'cloudflaredInstallResult', previousPath: currentPath, ...result });
    } catch (error) {
      await this.post({ type: 'cloudflaredInstallResult', previousPath: currentPath, ...result, saved, error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.cloudflaredInstallBusy = false;
    }
  }

  /**
   * One-click install of the official plain tunnel-client runtime (plan §4).
   * Verified paths are saved directly: the daemon reads this setting at the next
   * explicit OpenAI start, so no restart is needed and no channel is started.
   */
  private async installOpenaiTunnel(currentPath: string): Promise<void> {
    if (typeof currentPath !== 'string' || this.openaiInstallBusy) return;
    this.openaiInstallBusy = true;
    const initialPath = workspace.getConfiguration('blackhole').get<string>('openaiTunnelClientPath') ?? '';
    try {
      const result = await this.api.installRuntime('openai', currentPath.trim());
      if (this.disposed) return;
      const current = workspace.getConfiguration('blackhole');
      // Another window may have changed the setting meanwhile: never overwrite it.
      if ((current.get<string>('openaiTunnelClientPath') ?? '') !== initialPath) {
        await this.post({ type: 'openaiInstallResult', previousPath: currentPath, ...result, saved: false, note: `设置已在别处变化，未自动保存。已验证文件：${result.path}` });
        return;
      }
      if (initialPath !== result.path) await current.update('openaiTunnelClientPath', result.path, ConfigurationTarget.Global);
      await this.post({ type: 'openaiInstallResult', previousPath: currentPath, ...result, saved: true });
      if (!this.disposed) void window.showInformationMessage(`BlackHole：tunnel-client ${result.version} ${result.installed ? '安装完成' : '已就绪'}，路径已保存；尚未启动 OpenAI 渠道。`);
    } catch (error) {
      await this.post({ type: 'openaiInstallResult', previousPath: currentPath, error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.openaiInstallBusy = false;
    }
  }

  /**
   * OpenAI runtime controls (plan §5): the key goes straight to the daemon's OS
   * keychain and is never stored, logged or echoed here; start is explicit and
   * bound to the saved settings revision and the current credential revision.
   */
  private async openaiTunnel(m: { action: OpenAIAction; key?: string; tunnelId?: string; clientPath?: string }): Promise<void> {
    if (this.openaiBusy) return;
    this.openaiBusy = true;
    let ok = false;
    let message = '';
    try {
      const health = await this.api.health(4000);
      const view = health.openai_tunnel;
      if (!view || health.openai_tunnel_api_version !== 1 || !health.daemon_id) throw new Error('openai_tunnel_unsupported');
      const daemonId = health.daemon_id;
      if (m.action === 'saveKey') {
        const key = typeof m.key === 'string' ? m.key.trim() : '';
        if (!key) throw new Error('empty_api_key');
        const r = await this.api.openaiTunnelSetKey(daemonId, view.credential_revision, key);
        message = r.pending_restart ? 'Runtime API Key 已保存；重新启动 OpenAI 渠道后生效。' : 'Runtime API Key 已保存。';
      } else if (m.action === 'clearKey') {
        const pick = await window.showWarningMessage('BlackHole：清除 Runtime API Key 会先停止 OpenAI 渠道，再删除本机保存的密钥。', { modal: true }, '清除密钥');
        if (pick !== '清除密钥' || this.disposed) return;
        await this.api.openaiTunnelClearKey(daemonId, view.credential_revision);
        message = 'Runtime API Key 已删除；OpenAI 渠道已停止。';
      } else if (m.action === 'start') {
        const revision = await this.syncOpenaiSettings(m.tunnelId, m.clientPath);
        const r = await this.api.openaiTunnelStart(daemonId, revision, view.credential_revision);
        message = r.status === 'ready' ? 'OpenAI 渠道已就绪。' : 'OpenAI 渠道正在启动；就绪后状态会自动更新。';
      } else if (m.action === 'stop') {
        await this.api.openaiTunnelStop(daemonId, view.run_id);
        message = 'OpenAI 渠道已停止。';
      } else if (m.action === 'diagnostics') {
        const d = await this.api.openaiTunnelDiagnostics();
        const doc = await workspace.openTextDocument({ language: 'json', content: JSON.stringify(d, null, 2) });
        await window.showTextDocument(doc, { preview: true });
        message = '诊断信息已在新标签页打开（本机观测，已脱敏）。';
      }
      ok = true;
    } catch (e) {
      message = await this.openaiErrorText(e);
    } finally {
      this.openaiBusy = false;
      if (!this.disposed) {
        await this.post({ type: 'openaiTunnelResult', action: m.action, ok, message });
        void this.status();
      }
    }
  }

  /** The daemon must hold exactly the saved fields this window shows (plan §5.2.1). */
  private async syncOpenaiSettings(formTunnelId?: string, formClientPath?: string): Promise<number> {
    // Edits saved in this window are pushed first, so what remains different was changed on the daemon.
    await this.settingsSync?.flush();
    const c = workspace.getConfiguration('blackhole');
    const local: Record<string, string> = {
      openaiTunnelId: (c.get<string>('openaiTunnelId') ?? '').trim(),
      openaiTunnelClientPath: (c.get<string>('openaiTunnelClientPath') ?? '').trim(),
    };
    if ((formTunnelId !== undefined && formTunnelId.trim() !== local.openaiTunnelId)
      || (formClientPath !== undefined && formClientPath.trim() !== local.openaiTunnelClientPath)) throw new Error('unsaved_settings');
    let s = await this.api.settings();
    const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    const diff = Object.fromEntries(Object.entries(local).filter(([k, v]) => text(s.values[k]) !== v));
    if (!Object.keys(diff).length) return s.revision;
    // This window still shows the value it last saw from the daemon: the daemon moved on
    // (Web settings, another window). Take the daemon's value and let the operator confirm;
    // never write the stale copy back or start with it.
    const base = this.settingsSync?.baseline();
    if (base && Object.keys(diff).some((k) => text(base[k]) === local[k])) {
      await this.settingsSync?.sync();
      await this.refresh();
      throw new Error('settings_changed_elsewhere');
    }
    s = await this.api.patchSettings(diff, s.revision);
    return s.revision;
  }

  private async openaiErrorText(e: unknown): Promise<string> {
    const message = (e as { message?: unknown } | null)?.message;
    const code = typeof message === 'string' ? message : String(e);
    if (OPENAI_ERRORS[code]) return OPENAI_ERRORS[code];
    const view = await this.api.openaiTunnel().catch(() => undefined);
    if (view && view.reason_code === code && view.reason) return view.reason;
    return 'OpenAI 渠道操作失败（' + code + '）。';
  }

  private async customProbe(raw: string): Promise<void> {
    const base = raw.trim().replace(/\/+$/, '');
    let url: URL;
    try {
      url = new URL(base);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('invalid base');
    } catch {
      await this.post({ type: 'customProbeResult', url: base, ok: false, detail: '请输入完整公网地址，例如 https://example.com 或 http://203.0.113.10:8080' });
      return;
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8_000);
      let response: Response;
      try { response = await fetch(`${base}/probe`, { signal: controller.signal, redirect: 'error' }); }
      finally { clearTimeout(timer); }
      const body = await response.json().catch(() => null) as { ok?: unknown; service?: unknown } | null;
      const ok = response.ok && body?.ok === true && body.service === 'blackhole';
      await this.post({ type: 'customProbeResult', url: base, ok, detail: ok ? '' : `探测响应无效（HTTP ${response.status}）` });
    } catch (e) {
      await this.post({ type: 'customProbeResult', url: base, ok: false, detail: e instanceof Error && e.name === 'AbortError' ? '探测超时' : '公网地址不可达' });
    }
  }

  private async tunnelAction(action: 'quick' | 'named' | 'stop' | 'copy'): Promise<void> {
    if (action === 'copy') {
      if (this.lastUrl) { await env.clipboard.writeText(this.lastUrl); void window.showInformationMessage('BlackHole：公网渠道地址已复制。'); }
      else void window.showWarningMessage('BlackHole：当前没有可复制的公网渠道地址。');
      return;
    }
    try {
      if (action === 'stop') { await this.api.tunnelStop(); void window.showInformationMessage('BlackHole：公网渠道已停止。'); }
      else { await this.api.tunnelStart(action); void window.showInformationMessage(`BlackHole：${action === 'quick' ? '临时' : '持久'}公网渠道已启动。`); }
    } catch (e) {
      void window.showErrorMessage(`BlackHole: 渠道操作失败 — ${e instanceof Error ? e.message : String(e)}`);
    }
    await this.status();
  }

  private async save(values: Record<string, string>, webAgents?: string[]): Promise<void> {
    const c = workspace.getConfiguration('blackhole');
    const saved: string[] = [];
    let needsRestart = false;
    // A subpage submits a patch, not a snapshot of every hidden form.
    const has = (key: string) => Object.prototype.hasOwnProperty.call(values, key);
    const channelMode = normalizeChannelMode(has('channelMode') ? values.channelMode : c.get<string>('channelMode'));
    const publicBaseUrl = (has('publicBaseUrl') ? values.publicBaseUrl : c.get<string>('publicBaseUrl')) ?? '';
    if ((has('channelMode') || has('publicBaseUrl')) && channelMode === 'custom' && !/^https?:\/\/[^\s/]+/i.test(publicBaseUrl.trim())) {
      void window.showErrorMessage('BlackHole: 自定义公网地址需要填写可访问的 HTTP(S) Base URL。');
      return;
    }
    const tunnelId = (values.openaiTunnelId ?? '').trim();
    if (tunnelId && !OPENAI_TUNNEL_ID.test(tunnelId)) {
      void window.showErrorMessage('BlackHole: Tunnel ID 应为 OpenAI Platform 隧道设置中的 ID（tunnel_ 加 32 位小写十六进制），不是 URL。');
      return;
    }
    const clientPath = (values.openaiTunnelClientPath ?? '').trim();
    if (clientPath && !path.isAbsolute(clientPath)) {
      void window.showErrorMessage('BlackHole: tunnel-client 路径需要填写可执行文件的绝对路径，或留空。');
      return;
    }
    for (const f of FIELDS) {
      if (!has(f.key)) continue;
      const raw = values[f.key] ?? '';
      const current = c.get(f.key);
      const next = f.type === 'number' ? (raw === '' ? undefined : Number(raw)) : raw;
      if (String(current ?? '') !== String(next ?? '')) {
        await c.update(f.key, next, ConfigurationTarget.Global);
        saved.push(f.label);
        if (RESTART_KEYS.has(f.key)) needsRestart = true;
      }
    }
    // Tabs are views/defaults only (plan §5.1): switching never restarts the daemon
    // and never stops a running channel.
    if (channelMode !== normalizeChannelMode(c.get<string>('channelMode'))) {
      await c.update('channelMode', channelMode, ConfigurationTarget.Global);
      saved.push('默认渠道');
    }
    // 凭据来源（semanticMode）不在 FIELDS 里：三态枚举由 Devin Key 卡片的
    // chips 提交。指纹已含 semanticMode，保存后 syncConfigRestart 会自动重启。
    const semMode = values.semanticMode;
    if (typeof semMode === 'string' && ['off', 'explicit', 'auto'].includes(semMode) && semMode !== c.get('semanticMode')) {
      await c.update('semanticMode', semMode, ConfigurationTarget.Global);
      saved.push('Devin Key 模式');
    }
    // key 文件不属于任何指纹（是文件不是设置）：保存后必须手动重启 daemon
    const semKey = (values.semKey ?? '').trim();
    if (semKey !== '') {
      try {
        await this.api.semanticSaveKey(semKey);
        saved.push('Devin Key');
        needsRestart = true;
      } catch (e) {
        void window.showErrorMessage(`BlackHole: Devin Key 保存失败 — ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    await this.saveWebAgents(webAgents);
    if (webAgents) saved.push('Web Agent 显示');
    const detail = saved.length ? '（' + Array.from(new Set(saved)).join('、') + '）' : '';
    void window.showInformationMessage('BlackHole：设置已保存' + detail + (needsRestart ? '；相关改动需重启 daemon 生效。' : '。'));
    const { semKey: _secret, ...acknowledged } = values;
    await this.post({ type: 'manualSaved', values: acknowledged, keySaved: saved.includes('Devin Key') });
    await this.refresh();
  }

  /**
   * 自动保存：只接受 AUTO_SAVE_KEYS 和 Web Agent 显示，校验规则与「保存」一致。
   * 不弹成功通知、不重新下发表单（不打断正在编辑的其他字段），结果只回给面板显示。
   */
  private async autosave(values: Record<string, string>, webAgents?: string[]): Promise<void> {
    const c = workspace.getConfiguration('blackhole');
    const saved: string[] = [];
    let error: string | undefined;
    for (const [key, value] of Object.entries(values ?? {})) {
      if (!AUTO_SAVE_KEYS.has(key)) continue;
      const raw = String(value ?? '').trim();
      let next: string | number | undefined = raw;
      if (key === 'channelMode') next = normalizeChannelMode(raw);
      else if (key === 'openaiTunnelId' && raw && !OPENAI_TUNNEL_ID.test(raw)) {
        error = 'Tunnel ID 应为 OpenAI Platform 隧道设置中的 ID（tunnel_ 加 32 位小写十六进制），不是 URL；未保存。';
        continue;
      } else if (key === 'openaiTunnelClientPath' && raw && !path.isAbsolute(raw)) {
        error = 'tunnel-client 路径需要填写可执行文件的绝对路径，或留空；未保存。';
        continue;
      } else if (key === 'pollIntervalMs') {
        next = raw === '' ? undefined : Number(raw);
        if (typeof next === 'number' && !(Number.isFinite(next) && next >= 250)) { error = '轮询间隔至少 250 毫秒；未保存。'; continue; }
      }
      if (String(c.get(key) ?? '') === String(next ?? '')) continue;
      await c.update(key, next, ConfigurationTarget.Global);
      saved.push(key);
    }
    if (webAgents) {
      await this.saveWebAgents(webAgents);
      saved.push('webAgents');
    }
    if (this.disposed) return;
    const acknowledged = error ? {} : Object.fromEntries(Object.keys(values).filter(k => AUTO_SAVE_KEYS.has(k)).map(k => [k, c.get(k)]));
    await this.post({ type: 'autosaved', ok: !error, keys: saved, values: acknowledged, message: error ?? (saved.length ? '已自动保存' : '') });
  }

  /**
   * Persist the Web Agent checkboxes: subset -> write the array, all enabled
   * -> reset to the default (undefined), none -> explicit empty list (the
   * picker then hides every predefined agent; typed URLs still work).
   */
  private async saveWebAgents(next?: string[]): Promise<void> {
    if (!next) return;
    const c = workspace.getConfiguration('blackhole');
    const valid = next.filter((n) => AGENTS.some((a) => a.name === n));
    const current = c.get<string[]>('webAgents') ?? AGENTS.map((a) => a.name);
    const all = valid.length === AGENTS.length;
    const same = valid.length === current.length && valid.every((n) => current.includes(n));
    if (same) return;
    await c.update('webAgents', all ? undefined : valid, ConfigurationTarget.Global);
  }

  /**
   * Manually added web agents apply immediately — and ONLY re-render the
   * custom list. A full refresh() here would re-post `init` and wipe every
   * unsaved form edit, which read as "保存没有生效" when the user added a
   * site mid-edit.
   */
  private async addCustomAgent(name: string, url: string): Promise<void> {
    const error = await addCustomAgent(name, url);
    if (error) void window.showErrorMessage(`BlackHole: ${error}`);
    else void window.showInformationMessage('BlackHole：自定义站点已添加。');
    await this.postCustom();
  }

  private async removeCustomAgent(name: string): Promise<void> {
    const pick = await window.showWarningMessage(`BlackHole：删除自定义站点「${name}」？`, { modal: true }, '删除');
    if (pick !== '删除' || this.disposed) return;
    await removeCustomAgent(name);
    await this.postCustom();
    void window.showInformationMessage(`BlackHole：自定义站点「${name}」已删除。`);
  }

  /**
   * Push just the custom-agent list; the form stays untouched.
   */
  private async postCustom(): Promise<void> {
    await this.post({ type: 'custom', custom: customAgents().map((a) => ({ name: a.name, url: a.url })) });
  }

  // ─── Devin Key（语义搜索 context_search 的凭据） ────────────────
  //
  // key 是 daemon 启动时决定的（决定 context_search 是否注册），所以这里的
  // 每个动作只改 key 文件，改完都必须「重启 daemon」才生效——UI 文案里写死。

  private async postSemantic(): Promise<void> {
    const info = await this.api.semanticInfo().catch(() => undefined);
    if (info !== undefined) this.semanticSynced = true;
    await this.post({ type: 'semantic', info });
  }

  private async semanticSave(key: string): Promise<void> {
    try {
      await this.api.semanticSaveKey(key);
      void window.showInformationMessage('BlackHole：Devin Key 已保存；重启 daemon 后 context_search 生效。');
    } catch (e) {
      void window.showErrorMessage(`BlackHole: 保存失败 — ${e instanceof Error ? e.message : String(e)}`);
    }
    await this.postSemantic();
  }

  private async semanticClear(): Promise<void> {
    const pick = await window.showWarningMessage('BlackHole：清除 Devin Key 后，重启 daemon 会使 context_search 下线。', { modal: true }, '清除 Key');
    if (pick !== '清除 Key' || this.disposed) return;
    try {
      await this.api.semanticClear();
      void window.showInformationMessage('BlackHole：Devin Key 已清除；重启 daemon 后 context_search 下线。');
    } catch (e) {
      void window.showErrorMessage(`BlackHole: 清除失败 — ${e instanceof Error ? e.message : String(e)}`);
    }
    await this.postSemantic();
  }

  // ─── MCP Proxies（设置页只读区块）────────────────────────────
  //
  // 配置的唯一事实源是 ~/.blackhole/mcp-proxies.yaml：这里只渲染 daemon 的
  // 掩码投影（env 值已是 ***），整个区块除「重新校验」外没有任何可交互控件。

  /**
   * GET /proxies 的投影推给 webview；daemon 不可达推 null（区块显示未连接）。
   * 设置页首次打开/整页刷新时可主动验证 enabled MCP：先秒开现有投影，再并行
   * 实时拉一次工具目录，最后重读状态。disabled/config_error 永远不会因此被启动。
   */
  private proxyRead: Promise<void> | undefined;
  private pushProxies(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.proxyRead) return this.proxyRead;
    const read = this.readProxies().finally(() => { if (this.proxyRead === read) this.proxyRead = undefined; });
    this.proxyRead = read;
    return read;
  }

  private async readProxies(): Promise<void> {
    const generation = this.projectionGeneration;
    const info = await this.api.proxies().catch(() => null);
    if (this.disposed || generation !== this.projectionGeneration) return;
    // Exclude volatile metrics/catalog ages from the UI signature.
    const projection = info ? { configured: info.configured, daemonId: info.daemonId, surfaceGen: info.surfaceGen,
      status: info.status, config: info.config, disabled: info.disabled, warnings: info.warnings } : null;
    const signature = JSON.stringify(projection);
    this.lastProxies = projection;
    if (signature === this.proxySignature) return;
    this.proxySignature = signature;
    await this.post({ type: 'proxies', info: projection });
  }

  /** M4 引导式编辑：白名单字段 → 服务端合并校验原子写回 + 热加载；结果渲染在区块内。 */
  private async proxiesEdit(server: string, fields: Record<string, unknown>): Promise<void> {
    if (this.disposed) return;
    this.toolVersions.set(server, (this.toolVersions.get(server) ?? 0) + 1);
    this.projectionGeneration++;
    this.toolRequests.delete(server);
    try {
      const result = await this.api.proxiesEditFields(server, fields);
      this.projectionGeneration++;
      if (!result.written) throw new Error('写入被拒绝');
      // Acknowledge the exact saved fields before publishing a fresh projection.
      await this.post({ type: 'proxiesEditResult', server, fields, ok: true });
      if (this.proxyRead) await this.proxyRead;
      await this.pushProxies();
    } catch (e) {
      this.projectionGeneration++;
      await this.post({ type: 'proxiesEditResult', server, ok: false, detail: e instanceof Error ? e.message : String(e) });
    }
  }

  private async togglePxForm(form: 'add' | 'import'): Promise<void> {
    await this.post({ type: 'proxiesToggleForm', form });
  }

  /** M4.6 新增 MCP：表单字段 → 服务端校验 → 追加 YAML → 原子写回 → 热加载。 */
  private async proxiesAdd(server: Record<string, unknown>): Promise<void> {
    try {
      const result = await this.api.proxiesAdd(server);
      if (!result.added) throw new Error('校验未通过');
      await this.post({ type: 'proxiesAddResult', ok: true, detail: 'added', warning: result.warning });
      await this.pushProxies();
    } catch (e) {
      await this.post({ type: 'proxiesAddResult', ok: false, detail: e instanceof Error ? e.message : String(e) });
    }
  }

  /** M4.6 JSON 导入：mcpServers 通用格式 → 转换校验 → 原子写回 → 热加载。 */
  private async proxiesImport(json: string): Promise<void> {
    try {
      const result = await this.api.proxiesImport(json);
      const failed = (result.failed ?? []).map(f => `${f.name}: ${f.error}`).join('；');
      if (!result.imported?.length) throw new Error(failed || '没有可导入的条目');
      await this.post({ type: 'proxiesImportResult', ok: true, detail: `已导入 ${result.imported.join('、')}${failed ? '；失败：' + failed : ''}` });
      await this.pushProxies();
    } catch (e) {
      await this.post({ type: 'proxiesImportResult', ok: false, detail: e instanceof Error ? e.message : String(e) });
    }
  }

  /**
   * 查看已运行 MCP 的工具列表。该路径只读取/刷新现有连接，绝不负责启动上游；
   * 启停生命周期由 daemon 配置状态管理。迟到或跨 daemon 的响应一律丢弃。
   */
  private proxiesTools(server: string, refresh: boolean): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const row = this.lastProxies?.status?.find(s => s.name === server);
    if (!row || !['online', 'degraded'].includes(row.status) || this.lastProxies?.disabled?.includes(server)) return Promise.resolve();
    const active = this.toolRequests.get(server);
    if (active) return active;
    const revision = this.toolVersions.get(server) ?? 0;
    this.toolVersions.set(server, revision);
    const request = (async () => {
      await this.post({ type: 'proxiesToolsPending', server, refresh });
      if (this.disposed) return;
      try {
        const result = await this.api.proxiesTools(server, refresh);
        if (this.disposed || revision !== this.toolVersions.get(server)) return;
        if (typeof result.daemonId === 'string' && this.anchors.daemonId !== null && result.daemonId !== this.anchors.daemonId) return;
        await this.post({ type: 'proxiesToolsResult', server, refresh, ok: true, result });
        await this.pushProxies();
      } catch (e) {
        if (revision === this.toolVersions.get(server)) await this.post({ type: 'proxiesToolsResult', server, refresh, ok: false, detail: e instanceof Error ? e.message : String(e) });
      }
    })().finally(async () => {
      if (this.toolRequests.get(server) === request) this.toolRequests.delete(server);
      if (revision === this.toolVersions.get(server)) await this.post({ type: 'proxiesToolsSettled', server });
    });
    this.toolRequests.set(server, request);
    return request;
  }

  /**
   * v2.6 删除 MCP：与「停用」严格分离——停用只是卸载出运行时、配置保留；
   * 删除才把条目从 mcp-proxies.yaml 摘掉（不可撤销），故必须模态二次确认。
   */
  private async proxiesRemove(server: string): Promise<void> {
    const pick = await window.showWarningMessage(
      `BlackHole: 将「${server}」从 mcp-proxies.yaml 中删除？不可撤销。`,
      { modal: true },
      '删除',
    );
    if (pick !== '删除' || this.disposed) return;
    this.toolVersions.set(server, (this.toolVersions.get(server) ?? 0) + 1);
    try {
      const result = await this.api.proxiesRemove(server);
      if (!result.removed) throw new Error('删除被拒绝');
      await this.post({ type: 'proxiesRemoveResult', server, ok: true });
      await this.pushProxies();
    } catch (e) {
      await this.post({ type: 'proxiesRemoveResult', server, ok: false, detail: e instanceof Error ? e.message : String(e) });
    }
  }

  /** 重新校验：重跑启动同款校验管道，只报告不改运行状态；报告渲染在区块内。 */
  private async proxiesRevalidate(): Promise<void> {    const report: ProxiesRevalidateReport | null = await this.api.proxiesRevalidate().catch(() => null);
    if (!report) {
      void window.showErrorMessage('BlackHole: 重新校验失败 — daemon 不可达');
      return;
    }
    await this.post({ type: 'proxiesReport', report });
  }

  private html(): string {
    const nonce = Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    const fieldHtml = (f: Field): string => {
      const control=f.type==='select'
        ? `<select id="${f.key}">${(f.options??[]).map(option=>`<option value="${option.value}">${option.label}</option>`).join('')}</select>`
        : `<input id="${f.key}" type="${f.type === 'number' ? 'number' : 'text'}" spellcheck="false">`;
      // 需重启的字段标出来：它们不自动保存，要点「保存」。
      const tag = RESTART_KEYS.has(f.key) ? '<span class="rs" title="改完点「保存」，daemon 重启后生效">需重启</span>' : '';
      return `<div class="f"><label for="${f.key}">${f.label}${tag}</label>${control}<div class="d">${f.desc}</div>${f.key === 'skillsDir' ? '<div class="hint" id="skillsHint"></div>' : ''}</div>`;
    };
    // Devin Key 输入框与「daemon 端口」同行（fgrid 空槽位）；状态行、清除按钮、
    // 凭据来源 chips 全部收在输入框正下方，是唯一的 key 手动入口
    const keyCell =
      '<div class="f"><label for="semKey">Devin Key<span class="rs" title="改完点「保存」，daemon 重启后生效">需重启</span></label><input id="semKey" type="password" spellcheck="false" autocomplete="off" placeholder="sk-…">'
      + '<div class="chrow"><span class="chst dim" id="semst">…</span><span class="sp"></span><button id="semClear" class="secondary" style="display:none">清除已存</button></div>'
      + '<div class="semrow"><span class="lbl">凭据来源</span><div class="agrid" id="semMode"></div></div></div>';
    const cloudflaredField = fieldHtml(FIELDS.find((f) => f.key === 'cloudflaredPath')!);
    const publicUrlField = fieldHtml(FIELDS.find((f) => f.key === 'publicBaseUrl')!);
    const customPublicUrlField = '<div class="f"><label for="customPublicBaseUrl">公网地址</label><div class="channel-probe-line"><input id="customPublicBaseUrl" type="text" spellcheck="false" placeholder="https://blackhole.example.com"><button id="customProbe" class="secondary" type="button">检测</button></div><div class="d">支持 HTTP/HTTPS 公网地址。HTTP 为明文传输；HTTPS 由你的 TLS 入口终止。支持域名、IP 与自定义端口。</div></div>';
    const openaiPathField = fieldHtml(FIELDS.find((f) => f.key === 'openaiTunnelClientPath')!);
    const openaiIdField = fieldHtml(FIELDS.find((f) => f.key === 'openaiTunnelId')!);
    const CHANNEL_KEYS = new Set(['cloudflaredPath', 'publicBaseUrl', 'openaiTunnelClientPath', 'openaiTunnelId']);
    const connectorField = fieldHtml(FIELDS.find((f) => f.key === 'connectorName')!);
    const network = fieldHtml(FIELDS.find((f) => f.key === 'tunnelProbeProxy')!);
    const common = FIELDS.filter((f) => !f.advanced && !CHANNEL_KEYS.has(f.key) && f.key !== 'connectorName').map(fieldHtml).join('') + keyCell;
    const advanced = FIELDS.filter((f) => f.advanced && f.key !== 'tunnelProbeProxy').map(fieldHtml).join('');
    const build = resolveCloudEndpoint();
    const buildNotice = build.environment === 'test'
      ? '<p class="build-notice">测试构建 · ' + (build.origin === PRODUCTION_CLOUD_ORIGIN
        ? '当前连接正式服务，账户、订单及支付不隔离。'
        : '连接构建时指定的测试服务。') + '</p>' : '';
    return `<!DOCTYPE html>
<html lang="zh-cn">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); font-size: 13px; max-width: 760px; margin: 0 auto; padding: 24px 20px 60px; }
  h1 { font-size: 18px; font-weight: 650; }
  .ver { font-family: var(--vscode-editor-font-family); font-size: 11px; color: var(--vscode-descriptionForeground); margin-left: 8px; }
  /* 驾驶舱：daemon / 渠道 / 活动，一眼可见 */
  .cockpit { display: flex; border-radius: 8px; margin: 14px 0 6px; background: var(--vscode-sideBar-background); border: 1px solid var(--vscode-panel-border); overflow: hidden; }
  .cockpit .cell { flex: 1; padding: 11px 16px; min-width: 0; }
  .cockpit .cell.wide { flex: 1.6; }
  .cockpit .cell + .cell { border-left: 1px solid var(--vscode-panel-border); }
  .ck-k { font-size: 10px; letter-spacing: .1em; text-transform: uppercase; color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
  .ck-v { font-size: 12.5px; display: flex; align-items: center; gap: 7px; min-width: 0; }
  .ck-v .d { width: 7px; height: 7px; border-radius: 50%; background: var(--vscode-descriptionForeground); flex-shrink: 0; }
  .ck-v .d.ok { background: var(--vscode-charts-green); }
  .ck-v .d.warn { background: var(--vscode-charts-yellow); }
  .ck-v .d.bad { background: var(--vscode-charts-red); }
  .home-account-row { gap:7px; }
  .home-account-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .home-signout { width:28px; min-width:28px; height:28px; min-height:28px; flex:0 0 28px; margin-left:auto; padding:0; display:grid; place-items:center; border:1px solid transparent; border-radius:6px; background:transparent; color:var(--vscode-descriptionForeground); }
  .home-signout:hover:not(:disabled) { border-color:var(--vscode-widget-border); background:var(--vscode-list-hoverBackground); color:var(--vscode-foreground); }
  .home-signout svg { display:block; width:15px; height:15px; }
  /* 渠道总开关：与侧边栏标题里的开关同一套样式与状态。开关自身就是状态指示，显示时隐藏状态点。 */
  .chsw { position: relative; width: 26px; height: 14px; flex-shrink: 0; padding: 0; min-width: 0; border-radius: 999px; cursor: pointer; border: 1px solid var(--vscode-checkbox-border, var(--vscode-panel-border)); background: color-mix(in srgb, var(--vscode-descriptionForeground) 22%, transparent); transition: background .15s, border-color .15s; }
  .chsw::after { content: ''; position: absolute; top: 1px; left: 1px; width: 10px; height: 10px; border-radius: 50%; background: var(--vscode-foreground); opacity: .8; transition: transform .15s; }
  .chsw[aria-checked="true"]::after { transform: translateX(12px); background: #fff; opacity: 1; }
  .chsw[data-state="on"] { background: var(--vscode-charts-green); border-color: transparent; }
  .chsw[data-state="warn"], .chsw[data-state="starting"] { background: var(--vscode-charts-yellow); border-color: transparent; }
  .chsw[data-state="starting"]::after { animation: ckSwPulse 1s ease-in-out infinite; }
  .chsw[data-state="error"] { border-color: var(--vscode-charts-red); }
  .chsw:disabled { cursor: progress; opacity: 1; }
  .chsw:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  .chsw:not([hidden]) + .d { display: none; }
  .ck-msg { margin-top: 6px; font-size: 11px; line-height: 1.5; color: var(--vscode-errorForeground); }
  @keyframes ckSwPulse { 50% { opacity: .35; } }
  @media (prefers-reduced-motion: reduce) { .chsw, .chsw::after { transition: none; } .chsw[data-state="starting"]::after { animation: none; } }
  .ck-v code { font-family: var(--vscode-editor-font-family); font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; }
  .sec { font-weight: 600; font-size: 11.5px; color: var(--vscode-descriptionForeground); margin: 20px 0 8px; }
  .scan-head { display:flex; align-items:center; gap:12px; margin-bottom:12px; }
  .scan-icon { display:grid; place-items:center; width:38px; height:38px; flex:0 0 38px; border:1px solid color-mix(in srgb,var(--vscode-charts-blue) 32%,transparent); border-radius:10px; background:color-mix(in srgb,var(--vscode-charts-blue) 12%,transparent); color:var(--vscode-charts-blue); }
  .scan-icon svg { display:block; width:20px; height:20px; }
  .scan-copy { min-width:0; }
  .scan-copy strong { display:block; color:var(--vscode-foreground); font-size:12.5px; }
  .scan-copy .hint { margin-top:3px; }
  .card { background: var(--vscode-sideBar-background); border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 12px 14px; }
  .card button { font-size: 12px; padding: 4px 13px; }
  .chrow { display: flex; align-items: center; gap: 8px; }
  .chrow .sp { flex: 1; }
  .chst { font-size: 12px; }
  .chst.ok { color: var(--vscode-charts-green); }
  .chst.warn { color: var(--vscode-charts-yellow); }
  .chst.bad { color: var(--vscode-errorForeground); }
  .chst.dim { color: var(--vscode-descriptionForeground); }
  .btnrow { display: flex; gap: 8px; flex-wrap: wrap; }
  .hint { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 8px; line-height: 1.6; }
  .hint.ok { color: var(--vscode-charts-green); }
  .hint.bad { color: var(--vscode-errorForeground); }
  .hint.warn { color: var(--vscode-charts-yellow); }
  .fgrid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 18px; }
  .f { margin: 0; }
  .f label { display: block; font-weight: 600; margin-bottom: 4px; font-size: 12px; }
  .f input { width: 100%; box-sizing: border-box; font-family: var(--vscode-editor-font-family); font-size: 12px; padding: 6px 9px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); border-radius: 6px; }
  .f input:focus { outline: 1px solid var(--vscode-focusBorder); }
  .f select { width: 100%; box-sizing: border-box; font-size: 12px; padding: 6px 9px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); border-radius: 6px; }
  .f select:focus { outline: 1px solid var(--vscode-focusBorder); }
  select:not([multiple]) { appearance: none; -webkit-appearance: none; background-image: linear-gradient(45deg, transparent 50%, currentColor 50%), linear-gradient(135deg, currentColor 50%, transparent 50%); background-position: calc(100% - 13px) 55%, calc(100% - 9px) 55%; background-size: 4px 4px; background-repeat: no-repeat; padding-right: 26px; cursor: pointer; }
  select option { background-color: var(--vscode-dropdown-background, var(--vscode-input-background)); color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground)); }
  .f textarea { width: 100%; box-sizing: border-box; font-family: var(--vscode-editor-font-family); font-size: 12px; padding: 6px 9px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); border-radius: 6px; resize: vertical; }
  .f textarea:focus { outline: 1px solid var(--vscode-focusBorder); }
  .f.fwide { grid-column: 1 / -1; }
  .form-msg { font-size: 11px; align-self: center; }
  .form-msg.err { color: var(--vscode-errorForeground); }
  .form-msg.busy { color: var(--vscode-descriptionForeground); }
  .f .d { font-size: 11px; opacity: .7; margin-top: 4px; }
  .f .hint { margin-top: 4px; }
  .channel-config { margin-bottom: 8px; }
  .channel-mode { display:flex; align-items:center; gap:8px; margin-bottom:12px; }
  .channel-mode .lbl { font-size:11px; color:var(--vscode-descriptionForeground); margin-right:2px; }
  .channel-mode .agchip { padding:3px 11px; }
  .channel-custom-note { font-size:11px; color:var(--vscode-descriptionForeground); line-height:1.55; margin:8px 0 12px; }
  .channel-custom-note code { font-family:var(--vscode-editor-font-family); font-size:10.5px; }
  .channel-probe-line { display:flex; align-items:center; gap:8px; }
  .channel-probe-line input { flex:1 1 auto; min-width:0; }
  .channel-probe-line button { flex:0 0 auto; }
  .channel-required { margin: 10px 0 12px; font-size: 11px; color: var(--vscode-descriptionForeground); }
  .channel-actions { padding-top: 10px; border-top: 1px solid var(--vscode-panel-border); }
  .mcpurl { display:flex; align-items:center; gap:12px; min-width:0; }
  .mcpurl > span { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:var(--vscode-editor-font-family); font-size:12px; color:var(--vscode-descriptionForeground); }
  .mcp-actions { display:flex; align-items:center; gap:8px; flex-shrink:0; }
  .mcp-actions button { white-space:nowrap; }
  .mcp-actions #mcpCopy { color:var(--vscode-button-foreground); background:var(--vscode-button-background); }
  .mcp-actions #mcpRotate { color:var(--vscode-button-secondaryForeground); background:var(--vscode-button-secondaryBackground); }
  .agrid { display: flex; flex-wrap: wrap; gap: 7px; }
  .agchip { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; padding: 4px 12px; border-radius: 999px; border: 1px solid var(--vscode-input-border); color: var(--vscode-descriptionForeground); cursor: pointer; user-select: none; background: transparent; font-family: inherit; }
  .agchip:hover { color: var(--vscode-foreground); }
  .agchip.on { color: var(--vscode-foreground); border-color: color-mix(in srgb, var(--vscode-charts-blue) 55%, transparent); background: color-mix(in srgb, var(--vscode-charts-blue) 10%, transparent); }
  .agchip .d { width: 6px; height: 6px; border-radius: 50%; background: currentColor; opacity: .45; }
  .agchip.on .d { opacity: 1; background: var(--vscode-charts-blue); }
  .subsec { font-size: 11px; color: var(--vscode-descriptionForeground); margin: 14px 0 2px; }
  .ag-row { display: flex; align-items: center; gap: 9px; padding: 5px 0; font-size: 12px; }
  .ag-row .mono-g { font-family: var(--vscode-editor-font-family); font-size: 10px; font-weight: 700; width: 20px; height: 20px; display: grid; place-items: center; border-radius: 6px; color: var(--vscode-charts-blue); background: color-mix(in srgb, var(--vscode-charts-blue) 12%, transparent); flex-shrink: 0; }
  .ag-row .nm { font-weight: 600; }
  .ag-row .u { font-family: var(--vscode-editor-font-family); font-size: 11px; color: var(--vscode-descriptionForeground); word-break: break-all; }
  .wa-host { font-size: 11px; color: var(--vscode-descriptionForeground); }
  .wa-tag { font-size: 10px; padding: 1px 6px; border-radius: 5px; color: var(--vscode-charts-yellow); background: color-mix(in srgb, var(--vscode-charts-yellow) 14%, transparent); }
  .ag-row .del { margin-left: auto; font-family: inherit; font-size: 11px; color: var(--vscode-descriptionForeground); background: transparent; border: none; cursor: pointer; padding: 2px 8px; border-radius: 4px; }
  .ag-row .del:hover { color: var(--vscode-errorForeground); background: var(--vscode-toolbar-hoverBackground); }
  .waadd { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
  .waadd input { flex: 1; min-width: 120px; box-sizing: border-box; font-family: var(--vscode-editor-font-family); font-size: 12px; padding: 5px 9px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); border-radius: 6px; }
  .waadd input:focus { outline: 1px solid var(--vscode-focusBorder); }
  .waadd .nm { flex: 0 0 140px; font-family: var(--vscode-font-family); }
  /* MCP Proxies 只读区块：server 卡片 + 状态徽标（无任何编辑控件） */
  .pxs { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 9px 12px; margin-top: 8px; }
  .pxs .hd { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .pxs .nm { font-weight: 600; font-size: 12.5px; }
  .pxb { display: inline-flex; align-items: center; gap: 5px; font-size: 10px; font-weight: 600; padding: 1px 8px; border-radius: 999px; flex-shrink: 0; }
  .pxb .d { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .pxb.ok { color: var(--vscode-charts-green); background: color-mix(in srgb, var(--vscode-charts-green) 12%, transparent); }
  .pxb.warn { color: var(--vscode-charts-yellow); background: color-mix(in srgb, var(--vscode-charts-yellow) 14%, transparent); }
  .pxb.bad { color: var(--vscode-charts-red); background: color-mix(in srgb, var(--vscode-charts-red) 12%, transparent); }
  .pxb.dim { color: var(--vscode-descriptionForeground); background: color-mix(in srgb, var(--vscode-descriptionForeground) 12%, transparent); }
  .pxkv { font-size: 11.5px; color: var(--vscode-descriptionForeground); margin-top: 5px; line-height: 1.6; word-break: break-all; }
  .pxkv b { color: var(--vscode-foreground); font-weight: 600; }
  .pxkv.bad { color: var(--vscode-errorForeground); }
  .pxkv.warn { color: var(--vscode-charts-yellow); }
  .pxs .pchip { display: inline-block; font-size: 10px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--vscode-panel-border); color: var(--vscode-descriptionForeground); flex-shrink: 0; }
  .pxs .hd { row-gap: 4px; }
  .pxbtns { margin-left: auto; display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
  .pxbtns button { box-sizing: border-box; height: 24px; padding: 2px 10px; font-size: 11px; border-radius: 5px; display: inline-flex; align-items: center; justify-content: center; }
  .pxbtns .pxsw { width: 30px; height: 16px; padding: 0; align-self: center; }
  .pxbtns .pxe, .pxmhd .pxe { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); border: 1px solid transparent; }
  .pxbtns .pxe:hover:not(:disabled), .pxmhd .pxe:hover:not(:disabled) { background: color-mix(in srgb, var(--vscode-button-secondaryBackground) 82%, var(--vscode-foreground)); }
  .pxe.danger { color: var(--vscode-errorForeground); }
  .pxbtns .pxe.danger { background: transparent; border-color: color-mix(in srgb, var(--vscode-errorForeground) 40%, transparent); }
  .pxbtns .pxe.danger:hover:not(:disabled) { background: color-mix(in srgb, var(--vscode-errorForeground) 12%, transparent); }
  .pxpanel:empty { display: none; }
  .pxpanel { margin-top: 8px; border-top: 1px dashed var(--vscode-panel-border); padding-top: 8px; }
  .pxsw { position: relative; width: 30px; height: 16px; border: none; border-radius: 999px; padding: 0; cursor: pointer; background: color-mix(in srgb, var(--vscode-descriptionForeground) 45%, transparent); flex-shrink: 0; }
  .pxsw::after { content: ''; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%; background: #fff; transition: left .12s ease; }
  .pxsw.on { background: var(--vscode-charts-green); }
  .pxsw.on::after { left: 16px; }
  .pxedit { margin-top: 8px; border-top: 1px dashed var(--vscode-panel-border); padding-top: 8px; }
  .pxedit textarea { display: block; width: 100%; box-sizing: border-box; font-family: var(--vscode-editor-font-family); font-size: 11.5px; line-height: 1.5; padding: 6px 8px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); border-radius: 5px; resize: vertical; }
  .pxedit .btnrow { margin-top: 6px; display: flex; gap: 6px; align-items: center; }
  .pxedit .btnrow button { padding: 2px 10px; font-size: 11px; border-radius: 5px; }
  .pxthr { display: flex; align-items: center; gap: 8px; }
  .pxth { font-size: 11px; color: var(--vscode-descriptionForeground); }
  .pxthr .sp { flex: 1; }
  .pxthr button { padding: 1px 10px; font-size: 10.5px; border-radius: 5px; }
  .pxrows { margin-top: 6px; display: grid; gap: 6px; max-height: 340px; overflow: auto; }
  .pxrow { border: 1px solid var(--vscode-panel-border); border-radius: 5px; padding: 5px 8px; }
  .pxrn { font-family: var(--vscode-editor-font-family); font-size: 11px; color: var(--vscode-foreground); display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .pxrd { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 3px; line-height: 1.5; }
  .pxpanel .pchip { display: inline-block; font-size: 9.5px; padding: 0 6px; border-radius: 999px; border: 1px solid var(--vscode-panel-border); color: var(--vscode-descriptionForeground); }
  /* 工具列表弹窗：不参与卡片流式布局，展开/收起不会重排卡片 */
  .pxmodal { position: fixed; inset: 0; z-index: 50; background: rgba(0, 0, 0, .45); display: flex; align-items: center; justify-content: center; }
  .pxmbox { width: min(760px, 92vw); max-height: 82vh; display: flex; flex-direction: column; background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 12px 14px; box-shadow: 0 6px 24px rgba(0, 0, 0, .45); }
  .pxmhd { display: flex; align-items: center; gap: 8px; padding-bottom: 8px; border-bottom: 1px solid var(--vscode-panel-border); }
  .pxmhd .pxmt { font-weight: 600; font-size: 12.5px; }
  .pxmhd .sp { flex: 1; }
  .pxmhd button { padding: 2px 10px; font-size: 11px; border-radius: 5px; }
  .pxmbody { overflow: auto; padding-top: 4px; }
  .pxmbody .pxrows { max-height: none; }
  .pchip.dup { color: var(--vscode-charts-yellow); border-color: color-mix(in srgb, var(--vscode-charts-yellow) 50%, transparent); background: color-mix(in srgb, var(--vscode-charts-yellow) 12%, transparent); }
  .pxs .pchip[data-tools] { font-family: inherit; background: transparent; cursor: pointer; }
  .pxs .pchip[data-tools]:hover { color: var(--vscode-foreground); border-color: var(--vscode-focusBorder); }
  .pxs .pchip[data-tools]:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  .pxtool-toggle { display: inline-flex; align-items: center; gap: 7px; cursor: pointer; font: inherit; }
  .pxtool-toggle input { margin: 0; accent-color: var(--vscode-charts-blue); }
  .pxrow.muted { opacity: .58; }
  .pchip.merged { color: var(--vscode-charts-blue); border-color: color-mix(in srgb, var(--vscode-charts-blue) 45%, transparent); background: color-mix(in srgb, var(--vscode-charts-blue) 10%, transparent); cursor: help; }
  .pchip.cold { color: var(--vscode-descriptionForeground); border-style: dashed; cursor: help; }
  .pchip.filesonly { cursor: help; }
  .pxtarget { font-family: var(--vscode-editor-font-family); font-size: 10.5px; color: var(--vscode-descriptionForeground); margin-top: 6px; padding: 3px 7px; border-radius: 4px; background: color-mix(in srgb, var(--vscode-textBlockQuote-background, var(--vscode-editor-background)) 60%, transparent); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pxkv.dim { opacity: 0.85; }
  #pxMsg { margin-top: 8px; display: none; }
  #pxMsg.ok { display: block; color: var(--vscode-charts-green); }
  #pxMsg.err { display: block; color: var(--vscode-errorForeground); }
  #pxMsg.warn { display: block; color: var(--vscode-charts-yellow); }
  .semrow { display: flex; align-items: center; gap: 10px; margin-top: 8px; }
  .semrow .lbl { font-size: 12px; }
  .f .chrow { margin-top: 8px; }
  .f .chrow button { padding: 3px 10px; font-size: 11px; }
  details { margin-top: 8px; }
  summary { cursor: pointer; font-weight: 600; opacity: .85; }
  .actions { margin-top: 26px; display: flex; gap: 10px; }
  .actions .hint { margin: 0; align-self: center; }
  .f label .rs { font-weight: 400; font-size: 10px; margin-left: 6px; padding: 0 5px; border-radius: 8px; color: var(--vscode-descriptionForeground); border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35)); }
  button { font-family: inherit; font-size: 13px; padding: 6px 16px; cursor: pointer; border: none; border-radius: 6px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  button:disabled { opacity: .6; cursor: not-allowed; }
  button:focus-visible, input:focus-visible, select:focus-visible, summary:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 3px; }
  .activity-head { display:flex; align-items:center; gap:8px; min-width:0; }
  .activity-head .ck-k { margin-bottom:0; flex-shrink:0; }
  .activity-today { margin-left:auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; text-align:right; font-size:11px; color:var(--vscode-descriptionForeground); font-variant-numeric:tabular-nums; }
  .activity-track { display:flex; align-items:center; flex-wrap:wrap; gap:6px 12px; margin-top:6px; }
  .activity-grid { display:flex; gap:4px; min-height:14px; flex-shrink:0; }
  .activity-tooltip { position:fixed; z-index:100; max-width:min(290px,90vw); padding:8px 10px; border:1px solid var(--vscode-widget-border,var(--vscode-panel-border)); border-radius:5px; background:var(--vscode-editorHoverWidget-background,var(--vscode-editor-background)); color:var(--vscode-editorHoverWidget-foreground,var(--vscode-foreground)); white-space:pre-line; font-size:12px; line-height:1.65; pointer-events:none; box-shadow:0 3px 10px #0003; }
  .activity-tooltip[hidden] { display:none; }
  @media(max-width:520px) { .cockpit .cell { padding:10px 8px; } .cockpit .cell.wide { flex:2; } .activity-head { gap:6px; } .activity-grid { gap:3px; } }
  .activity-cell { width:14px; height:14px; border-radius:3px; border:1px solid color-mix(in srgb,var(--vscode-panel-border) 85%,transparent); background:var(--activity-0); padding:0; min-height:0; box-sizing:border-box; flex-shrink:0; cursor:pointer; }
  /* GitHub-style fixed intensity steps: theme accent transparency hid the differences. */
  #activity { --activity-0:#161b22; --activity-1:#0e4429; --activity-2:#006d32; --activity-3:#26a641; --activity-4:#39d353; }
  body.vscode-light #activity, body.vscode-high-contrast-light #activity { --activity-0:#ebedf0; --activity-1:#9be9a8; --activity-2:#40c463; --activity-3:#30a14e; --activity-4:#216e39; }
  .activity-cell[data-level="1"] { background:var(--activity-1); }
  .activity-cell[data-level="2"] { background:var(--activity-2); }
  .activity-cell[data-level="3"] { background:var(--activity-3); }
  .activity-cell[data-level="4"] { background:var(--activity-4); }
  body.vscode-high-contrast .activity-cell, body.vscode-high-contrast-light .activity-cell { border-color:var(--vscode-contrastBorder,var(--vscode-foreground)); }
  .activity-cell:hover { outline:1px solid var(--vscode-foreground); outline-offset:1px; }
  .activity-cell:focus-visible { outline:2px solid var(--vscode-focusBorder); outline-offset:2px; }
  @media(max-width:520px) { #activity .activity-cell { width:12px; height:12px; } }
  .account-card { --account-border: var(--vscode-widget-border, var(--vscode-panel-border)); padding: 24px; border-radius: 14px; }
  .account-head { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px; padding-bottom:18px; border-bottom:1px solid var(--account-border); }
  .account-eyebrow { font-size:10px; letter-spacing:.12em; color:var(--vscode-descriptionForeground); }
  .account-identity { font-size:17px; font-weight:600; margin-top:7px; overflow-wrap:anywhere; }
  .account-badge { padding:4px 9px; border:1px solid var(--account-border); border-radius:20px; font-size:11px; color:var(--vscode-descriptionForeground); }
  .account-grid { display:grid; grid-template-columns:1fr 1fr; gap:20px; margin:22px 0; align-items:end; }
  .account-label { display:block; font-size:11px; color:var(--vscode-descriptionForeground); margin-bottom:8px; }
  .account-card #cloudSubscription { min-height:36px; display:flex; align-items:center; font-size:15px; line-height:1.4; margin:0; }
  .plan-line { display:flex; align-items:center; gap:8px; min-width:0; }
  .account-card #cloudPlan { flex:1 1 auto; min-width:0; height:36px; padding:0 34px 0 11px; border:1px solid var(--account-border); border-radius:7px; color:var(--vscode-dropdown-foreground,var(--vscode-foreground)); background-color:var(--vscode-dropdown-background); font-family:inherit; font-size:12px; cursor:pointer; }
  .account-card #cloudPlan:hover:not(:disabled) { border-color:var(--vscode-focusBorder); }
  .account-card #cloudPlan:focus { outline:1px solid var(--vscode-focusBorder); outline-offset:1px; }
  .account-card #cloudPlan:disabled { cursor:not-allowed; color:var(--vscode-disabledForeground); opacity:.72; }
  .account-card .btnrow { flex-wrap:wrap; gap:8px; }
  .plan-line #cloudBuyCard { flex:0 0 auto; white-space:nowrap; }
  .account-card button { min-height:36px; border-radius:7px; }
  .account-reserved { display:flex; flex-wrap:wrap; gap:8px; margin:12px 0 18px; }
  .account-reserved button { font-size:11px; min-height:30px; background:transparent; border:1px solid var(--account-border); color:var(--vscode-descriptionForeground); opacity:1; }
  .account-note { margin-top:18px; padding-top:14px; border-top:1px solid var(--account-border); font-size:11px; color:var(--vscode-descriptionForeground); line-height:1.65; }
  .buy-modal { position:fixed; inset:0; z-index:70; display:flex; align-items:center; justify-content:center; padding:20px; background:color-mix(in srgb, #000 58%, transparent); backdrop-filter:blur(3px); }
  .buy-dialog { width:min(470px,100%); border:1px solid var(--vscode-widget-border,var(--vscode-panel-border)); border-radius:14px; background:var(--vscode-editor-background); box-shadow:0 18px 60px rgba(0,0,0,.5); overflow:hidden; }
  .buy-dialog-head { padding:20px 22px 15px; border-bottom:1px solid var(--vscode-panel-border); }
  .buy-dialog-eyebrow { font-size:10px; letter-spacing:.13em; color:var(--vscode-descriptionForeground); }
  .buy-dialog-title { margin-top:7px; font-size:19px; font-weight:650; }
  .buy-dialog-body { padding:18px 22px; }
  .buy-summary { display:grid; grid-template-columns:auto 1fr; gap:9px 18px; padding:14px; border:1px solid var(--vscode-panel-border); border-radius:9px; background:var(--vscode-sideBar-background); }
  .buy-summary .k { color:var(--vscode-descriptionForeground); font-size:11px; }
  .buy-summary .v { text-align:right; font-weight:600; overflow-wrap:anywhere; }
  .buy-dialog-note { margin-top:14px; color:var(--vscode-descriptionForeground); font-size:11.5px; line-height:1.65; }
  .buy-dialog-actions { display:flex; justify-content:flex-end; gap:8px; padding:14px 22px 20px; }
  .buy-dialog-actions button { min-width:92px; min-height:36px; }
  @media(max-width:580px) { .account-grid { grid-template-columns:1fr; gap:16px; } .account-card { padding:18px; } .buy-modal{padding:12px}.buy-dialog-actions{flex-direction:column-reverse}.buy-dialog-actions button{width:100%} }
  .build-notice { padding: 8px 10px; border: 1px solid var(--vscode-editorWarning-foreground); border-radius: 5px; color: var(--vscode-editorWarning-foreground); font-size: 12px; }
  .settings-nav { position:fixed; z-index:20; left:0; top:0; bottom:0; width:190px; box-sizing:border-box; padding:14px 10px; background:var(--vscode-sideBar-background); border-right:1px solid var(--vscode-panel-border); overflow:auto; }
  .settings-nav-head { display:flex; align-items:center; gap:8px; min-height:36px; margin-bottom:8px; }
  .settings-nav-title { font-weight:650; font-size:14px; flex:1; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .settings-nav-toggle { width:30px; min-width:30px; height:30px; padding:0; display:grid; place-items:center; background:transparent; border:1px solid transparent; color:var(--vscode-descriptionForeground); }
  .settings-nav-toggle:hover { border-color:var(--vscode-panel-border); color:var(--vscode-foreground); }
  .settings-nav-toggle svg { display:block; width:16px; height:16px; }
  .settings-nav-list { display:grid; gap:3px; list-style:none; margin:0; padding:0; }
  .settings-nav-list > li { min-width:0; }
  .settings-nav-btn { display:flex; align-items:center; gap:9px; width:100%; min-height:34px; padding:0 9px; border:0; border-radius:6px; background:transparent; color:var(--vscode-descriptionForeground); text-align:left; }
  .settings-nav-btn:hover { background:var(--vscode-list-hoverBackground); color:var(--vscode-foreground); }
  .settings-nav-btn[aria-current="page"] { background:var(--vscode-list-activeSelectionBackground); color:var(--vscode-list-activeSelectionForeground); }
  .settings-nav-icon { width:20px; flex:0 0 20px; display:grid; place-items:center; }
  .settings-nav-icon svg { display:block; width:17px; height:17px; }
  body { max-width:1040px; box-sizing:border-box; padding-left:220px; transition:padding-left .15s; }
  body.settings-nav-collapsed { padding-left:86px; }
  body.settings-nav-collapsed .settings-nav { width:58px; padding-left:8px; padding-right:8px; }
  body.settings-nav-collapsed .settings-nav-title, body.settings-nav-collapsed .settings-nav-label { display:none; }
  body.settings-nav-collapsed .settings-nav-btn { justify-content:center; padding-left:0; padding-right:0; }
  body.settings-nav-collapsed .settings-nav-toggle { margin:0 auto; }
  [data-page][hidden] { display:none !important; }
  .settings-mobile-menu, .settings-nav-scrim { display:none; }
  @media(max-width:720px) {
    body, body.settings-nav-collapsed { max-width:760px; padding:58px 14px 50px; }
    body.settings-nav-mobile-open { overflow:hidden; }
    .settings-nav, body.settings-nav-collapsed .settings-nav { right:auto; left:0; top:0; bottom:0; width:min(270px,calc(100vw - 48px)); height:auto; padding:56px 10px 14px; border-right:1px solid var(--vscode-panel-border); border-bottom:0; overflow-x:hidden; overflow-y:auto; transform:translateX(-100%); visibility:hidden; transition:transform .16s ease,visibility .16s step-end; z-index:50; box-shadow:0 10px 28px rgba(0,0,0,.28); }
    body.settings-nav-mobile-open .settings-nav { transform:translateX(0); visibility:visible; transition:transform .16s ease; }
    .settings-nav-head { display:none; }
    .settings-nav-list { display:grid; gap:4px; }
    .settings-nav-btn { width:100%; min-height:44px; white-space:normal; justify-content:flex-start; padding:0 10px; }
    body.settings-nav-collapsed .settings-nav-list { display:grid; }
    body.settings-nav-collapsed .settings-nav-btn { justify-content:flex-start; padding-left:10px; padding-right:10px; }
    body.settings-nav-collapsed .settings-nav-label { display:inline; }
    .settings-nav-scrim { position:fixed; inset:0; z-index:45; display:none; border:0; padding:0; background:rgba(0,0,0,.35); }
    body.settings-nav-mobile-open .settings-nav-scrim { display:block; }
    .settings-mobile-menu { display:grid; place-items:center; position:fixed; top:7px; left:8px; z-index:52; width:44px; height:44px; padding:0; border:1px solid var(--vscode-panel-border); border-radius:6px; background:var(--vscode-sideBar-background); color:var(--vscode-foreground); }
    .settings-mobile-menu:hover { background:var(--vscode-list-hoverBackground); }
    .settings-mobile-menu svg { display:block; width:18px; height:18px; }
    .settings-mobile-menu .mobile-menu-close { display:none; }
    .settings-mobile-menu[aria-expanded="true"] .mobile-menu-bars { display:none; }
    .settings-mobile-menu[aria-expanded="true"] .mobile-menu-close { display:block; }
    body > .settings-page-title { position:static; width:auto; height:auto; margin:0 0 18px; overflow:visible; white-space:normal; line-height:1.4; }
  }
  /* Disclose configuration, keep immediate-action pages free of form controls. */
  .actions[hidden], .settings-save-hint[hidden] { display:none !important; }
  .actions { align-items:center; flex-wrap:wrap; padding:14px 0 6px; border-top:1px solid var(--vscode-panel-border); }
  #saveNote { flex:1 1 220px; color:var(--vscode-descriptionForeground); font-size:12px; line-height:1.6; }
  .service-actions { display:flex; align-items:center; gap:16px; flex-wrap:wrap; }
  .service-actions > div { flex:1 1 220px; }
  .connection-disclosure { margin:16px 0; border:1px solid var(--vscode-panel-border); border-radius:8px; overflow:clip; }
  .connection-disclosure > summary { padding:16px; cursor:pointer; font-weight:600; line-height:1.5; }
  .connection-disclosure > summary small { display:block; margin:4px 0 0 16px; color:var(--vscode-descriptionForeground); font-size:12px; font-weight:400; }
  .connection-disclosure > summary:hover { background:var(--vscode-list-hoverBackground); }
  .connection-disclosure[open] > summary { border-bottom:1px solid var(--vscode-panel-border); }
  .connection-disclosure > .card { border:0; border-radius:0; margin:0; box-shadow:none; }
  .connection-disclosure > .sec { margin:18px 16px 8px; }
  .connection-disclosure .fgrid { grid-template-columns:minmax(0,1fr); }
  .fgrid { grid-template-columns:repeat(2,minmax(0,1fr)); }
  .f, .fgrid > *, .mcpurl > span { min-width:0; overflow-wrap:anywhere; }
  .f input, .f select { max-width:100%; box-sizing:border-box; }
  .chrow, .channel-mode, .mcpurl, .mcp-actions, .btnrow, .semrow { flex-wrap:wrap; }
  button:focus-visible, summary:focus-visible, select:focus-visible { outline:2px solid var(--vscode-focusBorder); outline-offset:2px; }
  @media(max-width:720px) {
    .fgrid { grid-template-columns:minmax(0,1fr); }
    .mcpurl { align-items:flex-start; gap:12px; }
    .mcp-actions { width:100%; gap:8px; }
    .mcp-actions button { flex:1 1 140px; min-height:38px; }
    .connection-disclosure > summary { padding:14px 12px; }
  }
  .row-setting { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:12px; }
  .row-setting > div { min-width:0; }
  .direct-switch { flex:0 0 40px; position:relative; width:40px; min-width:40px; height:24px; padding:0; border:1px solid var(--vscode-panel-border); border-radius:999px; background:var(--vscode-input-background); }
  .direct-switch::after { content:''; position:absolute; top:3px; left:3px; width:16px; height:16px; border-radius:50%; background:var(--vscode-foreground); }
  .direct-switch[aria-checked='true'] { background:var(--vscode-button-background); }
  .direct-switch[aria-checked='true']::after { transform:translateX(16px); background:var(--vscode-button-foreground); }
  .direct-fields, .connector-field { margin-top:16px; }
  .connector-field { max-width:720px; }
  .direct-advanced > .f { padding:14px 16px; max-width:520px; }
  .address-preview { margin:12px 0; padding:10px 12px; background:var(--vscode-editor-background); border:1px solid var(--vscode-panel-border); border-radius:6px; overflow-wrap:anywhere; font-size:12px; line-height:1.65; }
  .f input, .f select { min-width:0; min-height:36px; border-radius:6px; }
  .f input:focus-visible { outline:2px solid var(--vscode-focusBorder); outline-offset:1px; }
  #rmEndpoint { flex:1 1 220px; min-width:0; min-height:36px; }
  #rmDevices li > div { min-width:0; overflow-wrap:anywhere; }
  .pair-modal { padding:0; border:0; background:transparent; color:var(--vscode-foreground); width:min(470px,calc(100vw - 24px)); max-width:calc(100vw - 24px); max-height:calc(100dvh - 24px); }
  .pair-modal:not([open]) { display:none; }
  .pair-modal::backdrop { background:rgba(0,0,0,.48); }
  .pair-modal .buy-dialog { width:100%; max-width:none; box-sizing:border-box; }
  .pair-modal .buy-dialog-note { overflow-wrap:anywhere; }
  .field-label { display:block; margin-bottom:4px; font-size:12px; font-weight:600; }
  .settings-mobile-menu { border-radius:10px; }
  @media(prefers-reduced-motion:reduce) { body, .settings-nav { transition:none; } }
</style>
</head>
<body>
  <nav class="settings-nav" id="settingsNav" aria-label="设置分区">
    <div class="settings-nav-head"><span class="settings-nav-title">设置</span><button type="button" class="settings-nav-toggle" id="settingsNavToggle" aria-label="收起设置菜单" title="收起设置菜单" aria-controls="settingsNav" aria-expanded="true">${renderSettingsIcon('sidebar', 16)}</button></div>
    <ul class="settings-nav-list">${renderSettingsNavItems({ page: 'home', buttonClassName: 'settings-nav-btn', iconClassName: 'settings-nav-icon', labelClassName: 'settings-nav-label' })}</ul>
  </nav>
  <button type="button" class="settings-nav-scrim" id="settingsNavScrim" aria-label="关闭设置菜单" tabindex="-1"></button>
  <button type="button" class="settings-mobile-menu" id="settingsMobileMenu" aria-controls="settingsNav" aria-expanded="false" aria-label="打开设置菜单" title="打开设置菜单">${renderSettingsIcon('menu', 18, 'mobile-menu-bars')}${renderSettingsIcon('close', 18, 'mobile-menu-close')}</button>
  <h1 class="settings-page-title"><span id="settingsPageTitle">首页</span><span class="ver" id="ver"></span></h1>
  <p id="autoNote" class="hint settings-save-hint" role="status" aria-live="polite" hidden></p>
  ${buildNotice}
  <div class="cockpit" data-page="home">
    <div class="cell"><div class="ck-k">账号</div><div class="ck-v home-account-row"><span class="d" id="homeAcctDot"></span><span id="homeAcctName" class="home-account-name">读取中…</span><button id="homeAcctSignOut" class="home-signout" type="button" aria-label="退出登录" title="退出登录" style="display:none">${renderSettingsIcon('logout', 15)}</button></div><div class="ck-msg" id="homeAcctSub">时长待确认</div></div>
    <div class="cell"><div class="ck-k">连接</div><div class="ck-v"><button class="chsw" id="ckSw" type="button" role="switch" aria-checked="false" aria-label="公网渠道开关" hidden></button><span class="d" id="ckCd"></span><span id="ckCv">—</span></div><div class="ck-msg" id="ckSwMsg" role="status" hidden></div></div>
    <div class="build-notice" id="daemonWarn" style="display:none;grid-column:1/-1" role="status"></div>
    <div class="cell wide" id="activity"><div class="activity-head"><div class="ck-k">活动</div><div class="activity-today" id="activityToday">等待本地服务</div></div><div class="activity-track"><div class="activity-grid" id="activityGrid" role="group" aria-label="最近 7 天活动"></div></div></div>
  </div>
  <div id="activityTooltip" class="activity-tooltip" role="tooltip" hidden></div>
  <div class="sec" data-page="home">手机扫码接入<small>扫码后仍需在这台电脑上允许。</small></div>
  <div class="card" data-page="home">
    <div class="scan-head"><div class="scan-icon">${renderSettingsIcon('phone-scan', 20, undefined, 1.7)}</div><div class="scan-copy"><strong>用手机扫码配对</strong><div class="hint">在 BlackHole 手机端扫码配对。</div></div></div>
    <div class="chrow"><select id="rmEndpoint" aria-label="手机扫码入口" style="display:none;max-width:100%"></select><span class="sp"></span><button id="rmProbe" class="secondary" disabled>检测所选入口</button><button id="rmPair" class="secondary" aria-haspopup="dialog" disabled>生成配对码</button></div>
    <div class="hint" id="rmHint" style="margin:6px 0 10px" role="status"></div>
  </div>
  <div class="sec" data-page="account">账号与订阅</div>
  <section class="card account-card" aria-label="账号与订阅" data-page="account">
    <div class="account-head"><div><div class="account-eyebrow">BLACKHOLE ACCOUNT</div><div class="account-identity" id="cloudIdentity">读取账号状态…</div></div></div>
    <div class="account-grid"><div><span class="account-label">服务权益</span><div id="cloudSubscription">订阅状态尚未获取</div></div><div><label class="account-label" for="cloudPlan">订阅方案</label><div class="plan-line"><select id="cloudPlan" disabled><option value="pro_day">1 天 · ¥1.00</option><option value="pro_week">7 天 · ¥5.00</option><option value="pro_month">30 天 · ¥15.00</option></select><button id="cloudBuyCard" class="secondary" disabled>购买所选方案</button></div></div></div>
    <div class="btnrow"><button id="cloudCopyUserId" class="secondary" style="display:none">复制用户 ID</button><button id="cloudSignIn">登录</button><button id="cloudRefresh" class="secondary" disabled>刷新订阅</button><button id="cloudOrders" class="secondary" disabled>购买记录</button><button id="cloudRefund" class="secondary" disabled>申请退款</button><button id="cloudRedeem" class="secondary" disabled>兑换订阅卡</button><button id="cloudSignOut" class="secondary" style="display:none">退出登录</button></div>
    <div class="account-note">服务权益以最近一次服务端校验结果为准。</div>
  </section>
  <div class="sec" id="currentConnectionSec" data-page="connections">当前连接</div>
  <div class="card" data-page="connections" role="status"><strong id="connectionPrimary">读取连接状态…</strong><div class="hint" id="connectionPrimaryHint">以本地服务返回的状态为准。</div></div>
  <div class="sec" id="channelSec" data-page="connections"><span id="channelSecTitle">公网渠道</span><small id="channelSecHint">配置渠道；打开本页不会启动任何渠道。</small></div>
  <div class="card" data-page="connections">
    <div class="channel-mode"><span class="lbl">渠道方式</span><button type="button" class="agchip" data-channel-mode="cloudflare">Cloudflare</button><button type="button" class="agchip" data-channel-mode="openai">OpenAI</button><button type="button" class="agchip" data-channel-mode="custom">自定义</button></div>
    <div id="channelCloudflare"><div class="fgrid channel-config">${cloudflaredField}${publicUrlField}</div><button id="cfInstall" class="secondary" type="button">一键初始化安装</button><div id="cfInstallMessage" class="hint" role="status" aria-live="polite">准备并验证 cloudflared；验证后可选择保存并重启 daemon，不会自动启动渠道。</div><div class="channel-required">cloudflared 由 BlackHole 启停；固定公网地址仅用于持久渠道。修改后需重启 daemon。</div></div>
    <div id="channelOpenai" style="display:none"><div class="fgrid channel-config">${openaiPathField}${openaiIdField}</div><button id="oaInstall" class="secondary" type="button">一键安装</button><div id="oaInstallMessage" class="hint" role="status" aria-live="polite">下载并校验 OpenAI 官方 tunnel-client runtime（纯 runtime 版，不含 cloudflared）；验证通过后自动保存路径，不会启动渠道。</div><div class="fgrid channel-config"><div class="f"><label for="oaKey">Runtime API Key</label><input id="oaKey" type="password" spellcheck="false" autocomplete="off" placeholder="保存后只存在本机"><div class="chrow"><span class="chst dim" id="oaKeyState">…</span><span class="sp"></span><button id="oaKeySave" class="secondary" type="button">保存密钥</button><button id="oaKeyClear" class="secondary" type="button" style="display:none">清除密钥</button></div><div class="d">OpenAI Platform 中创建的 Runtime API Key（需 Tunnels Read/Use 权限）。只保存在本机，不写入设置文件，也不会回显。</div></div></div><div class="chrow"><button id="oaStart" type="button">启动 OpenAI 渠道</button><button id="oaStop" class="secondary" type="button" style="display:none">停止 OpenAI 渠道</button><button id="oaDiag" class="secondary" type="button">诊断</button></div><div id="oaResult" class="hint" role="status" aria-live="polite" style="display:none"></div><div class="channel-required">准备：在 <a href="#" id="oaLinkPlatform" data-link="platform">OpenAI Platform 隧道设置</a> 创建 Tunnel 并复制 Tunnel ID；Runtime API Key 需 Tunnels Read/Use 权限（创建/编辑 Tunnel 另需 Manage），Tunnel 还需关联要使用的 ChatGPT workspace。这些权限本地无法验证，诊断只能提示检查。</div><div class="channel-required">接入 ChatGPT：启动本渠道后，在 <a href="#" id="oaLinkChatgpt" data-link="chatgpt">chatgpt.com/plugins</a> 点 + 新建开发者模式应用（需先在 设置 → 安全 开启开发者模式），Connection 选「Tunnel」并选中该 Tunnel ID；应用名建议与「连接器名称」一致，复制的连接器提示词才能 @ 到它。</div><div class="channel-required">OpenAI Secure MCP Tunnel 只建立出站连接，不提供公网地址，所以只支持连接器提示词，不支持沙箱直连；与 Cloudflare 渠道互不影响，切换页签不会停止任何渠道。</div></div>
    <div id="channelCustom" style="display:none"><div class="fgrid channel-config">${customPublicUrlField}</div><div class="channel-custom-note">反向代理目标：<code id="customLocalTarget">http://127.0.0.1:7307</code>，保留原始 Host。与直连共用一个数据端口；不要代理主 daemon 管理端口。</div></div>
    <div class="chrow channel-actions">
      <span class="chst dim" id="cnst" style="display:none"></span>
      <span class="sp"></span>
      <button id="cnQuick" class="secondary">启动临时</button>
      <button id="cnNamed" class="secondary">启动持久</button>
      <button id="cnStop" class="secondary" style="display:none">停止</button>
      <button id="cnCopy" style="display:none">复制链接</button>
    </div>
    <div class="hint bad" id="cnerr" style="display:none"></div>
    <div class="channel-install"><div class="f"><label for="channelProxyUrl">渠道应用代理（可选）</label><input id="channelProxyUrl" type="text" spellcheck="false" placeholder="http://127.0.0.1:7890"><div class="hint" id="channelProxyHint">用于支持的渠道请求、检测和下载；不是系统代理，不保证 Cloudflare 数据流经过它。</div><div class="hint warn" id="channelProxyPending" role="status" style="display:none">代理已保存；当前 OpenAI 进程仍使用旧配置，停止并重新启动 OpenAI 渠道后生效。</div></div></div>
  </div>
  <dialog class="pair-modal" id="rmModal" aria-labelledby="rmTitle">
    <div class="buy-dialog">
      <div class="buy-dialog-head"><div class="buy-dialog-eyebrow">BLACKHOLE · 手机访问</div><div class="buy-dialog-title" id="rmTitle">用手机扫码</div></div>
      <div class="buy-dialog-body" style="text-align:center">
        <div id="rmQr" style="display:inline-block;background:#fff;padding:12px;border-radius:8px"></div>
        <div class="buy-dialog-note" id="rmLeft"></div>
        <div class="buy-dialog-note" id="rmNote">二维码仅可使用一次。</div>
      </div>
      <div class="buy-dialog-actions"><button class="secondary" id="rmClose" type="button" autofocus>关闭</button><button id="rmAgain" type="button">重新生成</button></div>
    </div>
  </dialog>
  <div class="sec" id="aiRouteSec" data-page="connections">默认连接<small>通常保持“自动”即可。</small></div>
  <div class="card" id="aiRouteCard" data-page="connections"><div class="f">
    <label for="aiDefaultRoute">默认连接方式</label><select id="aiDefaultRoute" disabled>
      <option value="auto">自动</option><option value="direct">固定使用直连</option><option value="cloudflare">固定使用 Cloudflare</option><option value="custom">固定使用自定义公网入口</option><option value="openai">固定使用 OpenAI Tunnel</option>
    </select><div class="hint" id="aiRouteHint">自动：直连开启时使用直连，否则使用上方选择的公网渠道。固定选择不会被抢占；不可用时提示，不自动换线。</div>
  </div></div>
  <div class="sec" id="mcpSec" data-page="connections">连接器</div>
  <div class="card" data-page="connections">
    <div class="mcpurl"><span id="mcpurl">连接信息待确认</span><div class="mcp-actions"><button id="mcpCopy" disabled>复制 MCP 链接</button><button id="mcpDesc" class="secondary">复制连接器描述</button></div></div>
    <div class="connector-field">${connectorField}</div>
    <div class="channel-install chrow"><span class="hint">重置会使旧 MCP 链接失效。</span><span class="sp"></span><button id="mcpRotate" class="secondary">重置 MCP 链接</button></div>
  </div>
  <div class="sec" data-page="agents">MCP Proxies</div>
  <div class="card" data-page="agents">
    <div id="pxBody"><div class="hint" style="margin:0">读取中…</div></div>
    <div class="btnrow" style="margin-top:10px">
      <button id="pxAdd" class="secondary" disabled>添加 MCP</button>
      <button id="pxImport" class="secondary" disabled>导入 JSON</button>
      <button id="pxReval" class="secondary" disabled>重新校验</button>
    </div>
    <div id="pxForm"></div>
    <div id="pxImportBox"></div>
    <div class="pxkv" id="pxMsg"></div>
    <div id="pxReport"></div>
  </div>
  <div class="pxmodal" id="pxModal" style="display:none" data-page="agents">
    <div class="pxmbox">
      <div class="pxmhd"><span class="pxmt" id="pxModalTitle"></span><span class="sp"></span><button class="pxe" data-modal-close="1">关闭</button></div>
      <div class="pxkv" id="pxModalStatus" role="status" aria-live="polite"></div>
      <div class="pxmbody" id="pxModalBody"></div>
    </div>
  </div>
  <div class="sec" data-page="agents">常用</div>
  <div class="card" data-page="agents">
    <div class="fgrid">${common}</div>
  </div>
  <div class="sec" data-page="agents">Web Agent 显示</div>
  <div class="card" data-page="agents">
    <div class="hint" style="margin:0 0 10px">选择要显示的预置站点；自定义站点始终显示。</div>
    <div id="wagrid" class="agrid"></div>
    <div class="subsec">自定义站点（手动添加）</div>
    <div id="walist"></div>
    <div class="waadd">
      <input id="waName" aria-label="站点名称" class="nm" placeholder="名称，如 Kimi" spellcheck="false">
      <input id="waUrl" aria-label="站点网址" placeholder="网址，如 kimi.com" spellcheck="false">
      <button id="waAdd" class="secondary">添加</button>
    </div>
  </div>
  <div class="sec" data-page="agents">Courier 网页站点</div>
  <div class="card" data-page="agents">
    <div class="hint" style="margin:0 0 10px">在浏览器 Courier 里用「检测此页面」接入的网页 AI，新会话可以选它们。删除后 Courier 会解除它的绑定、停止接管该网站并收回访问权限。</div>
    <div id="cslist" style="display:grid;gap:8px"></div>
  </div>
  <div class="sec" data-page="network">直连</div>
  <div class="card network-entry" data-page="network">
    <div class="row-setting"><div><strong>开启直连</strong><div class="hint">局域网、组网和自己配置的公网映射，共用这一个开关。</div></div><button id="directAccessToggle" type="button" role="switch" class="direct-switch" aria-label="开启直连" aria-checked="false" disabled></button></div>
    <div class="chst" id="directState" role="status">读取直连状态…</div>
    <div class="f direct-fields"><label for="directAccessUrl">对外访问地址（可选）</label><input id="directAccessUrl" type="text" spellcheck="false" placeholder="https://bh.example.com 或 http://你的公网IP:7307" disabled><div class="hint" id="directUrlHint">复制给 Agent 的 HTTP(S) 地址；留空使用自动发现的本机地址。保存地址不会开启直连。</div></div>
    <div class="address-preview" id="directResolved">多个本机地址在复制时选择；不修改监听范围。</div>
    <details class="connection-disclosure direct-advanced"><summary>高级<small>监听端口，通常不需要修改。</small></summary><div class="f"><label for="directPort">监听端口</label><input id="directPort" inputmode="numeric" type="text" value="7307" spellcheck="false" disabled><div class="hint" id="directPortHint">直连与反向代理共用此端口；外部映射端口可以不同。修改会短暂中断已有连接。</div></div></details>
    <div class="hint" id="directSaveNote" role="status"></div>
    <div class="hint">DNS、端口映射和 TLS 由你配置。仅开放连接所需的数据接口，不开放本地管理 API。</div>
  </div>
  <div class="sec" data-page="network">检测与诊断</div>
  <div class="card" data-page="network"><div class="fgrid">${network}</div></div>
  <div class="sec" data-page="security">已配对设备<small>撤销后该设备需要重新扫码。</small></div>
  <div class="card" data-page="security"><ul id="rmDevices" style="list-style:none;margin:0;padding:0"></ul></div>
  <div class="sec" data-page="security">授权管理</div>
  <div class="card" data-page="security">
    <div class="hint" style="margin:0 0 10px">全局授权会保留；会话授权仅当前 daemon 生命周期有效。删除后相关操作会重新询问。</div>
    <div id="aglist" style="display:grid;gap:8px"></div>
    <div class="btnrow" style="margin-top:10px">
      <button id="agClear" class="secondary">清除全部全局授权</button>
    </div>
  </div>
  <section data-page="advanced"><div class="sec">运行参数</div><div class="card"><div class="fgrid">${advanced}</div></div>
    <div class="sec">本地服务</div><div class="card service-actions"><div><b>重启 daemon</b><div class="hint">服务异常或设置提示需重启时使用；重启会中断正在进行的连接。</div></div><button id="restart" class="secondary">重启 daemon</button></div>
  </section>
  <div class="actions" id="settingsActions" hidden>
    <span id="saveNote" role="status" aria-live="polite"></span>
    <button id="save" title="只保存当前页面的手动设置">保存本页</button>
  </div>
  <div class="buy-modal" id="cloudBuyModal" style="display:none" role="dialog" aria-modal="true" aria-labelledby="cloudBuyTitle">
    <div class="buy-dialog">
      <div class="buy-dialog-head"><div class="buy-dialog-eyebrow">BLACKHOLE · 单次订阅购买</div><div class="buy-dialog-title" id="cloudBuyTitle">确认购买方案</div></div>
      <div class="buy-dialog-body"><div class="buy-summary"><span class="k">订阅方案</span><span class="v" id="cloudBuyPlanText">—</span><span class="k">购买账号</span><span class="v" id="cloudBuyUserText">—</span><span class="k">到账方式</span><span class="v">支付确认后自动叠加</span></div><div class="buy-dialog-note">下一步将在系统浏览器打开 BlackHole 支付确认页，再进入支付宝收银台。每次购买均为单次付款，不会自动续费；无需领取卡密或联系管理员开通。</div></div>
      <div class="buy-dialog-actions"><button id="cloudBuyCancel" class="secondary">取消</button><button id="cloudBuyConfirm">前往付款</button></div>
    </div>
  </div>
  <script nonce="${nonce}">
    const vs = acquireVsCodeApi();

    const $ = (id) => document.getElementById(id);
    const SETTINGS_PAGES=${JSON.stringify(SETTINGS_PAGES)};
    const SETTINGS_LABELS=${JSON.stringify(SETTINGS_LABELS)};
    const settingsState=vs.getState()||{};
    let settingsPage=SETTINGS_PAGES.includes(settingsState.settingsPage)?settingsState.settingsPage:'home';
    let settingsNavCollapsed=settingsState.settingsNavCollapsed===true;
    let settingsNavMobileOpen=false;
    let rmTimer = null, rmDevices = [], rmView = null, rmSelectedOrigin = '', rmPairBusy = false, rmRequest = 0, rmPreviousFocus = null;
    const isNarrowSettingsNav=()=>typeof window.matchMedia==='function'&&window.matchMedia('(max-width:720px)').matches;
    const MANUAL_FORM_PAGES = ['connections', 'network', 'agents', 'advanced'];
    function renderSettingsActions() {
      $('settingsActions').hidden = !MANUAL_FORM_PAGES.includes(settingsPage);
      $('saveNote').textContent = '仅保存本页标有「需重启」的设置；其他页面的输入不会提交。';
    }
    function resetSaveHint() {
      const note = $('autoNote');
      note.hidden = !MANUAL_FORM_PAGES.includes(settingsPage);
      note.className = 'hint settings-save-hint';
      note.textContent = '普通设置修改后自动保存；标有「需重启」的字段改完后点保存。';
    }
    function saveSettingsUi(){vs.setState(Object.assign({},vs.getState()||{},{settingsPage,settingsNavCollapsed}));}
    function persistSettingsUi(){saveSettingsUi();vs.postMessage({type:'settingsUi',page:settingsPage,collapsed:settingsNavCollapsed});}
    function applySettingsNav(){
      document.body?.classList?.toggle('settings-nav-collapsed',settingsNavCollapsed);
      document.body?.classList?.toggle('settings-nav-mobile-open',settingsNavMobileOpen);
      const toggle=$('settingsNavToggle');
      if(toggle){const label=settingsNavCollapsed?'展开设置菜单':'收起设置菜单';toggle.setAttribute('aria-label',label);toggle.title=label;toggle.setAttribute('aria-expanded',String(!settingsNavCollapsed));}
      document.querySelectorAll('[data-settings-target]').forEach((item)=>{const label=SETTINGS_LABELS[item.dataset.settingsTarget]||'';item.title=settingsNavCollapsed&&!isNarrowSettingsNav()?label:'';});
      const mobile=$('settingsMobileMenu'), nav=$('settingsNav'), scrim=$('settingsNavScrim');
      if(mobile){mobile.setAttribute('aria-expanded',String(settingsNavMobileOpen));mobile.setAttribute('aria-label',settingsNavMobileOpen?'关闭设置菜单':'打开设置菜单');mobile.title=settingsNavMobileOpen?'关闭设置菜单':'打开设置菜单';}
      if(nav)nav.setAttribute('aria-hidden',isNarrowSettingsNav()&&!settingsNavMobileOpen?'true':'false');
      if(scrim)scrim.hidden=!(isNarrowSettingsNav()&&settingsNavMobileOpen);
    }
    function closeSettingsMobileNav(){
      if(!settingsNavMobileOpen)return;
      settingsNavMobileOpen=false;applySettingsNav();
      const target=isNarrowSettingsNav()?$('settingsMobileMenu'):$('settingsNavToggle');
      if(target&&!target.disabled)target.focus();
    }
    function applySettingsPage(page){
      if (page !== settingsPage && (rmPairBusy || $('rmModal').open)) closeRemoteQr();
      settingsPage=SETTINGS_PAGES.includes(page)?page:'home';
      if(settingsNavMobileOpen)closeSettingsMobileNav();
      document.querySelectorAll('[data-page]').forEach(el=>{el.hidden=el.dataset.page!==settingsPage;});
      document.querySelectorAll('[data-settings-target]').forEach(el=>el.setAttribute('aria-current',el.dataset.settingsTarget===settingsPage?'page':'false'));
      const title=$('settingsPageTitle');if(title)title.textContent=SETTINGS_LABELS[settingsPage]||'设置';
      resetSaveHint();
      renderSettingsActions();
      saveSettingsUi();
      if(typeof window.scrollTo==='function')window.scrollTo({top:0,behavior:'auto'});
    }
    document.querySelectorAll('[data-settings-target]').forEach(btn=>btn.addEventListener('click',()=>{applySettingsPage(btn.dataset.settingsTarget);persistSettingsUi();}));
    $('settingsNavToggle').onclick=()=>{settingsNavCollapsed=!settingsNavCollapsed;applySettingsNav();persistSettingsUi();};
    $('settingsMobileMenu').addEventListener('click',()=>{settingsNavMobileOpen=!settingsNavMobileOpen;applySettingsNav();if(settingsNavMobileOpen)document.querySelector('[data-settings-target][aria-current="page"]')?.focus();});
    $('settingsNavScrim').addEventListener('click',closeSettingsMobileNav);
    window.addEventListener('keydown',event=>{if(event.key==='Escape'&&settingsNavMobileOpen){event.preventDefault();event.stopPropagation();closeSettingsMobileNav();}});
    window.addEventListener('resize',()=>{if(!isNarrowSettingsNav()&&settingsNavMobileOpen)closeSettingsMobileNav();});
    applySettingsNav();
    applySettingsPage(settingsPage);
    for(const [id,action] of [['cloudSignIn','signIn'],['cloudRedeem','redeem'],['cloudSignOut','signOut'],['homeAcctSignOut','signOut'],['cloudRefresh','refresh'],['cloudOrders','orders'],['cloudRefund','refund']]){
      $(id).onclick=()=>vs.postMessage({type:'cloudAccount',action});
    }
    const closeBuyModal=()=>{$('cloudBuyModal').style.display='none';};
    $('cloudBuyCard').onclick=()=>{const option=$('cloudPlan').selectedOptions[0],userId=$('cloudCopyUserId').dataset.userId;if(!userId)return;$('cloudBuyPlanText').textContent=option?.textContent||'所选方案';$('cloudBuyUserText').textContent=userId.slice(0,8)+'…'+userId.slice(-4);$('cloudBuyModal').style.display='flex';$('cloudBuyConfirm').focus();};
    $('cloudBuyCancel').onclick=closeBuyModal;
    $('cloudBuyModal').onclick=event=>{if(event.target===$('cloudBuyModal'))closeBuyModal();};
    $('cloudBuyConfirm').onclick=()=>{const sku=$('cloudPlan').value;closeBuyModal();vs.postMessage({type:'cloudAccount',action:'buyCard',sku});};
    window.addEventListener('keydown',event=>{if(event.key==='Escape'&&$('cloudBuyModal').style.display!=='none')closeBuyModal();});
    $('cloudCopyUserId').onclick=()=>{const userId=$('cloudCopyUserId').dataset.userId;if(userId)vs.postMessage({type:'copyUserId',userId});};
    window.addEventListener('message',event=>{
      if(event.data?.type!=='cloudAccount')return;
      const v=event.data.view||{},a=v.account,s=event.data.summary||{};
      const loggedIn=s.canSignOut===true;
      const name=s.displayName||(a?.name||a?.email)||(loggedIn?'BlackHole 用户':'尚未登录');
      const email=s.email||a?.email||'';
      const remaining=s.accountStatus==='suspended'?'账号已停用':s.accountStatus==='pending'?'订阅准备中':(s.remainingLabel||'时长待确认');
      $('homeAcctName').textContent=name;$('homeAcctName').title=email||name;
      $('homeAcctSub').textContent=remaining;
      $('homeAcctDot').className='d '+(s.remainingSeconds===0?'bad':typeof s.remainingSeconds==='number'&&s.remainingSeconds<259200?'warn':'');
      $('homeAcctSignOut').style.display=loggedIn?'':'none';$('homeAcctSignOut').disabled=!loggedIn;
      $('cloudIdentity').textContent=loggedIn?(email&&name!==email?name+' · '+email:name):'尚未登录';
      $('cloudCopyUserId').style.display=v.userId?'':'none';$('cloudCopyUserId').dataset.userId=v.userId||'';
      $('cloudSubscription').textContent=remaining;
      $('cloudSignIn').style.display=loggedIn?'none':'';
      $('cloudSignOut').style.display=loggedIn?'':'none';$('cloudSignOut').disabled=!loggedIn;
      $('cloudRefresh').disabled=!loggedIn;$('cloudRedeem').disabled=!loggedIn;$('cloudPlan').disabled=!loggedIn;$('cloudBuyCard').disabled=!loggedIn;$('cloudOrders').disabled=!loggedIn;$('cloudRefund').disabled=!loggedIn;
    });
    const KEYS = ${JSON.stringify(KEYS)};
    let semanticDirty = false, channelDraftPending = false, pendingManualKey = '';
    for (const id of KEYS.concat(['customPublicBaseUrl', 'semKey'])) {
      const el = $(id); if (!el) continue;
      el.addEventListener('input', () => { el.dataset.dirty = 'true'; });
    }
    function acknowledgeForm(values) {
      for (const [key,value] of Object.entries(values || {})) {
        const ids = key === 'publicBaseUrl' ? ['publicBaseUrl','customPublicBaseUrl'] : [key];
        for (const id of ids) if ($(id) && $(id).value.trim() === String(value).trim()) $(id).dataset.dirty = 'false';
        if (key === 'semanticMode' && semMode === value) semanticDirty = false;
        if (key === 'channelMode' && channelMode === value) channelDraftPending = false;
      }
    }
    // 不触发 daemon 重启的设置：选中 / 离开输入框即自动保存（其余走「保存」按钮）。
    const AUTO_KEYS = ${JSON.stringify([...AUTO_SAVE_KEYS])};
    let autoNoteTimer;
    function autosave(values, webAgents) {
      vs.postMessage(Object.assign({ type: 'autosave', values: values || {} }, webAgents ? { webAgents } : {}));
    }
    function onAutosaved(m) {
      if (m.ok) acknowledgeForm(m.values);
      const n = $('autoNote');
      clearTimeout(autoNoteTimer);
      if (!m.ok) { n.textContent = m.message; n.className = 'hint bad'; return; }
      if (!m.message) return;
      n.textContent = m.message; n.className = 'hint ok';
      autoNoteTimer = setTimeout(() => { n.textContent = '其余设置修改后自动保存；标有「需重启」的改完点保存。'; n.className = 'hint'; }, 2500);
    }
    // 驾驶舱的渠道总开关：开 = 启动上次使用的渠道，关 = 停止所有渠道（daemon /channel）。
    const SW_NAMES = { quick: '临时渠道', named: '持久渠道', openai: 'OpenAI 渠道' };
    let swBusy = false;
    function renderCockpitSwitch(c, daemon) {
      const sw = $('ckSw');
      sw.hidden = !c || daemon !== 'running';
      if (sw.hidden) return;
      sw.setAttribute('aria-checked', c.on ? 'true' : 'false');
      sw.dataset.state = swBusy ? 'starting' : c.state;
      sw.disabled = swBusy || c.state === 'starting';
      sw.title = c.on
        ? '关闭：停止' + c.running.map((x) => SW_NAMES[x] || x).join('、')
        : '开启：' + (SW_NAMES[c.next] || c.next) + (c.last ? '（上次使用）' : '')
          + (c.missing === 'cloudflared' ? ' · 需要先安装 cloudflared' : '')
          + (c.state === 'error' && c.reason ? ' · 上次失败：' + c.reason : '');
    }
    $('ckSw').addEventListener('click', () => {
      const sw = $('ckSw');
      if (sw.disabled) return;
      swBusy = true;
      const on = sw.getAttribute('aria-checked') !== 'true';
      sw.dataset.state = 'starting'; sw.disabled = true;
      $('ckSwMsg').hidden = true;
      vs.postMessage({ type: 'channelToggle', on });
    });
    function onChannelToggleResult(m) {
      swBusy = false;
      const box = $('ckSwMsg');
      box.textContent = m.message || '';
      box.hidden = !m.message;
      // 缺前提时把「公网渠道」切到对应标签（只切显示，不保存），方便就地补上。
      const tab = m.code === 'openai_setup' ? 'openai' : m.code === 'cloudflared' || m.code === 'named_url' ? 'cloudflare' : '';
      if (tab) { renderChannelMode(tab); renderStatus(lastStatus || { overview: {} }); $('channelCloudflare').closest('.card').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    }
    for (const k of AUTO_KEYS) {
      const input = document.getElementById(k);
      // change 只在内容改过并离开输入框（或回车）时触发，不会逐字保存。
      if (input) input.addEventListener('change', () => autosave({ [k]: input.value.trim() }));
    }
    function esc(s) { return (s ?? '').replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';'); }
    const activityCells = new Map();
    let activitySignature = '', activityHovered = null;
    const usageNumber = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
    const setText = (node, value) => { if (node.textContent !== value) node.textContent = value; };
    function showActivityTip(cell) {
      const tip = $('activityTooltip');
      if (!cell || !cell.isConnected) { tip.hidden = true; return; }
      setText(tip, cell.getAttribute('aria-label') || '');
      tip.hidden = false;
      const rect = cell.getBoundingClientRect();
      tip.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - tip.offsetWidth - 8)) + 'px';
      tip.style.top = (rect.bottom + tip.offsetHeight + 8 < window.innerHeight ? rect.bottom + 6 : Math.max(8, rect.top - tip.offsetHeight - 6)) + 'px';
    }
    function activityCallLevel(total) {
      return total <= 0 ? 0 : Math.min(4, Math.floor(total / 1000) + 1);
    }
    function normalizeActivityDays(inputDays) {
      const unique = new Map();
      for (const d of Array.isArray(inputDays) ? inputDays : []) {
        if (!d || !Number.isFinite(d.start) || !Number.isFinite(new Date(d.start).getTime())) continue;
        // Duplicate buckets are snapshots, not extra calls; latest snapshot wins.
        unique.set(d.start, {start:d.start,total:usageNumber(d.total),added:usageNumber(d.diff_added),removed:usageNumber(d.diff_removed)});
      }
      return Array.from(unique.values()).sort((a,b) => a.start-b.start).slice(-7);
    }
    function renderActivity(stats, inputDays) {
      // A transient disconnect is not an empty day; preserve the last valid counters.
      if (!stats) { $('activity').setAttribute('aria-label', '活动：本地服务未连接'); return; }
      $('activity').setAttribute('aria-label', '活动：最近 7 天，本机统计');
      const days = normalizeActivityDays(inputDays);
      const today = '今日 '+usageNumber(stats.total)+' 次 · +'+usageNumber(stats.diff_added)+' −'+usageNumber(stats.diff_removed)+' 行';
      const signature = JSON.stringify([today, days]);
      if (signature === activitySignature) return;
      activitySignature = signature;
      setText($('activityToday'), today);
      const present = new Set(days.map(d => String(d.start))), grid = $('activityGrid');
      for (const [key, cell] of activityCells) if (!present.has(key)) { cell.remove(); activityCells.delete(key); }
      for (const [index, day] of days.entries()) {
        const key = String(day.start);
        let cell = activityCells.get(key);
        if (!cell) {
          cell = document.createElement('button'); cell.type = 'button'; cell.className = 'activity-cell'; cell.dataset.day = key;
          cell.setAttribute('aria-describedby', 'activityTooltip');
          cell.addEventListener('mouseenter', () => { activityHovered = cell; showActivityTip(cell); });
          cell.addEventListener('mouseleave', () => { activityHovered = null; showActivityTip(activityCells.has(document.activeElement?.dataset?.day) ? document.activeElement : null); });
          cell.addEventListener('focus', () => showActivityTip(cell));
          cell.addEventListener('blur', () => showActivityTip(activityHovered));
          cell.addEventListener('click', () => showActivityTip(cell));
          cell.addEventListener('keydown', e => { if (e.key === 'Escape') $('activityTooltip').hidden = true; });
          activityCells.set(key, cell); grid.appendChild(cell);
        }
        if (grid.children[index] !== cell) grid.insertBefore(cell, grid.children[index] || null);
        const date = new Date(day.start);
        const level = String(activityCallLevel(day.total));
        const label = [date.getFullYear()+'年'+(date.getMonth()+1)+'月'+date.getDate()+'日', day.total+' 次工具调用', '+'+day.added+' / −'+day.removed+' 行'].join(String.fromCharCode(10));
        if (cell.getAttribute('aria-label') !== label) cell.setAttribute('aria-label', label);
        // Fixed call-count levels avoid recoloring other days whenever today's count grows.
        // Each 1,000 calls advances a shade; 3,000+ saturates the fourth green.
        if (cell.dataset.level !== level) cell.dataset.level = level;
      }
      if (!$('activityTooltip').hidden) showActivityTip(activityHovered || document.activeElement);
    }
    window.addEventListener('scroll', () => { $('activityTooltip').hidden = true; }, true);
    let lastStatus = null;
    function renderStatus(m) {
      lastStatus = m;
      const o = m.overview || {};
      // 首页正常态优先展示账号；daemon 只在异常时占用醒目位置。
      const daemonWarn = $('daemonWarn');
      const daemonText = o.daemon === 'starting' ? '本地服务正在启动…'
        : o.daemon === 'error' ? '本地服务异常，请到“高级”查看并处理。'
          : o.daemon === 'stopped' ? '本地服务未运行，请到“高级”启动。' : '';
      daemonWarn.style.display = daemonText ? '' : 'none';
      daemonWarn.textContent = daemonText;
      $('ver').textContent = o.version ? 'v' + o.version : '';
      // 驾驶舱：渠道（overview 扁平字段：tunnel / tunnel_mode / tunnel_reason）
      const t = o.tunnel;
      const cmap = { online: ['ok', o.tunnel_mode === 'named' ? '持久在线' : '临时在线'], unverified: ['warn', '未验证'], starting: ['warn', '启动中…'], error: ['bad', '启动失败'], unavailable: ['bad', '不可用'], unreachable: ['', '未连接'] };
      const customMap = { idle: ['', '待检测'], probing: ['warn', '检测中…'], online: ['ok', '自定义在线'], error: ['bad', '自定义不可达'] };
      // Overview: every running channel in one line (持久 · gpt), not just the selected mode; same wording as Web channelSummary.
      const kind = o.tunnel_mode === 'named' ? '持久' : '临时';
      const cfSum = { online: ['ok', kind], unverified: ['warn', kind + '未验证'], starting: ['warn', 'Cloudflare 启动中…'], error: ['bad', 'Cloudflare 失败'], unavailable: ['bad', 'Cloudflare 不可用'] };
      const gpSum = { ready: ['ok', 'gpt'], recovering: ['warn', 'gpt 恢复中'], starting: ['warn', 'gpt 启动中…'], stopping: ['warn', 'gpt 停止中…'], error: ['bad', 'gpt 失败'], unavailable: ['bad', 'gpt 不可用'] };
      const parts = [];
      if (channelMode === 'custom' && customProbe.state === 'online') parts.push(['ok', '自定义']);
      if (cfSum[t]) parts.push(cfSum[t]);
      if (o.openai_tunnel && gpSum[o.openai_tunnel.status]) parts.push(gpSum[o.openai_tunnel.status]);
      const routeView = o.connection_routes || null;
      const routeNames = { direct:'直连', cloudflare:'Cloudflare', custom:'自定义公网入口', openai:'OpenAI Tunnel' };
      $('connectionPrimary').textContent = routeView ? '当前默认：' + (routeNames[routeView.selected_route] || '待确认') : '连接状态待确认';
      $('connectionPrimaryHint').textContent = o.daemon !== 'running' ? '本地服务未连接' : !routeView ? '等待本地服务返回连接状态。' : routeView.needs_choice ? '多个直连地址，复制时选择目标 Agent 能访问的地址。' : routeView.connector_ready ? '默认连接已配置；网络可达性以目标客户端实际连接为准。' : '当前默认入口尚未就绪，不会自动改用其他渠道。';
      const cm = t === 'unreachable' ? cmap.unreachable : !parts.length ? ['', '未启动']
        : [parts.every((p) => p[0] === parts[0][0]) ? parts[0][0] : 'warn', parts.map((p) => p[1]).join(' · ')];
      void customMap;
      $('ckCd').className = 'd ' + cm[0];
      $('ckCv').textContent = cm[1];
      renderCockpitSwitch(o.channel, o.daemon);
      renderActivity(o.stats, o.activity_days);
      // 公网渠道卡片按钮可见性
      const hasNamed = !!o.public_base_url;
      const st = $('cnst'), err = $('cnerr');
      const bQ = $('cnQuick'), bN = $('cnNamed'), bS = $('cnStop'), bC = $('cnCopy');
      err.style.display = 'none'; err.className = 'hint';
      bC.style.display = 'none'; bS.style.display = 'none'; bQ.style.display = ''; bN.style.display = '';
      if (channelMode === 'custom') {
        bQ.style.display = 'none'; bN.style.display = 'none'; bS.style.display = 'none'; bC.style.display = 'none';
        const customStatus = customProbe.state === 'online' ? ['自定义 · 在线', 'ok'] : customProbe.state === 'probing' ? ['检测中…', 'warn'] : customProbe.state === 'error' ? ['自定义 · 不可达', 'bad'] : ['待检测', 'dim'];
        st.textContent = customStatus[0]; st.style.display = ''; st.className = 'chst ' + customStatus[1];
        if (customProbe.detail) { err.textContent = customProbe.detail; err.className = 'hint ' + (customProbe.state === 'error' ? 'bad' : ''); err.style.display = 'block'; }
      }
      if (channelMode === 'openai') {
        bQ.style.display = 'none'; bN.style.display = 'none'; bS.style.display = 'none'; bC.style.display = 'none';
        const ready = $('openaiTunnelClientPath').value.trim() !== '';
        const v = renderOpenaiRuntime(o);
        if (!ready && !(v && v.run_id)) { st.textContent = '未安装 tunnel-client'; st.className = 'chst dim'; }
        else if (!v) { st.textContent = 'tunnel-client 已就绪'; st.className = 'chst ok'; }
        else {
          const lab = oaLabels[v.status] || ['', v.status];
          st.textContent = 'OpenAI · ' + lab[1]; st.className = 'chst ' + (lab[0] || 'dim');
          if (v.reason) { err.textContent = v.reason; err.className = 'hint ' + (v.status === 'error' ? 'bad' : 'warn'); err.style.display = 'block'; }
        }
        st.style.display = '';
      }
      if (channelMode === 'cloudflare') {
      bN.disabled = !hasNamed;
      bN.title = hasNamed ? '启动持久渠道（固定域名）' : '持久渠道需先在「常用 → 固定公网域名」里配置';
      st.style.display = 'none';
      if (t === 'online' || t === 'unverified') {
        const named = o.tunnel_mode === 'named';
        st.textContent = (t === 'online' ? '在线 · ' : '未验证 · ') + (named ? '持久' : '临时');
        st.style.display = ''; st.className = t === 'online' ? 'chst ok' : 'chst warn';
        if (o.tunnel_reason) { err.textContent = o.tunnel_reason; err.className = 'hint warn'; err.style.display = 'block'; }
        bS.style.display = ''; bC.style.display = '';
        // 渠道互斥：在线时不允许直接切换。必须先停止，再重新选择临时或持久。
        bQ.style.display = 'none';
        bN.style.display = 'none';
      } else if (t === 'starting') {
        st.textContent = '启动中…'; st.style.display = ''; st.className = 'chst warn';
        if (o.tunnel_reason) { err.textContent = o.tunnel_reason; err.className = 'hint warn'; err.style.display = 'block'; }
        bQ.style.display = 'none'; bN.style.display = 'none'; bS.style.display = '';
      } else if (t === 'error' || t === 'unavailable') {
        st.textContent = t === 'error' ? '启动失败' : '不可用'; st.style.display = ''; st.className = 'chst bad';
        if (o.tunnel_reason) { err.textContent = o.tunnel_reason; err.className = 'hint bad'; err.style.display = 'block'; }
        // 失败状态保留启动按钮：换条件后可直接重试或换渠道，不必先点停止
        bS.style.display = '';
        bQ.style.display = ''; bN.style.display = '';
      } else if (t === 'unreachable') {
        st.textContent = 'daemon 未运行'; st.style.display = ''; st.className = 'chst dim';
        bQ.style.display = 'none'; bN.style.display = 'none';
      } else {
        st.textContent = '未启动'; st.style.display = ''; st.className = 'chst dim';
      }
      }
      const proxyPending = $('channelProxyPending');
      if (proxyPending) proxyPending.style.display = o.openai_tunnel?.proxy_pending_restart ? '' : 'none';
      const routes = o.connection_routes || null;
      const selectedOpenAI = routes ? routes.selected_route === 'openai' || routes.reason === 'openai_selected' : channelMode === 'openai';
      if (selectedOpenAI) {
        const tid = o.openai_tunnel_id || '';
        $('mcpSec').textContent = '连接器';
        $('mcpurl').dataset.url = '';
        $('mcpurl').textContent = tid ? 'Tunnel ID：' + tid : '尚未保存 Tunnel ID';
        $('mcpCopy').textContent = '复制 Tunnel ID';
        $('mcpCopy').dataset.kind = 'openai';
        $('mcpCopy').disabled = !tid;
        $('mcpRotate').style.display = 'none';
        $('mcpDesc').disabled = false;
      } else {
        const mcpValue = routes ? (routes.preferred_mcp_url || '') : (o.mcp_url || '');
        const mcpLocal = mcpValue.indexOf('://127.') > 0 || mcpValue.indexOf('://localhost') > 0 || mcpValue.indexOf('://[::1]') > 0;
        $('mcpSec').textContent = '连接器';
        $('mcpurl').dataset.url = mcpValue;
        if (routes && routes.needs_choice) $('mcpurl').textContent = '检测到多个直连地址，请先明确目标网络';
        else if (mcpValue) $('mcpurl').textContent = mcpLocal ? 'MCP 链接仅本机可用' : (routes && routes.preferred_mcp_kind === 'direct' ? '直连 MCP 链接已就绪' : 'MCP 链接已就绪');
        else $('mcpurl').textContent = routes?.reason === 'direct_unavailable' ? '已选择直连，但监听当前不可用' : routes?.reason === 'custom_unavailable' ? '自定义地址尚未配置' : 'MCP 链接尚未就绪';
        $('mcpCopy').textContent = '复制 MCP 链接';
        $('mcpCopy').dataset.kind = 'url';
        $('mcpCopy').disabled = o.daemon !== 'running' || (!mcpValue && !routes?.needs_choice);
        $('mcpRotate').style.display = '';
        $('mcpRotate').disabled = o.daemon !== 'running';
        $('mcpDesc').disabled = false;
      }
      // semantic 字段只在整页刷新时携带（status 轮询不带，见 overview 注释）
      if (o.semantic !== undefined) renderSemantic(o.semantic ?? null);
    }
    // Devin Key 卡片：registered = 当前已生效；would_resolve = 已保存待重启
    function renderSemantic(info) {
      const st = $('semst'), clr = $('semClear');
      if (!info) { st.textContent = '（daemon 未运行）'; st.className = 'chst dim'; clr.style.display = 'none'; return; }
      if (info.registered) {
        const from = info.registered_source === 'env' ? ' · 来自环境变量' : ' · ' + (info.registered_preview || '已配置');
        st.textContent = '已生效' + from;
        st.className = 'chst ok';
        // env 来源优先级最高：清 key 文件不改变任何行为，藏掉避免无效操作
        clr.style.display = info.registered_source === 'file' ? '' : 'none';
      } else if (info.would_resolve) {
        st.textContent = '已保存 key · 重启 daemon 后生效';
        st.className = 'chst warn';
        clr.style.display = '';
      } else {
        st.textContent = '未配置';
        st.className = 'chst dim';
        clr.style.display = 'none';
      }
    }
    const SEM_MODES = [
      { v: 'off', t: '关闭', title: '彻底不提供语义搜索' },
      { v: 'explicit', t: '手动', title: '使用下方保存的 key 或环境变量里的 key' },
      { v: 'auto', t: '自动', title: 'daemon 每次启动读取本机已登录的 Devin/Windsurf 凭据' },
    ];
    let semMode = 'explicit';
    function renderSemMode(cur) {
      semMode = SEM_MODES.some((m) => m.v === cur) ? cur : 'explicit';
      const g = $('semMode');
      g.innerHTML = SEM_MODES.map((m) =>
        '<button class="agchip' + (m.v === semMode ? ' on' : '') + '" data-v="' + m.v + '" title="' + m.title + '"><span class="d"></span>' + m.t + '</button>'
      ).join('');
      for (const el of g.querySelectorAll('.agchip')) {
        el.addEventListener('click', () => { semanticDirty = true; semMode = el.getAttribute('data-v'); renderSemMode(semMode); });
      }
    }
    let channelMode = 'cloudflare';
    let cloudflaredInstalling = false;
    let openaiInstalling = false;
    function syncOpenaiInstallVisibility() {
      const hasPath = $('openaiTunnelClientPath').value.trim() !== '';
      $('oaInstall').style.display = hasPath ? 'none' : '';
      $('oaInstallMessage').style.display = hasPath && !$('oaInstallMessage').dataset.keep ? 'none' : '';
    }
    function onOpenaiInstallResult(m) {
      const hint = $('oaInstallMessage'), input = $('openaiTunnelClientPath');
      openaiInstalling = false;
      $('oaInstall').disabled = false;
      $('oaInstall').textContent = '一键安装';
      input.disabled = false;
      $('save').disabled = false;
      hint.dataset.keep = '1';
      if (m.error) { hint.className = 'hint bad'; hint.textContent = '安装失败：' + m.error; syncOpenaiInstallVisibility(); return; }
      if (input.value === m.previousPath) input.value = m.path;
      syncOpenaiInstallVisibility();
      hint.className = m.saved ? 'hint ok' : 'hint';
      hint.textContent = m.note || ((m.installed ? 'tunnel-client ' + m.version + ' 安装完成：' : '已检测到可用的 tunnel-client，未下载：') + m.path + '。路径已保存；尚未启动 OpenAI 渠道。');
      renderStatus(lastStatus || { overview: {} });
    }
    let openaiBusy = false;
    const oaLabels = { off: ['', '未启动'], starting: ['warn', '启动中…'], ready: ['ok', '就绪'], recovering: ['warn', '恢复中…'], stopping: ['warn', '停止中…'], error: ['bad', '已停止（出错）'], unavailable: ['bad', '不可用'] };
    function renderOpenaiRuntime(o) {
      const v = o.openai_tunnel || null;
      const live = !!v && (v.status === 'starting' || v.status === 'ready' || v.status === 'recovering');
      const ks = $('oaKeyState');
      if (!v) { ks.textContent = o.version ? '当前 daemon 不支持 OpenAI 渠道（请重启 daemon）' : 'daemon 未连接'; ks.className = 'chst dim'; }
      else if (v.credential_configured === null) { ks.textContent = '无法读取已保存的密钥'; ks.className = 'chst bad'; }
      else if (v.credential_configured) { ks.textContent = v.pending_restart ? '已保存 · 重新启动渠道后生效' : '已保存'; ks.className = 'chst ' + (v.pending_restart ? 'warn' : 'ok'); }
      else { ks.textContent = '未保存'; ks.className = 'chst dim'; }
      $('oaKeyClear').style.display = v && v.credential_configured ? '' : 'none';
      $('oaStart').style.display = live ? 'none' : '';
      $('oaStop').style.display = live || (v && v.status === 'stopping') ? '' : 'none';
      for (const id of ['oaKeySave', 'oaKeyClear', 'oaStart', 'oaStop', 'oaDiag']) $(id).disabled = openaiBusy || !v;
      return v;
    }
    function openaiAction(action, extra) {
      if (openaiBusy) return;
      openaiBusy = true;
      renderOpenaiRuntime((lastStatus && lastStatus.overview) || {});
      const r = $('oaResult'); r.className = 'hint'; r.textContent = '处理中…'; r.style.display = 'block';
      vs.postMessage(Object.assign({ type: 'openaiTunnel', action: action }, extra || {}));
    }
    function onOpenaiTunnelResult(m) {
      openaiBusy = false;
      if (m.action === 'saveKey' && m.ok) $('oaKey').value = '';
      const r = $('oaResult');
      if (m.message) { r.textContent = m.message; r.className = 'hint ' + (m.ok ? 'ok' : 'bad'); r.style.display = 'block'; } else r.style.display = 'none';
      renderStatus(lastStatus || { overview: {} });
    }
    let customProbe = { url: '', state: 'idle', detail: '' };
    function syncCloudflaredInstallVisibility() {
      const hasPath = $('cloudflaredPath').value.trim() !== '';
      $('cfInstall').style.display = hasPath ? 'none' : '';
      $('cfInstallMessage').style.display = hasPath ? 'none' : '';
    }
    function onCloudflaredInstallResult(m) {
      const hint = $('cfInstallMessage'), input = $('cloudflaredPath');
      if (m.phase) {
        hint.className = 'hint';
        hint.textContent = m.phase === 'confirming' ? 'cloudflared 验证通过，等待确认；尚未保存或启动渠道。' : '正在保存路径并重启 daemon；不会自动启动渠道。';
        $('cfInstall').textContent = m.phase === 'confirming' ? '等待确认…' : '正在应用…';
        return;
      }
      cloudflaredInstalling = false;
      $('cfInstall').disabled = false;
      $('cfInstall').textContent = '一键初始化安装';
      input.disabled = false;
      $('save').disabled = false;
      for (const button of document.querySelectorAll('[data-channel-mode]')) button.disabled = false;
      hint.className = m.error ? 'hint bad' : 'hint';
      if (m.error) {
        if (m.saved && channelMode === 'cloudflare' && input.value === m.previousPath) input.value = m.path;
        syncCloudflaredInstallVisibility();
        hint.textContent = (m.saved ? '路径已保存，但应用失败：' : '') + m.error;
        return;
      }
      if (m.saved) {
        if (channelMode === 'cloudflare' && input.value === m.previousPath) input.value = m.path;
        syncCloudflaredInstallVisibility();
        hint.className = m.restarted ? 'hint ok' : 'hint bad';
        hint.textContent = m.restarted ? '路径已保存，daemon 已重启；尚未启动渠道。' : '路径已保存，但 daemon 重启失败。';
        return;
      }
      if (channelMode !== 'cloudflare' || input.value !== m.previousPath) {
        hint.textContent = 'cloudflared 已就绪：' + m.path + '。当前模式或路径已变化，未自动回填；请自行确认。';
        return;
      }
      input.value = m.path;
      syncCloudflaredInstallVisibility();
      hint.className = 'hint ok';
      hint.textContent = m.note || (m.installed ? '安装完成。' : '已有可用的 cloudflared，未下载。') + '路径已回填，请按原流程保存设置；尚未启动渠道。';
    }
    function resetCustomProbe() { customProbe = { url: '', state: 'idle', detail: '' }; }
    function renderChannelMode(cur) {
      channelMode = cur === 'custom' || cur === 'openai' ? cur : 'cloudflare';
      $('channelCloudflare').style.display = channelMode === 'cloudflare' ? '' : 'none';
      $('channelOpenai').style.display = channelMode === 'openai' ? '' : 'none';
      $('channelCustom').style.display = channelMode === 'custom' ? '' : 'none';
      for (const el of document.querySelectorAll('[data-channel-mode]')) {
        const on = el.getAttribute('data-channel-mode') === channelMode;
        el.classList.toggle('on', on);
        el.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
      if (channelMode !== 'cloudflare') {
        $('cnQuick').style.display = 'none'; $('cnNamed').style.display = 'none'; $('cnStop').style.display = 'none'; $('cnCopy').style.display = 'none';
      }
      const custom = $('customPublicBaseUrl'), fixed = $('publicBaseUrl');
      if (custom && fixed) {
        const from = channelMode === 'custom' ? fixed : custom, to = channelMode === 'custom' ? custom : fixed;
        if (to.dataset.dirty !== 'true' && document.activeElement !== to) { to.value = from.value; to.dataset.dirty = from.dataset.dirty || 'false'; }
      }
    }
    for (const el of document.querySelectorAll('[data-channel-mode]')) el.addEventListener('click', () => {
      if (cloudflaredInstalling) return;
      const before = channelMode;
      resetCustomProbe(); renderChannelMode(el.getAttribute('data-channel-mode')); renderStatus(lastStatus || { overview: {} });
      // 标签只是默认显示偏好，不开关通道：选中即保存。
      if (channelMode !== before) { channelDraftPending = true; autosave({ channelMode }); }
    });
    $('customPublicBaseUrl').addEventListener('input', () => { resetCustomProbe(); renderStatus(lastStatus || { overview: {} }); });
    // Default-route changes share the canonical conditional-save path below.
    window.addEventListener('message', (e) => {
      const m = e.data;
      if (m.type === 'settingsNavigate') applySettingsPage(m.page);
      else if (m.type === 'settingsUiRestore') { settingsNavCollapsed=m.collapsed===true; applySettingsNav(); applySettingsPage(m.page); }
      else if (m.type === 'init') {
        for (const k of KEYS) { const el = $(k); if (el && el.dataset.dirty !== 'true' && document.activeElement !== el) el.value = m.values[k] ?? ''; }
        if ($('customPublicBaseUrl').dataset.dirty !== 'true' && document.activeElement !== $('customPublicBaseUrl')) $('customPublicBaseUrl').value = m.values.publicBaseUrl ?? '';
        // Canonical direct settings arrive with their daemon revision in directAccess.
        renderChannelMode(channelDraftPending ? channelMode : m.values.channelMode);
        syncCloudflaredInstallVisibility();
        syncOpenaiInstallVisibility();
        if ($('semKey').dataset.dirty !== 'true') $('semKey').value = '';
        if (m.skillsHint !== undefined && $('skillsHint')) { $('skillsHint').textContent = m.skillsHint; $('skillsHint').className = 'hint ' + (m.skillsCls || ''); }
        renderSemMode(semanticDirty ? semMode : m.semanticMode);
        renderWebAgents(m.agents ?? [], m.webAgents ?? []); renderCustom(m.custom ?? []); renderStatus(m);
        renderSettingsActions();
      }
      else if (m.type === 'custom') renderCustom(m.custom ?? []);
      else if (m.type === 'manualSaved') {
        acknowledgeForm(m.values);
        if (m.keySaved && $('semKey').value.trim() === pendingManualKey) { $('semKey').value = ''; $('semKey').dataset.dirty = 'false'; }
        pendingManualKey = '';
      }
      else if (m.type === 'autosaved') onAutosaved(m);
      else if (m.type === 'channelToggleResult') onChannelToggleResult(m);
      else if (m.type === 'status') renderStatus(m);
      else if (m.type === 'remote') renderRemote(m.view, m.paired);
      else if (m.type === 'remoteQr') {
        if (m.requestId === rmRequest && settingsPage === 'home' && new URL(m.url).origin === rmSelectedOrigin) { rmPairBusy = false; showRemoteQr(m); }
      }
      else if (m.type === 'remotePairDone') { if (m.requestId === rmRequest) { rmPairBusy = false; renderRemote(rmView); } }
      else if (m.type === 'remoteProbeDone') { rmProbing.delete(m.origin); renderRemote(rmView); }
      else if (m.type === 'cloudflaredInstallResult') onCloudflaredInstallResult(m);
      else if (m.type === 'openaiInstallResult') onOpenaiInstallResult(m);
      else if (m.type === 'openaiTunnelResult') onOpenaiTunnelResult(m);
      else if (m.type === 'customProbeResult') {
        $('customProbe').disabled = false;
        const entered = $('customPublicBaseUrl').value.trim();
        if ((entered.endsWith('/') ? entered.slice(0, -1) : entered) !== m.url) return;
        customProbe = { url: m.url, state: m.ok ? 'online' : 'error', detail: m.detail || '' };
        renderStatus(lastStatus || { overview: {} });
      }
      else if (m.type === 'semantic') renderSemantic(m.info ?? null);
      else if (m.type === 'grants') renderGrants(m.grants ?? { always: [], sessions: [] });
      else if (m.type === 'courierSites') renderCourierSites(Array.isArray(m.sites) ? m.sites : []);
      else if (m.type === 'directAccess') renderDirect(m);
      else if (m.type === 'directBusy') { directUiBusy = m.busy === true; directControls(); }
      else if (m.type === 'directSaveState') directSaveState(m);
      else if (m.type === 'directUnavailable') { directFrame = null; $('directState').textContent = '无法读取当前直连状态'; $('directState').className = 'chst warn'; directControls(); }
      else if (m.type === 'proxies') { renderProxies(m.info); if (pxModalFor && pxData[pxModalFor]) renderPxTools(pxData[pxModalFor]); }
      else if (m.type === 'proxiesReport') renderProxiesReport(m.report);
      else if (m.type === 'proxiesEditResult') renderProxiesEditResult(m);
      else if (m.type === 'proxiesAddResult') renderProxiesAddResult(m);
      else if (m.type === 'proxiesImportResult') renderProxiesImportResult(m);
      else if (m.type === 'proxiesToolsPending') { if (pxModalFor === m.server) renderPxToolsPending(m); }
      else if (m.type === 'proxiesToolsResult') onPxToolsResult(m);
      else if (m.type === 'proxiesToolsSettled') { pxLoading.delete(m.server); if (pxModalFor === m.server && pxNeedsRefresh.has(m.server)) requestPxTools(false); }
      else if (m.type === 'proxiesToolsRefresh') requestPxTools(false);
      else if (m.type === 'proxiesReset') { for (const name of Object.keys(pxData)) delete pxData[name]; pxLoading.clear(); pxPendingEdits.clear(); pxModalClose(); }
      else if (m.type === 'proxiesToggleForm') togglePxForm(m.form);
    });
    // 授权按实际生效 scope 展示：全局（持久）+ 会话（进程内）。
    // pattern/path 键保持可读化；单条删除后对应操作恢复询问。
    // One canonical direct switch. Drafts are never replaced by periodic status frames.
    let directOn = false, directFrame = null, directUiBusy = false, directRevision = -1;
    const directPending = new Set();
    const directSaved = {};
    function directOrigin(raw) {
      const v = String(raw || '').trim(); if (!v) return '';
      try { const u = new URL(v); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && u.pathname === '/' && !u.search && !u.hash ? u.origin : null; } catch { return null; }
    }
    function renderDirectPreview() {
      const origin = directOrigin($('directAccessUrl').value);
      $('directResolved').textContent = origin === null ? '地址格式无效，未用于生成连接。' : origin
        ? '地址预览：' + origin + '/bh.md · ' + origin + '/mcp/…' + (directOn ? '' : '（直连未开启）')
        : '留空使用自动发现的本机地址；多个地址在复制时选择。通用云沙箱需要它能访问的对外地址。';
    }
    function directControls() {
      $('directAccessToggle').disabled = !directFrame || directUiBusy || directPending.has('directAccessEnabled');
      for (const id of ['directPort','directAccessUrl','channelProxyUrl','aiDefaultRoute']) $(id).disabled = !directFrame || (directUiBusy && id !== 'channelProxyUrl') || directPending.has(id);
    }
    function renderDirect(m) {
      if (typeof m.revision === 'number' && m.revision < directRevision) return;
      if (typeof m.revision === 'number') directRevision = m.revision;
      directFrame = m; directOn = m.on === true;
      const v = m.listener;
      const ready = directOn && v?.listening && v.state === 'listening' && v.mode === 'direct' && v.port === m.port;
      const st = v?.state === 'applying' ? ['warn','正在应用…'] : !directOn ? ['dim', v?.mode === 'proxy' && v.listening ? '直连未开启；反向代理目标可用' : '未开启'] : v?.error ? ['bad',v.error] : ready ? ['ok','监听中 · 0.0.0.0:' + m.port] : ['warn','直连尚未就绪'];
      $('directState').className = 'chst ' + st[0]; $('directState').textContent = st[1];
      $('directAccessToggle').setAttribute('aria-checked', String(directOn));
      const incoming = { directPort: String(m.port || 7307), directAccessUrl: m.url || '', channelProxyUrl: m.proxyUrl || '', aiDefaultRoute: m.aiDefaultRoute || 'auto' };
      for (const id of Object.keys(incoming)) {
        directSaved[id] = incoming[id];
        const el = $(id);
        if (document.activeElement !== el && el.dataset.dirty !== 'true' && !directPending.has(id)) el.value = incoming[id];
      }
      $('customLocalTarget').textContent = v?.target || 'http://127.0.0.1:' + (m.port || 7307);
      directControls(); renderDirectPreview();
    }
    function directSaveState(m) {
      for (const key of m.keys || []) {
        if (m.state === 'saving') directPending.add(key); else directPending.delete(key);
        if (m.state === 'saved' && m.values && $(key)) {
          const el = $(key), saved = String(m.values[key]);
          directSaved[key] = saved;
          const entered = key === 'directAccessUrl' || key === 'channelProxyUrl' ? directOrigin(el.value) : el.value.trim();
          if (entered === saved) { el.dataset.dirty = 'false'; el.value = saved; el.setAttribute('aria-invalid','false'); }
        }
      }
      const note = $('directSaveNote'); note.textContent = m.state === 'saving' ? '正在保存…' : m.state === 'saved' ? '已保存' : m.message || '保存失败，请重试。'; note.className = 'hint ' + (m.state === 'error' ? 'bad' : '');
      if ((m.keys || []).includes('channelProxyUrl') || (m.keys || []).includes('aiDefaultRoute')) {
        $('autoNote').hidden = false; $('autoNote').textContent = note.textContent; $('autoNote').className = note.className;
      }
      directControls();
    }
    function saveDirectField(id) {
      if (directPending.has(id) || !directFrame) return;
      const el = $(id); let value = el.value.trim(); let message = '';
      if (id === 'directPort') {
        const n = Number(value); if (!value || !Number.isInteger(n) || n < 1024 || n > 65535) message = '端口必须是 1024–65535 之间的整数。'; else value = n;
      } else if (id !== 'aiDefaultRoute') {
        const origin = directOrigin(value);
        if (origin === null || (id === 'channelProxyUrl' && origin && !new URL(origin).port)) message = id === 'channelProxyUrl' ? '请填写带端口且不含凭据的 HTTP(S) 代理地址。' : '请填写不带路径、凭据或查询参数的 HTTP(S) 地址，或留空。';
        else value = origin;
      }
      el.setAttribute('aria-invalid', String(!!message));
      const hint = $(id === 'directPort' ? 'directPortHint' : id === 'directAccessUrl' ? 'directUrlHint' : id === 'channelProxyUrl' ? 'channelProxyHint' : 'aiRouteHint');
      if (message) { hint.textContent = message; hint.className = 'hint bad'; return; }
      if (String(value) === String(directSaved[id])) { el.dataset.dirty = 'false'; return; }
      hint.className = 'hint'; directPending.add(id); directControls();
      vs.postMessage(id === 'directPort' ? {type:id,port:value} : id === 'aiDefaultRoute' ? {type:id,route:value} : {type:id,url:value});
    }
    for (const id of ['directPort','directAccessUrl','channelProxyUrl','aiDefaultRoute']) {
      $(id).addEventListener('input', () => { $(id).dataset.dirty = 'true'; if (id === 'directAccessUrl') renderDirectPreview(); });
      $(id).addEventListener('change', () => saveDirectField(id));
      $(id).addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); $(id).blur(); }
        else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); $(id).value = directSaved[id] || ''; $(id).dataset.dirty = 'false'; $(id).setAttribute('aria-invalid','false'); renderDirectPreview(); }
      });
    }
    $('directAccessToggle').addEventListener('click', () => {
      if (!directFrame || directUiBusy) return;
      if (!directOn && directOrigin($('directAccessUrl').value) === null) { $('directUrlHint').textContent = '请修正地址或留空后再开启直连。'; $('directAccessUrl').focus(); return; }
      directUiBusy = true; directControls();
      vs.postMessage({type:'directAccessToggle',on:!directOn,url:$('directAccessUrl').value.trim()});
    });

    // Courier 网页站点：浏览器 Courier「检测此页面」接入的网站；删除后 Courier 解除绑定并收回权限。
    function renderCourierSites(sites) {
      const list = $('cslist');
      if (!list) return;
      if (!sites.length) {
        list.innerHTML = '<div class="hint" style="margin:0">还没有接入的网站。在浏览器里打开网页 AI 的聊天页，点工具栏 Courier 的「检测此页面」即可接入（最多 20 个）。</div>';
        return;
      }
      list.innerHTML = sites.map((x) => '<div class="ag-row"><span class="nm" style="flex:1">' + esc(String(x.name)) + ' <span class="wa-host">' + esc(String(x.origin).replace('https://', '')) + '</span>'
        + '</span><button class="del" data-id="' + esc(String(x.id)) + '" title="删除这个网站">删除</button></div>').join('');
      for (const el of list.querySelectorAll('.del')) el.addEventListener('click', () => vs.postMessage({ type: 'courierSiteRemove', id: el.dataset.id }));
    }
    function renderGrants(info) {
      const list = $('aglist');
      const always = Array.isArray(info && info.always) ? info.always : [];
      const sessions = Array.isArray(info && info.sessions) ? info.sessions : [];
      const sessionCount = sessions.reduce((n, s) => n + (Array.isArray(s.grants) ? s.grants.length : 0), 0);
      if (!always.length && sessionCount === 0) {
        list.innerHTML = '<div class="hint" style="margin:0">当前没有会跳过再次询问的授权。</div>';
        return;
      }
      const pretty = (k) => {
        if (k.startsWith('pattern:')) {
          const parts = k.slice(8).split('|');
          const lv = { critical: '不可逆', warn: '较高', info: '常规' }[parts[1]] || parts[1];
          return esc(parts[0]) + ' <span class="wa-tag">风险：' + lv + '</span>';
        }
        if (k.startsWith('path:')) return '<span class="wa-tag">目录前缀</span> ' + esc(k.slice(5));
        return esc(k);
      };
      const rows = [];
      if (always.length) {
        rows.push('<div class="hint" style="margin:2px 0 0"><b>全局授权</b> · 重启后仍保留</div>');
        for (const k of always) rows.push(
          '<div class="ag-row"><span class="nm" style="flex:1">' + pretty(k) + '</span>'
          + '<button class="del" data-scope="always" data-key="' + esc(k) + '" title="删除该全局授权">删除</button></div>'
        );
      }
      for (const s of sessions) {
        const grants = Array.isArray(s.grants) ? s.grants : [];
        if (!grants.length) continue;
        const label = s.session_name || s.workspace_path || s.session_id || '未知会话';
        rows.push('<div class="hint" style="margin:4px 0 0"><b>会话授权</b> · ' + esc(label) + ' · daemon 重启后失效</div>');
        for (const k of grants) rows.push(
          '<div class="ag-row"><span class="nm" style="flex:1">' + pretty(k) + '</span>'
          + '<button class="del" data-scope="session" data-session="' + esc(s.session_id || '') + '" data-key="' + esc(k) + '" title="删除该会话授权">删除</button></div>'
        );
      }
      list.innerHTML = rows.join('');
      for (const el of list.querySelectorAll('.del')) {
        el.addEventListener('click', () => vs.postMessage({
          type: 'grantRemove',
          scope: el.dataset.scope,
          sessionId: el.dataset.session || undefined,
          key: el.dataset.key,
        }));
      }
    }
    function renderWebAgents(agents, enabled) {
      const on = new Set(enabled);
      $('wagrid').innerHTML = agents.map((a) =>
        '<button class="agchip' + (on.has(a.name) ? ' on' : '') + '" data-name="' + esc(a.name) + '" title="' + esc(a.description) + '"><span class="d"></span>' + esc(a.name) + '</button>'
      ).join('');
      for (const el of $('wagrid').querySelectorAll('.agchip')) {
        el.addEventListener('click', () => { el.classList.toggle('on'); autosave({}, collectWebAgents()); });
      }
    }
    function renderCustom(custom) {
      const list = $('walist');
      if (!custom.length) { list.innerHTML = '<div class="hint" style="margin:0">还没有自定义站点。</div>'; return; }
      list.innerHTML = custom.map((a) =>
        '<div class="ag-row"><span class="mono-g">' + esc((a.name || '?').charAt(0).toUpperCase()) + '</span><span class="nm">' + esc(a.name) + '</span><span class="u">' + esc(a.url) + '</span>'
        + '<button class="del" data-name="' + esc(a.name) + '" title="删除该自定义站点">删除</button></div>'
      ).join('');
      for (const b of list.querySelectorAll('button[data-name]')) {
        b.addEventListener('click', () => vs.postMessage({ type: 'removeCustomAgent', name: b.getAttribute('data-name') }));
      }
    }
    function collectWebAgents() {
      return Array.prototype.map.call(document.querySelectorAll('#wagrid .agchip.on'), (el) => el.getAttribute('data-name'));
    }
    // MCP Proxies 区块：启用即由 daemon 启动并加载工具目录；停用不启动且不显示数量。
    // 数量气泡只在 MCP 在线后出现，点击后管理当前真实目录与工具暴露范围。
    function pxBadge(st) {
      const map = { online: ['ok', '在线'], starting: ['warn', '启动中…'], offline: ['warn', '等待启动'], degraded: ['warn', '工具异常'], crashed: ['bad', '启动失败'], config_error: ['bad', '配置错误'], disabled: ['dim', '已停用'] };
      const m = map[st] || ['dim', st || '未知'];
      return '<span class="pxb ' + m[0] + '"><span class="d"></span>' + esc(m[1]) + '</span>';
    }
    // 工具数量：优先用已取回的目录，其次用状态投影（都无需展开列表）
    function pxCount(name, fallback) {
      const d = pxData[name];
      if (d && d.ok !== false && d.result) return (d.result.tools || []).filter((t) => t.enabled !== false).length;
      return fallback;
    }
    // 数量承载在卡片的状态筹码上（按钮本身不显示数字）
    function pxCountParts(name, fallback) {
      const n = pxCount(name, fallback);
      if (n < 0) return { cls: 'cold', text: '未加载' };
      return { cls: 'filesonly', text: n + ' 个工具' };
    }
    function renderProxies(info) {
      const body = $('pxBody'), btn = $('pxReval');
      const addBtn = $('pxAdd'), importBtn = $('pxImport');
      btn.disabled = !info;
      addBtn.disabled = !info;
      importBtn.disabled = !info;
      if (!info) { pxServers = []; pxModalClose(); pxLoading.clear(); body.innerHTML = '<div class="hint" style="margin:0">本地服务未连接</div>'; return; }
      if (!info.configured) {
        pxServers = [];
        body.innerHTML = '<div class="hint" style="margin:0">暂无 MCP server</div>';
        return;
      }
      const generation = String(info.daemonId || '') + ':' + String(info.surfaceGen ?? '');
      if (pxGeneration && generation !== pxGeneration) {
        for (const name of Object.keys(pxData)) delete pxData[name];
        if (pxModalFor) pxNeedsRefresh.add(pxModalFor);
      }
      pxGeneration = generation;
      pxCfg = {};
      for (const c of info.config || []) pxCfg[c.name] = { ...c };
      const rows = info.status || [];
      const disabledNames = new Set(info.disabled || []);
      if (!rows.length) { pxServers = []; body.innerHTML = '<div class="hint" style="margin:0">暂无 MCP server</div>'; return; }
      const fmtTarget = (c) => c.transport === 'http' ? (c.url || '') : [c.command || '', ...(c.args || [])].filter((x) => x !== '').join(' ');
      const html = [];
      for (const s of rows) {
        const c = pxCfg[s.name] || {};
        const exposedN = s.catalogCount === null ? -1 : typeof s.catalogCount === 'number' ? s.catalogCount : ((s.tools || []).length || -1);
        const isOff = disabledNames.has(s.name) || s.status === 'disabled';
        const cp = pxCountParts(s.name, exposedN);
        const canManageTools = !isOff && (s.status === 'online' || s.status === 'degraded') && exposedN >= 0;
        const chip = canManageTools
          ? '<button class="pchip ' + cp.cls + '" data-count="' + esc(s.name) + '" data-tools="' + esc(s.name) + '" aria-label="管理 ' + esc(s.name) + ' 的工具">' + cp.text + '</button>'
          : '';
        const btns = '<span class="pxbtns">'
          + (s.status === 'config_error' ? ''
              : '<button class="pxsw' + (isOff ? '' : ' on') + '" data-toggle="' + esc(s.name) + '" data-on="' + (isOff ? '0' : '1') + '" role="switch" aria-label="启用 ' + esc(s.name) + '" title="' + (isOff ? '启用并启动 MCP' : '停用并断开 MCP') + '" aria-checked="' + (isOff ? 'false' : 'true') + '"></button>')
          + (s.status === 'config_error' ? '' : '<button class="pxe" data-edit="' + esc(s.name) + '">编辑</button>')
          + '<button class="pxe danger" data-del="' + esc(s.name) + '">删除</button>'
          + '</span>';
        html.push('<div class="pxs" data-server="' + esc(s.name) + '"><div class="hd"><span class="nm">' + esc(s.name) + '</span>' + pxBadge(s.status) + chip + btns + '</div>');
        if (s.status === 'config_error' && s.reason) html.push('<div class="pxkv bad">校验失败：' + esc(s.reason) + '</div>');
        if (s.status === 'crashed' && s.reason) html.push('<div class="pxkv bad">崩溃原因：' + esc(s.reason) + '</div>');
        if (s.status === 'degraded' && (s.missingTools || []).length) html.push('<div class="pxkv warn">缺失工具：' + esc(s.missingTools.join('、')) + '</div>');
        for (const w of c.warnings || []) html.push('<div class="pxkv warn">警告：' + esc(w) + '</div>');
        const tgt = fmtTarget(c);
        if (tgt) html.push('<div class="pxtarget">' + esc((c.transport || 'stdio') + ' · ' + tgt) + '</div>');
        // 工具列表走弹窗（不参与卡片流式布局）；编辑仍内联在卡片里
        html.push('<div class="pxedit" data-edit-panel="' + esc(s.name) + '" style="display:none"></div>');
        html.push('</div>');
      }
      body.innerHTML = html.join('');
      // Counts come from the metadata projection, never from background tools requests.
      pxServers = rows.filter(s => !disabledNames.has(s.name) && (s.status === 'online' || s.status === 'degraded')).map(s => s.name);
      for (const name of Object.keys(pxData)) if (!pxServers.includes(name)) delete pxData[name];
      if (pxModalFor && !pxServers.includes(pxModalFor)) pxModalClose();
      if (pxModalFor && pxNeedsRefresh.has(pxModalFor)) requestPxTools(false);
    }
    let pxServers = [];
    let pxCfg = {};
    const pxData = {};
    const pxPendingEdits = new Map();
    const pxLoading = new Set();
    const pxNeedsRefresh = new Set();
    let pxGeneration = '';
    let pxModalFor = null; // 工具列表弹窗当前展示的 server（null = 关闭）
    function pxEditPanel(name) {
      const all = $('pxBody').querySelectorAll('[data-edit-panel]');
      for (const el of all) if (el.getAttribute('data-edit-panel') === name) return el;
      return null;
    }
    function pxCountEl(name) {
      const all = $('pxBody').querySelectorAll('[data-count]');
      for (const el of all) if (el.getAttribute('data-count') === name) return el;
      return null;
    }
    function requestPxTools(live) {
      const name = pxModalFor;
      if (!name || !pxServers.includes(name) || pxLoading.has(name) || pxPendingEdits.has(name)) return;
      pxNeedsRefresh.delete(name);
      pxLoading.add(name);
      vs.postMessage({ type: 'proxiesTools', server: name, refresh: !!live });
    }
    // 重名工具索引：tool 名 → 拥有它的 server 列表（跨 MCP 同名 → 列表里标出来）
    function pxToolIndex() {
      const byName = {};
      for (const k in pxData) {
        const d = pxData[k];
        if (!d || d.ok === false || !d.result) continue;
        for (const t of d.result.tools || []) {
          if (!byName[t.name]) byName[t.name] = [];
          if (byName[t.name].indexOf(k) === -1) byName[t.name].push(k);
        }
      }
      return byName;
    }
    function pxModalOpen(name) {
      if (!pxServers.includes(name)) return;
      pxModalFor = name;
      const t = $('pxModalTitle');
      if (t) t.textContent = name;
      $('pxModal').style.display = '';
      const d = pxData[name];
      if (d && d.ok !== false) renderPxTools(d);
      else { renderPxToolsPending({ server: name, refresh: true }); requestPxTools(true); }
      $('pxModal').querySelector('[data-modal-close]')?.focus();
    }
    function pxModalClose() {
      pxModalFor = null;
      const m = $('pxModal');
      if (m) m.style.display = 'none';
    }
    function renderPxToolsPending(m) {
      if (!m.refresh && pxData[m.server]?.result) return;
      const box = $('pxModalBody');
      if (!box) return;
      box.innerHTML = '<div class="pxthr"><span class="pxth">' + (m.refresh ? '拉取中…' : '读取中…') + '</span></div>';
    }
    function renderPxTools(m) {
      const box = $('pxModalBody');
      if (!box) return;
      if (m.ok === false) { box.innerHTML = '<div class="pxkv bad">拉取失败：' + esc(m.detail || '') + '</div>'; return; }
      const r = m.result || {};
      const tools = r.tools || [];
      const index = pxToolIndex();
      // 本次渲染的目录也并入索引：它可能还没进 pxData（例如刚打开弹窗时的首帧）
      for (const t of tools) {
        if (!index[t.name]) index[t.name] = [];
        if (index[t.name].indexOf(m.server) === -1) index[t.name].push(m.server);
      }
      let dupN = 0;
      for (const t of tools) if ((t.conflictSources || []).length > 1) dupN += 1;
      const head = '<div class="pxthr"><span class="pxth">工具 ' + tools.length
        + (dupN > 0 ? ' · 重名 ' + dupN : '')
        + (r.cachedOnly ? ' · 缓存' : ' · 实时')
        + (r.ageMs != null ? ' · ' + Math.round(r.ageMs / 1000) + 's 前' : '') + '</span>'
        + '<span class="sp"></span>'
        + '<button data-refresh="' + esc(m.server) + '"' + (r.disabled ? ' disabled' : '') + '>刷新</button></div>';
      const parts = [head];
      if (r.disabled) parts.push('<div class="pxkv dim">已停用</div>');
      if (r.error) parts.push('<div class="pxkv bad">' + esc(r.error) + '</div>');
      if (!tools.length) {
        parts.push('<div class="pxkv dim">' + (r.disabled ? '无缓存' : '无工具') + '</div>');
      } else {
        parts.push('<div class="pxrows">' + tools.map((t) => {
          const canonical = t.upstreamTool || t.name;
          const expose = pxCfg[m.server]?.surface?.expose;
          const enabled = !Array.isArray(expose) || expose.indexOf(canonical) !== -1;
          const chips = [];
          const conflicts = t.conflictSources || [];
          if (conflicts.length > 1) chips.push('<span class="pchip dup">名称冲突 · ' + esc(conflicts.join(', ')) + '</span>');
          if (!enabled) chips.push('<span class="pchip">已屏蔽</span>');
          if (t.upstreamTool && t.upstreamTool !== t.name) chips.push('<span class="pchip">upstream: ' + esc(t.upstreamTool) + '</span>');
          return '<div class="pxrow' + (enabled ? '' : ' muted') + '"><div class="pxrn"><label class="pxtool-toggle"><input type="checkbox" data-tool-toggle="' + esc(m.server) + '" data-tool-name="' + esc(canonical) + '"' + (enabled ? ' checked' : '') + '><span>' + esc(t.name) + '</span></label>' + chips.join('') + '</div>'
            + (t.description ? '<div class="pxrd">' + esc(t.description) + '</div>' : '') + '</div>';
        }).join('') + '</div>');
      }
      box.innerHTML = parts.join('');
    }
    // 工具列表结果：更新卡片上的数量筹码；弹窗正开着这台 server 时才重绘列表
    function onPxToolsResult(m) {
      pxLoading.delete(m.server);
      if (!pxServers.includes(m.server) || m.result?.disabled) return;
      pxData[m.server] = m;
      const chip = pxCountEl(m.server);
      if (chip) { const cp = pxCountParts(m.server, 0); chip.className = 'pchip ' + cp.cls; chip.textContent = cp.text; }
      if (pxModalFor === m.server) renderPxTools(m);
    }
    // 编辑 MCP：连接配置是主内容；历史代理策略保留在低权重「高级代理设置」中。
    const ADVANCED_EDIT_KEYS = ['surface', 'risk', 'approvalUnits', 'redactPaths', 'sensitiveKeys', 'limits', 'browser'];
    function advancedEditableOf(c) {
      const o = {};
      for (const k of ADVANCED_EDIT_KEYS) {
        const v = c[k];
        if (v === undefined || v === null) continue;
        if (Array.isArray(v) && v.length === 0) continue;
        if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) continue;
        o[k] = v;
      }
      return o;
    }
    function togglePxEdit(name) {
      const box = pxEditPanel(name);
      if (!box) return;
      if (box.style.display !== 'none') { box.style.display = 'none'; return; }
      const c = pxCfg[name] || {};
      const transport = c.transport === 'http' ? 'http' : 'stdio';
      /* newline separator is materialized at webview runtime; avoids outer-template escape cooking */
      /*
      const argsText = (c.args || []).join('\n');
      */
      const argsText = (c.args || []).join(String.fromCharCode(10));
      const advanced = JSON.stringify(advancedEditableOf(c), null, 2);
      box.innerHTML = '<div class="fgrid pxeditgrid">'
        + '<div class="f"><label>Transport</label><select data-edit-field="transport"><option value="stdio"' + (transport === 'stdio' ? ' selected' : '') + '>stdio</option><option value="http"' + (transport === 'http' ? ' selected' : '') + '>http</option></select></div>'
        + '<div class="f" data-edit-when="stdio"><label>Command</label><input data-edit-field="command" spellcheck="false" value="' + esc(c.command || '') + '"></div>'
        + '<div class="f fwide" data-edit-when="stdio"><label>Arguments <span class="hint">每行一个参数</span></label><textarea data-edit-field="args" spellcheck="false" rows="4">' + esc(argsText) + '</textarea></div>'
        + '<div class="f fwide" data-edit-when="http"><label>URL</label><input data-edit-field="url" spellcheck="false" value="' + esc(c.url || '') + '"></div>'
        + '</div>'
        + '<details class="pxadv"><summary>高级代理设置</summary><textarea class="pxjson" spellcheck="false" rows="7">' + esc(advanced) + '</textarea></details>'
        + '<div class="btnrow"><button class="pxe" data-edit-save="' + esc(name) + '">保存</button><button class="pxe secondary" data-edit-cancel="' + esc(name) + '">取消</button><span class="form-msg"></span></div>';
      const sel = box.querySelector('[data-edit-field="transport"]');
      const sync = () => { for (const row of box.querySelectorAll('[data-edit-when]')) row.hidden = row.getAttribute('data-edit-when') !== sel.value; };
      sel.addEventListener('change', sync); sync();
      box.style.display = '';
    }
    function savePxEdit(name) {
      const box = pxEditPanel(name);
      if (!box) return;
      const msg = box.querySelector('.form-msg');
      const fail = (t) => { if (msg) { msg.className = 'form-msg err'; msg.textContent = t; } };
      const transport = box.querySelector('[data-edit-field="transport"]').value;
      const fields = { transport: transport };
      if (transport === 'stdio') {
        const command = box.querySelector('[data-edit-field="command"]').value.trim();
        if (!command) { fail('stdio 需要 Command'); return; }
        fields.command = command;
        fields.args = box.querySelector('[data-edit-field="args"]').value.split(String.fromCharCode(10)).map((x) => x.replace(String.fromCharCode(13), '').trim()).filter(Boolean);
        fields.url = null;
      } else {
        const url = box.querySelector('[data-edit-field="url"]').value.trim();
        if (!url) { fail('http 需要 URL'); return; }
        fields.url = url;
        fields.command = null;
        fields.args = [];
      }
      const ta = box.querySelector('.pxjson');
      let advanced;
      try { advanced = JSON.parse((ta && ta.value) || '{}'); } catch (e) { fail('高级设置 JSON 解析失败'); return; }
      if (advanced === null || typeof advanced !== 'object' || Array.isArray(advanced)) { fail('高级设置必须是 JSON 对象'); return; }
      const bad = Object.keys(advanced).filter((k) => ADVANCED_EDIT_KEYS.indexOf(k) === -1);
      if (bad.length) { fail('不可编辑：' + bad.join(', ')); return; }
      Object.assign(fields, advanced);
      if (msg) { msg.className = 'form-msg busy'; msg.textContent = '保存中…'; }
      vs.postMessage({ type: 'proxiesEdit', server: name, fields: fields });
    }
    function renderProxiesEditResult(r) {
      if (r.server) {
        pxPendingEdits.delete(r.server);
        pxLoading.delete(r.server);
        if (r.ok && r.fields && pxCfg[r.server]) Object.assign(pxCfg[r.server], r.fields);
        for (const b of $('pxBody').querySelectorAll('[data-toggle]')) if (b.getAttribute('data-toggle') === r.server) { b.disabled = false; b.removeAttribute('aria-busy'); }
        if (pxModalFor === r.server && pxData[r.server]) renderPxTools(pxData[r.server]);
      }
      const msg = $('pxMsg');
      if (msg) { msg.className = r.ok ? 'ok' : 'err'; msg.textContent = r.ok ? '已保存' : '保存失败：' + r.detail; }
      const note = $('pxModalStatus');
      if (note && pxModalFor === r.server) { note.className = r.ok ? 'pxkv' : 'pxkv bad'; note.textContent = r.ok ? '已保存' : '保存失败：' + r.detail; }
    }
    function savePxFields(name, fields, target) {
      if (pxPendingEdits.has(name)) return;
      pxPendingEdits.set(name, fields);
      if (target) { target.disabled = true; target.setAttribute?.('aria-busy', 'true'); }
      for (const input of $('pxModal').querySelectorAll('[data-tool-toggle]')) input.disabled = true;
      if (pxModalFor === name) { $('pxModalStatus').className = 'pxkv'; $('pxModalStatus').textContent = '保存中…'; }
      vs.postMessage({ type: 'proxiesEdit', server: name, fields });
    }
    // ── M4.6「添加 MCP」表单（transport 切换 stdio/http；file-only 字段在此一次性录入）──
    function togglePxForm(form) {
      const add = $('pxForm'), imp = $('pxImportBox');
      if (form === 'add') {
        imp.innerHTML = ''; imp.dataset.open = '0';
        if (add.dataset.open === '1') { add.innerHTML = ''; add.dataset.open = '0'; return; }
        add.dataset.open = '1';
        add.innerHTML =
          '<div class="fgrid" style="margin-top:10px">'
          + '<div class="f"><label>名称</label><input data-f="name" spellcheck="false" placeholder="如 chrome"></div>'
          + '<div class="f"><label>transport</label><select data-f="transport"><option value="stdio">stdio</option><option value="http">http</option></select></div>'
          + '<div class="f" data-when="stdio"><label>command</label><input data-f="command" spellcheck="false" placeholder="如 node / npx"></div>'
          + '<div class="f" data-when="http"><label>url</label><input data-f="url" spellcheck="false" placeholder="http://127.0.0.1:9000/mcp"></div>'
          + '<div class="f fwide" data-when="stdio"><label>Arguments <span class="hint">每行一个参数</span></label><textarea data-f="args" spellcheck="false" rows="3" placeholder="-y&#10;some-mcp@1.9.0"></textarea></div>'
          + '</div>'
          + '<div class="btnrow" style="margin-top:10px"><button class="pxs-go">添加</button><span class="form-msg"></span></div>';
        const sel = add.querySelector('[data-f="transport"]');
        const sync = () => { for (const row of add.querySelectorAll('[data-when]')) row.hidden = row.getAttribute('data-when') !== sel.value; };
        sel.addEventListener('change', sync); sync();
        add.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') add.querySelector('.pxs-go').click(); });
        add.querySelector('.pxs-go').addEventListener('click', () => {
          const get = (f) => { const el = add.querySelector('[data-f="' + f + '"]'); return el ? el.value : ''; };
          const msg = add.querySelector('.form-msg');
          const fail = (t) => { msg.className = 'form-msg err'; msg.textContent = t; };
          const name = get('name').trim();
          if (!name) { fail('名称必填'); return; }
          const server = { name: name, enabled: true, transport: sel.value };
          if (sel.value === 'stdio') {
            const command = get('command').trim();
            if (!command) { fail('stdio 需要 command'); return; }
            server.command = command;
            const args = get('args');
            if (args.trim()) server.args = args.split(String.fromCharCode(10)).map((x) => x.replace(String.fromCharCode(13), '').trim()).filter(Boolean);
          } else {
            const url = get('url').trim();
            if (!url) { fail('http 需要 url'); return; }
            server.url = url;
          }
          const go = add.querySelector('.pxs-go');
          go.disabled = true; go.textContent = '添加中…';
          msg.className = 'form-msg busy'; msg.textContent = '';
          vs.postMessage({ type: 'proxiesAdd', server: server });
        });
        return;
      }
      // 导入 JSON（Claude Desktop / Cursor 通用 mcpServers 格式）
      if (add.dataset.open === '1') { add.innerHTML = ''; add.dataset.open = '0'; }
      if (imp.dataset.open === '1') { imp.innerHTML = ''; imp.dataset.open = '0'; return; }
      imp.dataset.open = '1';
      imp.innerHTML =
        '<div class="f" style="margin-top:10px"><label>粘贴 mcpServers JSON</label><textarea data-f="json" rows="6" spellcheck="false"></textarea></div>'
        + '<div class="btnrow" style="margin-top:10px"><button class="pxs-go">导入</button><span class="form-msg"></span></div>';
      const impGo = imp.querySelector('.pxs-go');
      imp.querySelector('[data-f="json"]').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) impGo.click(); });
      impGo.addEventListener('click', () => {
        const json = imp.querySelector('[data-f="json"]').value;
        const msg = imp.querySelector('.form-msg');
        if (!json.trim()) { if (msg) { msg.className = 'form-msg err'; msg.textContent = '粘贴 JSON 后再导入'; } return; }
        impGo.disabled = true; impGo.textContent = '导入中…';
        if (msg) { msg.className = 'form-msg busy'; msg.textContent = ''; }
        vs.postMessage({ type: 'proxiesImport', json: json });
      });
    }
    function renderProxiesAddResult(m) {
      const box = $('pxForm');
      const go = box.querySelector('.pxs-go');
      if (!m.ok) {
        if (go) { go.disabled = false; go.textContent = '添加'; }
        const msg = box.querySelector('.form-msg');
        if (msg) { msg.className = 'form-msg err'; msg.textContent = '添加失败：' + m.detail; }
        return;
      }
      box.innerHTML = ''; box.dataset.open = '0';
      const warn = typeof m.warning === 'string' && m.warning !== '' ? m.warning : null;
      const bar = $('pxMsg');
      if (bar) {
        if (warn !== null) { bar.className = 'warn'; bar.textContent = '已添加（' + warn + '）'; }
        else { bar.className = 'ok'; bar.textContent = '✓ 已添加'; }
      }
    }
    function renderProxiesImportResult(m) {
      const box = $('pxImportBox');
      const go = box.querySelector('.pxs-go');
      if (!m.ok) {
        if (go) { go.disabled = false; go.textContent = '导入'; }
        const msg = box.querySelector('.form-msg');
        if (msg) { msg.className = 'form-msg err'; msg.textContent = '导入失败：' + m.detail; }
        return;
      }
      box.innerHTML = ''; box.dataset.open = '0';
      const warn = typeof m.warning === 'string' && m.warning !== '' ? m.warning : null;
      const bar = $('pxMsg');
      if (bar) { bar.className = 'ok'; bar.textContent = '✓ 导入完成：' + esc(m.detail); }
    }
    function renderProxiesReport(r) {
      const el = $('pxReport');
      const servers = r.servers || [];
      const ok = servers.filter((s) => s.ok).length;
      const parts = ['<div class="pxkv">重新校验 · <b>' + ok + '/' + servers.length + '</b> 个 server 配置有效</div>'];
      for (const q of r.quarantined || []) parts.push('<div class="pxkv bad">已隔离：' + esc(q.name) + ' — ' + esc(q.reason) + '</div>');
      for (const w of r.warnings || []) parts.push('<div class="pxkv warn">警告：' + esc(w.name) + ' — ' + esc(w.reason) + '</div>');
      // r.note 是给 agent/CLI 的机制说明，UI 不展示
      el.innerHTML = parts.join('');
    }
    $('waAdd').addEventListener('click', () => {
      const name = $('waName').value.trim(), url = $('waUrl').value.trim();
      if (!name || !url) return;
      // cleared up front: the init refresh re-renders the list on success
      $('waName').value = ''; $('waUrl').value = '';
      vs.postMessage({ type: 'addCustomAgent', name, url });
    });
    $('cloudflaredPath').addEventListener('input', syncCloudflaredInstallVisibility);
    $('cfInstall').addEventListener('click', () => {
      if (channelMode !== 'cloudflare' || cloudflaredInstalling || $('cfInstall').disabled) return;
      cloudflaredInstalling = true;
      $('cfInstall').disabled = true;
      $('cloudflaredPath').disabled = true;
      $('save').disabled = true;
      for (const button of document.querySelectorAll('[data-channel-mode]')) button.disabled = true;
      $('cfInstall').textContent = '初始化中…';
      $('cfInstallMessage').className = 'hint';
      $('cfInstallMessage').textContent = '正在准备 cloudflared；验证后可选择保存并重启，不会自动启动渠道。';
      vs.postMessage({ type: 'installCloudflared', path: $('cloudflaredPath').value, channelMode });
    });
    const requireCloudflaredPath=()=>{if($('cloudflaredPath').value.trim())return true;alert('使用公网渠道前，请先填写 cloudflared 可执行文件的完整路径并保存。');$('cloudflaredPath').focus();return false;};
    $('openaiTunnelClientPath').addEventListener('input', () => { delete $('oaInstallMessage').dataset.keep; syncOpenaiInstallVisibility(); renderStatus(lastStatus || { overview: {} }); });
    $('oaInstall').addEventListener('click', () => {
      if (openaiInstalling || $('oaInstall').disabled) return;
      openaiInstalling = true;
      $('oaInstall').disabled = true;
      $('openaiTunnelClientPath').disabled = true;
      $('save').disabled = true;
      $('oaInstall').textContent = '安装中…';
      $('oaInstallMessage').className = 'hint';
      $('oaInstallMessage').textContent = '正在下载并校验 tunnel-client（约 7.5 MB）；不会启动渠道。';
      vs.postMessage({ type: 'installOpenaiTunnel', path: $('openaiTunnelClientPath').value });
    });
    $('oaKeySave').addEventListener('click', () => { const key = $('oaKey').value.trim(); if (!key) { $('oaKey').focus(); return; } openaiAction('saveKey', { key: key }); });
    $('oaKey').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('oaKeySave').click(); } });
    $('oaKeyClear').addEventListener('click', () => openaiAction('clearKey'));
    $('oaStart').addEventListener('click', () => openaiAction('start', { tunnelId: $('openaiTunnelId').value.trim(), clientPath: $('openaiTunnelClientPath').value.trim() }));
    $('oaStop').addEventListener('click', () => openaiAction('stop'));
    $('oaDiag').addEventListener('click', () => openaiAction('diagnostics'));
    $('cnQuick').addEventListener('click', () => { if(requireCloudflaredPath()) vs.postMessage({ type: 'tunnel', action: 'quick' }); });
    $('cnNamed').addEventListener('click', () => { if(requireCloudflaredPath()) vs.postMessage({ type: 'tunnel', action: 'named' }); });
    $('cnStop').addEventListener('click', () => vs.postMessage({ type: 'tunnel', action: 'stop' }));
    $('cnCopy').addEventListener('click', () => vs.postMessage({ type: 'tunnel', action: 'copy' }));
    $('customProbe').addEventListener('click', () => {
      const entered = $('customPublicBaseUrl').value.trim();
      const url = entered.endsWith('/') ? entered.slice(0, -1) : entered;
      if (!url) { alert('请先填写当前公网地址。'); $('customPublicBaseUrl').focus(); return; }
      customProbe = { url, state: 'probing', detail: '' };
      $('customProbe').disabled = true;
      renderStatus(lastStatus || { overview: {} });
      vs.postMessage({ type: 'customProbe', url });
    });
    $('mcpCopy').addEventListener('click', () => {
      if ($('mcpCopy').disabled) return;
      if ($('mcpCopy').dataset.kind === 'openai') { vs.postMessage({ type: 'copyTunnelId' }); return; }
      vs.postMessage({ type: 'copyConnection' });
    });
    $('mcpDesc').addEventListener('click', () => vs.postMessage({ type: 'copyConnectorDesc' }));
    for (const id of ['oaLinkPlatform', 'oaLinkChatgpt']) $(id).addEventListener('click', (e) => { e.preventDefault(); vs.postMessage({ type: 'openLink', target: $(id).dataset.link }); });
    // Destructive confirmation lives in the extension host (rotateToken), not window.confirm:
    // host dialogs are reliable in VS Code webviews and keep one confirmation source of truth.
    $('mcpRotate').addEventListener('click', () => vs.postMessage({ type: 'rotateToken' }));
    $('agClear').addEventListener('click', () => vs.postMessage({ type: 'grantsClear' }));
    const rmProbing = new Set();
    const rmReason = { off: '手机访问暂不可用。', channel_offline: '先开启直连或启动可用的公网渠道。', not_https: '渠道没有可用的手机入口。', direct_applying: '正在应用直连设置。', direct_unavailable: '直连未就绪，请检查端口和本地服务。', direct_no_address: '未发现可访问地址，可在“直连”中填写对外地址。', custom_unavailable: '自定义公网入口未就绪，请检查地址和反向代理目标。' };
    function fmtTime(s) { const d = new Date(s); return isNaN(d.getTime()) ? '—' : d.toLocaleString(); }
    function renderRemote(v, paired) {
      const hint = $('rmHint'), list = $('rmDevices');
      const empty = () => { const li = document.createElement('li'); li.className = 'hint'; li.style.margin = '0'; li.textContent = '还没有配对的手机。'; return li; };
      rmView = v;
      if (!v) { closeRemoteQr(); $('rmPair').disabled = true; $('rmAgain').disabled = true; $('rmProbe').disabled = true; $('rmEndpoint').style.display = 'none'; hint.textContent = '无法读取当前手机访问状态，请检查本地服务。'; hint.style.display = ''; const unknown = empty(); unknown.textContent = '设备状态待确认'; list.replaceChildren(unknown); return; }
      const endpoints = v.endpoints || (v.origin ? [{ origin: v.origin, kind: v.kind || 'fixed' }] : []);
      const select = $('rmEndpoint');
      if (!rmSelectedOrigin) rmSelectedOrigin = endpoints[0]?.origin || '';
      const selected = endpoints.find((x) => x.origin === rmSelectedOrigin);
      const options = endpoints.map((x) => {
        const option = document.createElement('option');
        option.value = x.origin;
        option.textContent = (x.kind === 'quick' ? '临时渠道' : '固定入口') + ' · ' + x.origin;
        return option;
      });
      if (!selected) { const missing = document.createElement('option'); missing.value = rmSelectedOrigin; missing.textContent = '所选入口不可用，请重新选择'; missing.disabled = true; options.unshift(missing); }
      select.replaceChildren(...options); select.value = rmSelectedOrigin;
      select.style.display = endpoints.length > 1 || !selected ? '' : 'none';
      $('rmPair').disabled = !v.available || !selected || rmPairBusy;
      $('rmAgain').disabled = $('rmPair').disabled;
      $('rmPair').textContent = rmPairBusy ? '生成中…' : '生成配对码';
      select.disabled = rmPairBusy;
      const verification = selected?.verification || { state: 'unverified', checked_at: null, reason: null };
      const checking = rmProbing.has(rmSelectedOrigin) || verification.state === 'checking';
      $('rmProbe').disabled = !selected || checking;
      $('rmProbe').textContent = checking ? '检测中…' : '检测所选入口';
      const label = verification.state === 'passed' ? '本机检测通过；手机仍需能访问此网络' : verification.state === 'failed' ? '本机检测失败，不代表所有设备不可达' : checking ? '本机检测中…' : '已配置 · 未验证';
      const note = selected ? selected.origin + ' · ' + label + (selected.kind === 'quick' ? ' · 临时渠道停止或换址后需要重新扫码' : ' · 固定入口') + (verification.checked_at === null ? '' : ' · ' + fmtTime(verification.checked_at))
        : '所选手机入口不可用；不会自动切到其他渠道。' + (rmReason[v.reason] || '');
      hint.textContent = note; hint.className = selected && verification.state === 'passed' ? 'hint' : 'hint warn'; hint.style.display = '';
      rmDevices = v.devices || [];
      if (!rmDevices.length) list.replaceChildren(empty());
      else list.replaceChildren(...rmDevices.map(d => {
        const li = document.createElement('li');
        li.style.cssText = 'display:flex;gap:8px;align-items:center;padding:6px 0;border-top:1px solid var(--vscode-panel-border)';
        const t = document.createElement('div'); t.style.flex = '1';
        const n = document.createElement('div'); n.textContent = d.name;
        const s = document.createElement('div'); s.className = 'hint'; s.textContent = '配对于 ' + fmtTime(d.created_at) + ' · 最近使用 ' + fmtTime(d.last_seen_at);
        t.append(n, s);
        const b = document.createElement('button'); b.className = 'secondary'; b.textContent = '撤销';
        b.addEventListener('click', () => vs.postMessage({ type: 'remote', action: 'revoke', id: d.id, name: d.name }));
        li.append(t, b); return li;
      }));
      // scanned (the 允许 / 拒绝 notification takes over) or paired: the QR code is used up
      if ((!selected || paired || (v.requests && v.requests.length)) && ($('rmModal').open || rmPairBusy)) closeRemoteQr();
    }
    function closeRemoteQr() {
      rmRequest++; rmPairBusy = false;
      if ($('rmModal').open) $('rmModal').close();
      if (rmTimer) clearInterval(rmTimer); rmTimer = null;
      if (rmView) { $('rmPair').disabled = !rmView.available || !(rmView.endpoints || []).some(x => x.origin === rmSelectedOrigin); $('rmAgain').disabled = $('rmPair').disabled; }
      if (rmPreviousFocus?.isConnected) rmPreviousFocus.focus(); rmPreviousFocus = null;
    }
    function showRemoteQr(m) {
      const NS = 'http://www.w3.org/2000/svg', q = 4;
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('viewBox', (-q) + ' ' + (-q) + ' ' + (m.n + 2 * q) + ' ' + (m.n + 2 * q));
      svg.setAttribute('width', '232'); svg.setAttribute('height', '232'); svg.setAttribute('shape-rendering', 'crispEdges');
      svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', '配对二维码');
      const p = document.createElementNS(NS, 'path'); p.setAttribute('d', m.path); p.setAttribute('fill', '#000');
      svg.append(p); $('rmQr').replaceChildren(svg);
      $('rmNote').textContent = new URL(m.url).origin + ' · 配对码不是连通性证明。扫码后在电脑上点「允许」。' + (m.kind === 'quick' ? '临时渠道停止或换址后需重新扫码。' : '固定入口。');
      if (!$('rmModal').open) { if (!rmPreviousFocus?.isConnected) rmPreviousFocus = $('rmPair'); $('rmModal').showModal(); }
      $('rmClose').focus();
      const end = new Date(m.expiresAt).getTime();
      const tick = () => {
        const left = Math.max(0, Math.round((end - Date.now()) / 1000));
        $('rmLeft').textContent = left > 0 ? '有效期 ' + Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0') : '二维码已过期，请重新生成。';
        $('rmQr').style.opacity = left > 0 ? '1' : '.25';
        if (left <= 0 && rmTimer) { clearInterval(rmTimer); rmTimer = null; }
      };
      if (rmTimer) clearInterval(rmTimer);
      tick(); rmTimer = setInterval(tick, 1000);
    }
    $('rmEndpoint').addEventListener('change', () => { rmSelectedOrigin = $('rmEndpoint').value; closeRemoteQr(); renderRemote(rmView); });
    $('rmProbe').addEventListener('click', () => {
      if ($('rmProbe').disabled || !rmSelectedOrigin) return;
      rmProbing.add(rmSelectedOrigin); renderRemote(rmView);
      vs.postMessage({ type: 'remote', action: 'probe', origin: rmSelectedOrigin });
    });
    const requestRemotePair = () => {
      if ($('rmPair').disabled || !rmSelectedOrigin || rmPairBusy) return;
      if (!$('rmModal').open) rmPreviousFocus = $('rmPair');
      rmPairBusy = true; const requestId = ++rmRequest; renderRemote(rmView);
      vs.postMessage({ type: 'remote', action: 'pair', origin: rmSelectedOrigin, requestId });
    };
    $('rmPair').addEventListener('click', requestRemotePair);
    $('rmAgain').addEventListener('click', requestRemotePair);
    $('rmClose').addEventListener('click', closeRemoteQr);
    $('rmModal').addEventListener('click', e => { if (e.target === $('rmModal')) closeRemoteQr(); });
    $('rmModal').addEventListener('cancel', e => { e.preventDefault(); closeRemoteQr(); });
    $('pxReval').addEventListener('click', () => vs.postMessage({ type: 'proxiesRevalidate' }));
    $('pxAdd').addEventListener('click', () => vs.postMessage({ type: 'proxiesToggleForm', form: 'add' }));
    $('pxImport').addEventListener('click', () => vs.postMessage({ type: 'proxiesToggleForm', form: 'import' }));
    // 卡片按钮用事件委托（卡片会随每次刷新整块重绘）：
    // 工具=打开弹窗 / 开关（启用·停用）/ 编辑（白名单字段，保存·取消）/ 删除（YAML 摘除）
    $('pxBody').addEventListener('click', (e) => {
      const t = e.target;
      if (!t || !t.getAttribute) return;
      const tools = t.getAttribute('data-tools');
      if (tools) { pxModalOpen(tools); return; }
      const toggle = t.getAttribute('data-toggle');
      if (toggle) { savePxFields(toggle, { enabled: t.getAttribute('data-on') !== '1' }, t); return; }
      const edit = t.getAttribute('data-edit');
      if (edit) { togglePxEdit(edit); return; }
      const save = t.getAttribute('data-edit-save');
      if (save) { savePxEdit(save); return; }
      const cancel = t.getAttribute('data-edit-cancel');
      if (cancel) { const b = pxEditPanel(cancel); if (b) b.style.display = 'none'; return; }
      const del = t.getAttribute('data-del');
      if (del) vs.postMessage({ type: 'proxiesRemove', server: del });
    });
    // 工具列表弹窗：关闭按钮 / 刷新 / 点背景关闭（弹窗不参与卡片布局，开关不会重排卡片）
    $('pxModal').addEventListener('click', (e) => {
      const t = e.target;
      if (!t || !t.getAttribute) return;
      const toolToggle = t.getAttribute('data-tool-toggle');
      if (toolToggle) {
        const tool = t.getAttribute('data-tool-name');
        const d = pxData[toolToggle], catalog = d && d.result ? (d.result.tools || []) : [];
        const current = pxCfg[toolToggle]?.surface?.expose;
        const selected = new Set(Array.isArray(current) ? current : catalog.map((x) => x.upstreamTool || x.name));
        if (t.checked) selected.add(tool); else selected.delete(tool);
        savePxFields(toolToggle, { surface: { ...(pxCfg[toolToggle]?.surface || {}), expose: Array.from(selected) } }, t);
        return;
      }
      if (t.getAttribute('data-modal-close')) { pxModalClose(); return; }
      const refresh = t.getAttribute('data-refresh');
      if (refresh) { requestPxTools(true); return; }
      if (t === $('pxModal')) pxModalClose();
    });
    $('semClear').addEventListener('click', () => vs.postMessage({ type: 'semanticClear' }));
    $('save').addEventListener('click', () => {
      if (cloudflaredInstalling || openaiInstalling || !MANUAL_FORM_PAGES.includes(settingsPage)) return;
      const values = {};
      for (const k of KEYS) {
        const el = $(k);
        if (el && !AUTO_KEYS.includes(k) && el.closest('[data-page]')?.dataset.page === settingsPage) values[k] = el.value.trim();
      }
      if (settingsPage === 'connections') {
        values.publicBaseUrl = (channelMode === 'custom' ? $('customPublicBaseUrl') : $('publicBaseUrl')).value.trim();
        if (values.publicBaseUrl && directOrigin(values.publicBaseUrl) === null) { $('autoNote').textContent = '请修正公网地址：只接受 HTTP(S) 地址，不带路径或凭据。'; $('autoNote').className = 'hint bad'; return; }
      }
      if (settingsPage === 'agents') { values.semanticMode = semMode; values.semKey = $('semKey').value.trim(); pendingManualKey = values.semKey; }
      vs.postMessage({ type: 'save', values });
    });
    $('restart').addEventListener('click', () => vs.postMessage({ type: 'restart' }));
    // Host waits for this handshake before publishing the first init/proxy frames.
    // It guarantees the browser-side message listener is already installed.
    vs.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}
