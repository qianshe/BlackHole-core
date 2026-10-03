import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { commands, env, Position, Range, Selection, TextEditorRevealType, Uri, window, workspace, WebviewView, type Disposable, type WebviewViewProvider } from 'vscode';
import type { AuthView } from './cloudAuthClient';
import { argumentDetails, commandSummary, pendingConfirmationFor, resultBody, resultDiff } from './callFormat';
import { editorNavigationPreview, resolveEditorNavigation } from './editorNavigation';
import { isWorkspaceFileTool, displayToolName } from './toolNames';
import { sidebarIcons } from './icons';
import { getConfig } from './config';
import { prepareHandoffPrompt } from './handoffCopy';
import { mermaidConfig, renderMarkdown } from './markdown';
import { abortableSleep, SessionFeed, type FeedEnv, type FeedSnapshot } from './sessionFeed';
import { handoffMarkup, handoffScript, handoffStyles } from './handoffView';

/** The Web build's single-file mermaid (name carries a content hash); '' when absent (diagrams stay code). */
let mermaidAssetPath: string | undefined;
function mermaidAsset(): string {
  if (mermaidAssetPath !== undefined) return mermaidAssetPath;
  const dir = path.join(__dirname, 'daemon', 'web', 'assets');
  let name: string | undefined;
  try { name = readdirSync(dir).find((f) => /^mermaid-[0-9a-f]+\.min\.js$/.test(f)); } catch { /* no Web build */ }
  mermaidAssetPath = name ? path.join(dir, name) : '';
  return mermaidAssetPath;
}
import type { CallRow, ChannelSwitchView, ControlApi, CourierMessageView, CourierSendResult, CourierSiteChoice, CourierStopResult, CourierTargetView, PendingHandoff, PermissionMode, SessionAction, SessionInfo, SessionLink, TodoItem, TunnelState } from './controlApi';
import type { DaemonManager } from './daemonManager';
import type { Poller } from './poller';

/** 渠道总开关缺前提时的提示（cloudflared 另有引导卡片）。 */
const CHANNEL_MISSING: Record<string, string> = {
  named_url: '持久渠道还没有配置公网地址，已打开设置页。',
  openai_setup: 'OpenAI 渠道还没配置完（Tunnel ID、tunnel-client 或密钥），已打开设置页。',
  openai_unavailable: '当前 daemon 不支持 OpenAI 渠道。',
  start_failed: '渠道没有启动，原因见鼠标悬停提示。',
};

export interface SidebarHooks {
  /** 首次引导的渠道卡片是否已被用户点过「稍后」（存在 globalState，跨窗口保留）。 */
  setupDismissed?(): boolean;
  dismissSetup?(dismissed: boolean): void;
  /** 下载并验证 cloudflared，把路径存进设置（和设置页的一键安装是同一个安装程序）。 */
  installCloudflared?(): Promise<void>;
  create(): void;
  act(session: SessionInfo, action: SessionAction): void;
  copyTemplate(session: SessionInfo, kind: 'connector' | 'sandbox', message?: string): void;
  /** Chat composer: send to the bound web chat, or open a new one when targetId is null (Courier). */
  chatSend(session: SessionInfo, targetId: string | null, text: string, site?: string): Promise<CourierSendResult>;
  /** Stop button: asks the bound web chat to press its own stop control (daemon relays it to Courier). */
  chatStop(session: SessionInfo, targetId: string | null): Promise<CourierStopResult>;
  /** Cut the session's pairing with its web chat (it only receives afterwards). */
  unpair(session: SessionInfo): Promise<void>;
  /** Force-reload the paired web chat page. */
  chatReload(session: SessionInfo): Promise<void>;
  /** Answer the paired chat's open rating card with the auto-rate rule. */
  chatCard(session: SessionInfo, targetId: string | null): Promise<CourierStopResult>;
  /** Ask for a new name and store it. */
  rename(session: SessionInfo): Promise<void>;
}

interface ViewMessage {
  type: 'ready' | 'create' | 'refresh' | 'settings' | 'open' | 'back' | 'action' | 'copyTemplate' | 'approve' | 'deny' | 'webAgent' | 'callOlder' | 'mode' | 'cancel' | 'reorder' | 'openCallResource' | 'copyHandoff' | 'previewHandoff' | 'cancelHandoffPreview' | 'chatSend' | 'chatStop' | 'openLink' | 'unpair' | 'rename' | 'chatReload' | 'chatCard' | 'copyText' | 'courierImages'
    | 'signIn' | 'channelToggle' | 'setupStart' | 'setupDismiss' | 'setupResume';
  /** channelToggle：打开还是关闭渠道总开关。 */
  on?: boolean;
  /** courierImages: how many images the sent message carries. */
  count?: number;
  id?: string;
  handoffId?: string;
  requestId?: string;
  /** cancel：目标调用所属 session（daemon 侧据此做归属校验）。 */
  sessionId?: string;
  /** approve 的范围（once / session / always）；缺省 = once。 */
  scope?: 'once' | 'session' | 'always';
  action?: SessionAction;
  kind?: 'connector' | 'sandbox';
  permissionMode?: PermissionMode;
  ids?: string[];
  /** chatSend: bound web chat (null = open a new one) and the text. */
  targetId?: string | null;
  text?: string;
  /** chatSend without a bound chat: which site Courier opens (draft card buttons). */
  site?: string;
}

/** 详情页时间线的 feed 首屏条数与每次往上翻的条数（调用 + 回复，最新的在下面）。 */
const FEED_LIMIT = 50;

/** 会话 feed 里的 state（与守护进程 daemon.ts 的 state provider 一致）。 */
interface FeedState {
  name: string | null;
  status: string;
  link: SessionLink;
  connected: boolean;
  target: { targetId: string; site: string; label: string; open: boolean; ready: boolean | null; busy: boolean | null; draft: boolean | null } | null;
}
type SidebarFeed = SessionFeed<CallRow, CourierMessageView, FeedState>;
type SidebarFeedSnapshot = FeedSnapshot<CallRow, CourierMessageView, FeedState>;
interface FeedSlot { id: string; feed: SidebarFeed; off: () => void; last: SidebarFeedSnapshot }
type FeedEvent = Parameters<Parameters<FeedEnv['subscribe']>[0]>[0];
type CourierPane = { connected: boolean; targets: Pick<CourierTargetView, 'targetId' | 'site' | 'label' | 'conversationKey' | 'open' | 'ready' | 'busy' | 'draft'>[]; messages: CourierMessageView[]; link: SessionLink; sites?: CourierSiteChoice[] };

/** feed 的长轮询会挂起最多 wait 秒，请求超时按 (wait+10) 秒（默认 8 秒会把它掰断）。 */
const feedTimeoutMs = (path: string): number => (Number(/[?&]wait=(\d+)/.exec(path)?.[1] ?? 0) + 10) * 1000;

/** 调用与状态没变（元素引用都相同），只有回复消息有变化：流式输出时走轻量消息，不重绘整页调用。 */
function onlyMessagesChanged(a: SidebarFeedSnapshot, b: SidebarFeedSnapshot): boolean {
  if (a.state !== b.state || a.hasOlder !== b.hasOlder || a.loadingOlder !== b.loadingOlder || a.loaded !== b.loaded) return false;
  if (a.calls.length !== b.calls.length || a.calls.some((c, i) => c !== b.calls[i])) return false;
  const ids = new Set(b.messages.map((m) => m.id));
  return a.messages.every((m) => ids.has(m.id));
}

