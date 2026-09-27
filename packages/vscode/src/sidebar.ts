import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { commands, env, Position, Range, Selection, TextEditorRevealType, Uri, window, workspace, WebviewView, type Disposable, type WebviewViewProvider } from 'vscode';
import { argumentDetails, commandSummary, pendingConfirmationFor, resultBody, resultDiff } from './callFormat';
import { editorNavigationPreview, resolveEditorNavigation } from './editorNavigation';
import { isWorkspaceFileTool, displayToolName } from './toolNames';
import { sidebarIcons } from './icons';
import { getConfig } from './config';
import { prepareHandoffPrompt } from './handoffCopy';
import { handoffMarkup, handoffScript, handoffStyles } from './handoffView';
import type { CallRow, ControlApi, PendingHandoff, PermissionMode, SessionAction, SessionInfo, TodoItem, TunnelState } from './controlApi';
import type { DaemonManager } from './daemonManager';
import type { Poller } from './poller';

export interface SidebarHooks {
  create(): void;
  act(session: SessionInfo, action: SessionAction): void;
  copyTemplate(session: SessionInfo, kind: 'connector' | 'sandbox'): void;
}

interface ViewMessage {
  type: 'ready' | 'create' | 'refresh' | 'settings' | 'open' | 'back' | 'action' | 'copyTemplate' | 'approve' | 'deny' | 'webAgent' | 'callPage' | 'mode' | 'cancel' | 'reorder' | 'openCallResource' | 'copyHandoff' | 'previewHandoff' | 'cancelHandoffPreview';
  id?: string;
  handoffId?: string;
  requestId?: string;
  /** callPage：目标页码（0 起；负值会被钳到 0）。 */
  page?: number;
  /** cancel：目标调用所属 session（daemon 侧据此做归属校验）。 */
  sessionId?: string;
  /** approve 的范围（once / session / always）；缺省 = once。 */
  scope?: 'once' | 'session' | 'always';
  action?: SessionAction;
  kind?: 'connector' | 'sandbox';
  permissionMode?: PermissionMode;
  ids?: string[];
}