/** Agent replies go to the webview as rendered Markdown (escaped; see markdown.ts), cached per text. */
const mdCache = new Map<string, { text: string; html: string }>();
function chatView(m: CourierMessageView): CourierMessageView & { html?: string } {
  if (m.kind !== 'agent') return m;
  let c = mdCache.get(m.id);
  if (!c || c.text !== m.text) {
    c = { text: m.text, html: renderMarkdown(m.text) };
    mdCache.set(m.id, c);
    if (mdCache.size > 600) mdCache.delete(mdCache.keys().next().value as string);
  }
  return { ...m, html: c.html };
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const samePath = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const currentWorkspaceRoot = (): string => {
  const f = workspace.workspaceFolders?.[0];
  if (!f) return '';
  try {
    return realpathSync(f.uri.fsPath);
  } catch {
    return f.uri.fsPath;
  }
};

const isPathInside = (root: string, target: string): boolean => {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
};

/**
 * Sidebar with two modes: a flat session list (with the user-driven channel
 * row) and, on selecting a session, a tool-call feed with inline approvals.
 * Session actions live in a custom right-click / ⋯ context menu.
 */
export class SidebarProvider implements WebviewViewProvider, Disposable {
  static readonly viewId = 'blackhole.sidebar';

  private view: WebviewView | undefined;
  private sessions: SessionInfo[] = [];
  private tunnel: TunnelState | null = null;
  /** OpenAI tunnel status for the channel pill; runs in parallel with Cloudflare. */
  private openai: string | null = null;
  /** 云端账号状态：只用来决定是否显示登录卡片；null = 还没收到。 */
  private account: AuthView['state'] | null = null;
  /** 渠道总开关；旧版 daemon 没有这个接口时为 null（不显示开关和引导）。 */
  private channel: ChannelSwitchView | null = null;
  private channelBusy = false;
  /** 首次引导：一键安装 cloudflared 并启动临时渠道的进度（null = 没在进行）。 */
  private setup: { step: 'install' | 'restart' | 'start' | 'failed'; failedAt?: 'install' | 'restart' | 'start'; error?: string } | null = null;
  /** 开关缺前提时给用户的一句话（下次刷新清掉）。 */
  private channelNote: string | null = null;
  private disposed = false;
  private viewGeneration = 0;
  private subscriptions: Disposable[] = [];

  private mode: 'sessions' | 'calls' = 'sessions';
  private selectedId = '';
  /** 选中会话的 feed（长轮询，见 sessionFeed.ts）：时间线、回复（含流式输出）、状态都来自它，进入详情页时开、离开时关。 */
  private feed: FeedSlot | null = null;
  /** 详情页已加载的调用（最旧的在前）：随 feed 快照更新，打开文件等操作按它查记录。 */
  private pageCalls: CallRow[] = [];
  /** feed 所需的页面可见/隐藏事件（侧栏隐藏时不挂着长轮询）。 */
  private readonly feedEvents = new Set<(event: FeedEvent) => void>();
  /** refresh 串行化：上一轮未结束时只标记重跑，快速翻页不会乱序覆盖。 */
  private refreshBusy = false;
  private refreshAgain = false;
  /** daemon 变更 epoch：与上次相同则本轮零拉取（见 refresh）。 */
  private lastEpoch = -1;
  /** 当前详情页的任务清单与可选目标（两者皆空时不渲染）。 */
  private todos: TodoItem[] = [];
  private todoGoal: string | undefined;
  private todosUnavailable = false;
  /** Chat page: Courier connection, web chats bound to the selected session, and its thread. */
  /** Session list: each session's web-chat link (paired sessions get 刷新网页 / 解除配对 in their menu). */
  private links: Record<string, SessionLink> = {};
  /** 新建会话可选的站点（内置 + 在 Courier 里添加的）：只在 /courier 状态里，详情页刷新时读。 */
  private courierSites: CourierSiteChoice[] | undefined;
  private webFlags: { busy: string[]; asking: string[] } = { busy: [], asking: [] };
  private handoff: PendingHandoff | null = null; // Never populated by polling; cleared on disposal.
  private navigationGeneration = 0;
  private previewGeneration = 0;
  private handoffSynchronized = false;
  private handoffCopyToken: object | undefined;
  private handoffEndpoint = '';
  private handoffDaemon = '';
  private pending: Awaited<ReturnType<ControlApi['confirmations']>>['confirmations'] = [];

  constructor(
    private readonly api: ControlApi,
    private readonly daemon: DaemonManager,
    private readonly poller: Poller,
    private readonly hooks: SidebarHooks,
  ) {
    this.subscriptions.push(
      this.poller.onTick(() => void this.refresh()),
      this.daemon.onDidChangeState(() => {
        if (this.daemon.currentState !== 'running') {
          this.handoffSynchronized = false; this.navigationGeneration++; this.previewGeneration++;
        }
        this.postUpdate();
      }),
    );
  }

  resolveWebviewView(view: WebviewView): void {
    if (this.disposed) return;
    this.view = view;
    this.viewGeneration++;
    this.lastEpoch = -1;
    const messages = view.webview.onDidReceiveMessage((m: ViewMessage) => {
      if (this.view !== view || this.disposed) return;
      void this.onMessage(m).catch(error => { if (this.view === view && !this.disposed) console.error('BlackHole: sidebar action failed', error); });
    });
    // 侧栏隐藏/显示：feed 隐藏时中止挂起的请求，显示时用原 offset 立即拉一次
    const visibility = view.onDidChangeVisibility?.(() => this.emitFeedEvent(view.visible ? 'show' : 'hide'));
    view.onDidDispose(() => {
      messages.dispose();
      visibility?.dispose();
      if (this.view === view) {
        this.view = undefined; this.handoff = null; this.viewGeneration++; this.refreshAgain = false;
        this.emitFeedEvent('hide');
      }
    });
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html(view.webview);
    this.emitFeedEvent('show');
    void this.refresh(true);
  }

  private emitFeedEvent(event: FeedEvent): void {
    for (const fn of [...this.feedEvents]) fn(event);
  }

  private feedEnv(): FeedEnv {
    return {
      now: () => Date.now(),
      sleep: abortableSleep,
      visible: () => this.view !== undefined && this.view.visible !== false,
      subscribe: (cb) => {
        this.feedEvents.add(cb);
        return () => { this.feedEvents.delete(cb); };
      },
    };
  }

  /** 打开选中会话的 feed（先关掉上一个）。 */
  private openFeed(id: string): void {
    this.closeFeed(); // 同时清空 pageCalls
    const feed: SidebarFeed = new SessionFeed({
      sessionId: id,
      limit: FEED_LIMIT,
      fetchJson: (feedPath, signal) => this.api.feedJson(feedPath, signal, feedTimeoutMs(feedPath)),
      env: this.feedEnv(),
    });
    const slot: FeedSlot = { id, feed, off: () => undefined, last: feed.snapshot() };
    slot.off = feed.subscribe(() => this.onFeed(slot));
    this.feed = slot;
    feed.start();
  }

  private closeFeed(): void {
    this.pageCalls = [];
    const slot = this.feed;
    if (!slot) return;
    this.feed = null;
    slot.off();
    slot.feed.stop();
  }

  /** 刷新 feed：发送消息、停止、解除配对等操作后立即再读一次，不等长轮询。 */
  private kickFeed(): void {
    this.feed?.feed.kick();
  }

  /** feed 有变化：只有回复文本在变（流式输出）时发轻量消息，其他变化整页重绘。 */
  private onFeed(slot: FeedSlot): void {
    if (this.disposed || this.feed !== slot) return;
    const prev = slot.last;
    const next = slot.feed.snapshot();
    slot.last = next;
    if (this.mode !== 'calls' || this.selectedId !== slot.id) return;
    this.pageCalls = next.calls;
    if (!onlyMessagesChanged(prev, next)) { this.postUpdate(); return; }
    const before = new Map(prev.messages.map((m) => [m.id, m]));
    for (const m of next.messages) {
      if (before.get(m.id) !== m) void this.post({ type: 'chatMsg', sessionId: slot.id, message: chatView(m) });
    }
  }

  /** 当前详情页的 feed 快照（不在详情页或 feed 还没开时为 null）。 */
  private feedSnapshot(): SidebarFeedSnapshot | null {
    return this.mode === 'calls' && this.feed?.id === this.selectedId ? this.feed.feed.snapshot() : null;
  }

  /** 详情页的聊天状态：全部来自 feed 的 state 与回复（不再单独拉 /courier、/courier/messages）。 */
  private get courier(): CourierPane {
    const snap = this.feedSnapshot();
    const st = snap?.state ?? null;
    const t = st?.target ?? null;
    return {
      connected: st?.connected ?? false,
      targets: t ? [{ targetId: t.targetId, site: t.site, label: t.label, conversationKey: null, open: t.open, ready: t.ready, busy: t.busy, draft: t.draft }] : [],
      messages: snap?.messages ?? [],
      link: st?.link ?? (this.selected()?.draft ? 'new' : 'direct'),
      sites: this.courierSites,
    };
  }


  /** Whether inline approvals are actually visible, not merely retained in memory. */
  get visible(): boolean {
    return !this.disposed && this.view?.visible === true;
  }

  /** True once the webview exists — the inline/top approval banners can render. */
  get resolved(): boolean {
    return this.view !== undefined;
  }

  projectName(sessionId: string): string | undefined {
    const s = this.sessions.find((x) => x.id === sessionId);
    return s ? path.basename(s.workspace_path) : undefined;
  }

  /** Enter the call feed for a session (called by openSession command too). */
  showCalls(session: SessionInfo): void {
    this.navigationGeneration++;
    this.previewGeneration++;
    this.mode = 'calls';
    this.selectedId = session.id;
    this.openFeed(session.id);
    this.todos = [];
    this.todoGoal = undefined;
    this.todosUnavailable = false;
    this.handoff = null;
    this.postUpdate();
    void this.refresh(true);
  }

  async refresh(force = false): Promise<void> {
    if (this.disposed || !this.view) return;
    // 串行化：上一轮未结束时只标记再跑一轮，重跑内部按最新页码重拉。
    // 快速连点翻页时，乱序完成的旧响应不会把新页覆盖回去。
    if (this.refreshBusy) {
      this.refreshAgain = true;
      return;
    }
    this.refreshBusy = true;
    try {
      do {
        this.refreshAgain = false;
        // 重跑视为强制：翻页不改变 daemon epoch，门控会把它误跳过
        await this.refreshInner(force);
        force = true;
      } while (this.refreshAgain && !this.disposed && this.view);
    } catch (error) {
      if (!this.disposed && this.view) console.error('BlackHole: sidebar refresh failed', error);
    } finally {
      this.refreshBusy = false;
    }
  }

  private async refreshInner(force: boolean): Promise<void> {
    const generation = this.viewGeneration;
    const current = () => !this.disposed && this.view !== undefined && generation === this.viewGeneration;
    if (!current()) return;
    // 变更门控：daemon 的 epoch 没动 = 没有任何新东西，本轮零拉取零重绘
    // （运行中卡片的耗时由 webview 内的本地时钟推进，见 renderCalls）。
    // /changes 不可达（旧 daemon/瞬时故障）→ 照旧全量刷新，自愈性不变。
    let nextEpoch = -1;
    if (!force) {
      const ch = await this.api.changes().catch(() => undefined);
      if (!current()) return;
      if (ch) {
        if (ch.epoch === this.lastEpoch) return;
        nextEpoch = ch.epoch;
      }
    }
    // 只有完整读取当前快照后才确认 epoch。任何部分失败都要在下一 tick
    // 重试，不能把一次临时故障缓存为“没有变化”；强制刷新仍绕过门控。
    this.lastEpoch = -1;
    let complete = true;
    const failed = <T>(fallback: T): T => { complete = false; return fallback; };
    // 全量拉取待审批确认：审批条在列表/详情两种模式下都要渲染（样式与内联框一致）
    const [sessions, health, pendingAll, channel] = await Promise.all([
      this.api.listSessions().then((r) => r.sessions).catch(() => failed(undefined)),
      this.api.health().catch(() => failed(undefined)),
      this.api.confirmations().then((r) => r.confirmations.filter((c) => c.status === 'pending')).catch(() => failed([])),
      // 拉取失败即清空：daemon 不可达时没有可处理的审批，徽标绝不残留旧数字
      // 渠道总开关是可选的：旧版 daemon 没有这个接口，不影响列表。
      Promise.resolve().then(() => this.api.channel()).catch(() => null),
    ]);
    if (!current()) return;
    this.channel = channel;
    if (channel?.on) this.channelNote = null;
    if (sessions !== undefined) {
      this.sessions = sessions.filter((s) => s.status !== 'revoked' && s.status !== 'archived');
    }
    this.tunnel = health ? { status: health.tunnel, url: health.tunnel_url, mode: health.tunnel_mode, reason: health.tunnel_reason } : null;
    this.openai = health?.openai_tunnel?.status ?? null;
    this.pending = pendingAll;
    this.handoffSynchronized = sessions !== undefined && health !== undefined;
    const endpoint = JSON.stringify(getConfig());
    const daemonId = health?.daemon_id ?? '';
    if ((this.handoffEndpoint && endpoint !== this.handoffEndpoint)
      || (this.handoffDaemon && daemonId && daemonId !== this.handoffDaemon)) {
      this.navigationGeneration++; this.previewGeneration++;
    }
    this.handoffEndpoint = endpoint;
    if (daemonId) this.handoffDaemon = daemonId;
    if (!this.handoffSynchronized) this.previewGeneration++;

    if (this.mode === 'calls') {
      const sel = this.sessions.find((s) => s.id === this.selectedId);
      if (!sel) {
        this.mode = 'sessions'; // selected session vanished
        this.closeFeed();
        this.handoff = null;
      } else {
        const detailCurrent = () => current() && this.mode === 'calls' && this.selectedId === sel.id;
        let todosUnavailable = false;
        // 时间线、回复、聊天状态都由 feed 自己推送（onFeed），这里只拉任务清单和新建会话可选的站点。
        const [todoBoard, courier] = await Promise.all([
          // daemon 不可达即清空可见清单，但明确标记为“暂不可用”，避免 webview
          // 把一次 transport failure 当成真实空 board 并丢掉当前详情页的完成态上下文。
          this.api.todos(sel.id).catch(() => {
            todosUnavailable = true;
            return failed({ items: [] as TodoItem[], contract: undefined, updated_at: 0 });
          }),
          // Chat state is optional: any failure (even a synchronous one) must not block the call page.
          Promise.resolve().then(() => this.api.courierStatus(true)).catch(() => null),
        ]);
        if (!detailCurrent()) { this.refreshAgain = true; return; }
        this.todos = todoBoard.items;
        this.todoGoal = todoBoard.contract?.goal;
        this.todosUnavailable = todosUnavailable;
        // New-chat sites (builtins + sites added in Courier); an older daemon sends none.
        if (courier && 'sites' in courier && Array.isArray(courier.sites)) this.courierSites = courier.sites;
      }
    }

    if (this.mode === 'sessions') {
      // Cached Courier state only (no round trip to the browser); optional, never blocks the list.
      const st = await Promise.resolve().then(() => this.api.courierStatus(true)).catch(() => null);
      this.links = st && 'links' in st && st.links ? st.links : {};
      // Row status: the web agent is replying / waiting for an answer to its question.
      const targets = (st && 'targets' in st ? st.targets : []) as Array<{ sessionId?: string | null; busy?: boolean | null }>;
      this.webFlags = {
        busy: targets.filter((t) => t.busy && t.sessionId).map((t) => t.sessionId!),
        asking: st && 'asking' in st && Array.isArray((st as { asking?: unknown }).asking) ? (st as { asking: string[] }).asking : [],
      };
    }

    if (complete) this.lastEpoch = nextEpoch;
    this.postUpdate();
  }

  /** 云端账号状态变化（登录、退出、刷新）：侧边栏据此显示或收起登录卡片。 */
  updateAccount(view: AuthView): void {
    if (this.account === view.state) return;
    this.account = view.state;
    this.postUpdate();
  }

  /** 侧边栏标题里的渠道总开关。缺 cloudflared 时展开引导卡片（下载要用户在卡片里确认），其他前提打开设置页。 */
  private async toggleChannel(on: boolean): Promise<void> {
    if (this.channelBusy || this.setup) return;
    this.channelBusy = true;
    this.channelNote = null;
    this.postUpdate();
    try {
      const r = await this.api.channelSwitch(on);
      if (!r.ok) {
        if (r.error === 'cloudflared') {
          this.hooks.dismissSetup?.(false);
          this.channelNote = '还没有 cloudflared：用下面的「一键安装并启动」。';
        } else {
          this.channelNote = CHANNEL_MISSING[r.error] ?? `渠道没有启动（${r.error}）。`;
          if (r.error === 'named_url' || r.error === 'openai_setup') void commands.executeCommand('blackhole.openSettings');
        }
      }
    } catch (e) {
      this.channelNote = `操作失败：${e instanceof Error ? e.message : String(e)}`;
    } finally {
      this.channelBusy = false;
    }
    await this.refresh(true);
  }

  /**
   * 首次引导：下载并验证 cloudflared → 保存路径并重启 daemon（路径只在启动时读取）→ 启动临时渠道。
   * 只由卡片上的按钮触发；任何一步失败都停在那里，可以重试。
   */
  private async runSetup(): Promise<void> {
    if (this.setup && this.setup.step !== 'failed') return;
    const step = (s: 'install' | 'restart' | 'start') => { this.setup = { step: s }; this.postUpdate(); };
    const fail = (at: 'install' | 'restart' | 'start', e: unknown) => {
      const message = (e as { message?: unknown } | null)?.message;
      this.setup = { step: 'failed', failedAt: at, error: typeof message === 'string' ? message : String(e) };
      this.postUpdate();
    };
    step('install');
    try {
      if (!this.hooks.installCloudflared) throw new Error('当前版本不支持一键安装，请在设置页配置。');
      await this.hooks.installCloudflared();
    } catch (e) { fail('install', e); return; }
    if (this.disposed) return;
    step('restart');
    try {
      // restart() 会合并配置变化触发的那次重启，不会重启两次。
      if (!(await this.daemon.restart())) throw new Error('本地服务重启失败，请稍后重试。');
    } catch (e) { fail('restart', e); return; }
    if (this.disposed) return;
    step('start');
    try {
      // 引导固定启动临时渠道（即使配过持久地址），并记为「上次使用」。
      const t = await this.api.tunnelStart('quick');
      if (t.status !== 'starting' && t.status !== 'online' && t.status !== 'unverified') throw new Error(t.reason || '临时渠道没有启动。');
    } catch (e) { fail('start', e); return; }
    this.setup = null;
    if (!this.disposed) void window.showInformationMessage('BlackHole：已提交临时渠道启动请求，连接状态将在侧栏更新。');
    await this.refresh(true);
  }

  /** 详情页往上翻：由 feed 读下一页更早的调用与回复（/history），状态变化经 onFeed 推给页面。 */
  private async loadOlder(): Promise<void> {
    const slot = this.mode === 'calls' ? this.feed : null;
    if (!slot || slot.id !== this.selectedId) return;
    await slot.feed.loadOlder(); // 失败时保留已加载的内容，下次再往上翻重试
  }

  private selected(): SessionInfo | undefined {
    return this.sessions.find((s) => s.id === this.selectedId);
  }

  private async post(message: unknown): Promise<void> {
    const view = this.view;
    if (!view || this.disposed) return;
    try { await view.webview.postMessage(message); }
    catch (error) { if (!this.disposed && this.view === view) console.error('BlackHole: sidebar update failed', error); }
  }

  private postUpdate(): void {
    if (!this.view || this.disposed) return;
    const snap = this.feedSnapshot();
    const courier = this.mode === 'calls' ? this.courier : undefined;
    void this.post({
      type: 'update',
      mode: this.mode,
      sessions: this.sessions,
      daemon: this.daemon.currentState,
      currentRoot: currentWorkspaceRoot(),
      tunnel: this.tunnel,
      openai: this.openai,
      account: this.account,
      channel: this.channel,
      channelBusy: this.channelBusy,
      channelNote: this.channelNote,
      setup: this.setup,
      setupDismissed: this.hooks.setupDismissed?.() ?? false,
      selected: this.mode === 'calls' ? this.selected() : undefined,
      // 只送当前页：旧会话几百条记录时不再每轮全量展开+解析+过桥大 payload
      calls:
        this.mode === 'calls'
          ? this.pageCalls.map((c) => {
              // Keep raw args/results in the trusted Extension Host. The webview
              // receives only the rendered text and a bounded navigation hint.
              const {
                args_json: _argsJson,
                result_summary: _resultSummary,
                navigation_json: _navigationJson,
                args_hash: _argsHash,
                session_id: _sessionId,
                seq: _seq,
                ...row
              } = c;
              return {
                ...row,
                tool: displayToolName(c.tool),
                summary: commandSummary(c),
                argsDisplay: argumentDetails(c),
                body: resultBody(c),
                diff: resultDiff(c),
                navigation: editorNavigationPreview(c),
              };
            })
          : [],
      // 「会话开始 · 共 N 次调用」只在已翻到头（没有更早的）时显示，这时已加载的调用数就是总数
      callTotal: snap && !snap.hasOlder ? snap.calls.length : 0,
      hasOlder: snap?.hasOlder ?? false,
      olderBusy: snap?.loadingOlder ?? false,
      todos: this.mode === 'calls' ? this.todos : [],
      goal: this.mode === 'calls' ? this.todoGoal : undefined,
      todosUnavailable: this.mode === 'calls' ? this.todosUnavailable : false,
      courier: courier ? { ...courier, messages: courier.messages.map(chatView) } : undefined,
      links: this.mode === 'sessions' ? this.links : undefined,
      web: this.mode === 'sessions' ? this.webFlags : undefined,
      handoffSynchronized: this.handoffSynchronized,
      handoffGeneration: this.navigationGeneration,
      handoffUnsupported: this.sessions.some(s => s.pending_handoff === undefined),
      pending: this.pending,
    });
  }

  private async openCallResource(callId: string): Promise<void> {
    if (this.mode !== 'calls') return;
    const session = this.selected();
    const call = this.pageCalls.find((row) => row.id === callId);
    if (!session || !call || call.session_id !== session.id || !isWorkspaceFileTool(call.tool)) {
      void window.showErrorMessage('BlackHole: 无法验证该文件调用的会话归属');
      return;
    }
    const navigation = editorNavigationPreview(call);
    if (!navigation || !navigation.enabled) {
      void window.showInformationMessage('BlackHole: 该调用当前没有可用的文件导航');
      return;
    }
    let workspaceRoot: string;
    try {
      workspaceRoot = realpathSync(session.workspace_path);
    } catch {
      void window.showErrorMessage('BlackHole: 该会话的工作区当前不可访问');
      return;
    }
    // New records use workspace-relative paths. Legacy calls may have stored an
    // absolute in-workspace argument; accept it only after the same containment check.
    const target = path.isAbsolute(navigation.path)
      ? path.normalize(navigation.path)
      : path.resolve(workspaceRoot, navigation.path);
    // A legacy absolute path may be spelled through a symlinked session path
    // (macOS /var -> /private/var, symlinked project dirs). This is only a
    // pre-filter; the real-path containment check below is the boundary.
    if (!isPathInside(workspaceRoot, target) && !isPathInside(path.resolve(session.workspace_path), target)) {
      void window.showErrorMessage('BlackHole: 文件导航路径越过了会话工作区');
      return;
    }
    if (!existsSync(target)) {
      const resolved = resolveEditorNavigation(call, null);
      if (resolved.state === 'deleted') void window.showInformationMessage(`BlackHole: ${resolved.notice ?? '文件已删除'}`);
      else void window.showErrorMessage(`BlackHole: ${resolved.notice ?? '文件当前不存在'}`);
      return;
    }

    let realTarget: string;
    try {
      realTarget = realpathSync(target);
      if (!isPathInside(workspaceRoot, realTarget) || !statSync(realTarget).isFile()) throw new Error('not a workspace file');
    } catch {
      void window.showErrorMessage('BlackHole: 目标不是会话工作区内的普通文件');
      return;
    }

    const document = await workspace.openTextDocument(Uri.file(realTarget));
    const resolved = resolveEditorNavigation(call, document.getText());
    const editor = await window.showTextDocument(document, { preview: true });
    if (resolved.startLine) {
      const startLine = Math.min(Math.max(0, resolved.startLine - 1), Math.max(0, document.lineCount - 1));
      const endLine = Math.min(Math.max(startLine, (resolved.endLine ?? resolved.startLine) - 1), Math.max(0, document.lineCount - 1));
      const start = new Position(startLine, 0);
      const end = document.lineAt(endLine).range.end;
      const range = new Range(start, end);
      editor.selection = new Selection(start, end);
      editor.revealRange(range, TextEditorRevealType.InCenter);
    } else {
      const top = new Position(0, 0);
      editor.selection = new Selection(top, top);
      editor.revealRange(new Range(top, top), TextEditorRevealType.InCenter);
    }
    if (resolved.notice) window.setStatusBarMessage(`BlackHole: ${resolved.notice}`, 6000);
  }

  private handoffRequest(m: ViewMessage): boolean {
    const bounded = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 256;
    return bounded(m.id) && bounded(m.handoffId) && bounded(m.requestId);
  }

  private handoffCurrent(m: ViewMessage, generation: number, navigation: number, endpoint: string): boolean {
    return !this.disposed && this.view !== undefined && generation === this.viewGeneration
      && navigation === this.navigationGeneration && endpoint === JSON.stringify(getConfig())
      && this.handoffSynchronized
      && (this.mode === 'sessions' || this.selectedId === m.id)
      && this.sessions.some(s => s.id === m.id && s.pending_handoff?.id === m.handoffId);
  }

  private async copyHandoff(m: ViewMessage): Promise<void> {
    if (!this.handoffRequest(m) || (m.kind !== 'connector' && m.kind !== 'sandbox')) return;
    const generation = this.viewGeneration, navigation = this.navigationGeneration, endpoint = JSON.stringify(getConfig());
    const current = () => this.handoffCurrent(m, generation, navigation, endpoint);
    const respond = (ok: boolean, error?: string) => generation === this.viewGeneration && !this.disposed
      ? this.post({ type: 'handoffCopied', id: m.id, handoffId: m.handoffId, requestId: m.requestId, kind: m.kind, ok, error }) : Promise.resolve();
    if (this.handoffCopyToken) { await respond(false, 'Handoff 正在复制，请稍后重试。'); return; }
    if (!current()) { await respond(false, 'Handoff 已更新或未同步，请重试复制。'); return; }
    const token = {}; this.handoffCopyToken = token;
    try {
      const prompt = await prepareHandoffPrompt(this.api, m.id!, m.handoffId!, m.kind, getConfig().connectorName || 'BlackHole');
      if (!current()) { await respond(false, 'Handoff 操作上下文已改变，请重试复制。'); return; }
      await env.clipboard.writeText(prompt);
      await respond(true);
    } catch (error) {
      await respond(false, msg(error));
      if (current()) await this.refresh(true);
    } finally {
      if (this.handoffCopyToken === token) this.handoffCopyToken = undefined;
    }
  }

  private async previewHandoff(m: ViewMessage): Promise<void> {
    if (!this.handoffRequest(m)) return;
    const generation = this.viewGeneration, navigation = this.navigationGeneration, endpoint = JSON.stringify(getConfig());
    const preview = ++this.previewGeneration;
    const current = () => preview === this.previewGeneration && this.handoffCurrent(m, generation, navigation, endpoint);
    const respond = (data: object) => this.post({ type: 'handoffPreview', id: m.id, handoffId: m.handoffId, requestId: m.requestId, ...data });
    if (!current()) { await respond({ ok: false, error: 'Handoff 已更新或未同步，请重试。' }); return; }
    try {
      const snapshot = await this.api.handoff(m.id!);
      if (!current()) return;
      if (snapshot.session.id !== m.id || snapshot.handoff?.id !== m.handoffId) throw Error('Handoff 已更新或清除，请重试。');
      await respond({ ok: true, handoff: snapshot.handoff });
    } catch (error) {
      if (current()) { await respond({ ok: false, error: msg(error) }); await this.refresh(true); }
    }
  }

  private async onMessage(m: ViewMessage): Promise<void> {
    switch (m.type) {
      case 'ready':
        // page's message listener is attached; push current state now so the
        // view renders even if the poller hasn't ticked yet
        this.postUpdate();
        return;
      case 'create':
        this.hooks.create();
        return;
      case 'refresh':
        void this.refresh(true);
        return;
      case 'callOlder':
        await this.loadOlder();
        return;
      case 'previewHandoff':
        await this.previewHandoff(m);
        return;
      case 'cancelHandoffPreview':
        this.previewGeneration++;
        return;
      case 'copyHandoff':
        await this.copyHandoff(m);
        return;
      case 'openCallResource':
        if (m.id) await this.openCallResource(m.id);
        return;
      case 'courierImages': {
        // Sent images live in the daemon; the webview has no network, so they travel as data: URLs.
        const id = typeof m.id === 'string' ? m.id : '';
        const count = Math.min(Math.max(Math.floor(Number(m.count) || 0), 0), 8);
        if (!id || !count) return;
        const urls = await Promise.all(Array.from({ length: count }, (_, i) => this.api.courierImage(id, i).catch(() => null)));
        await this.post({ type: 'courierImagesData', id, urls });
        return;
      }
      case 'copyText':
        // Code-block copy in replies: plain text, capped so a webview cannot flood the clipboard.
        if (typeof m.text === 'string' && m.text.length <= 1_000_000) await env.clipboard.writeText(m.text);
        return;
      case 'openLink': {
        // Links in agent replies (markdown.ts only emits http(s)/mailto); re-checked here.
        const url = typeof m.text === 'string' ? m.text : '';
        if (/^(?:https?:\/\/|mailto:)/i.test(url)) await env.openExternal(Uri.parse(url, true));
        return;
      }
      case 'settings':
        await commands.executeCommand('blackhole.openSettings');
        return;
      case 'signIn':
        // 和设置页同一个登录命令：在浏览器里完成，账号状态变化经 updateAccount 推回来。
        await commands.executeCommand('blackhole.accountSignIn');
        return;
      case 'channelToggle':
        if (typeof m.on === 'boolean') await this.toggleChannel(m.on);
        return;
      case 'setupStart':
        await this.runSetup();
        return;
      case 'setupDismiss':
        this.hooks.dismissSetup?.(true);
        if (this.setup?.step === 'failed') this.setup = null;
        this.postUpdate();
        return;
      case 'setupResume':
        // Reveal the existing setup UI only; never install or start a channel implicitly.
        this.hooks.dismissSetup?.(false);
        this.postUpdate();
        return;
      case 'webAgent':
        await commands.executeCommand('blackhole.openLocalWeb');
        return;
      case 'back': {
        // Closing a draft nobody has used (no web chat, no message) means it is not wanted: discard it.
        const leaving = this.mode === 'calls' ? this.selected() : undefined;
        if (leaving?.draft && !this.courier.messages.length && !this.courier.targets.length) {
          void this.api.sessionAction(leaving.id, 'revoke').catch(() => undefined).then(() => this.refresh(true));
        }
      }
        this.navigationGeneration++;
        this.previewGeneration++;
        this.mode = 'sessions';
        this.closeFeed();
        this.handoff = null;
        // 模式切换必须立即重绘：epoch 门控会因"没有新变更"跳过本轮刷新，
        // 返回列表就永远停在详情页
        this.postUpdate();
        void this.refresh(true);
        return;
      case 'open': {
        const s = this.sessions.find((x) => x.id === m.id);
        if (s) this.showCalls(s);
        return;
      }
      case 'approve':
      case 'deny': {
        if (!m.id) return;
        try {
          const resolved = await this.api.resolveConfirmation(m.id, m.type === 'approve' ? 'approve' : 'deny', m.scope);
          if (m.type === 'approve' && m.scope === 'always' && resolved.scope === 'session') {
            window.setStatusBarMessage('BlackHole: 该操作含不可逆风险，「始终批准」已按策略降级为本会话授权', 6000);
          }
          // 就地更新待审批列表，随后的轮询校正为服务端真值
          this.pending = this.pending.filter((p) => p.id !== m.id);
          void this.refresh();
        } catch (e) {
          void window.showErrorMessage(`BlackHole: 审批操作失败 — ${msg(e)}`);
        }
        return;
      }
      case 'cancel': {
        // 取消 proxy 调用（pending 审批 / 在途 upstream）：成功后立即走一次
        // 轮询刷新（daemon 侧已记 denied 并释放队列，epoch 会 bump）。
        // 404 = 已无可取消对象（恰好被拒/超时/完成），静默忽略。
        if (!m.id) return;
        try {
          await this.api.cancelCall(m.id, m.sessionId);
          void this.refresh();
        } catch (e) {
          if ((e as { status?: number }).status !== 404) {
            void window.showErrorMessage(`BlackHole: 取消调用失败 — ${msg(e)}`);
          }
        }
        return;
      }
      case 'mode': {
        const s = (m.id ? this.sessions.find((x) => x.id === m.id) : undefined) ?? this.selected();
        if (!s || !m.permissionMode || s.permission_mode === m.permissionMode) return;
        if (m.permissionMode === 'danger-full-access') {
          const confirm = await window.showWarningMessage(
            'BlackHole: 完全访问会允许该会话在本机工作区外写入并执行高风险命令，且不再进行常规命令审批。仅对完全信任的 Agent 使用。',
            { modal: true },
            '启用完全访问',
          );
          if (confirm !== '启用完全访问') return;
        }
        try {
          const updated = await this.api.setSessionMode(s.id, m.permissionMode);
          this.sessions = this.sessions.map((row) => row.id === updated.id ? updated : row);
          const label = updated.permission_mode === 'read-only'
            ? '只读'
            : updated.permission_mode === 'danger-full-access'
              ? '完全访问'
              : '工作区可写';
          void window.showInformationMessage(`BlackHole: 会话已切换为 ${label} 模式`);
          this.postUpdate();
          void this.refresh(true);
        } catch (e) {
          void window.showErrorMessage(`BlackHole: 切换权限失败 — ${msg(e)}`);
        }
        return;
      }
      case 'reorder': {
        // The list does not show drafts (the daemon keeps them out of the stored order too):
        // compare with the listed sessions, or every drag is dropped silently.
        const listed = this.sessions.filter((s) => !s.draft);
        if (!Array.isArray(m.ids) || m.ids.length !== listed.length) return;
        try {
          const result = await this.api.reorderSessions(m.ids);
          this.sessions = result.sessions.filter((s) => s.status !== 'revoked' && s.status !== 'archived');
          this.postUpdate();
        } catch (e) {
          void window.showErrorMessage(`BlackHole: 调整会话顺序失败 — ${msg(e)}`);
          void this.refresh(true);
        }
        return;
      }
      case 'chatSend': {
        const s = m.id ? this.sessions.find((x) => x.id === m.id) : undefined;
        if (!s || typeof m.text !== 'string' || !m.text.trim()) return;
        // Without a paired chat only a new session may send: that opens a ChatGPT chat (connector prompt first).
        const targetId = typeof m.targetId === 'string' ? m.targetId : null;
        if (!targetId && this.courier.link !== 'new') return;
        // arena / chatgpt / a site added in Courier (c-…); anything else opens ChatGPT.
        const site = typeof m.site === 'string' && /^(arena|chatgpt|c-[a-z0-9-]{1,30})$/.test(m.site) ? m.site : 'chatgpt';
        const r = await this.hooks.chatSend(s, targetId, m.text, site);
        void this.post({ type: 'chatResult', id: s.id, ok: r.ok, sent: r.sent, message: r.message });
        this.kickFeed();
        void this.refresh();
        return;
      }
      case 'chatStop': {
        const s = m.id ? this.sessions.find((x) => x.id === m.id) : undefined;
        if (!s) return;
        const targetId = typeof m.targetId === 'string' ? m.targetId : null;
        const r = await this.hooks.chatStop(s, targetId);
        void this.post({ type: 'chatStopResult', id: s.id, ok: r.ok, code: r.code, message: r.message });
        this.kickFeed();
        void this.refresh();
        return;
      }
      case 'unpair': {
        const s = m.id ? this.sessions.find((x) => x.id === m.id) : undefined;
        if (!s) return;
        await this.hooks.unpair(s);
        this.kickFeed();
        void this.refresh(true);
        return;
      }
      case 'chatCard': {
        const s = m.id ? this.sessions.find((x) => x.id === m.id) : undefined;
        if (!s) return;
        const r = await this.hooks.chatCard(s, typeof m.targetId === 'string' ? m.targetId : null);
        void this.post({ type: 'chatCardResult', id: s.id, ok: r.ok, message: r.message });
        this.kickFeed();
        void this.refresh();
        return;
      }
      case 'chatReload': {
        const s = m.id ? this.sessions.find((x) => x.id === m.id) : undefined;
        if (!s) return;
        await this.hooks.chatReload(s);
        this.kickFeed();
        void this.refresh();
        return;
      }
      case 'rename': {
        const s = m.id ? this.sessions.find((x) => x.id === m.id) : undefined;
        if (!s) return;
        await this.hooks.rename(s);
        this.kickFeed();
        void this.refresh(true);
        return;
      }
      case 'action':
      case 'copyTemplate': {
        // act on the session the menu was opened for; the id-less form (older
        // messages) still means "the session the call feed is showing"
        const s = (m.id ? this.sessions.find((x) => x.id === m.id) : undefined) ?? this.selected();
        if (!s) return;
        if (m.type === 'action' && m.action) this.hooks.act(s, m.action);
        else if (m.type === 'copyTemplate' && m.kind) this.hooks.copyTemplate(s, m.kind, typeof m.text === 'string' && m.text.trim() ? m.text : undefined);
        return;
      }
    }
  }

  private html(webview?: WebviewView['webview']): string {
    const nonce = Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
    // Mermaid: reuse the Web build's copy shipped with the daemon (dist/daemon/web/assets/mermaid-<hash>.min.js).
    const mermaidFile = webview?.asWebviewUri ? mermaidAsset() : '';
    const mermaidSrc = mermaidFile ? webview!.asWebviewUri(Uri.file(mermaidFile)).toString() : '';
    const scriptSrc = webview?.cspSource ? ` ${webview.cspSource}` : '';
    // Reuse the shipped brand asset; a data URI keeps the existing image CSP unchanged.
    let brandIcon = '';
    try { brandIcon = 'data:image/svg+xml;base64,' + readFileSync(path.join(__dirname, '..', 'media', 'icon.svg')).toString('base64'); }
    catch { /* Non-packaged test fixtures may not have extension assets. */ }
    const mermaidConfigs = JSON.stringify({ dark: mermaidConfig(true), default: mermaidConfig(false) });
    const csp = `default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'${scriptSrc};`;
    return `<!DOCTYPE html>
<html lang="zh-cn">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  /* 布局锚定 webview 视口，标题、任务区和分页各自占位，只有列表滚动。 */
  html, body { height: 100%; }
  /* 撤销宿主注入的 scrollbar-color，才能启用下方的 4px WebKit 滚动条样式。 */
  html { scrollbar-color: auto; }
  body { position: relative; font-family: var(--vscode-font-family); color: var(--vscode-foreground); font-size: 13px; padding: 0; margin: 0; overflow: hidden; }
  body::-webkit-scrollbar { width: 0; height: 0; }
  #layout { position: fixed; inset: 0; display: flex; flex-direction: column; overflow: hidden; }
  #layout > .err { flex-shrink: 0; }
  /* 列表外层：给「回到底部」一个不随滚动移动的定位基准 */
  .list-wrap { flex: 1; min-width: 0; min-height: 0; position: relative; display: flex; }
  #list { flex: 1; min-height: 0; min-width: 0; overflow-y: auto; overscroll-behavior: contain; padding-bottom: 10px; }
  .list-wrap .jump { position: absolute; right: 14px; bottom: 12px; width: 28px; height: 28px; display: grid; place-items: center; padding: 0; border-radius: 999px; border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background)); color: var(--vscode-foreground); box-shadow: 0 2px 10px rgba(0, 0, 0, .35); font-size: 13px; line-height: 1; cursor: pointer; z-index: 3; }
  .list-wrap .jump:hover { background: color-mix(in srgb, var(--vscode-foreground) 12%, var(--vscode-sideBar-background)); }
  .list-wrap .jump:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
  .hdr { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-bottom: 1px solid var(--vscode-panel-border); flex-shrink: 0; background: var(--vscode-sideBar-background); }
  .hdr .ttl { font-weight: 650; font-size: 13px; }
  .hdr .ttl.small { font-weight: 600; font-size: 12.5px; }
  .hdr .sp { flex: 1; }
  .ib { width: 24px; height: 24px; display: grid; place-items: center; border: none; border-radius: 6px; background: transparent; color: var(--vscode-icon-foreground); cursor: pointer; font-family: inherit; padding: 0; font-size: 13px; }
  .ib:hover { background: var(--vscode-toolbar-hoverBackground); }
  .ib svg { display: block; }
  /* 渠道状态胶囊：融进标题行；点击进设置页 */
  .chanpill { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; padding: 2px 9px; border-radius: 999px; border: none; cursor: pointer; font-family: inherit; color: var(--vscode-descriptionForeground); background: transparent; margin-right: 4px; }
  .chanpill .d { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .chanpill.ok { color: var(--vscode-charts-green); background: color-mix(in srgb, var(--vscode-charts-green) 12%, transparent); }
  .chanpill.warn { color: var(--vscode-charts-yellow); background: color-mix(in srgb, var(--vscode-charts-yellow) 14%, transparent); }
  .chanpill.bad { color: var(--vscode-charts-red); background: color-mix(in srgb, var(--vscode-charts-red) 12%, transparent); }
  .chanpill:hover { filter: brightness(1.15); }
  /* 渠道总开关：26x14 胶囊，状态色和渠道胶囊一致（绿=开、黄=启动中/未验证、红描边=失败）。 */
  .chsw { position: relative; width: 26px; height: 14px; flex-shrink: 0; padding: 0; border-radius: 999px; cursor: pointer; border: 1px solid var(--vscode-checkbox-border, var(--vscode-panel-border)); background: color-mix(in srgb, var(--vscode-descriptionForeground) 22%, transparent); transition: background .15s, border-color .15s; }
  .chsw::after { content: ''; position: absolute; top: 1px; left: 1px; width: 10px; height: 10px; border-radius: 50%; background: var(--vscode-foreground); opacity: .8; transition: transform .15s; }
  .chsw[aria-checked="true"]::after { transform: translateX(12px); background: #fff; opacity: 1; }
  .chsw[data-state="on"] { background: var(--vscode-charts-green); border-color: transparent; }
  .chsw[data-state="warn"], .chsw[data-state="starting"] { background: var(--vscode-charts-yellow); border-color: transparent; }
  .chsw[data-state="starting"]::after { animation: bhPulse 1s ease-in-out infinite; }
  .chsw[data-state="error"] { border-color: var(--vscode-charts-red); }
  .chsw:disabled { cursor: progress; }
  .chsw:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  /* B / focused welcome. The session list is a four-column grid owned by Handoff. */
  #list[data-mode="sessions"] > .bh-onboard { grid-column: 1 / -1; min-width: 0; }
  .bh-onboard, .bh-onboard * { box-sizing: border-box; }
  .bh-onboard { width: 100%; padding: 30px 24px 26px; color: var(--vscode-foreground); text-align: center; }
  .bh-onboard-body { width: 100%; max-width: 320px; margin: 0 auto; }
  .bh-onboard-progress { display: flex; align-items: center; justify-content: center; list-style: none; padding: 0; margin: 0 0 30px; font-size: 11px; color: var(--vscode-descriptionForeground); }
  .bh-onboard-progress li { display: flex; align-items: center; gap: 6px; white-space: nowrap; }
  .bh-onboard-progress li:not(:last-child)::after { content: ''; width: 16px; height: 1px; background: var(--vscode-panel-border); margin: 0 9px; }
  .bh-onboard-progress .num { font-family: var(--vscode-editor-font-family); }
  .bh-onboard-progress .current { color: var(--vscode-foreground); }
  .bh-onboard-progress .current .num { color: var(--vscode-textLink-foreground); }
  .bh-onboard-progress .done .num { color: var(--vscode-charts-green); }
  .bh-onboard-mark { display: block; width: 37px; height: 37px; margin: 0 auto 23px; background: var(--vscode-foreground); mask: url('${brandIcon}') center / contain no-repeat; }
  .bh-onboard h2 { margin: 0 0 12px; font-size: 21px; font-weight: 500; line-height: 1.4; letter-spacing: -.4px; text-wrap: balance; }
  .bh-onboard p { margin: 0; font-size: 12px; line-height: 1.8; color: var(--vscode-descriptionForeground); overflow-wrap: anywhere; }
  .bh-onboard-actions { display: flex; flex-direction: column; align-items: center; gap: 7px; margin-top: 23px; }
  .bh-onboard button, .bh-onboard summary { font: inherit; font-size: 12px; cursor: pointer; }
  .bh-onboard button { border: 0; border-radius: 4px; line-height: 1.6; }
  .bh-onboard .primary { width: 100%; min-height: 34px; padding: 6px 12px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .bh-onboard .primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  .bh-onboard .primary:disabled { opacity: .7; cursor: progress; }
  .bh-onboard .link { padding: 3px 2px; min-height: 28px; background: transparent; color: var(--vscode-descriptionForeground); }
  .bh-onboard .link:hover { color: var(--vscode-textLink-foreground); text-decoration: underline; }
  .bh-onboard button:focus-visible, .bh-onboard summary:focus-visible, .bh-onboard h2:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: 3px; }
  .bh-onboard-helper { border-top: 1px solid var(--vscode-panel-border); padding-top: 14px; margin-top: 24px; text-align: left; }
  .bh-onboard-helper p { font-size: 11px; }
  .bh-onboard details { margin-top: 15px; min-width: 0; text-align: left; color: var(--vscode-descriptionForeground); }
  .bh-onboard summary { min-height: 26px; line-height: 1.7; font-size: 11px; }
  .bh-onboard details p { font-size: 11px; padding-top: 8px; }
  .bh-onboard details .link { color: var(--vscode-textLink-foreground); font-size: 11px; }
  .bh-onboard pre { white-space: pre-wrap; overflow-wrap: anywhere; font: 11px/1.7 var(--vscode-editor-font-family); color: var(--vscode-descriptionForeground); background: var(--vscode-textCodeBlock-background, var(--vscode-editorWidget-background)); padding: 9px 10px; margin: 8px 0 0; max-height: 160px; overflow-y: auto; }
  .bh-onboard-status { margin-top: 16px; font-size: 11px; line-height: 1.7; color: var(--vscode-descriptionForeground); }
  .bh-onboard-failure { color: var(--vscode-errorForeground); font-size: 11px; margin-bottom: 8px; }
  .bh-onboard[data-state="unverified"] .bh-onboard-failure { color: var(--vscode-descriptionForeground); }
  .bh-onboard-steps { padding: 0; margin: 22px 0 0; list-style: none; display: grid; gap: 10px; text-align: left; font-size: 12px; }
  .bh-onboard-steps li { display: flex; align-items: center; gap: 9px; line-height: 1.7; color: var(--vscode-descriptionForeground); }
  .bh-onboard-steps .mk { width: 12px; height: 12px; flex: none; display: grid; place-items: center; border: 1px solid var(--vscode-panel-border); border-radius: 50%; font-size: 10px; line-height: 1; }
  .bh-onboard-steps .active { color: var(--vscode-foreground); }
  .bh-onboard-steps .active .mk { border-color: var(--vscode-progressBar-background); border-top-color: transparent; animation: bhGuideSpin 1s linear infinite; }
  .bh-onboard-steps .done .mk { border: 0; color: var(--vscode-charts-green); }
  .bh-onboard-steps .failed, .bh-onboard-steps .failed .mk { color: var(--vscode-errorForeground); border-color: var(--vscode-errorForeground); }
  .bh-onboard-facts { padding: 0; margin: 20px 0 0; text-align: left; font-size: 11px; }
  .bh-onboard-facts div { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px; padding: 8px 0; border-top: 1px solid var(--vscode-panel-border); }
  .bh-onboard-facts dd { margin: 0; color: var(--vscode-charts-green); }
  .bh-onboard.is-collapsed { padding: 10px 14px; border-bottom: 1px solid var(--vscode-panel-border); }
  .bh-onboard-resume { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 11px; color: var(--vscode-descriptionForeground); }
  .bh-onboard-resume .link { color: var(--vscode-textLink-foreground); white-space: nowrap; }
  .bh-onboard [hidden] { display: none !important; }
  .hdr .ttl { min-width: 0; white-space: nowrap; }
  .hdr .ib { flex-shrink: 0; }
  .chanpill { min-width: 0; overflow: hidden; }
  .chanpill .d { flex-shrink: 0; }
  #chtxt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hdr[data-onboarding="true"] #create, .hdr[data-onboarding="true"] #webagent, .hdr[data-onboarding="true"] #chsw { display: none; }
  @keyframes bhGuideSpin { to { transform: rotate(360deg); } }
  @media (max-width: 280px) {
    .bh-onboard { padding: 24px 18px; }
    .bh-onboard-progress li:not(:last-child)::after { width: 12px; margin-inline: 7px; }
    .hdr { gap: 4px; padding-inline: 8px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .chsw, .chsw::after { transition: none; }
    .chsw[data-state="starting"]::after, .bh-onboard-steps .active .mk { animation: none; }
  }
  .err { color: var(--vscode-errorForeground); font-size: 11px; padding: 6px 12px 0; overflow-wrap: anywhere; }
  #cherr { box-sizing: border-box; margin: 8px 10px 0; padding: 7px 9px; border: 1px solid color-mix(in srgb, var(--vscode-errorForeground) 28%, transparent); border-radius: 5px; background: color-mix(in srgb, var(--vscode-errorForeground) 7%, transparent); line-height: 1.4; }
  /* 会话行：账本式 —— 全宽、发丝线分隔、更密 */
  .row { display: flex; align-items: center; gap: 6px; min-height: 30px; padding: 3px 10px; cursor: pointer; border-bottom: 1px solid color-mix(in srgb, var(--vscode-foreground) 9%, transparent); }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .row.dragging { opacity: .45; }
  .row.drag-before { box-shadow: inset 0 2px 0 var(--vscode-focusBorder); }
  .row.drag-after { box-shadow: inset 0 -2px 0 var(--vscode-focusBorder); }
  .drag { width: 18px; align-self: stretch; display: grid; place-items: center; flex-shrink: 0; cursor: grab; color: var(--vscode-descriptionForeground); opacity: .48; }
  .row:hover .drag { opacity: .9; }
  .drag:active { cursor: grabbing; }
  .drag::before { content: '⠿'; font-size: 15px; line-height: 1; }
  .row .main { flex: 1; min-width: 0; }
  .row .name { font-weight: 600; font-size: 12.5px; display: flex; align-items: center; gap: 6px; min-width: 0; }
  .row .name .txt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row .cur { font-size: 10px; color: var(--vscode-charts-blue); border: 1px solid color-mix(in srgb, var(--vscode-charts-blue) 45%, transparent); border-radius: 999px; padding: 0 6px; flex-shrink: 0; }
  .row .sub { font-size: 10.5px; color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .st { font-size: 11px; white-space: nowrap; flex-shrink: 0; }
  .st.active { color: var(--vscode-charts-green); }
  .st.paused { color: var(--vscode-charts-yellow); }
  .st.await { color: var(--vscode-charts-yellow); font-weight: 600; }
  .st.dim { color: var(--vscode-descriptionForeground); }
  .st.run { color: var(--vscode-charts-blue); }
  .last-tool-age { margin-left: 5px; color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family); font-variant-numeric: tabular-nums; font-weight: 400; }
  .ract { width: 22px; height: 22px; display: grid; place-items: center; border: none; border-radius: 6px; background: transparent; color: var(--vscode-icon-foreground); cursor: pointer; padding: 0; flex-shrink: 0; }
  .ract svg { display: block; }
  .row .ract { opacity: 0; }
  .row:hover .ract { opacity: 1; }
  .row .ract:hover { background: var(--vscode-toolbar-hoverBackground); }
  .empty { opacity: .65; padding: 16px 12px; line-height: 1.8; }
  .draft { padding: 28px 16px; display: flex; flex-direction: column; align-items: center; gap: 10px; text-align: center; }
  .draft .dt { font-weight: 600; }
  .draft .dd { opacity: .7; line-height: 1.6; max-width: 34em; }
  .draft .row { display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; }
  .draft button { font-family: inherit; font-size: 12px; padding: 4px 12px; border-radius: 4px; cursor: pointer; border: 1px solid var(--vscode-button-border, transparent); color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  .draft button.pri { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  .draft button:disabled { opacity: .5; cursor: default; }
  .empty button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: none; border-radius: 4px; padding: 3px 10px; cursor: pointer; font-family: inherit; }
  /* 调用卡片（静谧工作台：抬升面、无边界） */
  /* 视口外卡片跳过渲染与布局：列表变长时收益递增。contain-intrinsic-size 提供未渲染时的占位高度，auto 记住真实高度以避免滚动跳动。卡片内无溢出定位元素（#tip/#abar/#ctx 均为 fixed 挂在 body 层），containment 无副作用。 */
  /* 时间线边界：连续的工具调用读作一条通栏「工具带」（浅底 + 左侧细轨），
     回复是内缩的卡片（.msg.agent 有边框）——两类内容不再糊在一起。 */
  .call { margin: 0 16px; border-radius: 6px; background: color-mix(in srgb, var(--vscode-foreground) 3.5%, transparent); box-shadow: inset 2px 0 0 color-mix(in srgb, var(--vscode-foreground) 16%, transparent); overflow: hidden; content-visibility: auto; contain-intrinsic-size: auto 28px; }
  .call + .call { margin-top: 4px; }
  .call.open { background: color-mix(in srgb, var(--vscode-foreground) 7%, transparent); margin-bottom: 2px; }
  /* 新调用入场：只在列表已有卡片时播放（见 renderCalls 的 hadCards），切会话/翻页的整批重建不放动画，避免整屏抖动 */
  @keyframes bhCardIn { from { opacity: 0; transform: translateY(-8px) scale(.98); } }
  .call.enter { animation: bhCardIn .3s cubic-bezier(.22, 1, .36, 1); }
  @media (prefers-reduced-motion: reduce) { .call.enter { animation: none; } }
  .call-hd { display: flex; align-items: center; gap: 7px; padding: 2px 10px; min-height: 22px; box-sizing: border-box; cursor: pointer; opacity: .8; }
  .call-hd:hover, .call.open .call-hd { opacity: 1; background: color-mix(in srgb, var(--vscode-foreground) 6%, transparent); }
  .call-hd:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -2px; }
  /* Codex 式状态符号：颜色 + 符号，文字在 aria-label/title 里 */
  .call .bullet { flex: none; width: 12px; text-align: center; font-family: var(--vscode-editor-font-family); font-size: 10px; color: var(--vscode-descriptionForeground); }
  .call .bullet.completed { color: var(--vscode-charts-green); }
  .call .bullet.started { color: var(--vscode-charts-blue); animation: bhPulse 1.6s ease-in-out infinite; }
  .call .bullet.awaiting { color: var(--vscode-charts-yellow); }
  .call .bullet.failed, .call .bullet.denied { color: var(--vscode-charts-red); }
  @media (prefers-reduced-motion: reduce) { .call .bullet.started { animation: none; } }
  /* 工具名退成标签，动宾短语（c.summary）才是主体 */
  .call .tool { font-family: var(--vscode-editor-font-family); font-size: 11px; font-weight: 500; color: var(--vscode-descriptionForeground); flex-shrink: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .call .sum, .call .resource-wrap { flex: 1 1 0; min-width: 0; font-family: var(--vscode-editor-font-family); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .call .sum { color: var(--vscode-descriptionForeground); }
  .call .resource-wrap { display: none; align-items: baseline; gap: 4px; color: var(--vscode-descriptionForeground); }
  .call .resource-kind { flex: none; }
  .call .resource { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0 0 0 4px; border: 0; border-left: 1px solid var(--vscode-widget-border); background: transparent; color: var(--vscode-textLink-foreground); text-align: left; cursor: pointer; }
  .call .resource:hover { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
  .call .resource:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; border-radius: 3px; }
  .call .meta { font-size: 10px; color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family); white-space: nowrap; flex-shrink: 0; opacity: .85; }
  .call .scope { color: var(--vscode-charts-green); font-size: 10px; font-weight: 600; flex-shrink: 0; }
  .badge { border: 0; border-radius: 999px; padding: 0 6px; font-family: inherit; font-size: 10px; font-weight: 600; flex-shrink: 0; }
  .badge:empty { display: none; }
  .call .badge.completed { background: transparent; padding: 0; opacity: .75; }
  .badge.completed { color: var(--vscode-charts-green); background: color-mix(in srgb, var(--vscode-charts-green) 14%, transparent); }
  .badge.started { color: var(--vscode-charts-yellow); background: color-mix(in srgb, var(--vscode-charts-yellow) 16%, transparent); }
  .badge.awaiting { color: #1f1f1f; background: var(--vscode-charts-yellow); }
  .badge.failed { color: var(--vscode-charts-red); background: color-mix(in srgb, var(--vscode-charts-red) 14%, transparent); }
  .badge.denied { color: var(--vscode-charts-red); opacity: .8; background: transparent; }
  .badge.unknown { color: var(--vscode-charts-orange); background: color-mix(in srgb, var(--vscode-charts-orange) 14%, transparent); }
  /* 改动统计跟着它描述的文件走：Added path (+N -M) */
  .diff { font-family: var(--vscode-editor-font-family); font-size: 10px; font-weight: 650; flex-shrink: 0; color: var(--vscode-descriptionForeground); }
  .diff .add { color: var(--vscode-charts-green); margin-right: 3px; }
  .diff .del { color: var(--vscode-charts-red); }
  /* 调用参数悬浮提示：单例浮层，替代原生 title（即时弹出、主题一致、可格式化） */
  #tip { position: fixed; z-index: 20; display: none; max-width: min(480px, calc(100vw - 16px)); max-height: min(320px, 60vh); overflow: auto; padding: 8px 11px; border-radius: 8px; font-family: var(--vscode-editor-font-family); font-size: 11px; line-height: 1.55; white-space: pre-wrap; word-break: break-all; color: var(--vscode-foreground); background: var(--vscode-editorHoverWidget-background, var(--vscode-sideBar-background)); border: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-panel-border)); box-shadow: 0 8px 24px rgba(0,0,0,.4); cursor: default; }
  /* 输出挂在调用下面（Codex 的 └ 连接线），并收在「… 还有 N 行」后面 */
  .call .body { position: relative; padding: 3px 10px 8px 29px; display: none; }
  .call.open .body { display: block; }
  .call.open .body::before { content: '└'; position: absolute; left: 13px; top: 4px; font-family: var(--vscode-editor-font-family); font-size: 11px; color: var(--vscode-descriptionForeground); opacity: .6; pointer-events: none; }
  .call .body .more { margin: 3px 0 0; padding: 1px 9px; font-family: var(--vscode-editor-font-family); font-size: 10.5px; color: var(--vscode-descriptionForeground); background: transparent; border: 1px solid color-mix(in srgb, var(--vscode-foreground) 16%, transparent); border-radius: 999px; cursor: pointer; }
  .call .body .more:hover { color: var(--vscode-foreground); }
  /* 极细滚动条（页面级 + 展开卡片 <pre> 两级）：平时半透明 4px，hover 加深——
     存在感最小化，滚动能力不打折；webkit webview 的标准做法 */
  ::-webkit-scrollbar { width: 4px; height: 4px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--vscode-foreground) 18%, transparent); border-radius: 999px; }
  ::-webkit-scrollbar-thumb:hover { background: color-mix(in srgb, var(--vscode-foreground) 38%, transparent); }
  ::-webkit-scrollbar-corner { background: transparent; }
  .call pre { background: transparent; padding: 2px 0 0; white-space: pre-wrap; word-break: break-all; max-height: 260px; overflow: auto; font-size: 11.5px; line-height: 1.6; margin: 0; }
  /* proxy 调用的行内取消按钮：视觉与审批卡的「拒绝」一致（红描边幽灵按钮） */
  .call .cx { font-family: inherit; font-size: 10px; padding: 2px 9px; border-radius: 5px; cursor: pointer; flex-shrink: 0; color: var(--vscode-charts-red); background: transparent; border: 1px solid color-mix(in srgb, var(--vscode-charts-red) 40%, transparent); }
  .call .cx:hover { background: color-mix(in srgb, var(--vscode-charts-red) 12%, transparent); }
  /* 审批终稿：队列式悬浮详情卡（overlay，不顶开列表）。设计稿见
     _temp/design-demos/scrollbar-approval.html */
  #abar { position: fixed; left: 8px; right: 8px; bottom: 8px; z-index: 9; display: none; max-height: 72%; border-radius: 10px; background: var(--vscode-sideBar-background); border: 1px solid color-mix(in srgb, var(--vscode-editorWarning-foreground, #caa20a) 50%, transparent); box-shadow: 0 12px 36px rgba(0,0,0,.5); }
  #abar.has { display: block; }
  .apq .aphead { display: flex; align-items: center; gap: 7px; padding: 8px 12px; font-size: 11.5px; font-weight: 650; color: var(--vscode-editorWarning-foreground, #caa20a); background: var(--vscode-inputValidation-warningBackground, rgba(122,91,0,.18)); border-bottom: 1px solid color-mix(in srgb, var(--vscode-editorWarning-foreground, #caa20a) 45%, transparent); }
  .apq .adot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; animation: appulse 1.8s ease-in-out infinite; flex-shrink: 0; }
  @keyframes appulse { 50% { opacity: .35; } }
  .apq .sp { flex: 1; }
  .apq .acnt { font-family: var(--vscode-editor-font-family); font-size: 10px; padding: 1px 7px; border-radius: 999px; background: var(--vscode-editorWarning-foreground, #caa20a); color: #1f1f1f; }
  .apq .srcrow { display: flex; align-items: center; gap: 6px; padding: 10px 12px 0; font-size: 11px; color: var(--vscode-descriptionForeground); }
  .apq .srcrow .nm { font-weight: 650; color: var(--vscode-foreground); }
  .apq .srcrow .go { color: var(--vscode-charts-blue); cursor: pointer; font-size: 10.5px; margin-left: auto; }
  .apq .srcrow .go:hover { text-decoration: underline; }
  /* 风险标签-命中同色图例（级别派生）：红=critical 不可逆 / 黄=warn 影响大 / 蓝=info 常规变更 */
  .apq .riskrow { display: flex; align-items: center; gap: 6px; padding: 8px 12px 0; flex-wrap: wrap; }
  .apq .rchip { font-size: 10px; font-weight: 600; padding: 1px 8px; border-radius: 999px; color: var(--vscode-charts-red); background: color-mix(in srgb, var(--vscode-charts-red) 12%, transparent); border: 1px solid color-mix(in srgb, var(--vscode-charts-red) 32%, transparent); }
  .apq .rchip.warn { color: var(--vscode-editorWarning-foreground, #caa20a); background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #caa20a) 10%, transparent); border-color: color-mix(in srgb, var(--vscode-editorWarning-foreground, #caa20a) 30%, transparent); }
  .apq .rchip.info { color: var(--vscode-charts-blue); background: color-mix(in srgb, var(--vscode-charts-blue) 10%, transparent); border-color: color-mix(in srgb, var(--vscode-charts-blue) 30%, transparent); }
  .apq .acmd { font-family: var(--vscode-editor-font-family); font-size: 11px; margin: 8px 12px 0; padding: 8px 10px; border-radius: 6px; background: color-mix(in srgb, #000 25%, transparent); white-space: pre-wrap; word-break: break-all; line-height: 1.7; max-height: 30vh; overflow-y: auto; }
  .apq .acmd .hit { color: var(--vscode-charts-red); font-weight: 700; background: color-mix(in srgb, var(--vscode-charts-red) 13%, transparent); border-radius: 3px; padding: 0 2px; }
  .apq .acmd .hit.warn { color: var(--vscode-editorWarning-foreground, #caa20a); background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #caa20a) 12%, transparent); }
  .apq .acmd .hit.info { color: var(--vscode-charts-blue); background: color-mix(in srgb, var(--vscode-charts-blue) 12%, transparent); }
  .apq .abtns { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 10px 12px 12px; }
  .apq button { font-size: 11px; padding: 4px 14px; border-radius: 6px; cursor: pointer; border: 1px solid transparent; font-family: inherit; }
  .apq button.ok { color: var(--vscode-button-foreground); background: var(--vscode-button-background); font-weight: 600; }
  .apq button.more { color: var(--vscode-descriptionForeground); background: transparent; border-color: var(--vscode-panel-border); }
  .apq button.more:hover { color: var(--vscode-foreground); }
  .apq button.no { color: var(--vscode-charts-red); background: transparent; border-color: color-mix(in srgb, var(--vscode-charts-red) 40%, transparent); }
  .appr button.view { color: var(--vscode-descriptionForeground); background: transparent; border-color: var(--vscode-panel-border); }
  .appr button.view:hover { color: var(--vscode-foreground); }
  /* 分页 */
  /* 分页器在列表外独立占位，末尾卡片无需额外补偿即可完整滚入视口。 */
  .older { display: flex; justify-content: center; padding: 6px 0 2px; font-size: 11px; color: var(--vscode-descriptionForeground); }
  .older button { font-size: 11px; padding: 2px 10px; cursor: pointer; border: none; border-radius: 6px; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); font-family: inherit; }
  /* 任务清单（V2F 浮层版）：头部常驻，展开浮层悬在调用卡上方 */
  #tasks { position: relative; flex-shrink: 0; z-index: 8; margin: 0 0 2px; padding: 4px 10px 2px; background: var(--vscode-sideBar-background); }
  #tasks .t2f { position: relative; }
  #tasks .hd { display: flex; align-items: baseline; gap: 8px; padding: 6px 8px; margin: 0 -8px; border-radius: 6px; cursor: pointer; }
  #tasks .hd:hover { background: var(--vscode-toolbar-hoverBackground); }
  #tasks .hd .sp { flex: 1; }
  #tasks .t-name { font-size: 11.5px; font-weight: 650; }
  #tasks .num { font-family: var(--vscode-editor-font-family); font-size: 11.5px; font-weight: 700; color: var(--vscode-charts-blue); transition: color .5s ease; }
  #tasks .num.all { color: var(--vscode-charts-green); }
  #tasks .sub { font-size: 10px; color: var(--vscode-descriptionForeground); white-space: nowrap; }
  #tasks .chev { color: var(--vscode-descriptionForeground); font-size: 10px; transition: transform .15s; }
  #tasks .t2f.open .chev { transform: rotate(180deg); }
  #tasks .bar { height: 2px; border-radius: 999px; background: color-mix(in srgb, var(--vscode-foreground) 9%, transparent); overflow: hidden; position: relative; }
  #tasks .bar i { display: block; height: 100%; width: 0; border-radius: 999px; transition: width .55s cubic-bezier(.22, 1, .36, 1), background-color .5s ease; background: linear-gradient(90deg, var(--vscode-charts-blue) 0%, color-mix(in srgb, var(--vscode-charts-blue) 45%, #fff) 50%, var(--vscode-charts-blue) 100%); background-size: 200% 100%; animation: bhFlow 2.2s linear infinite; }
  #tasks .bar i.all { background: var(--vscode-charts-green); animation: none; }
  @keyframes bhFlow { from { background-position: 200% 0; } to { background-position: 0% 0; } }
  #tasks .bar.celebrate::after { content: ''; position: absolute; top: 0; bottom: 0; left: 0; width: 36%; background: linear-gradient(90deg, transparent, rgba(255,255,255,.6), transparent); animation: bhSweep .8s ease-out forwards; }
  @keyframes bhSweep { from { transform: translateX(-110%); } to { transform: translateX(310%); } }
  #tasks .pop { position: absolute; left: 0; right: 0; top: calc(100% + 6px); z-index: 6; background: var(--vscode-sideBar-background); border: 1px solid var(--vscode-panel-border); border-radius: 8px; box-shadow: 0 10px 30px rgba(0,0,0,.45); padding: 4px 10px 8px; }
  #tasks .t2f.closed .pop { display: none; }
  #tasks .t2f.open .pop { animation: bhPop .16s ease-out; }
  @keyframes bhPop { from { opacity: 0; transform: translateY(-5px); } }
  #tasks .items { padding: 1px 0 2px; }
  #tasks .ti { display: flex; align-items: baseline; gap: 8px; padding: 2.5px 0; font-size: 12px; min-width: 0; }
  #tasks .ti .tk { width: 13px; text-align: center; flex-shrink: 0; font-size: 10px; }
  #tasks .ti .tx { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #tasks .ti.goal .tk { color: var(--vscode-charts-blue); }
  #tasks .ti.goal .tx { font-weight: 600; }
  #tasks .ti.pend { color: var(--vscode-descriptionForeground); }
  #tasks .ti.pend .tk { opacity: .7; }
  #tasks .ti.act .tk { color: var(--vscode-charts-blue); animation: bhPulse 1.6s ease-in-out infinite; }
  #tasks .ti.act .tx { font-weight: 600; }
  #tasks .ti.done .tk { color: var(--vscode-charts-green); }
  #tasks .ti.done .tx { color: var(--vscode-descriptionForeground); opacity: .7; text-decoration: line-through; }
  @keyframes bhPulse { 50% { opacity: .3; } }
  @media (prefers-reduced-motion: reduce) {
    #tasks .bar i, #tasks .bar.celebrate::after, #tasks .ti.act .tk, #tasks .t2f.open .pop { animation: none !important; transition: none !important; }
  }
  /* 会话操作菜单（右键 / ⋯） */
  #ctx { position: fixed; z-index: 10; display: none; min-width: 170px; padding: 4px 0; background: var(--vscode-menu-background); border: 1px solid var(--vscode-menu-border); border-radius: 6px; box-shadow: 0 4px 16px rgba(0,0,0,.35); }
  #ctx .item { padding: 5px 14px; font-size: 12px; cursor: pointer; color: var(--vscode-menu-foreground); }
  #ctx .item:hover { background: var(--vscode-menu-selectionBackground); color: var(--vscode-menu-selectionForeground); }
  #ctx .sep { height: 1px; margin: 4px 0; background: var(--vscode-menu-separatorBackground); }
  #ctx .item.danger { color: var(--vscode-errorForeground); }
  #ctx .grp { padding: 4px 14px 2px; font-size: 11px; color: var(--vscode-descriptionForeground); cursor: default; }
  /* Chat: messages in the call timeline + composer docked at the bottom */
  .msg { margin: 12px 12px; font-size: 13px; line-height: 1.55; }
  /* 回复是正文不是卡片：不加框，只留出两侧空白，与通栏工具带区分 */
  .msg.agent { margin: 14px 16px; }
  .msg.user { width: fit-content; max-width: 85%; margin: 24px 12px 32px auto; border: 1px solid color-mix(in srgb, var(--vscode-focusBorder) 40%, transparent); padding: 6px 10px; border-radius: 10px; background: color-mix(in srgb, var(--vscode-focusBorder) 14%, transparent); }
  .msg.user .msg-body { white-space: pre-wrap; word-break: break-word; }
  .msg.user .msg-body.folded { max-height: 200px; overflow: hidden; -webkit-mask-image: linear-gradient(to bottom, #000 70%, transparent); mask-image: linear-gradient(to bottom, #000 70%, transparent); }
  .msg-fold { display: block; margin: 2px 0 0 auto; padding: 2px 0; border: 0; background: none; color: var(--vscode-textLink-foreground); font: inherit; font-size: 11px; cursor: pointer; }
  .msg-fold:hover { text-decoration: underline; }
  .msg-fold:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  .msg-st { display: block; margin-top: 2px; font-size: 11px; }
  .msg-img { display: block; margin-top: 4px; padding: 0; border: 0; background: none; color: var(--vscode-textLink-foreground); font-size: 11px; cursor: pointer; }
  .msg-img:hover { text-decoration: underline; }
  .img-view { position: fixed; inset: 0; z-index: 100; display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 16px; overflow: auto; background: rgba(0, 0, 0, 0.8); outline: none; }
  .img-view img { max-width: 100%; height: auto; border-radius: 6px; }
  .img-gone { margin: auto; color: #fff; font-size: 12px; }
  .msg.user { position: relative; }
  .msg-copy { display: inline-grid; place-items: center; width: 22px; height: 22px; padding: 0; border: 0; border-radius: 5px; background: transparent; color: var(--vscode-descriptionForeground); cursor: pointer; }
  .msg-copy:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
  .msg-copy:focus-visible { outline: 1px solid var(--vscode-focusBorder); opacity: 1; }
  .msg-copy.done { color: var(--vscode-charts-green); }
  .msg-copy.agent-copy { margin-top: 4px; }
  .msg-copy.user-copy { position: absolute; right: 0; top: 100%; margin-top: 2px; opacity: 0; }
  .msg.user:hover .msg-copy.user-copy { opacity: 1; }
  .msg-st.failed { color: var(--vscode-errorForeground); }
  .msg-st.unconfirmed { color: var(--vscode-editorWarning-foreground); }
  .msg-head { display: flex; gap: 8px; align-items: baseline; color: var(--vscode-descriptionForeground); font-size: 11px; margin-bottom: 2px; }
  .msg-head .who { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .md { word-break: break-word; }
  .md > :first-child { margin-top: 0; }
  .md > :last-child { margin-bottom: 0; }
  .md p, .md ul, .md ol, .md pre, .md table, .md blockquote { margin: 0 0 8px; }
  .md h1, .md h2, .md h3, .md h4, .md h5, .md h6 { margin: 12px 0 6px; line-height: 1.3; font-weight: 600; }
  .md h1 { font-size: 1.3em; } .md h2 { font-size: 1.18em; } .md h3 { font-size: 1.06em; } .md h4, .md h5, .md h6 { font-size: 1em; }
  .md ul, .md ol { padding-left: 20px; }
  .md li + li { margin-top: 2px; }
  .md code { font-family: var(--vscode-editor-font-family); font-size: .92em; padding: 1px 4px; border-radius: 3px; background: var(--vscode-textCodeBlock-background); }
  .md pre { padding: 8px 10px; border-radius: 6px; overflow-x: auto; background: var(--vscode-textCodeBlock-background); }
  .md pre code { padding: 0; background: none; font-size: 12px; white-space: pre; }
  div.md-code { position: relative; margin: 0 0 8px; }
  div.md-code:last-child { margin-bottom: 0; }
  div.md-code > pre { margin: 0; padding-right: 32px; }
  .md-copy { position: absolute; top: 3px; right: 3px; display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; padding: 0; border: 1px solid transparent; border-radius: 4px; background: transparent; color: var(--vscode-descriptionForeground); cursor: pointer; }
  .md-copy:hover, .md-copy:focus-visible { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
  .md-copy:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
  .md-copy.done { color: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); }
  .md-diagram { overflow-x: auto; padding: 6px 30px 6px 6px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; }
  .md-diagram svg { display: block; max-width: 100%; height: auto; margin: 0 auto; }
  div.md-mermaid[data-mm="ok"] > pre { display: none; }
  .md-diagram { cursor: zoom-in; }
  .md-diagram:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
  .mm-zoom { position: fixed; inset: 0; z-index: 1000; display: flex; flex-direction: column; background: var(--vscode-sideBar-background, var(--vscode-editor-background)); outline: none; }
  .mm-zoom-bar { display: flex; justify-content: flex-end; gap: 4px; padding: 4px 6px; border-bottom: 1px solid var(--vscode-panel-border); }
  .mm-zoom-bar button { min-width: 28px; height: 24px; padding: 0 6px; border: 1px solid var(--vscode-panel-border); border-radius: 4px; background: transparent; color: var(--vscode-foreground); font: inherit; font-variant-numeric: tabular-nums; cursor: pointer; }
  .mm-zoom-bar button:hover { background: var(--vscode-toolbar-hoverBackground); }
  .mm-zoom-bar button:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
  .mm-zoom-stage { position: relative; flex: 1; overflow: hidden; touch-action: none; cursor: grab; }
  .mm-zoom-stage:active { cursor: grabbing; }
  .mm-zoom-pic { position: absolute; top: 0; left: 0; transform-origin: 0 0; user-select: none; }
  .mm-zoom-pic svg { display: block; max-width: none; }
  .md blockquote { padding-left: 10px; border-left: 3px solid var(--vscode-textBlockQuote-border, var(--vscode-panel-border)); color: var(--vscode-descriptionForeground); }
  .md table { border-collapse: collapse; display: block; overflow-x: auto; font-size: 12px; }
  .md th, .md td { border: 1px solid var(--vscode-panel-border); padding: 3px 8px; text-align: left; }
  .md hr { border: 0; border-top: 1px solid var(--vscode-panel-border); margin: 10px 0; }
  .md a { color: var(--vscode-textLink-foreground); }
  .msg.streaming .md > :last-child::after { content: ''; display: inline-block; width: 7px; height: 1em; margin-left: 2px; vertical-align: text-bottom; background: currentColor; opacity: .6; animation: bhCaret 1s steps(1) infinite; }
  @keyframes bhCaret { 50% { opacity: 0; } }
  @media (prefers-reduced-motion: reduce) { .msg.streaming .md > :last-child::after { animation: none; } }
  /* 附加信息区在分隔线之上：提问 → 提示 → 来源/模型/发送状态；分隔线之下只剩输入条 */
  .cmp { flex-shrink: 0; padding: 0; background: var(--vscode-sideBar-background); }
  .cmp-extra { padding: 4px 10px; }
  .cmp-box { padding: 6px 10px 8px; border-top: 1px solid var(--vscode-panel-border); }
  .cmp-head { display: flex; align-items: center; gap: 6px; min-height: 20px; font-size: 11px; color: var(--vscode-descriptionForeground); }
  .cmp-head .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-foreground); }
  /* 紧凑选择器：一段文字 + 小箭头，点开是向上弹出的菜单（原生 select 的弹层没法设计，也太宽） */
  .pick { position: relative; flex: none; display: inline-flex; }
  .pick-btn { display: inline-flex; align-items: center; gap: 5px; height: 20px; max-width: 180px; padding: 0 6px; margin-left: -6px; font: inherit; font-size: 11px; font-weight: 600; color: var(--vscode-foreground); background: transparent; border: 0; border-radius: 4px; cursor: pointer; }
  .pick-btn span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pick-btn::after { content: ''; flex: none; width: 4px; height: 4px; margin-top: -2px; border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor; transform: rotate(45deg); opacity: .7; }
  .pick-btn:hover, .pick.open .pick-btn { background: var(--vscode-toolbar-hoverBackground, rgba(127,127,127,.15)); }
  .pick-btn:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 0; }
  .pick-btn:disabled { opacity: .5; cursor: default; }
  .pick-menu { position: absolute; left: -6px; bottom: calc(100% + 4px); z-index: 20; min-width: 168px; max-width: 260px; padding: 4px; margin: 0; list-style: none; color: var(--vscode-menu-foreground, var(--vscode-foreground)); background: var(--vscode-menu-background, var(--vscode-dropdown-background)); border: 1px solid var(--vscode-menu-border, var(--vscode-widget-border, var(--vscode-panel-border))); border-radius: 6px; box-shadow: 0 4px 16px var(--vscode-widget-shadow, rgba(0,0,0,.36)); }
  .pick-menu[hidden] { display: none; }
  .pick-item { display: grid; grid-template-columns: 14px 1fr auto; align-items: center; gap: 6px; height: 24px; padding: 0 8px 0 4px; border-radius: 4px; font-size: 12px; cursor: pointer; white-space: nowrap; }
  .pick-item .ck { text-align: center; font-size: 11px; opacity: 0; }
  .pick-item[aria-selected="true"] .ck { opacity: 1; }
  .pick-item .lb { overflow: hidden; text-overflow: ellipsis; }
  .pick-item .tg { font-size: 10px; color: var(--vscode-descriptionForeground); }
  .pick-item.act { background: var(--vscode-menu-selectionBackground, var(--vscode-list-activeSelectionBackground)); color: var(--vscode-menu-selectionForeground, var(--vscode-list-activeSelectionForeground)); }
  .pick-item.act .tg { color: inherit; opacity: .8; }
  .cmp-head .pill { flex: none; display: inline-flex; align-items: center; gap: 4px; }
  /* 模型信息属于 Composer（当前网页 AI 的模型），不再写进会话消息里 */
  .cmp-head .model { flex: none; max-width: 46%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0 6px; border-radius: 999px; font-size: 10px; color: var(--vscode-descriptionForeground); background: color-mix(in srgb, var(--vscode-foreground) 10%, transparent); }
  .cmp-head .pill::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .cmp-head .pill.ok { color: var(--vscode-testing-iconPassed, #3fb950); }
  .cmp-head .pill.warn { color: var(--vscode-editorWarning-foreground); }
  .cmp-head .pill.bad { color: var(--vscode-errorForeground); }
  /* 发送中：呼吸的点，不看文字也能读出「正在发」 */
  .cmp-head .pill.sending { color: var(--vscode-editorWarning-foreground); }
  .cmp-head .pill.sending::before { animation: bhPulse 1.6s ease-in-out infinite; }
  @media (prefers-reduced-motion: reduce) { .cmp-head .pill.sending::before { animation: none; } }
  /* 传统聊天输入条：一个带边框的输入域，发送按钮在域内垂直居中（不压最后一行的字） */
  .cmp-field { position: relative; }
  .cmp-field textarea { display: block; width: 100%; box-sizing: border-box; resize: none; min-height: 34px; max-height: 160px; font: inherit; font-size: 12px; line-height: 1.45; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 8px; padding: 6px 32px 6px 8px; }
  .cmp-field textarea:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; border-color: var(--vscode-focusBorder); }
  .cmp-field button { position: absolute; top: 50%; right: 6px; transform: translateY(-50%); width: 24px; height: 24px; display: grid; place-items: center; padding: 0; border: 0; border-radius: 6px; font-size: 13px; line-height: 1; color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; }
  .cmp-field button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  .cmp-field button:disabled { opacity: .45; cursor: default; }
  .cmp-field button:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
  /* 生成中：发送键的位置换成停止键（同一槽位，输入条不动） */
  .cmp-field button.stop { background: var(--vscode-inputValidation-errorBorder, #b3261e); color: #fff; }
  /* 提问（等回答）是这一带唯一成框的块：卡片 + 选项按钮 */
  .qcard { margin-bottom: 6px; border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 8px; overflow: hidden; background: color-mix(in srgb, var(--vscode-foreground) 5%, var(--vscode-sideBar-background)); box-shadow: 0 1px 3px rgba(0, 0, 0, .18); }
  .qcard .q-head { display: flex; align-items: flex-start; gap: 8px; padding: 8px 10px; border-bottom: 1px solid var(--vscode-panel-border); }
  .qcard .q-title { flex: 1; min-width: 0; font-size: 12px; line-height: 1.45; }
  .qcard .q-skip { flex: none; font: inherit; font-size: 11px; padding: 1px 8px; border-radius: 4px; border: 1px solid var(--vscode-panel-border); background: transparent; color: var(--vscode-textLink-foreground); cursor: pointer; }
  .qcard .q-opt { display: flex; width: 100%; align-items: center; gap: 8px; padding: 7px 10px; border: 0; border-bottom: 1px solid var(--vscode-panel-border); background: transparent; color: inherit; font: inherit; font-size: 12px; text-align: left; cursor: pointer; }
  .qcard .q-opt:last-of-type { border-bottom: 0; }
  .qcard .q-opt:hover, .qcard .q-opt:focus-visible { background: var(--vscode-list-hoverBackground); outline: none; }
  .qcard .q-opt .q-n { flex: none; width: 16px; height: 16px; border-radius: 50%; border: 1px solid var(--vscode-descriptionForeground); font-size: 10px; line-height: 14px; text-align: center; color: var(--vscode-descriptionForeground); }
  .qcard .q-opt:hover .q-n { border-color: var(--vscode-focusBorder); color: var(--vscode-focusBorder); }
  .qcard .q-hint { padding: 5px 10px; font-size: 11px; color: var(--vscode-descriptionForeground); border-top: 1px solid var(--vscode-panel-border); }
  .qcard button:disabled { opacity: .5; cursor: default; }
  /* 备注是输入框上方的一条提示带：输入框永远是这个 composer 的最后一行 */
  .cmp-note { font-size: 11px; margin: 0 0 5px; padding: 4px 8px; border-radius: 6px; color: var(--vscode-descriptionForeground); background: color-mix(in srgb, var(--vscode-foreground) 7%, transparent); }
  .cmp-note:empty { display: none; }
  .cmp-note.ok { color: var(--vscode-testing-iconPassed, #3fb950); background: color-mix(in srgb, var(--vscode-testing-iconPassed, #3fb950) 13%, transparent); }
  .cmp-note.warn { color: var(--vscode-editorWarning-foreground); background: color-mix(in srgb, var(--vscode-editorWarning-foreground) 13%, transparent); }
  .cmp-note.bad { color: var(--vscode-errorForeground); background: color-mix(in srgb, var(--vscode-errorForeground) 13%, transparent); }
  ${handoffStyles}
</style>
</head>
<body>
  <div id="layout">
    <div class="hdr" id="hdr"></div>
    <div class="err" id="err" style="display:none"></div>
    <div class="err" id="cherr" style="display:none"></div>
    ${handoffMarkup}
    <div id="tasks" style="display:none"></div>
    <div class="list-wrap">
      <div class="list" id="list"></div>
      <button class="jump" id="jump" type="button" title="回到底部" aria-label="回到底部" style="display:none">↓</button>
    </div>
    <div class="cmp" id="composer" style="display:none">
      <div class="cmp-extra">
        <div class="qcard" id="qcard" role="group" style="display:none"></div>
        <div class="cmp-note" id="cmpNote"></div>
        <div class="cmp-head" id="cmpHead"></div>
      </div>
      <div class="cmp-box" id="cmpBox">
        <div class="cmp-field">
          <textarea id="cmpInput" rows="2" placeholder="输入消息，Enter 发送，Shift+Enter 换行" aria-label="发送到网页会话"></textarea>
          <button id="cmpSend" title="发送（Enter）" aria-label="发送">↑</button>
          <button id="cmpStop" class="stop" title="停止生成（点网页自己的停止按钮）" aria-label="停止生成" style="display:none">■</button>
        </div>
      </div>
    </div>
  </div>
  <div id="abar"></div>
  <div id="ctx"></div>
  <script nonce="${nonce}">
    const vs = acquireVsCodeApi();
    ${handoffScript}
    const handoffView = mountHandoffView(document, message => vs.postMessage(message));
    const $ = (id) => document.getElementById(id);
    const IC = ${sidebarIcons()};
    let cur = { mode: 'sessions', selected: null };

    function esc(s) { return (s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
    // Lifecycle/approval take precedence; activity comes from the daemon, never the tunnel.
    function sessionStatus(s, d, showLastToolAge = false) {
      const cnt = (d.pending || []).filter((p) => p.session_id === s.id).length;
      if (s.draft) return '<span class="st dim">◌ 待 AI 首次调用</span>';
      if (s.status === 'paused') return '<span class="st paused">◐ 已暂停</span>';
      if (cnt > 0) return '<span class="st await">● 待审批' + (cnt > 1 ? ' ×' + cnt : '') + '</span>';
      if (s.status !== 'active') return '<span class="st dim">' + esc(s.status) + '</span>';
      if (s.activity === 'running') return '<span class="st active">● 运行中' + (showLastToolAge ? '<span class="last-tool-age" id="lastToolAge"></span>' : '') + '</span>';
      if (s.activity === 'idle') return '<span class="st dim">◌ 空闲</span>';
      return '<span class="st dim">◌ 状态未知</span>';
    }

    // Session list: one status at the end of the row, most urgent first, color + text; idle shows
    // nothing. 待审批 / 待回答 need you, 生成中 / 运行中 are working, the rest is quiet progress.
    function rowStatus(s, d) {
      const cnt = (d.pending || []).filter((p) => p.session_id === s.id).length;
      const web = d.web || { busy: [], asking: [] };
      const st = (cls, text, title) => '<span class="st ' + cls + '"' + (title ? ' title="' + title + '"' : '') + '>' + text + '</span>';
      if (s.draft) return st('dim', '待首次调用');
      if (cnt > 0) return st('await', cnt + ' 待审批');
      if (web.asking.includes(s.id)) return st('await', '待回答', '网页 AI 发来了提问');
      if (web.busy.includes(s.id)) return st('run', '生成中', '网页 AI 正在回复');
      if (s.status === 'active' && s.activity === 'running') return st('run', '运行中', '正在调用工具');
      if (s.todos_total > 0 && s.todos_done < s.todos_total) return st('dim', s.todos_done + '/' + s.todos_total, 'Todo 进度');
      if (s.pending_handoff) return st('dim', 'Handoff', '有待接手的 Handoff');
      if (s.status === 'paused') return st('dim', '已暂停');
      return '';
    }

    function fmtAge(ms) {
      const sec = Math.max(0, Math.floor(ms / 1000));
      if (sec < 60) return sec + 's';
      const min = Math.floor(sec / 60), rem = sec % 60;
      if (min < 60) return min + 'm ' + String(rem).padStart(2, '0') + 's';
      const hour = Math.floor(min / 60), minRem = min % 60;
      return hour + 'h ' + String(minRem).padStart(2, '0') + 'm';
    }

    let lastToolActivityAt = 0;
    function renderLastToolAge(now = Date.now()) {
      const node = $('lastToolAge');
      if (!node) return;
      node.textContent = lastToolActivityAt > 0 ? '· ' + fmtAge(now - lastToolActivityAt) : '';
    }

    function renderHeader(d) {
      const hdr = $('hdr');
      $('cherr').style.display = 'none';
      if (d.mode === 'calls') {
        const s = d.selected;
        const name = s ? (s.name || (s.workspace_path.split(/[\\\\/]/).pop() || s.workspace_path)) : '';
        hdr.innerHTML = '<button class="ib" id="back" title="返回会话列表">←</button>'
          + '<span class="ttl small">' + esc(name) + '</span>'
          + (s ? sessionStatus(s, d, true) : '')
          + '<span class="sp"></span>'
          + '<button class="ib" id="menu" title="会话操作">' + IC.more + '</button>';
        $('back').addEventListener('click', () => vs.postMessage({ type: 'back' }));
        // The page-level click-to-dismiss listener (bottom of this script) also
        // sees this click as it bubbles to document and would hide the menu in
        // the same tick — the button would look dead. Stop it at the opener.
        // (Session rows use contextmenu, which emits no click, hence only this
        // button was affected.)
        $('menu').addEventListener('click', (e) => {
          e.stopPropagation();
          openMenu(e.clientX, e.clientY, true);
        });
        return;
      }
      hdr.innerHTML = '<span class="ttl">BlackHole</span>'
        + '<button class="chsw" id="chsw" role="switch" aria-checked="false" aria-label="公网渠道开关" hidden></button>'
        + '<button class="chanpill" id="chpill" title="渠道：点击打开设置页管理"><span class="d"></span><span id="chtxt">…</span></button>'
        + '<span class="sp"></span>'
        + '<button class="ib" id="create" title="创建会话">' + IC.plus + '</button>'
        + '<button class="ib" id="webagent" title="打开本地 Web">' + IC.globe + '</button>'
        + '<button class="ib" id="settings" title="设置">' + IC.gear + '</button>'
        + '<button class="ib" id="refresh" title="刷新">' + IC.refresh + '</button>';
      $('chpill').addEventListener('click', () => vs.postMessage({ type: 'settings' }));
      // 开关是 button：空格和回车都会触发 click。
      $('chsw').addEventListener('click', () => {
        const sw = $('chsw');
        if (sw.disabled) return;
        const on = sw.getAttribute('aria-checked') !== 'true';
        sw.dataset.state = 'starting'; sw.disabled = true;
        vs.postMessage({ type: 'channelToggle', on });
      });
      $('create').addEventListener('click', () => vs.postMessage({ type: 'create' }));
      $('webagent').addEventListener('click', () => vs.postMessage({ type: 'webAgent' })); // opens the local Web console
      $('settings').addEventListener('click', () => vs.postMessage({ type: 'settings' }));
      $('refresh').addEventListener('click', () => vs.postMessage({ type: 'refresh' }));
    }

    function renderChannel(d) {
      const t = d.tunnel;
      const pill = $('chpill'), cherr = $('cherr');
      if (!pill) return;
      if (cherr) cherr.style.display = 'none';
      let cls = '', label = d.daemon === 'running' ? '渠道未启动' : '未连接';
      // Every running channel in one line (持久 · gpt), whichever mode is selected; same wording as Web channelSummary.
      const cfMap = { online: ['ok', t && t.mode === 'named' ? '持久' : '临时'], unverified: ['warn', (t && t.mode === 'named' ? '持久' : '临时') + '未验证'], starting: ['warn', 'Cloudflare 启动中…'], error: ['bad', 'Cloudflare 失败'], unavailable: ['bad', 'Cloudflare 不可用'] };
      const gpMap = { ready: ['ok', 'gpt'], recovering: ['warn', 'gpt 恢复中'], starting: ['warn', 'gpt 启动中…'], stopping: ['warn', 'gpt 停止中…'], error: ['bad', 'gpt 失败'], unavailable: ['bad', 'gpt 不可用'] };
      const parts = [];
      if (d.daemon === 'running' && t && cfMap[t.status]) parts.push(cfMap[t.status]);
      if (d.daemon === 'running' && d.openai && gpMap[d.openai]) parts.push(gpMap[d.openai]);
      if (parts.length) {
        cls = parts.every((p) => p[0] === parts[0][0]) ? parts[0][0] : 'warn';
        label = parts.map((p) => p[1]).join(' · ');
      }
      const onboarding = onboardingState(d);
      // Missing prerequisites are setup states; only actual failures use error styling.
      if (onboarding === 'login') { cls = ''; label = '待登录'; }
      else if (onboarding === 'setup' || onboarding === 'configure' || onboarding === 'dismissed') { cls = ''; label = '待设置'; }
      else if (onboarding === 'install' || onboarding === 'restart' || onboarding === 'start') { cls = 'warn'; label = '准备中'; }
      else if (onboarding === 'failed') { cls = 'bad'; label = '待重试'; }
      else if (onboarding === 'unverified') { cls = 'warn'; label = '待验证'; }
      pill.className = 'chanpill ' + cls;
      $('chtxt').textContent = label;
      $('hdr').dataset.onboarding = String(!!onboarding && onboarding !== 'dismissed');
      if (!onboarding && cherr && t && t.reason && (t.status === 'starting' || t.status === 'error' || t.status === 'unavailable')) { cherr.style.display = 'block'; cherr.textContent = t.reason; }
      if (!onboarding && cherr && d.channelNote) { cherr.style.display = 'block'; cherr.textContent = d.channelNote; }
      renderSwitch(d);
    }

    const CHANNEL_NAMES = { quick: '临时渠道', named: '持久渠道', openai: 'OpenAI 渠道' };
    // 渠道总开关：旧版 daemon（没有 /channel）、未连接或未登录时不显示。
    function renderSwitch(d) {
      const sw = $('chsw');
      if (!sw) return;
      const c = d.channel;
      sw.hidden = !c || d.daemon !== 'running' || d.account === 'logged_out';
      if (sw.hidden) return;
      const busy = !!(d.channelBusy || d.setup);
      sw.setAttribute('aria-checked', c.on ? 'true' : 'false');
      sw.dataset.state = busy ? 'starting' : c.state;
      sw.disabled = busy || c.state === 'starting';
      sw.title = c.on
        ? '关闭：停止' + c.running.map((x) => CHANNEL_NAMES[x] || x).join('、')
        : '开启：' + (CHANNEL_NAMES[c.next] || c.next) + (c.last ? '（上次使用）' : '')
          + (c.missing === 'cloudflared' ? ' · 需要先安装 cloudflared' : '')
          + (c.state === 'error' && c.reason ? ' · 上次失败：' + c.reason : '');
    }

    // B / focused welcome: presentation only. Account and channel facts still come from the host.
    let signInOpened = false, onboardEngaged = false, onboardNode = null, onboardKey = '';
    const SETUP_STEPS = [['install', '安装并验证 cloudflared'], ['restart', '重启本地服务'], ['start', '启动临时公网渠道']];
    function onboardingState(d) {
      const c = d.channel, s = d.setup, empty = !(d.sessions || []).some(x => !x.draft);
      if (d.daemon === 'running' && d.account === 'logged_out') return 'login';
      // Keep real progress visible while the daemon is restarting.
      if (s) return s.step;
      if (d.daemon !== 'running' || !c) return null;
      const candidate = empty || onboardEngaged || !c.last || c.missing === 'cloudflared';
      if (!candidate) return null;
      if (d.setupDismissed && c.state !== 'on' && !d.channelBusy) return 'dismissed';
      if (d.channelBusy || c.state === 'starting') return 'start';
      if (c.state === 'warn') return 'unverified';
      if (c.on && c.state === 'on') return empty && d.account === 'verified' ? 'ready' : null;
      if ((c.state === 'error' && c.missing !== 'cloudflared') || (onboardEngaged && d.channelNote)) return 'failed';
      if (c.missing && c.missing !== 'cloudflared') return 'configure';
      return 'setup';
    }
    function onboardProgress(state, account) {
      const step = state === 'login' ? 0 : state === 'ready' ? 2 : 1;
      return '<ol class="bh-onboard-progress" aria-label="准备进度">' + ['登录', '连接', '开始'].map((label, i) => {
        const done = i < step && (i !== 0 || account === 'verified');
        return '<li class="' + (done ? 'done' : i === step ? 'current' : '') + '"' + (i === step ? ' aria-current="step"' : '') + '><span class="num">' + (done ? '✓' : '0' + (i + 1)) + '</span>' + label + '</li>';
      }).join('') + '</ol>';
    }
    function onboardSteps(state, failedAt) {
      const at = SETUP_STEPS.findIndex(x => x[0] === (state === 'failed' ? failedAt : state));
      return '<ol class="bh-onboard-steps" aria-label="安装进度">' + SETUP_STEPS.map((x, i) => '<li class="' + (i < at ? 'done' : i === at ? (state === 'failed' ? 'failed' : 'active') : '') + '"' + (i === at ? ' aria-current="step"' : '') + '><span class="mk" aria-hidden="true">' + (i < at ? '✓' : i === at && state === 'failed' ? '!' : '') + '</span>' + x[1] + '</li>').join('') + '</ol>';
    }
    function onboardButton(id, text, disabled = false) {
      return '<button type="button" class="primary" id="' + id + '"' + (disabled ? ' disabled' : '') + '>' + esc(text) + '</button>';
    }
    function onboardOther() {
      return '<details id="guideOther"><summary id="guideOtherToggle">已有通道或其它连接方式</summary><p>也可使用 OpenAI 通道或自定义地址，无需走这条安装流程。</p><button type="button" class="link" id="guideSettings">打开连接设置 →</button></details>';
    }
    function renderOnboarding(d) {
      if (!d.setup && d.channel?.on && d.channel.state === 'on') onboardEngaged = false;
      const state = onboardingState(d), c = d.channel || {}, s = d.setup;
      if (!state) { onboardNode = null; onboardKey = ''; return null; }
      const key = JSON.stringify([state, d.account, c.next, c.running, c.reason, c.missing, s, d.channelNote, d.tunnel?.reason, signInOpened]);
      if (onboardNode && key === onboardKey) return onboardNode;
      const openDetails = onboardNode ? [...onboardNode.querySelectorAll('details[open]')].map(x => x.id) : [];
      const el = document.createElement('section');
      el.className = 'bh-onboard' + (state === 'dismissed' ? ' is-collapsed' : '');
      el.dataset.state = state;
      el.setAttribute('aria-labelledby', 'guideTitle');
      const later = '<button type="button" class="link" id="guideLater">稍后设置</button>';
      const helper = text => '<div class="bh-onboard-helper"><p>' + text + '</p></div>';
      let body = '';
      if (state === 'dismissed') {
        body = '<div class="bh-onboard-resume"><span id="guideTitle">连接尚未完成</span><button type="button" class="link" id="guideResume">继续设置 →</button></div>';
      } else if (state === 'login') {
        body = '<h2 id="guideTitle" tabindex="-1">连接你的工作区</h2><p>先登录 BlackHole，再选择连接方式。<br>让网页 AI 使用你选定的本地工作区。</p><div class="bh-onboard-actions">' + onboardButton('guideSignIn', signInOpened ? '重新打开登录页' : '在浏览器中登录 ↗') + '</div><div class="bh-onboard-status" id="guideSignInNote" role="status"' + (signInOpened ? '' : ' hidden') + '>等待登录完成，随后自动继续</div>' + helper('登录在浏览器中完成。<br>此步骤不会启动公网渠道。');
      } else if (state === 'ready') {
        const names = (c.running || []).map(x => CHANNEL_NAMES[x] || x).join('、');
        body = '<h2 id="guideTitle" tabindex="-1">连接已就绪</h2><p>接下来创建会话，选择 AI 可以使用的工作区和权限。</p><dl class="bh-onboard-facts"><div><dt>登录状态</dt><dd>已登录</dd></div><div><dt>当前渠道</dt><dd>' + esc(names || '已连接') + '</dd></div></dl><div class="bh-onboard-actions">' + onboardButton('guideCreate', '创建会话 →') + '</div>' + helper('会话权限可随时在 BlackHole 中调整。');
      } else if (state === 'install' || state === 'restart' || state === 'start') {
        const label = { install: '安装并验证中…', restart: '重启服务中…', start: '等待渠道启动…' }[state];
        body = '<h2 id="guideTitle" tabindex="-1">正在准备连接</h2><p>完成准备后，即可接入网页 AI。</p>' + (s ? onboardSteps(state) : '<div class="bh-onboard-status" role="status">正在等待渠道返回连接状态</div>') + '<div class="bh-onboard-actions">' + onboardButton('guideGo', label, true) + '</div>' + helper('无需重复操作。<br>若准备失败，可在这里查看原因并重试。');
      } else if (state === 'failed' || state === 'unverified') {
        const at = s?.failedAt || 'start';
        const copy = state === 'unverified' ? '渠道进程已启动，但公网连接尚未验证。暂不视为连接就绪。' : { install: '下载未完成。检查网络后重试，或在设置中指定已安装的程序。', restart: '本地服务未能重启。查看错误详情后重试。', start: '渠道未能启动。查看错误详情，或使用其它连接方式。' }[at];
        const error = s?.error || d.channelNote || c.reason || d.tunnel?.reason || '没有更多诊断信息。请打开设置检查渠道状态。';
        body = '<div class="bh-onboard-failure" role="status">' + (state === 'failed' ? '准备未完成' : '等待验证') + '</div><h2 id="guideTitle" tabindex="-1">连接还差一步</h2><p>' + copy + '</p>' + (s ? onboardSteps(state, at) : '') + '<div class="bh-onboard-actions">' + onboardButton(state === 'unverified' ? 'guideRefresh' : 'guideGo', state === 'unverified' ? '刷新连接状态' : '重新准备') + later + '</div><details id="guideDetails"><summary id="guideDetailsToggle">查看错误详情</summary><pre>' + esc(error) + '</pre></details>' + onboardOther();
      } else if (state === 'configure') {
        body = '<h2 id="guideTitle" tabindex="-1">选择连接方式</h2><p>' + esc(CHANNEL_NAMES[c.next] || '当前渠道') + '还需要完成配置。</p><div class="bh-onboard-actions">' + onboardButton('guideSettings', '打开连接设置 →') + later + '</div>' + helper('使用已有通道或自定义地址，不会自动安装其它程序。');
      } else {
        const install = c.missing === 'cloudflared', name = CHANNEL_NAMES[c.next] || '渠道';
        body = '<h2 id="guideTitle" tabindex="-1">让网页 AI 连进来</h2><p>' + (install ? '用临时渠道快速开始，无需准备域名。' : esc(name) + '已配置，启动后即可接入网页 AI。') + '</p><div class="bh-onboard-actions">' + onboardButton('guideGo', install ? '安装并连接 →' : '启动' + name + ' →') + later + '</div>' + helper(install ? '将安装并验证 cloudflared、重启本地服务，<br>然后启动临时公网渠道。<br>临时地址在重启渠道后会变化。' : '渠道只会在你确认后启动。') + onboardOther();
      }
      el.innerHTML = state === 'dismissed' ? body : '<div class="bh-onboard-body">' + onboardProgress(state, d.account) + '<span class="bh-onboard-mark" aria-hidden="true"></span>' + body + '</div>';
      for (const id of openDetails) { const node = el.querySelector('#' + id); if (node) node.open = true; }
      el.addEventListener('click', event => {
        const button = event.target.closest('button');
        if (!button || button.disabled) return;
        const id = button.id;
        if (id === 'guideSignIn') {
          signInOpened = true;
          button.textContent = '重新打开登录页';
          el.querySelector('#guideSignInNote').hidden = false;
          vs.postMessage({ type: 'signIn' });
        } else if (id === 'guideGo') {
          button.disabled = true; onboardEngaged = true;
          vs.postMessage(s || c.missing === 'cloudflared' ? { type: 'setupStart' } : { type: 'channelToggle', on: true });
        } else if (id === 'guideSettings') vs.postMessage({ type: 'settings' });
        else if (id === 'guideLater') vs.postMessage({ type: 'setupDismiss' });
        else if (id === 'guideResume') vs.postMessage({ type: 'setupResume' });
        else if (id === 'guideRefresh') vs.postMessage({ type: 'refresh' });
        else if (id === 'guideCreate') vs.postMessage({ type: 'create' });
      });
      onboardKey = key; onboardNode = el;
      return el;
    }

    // 列表节点常驻，任务区和分页均不参与它的滚动。
    const scroller = $('list');
    const saveScroll = () => scroller.scrollTop;
    const restoreScroll = (y) => { scroller.scrollTop = y; };

    // 会话列表整表重建：内容全部就绪后再恢复滚动位置。
    function renderSessions(d) {
      const scrollY = saveScroll();
      const list = scroller;
      const active = document.activeElement;
      const focusId = active?.closest('.bh-onboard') ? active.id : null;
      // Polling may rebuild the list, but must not close disclosures or strand keyboard focus.
      const restoreScroll = y => {
        list.scrollTop = y;
        if (focusId) {
          const target = $(focusId) || $('guideTitle');
          if (target && !target.disabled) target.focus({ preventScroll: true });
        }
      };
      const guide = renderOnboarding(d);
      list.innerHTML = '';
      list.dataset.mode = 'sessions';
      renderChannel(d);
      if (guide) list.appendChild(guide);
      // Focused onboarding owns the list area. Historical sessions return only
      // after the user dismisses setup or onboarding no longer applies.
      if (guide && guide.dataset.state !== 'dismissed') { restoreScroll(scrollY); return; }
      // Drafts are not listed (same as the Web console): a session shows up once it really started.
      const listed = d.sessions.filter((s) => !s.draft);

      if (listed.length === 0) {
        list.insertAdjacentHTML('beforeend', '<div class="empty">还没有会话。<br>创建一个，把整理好的提示词粘给网页 AI。<br></div>');
        const b = document.createElement('button');
        b.textContent = '+ 创建会话';
        b.addEventListener('click', () => vs.postMessage({ type: 'create' }));
        list.querySelector('.empty').appendChild(b);
        restoreScroll(scrollY);
        return;
      }
      for (const s of listed) {
        const row = document.createElement('div');
        row.className = 'row';
        const folder = s.workspace_path.split(/[\\\\/]/).pop() || s.workspace_path;
        const name = s.name || folder;
        const isCur = d.currentRoot && s.workspace_path.toLowerCase() === d.currentRoot.toLowerCase();
        row.dataset.sessionId = s.id;
        row.innerHTML = '<span class="drag" draggable="true" title="拖动调整会话顺序" aria-label="拖动调整会话顺序"></span>'
          + '<div class="main"><div class="name"><span class="txt"></span></div></div>'
          + rowStatus(s, d)
          + '<button class="ract" title="会话操作">' + IC.more + '</button>';
        row.querySelector('.txt').textContent = name;
        handoffView.attach(row.querySelector('.name'), s);
        if (isCur) { const tag = document.createElement('span'); tag.className = 'cur'; tag.textContent = '当前'; row.querySelector('.name').appendChild(tag); }
        // 账本式副行：完整工作区路径 · 权限模式（状态移到行右侧彩字）
        const modeLabel = s.permission_mode === 'read-only' ? '只读' : s.permission_mode === 'danger-full-access' ? '完全访问' : '工作区可写';
        row.title = name + ' · ' + s.workspace_path + ' · ' + modeLabel; // single-line row: path and mode on hover
        const drag = row.querySelector('.drag');
        drag.addEventListener('click', (e) => e.stopPropagation());
        drag.addEventListener('dragstart', (e) => {
          e.stopPropagation();
          row.classList.add('dragging');
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', s.id);
        });
        drag.addEventListener('dragend', () => {
          row.classList.remove('dragging');
          for (const el of list.querySelectorAll('.drag-before,.drag-after')) el.classList.remove('drag-before', 'drag-after');
        });
        row.addEventListener('dragover', (e) => {
          const from = e.dataTransfer.types.includes('text/plain');
          if (!from || row.classList.contains('dragging')) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          const before = e.clientY < row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2;
          row.classList.toggle('drag-before', before);
          row.classList.toggle('drag-after', !before);
        });
        row.addEventListener('dragleave', () => row.classList.remove('drag-before', 'drag-after'));
        row.addEventListener('drop', (e) => {
          e.preventDefault(); e.stopPropagation();
          const fromId = e.dataTransfer.getData('text/plain');
          const targetId = s.id;
          const before = row.classList.contains('drag-before');
          row.classList.remove('drag-before', 'drag-after');
          if (!fromId || fromId === targetId) return;
          const ids = listed.map((item) => item.id);
          const fromIndex = ids.indexOf(fromId), targetIndex = ids.indexOf(targetId);
          if (fromIndex < 0 || targetIndex < 0) return;
          ids.splice(fromIndex, 1);
          let insertAt = ids.indexOf(targetId) + (before ? 0 : 1);
          ids.splice(insertAt, 0, fromId);
          vs.postMessage({ type: 'reorder', ids });
        });
        row.addEventListener('click', () => vs.postMessage({ type: 'open', id: s.id }));
        row.addEventListener('contextmenu', (e) => { e.preventDefault(); openMenu(e.clientX, e.clientY, false, s); });
        row.querySelector('.ract').addEventListener('click', (e) => {
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          openMenu(r.left, r.bottom + 4, false, s);
        });
        list.appendChild(row);
      }
      restoreScroll(scrollY);
    }

    // 调用参数悬浮提示：单例浮层 + 事件委托（轮询整表重建 DOM 不用重绑）。
    // 只在摘要上悬停 1s 后弹出（扫过列表不触发）；浮层可移入（pointer-events
    // 开启 + 200ms 宽限），移入后可从容选择复制；数据取自 callIndex
    const callIndex = new Map();
    const tip = document.createElement('div');
    tip.id = 'tip';
    document.body.appendChild(tip);
    let tipAnchor = null;
    let tipCallId = null;
    let tipTimer = null;
    let tipHideTimer = null;
    function hideTip() { tip.style.display = 'none'; tipAnchor = null; tipCallId = null; }
    function placeTip(anchor) {
      const r = anchor.getBoundingClientRect();
      // 宽度跟随视口：窄窗口（窄侧栏）时收缩到 vw-16，不越过窗口边被裁；
      // 宽窗口封顶 480。置位前先限宽，offsetWidth 才是最终渲染宽
      tip.style.maxWidth = Math.min(480, window.innerWidth - 16) + 'px';
      const w = tip.offsetWidth, h = tip.offsetHeight;
      tip.style.left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8) + 'px';
      let y = r.bottom + 6;
      if (y + h > window.innerHeight - 8) y = Math.max(8, r.top - h - 6);
      tip.style.top = y + 'px';
    }
    document.addEventListener('mouseover', (e) => {
      if (tip.contains(e.target)) { clearTimeout(tipHideTimer); return; } // 移入浮层：保持显示
      const sum = e.target.closest && e.target.closest('.sum');
      if (sum) {
        if (sum === tipAnchor) return; // 已在这条摘要上
        clearTimeout(tipHideTimer);
        clearTimeout(tipTimer);
        tipTimer = setTimeout(() => {
          const card = sum.closest('.call');
          const c = card && callIndex.get(card.dataset.id);
          if (!c) return;
          tipAnchor = sum;
          tipCallId = card.dataset.id;
          tip.textContent = c.argsDisplay || c.summary || c.tool;
          tip.style.display = 'block';
          placeTip(sum);
        }, 1000);
      } else {
        // 离开摘要（且不在浮层上）：宽限 200ms，给鼠标移入浮层的时间
        clearTimeout(tipTimer);
        tipHideTimer = setTimeout(hideTip, 200);
      }
    });
    tip.addEventListener('mouseleave', () => { tipHideTimer = setTimeout(hideTip, 200); });
    scroller.addEventListener('scroll', hideTip, { passive: true });
    scroller.addEventListener('click', (e) => {
      const b = e.target instanceof Element ? e.target.closest('[data-draft-copy]') : null;
      if (!b || !cur || !cur.selected) return;
      vs.postMessage({ type: 'copyTemplate', kind: b.dataset.draftCopy, id: cur.selected.id });
    });

    // expanded call cards survive the polling re-render: remember open ids
    const openCalls = new Set();
    // Timeline loads older calls on scroll-up; one request at a time (reset by every update).
    let olderAsked = false;
    function askOlder() {
      if (olderAsked || !cur || cur.mode !== 'calls' || !cur.hasOlder || cur.olderBusy) return;
      olderAsked = true;
      vs.postMessage({ type: 'callOlder' });
    }
    const jump = $('jump');
    scroller.addEventListener('scroll', () => {
      if (scroller.dataset.mode === 'calls' && scroller.scrollTop < 80) askOlder();
      syncJump();
    }, { passive: true });
    // 回到底部：滚离底部时出现在列表右下角（会话列表模式不出现）
    function syncJump() {
      const far = scroller.dataset.mode === 'calls' && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > 60;
      const show = far ? '' : 'none';
      if (jump.style.display !== show) jump.style.display = show;
    }
    jump.addEventListener('click', () => { scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' }); });
    // 跨模式保留会话列表滚动位置：离开 sessions 记住，切回时还原（calls 始终从顶部开始）
    let savedSessionsScroll = 0;

    function fmtDur(ms) {
      if (ms < 0) ms = 0;
      if (ms < 1000) return ms + 'ms';
      const s = Math.floor(ms / 1000);
      if (s < 60) return s + 's';
      const m = Math.floor(s / 60);
      if (m < 60) return m + 'm' + (s % 60 ? ' ' + (s % 60) + 's' : '');
      const h = Math.floor(m / 60);
      return h + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : '');
    }

    // 任务清单（V2F 浮层版）：面板 DOM 常驻、就地更新——进度条过渡、流光和
    // 浮层开合状态不随轮询重建（随 feed 全量重建会让动画反复重放）
    const tasksEl = $('tasks');
    let tasksBuilt = false;
    let tasksOpen = false;
    let tasksLastKey = '';
    let tasksLastPct = -1;
    let tasksSeenIncomplete = false;

    function closeTasks() {
      tasksOpen = false;
      const box = tasksEl.querySelector('.t2f');
      if (box) { box.classList.remove('open'); box.classList.add('closed'); }
    }

    function renderTasks(d) {
      const items = d.mode === 'calls' ? (d.todos || []) : [];
      const goal = d.mode === 'calls' && typeof d.goal === 'string' ? d.goal : '';
      const unavailable = d.mode === 'calls' && d.todosUnavailable === true;
      if (items.length === 0 && !goal) {
        // 空清单（或离开详情页）：整个面板不渲染，不留空壳。读取失败只隐藏
        // 当前 DOM，不清除“本详情页曾见未完成项”的上下文；真实空 board/离开
        // 详情页才重置它，避免恢复时把刚完成误判成历史完成。
        tasksEl.style.display = 'none';
        tasksEl.innerHTML = '';
        tasksBuilt = false;
        tasksOpen = false;
        tasksLastKey = '';
        if (!unavailable) {
          tasksLastPct = -1;
          tasksSeenIncomplete = false;
        }
        return;
      }
      const done = items.filter((t) => t.status === 'completed').length;
      const active = items.filter((t) => t.status === 'in_progress').length;
      const pct = items.length ? Math.round((done / items.length) * 100) : 0;
      const all = items.length > 0 && done === items.length;
      if (items.length > 0 && !all) tasksSeenIncomplete = true;
      if (all && !tasksSeenIncomplete) {
        // Entering a detail view with an already-completed board should not
        // consume persistent vertical space. Keep the board intact; this is
        // presentation-only and later unfinished work will make it visible.
        tasksEl.style.display = 'none';
        tasksEl.innerHTML = '';
        tasksBuilt = false;
        tasksOpen = false;
        tasksLastKey = '';
        tasksLastPct = -1;
        return;
      }
      const justCompleted = all && tasksLastPct >= 0 && tasksLastPct < 100;
      tasksEl.style.display = 'block';
      if (!tasksBuilt) {
        tasksBuilt = true;
        tasksEl.innerHTML = '<div class="t2f closed"><div class="hd" id="tasksHd">'
          + '<span class="t-name">任务清单</span><span class="sp"></span>'
          + '<span class="num" id="tasksNum"></span><span class="sub" id="tasksSub"></span><span class="chev">▾</span></div>'
          + '<div class="bar" id="tasksBar"><i id="tasksFill"></i></div>'
          + '<div class="pop"><div class="items" id="tasksItems"></div></div></div>';
        $('tasksHd').addEventListener('click', (e) => {
          e.stopPropagation();
          tasksOpen = !tasksOpen;
          const box = tasksEl.querySelector('.t2f');
          box.classList.toggle('open', tasksOpen);
          box.classList.toggle('closed', !tasksOpen);
        });
      }
      if (justCompleted) closeTasks();
      const hasItems = items.length > 0;
      const num = $('tasksNum');
      num.hidden = !hasItems;
      num.textContent = hasItems ? done + '/' + items.length : '';
      num.classList.toggle('all', all);
      const sub = $('tasksSub');
      sub.hidden = !hasItems;
      sub.textContent = hasItems ? (all ? '清单已完成' : (active + ' 进行中')) : '';
      const bar = $('tasksBar');
      bar.hidden = !hasItems;
      const fill = $('tasksFill');
      fill.classList.toggle('all', all);
      if (!hasItems) {
        fill.style.width = '0%';
        tasksLastPct = -1;
      } else if (tasksLastPct < 0) {
        // 首次渲染：从 0 入场滑到目标
        fill.style.width = '0%';
        requestAnimationFrame(() => {
          requestAnimationFrame(() => { const f = $('tasksFill'); if (f) f.style.width = pct + '%'; });
        });
      } else {
        // 达成 100% 的一次性扫光：由前后进度 diff 触发，animationend 后移除防重放
        if (tasksLastPct < 100 && pct === 100) {
          const bar = tasksEl.querySelector('.bar');
          bar.classList.remove('celebrate');
          void bar.offsetWidth;
          bar.classList.add('celebrate');
        }
        fill.style.width = pct + '%';
      }
      tasksLastPct = hasItems ? pct : -1;
      const key = JSON.stringify([goal, items]);
      if (key !== tasksLastKey) {
        tasksLastKey = key;
        const list = $('tasksItems');
        list.textContent = '';
        if (goal) {
          const row = document.createElement('div'); row.className = 'ti goal';
          const tk = document.createElement('span'); tk.className = 'tk'; tk.textContent = '◎';
          const tx = document.createElement('span'); tx.className = 'tx'; tx.textContent = '目标：' + goal; tx.title = goal;
          row.appendChild(tk); row.appendChild(tx); list.appendChild(row);
        }
        for (const t of items) {
          const row = document.createElement('div');
          row.className = 'ti ' + (t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'act' : 'pend');
          const tk = document.createElement('span');
          tk.className = 'tk';
          tk.textContent = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '●' : '◌';
          const tx = document.createElement('span');
          tx.className = 'tx';
          // 进行中优先显示 activeForm（进行时文案），其余显示任务本体
          tx.textContent = t.status === 'in_progress' ? (t.activeForm || t.content) : t.content;
          tx.title = t.content;
          row.appendChild(tk);
          row.appendChild(tx);
          list.appendChild(row);
        }
      }
    }

    // 运行中工具卡片的耗时由本地时钟每秒就地推进；会话状态本身不显示计时。
    let lastCalls = [];
    setInterval(() => {
      renderLastToolAge();
      if (!lastCalls.length) return;
      const now = Date.now();
      for (const c of lastCalls) {
        if (c.status !== 'started' && c.status !== 'awaiting') continue;
        const card = document.querySelector('.call[data-id="' + c.id + '"]');
        if (!card) continue;
        const durMs = c.status === 'started' || c.status === 'awaiting' ? now - c.created_at : c.updated_at - c.created_at;
        const meta = card.querySelector('.meta');
        if (meta) meta.textContent = fmtDur(durMs);
      }
    }, 1000);

    // 调用卡片节点缓存：call.id → 卡片 DOM。增量渲染复用节点，只有会话/分页
    // 上下文变化时才整批重建（见 renderCalls 的 ctxKey 判断）。
    const cardById = new Map();
    let cardCtx = '';
    // 当前列表所属 session：取消按钮要把 session 一起带上做归属校验（daemon 侧
    // callId 只是 tool_calls 行 id，不带 session 就能取消到别的会话的调用）
    let curSessionId = '';

    // Codex 式截断：正文只预览前 N 行，其余收在「… 还有 N 行」后面
    const BODY_PREVIEW_LINES = 14;
    function bodyPreview(text, full) {
      const lines = text.split('\\n');
      const hidden = Math.max(0, lines.length - BODY_PREVIEW_LINES);
      return { text: full || hidden === 0 ? text : lines.slice(0, BODY_PREVIEW_LINES).join('\\n'), hidden };
    }

    function createCard(c) {
      const card = document.createElement('div');
      card.className = 'call';
      card.dataset.id = c.id;
      card.innerHTML = '<div class="call-hd" role="button" tabindex="0" aria-expanded="false">'
        + '<span class="bullet"></span><span class="tool"></span><span class="scope"></span><span class="diff"></span>'
        + '<span class="sum"></span><span class="resource-wrap" style="display:none"><span class="resource-kind"></span><button class="resource" type="button"></button></span>'
        + '<span class="badge"></span><span class="meta"></span>'
        + '<button class="cx" style="display:none">取消</button></div>'
        + '<div class="body"><pre></pre></div>';
      // textContent 天然转义，工具名不需要 esc()
      card.querySelector('.tool').textContent = c.tool;
      return card;
    }

    // 就地更新：每个字段先比对再写——无变化的卡片不产生任何 DOM 操作
    function updateCard(card, c, ctx) {
      // 布局：工具名 → scope → diff → 摘要 → badge → 耗时
      const scopeEl = card.querySelector('.scope');
      if (scopeEl.textContent !== ctx.scopeText) scopeEl.textContent = ctx.scopeText;
      scopeEl.style.display = ctx.scopeText ? '' : 'none';
      const diffEl = card.querySelector('.diff');
      const d = c.diff && (c.diff.added > 0 || c.diff.removed > 0) ? c.diff : null;
      const dk = d ? (d.added > 0 ? '+' + d.added : '') + (d.removed > 0 ? '-' + d.removed : '') : '';
      if (card._diffKey !== dk) {
        card._diffKey = dk;
        diffEl.innerHTML = d ? (d.added > 0 ? '<span class="add">+' + d.added + '</span>' : '')
          + (d.removed > 0 ? '<span class="del">-' + d.removed + '</span>' : '') : '';
        diffEl.style.display = dk ? '' : 'none';
      }
      const navigation = c.navigation && c.navigation.enabled ? c.navigation : null;
      const sumEl = card.querySelector('.sum'), resourceWrap = card.querySelector('.resource-wrap'), resourceKind = card.querySelector('.resource-kind'), resourceEl = card.querySelector('.resource');
      if (sumEl.textContent !== c.summary) sumEl.textContent = c.summary;
      sumEl.style.display = navigation ? 'none' : '';
      resourceWrap.style.display = navigation ? 'flex' : 'none';
      if (navigation) {
        if (resourceKind.textContent !== navigation.kind) resourceKind.textContent = navigation.kind;
        if (resourceEl.textContent !== navigation.label) resourceEl.textContent = navigation.label;
        resourceEl.setAttribute('aria-label', navigation.ariaLabel);
      } else {
        resourceKind.textContent = '';
        resourceEl.textContent = '';
        resourceEl.removeAttribute('aria-label');
      }
      // 状态先落到行首的符号上（Codex 的 •）：文字只在需要你做决定时出现，
      // 其余状态把词留给 aria-label/title，颜色不是唯一信号
      const bulletEl = card.querySelector('.bullet');
      if (bulletEl) {
        const blk = c.status + '|' + ctx.badgeText;
        if (card._bulletKey !== blk) {
          card._bulletKey = blk;
          bulletEl.className = 'bullet ' + c.status;
          bulletEl.textContent = { started: '●', awaiting: '▲', completed: '✓', failed: '✕', denied: '✕' }[c.status] || '·';
          bulletEl.setAttribute('role', 'img');
          bulletEl.setAttribute('aria-label', ctx.badgeText);
          bulletEl.title = ctx.badgeText;
        }
      }
      const bk = ctx.badge + '|' + ctx.badgeText;
      if (card._badgeKey !== bk) {
        card._badgeKey = bk;
        const b = card.querySelector('span.badge');
        b.className = 'badge ' + ctx.badge;
        b.textContent = ctx.badge === 'awaiting' ? ctx.badgeText : '';
      }
      const meta = fmtDur(ctx.durMs);
      const metaEl = card.querySelector('.meta');
      if (metaEl.textContent !== meta) metaEl.textContent = meta;
      // proxy 调用（运行中/等待审批）显示行内取消按钮：显隐随状态就地切换
      const cxEl = card.querySelector('.cx');
      const cxShow = c.tool === 'proxy' && (c.status === 'started' || c.status === 'awaiting') ? '' : 'none';
      if (cxEl.style.display !== cxShow) cxEl.style.display = cxShow;
      // 返回内容是最大单项（每条最多 2k 字符）：只在卡片展开时才写入
      if (card.classList.contains('open')) {
        const text = c.body || '(无返回内容)';
        if (card._body !== text) { card._body = text; card._bodyFull = false; card._bodyKey = ''; }
        const full = card._bodyFull === true;
        const view = bodyPreview(card._body, full);
        const vk = full + '|' + view.hidden + '|' + card._body.length;
        if (card._bodyKey !== vk) {
          card._bodyKey = vk;
          card.querySelector('pre').textContent = view.text;
          const body = card.querySelector('.body');
          let more = body.querySelector('.more');
          if (view.hidden > 0) {
            if (!more) { more = document.createElement('button'); more.className = 'more'; more.type = 'button'; body.appendChild(more); }
            more.textContent = full ? '收起' : ('… 还有 ' + view.hidden + ' 行');
            more.setAttribute('aria-expanded', String(full));
          } else if (more) more.remove();
        }
      }
      if (openCalls.has(c.id)) card.classList.add('open');
      const header = card.querySelector('.call-hd'), expanded = String(card.classList.contains('open'));
      if (header.getAttribute('aria-expanded') !== expanded) header.setAttribute('aria-expanded', expanded);
    }

    document.addEventListener('keydown', (e) => {
      // Only the header itself: Enter/Space on its cancel button must not expand the card.
      if ((e.key === 'Enter' || e.key === ' ') && e.target.classList?.contains('call-hd')) {
        e.preventDefault(); e.target.click();
      }
    });
    // 卡片交互全部事件委托：绑在 document 上一次，节点复用后无需重绑、
    // 也不会重复触发（节点上逐个绑定在增量渲染下必然重复）
    document.addEventListener('click', (e) => {
      const t = e.target;
      const cl = t.closest ? t.closest.bind(t) : null;
      if (!cl) return;
      if (cl('#olderBtn')) { askOlder(); return; }
      const resource = cl('.resource');
      if (resource) {
        const card = resource.closest('.call');
        if (card && card.dataset.id) vs.postMessage({ type: 'openCallResource', id: card.dataset.id });
        return;
      }
      // 展开/收起长输出：就地改文本，不等下一次轮询
      const moreBtn = cl('.more');
      if (moreBtn) {
        const card = moreBtn.closest('.call');
        const call = card && card.dataset.id ? callIndex.get(card.dataset.id) : null;
        if (card && call) {
          card._bodyFull = card._bodyFull !== true;
          const view = bodyPreview(call.body || '(无返回内容)', card._bodyFull);
          card.querySelector('pre').textContent = view.text;
          card._bodyKey = '';
          moreBtn.textContent = card._bodyFull ? '收起' : ('… 还有 ' + view.hidden + ' 行');
          moreBtn.setAttribute('aria-expanded', String(card._bodyFull === true));
        }
        return;
      }
      // 行内取消按钮先于 .call-hd 分支处理：按钮在标题行内，不能触发卡片展开
      const cxb = cl('.cx');
      if (cxb) {
        const card = cxb.closest('.call');
        if (card && card.dataset.id) vs.postMessage({ type: 'cancel', id: card.dataset.id, sessionId: curSessionId || undefined });
        return;
      }
      const hd = cl('.call-hd');
      if (!hd) return;
      const card = hd.closest('.call');
      if (!card) return;
      const id = card.dataset.id;
      card.classList.toggle('open');
      hd.setAttribute('aria-expanded', String(card.classList.contains('open')));
      if (card.classList.contains('open')) {
        openCalls.add(id);
        // 展开瞬间才填充返回内容（延迟填充：省掉每轮 20×2k 字符的写入）
        const c = callIndex.get(id);
        const text = (c && c.body) || '(无返回内容)';
        if (card._body !== text) { card._body = text; card.querySelector('pre').textContent = text; }
      } else {
        openCalls.delete(id);
      }
    });
    document.addEventListener('contextmenu', (e) => {
      if (e.target.closest && e.target.closest('.call')) { e.preventDefault(); openMenu(e.clientX, e.clientY, true); }
    });

    function renderCalls(d) {
      // 浮层只在对应调用的数据消失时才收起（节点复用后锚点长期有效）
      if (tipCallId !== null && !callIndex.has(tipCallId)) hideTip();
      curSessionId = d.selected ? d.selected.id : '';
      // Only a session change rebuilds; otherwise cards are reused. Chat order: oldest at the top, newest at the bottom.
      const ctxKey = d.selected ? d.selected.id : '';
      const list = scroller;
      let fresh = false;
      if (list.dataset.mode !== 'calls' || cardCtx !== ctxKey) {
        list.innerHTML = '';
        list.dataset.mode = 'calls';
        cardById.clear();
        callIndex.clear();
        cardCtx = ctxKey;
        fresh = true;
      }
      // Follow new items only when already at the bottom; loading older items keeps the view where it is.
      const atBottom = fresh || list.scrollHeight - list.scrollTop - list.clientHeight < 40;
      const keep = [...list.children].find((n) => n.id !== 'olderRow' && !n.classList.contains('empty'));
      const keepTop = keep ? keep.offsetTop : 0;
      // Questions live in the composer's question card, not in the thread; receive-only sessions
      // (no composer, no card) keep them in the thread as the only trace.
      const qInThread = !!d.courier && (d.courier.link === 'unpaired' || d.courier.link === 'direct');
      const pageMsgs = ((d.courier && d.courier.messages) || []).filter((m) => qInThread || !m.question);
      if (list.dataset.msgCtx !== ctxKey) { msgById.clear(); list.dataset.msgCtx = ctxKey; }
      if (d.calls.length === 0 && pageMsgs.length === 0 && d.selected && d.selected.draft) {
        // New session = draft: the two prompts are for copying only; the composer below starts a ChatGPT chat.
        const sig = 'draft:' + ctxKey;
        if (list.dataset.draftSig !== sig) {
          list.dataset.draftSig = sig;
          list.innerHTML = '<div class="draft"><div class="dt">新会话还没有连上网页 AI</div>'
            + '<div class="row"><button data-draft-copy="connector">复制提示词 · 连接器</button><button data-draft-copy="sandbox">复制提示词 · 沙箱直连</button></div>'
            + '<div class="dd">复制提示词交给网页 AI 自行使用；或在下方输入并发送，新开网页 AI 会话并配对（右上方选发送方式）。都没做就返回列表会丢弃这个会话。</div></div>';
        }
        cardById.clear();
        callIndex.clear();
        msgById.clear();
        lastCalls = d.calls;
        return;
      }
      list.dataset.draftSig = '';
      if (d.calls.length === 0 && pageMsgs.length === 0) {
        list.innerHTML = '<div class="empty">还没有消息和工具调用。在下方输入框发送第一条消息，或把提示词粘给网页 AI。</div>';
        cardById.clear();
        callIndex.clear();
        msgById.clear();
        lastCalls = d.calls;
        lastToolActivityAt = 0;
        renderLastToolAge();
        return;
      }
      // 空状态提示：增量路径下 list 不重建（ctxKey 未变），有数据后必须显式移除，
      // 否则「暂无工具调用」会残留在卡片下方
      const emptyEl = list.querySelector('.empty');
      if (emptyEl) emptyEl.remove();
      // Same for the new-session card once the first message or call shows up.
      const draftEl = list.querySelector('.draft');
      if (draftEl) draftEl.remove();
      // 审批操作统一在悬浮队列卡（renderApprovalCard），卡片不再内联审批框：
      // pending×卡片只能按 args_hash 模糊配对（confirmations 无 call_id），分页下会错位，
      // 且「第 0 页才可见」的双层分支已无存在必要——统一入口规则最简单
      // d.calls 就是当前页（扩展侧按页拉取），本地不再切片。
      const pageCalls = d.calls;
      const now = Date.now();
      lastToolActivityAt = pageCalls.reduce((latest, c) => Math.max(latest, Number(c.updated_at || 0), Number(c.created_at || 0)), 0);
      renderLastToolAge(now);
      // 循环前记录：本轮是「往已有列表新增」还是「整批重建」——ctxKey 变化时 cardById 已清空，
      // hadCards 为 false，切会话/翻页不会整屏播动画
      const hadCards = cardById.size > 0;
      const seen = new Set();
      const seenMsg = new Set();
      // Top row: loads older calls (also on scroll-up), or marks the start of the session.
      let older = $('olderRow');
      if (!older) { older = document.createElement('div'); older.id = 'olderRow'; older.className = 'older'; }
      if (list.firstChild !== older) list.insertBefore(older, list.firstChild);
      const olderKey = d.hasOlder ? (d.olderBusy ? 'busy' : 'more') : 'start';
      if (older.dataset.k !== olderKey) {
        older.dataset.k = olderKey;
        older.innerHTML = olderKey === 'more' ? '<button id="olderBtn" type="button">加载更早的记录</button>'
          : olderKey === 'busy' ? '<span>正在加载…</span>' : '<span>会话开始 · 共 ' + (d.callTotal || 0) + ' 次调用</span>';
      }
      let prev = older;
      // Messages are merged into the call order by time (the page may be newest- or oldest-first).
      // Fewer than two calls say nothing about the order: the timeline is oldest-first (newest at the bottom).
      const desc = pageCalls.length >= 2 && Number(pageCalls[0].created_at) > Number(pageCalls[pageCalls.length - 1].created_at);
      const queue = pageMsgs.slice().sort((a, b) => (desc ? b.at - a.at : a.at - b.at));
      const finals = finalReplyIds(pageMsgs);
      const place = (node) => {
        if (prev.nextSibling !== node) list.insertBefore(node, prev.nextSibling);
        prev = node;
      };
      const flushMsgs = (t) => {
        while (queue.length && (t === null || (desc ? queue[0].at > t : queue[0].at < t))) {
          const m = queue.shift();
          seenMsg.add(m.id);
          let node = msgById.get(m.id);
          const fin = finals.has(m.id);
          if (!node || node._sig !== msgSig(m) + (fin ? '|f' : '')) {
            const next = msgCard(m, fin);
            if (node) node.replaceWith(next);
            node = next;
            msgById.set(m.id, node);
          }
          place(node);
        }
      };
      for (const c of pageCalls) {
        flushMsgs(Number(c.created_at));
        seen.add(c.id);
        callIndex.set(c.id, c);
        let card = cardById.get(c.id);
        if (!card) {
          card = createCard(c);
          cardById.set(c.id, card);
          if (hadCards) {
            card.classList.add('enter');
            card.addEventListener('animationend', () => card.classList.remove('enter'), { once: true });
          }
        }
        updateCard(card, c, {
          badge: c.status,
          badgeText: { started: '运行中', awaiting: '等待审批', completed: '完成', failed: '失败', denied: '拒绝', unknown: '中断' }[c.status] || c.status,
          durMs: c.status === 'started' || c.status === 'awaiting' ? (now - c.created_at) : (c.updated_at - c.created_at),
          scopeText: { once: '一次', session: '会话', always: '全局' }[c.approval_scope] || '',
        });
        // 顺序校正：只有新卡片或错位卡片才动 DOM（insertBefore 对已有节点是移动）
        place(card);
      }
      flushMsgs(null);
      for (const [id, node] of msgById) if (!seenMsg.has(id)) { node.remove(); msgById.delete(id); }
      // 掉出本页的卡片移除（分页滚动 / 会话截断）
      for (const [id, card] of cardById) if (!seen.has(id)) { card.remove(); cardById.delete(id); callIndex.delete(id); }
      // 跨会话的展开状态由 message handler 的会话切换分支清理（openCalls.clear()）
      lastCalls = d.calls;
      if (atBottom) list.scrollTop = list.scrollHeight;
      else if (keep && keep.isConnected) list.scrollTop += keep.offsetTop - keepTop;
      syncJump();
    }

    // ---- Chat (Courier): messages in the timeline + composer ----
    const msgById = new Map();
    const SITE_NAME = { arena: 'Arena', chatgpt: 'ChatGPT' };
    const hhmm = (t) => { const x = new Date(t); return String(x.getHours()).padStart(2, '0') + ':' + String(x.getMinutes()).padStart(2, '0'); };
    const span = (cls, text) => { const s = document.createElement('span'); s.className = cls; s.textContent = text; return s; };
    // Compact picker (send method / web chat): text + chevron, opens a small menu upwards.
    // items: [{ id, label, tag? }]. Keyboard: ↑/↓, Enter, Esc; closes on outside click.
    let pickClose = null;
    document.addEventListener('mousedown', (e) => { if (pickClose && !(e.target instanceof Element && e.target.closest('.pick.open'))) pickClose(); }, true);
    function picker(aria, items, value, onPick) {
      const wrap = document.createElement('div');
      wrap.className = 'pick';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pick-btn';
      btn.setAttribute('aria-haspopup', 'listbox');
      btn.setAttribute('aria-expanded', 'false');
      btn.setAttribute('aria-label', aria);
      btn.title = aria;
      const cur0 = items.find((x) => x.id === value) || items[0];
      btn.append(span('', cur0 ? cur0.label : ''));
      const menu = document.createElement('ul');
      menu.className = 'pick-menu';
      menu.setAttribute('role', 'listbox');
      menu.setAttribute('aria-label', aria);
      menu.hidden = true;
      let act = Math.max(0, items.indexOf(cur0));
      const rows = items.map((x, i) => {
        const li = document.createElement('li');
        li.className = 'pick-item';
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', String(x === cur0));
        li.append(span('ck', '✓'), span('lb', x.label), span('tg', x.tag || ''));
        li.addEventListener('mouseenter', () => mark(i));
        li.addEventListener('click', () => choose(i));
        menu.append(li);
        return li;
      });
      function mark(i) { act = i; rows.forEach((r, j) => r.classList.toggle('act', j === i)); }
      function close() { if (menu.hidden) return; menu.hidden = true; wrap.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); if (pickClose === close) pickClose = null; }
      function open() { if (pickClose) pickClose(); menu.hidden = false; wrap.classList.add('open'); btn.setAttribute('aria-expanded', 'true'); mark(Math.max(0, items.indexOf(cur0))); pickClose = close; }
      function choose(i) { close(); btn.focus(); if (items[i] && items[i] !== cur0) onPick(items[i].id); }
      btn.addEventListener('click', () => (menu.hidden ? open() : close()));
      btn.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { if (!menu.hidden) { e.preventDefault(); e.stopPropagation(); close(); } return; }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          if (menu.hidden) { open(); return; }
          mark((act + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length);
        } else if ((e.key === 'Enter' || e.key === ' ') && !menu.hidden) { e.preventDefault(); choose(act); }
      });
      wrap.append(btn, menu);
      return wrap;
    }
    const msgSig = (m) => m.status + '|' + m.text.length + '|' + m.text.slice(-64);
    // 模型信息属于 Composer：从网页 AI 的最新回复里按站点取，不写进会话消息。
    function agentModel(site) {
      const ms = ((cur && cur.courier) || {}).messages || [];
      for (let i = ms.length - 1; i >= 0; i--) if (ms[i].kind === 'agent' && ms[i].model && (!site || ms[i].site === site)) return ms[i].model;
      return '';
    }
    // Chat stream: your messages as a light block on the right; agent replies full width as Markdown
    // (rendered and escaped by the extension, markdown.ts). Tool calls stay one compact line each.
    // A long message of yours folds to 200px with a toggle (only when clearly taller: +48px);
    // the open state survives re-renders of the card.
    const openUser = new Set();
    function foldUser(el, body, id) {
      requestAnimationFrame(() => {
        if (!body.isConnected || body.scrollHeight <= 248) return;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'msg-fold';
        const paint = () => {
          const open = openUser.has(id);
          body.classList.toggle('folded', !open);
          btn.textContent = open ? '收起' : '展开全文';
          btn.setAttribute('aria-expanded', String(open));
        };
        btn.addEventListener('click', () => { if (openUser.has(id)) openUser.delete(id); else openUser.add(id); paint(); });
        body.after(btn);
        paint();
      });
    }
    // The final reply of each turn: the last agent message before your next one (calls between
    // don't count). Only these and your own messages get a copy button.
    function finalReplyIds(msgs) {
      const out = new Set();
      let last = null;
      for (const m of msgs.slice().sort((a, b) => a.at - b.at)) {
        if (m.kind === 'agent') last = m.id;
        else { if (last) out.add(last); last = null; }
      }
      if (last) out.add(last);
      return out;
    }
    const COPY_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M9 9h10v11H9zM5 15V4h10"/></svg>';
    /** Full-view overlay for a sent message's images; click outside or Esc closes. */
    function showImages(d) {
      const urls = (d.urls || []).filter((u) => typeof u === 'string' && u.indexOf('data:image/') === 0);
      document.querySelector('.img-view')?.remove();
      const ov = document.createElement('div');
      ov.className = 'img-view';
      ov.tabIndex = -1;
      if (!urls.length) ov.append(span('img-gone', '图片已过期或不可用'));
      for (const u of urls) { const im = document.createElement('img'); im.src = u; im.alt = '图片'; ov.append(im); }
      const close = () => ov.remove();
      ov.addEventListener('click', (e) => { if (e.target === ov || e.target.className === 'img-gone') close(); });
      ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
      document.body.append(ov);
      ov.focus();
    }
    function msgCopy(text, cls) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'msg-copy ' + cls;
      b.title = '复制';
      b.setAttribute('aria-label', '复制');
      b.innerHTML = COPY_SVG;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        vs.postMessage({ type: 'copyText', text });
        b.classList.add('done');
        b.title = '已复制';
        setTimeout(() => { b.classList.remove('done'); b.title = '复制'; }, 1500);
      });
      return b;
    }
    function msgCard(m, final = false) {
      const el = document.createElement('div');
      el.className = 'msg ' + (m.kind === 'agent' ? 'agent' : 'user') + (m.status === 'streaming' ? ' streaming' : '');
      el._sig = msgSig(m) + (final ? '|f' : '');
      const site = SITE_NAME[m.site] || '网页会话';
      el.title = hhmm(m.at);
      if (m.kind === 'agent') {
        const head = document.createElement('div');
        head.className = 'msg-head';
        head.append(span('who', site), span('when', hhmm(m.at)));
        const body = document.createElement('div');
        body.className = 'msg-body md';
        body.innerHTML = m.html || '';
        renderDiagrams(body);
        el.append(head, body);
        if (final && m.status !== 'streaming') el.append(msgCopy(m.text, 'agent-copy'));
        return el;
      }
      const body = document.createElement('div');
      body.className = 'msg-body';
      body.textContent = m.text;
      if (m.images) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'msg-img';
        b.textContent = '查看图片 ×' + m.images;
        b.addEventListener('click', (e) => { e.stopPropagation(); vs.postMessage({ type: 'courierImages', id: m.id, count: m.images }); });
        el.append(b);
      }
      el.append(body);
      foldUser(el, body, m.id);
      if (m.status !== 'sent') {
        const st = m.status === 'unconfirmed' ? '未确认是否送达' : '未发送' + (m.message ? '：' + m.message : '');
        const s = span('msg-st ' + m.status, st);
        el.append(s);
      } else if (m.message) {
        el.append(span('msg-st unconfirmed', m.message)); // prompt only filled into a user-added site
      }
      el.append(msgCopy(m.text, 'user-copy'));
      return el;
    }
    // Mermaid diagrams (markdown.ts marks closed mermaid fences .md-mermaid): mermaid.min.js loads on
    // first use; SVGs are cached by theme + source so re-rendered cards do not flicker; a diagram that
    // fails to parse keeps its code block.
    const MERMAID_SRC = '${mermaidSrc}';
    const MERMAID_CONFIG = ${mermaidConfigs};
    const mmCache = new Map();
    let mmLoad = null, mmTheme = '', mmSeq = 0;
    function mmThemeNow() {
      const c = document.body.classList;
      return c.contains('vscode-dark') || (c.contains('vscode-high-contrast') && !c.contains('vscode-high-contrast-light')) ? 'dark' : 'default';
    }
    function mmApply(block, svg) {
      if (!svg) { block.dataset.mm = 'fail'; return; }
      let fig = block.querySelector(':scope > .md-diagram');
      if (!fig) { fig = document.createElement('div'); fig.className = 'md-diagram'; fig.tabIndex = 0; fig.title = '点击放大'; fig.setAttribute('role', 'button'); block.insertBefore(fig, block.querySelector(':scope > pre')); }
      fig.innerHTML = svg;
      block.dataset.mm = 'ok';
    }
    function loadMermaid() {
      if (!mmLoad) mmLoad = new Promise((resolve, reject) => {
        const sc = document.createElement('script');
        sc.src = MERMAID_SRC;
        sc.nonce = '${nonce}';
        sc.onload = () => (window.mermaid ? resolve(window.mermaid) : reject(new Error('mermaid')));
        sc.onerror = () => reject(new Error('mermaid'));
        document.head.append(sc);
      }).catch((err) => { mmLoad = null; throw err; });
      return mmLoad;
    }
    function renderDiagrams(root) {
      if (!MERMAID_SRC || !root) return;
      const t = mmThemeNow();
      const pending = [];
      root.querySelectorAll('.md-mermaid:not([data-mm])').forEach((block) => {
        const code = block.querySelector('pre code');
        const src = code ? code.textContent || '' : '';
        const key = t + '|' + src;
        if (mmCache.has(key)) mmApply(block, mmCache.get(key));
        else { block.dataset.mm = 'wait'; pending.push({ block, src, key }); }
      });
      if (!pending.length) return;
      loadMermaid().then(async (mermaid) => {
        for (const p of pending) {
          let svg = mmCache.get(p.key);
          if (svg === undefined) {
            if (mmTheme !== t) { mermaid.initialize(MERMAID_CONFIG[t]); mmTheme = t; }
            const id = 'bh-mm-' + (++mmSeq);
            try { svg = (await mermaid.render(id, p.src)).svg; } catch { svg = ''; }
            const scratch = document.getElementById('d' + id);
            if (scratch) scratch.remove(); // left behind on a parse error
            if (mmCache.size >= 200) mmCache.delete(mmCache.keys().next().value);
            mmCache.set(p.key, svg);
          }
          mmApply(p.block, svg);
        }
      }).catch(() => { pending.forEach((p) => { delete p.block.dataset.mm; }); });
    }
    // Diagram zoom viewer: click a diagram; wheel / pinch zoom, drag pans, double-click toggles fit / 2x,
    // keys + - 0 Esc. Same behaviour as the Web console (diagrams.ts).
    function openZoom(svgEl) {
      const vb = (svgEl.getAttribute('viewBox') || '').split(/[ ,]+/).map(Number);
      const w = vb.length === 4 && vb[2] > 0 ? vb[2] : (svgEl.getBoundingClientRect().width || 1);
      const h = vb.length === 4 && vb[3] > 0 ? vb[3] : (svgEl.getBoundingClientRect().height || 1);
      const pic = svgEl.cloneNode(true);
      pic.removeAttribute('style');
      pic.setAttribute('width', String(w));
      pic.setAttribute('height', String(h));
      const overlay = document.createElement('div');
      overlay.className = 'mm-zoom';
      overlay.tabIndex = -1;
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-label', 'Mermaid 图');
      const bar = document.createElement('div');
      bar.className = 'mm-zoom-bar';
      const button = (label, title) => {
        const b = document.createElement('button');
        b.type = 'button'; b.textContent = label; b.title = title; b.setAttribute('aria-label', title);
        bar.append(b);
        return b;
      };
      const out = button('−', '缩小'), pct = button('100%', '适应窗口'), zin = button('+', '放大'), close = button('×', '关闭');
      const stage = document.createElement('div');
      stage.className = 'mm-zoom-stage';
      const holder = document.createElement('div');
      holder.className = 'mm-zoom-pic';
      holder.append(pic);
      stage.append(holder);
      overlay.append(bar, stage);
      let scale = 1, x = 0, y = 0;
      const draw = () => { holder.style.transform = 'translate(' + x + 'px, ' + y + 'px) scale(' + scale + ')'; pct.textContent = Math.round(scale * 100) + '%'; };
      const fitScale = () => { const r = stage.getBoundingClientRect(); return Math.min((r.width - 24) / w, (r.height - 24) / h, 2); };
      const fit = () => { const r = stage.getBoundingClientRect(); scale = fitScale(); x = (r.width - w * scale) / 2; y = (r.height - h * scale) / 2; draw(); };
      const zoomAt = (next, px, py) => { const s = Math.min(8, Math.max(0.1, next)); x = px - (px - x) * s / scale; y = py - (py - y) * s / scale; scale = s; draw(); };
      const center = () => { const r = stage.getBoundingClientRect(); return [r.width / 2, r.height / 2]; };
      const local = (e) => { const r = stage.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
      stage.addEventListener('wheel', (e) => { e.preventDefault(); const p = local(e); zoomAt(scale * Math.exp(-e.deltaY * 0.0015), p[0], p[1]); }, { passive: false });
      stage.addEventListener('dblclick', (e) => { const p = local(e); const f = fitScale(); if (Math.abs(scale - f) < 0.01) zoomAt(f * 2, p[0], p[1]); else fit(); });
      const pointers = new Map();
      let pinch = 0;
      const spread = () => { const v = Array.from(pointers.values()); return [Math.hypot(v[0][0] - v[1][0], v[0][1] - v[1][1]), (v[0][0] + v[1][0]) / 2, (v[0][1] + v[1][1]) / 2]; };
      stage.addEventListener('pointerdown', (e) => { stage.setPointerCapture(e.pointerId); pointers.set(e.pointerId, local(e)); if (pointers.size === 2) pinch = spread()[0]; });
      stage.addEventListener('pointermove', (e) => {
        const prev = pointers.get(e.pointerId);
        if (!prev) return;
        const cur = local(e);
        pointers.set(e.pointerId, cur);
        if (pointers.size === 1) { x += cur[0] - prev[0]; y += cur[1] - prev[1]; draw(); return; }
        const s = spread();
        if (pinch > 0 && s[0] > 0) zoomAt(scale * s[0] / pinch, s[1], s[2]);
        pinch = s[0];
      });
      const lift = (e) => { pointers.delete(e.pointerId); pinch = 0; };
      stage.addEventListener('pointerup', lift);
      stage.addEventListener('pointercancel', lift);
      const prevFocus = document.activeElement;
      const shut = () => { overlay.remove(); if (prevFocus && prevFocus.focus) prevFocus.focus(); };
      out.addEventListener('click', () => { const c = center(); zoomAt(scale / 1.25, c[0], c[1]); });
      zin.addEventListener('click', () => { const c = center(); zoomAt(scale * 1.25, c[0], c[1]); });
      pct.addEventListener('click', fit);
      close.addEventListener('click', shut);
      overlay.addEventListener('keydown', (e) => {
        const c = center();
        if (e.key === 'Escape') shut();
        else if (e.key === '+' || e.key === '=') zoomAt(scale * 1.25, c[0], c[1]);
        else if (e.key === '-') zoomAt(scale / 1.25, c[0], c[1]);
        else if (e.key === '0') fit();
        else return;
        e.preventDefault();
        e.stopPropagation();
      });
      document.body.append(overlay);
      overlay.focus();
      fit();
    }
    function zoomTarget(t) {
      const fig = t && t.closest ? t.closest('.md-diagram') : null;
      return fig ? fig.querySelector('svg') : null;
    }
    document.addEventListener('click', (e) => { const svg = zoomTarget(e.target); if (svg) openZoom(svg); });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const svg = zoomTarget(e.target);
      if (svg) { e.preventDefault(); openZoom(svg); }
    });
    // VS Code theme switch (body class): redraw the diagrams in the new theme.
    new MutationObserver(() => {
      if (!mmTheme || mmThemeNow() === mmTheme) return;
      document.querySelectorAll('.md-mermaid[data-mm="ok"], .md-mermaid[data-mm="fail"]').forEach((b) => { delete b.dataset.mm; });
      renderDiagrams(document);
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    // Code-block copy button (markdown.ts): the extension writes the clipboard.
    document.addEventListener('click', (e) => {
      const btn = e.target.closest && e.target.closest('.md-copy');
      if (!btn) return;
      e.preventDefault();
      const code = btn.closest('.md-code') && btn.closest('.md-code').querySelector('pre code');
      if (!code) return;
      vs.postMessage({ type: 'copyText', text: code.textContent || '' });
      btn.classList.add('done');
      btn.title = '已复制';
      setTimeout(() => { btn.classList.remove('done'); btn.title = '复制代码'; }, 1500);
    });
    // Links in replies open in the browser through the extension.
    document.addEventListener('click', (e) => {
      const a = e.target.closest && e.target.closest('.md a[href]');
      if (!a) return;
      e.preventDefault();
      vs.postMessage({ type: 'openLink', text: a.getAttribute('href') });
    });
    // A streamed message update: patch the current state and re-render the timeline in place.
    function chatMsg(d) {
      if (!cur || cur.mode !== 'calls' || !cur.selected || cur.selected.id !== d.sessionId || !cur.courier) return;
      const list = cur.courier.messages || (cur.courier.messages = []);
      const i = list.findIndex((x) => x.id === d.message.id);
      if (i >= 0) list[i] = d.message; else list.push(d.message);
      renderCalls(cur);
      renderComposer(cur);
      syncSend();
    }

    const composer = $('composer');
    const cmpInput = $('cmpInput');
    const cmpSend = $('cmpSend');
    const cmpStop = $('cmpStop');
    let chatBusy = false;
    let chatStopBusy = false;
    let chatPick = '';
    // New session: how the first message goes out (Courier opens ChatGPT / Arena / a site added in
    // Courier, or a prompt copy). The remembered choice stays even while its site is missing; sending
    // falls back to ChatGPT when that site was deleted.
    const SEND_METHODS = [
      { id: 'chatgpt', label: 'ChatGPT', tag: '连接器', hint: '第一条消息会新开 ChatGPT 会话并配对，附上连接器提示词' },
      { id: 'arena', label: 'Arena', tag: '沙箱', hint: '第一条消息会新开 Arena 会话并配对，附上沙箱直连提示词' },
    ];
    function sendMethods() {
      const sites = (((cur && cur.courier) || {}).sites || []).filter((x) => x && x.custom);
      for (const x of sites) SITE_NAME[x.id] = x.name;
      const custom = sites.map((x) => ({ id: x.id, label: x.name, tag: x.template === 'connector' ? '连接器' : '沙箱', hint: '不绑定：新开 ' + x.name + ' 并填入' + (x.template === 'connector' ? '连接器' : '沙箱直连') + '提示词，由你在网页中手动发送，回复不同步' }));
      return [SEND_METHODS[0], SEND_METHODS[1], ...custom];
    }
    const usableMethod = () => (sendMethods().some((x) => x.id === sendMethod) ? sendMethod : 'chatgpt');
    let sendMethod = ((vs.getState() || {}).sendMethod) || 'chatgpt';
    if (typeof sendMethod !== 'string' || !/^(chatgpt|arena|manual|c-[a-z0-9-]{1,30})$/.test(sendMethod)) sendMethod = 'chatgpt';
    const manualSend = () => ((cur && cur.courier) || {}).link === 'new' && usableMethod() === 'manual';
    let chatHeadSig = '';
    // 发送状态住在 pill 里（可发送 → 发送中 → 已发送），不再占输入框下面的一行
    let chatFlash = '';
    let chatFlashCls = 'ok';
    let chatFlashTimer = 0;
    function chatState(t) {
      if (!t.open) return ['', '未打开，发送时自动打开'];
      if (t.ready === false) return ['bad', '页面没有响应'];
      if (t.busy) return ['warn', '正在生成'];
      if (t.draft) return ['warn', '有草稿'];
      return ['ok', '可发送'];
    }
    /** 发送状态优先于渠道状态：正在发显示「发送中」，刚发完短暂显示「已发送」 */
    function chatPill() {
      const c = (cur && cur.courier) || {};
      const targets = c.targets || [];
      const t = targets.find((x) => x.targetId === chatPick) || targets[0];
      if (chatBusy) return ['sending', '发送中'];
      if (chatFlash) return [chatFlashCls, chatFlash];
      return t ? chatState(t) : ['', ''];
    }
    /** 就地更新 pill：busy/flash 变化不重建 head，避免打断下拉与焦点 */
    function syncPill() {
      const head = $('cmpHead');
      if (!head) return;
      let p = head.querySelector('.pill');
      const st = chatPill();
      if (!st[1]) { if (p) p.remove(); return; }
      if (!p) { p = document.createElement('span'); head.append(p); }
      const key = st[0] + '|' + st[1];
      if (p.dataset.k !== key) { p.dataset.k = key; p.className = 'pill ' + st[0]; p.textContent = st[1]; }
    }
    function chatNote(cls, text) { const n = $('cmpNote'); n.className = 'cmp-note ' + (cls || ''); n.textContent = text || ''; }
    /** The web AI is still answering (its tab says so, or a reply is streaming): no new message until it is done. */
    // The last unanswered question from the web agent (no message of yours sent after it).
    function openQuestion() {
      const ms = ((cur && cur.courier) || {}).messages || [];
      for (let i = ms.length - 1; i >= 0; i--) {
        const m = ms[i];
        if (m.kind === 'user' && m.status === 'sent') return null;
        // Answered on the web page (Courier reports it): the card closes here too.
        if (m.kind === 'agent' && m.question) return m.question.answered ? null : m;
      }
      return null;
    }
    let qSig = '';
    function renderQuestion() {
      const box = $('qcard');
      const m = openQuestion();
      const sig = m ? m.id + '|' + chatBusy : '';
      if (sig === qSig) return;
      qSig = sig;
      box.textContent = '';
      if (!m) { box.style.display = 'none'; return; }
      const q = m.question;
      box.style.display = '';
      box.setAttribute('aria-label', q.title);
      const head = document.createElement('div');
      head.className = 'q-head';
      head.append(span('q-title', q.title));
      if (q.skip) {
        const sk = document.createElement('button');
        sk.className = 'q-skip'; sk.textContent = '跳过'; sk.disabled = chatBusy;
        sk.addEventListener('click', () => chatAnswer(m, '跳过'));
        head.append(sk);
      }
      box.append(head);
      q.options.forEach((o, i) => {
        const b = document.createElement('button');
        b.className = 'q-opt'; b.type = 'button'; b.disabled = chatBusy;
        b.append(span('q-n', String(i + 1)), span('q-l', o));
        b.addEventListener('click', () => chatAnswer(m, o));
        box.append(b);
      });
      box.append(span('q-hint', '点选项回答，或按数字键 1-' + Math.min(9, q.options.length) + (q.input ? '；也可以在下面输入框里写回答' : '')));
    }
    function chatAnswer(m, text) {
      const c = (cur && cur.courier) || {};
      if (chatBusy || !cur || !cur.selected || !c.connected) return;
      chatBusy = true;
      chatNote('', '正在回答…');
      qSig = ''; renderQuestion(); syncSend();
      vs.postMessage({ type: 'chatSend', id: cur.selected.id, targetId: m.targetId || chatPick || null, text });
    }
    document.addEventListener('keydown', (e) => {
      const m = openQuestion();
      if (!m || e.target === cmpInput || e.ctrlKey || e.metaKey || e.altKey || !/^[1-9]$/.test(e.key)) return;
      const o = m.question.options[Number(e.key) - 1];
      if (o) { e.preventDefault(); chatAnswer(m, o); }
    });
    function chatGenerating() {
      if (openQuestion()) return false; // the agent waits for your answer
      const c = (cur && cur.courier) || {};
      const t = (c.targets || []).find((x) => x.targetId === chatPick) || (c.targets || [])[0];
      return !!(t && t.busy) || (c.messages || []).some((m) => m.status === 'streaming');
    }
    function syncSend() {
      const c = (cur && cur.courier) || { connected: false };
      const gen = chatGenerating();
      const ready = c.connected || manualSend();
      cmpInput.disabled = !ready;
      cmpSend.disabled = !ready || chatBusy || gen || !cmpInput.value.trim();
      cmpSend.title = gen ? '网页 AI 正在生成，完成后才能发送' : '发送（Enter）';
      // 生成中：发送键原地换成停止键（同槽位，输入条不跳）
      const canStop = gen && c.connected;
      cmpStop.style.display = canStop ? '' : 'none';
      cmpSend.style.display = canStop ? 'none' : '';
      cmpStop.disabled = chatStopBusy;
      syncPill();
      renderQuestion();
    }
    function renderComposer(d) {
      if (d.mode !== 'calls' || !d.selected) { composer.style.display = 'none'; return; }
      composer.style.display = '';
      if (composer.dataset.sid !== d.selected.id) {
        composer.dataset.sid = d.selected.id;
        chatPick = ''; chatBusy = false; chatHeadSig = '';
        chatFlash = ''; clearTimeout(chatFlashTimer);
        cmpInput.value = ''; chatNote('', '');
      }
      const c = d.courier || { connected: false, targets: [] };
      const targets = c.targets || [];
      if (targets.length && !targets.some((t) => t.targetId === chatPick)) chatPick = targets[0].targetId;
      const picked = targets.find((x) => x.targetId === chatPick) || targets[0];
      // The model belongs to the composer, so it is part of the head signature
      const model = picked ? agentModel(picked.site) : '';
      // Receive only: the pairing was cut, or the web AI connected with a copied prompt (no Courier).
      const link = c.link || 'direct';
      const receiveOnly = link === 'unpaired' || link === 'direct';
      $('cmpBox').style.display = receiveOnly ? 'none' : '';
      const methods = sendMethods();
      const method = usableMethod();
      const sig = JSON.stringify([c.connected, targets, chatPick, model, link, method, methods.map((x) => x.id + x.label)]);
      if (sig !== chatHeadSig) {
        chatHeadSig = sig;
        const head = $('cmpHead');
        head.textContent = '';
        if (link === 'unpaired') head.append(span('name', '已解除配对 · 只接收；可在浏览器 Courier 里重新配对'));
        else if (link === 'direct') head.append(span('name', '提示词直连 · 只接收，对话在网页 AI 里进行'));
        else if (!targets.length && link === 'new') {
          const sel = picker('发送方式', methods, method, (v) => { sendMethod = v; vs.setState(Object.assign({}, vs.getState() || {}, { sendMethod })); chatHeadSig = ''; renderComposer(cur); });
          const hint = !c.connected ? '浏览器里的 Courier 未连接，打开浏览器后会自动连上' : methods.find((x) => x.id === method).hint;
          const hn = span('name', hint);
          hn.title = hint;
          head.append(sel, hn);
        }
        else if (!c.connected) head.append(span('name', '浏览器里的 Courier 未连接，打开浏览器后会自动连上'));
        else if (!targets.length) head.append(span('name', '配对的网页会话不在 Courier 里'));
        else {
          // 左上方只保留来源（Arena / ChatGPT / …）：会话标题在每条回复里重复，没有信息量
          const src = (t) => SITE_NAME[t.site] || t.site;
          const label = (t) => src(t) + ' · ' + (t.label || t.conversationKey || '新会话');
          const uniqueSites = new Set(targets.map((t) => t.site)).size === targets.length;
          if (targets.length > 1) {
            const sel = picker('选择网页会话', targets.map((t) => ({ id: t.targetId, label: uniqueSites ? src(t) : label(t), tag: chatState(t)[1] })), chatPick, (v) => { chatPick = v; chatHeadSig = ''; renderComposer(cur); });
            head.append(sel);
          } else {
            const n = span('name', src(targets[0]));
            n.title = label(targets[0]);
            head.append(n);
          }
          if (model) { const mdl = span('model', model); mdl.title = '网页 AI 模型'; head.append(mdl); }
          // An open Arena rating card: say so and offer the auto-rate rule on demand.
          const picked = targets.find((t) => t.targetId === chatPick) || targets[0];
          if (picked && picked.card && link === 'paired') {
            const cn = span('name', '评价卡未处理');
            cn.title = picked.card;
            const cb = document.createElement('button');
            cb.type = 'button';
            cb.textContent = '处理评价卡';
            cb.title = '按自动评价规则：模型在保留列表选「是」，不在选「否」，没读到模型就关闭';
            cb.addEventListener('click', () => { cb.disabled = true; chatNote('', '正在处理评价卡…'); vs.postMessage({ type: 'chatCard', id: cur.selected.id, targetId: picked.targetId }); });
            head.append(cn, cb);
          }
        }
      }
      syncSend();
    }
    function chatStopNow() {
      const c = (cur && cur.courier) || {};
      const targets = c.targets || [];
      if (!cur || !cur.selected || !c.connected || chatStopBusy) return;
      if (!targets.length) { chatNote('warn', '配对的网页会话不在 Courier 里，无法停止'); return; }
      chatStopBusy = true;
      chatFlash = ''; clearTimeout(chatFlashTimer);
      chatNote('warn', '正在让网页 AI 停止…');
      syncSend();
      vs.postMessage({ type: 'chatStop', id: cur.selected.id, targetId: chatPick || null });
    }
    cmpStop.addEventListener('click', chatStopNow);
    function chatStopResult(r) {
      if (!cur || !cur.selected || r.id !== cur.selected.id) return;
      chatStopBusy = false;
      if (r.ok) {
        chatNote('', '');
        chatFlash = '已停止'; chatFlashCls = 'warn';
        clearTimeout(chatFlashTimer);
        chatFlashTimer = setTimeout(function () { chatFlash = ''; syncPill(); }, 1800);
      } else {
        chatNote(r.code === 'not_running' ? 'warn' : 'bad', r.message || '停止失败');
      }
      syncSend();
    }
    function fitInput() { cmpInput.style.height = 'auto'; cmpInput.style.height = Math.min(160, cmpInput.scrollHeight + 2) + 'px'; }
    function chatSendNow() {
      const text = cmpInput.value;
      const c = (cur && cur.courier) || {};
      if (!text.trim() || chatBusy || !cur || !cur.selected) return;
      if (manualSend()) {
        // Manual: copy the connector prompt carrying this message; the web AI's first call opens the session.
        vs.postMessage({ type: 'copyTemplate', kind: 'connector', id: cur.selected.id, text });
        chatNote('', '提示词已复制，发给网页 AI；它第一次调用 BlackHole 时会话会自动开始。');
        return;
      }
      if (!c.connected) return;
      if (chatGenerating()) { chatNote('warn', '网页 AI 正在生成，完成后才能发送'); return; }
      const targets = c.targets || [];
      if (!targets.length && c.link !== 'new') { chatNote('warn', '配对的网页会话不在 Courier 里，无法发送'); return; }
      chatBusy = true;
      chatFlash = ''; clearTimeout(chatFlashTimer);
      // 「发送中」由 pill 承担；只有新开会话这一种还需要一行说明
      const m = usableMethod();
      const site = m === 'manual' ? 'chatgpt' : m;
      chatNote('', targets.length ? '' : '正在新开 ' + (SITE_NAME[site] || '网页') + ' 会话并发送…');
      syncSend();
      vs.postMessage({ type: 'chatSend', id: cur.selected.id, targetId: targets.length ? chatPick : null, text, site });
    }
    cmpInput.addEventListener('input', () => { fitInput(); syncSend(); });
    cmpInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); chatSendNow(); }
    });
    cmpSend.addEventListener('click', chatSendNow);
    function chatResult(r) {
      if (!cur || !cur.selected || r.id !== cur.selected.id) return;
      chatBusy = false;
      if (r.ok) {
        cmpInput.value = ''; fitInput(); chatNote('', '');
        chatFlash = '已发送'; chatFlashCls = 'ok';
        clearTimeout(chatFlashTimer);
        chatFlashTimer = setTimeout(function () { chatFlash = ''; syncPill(); }, 1800);
      } else { chatFlash = ''; chatNote(r.sent ? 'warn' : 'bad', r.message || '发送失败'); }
      syncSend();
    }


    // ctxMenu: from the calls-mode header/menu (selected session) or a session row.
    function openMenu(x, y, fromCalls, sessionRow) {
      const ctx = $('ctx');
      const s = fromCalls ? cur.selected : sessionRow;
      if (!s) return;
      // Every item must name the session the menu was opened for: this menu
      // serves both the calls header (cur.selected) and session rows, and the
      // extension has no other way to tell a row apart from the open detail.
      const id = s.id;
      // Same groups, order and wording as the web console menu (SessionMenuItems):
      // 会话 · 提示词 · 网页会话 (paired only) · 权限 · 会话 ID / 终止.
      const items = [];
      items.push({ label: s.status === 'paused' ? '恢复会话' : '暂停会话', msg: { type: 'action', action: s.status === 'paused' ? 'resume' : 'pause', id } });
      items.push({ label: '重命名', msg: { type: 'rename', id } });
      items.push({ sep: true });
      items.push({ label: '复制连接器提示词', msg: { type: 'copyTemplate', kind: 'connector', id } });
      items.push({ label: '复制沙箱提示词', msg: { type: 'copyTemplate', kind: 'sandbox', id } });
      const link = fromCalls ? (cur.courier && cur.courier.link) : ((cur.links || {})[id]);
      if (link === 'paired') {
        items.push({ sep: true });
        items.push({ label: '刷新网页', msg: { type: 'chatReload', id } });
        items.push({ label: '解除配对', msg: { type: 'unpair', id } });
      }
      items.push({ sep: true });
      items.push({ group: '权限' });
      const modeItems = [
        { mode: 'read-only', label: '只读' },
        { mode: 'workspace-write', label: '工作区可写' },
        { mode: 'danger-full-access', label: '完全访问', danger: true },
      ];
      for (const item of modeItems) {
        items.push({
          label: (s.permission_mode === item.mode ? '✓ ' : '') + item.label,
          danger: item.danger,
          msg: { type: 'mode', permissionMode: item.mode, id },
        });
      }
      items.push({ sep: true });
      items.push({ label: '重置会话 ID', msg: { type: 'action', action: 'rotate', id } });
      items.push({ label: '终止会话', danger: true, msg: { type: 'action', action: 'revoke', id } });
      ctx.innerHTML = '';
      for (const it of items) {
        if (it.sep) { const sp = document.createElement('div'); sp.className = 'sep'; ctx.appendChild(sp); continue; }
        if (it.group) { const g = document.createElement('div'); g.className = 'grp'; g.textContent = it.group; ctx.appendChild(g); continue; }
        const el = document.createElement('div');
        el.className = 'item' + (it.danger ? ' danger' : '');
        el.textContent = it.label;
        el.addEventListener('click', () => { hideMenu(); vs.postMessage(it.msg); });
        ctx.appendChild(el);
      }
      ctx.style.display = 'block';
      const r = ctx.getBoundingClientRect();
      ctx.style.left = Math.min(x, window.innerWidth - r.width - 4) + 'px';
      ctx.style.top = Math.min(y, window.innerHeight - r.height - 4) + 'px';
    }
    function hideMenu() { $('ctx').style.display = 'none'; }
    document.addEventListener('click', hideMenu);
    window.addEventListener('blur', hideMenu);
    // 任务浮层的点外部/Esc 关闭：头部点击已 stopPropagation，不会自关
    document.addEventListener('click', (e) => { if (tasksOpen && !tasksEl.contains(e.target)) closeTasks(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeTasks(); });

    // 底部审批弹窗：待审批不在当前详情页时出现；样式与内联审批框一致
    function cmdPreview(p) {
      // 审批命令完整显示（pwsh 审批的命令就是几行文本，没有截断的必要）；
      // 非命令型 args 的 JSON 回退仍限长（防畸形大对象撑爆弹窗）
      try { const a = JSON.parse(p.args_json); if (typeof a.command === 'string') return a.command; } catch (e) { /* fall through */ }
      return (p.args_json || '').slice(0, 2000);
    }
    // 审批终稿：队列式悬浮详情卡（demo: _temp/design-demos/scrollbar-approval.html）。
    // overlay 悬浮在列表上方（不顶开列表、不打断滚动）；一次只显示一条，
    // 处理完自动顶下一条；风险标签与命令内命中片段同色图例（daemon riskMatches 判定）
    let apQueueIdx = 0;
    // Map a risk tone (red|yellow|blue) to the CSS modifier class the stylesheet
    // actually defines (.warn/.info); red is the base style, so it adds nothing.
    // Without this map, yellow/blue fell through to the base red style.
    function toneClass(tone) {
      return tone === 'yellow' ? ' warn' : tone === 'blue' ? ' info' : '';
    }
    function renderApprovalCard(d) {
      const bar = $('abar');
      const items = d.pending || [];
      if (items.length === 0) { apQueueIdx = 0; bar.className = ''; bar.innerHTML = ''; syncApprovalPad(); return; }
      if (apQueueIdx >= items.length) apQueueIdx = items.length - 1;
      const p = items[apQueueIdx];
      const nameOf = (id) => {
        const s = (d.sessions || []).find((x) => x.id === id);
        return s ? (s.name || s.workspace_path.split(/[\\/]/).pop() || s.workspace_path) : id;
      };
      const cmd = cmdPreview(p);
      // 命中区间 → 高亮 span（textContent 拼装：先纯文本节点，命中段用 span 包裹）
      const matches = (p.risk_matches || []).slice().sort((a, b) => a.range[0] - b.range[0]);
      const hasCritical = matches.some((m) => m.level === 'critical');
      // 相同标签只显示一次（rm 与 rmdir 同命中"文件删除"时标签行不重复）
      const seenLabels = new Set();
      const tagList = matches.filter((m) => (seenLabels.has(m.label) ? false : (seenLabels.add(m.label), true)));
      let cmdHtml = '';
      let pos = 0;
      for (const m of matches) {
        if (m.range[0] < pos || m.range[1] > cmd.length) continue;
        cmdHtml += esc(cmd.slice(pos, m.range[0])) + '<span class="hit' + toneClass(m.tone) + '">' + esc(cmd.slice(m.range[0], m.range[1])) + '</span>';
        pos = m.range[1];
      }
      cmdHtml += esc(cmd.slice(pos));
      bar.className = 'has';
      bar.innerHTML = '<div class="apq">'
        + '<div class="aphead"><span class="adot"></span>待审批<span class="sp"></span>' + (items.length > 1 ? '<span class="acnt">' + (apQueueIdx + 1) + '/' + items.length + '</span>' : '') + '</div>'
        + '<div class="srcrow"><span class="nm">' + esc(nameOf(p.session_id)) + '</span><span class="go" data-sid="' + esc(p.session_id) + '">查看会话 ›</span></div>'
        + (tagList.length ? '<div class="riskrow">' + tagList.map((m) => '<span class="rchip' + toneClass(m.tone) + '">' + esc(m.label) + '</span>').join('') + '</div>' : '')
        + '<div class="acmd">' + cmdHtml + '</div>'
        + '<div class="abtns">'
        + '<button class="ok" data-id="' + esc(p.id) + '" data-scope="once" title="只放行这一次调用">批准一次</button>'
        + '<button class="more" data-id="' + esc(p.id) + '" data-scope="session" title="本会话内同类操作不再询问">本会话</button>'
        + (hasCritical ? '' : '<button class="more" data-id="' + esc(p.id) + '" data-scope="always" title="所有会话不再询问，并在 daemon 重启后继续保留">始终</button>')
        + '<span class="sp"></span>'
        + '<button class="no" data-id="' + esc(p.id) + '">拒绝</button></div>'
        + '</div>';
      bar.querySelector('.go').addEventListener('click', (e) => { e.stopPropagation(); vs.postMessage({ type: 'open', id: p.session_id }); });
      for (const b of bar.querySelectorAll('button[data-scope]')) {
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          // 就地从队列移除该条并立即渲染下一条，轮询随后校正为服务端真值
          d.pending = items.filter((x) => x.id !== b.getAttribute('data-id'));
          renderApprovalCard(d);
          vs.postMessage({ type: 'approve', id: b.getAttribute('data-id'), scope: b.getAttribute('data-scope') });
        });
      }
      bar.querySelector('.no').addEventListener('click', (e) => {
        e.stopPropagation();
        d.pending = items.filter((x) => x.id !== p.id);
        renderApprovalCard(d);
        vs.postMessage({ type: 'deny', id: p.id });
      });
      syncApprovalPad();
    }

    // 审批卡是 fixed 悬浮层（不占布局），显示时会盖住列表底部：给 #list 补一段
    // 等于卡片实际高度 + 间距的 padding-bottom，保证最后一条调用能滚出卡片之上。
    // 卡片隐藏时归零。rAF 等布局完成后再量高（innerHTML 刚写入，需下一帧才有准确高度）。
    function syncApprovalPad() {
      requestAnimationFrame(() => {
        const bar = $('abar');
        const shown = bar.classList.contains('has');
        scroller.style.paddingBottom = shown ? (bar.offsetHeight + 16) + 'px' : '';
      });
    }

    window.addEventListener('message', (e) => {
      const d = e.data;
      if (d.type === 'handoffCopied') { handoffView.copied(d); return; }
      if (d.type === 'handoffPreview') { handoffView.preview(d); return; }
      if (d.type === 'chatResult') { chatResult(d); return; }
      if (d.type === 'chatStopResult') { chatStopResult(d); return; }
      if (d.type === 'chatCardResult') { chatNote(d.ok ? '' : 'warn', d.message || ''); chatHeadSig = ''; renderComposer(cur); return; }
      if (d.type === 'chatMsg') { chatMsg(d); return; }
      if (d.type === 'courierImagesData') { showImages(d); return; }
      if (d.type !== 'update') return;
      const focusedHandoff = document.activeElement?.dataset.handoffAction !== undefined ? { ...document.activeElement.dataset } : null;
      handoffView.render(d);
      // reset pagination when entering a different session/list mode
      const modeChanged = cur.mode !== d.mode;
      // 离开 sessions 前记住其滚动位置，切回时还原（见 renderSessions 尾部）
      if (modeChanged && cur.mode === 'sessions') savedSessionsScroll = scroller.scrollTop;
      if (modeChanged || (d.mode === 'calls' && cur.selected && d.selected && cur.selected.id !== d.selected.id)) {
        openCalls.clear();
        // calls 进入由 renderCalls 滚到底部（最新）；切回 sessions 的位置由 renderSessions 还原
      }
      olderAsked = false;
      cur = d;
      const err = $('err');
      if (d.daemon === 'error') { err.style.display = 'block'; err.textContent = 'daemon 异常：详见输出面板 BlackHole 频道'; }
      else err.style.display = 'none';
      renderHeader(d);
      renderApprovalCard(d);
      renderTasks(d);
      if (d.mode === 'calls') renderCalls(d);
      else renderSessions(d);
      // 刚切回 sessions：覆盖 renderSessions 的同模式还原，恢复离开前记住的位置
      if (modeChanged && d.mode === 'sessions') scroller.scrollTop = savedSessionsScroll;
      syncJump();
      renderComposer(d);
      if (focusedHandoff && !$('handoffDialog').open) {
        const candidate = [...document.querySelectorAll('[data-handoff-action]')].find(el => el.dataset.sessionId === focusedHandoff.sessionId && el.dataset.handoffId === focusedHandoff.handoffId && el.dataset.handoffAction === focusedHandoff.handoffAction);
        candidate?.focus();
      }
    });
    vs.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }

  dispose(): void {
    this.disposed = true;
    this.handoff = null;
    this.view = undefined;
    this.viewGeneration++;
    this.refreshAgain = false;
    this.closeFeed();
    this.feedEvents.clear();
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
  }
}