/** 详情页调用列表的单页行数（与 webview 侧 PAGE_SIZE 保持一致）。 */
const CALL_PAGE_SIZE = 20;

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
  private disposed = false;
  private viewGeneration = 0;
  private subscriptions: Disposable[] = [];

  private mode: 'sessions' | 'calls' = 'sessions';
  private selectedId = '';
  /** 当前页的调用行（daemon 按 rowid DESC 返回；历史页按需拉取，不常驻内存）。 */
  private pageCalls: CallRow[] = [];
  private callPage = 0;
  /** 锚定 seq（daemon 侧 MAX(rowid)）：翻页窗口的基准，新写入只落第 0 页。 */
  private callAnchor = 0;
  private callTotal = 0;
  /** anchor 窗口内的行数：分页器页数与翻页边界依据（全量含锚定后新写入，深页取不到）。 */
  private windowTotal = 0;
  /** refresh 串行化：上一轮未结束时只标记重跑，快速翻页不会乱序覆盖。 */
  private refreshBusy = false;
  private refreshAgain = false;
  /** daemon 变更 epoch：与上次相同则本轮零拉取（见 refresh）。 */
  private lastEpoch = -1;
  /** 当前详情页的任务清单与可选目标（两者皆空时不渲染）。 */
  private todos: TodoItem[] = [];
  private todoGoal: string | undefined;
  private todosUnavailable = false;
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
    view.onDidDispose(() => {
      messages.dispose();
      if (this.view === view) { this.view = undefined; this.handoff = null; this.viewGeneration++; this.refreshAgain = false; }
    });
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html();
    void this.refresh(true);
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
    this.pageCalls = [];
    this.callPage = 0;
    this.callAnchor = 0;
    this.callTotal = 0;
    this.windowTotal = 0;
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
    const [sessions, health, pendingAll] = await Promise.all([
      this.api.listSessions().then((r) => r.sessions).catch(() => failed(undefined)),
      this.api.health().catch(() => failed(undefined)),
      this.api.confirmations().then((r) => r.confirmations.filter((c) => c.status === 'pending')).catch(() => failed([])),
      // 拉取失败即清空：daemon 不可达时没有可处理的审批，徽标绝不残留旧数字
    ]);
    if (!current()) return;
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
        this.handoff = null;
      } else {
        const detailCurrent = () => current() && this.mode === 'calls' && this.selectedId === sel.id;
        let todosUnavailable = false;
        const [feed, todoBoard] = await Promise.all([
          this.api.callsPage(sel.id, this.callPage, this.callPage === 0 ? 0 : this.callAnchor).catch(() => failed({ calls: [] as CallRow[], total: 0, window_total: 0, max_seq: 0 })),
          // daemon 不可达即清空可见清单，但明确标记为“暂不可用”，避免 webview
          // 把一次 transport failure 当成真实空 board 并丢掉当前详情页的完成态上下文。
          this.api.todos(sel.id).catch(() => {
            todosUnavailable = true;
            return failed({ items: [] as TodoItem[], contract: undefined, updated_at: 0 });
          }),
        ]);
        if (!detailCurrent()) { this.refreshAgain = true; return; }
        // 首次锚定：anchor=0 时响应里的 max_seq 即当前最大 seq，此后窗口固定
        if ((this.callPage === 0 || !this.callAnchor) && feed.max_seq > 0) this.callAnchor = feed.max_seq;
        // 页码越界（会话记录被清理等导致页数变少）→ 钳回"窗口口径"末页重拉一次。
        // 用 window_total 而非 total：全量口径多算 anchor 后的新写入，深页被误判越界
        // 钳回末页（翻历史被反复拽回末页的根源）
        // clamp uses the SAME total as the pager (feed.total, count-based) so
        // the last-page math agrees with the displayed page count.
        const wTotal = feed.total || feed.window_total || 0;
        if (!feed.calls.length && this.callPage > 0 && wTotal > 0) {
          this.callPage = Math.max(0, Math.ceil(wTotal / CALL_PAGE_SIZE) - 1);
          const refetch = await this.api.callsPage(sel.id, this.callPage, this.callAnchor).catch(() => failed(undefined));
          if (!detailCurrent()) { this.refreshAgain = true; return; }
          if (refetch) {
            Object.assign(feed, refetch);
            this.windowTotal = refetch.window_total ?? refetch.total;
          }
        }
        this.pageCalls = feed.calls;
        this.callTotal = feed.total;
        this.windowTotal = feed.window_total ?? feed.total;
        this.todos = todoBoard.items;
        this.todoGoal = todoBoard.contract?.goal;
        this.todosUnavailable = todosUnavailable;

      }
    }

    if (complete) this.lastEpoch = nextEpoch;
    this.postUpdate();
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
    void this.post({
      type: 'update',
      mode: this.mode,
      sessions: this.sessions,
      daemon: this.daemon.currentState,
      currentRoot: currentWorkspaceRoot(),
      tunnel: this.tunnel,
      openai: this.openai,
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
      callTotal: this.mode === 'calls' ? this.callTotal : 0,
      windowTotal: this.mode === 'calls' ? this.windowTotal : 0,
      callPage: this.mode === 'calls' ? this.callPage : 0,
      todos: this.mode === 'calls' ? this.todos : [],
      goal: this.mode === 'calls' ? this.todoGoal : undefined,
      todosUnavailable: this.mode === 'calls' ? this.todosUnavailable : false,
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
      case 'callPage': {
        // 翻页由 webview 上报：改页码后强制按新页重拉（翻页不改 daemon 数据，epoch 不变）。
        // 只在详情页有效：残监听/竞态在列表页触发时直接忽略
        if (this.mode !== 'calls') return;
        const page = Math.max(0, m.page || 0);
        if (page !== this.callPage) {
          this.callPage = page;
          void this.refresh(true);
        }
        return;
      }
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
      case 'settings':
        await commands.executeCommand('blackhole.openSettings');
        return;
      case 'webAgent':
        await commands.executeCommand('blackhole.openWebAgent');
        return;
      case 'back':
        this.navigationGeneration++;
        this.previewGeneration++;
        this.mode = 'sessions';
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
        if (!Array.isArray(m.ids) || m.ids.length !== this.sessions.length) return;
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
      case 'action':
      case 'copyTemplate': {
        // act on the session the menu was opened for; the id-less form (older
        // messages) still means "the session the call feed is showing"
        const s = (m.id ? this.sessions.find((x) => x.id === m.id) : undefined) ?? this.selected();
        if (!s) return;
        if (m.type === 'action' && m.action) this.hooks.act(s, m.action);
        else if (m.type === 'copyTemplate' && m.kind) this.hooks.copyTemplate(s, m.kind);
        return;
      }
    }
  }

  private html(): string {
    const nonce = Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
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
  #list { flex: 1; min-height: 0; min-width: 0; overflow-y: auto; overscroll-behavior: contain; padding-bottom: 10px; }
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
  .err { color: var(--vscode-errorForeground); font-size: 11px; padding: 6px 12px 0; word-break: break-all; }
  /* 会话行：账本式 —— 全宽、发丝线分隔、更密 */
  .row { display: flex; align-items: center; gap: 6px; padding: 7px 10px; cursor: pointer; border-bottom: 1px solid color-mix(in srgb, var(--vscode-foreground) 9%, transparent); }
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
  .last-tool-age { margin-left: 5px; color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family); font-variant-numeric: tabular-nums; font-weight: 400; }
  .ract { width: 22px; height: 22px; display: grid; place-items: center; border: none; border-radius: 6px; background: transparent; color: var(--vscode-icon-foreground); cursor: pointer; padding: 0; flex-shrink: 0; }
  .ract svg { display: block; }
  .row .ract { opacity: 0; }
  .row:hover .ract { opacity: 1; }
  .row .ract:hover { background: var(--vscode-toolbar-hoverBackground); }
  .empty { opacity: .65; padding: 16px 12px; line-height: 1.8; }
  .empty button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: none; border-radius: 4px; padding: 3px 10px; cursor: pointer; font-family: inherit; }
  /* 调用卡片（静谧工作台：抬升面、无边界） */
  /* 视口外卡片跳过渲染与布局：列表变长时收益递增。contain-intrinsic-size 提供未渲染时的占位高度，auto 记住真实高度以避免滚动跳动。卡片内无溢出定位元素（#tip/#abar/#ctx 均为 fixed 挂在 body 层），containment 无副作用。 */
  .call { margin: 8px 10px 0; background: color-mix(in srgb, var(--vscode-foreground) 4%, var(--vscode-sideBar-background)); border-radius: 8px; overflow: hidden; content-visibility: auto; contain-intrinsic-size: auto 36px; }
  /* 新调用入场：只在列表已有卡片时播放（见 renderCalls 的 hadCards），切会话/翻页的整批重建不放动画，避免整屏抖动 */
  @keyframes bhCardIn { from { opacity: 0; transform: translateY(-8px) scale(.98); } }
  .call.enter { animation: bhCardIn .3s cubic-bezier(.22, 1, .36, 1); }
  @media (prefers-reduced-motion: reduce) { .call.enter { animation: none; } }
  .call-hd { display: flex; align-items: center; gap: 8px; padding: 7px 10px; min-height: 36px; box-sizing: border-box; cursor: pointer; }
  .call-hd:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -2px; }
  .call .tool { font-family: var(--vscode-editor-font-family); font-size: 11.5px; font-weight: 650; flex-shrink: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .call .sum, .call .resource-wrap { flex: 1 1 0; min-width: 0; font-family: var(--vscode-editor-font-family); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .call .sum { color: var(--vscode-descriptionForeground); }
  .call .resource-wrap { display: none; align-items: baseline; gap: 4px; color: var(--vscode-descriptionForeground); }
  .call .resource-kind { flex: none; }
  .call .resource { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0 0 0 4px; border: 0; border-left: 1px solid var(--vscode-widget-border); background: transparent; color: var(--vscode-textLink-foreground); text-align: left; cursor: pointer; }
  .call .resource:hover { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
  .call .resource:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; border-radius: 3px; }
  .call .meta { font-size: 10px; color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family); white-space: nowrap; flex-shrink: 0; opacity: .85; }
  .call .scope { color: var(--vscode-charts-green); font-size: 10px; font-weight: 600; flex-shrink: 0; }
  .badge { border: 0; border-radius: 999px; padding: 1px 8px; font-family: inherit; font-size: 10px; font-weight: 600; flex-shrink: 0; }
  .badge.completed { color: var(--vscode-charts-green); background: color-mix(in srgb, var(--vscode-charts-green) 14%, transparent); }
  .badge.started { color: var(--vscode-charts-yellow); background: color-mix(in srgb, var(--vscode-charts-yellow) 16%, transparent); }
  .badge.awaiting { color: #1f1f1f; background: var(--vscode-charts-yellow); }
  .badge.failed { color: var(--vscode-charts-red); background: color-mix(in srgb, var(--vscode-charts-red) 14%, transparent); }
  .badge.denied { color: var(--vscode-charts-red); opacity: .8; background: transparent; }
  .badge.unknown { color: var(--vscode-charts-orange); background: color-mix(in srgb, var(--vscode-charts-orange) 14%, transparent); }
  .diff { font-family: var(--vscode-editor-font-family); font-size: 10px; font-weight: 650; flex-shrink: 0; }
  .diff .add { color: var(--vscode-charts-green); margin-right: 3px; }
  .diff .del { color: var(--vscode-charts-red); }
  /* 调用参数悬浮提示：单例浮层，替代原生 title（即时弹出、主题一致、可格式化） */
  #tip { position: fixed; z-index: 20; display: none; max-width: min(480px, calc(100vw - 16px)); max-height: min(320px, 60vh); overflow: auto; padding: 8px 11px; border-radius: 8px; font-family: var(--vscode-editor-font-family); font-size: 11px; line-height: 1.55; white-space: pre-wrap; word-break: break-all; color: var(--vscode-foreground); background: var(--vscode-editorHoverWidget-background, var(--vscode-sideBar-background)); border: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-panel-border)); box-shadow: 0 8px 24px rgba(0,0,0,.4); cursor: default; }
  .call .body { padding: 0 10px 9px; display: none; }
  .call.open .body { display: block; }
  /* 极细滚动条（页面级 + 展开卡片 <pre> 两级）：平时半透明 4px，hover 加深——
     存在感最小化，滚动能力不打折；webkit webview 的标准做法 */
  ::-webkit-scrollbar { width: 4px; height: 4px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--vscode-foreground) 18%, transparent); border-radius: 999px; }
  ::-webkit-scrollbar-thumb:hover { background: color-mix(in srgb, var(--vscode-foreground) 38%, transparent); }
  ::-webkit-scrollbar-corner { background: transparent; }
  .call pre { background: var(--vscode-textCodeBlock-background); padding: 8px 10px; border-radius: 6px; white-space: pre-wrap; word-break: break-all; max-height: 260px; overflow: auto; font-size: 11.5px; margin: 0; }
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
  .pager { flex-shrink: 0; z-index: 8; display: flex; align-items: center; gap: 8px; padding: 8px 12px; font-size: 11px; color: var(--vscode-descriptionForeground); background: var(--vscode-sideBar-background); border-top: 1px solid var(--vscode-panel-border); box-shadow: 0 -6px 18px rgba(0,0,0,.25); }
  .pager button { font-size: 11px; padding: 2px 10px; cursor: pointer; border: none; border-radius: 6px; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); font-family: inherit; }
  .pager button:disabled { opacity: .4; cursor: default; }
  .pager .info { flex: 1; text-align: center; }
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
    <div class="list" id="list"></div>
    <div class="pager" id="pager" style="display:none"></div>
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
      if (s.status === 'paused') return '<span class="st paused">◐ 已暂停</span>';
      if (cnt > 0) return '<span class="st await">● 待审批' + (cnt > 1 ? ' ×' + cnt : '') + '</span>';
      if (s.status !== 'active') return '<span class="st dim">' + esc(s.status) + '</span>';
      if (s.activity === 'running') return '<span class="st active">● 运行中' + (showLastToolAge ? '<span class="last-tool-age" id="lastToolAge"></span>' : '') + '</span>';
      if (s.activity === 'idle') return '<span class="st dim">◌ 空闲</span>';
      return '<span class="st dim">◌ 状态未知</span>';
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
        + '<button class="chanpill" id="chpill" title="渠道：点击打开设置页管理"><span class="d"></span><span id="chtxt">…</span></button>'
        + '<span class="sp"></span>'
        + '<button class="ib" id="create" title="创建会话">' + IC.plus + '</button>'
        + '<button class="ib" id="webagent" title="打开 Web Agent">' + IC.globe + '</button>'
        + '<button class="ib" id="settings" title="设置">' + IC.gear + '</button>'
        + '<button class="ib" id="refresh" title="刷新">' + IC.refresh + '</button>';
      $('chpill').addEventListener('click', () => vs.postMessage({ type: 'settings' }));
      $('create').addEventListener('click', () => vs.postMessage({ type: 'create' }));
      $('webagent').addEventListener('click', () => vs.postMessage({ type: 'webAgent' }));
      $('settings').addEventListener('click', () => vs.postMessage({ type: 'settings' }));
      $('refresh').addEventListener('click', () => vs.postMessage({ type: 'refresh' }));
    }

    function renderChannel(d) {
      const t = d.tunnel;
      const pill = $('chpill'), cherr = $('cherr');
      if (!pill) return;
      if (cherr) cherr.style.display = 'none';
      let cls = '', label = '渠道未启动';
      if (d.daemon !== 'running') { label = '未连接'; }
      else if (!t) { label = '渠道未启动'; }
      else if (t.status === 'online') { cls = 'ok'; label = t.mode === 'named' ? '持久在线' : '临时在线'; }
      else if (t.status === 'starting') { cls = 'warn'; label = '渠道启动中…'; }
      else if (t.status === 'error') { cls = 'bad'; label = '渠道启动失败'; }
      else if (t.status === 'unavailable') { cls = 'bad'; label = '渠道不可用'; }
      // OpenAI 渠道与 Cloudflare 并行：Cloudflare 未启动时单独显示 OpenAI，两条都在时并列。
      const oaMap = { ready: ['ok', 'OpenAI 就绪'], recovering: ['warn', 'OpenAI 恢复中'], starting: ['warn', 'OpenAI 启动中…'], stopping: ['warn', 'OpenAI 停止中…'], error: ['bad', 'OpenAI 失败'], unavailable: ['bad', 'OpenAI 不可用'] };
      const oa = d.daemon === 'running' && d.openai ? oaMap[d.openai] : null;
      if (oa && label === '渠道未启动') { cls = oa[0]; label = oa[1]; }
      else if (oa) { label += ' · ' + oa[1]; }
      pill.className = 'chanpill ' + cls;
      $('chtxt').textContent = label;
      if (cherr && t && t.reason && (t.status === 'starting' || t.status === 'error' || t.status === 'unavailable')) { cherr.style.display = 'block'; cherr.textContent = t.reason; }
    }

    // 列表节点常驻，任务区和分页均不参与它的滚动。
    const scroller = $('list');
    const saveScroll = () => scroller.scrollTop;
    const restoreScroll = (y) => { scroller.scrollTop = y; };

    // 会话列表整表重建：内容全部就绪后再恢复滚动位置。
    function renderSessions(d) {
      const scrollY = saveScroll();
      const list = scroller;
      list.innerHTML = '';
      list.dataset.mode = 'sessions';
      renderChannel(d);

      if (d.sessions.length === 0) {
        list.innerHTML = '<div class="empty">还没有会话。<br>创建一个，把整理好的提示词粘给网页 AI。<br></div>';
        const b = document.createElement('button');
        b.textContent = '+ 创建会话';
        b.addEventListener('click', () => vs.postMessage({ type: 'create' }));
        list.querySelector('.empty').appendChild(b);
        restoreScroll(scrollY);
        return;
      }
      for (const s of d.sessions) {
        const row = document.createElement('div');
        row.className = 'row';
        const folder = s.workspace_path.split(/[\\\\/]/).pop() || s.workspace_path;
        const name = s.name || folder;
        const isCur = d.currentRoot && s.workspace_path.toLowerCase() === d.currentRoot.toLowerCase();
        row.dataset.sessionId = s.id;
        row.innerHTML = '<span class="drag" draggable="true" title="拖动调整会话顺序" aria-label="拖动调整会话顺序"></span>'
          + '<div class="main"><div class="name"><span class="txt"></span></div><div class="sub"></div></div>'
          + sessionStatus(s, d)
          + '<button class="ract" title="会话操作">' + IC.more + '</button>';
        row.querySelector('.txt').textContent = name;
        handoffView.attach(row.querySelector('.name'), s);
        if (isCur) { const tag = document.createElement('span'); tag.className = 'cur'; tag.textContent = '当前'; row.querySelector('.name').appendChild(tag); }
        // 账本式副行：完整工作区路径 · 权限模式（状态移到行右侧彩字）
        const modeLabel = s.permission_mode === 'read-only' ? '只读' : s.permission_mode === 'danger-full-access' ? '完全访问' : '工作区可写';
        row.querySelector('.sub').textContent = s.workspace_path + ' · ' + modeLabel;
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
          const ids = d.sessions.map((item) => item.id);
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

    // expanded call cards survive the polling re-render: remember open ids
    const openCalls = new Set();
    const PAGE_SIZE = 20;
    let callPage = 0;
    // 当前端数：由扩展侧 callTotal 计算并随 update 下发（翻页点击的边界检查用）
    let totalPagesNow = 1;
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

    function createCard(c) {
      const card = document.createElement('div');
      card.className = 'call';
      card.dataset.id = c.id;
      card.innerHTML = '<div class="call-hd" role="button" tabindex="0" aria-expanded="false">'
        + '<span class="tool"></span><span class="scope"></span><span class="diff"></span>'
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
      const bk = ctx.badge + '|' + ctx.badgeText;
      if (card._badgeKey !== bk) {
        card._badgeKey = bk;
        const b = card.querySelector('span.badge');
        b.className = 'badge ' + ctx.badge;
        b.textContent = ctx.badgeText;
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
        if (card._body !== text) { card._body = text; card.querySelector('pre').textContent = text; }
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
      const pgPrev = cl('#pgPrev'), pgNext = cl('#pgNext');
      // 翻页：本地乐观改页码并上报，扩展侧按新页拉取后回推渲染；
      // webview 不再持有全量数据做本地切片，连点由扩展侧 refreshBusy 串行化兜底
      if (pgPrev) { if (callPage > 0) { callPage--; vs.postMessage({ type: 'callPage', page: callPage }); } return; }
      if (pgNext) { if (callPage < totalPagesNow - 1) { callPage++; vs.postMessage({ type: 'callPage', page: callPage }); } return; }
      const resource = cl('.resource');
      if (resource) {
        const card = resource.closest('.call');
        if (card && card.dataset.id) vs.postMessage({ type: 'openCallResource', id: card.dataset.id });
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
      // 上下文（会话 / 分页）变化才整批重建，否则走增量路径复用已有卡片
      const ctxKey = (d.selected ? d.selected.id : '') + '|' + callPage;
      const list = scroller;
      if (list.dataset.mode !== 'calls' || cardCtx !== ctxKey) {
        list.innerHTML = '';
        list.dataset.mode = 'calls';
        list.scrollTop = 0;
        cardById.clear();
        callIndex.clear();
        cardCtx = ctxKey;
      }
      if (d.calls.length === 0) {
        list.innerHTML = '<div class="empty">暂无工具调用 — 把提示词粘给网页 AI 后，调用会出现在这里。</div>';
        cardById.clear();
        callIndex.clear();
        lastCalls = d.calls;
        lastToolActivityAt = 0;
        renderLastToolAge();
        return;
      }
      // 空状态提示：增量路径下 list 不重建（ctxKey 未变），有数据后必须显式移除，
      // 否则「暂无工具调用」会残留在卡片下方
      const emptyEl = list.querySelector('.empty');
      if (emptyEl) emptyEl.remove();
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
      let prev = null;
      for (const c of pageCalls) {
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
        if (prev) { if (prev.nextSibling !== card) list.insertBefore(card, prev.nextSibling); }
        else if (list.firstChild !== card) list.insertBefore(card, list.firstChild);
        prev = card;
      }
      // 掉出本页的卡片移除（分页滚动 / 会话截断）
      for (const [id, card] of cardById) if (!seen.has(id)) { card.remove(); cardById.delete(id); callIndex.delete(id); }
      // 跨会话的展开状态由 message handler 的会话切换分支清理（openCalls.clear()）；
      // 同会话内 d.calls 只含当前页，拿它当 live 集合会误删其他页的展开状态
      lastCalls = d.calls;
    }

    // 分页节点在列表外常驻；总页数同时供点击处理的边界检查使用。
    function renderPager(d) {
      const pager = $('pager');
      // 页数按 anchor 窗口口径（windowTotal）：翻页边界与真实窗口一致，
      // 不会翻到取不到数据的"幽灵页"再被钳回末页
      const totalPages = d.mode === 'calls' ? Math.max(1, Math.ceil((d.callTotal || d.windowTotal || d.calls.length) / PAGE_SIZE)) : 1;
      totalPagesNow = totalPages;
      if (d.mode !== 'calls' || d.calls.length === 0 || totalPages <= 1) {
        pager.style.display = 'none';
        pager.innerHTML = '';
        delete pager.dataset.key;
        return;
      }
      pager.style.display = '';
      const pagerKey = totalPages + '|' + callPage + '|' + d.callTotal;
      if (pager.dataset.key === pagerKey) return;
      pager.dataset.key = pagerKey;
      pager.innerHTML = '<button id="pgPrev"' + (callPage === 0 ? ' disabled' : '') + '>‹ 上一页</button>'
        + '<span class="info">第 ' + (callPage + 1) + ' / ' + totalPages + ' 页 · 共 ' + (d.callTotal || d.calls.length) + ' 条</span>'
        + '<button id="pgNext"' + (callPage >= totalPages - 1 ? ' disabled' : '') + '>下一页 ›</button>';
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
      const items = [];
      items.push({ label: '复制提示词 · 连接器', msg: { type: 'copyTemplate', kind: 'connector', id } });
      items.push({ label: '复制提示词 · 沙箱直连', msg: { type: 'copyTemplate', kind: 'sandbox', id } });
      items.push({ sep: true });
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
      items.push({ label: s.status === 'paused' ? '恢复会话' : '暂停会话', msg: { type: 'action', action: s.status === 'paused' ? 'resume' : 'pause', id } });
      items.push({ label: '重置会话 ID', msg: { type: 'action', action: 'rotate', id } });
      items.push({ label: '终止会话', danger: true, msg: { type: 'action', action: 'revoke', id } });
      ctx.innerHTML = '';
      for (const it of items) {
        if (it.sep) { const sp = document.createElement('div'); sp.className = 'sep'; ctx.appendChild(sp); continue; }
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
      if (d.type !== 'update') return;
      const focusedHandoff = document.activeElement?.dataset.handoffAction !== undefined ? { ...document.activeElement.dataset } : null;
      handoffView.render(d);
      // reset pagination when entering a different session/list mode
      const modeChanged = cur.mode !== d.mode;
      // 离开 sessions 前记住其滚动位置，切回时还原（见 renderSessions 尾部）
      if (modeChanged && cur.mode === 'sessions') savedSessionsScroll = scroller.scrollTop;
      if (modeChanged || (d.mode === 'calls' && cur.selected && d.selected && cur.selected.id !== d.selected.id)) {
        openCalls.clear();
        // calls 进入始终从顶部；切回 sessions 的位置由 renderSessions 还原
        if (d.mode === 'calls') scroller.scrollTop = 0;
      }
      // 页码以扩展侧为准（showCalls 重置 / 翻页上报 / 越界钳制都发生在那边）
      callPage = d.callPage || 0;
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
      renderPager(d);
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
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
  }
}
