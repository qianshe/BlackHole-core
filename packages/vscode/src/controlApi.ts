import type { ProcessSyncInput, ProcessSyncResult, ProcessStopInput, ProcessViewItem } from './processTypes';
import { apiBase, type ExtConfig } from './config';
import type { AuthView, Credential } from './cloudAuthClient';

/**
 * Today's usage counters attached to /health by the daemon (0-point local
 * cutoff). `mcp_*` count protocol-level behavior (MCP handshakes, HTTP DELETE
 * against /mcp) — the signal for agents that re-initialize or DELETE heavily.
 */
export interface DailyStats {
  total: number;
  diff_added: number;
  diff_removed: number;
  mcp_initializes: number;
  mcp_reuses: number;
  mcp_rejected: number;
  mcp_deletes: number;
  /** Live parked protocol pipes + daemon process memory. */
  mcp_live_pipes: number;
  rss_mb: number;
  heap_mb: number;
}

export interface ActivityDay {
  start: number;
  total: number;
  diff_added: number;
  diff_removed: number;
}

export interface ExecutionRuntime {
  platform: string;
  arch: string;
  execution_tools: Array<'exec' | 'process'>;
  exec_shell: string | null;
  process_shell: string | null;
  process_available: boolean;
  process_unavailable_reason: string | null;
  sandbox: {
    backend: 'none' | 'bubblewrap' | 'seatbelt' | 'windows-acl';
    status: 'available' | 'unavailable' | 'deferred' | 'unsupported';
    reason: string | null;
    detail: string | null;
    fail_closed: true;
  };
  process_management: {
    owner: 'job-object' | 'process-group-supervisor' | 'unavailable';
    cleanup_guarantee: 'kernel-owned' | 'confirmed-or-unknown' | 'unavailable';
  };
}
export interface Health {
  ok: boolean;
  version: string;
  /** Fingerprint of the extension/configuration that spawned this daemon. Older daemons omit it. */
  start_fingerprint?: string;
  /** Plan 6.11: daemon-owned account API and whether its OS credential store works. Older daemons omit both. */
  account_api_version?: number;
  account_storage?: 'available' | 'unavailable';
  cloud_origin?: string;
  /** v2.6 daemon 身份（版本-启动时刻-pid）：工具列表与它绑定，变了即作废旧数据。 */
  daemon_id?: string;
  /** Daemon-owned settings revision; a change means another client edited them. Older daemons omit it. */
  settings_revision?: number;
  /** 局域网直连状态（旧版守护进程没有这一项）。 */
  lan_access?: { enabled: boolean; port: number; listening: boolean; error: string | null; addresses: string[]; mcp_path: string } | null;
  /** v2.6 工具表面代次：reload/目录刷新/预热即自增 → 设置页自动重取工具列表。 */
  proxy_surface_gen?: number | null;
  /** v2.6 MCP 主机连接代次：每次握手（重连）自增 → 设置页自动重新获取工具列表。 */
  mcp_conn_gen?: number;
  public_base_url: string | null;
  tunnel: string;
  tunnel_mode: 'quick' | 'named' | null;
  tunnel_url: string | null;
  tunnel_reason: string | null;
  /** Machine-level and stable: every session on this host shares this MCP URL. */
  mcp_url: string;
  /** Stable path suffix for custom temporary public channels. */
  mcp_path?: string;
  /** Machine-level command execution, sandbox and process-ownership diagnostics. */
  execution_runtime?: ExecutionRuntime;
  stats?: DailyStats;
  activity_days?: ActivityDay[];
  /** Hover extras: daemon age, live workload, approval picture. */
  uptime_min: number;
  sessions_active: number;
  /** Running activity, not merely unpaused sessions; absent on older daemons. */
  sessions_running?: number;
  approvals_pending: number;
  approvals_denied: number;
  /** OpenAI Secure MCP Tunnel runtime (plan §5); older daemons omit both. */
  openai_tunnel_api_version?: number;
  openai_tunnel?: OpenAITunnelView;
}

export type OpenAITunnelStatus = 'off' | 'starting' | 'ready' | 'recovering' | 'stopping' | 'error' | 'unavailable';
/** Daemon-side OpenAI tunnel view: never carries the API key or the machine MCP URL. */
export interface OpenAITunnelView {
  status: OpenAITunnelStatus;
  run_id: string | null;
  active_tunnel_id: string | null;
  /** null = the OS credential store could not be read. */
  credential_configured: boolean | null;
  credential_revision: number;
  pending_restart: boolean;
  reason_code: string | null;
  reason: string | null;
  client_version: string | null;
  started_at: string | null;
  ready_at: string | null;
}

export type TunnelKind = 'quick' | 'named';

/** 批准范围：once 仅本次 / session 本会话内 / always daemon 存续期内。 */
export type ApprovalScope = 'once' | 'session' | 'always';

export interface TunnelState {
  status: string;
  url: string | null;
  mode: TunnelKind | null;
  reason: string | null;
}

/** 渠道总开关（daemon GET /channel）：开 = 启动上次使用的渠道，关 = 停止所有渠道。 */
export type ChannelChoice = TunnelKind | 'openai';
export interface ChannelSwitchView {
  on: boolean;
  state: 'off' | 'starting' | 'on' | 'warn' | 'error';
  running: ChannelChoice[];
  /** 正在运行的渠道；关着时为打开会启动的渠道。 */
  next: ChannelChoice;
  last: ChannelChoice | null;
  missing: 'cloudflared' | 'named_url' | 'openai_setup' | 'openai_unavailable' | null;
  reason: string | null;
}

export type PermissionMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface HandoffSummary { id: string; created_at: number; }

export interface SessionInfo {
  /** Missing on older daemons; null confirms no pending context. */
  pending_handoff?: HandoffSummary | null;
  id: string;
  /** Current numeric credential: the `sessionId` argument of every work-tool call. */
  session_id: string;
  /** Task text typed at creation; shown as the session name, lands in prompt templates. */
  name: string | null;
  workspace_path: string;
  status: 'active' | 'paused' | 'revoked' | 'archived';
  /** Older daemons omit activity; never infer it from channel connectivity. */
  activity?: 'idle' | 'running';
  permission_mode: PermissionMode;
  /** Reserved, not stored yet: the first tool call stores it, closing it discards it (older daemons omit it). */
  draft?: boolean;
  created_at: string;
  last_active_at: string;
}

export interface PendingHandoff {
  id: string;
  content: string;
  created_at: number;
}

export interface HandoffSnapshot {
  handoff: PendingHandoff | null;
  available: boolean;
  session: SessionInfo;
  mcp_url: string;
  /** Status only; older daemons omit it. Lets handoff accept URL-free connector prompts over OpenAI. */
  openai_tunnel?: { status: OpenAITunnelStatus } | null;
}

export interface CreatedSession extends SessionInfo {
  mcp_url: string;
}

export interface CallRow {
  seq?: number;
  id: string;
  session_id: string;
  tool: string;
  args_json: string;
  args_hash: string;
  status: 'started' | 'awaiting' | 'completed' | 'failed' | 'denied' | 'unknown';
  result_summary: string | null;
  /** Versioned local navigation metadata for editor calls. */
  navigation_json?: string | null;
  /** 该调用经何种范围获得批准；NULL = 未经审批（或被拒绝）。 */
  approval_scope?: ApprovalScope | null;
  created_at: number;
  updated_at: number;
}

/** 风险命中（daemon riskMatches 预计算）：标签 + 命令内高亮区间。 */
export interface RiskMatch {
  label: string;
  /** 级别派生色：red=critical / yellow=warn / blue=info。 */
  tone: 'red' | 'yellow' | 'blue';
  /** 严重级别（工作区外路径报 warn）。 */
  level: 'critical' | 'warn' | 'info';
  /** [start, end) 字符偏移，作用于 args_json 里的 command 文本。 */
  range: [number, number];
}

export interface ConfirmationInfo {
  id: string;
  session_id: string;
  tool: string;
  args_json: string;
  args_hash: string;
  status: string;
  /** 最终生效 scope；critical 的 always 请求会由 daemon 降级为 session。 */
  scope?: ApprovalScope | null;
  created_at: number;
  expires_at: number;
  /** 审批卡的风险标签/高亮数据；null = 事件已过保留期或旧版本记录。 */
  risk_matches?: RiskMatch[] | null;
}

export interface ApprovalGrantsInfo {
  always: string[];
  sessions: {
    session_id: string;
    session_name: string | null;
    workspace_path: string | null;
    grants: string[];
  }[];
}

/** 任务清单条目（MCP `todo` 工具的存储形态）。 */
export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  /** 进行中时面板优先显示的进行时文案；缺省回退 content。 */
  activeForm?: string;
}

export interface TaskContract {
  goal: string;
  nonGoals: string[];
  successCriteria: string[];
  verification: string[];
}

export interface TodoBoard {
  items: TodoItem[];
  contract?: TaskContract;
  updated_at: number;
}

export type SessionAction = 'pause' | 'resume' | 'revoke' | 'rotate';

/** GET /api/semantic：daemon 启动时的注册状态 + 现在重启后会变成的状态。 */
export interface SemanticInfo {
  registered: boolean;
  registered_source: string;
  registered_detail: string;
  registered_preview: string;
  engine: string;
  mode: string;
  key_file: string;
  timeout_ms: number;
  would_resolve: boolean;
  would_source: string;
  would_detail: string;
}

/** GET /api/proxies 的单 server 运行状态行。 */
export interface ProxyStatusRow {
  name: string;
  status: 'offline' | 'starting' | 'online' | 'degraded' | 'crashed' | 'config_error' | 'disabled';
  tools: string[];
  catalogCount?: number | null;
  /** degraded 时：配置要求暴露但上游未提供的工具。 */
  missingTools?: string[];
  /** crashed / config_error 时的原因。 */
  reason?: string;
}

/** GET /api/proxies 的单 server 配置掩码投影（只读；env 值恒为 ***）。 */
export interface ProxyConfigRow {
  name: string;
  transport: string;
  url?: string;
  command: string;
  args: string[];
  env: { inherit: string[]; set: Record<string, string>; setFromFile?: Record<string, string> };
  surface: { expose?: string[]; aliases?: Record<string, string> };
  risk: Record<string, 'allow' | 'confirm' | 'deny'>;
  approvalUnits: Record<string, 'tool' | 'args'>;
  redactPaths: string[];
  sensitiveKeys: string[];
  scope: 'session' | 'shared';
  profile: string | null;
  /** profile 专属命名空间（browser profile 的白名单；null = 未配置）。 */
  browser?: { allowedDomains: string[] } | null;
  limits: Partial<{ connectTimeoutMs: number; callTimeoutMs: number; approvalTimeoutMs: number; maxChildren: number }> | null;
  prewarm: 'never' | 'on_session_start';
  warnings: string[];
}

/** GET /api/proxies：MCP proxy 只读投影（设置页唯一读取形态）。 */
export interface ProxiesInfo {
  configured: boolean;
  /** v2.6：这份投影所属的 daemon 身份（与 health.daemon_id 比对）。 */
  daemonId?: string;
  /** v2.6：这份投影对应的表面代次。 */
  surfaceGen?: number | null;
  status?: ProxyStatusRow[];
  config?: ProxyConfigRow[];
  warnings?: { name: string; reason: string }[];
  /** enabled=false 的 server 名（设置页渲染「已停用」徽标 + 启用按钮）。 */
  disabled?: string[];
}

/** POST /api/proxies/config/fields 的 reload 报告（hot/recycled/added/removed 为 server 名）。 */
export interface ProxiesEditReport {
  written: boolean;
  report: {
    hot: string[];
    recycled: string[];
    added: string[];
    removed: string[];
    policyGen: number;
  };
}

/** POST /api/proxies/revalidate：只报告，不改运行状态。 */
export interface ProxiesRevalidateReport {
  servers: { name: string; transport: string; ok: boolean }[];
  quarantined: { name: string; reason: string }[];
  warnings: { name: string; reason: string }[];
  note: string;
}

/** POST /api/proxies/tools 的单条工具行（v2.6）。 */
export interface ProxyToolRow {
  /** Agent-visible tool name（alias 已生效）。 */
  name: string;
  /** 实际 upstream canonical tool，仅 operator UI 可见。 */
  upstreamTool: string;
  /** 上游描述（已过脱敏管道 + 截断）。 */
  description: string;
  /** Whether the operator exposes this canonical tool. */
  enabled?: boolean;
  /** False for a hidden tool or a conflicting exposed name. */
  callable: boolean;
  /** 冲突来源 MCP 名，仅 operator UI 展示。 */
  conflictSources: string[];
}

/** POST /api/proxies/tools：单个 MCP 的工具目录（缓存优先；refresh 才实时拉取）。 */
export interface ProxyToolsResult {
  configured: boolean;
  /** 产出这份数据的 daemon 身份：与当前 health.daemon_id 不符即视为过期，丢弃。 */
  daemonId?: string;
  /** 产出这份数据时的表面代次（与 health.proxy_surface_gen 比对，判断是否需重取）。 */
  surfaceGen?: number | null;
  name: string;
  /** true = 该 MCP 处于停用态（配置保留，仅按缓存展示）。 */
  disabled: boolean;
  /** true = 本次未实时拉取（缓存或停用），false = 实时结果。 */
  cachedOnly: boolean;
  tools: ProxyToolRow[];
  /** expose 显式列出但上游没有的工具（degraded 依据）。 */
  missing?: string[];
  /** catalog 缓存年龄（ms）；无缓存 null。 */
  ageMs?: number | null;
  /** 拉取失败原因（此时 tools 回退为缓存）。 */
  error?: string;
  note?: string;
}

/** Daemon-owned settings as served by /api/settings. */
export interface DaemonSettings {
  revision: number;
  migrated: boolean;
  values: Record<string, unknown>;
  updated_at: string | null;
  pending_restart: string[];
  /** Keys a newer daemon still accepts one first copy for (absent on older daemons). */
  unseeded?: string[];
}

/** Thin loopback client for the daemon's /api control plane. */
export interface RemoteDevice { id: string; name: string; created_at: string; last_seen_at: string }
export interface RemoteView {
  enabled: boolean;
  available: boolean;
  reason: string | null;
  origin: string | null;
  kind: 'quick' | 'fixed' | null;
  devices: RemoteDevice[];
  /** phones that scanned the code and wait for 允许 on this computer */
  requests?: { id: string; name: string; created_at: string; expires_at: string }[];
}

/** A web chat bound in the Courier browser extension (GET /api/courier). */
export interface CourierTargetView {
  targetId: string;
  site: string;
  label: string;
  conversationKey: string | null;
  open: boolean;
  ready: boolean | null;
  busy: boolean | null;
  draft: boolean | null;
  model: string | null;
  /** Title of an open Arena rating card, null when none. */
  card?: string | null;
  sessionId: string | null;
}
/** A site Courier can open a new chat on: builtins (arena, chatgpt) first, then sites added in Courier. */
export interface CourierSiteChoice { id: string; name: string; custom: boolean }
/** How a session reaches its web chat (see the daemon's CourierPairs). */
export type SessionLink = 'new' | 'paired' | 'unpaired' | 'direct';
export interface CourierSendResult { ok: boolean; code?: string; message: string; sent: boolean; targetId?: string }
/** Result of asking the bound chat to press its own stop control (POST /courier/stop). */
export interface CourierStopResult { ok: boolean; code?: string; message: string }

/** One entry of a session's Chat thread (GET /api/courier/messages). */
export interface CourierMessageView {
  id: string;
  kind: 'user' | 'agent';
  text: string;
  at: number;
  status: 'sent' | 'unconfirmed' | 'failed' | 'reply' | 'streaming';
  site: string | null;
  targetId: string | null;
  code?: string;
  message?: string;
  model?: string;
  /** The web agent asked a question with options: answer with an option label, 跳过 or free text. */
  question?: { title: string; options: string[]; skip: boolean; input: boolean; answered?: boolean; answer?: string };
}

export class ControlApi {
  constructor(private readonly cfg: () => ExtConfig) {}

  settings(): Promise<DaemonSettings> {
    return this.req('GET', '/settings', undefined, 4000);
  }

  /** `revision` makes the write conditional (409 revision_conflict when the daemon moved on). */
  patchSettings(values: Record<string, unknown>, revision?: number): Promise<DaemonSettings> {
    return this.req('PATCH', '/settings', revision === undefined ? { values } : { values, revision }, 4000);
  }

  remoteView(): Promise<RemoteView> {
    return this.req('GET', '/remote', undefined, 4000);
  }

  remotePair(): Promise<{ url: string; expires_at: string; kind: string }> {
    return this.req('POST', '/remote/pair', undefined, 4000);
  }

  remoteDecide(id: string, allow: boolean): Promise<RemoteView> {
    return this.req('POST', `/remote/requests/${encodeURIComponent(id)}`, { allow }, 4000);
  }

  remoteRevoke(id: string): Promise<RemoteView> {
    return this.req('POST', `/remote/devices/${encodeURIComponent(id)}/revoke`, undefined, 4000);
  }

  migrateSettings(values: Record<string, unknown>): Promise<DaemonSettings> {
    return this.req('POST', '/settings/migrate', { values }, 4000);
  }

  processSync(input: ProcessSyncInput): Promise<ProcessSyncResult> {
    return this.req('POST', '/processes/sync', input, 4000);
  }

  processStop(input: ProcessStopInput): Promise<Pick<ProcessViewItem, 'state' | 'reason' | 'exitCode'>> {
    return this.req('POST', '/processes/stop', input, 8000);
  }

  openaiTunnel(): Promise<OpenAITunnelView> { return this.req('GET', '/openai-tunnel', undefined, 4000); }
  openaiTunnelStart(daemonId: string, settingsRevision: number, credentialRevision: number): Promise<OpenAITunnelView> {
    return this.req('POST', '/openai-tunnel/start', { daemon_id: daemonId, settings_revision: settingsRevision, credential_revision: credentialRevision }, 20_000);
  }
  openaiTunnelStop(daemonId: string, runId: string | null): Promise<OpenAITunnelView> {
    return this.req('POST', '/openai-tunnel/stop', { daemon_id: daemonId, run_id: runId }, 10_000);
  }
  openaiTunnelSetKey(daemonId: string, credentialRevision: number, apiKey: string): Promise<Pick<OpenAITunnelView, 'credential_configured' | 'credential_revision' | 'pending_restart'>> {
    return this.req('PUT', '/openai-tunnel/credential', { daemon_id: daemonId, credential_revision: credentialRevision, api_key: apiKey }, 15_000);
  }
  openaiTunnelClearKey(daemonId: string, credentialRevision: number): Promise<Pick<OpenAITunnelView, 'credential_configured' | 'credential_revision'>> {
    return this.req('DELETE', '/openai-tunnel/credential', { daemon_id: daemonId, credential_revision: credentialRevision }, 20_000);
  }
  openaiTunnelDiagnostics(): Promise<Record<string, unknown>> { return this.req('GET', '/openai-tunnel/diagnostics', undefined, 8000); }


  private async req<T>(method: string, path: string, body?: unknown, timeoutMs = 8_000, port = this.cfg().port): Promise<T> {
    const res = await fetch(`${apiBase(port)}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) {
      // status 附在错误对象上：调用方按码分支（如 cancel 的 404 静默忽略）
      const err = new Error(typeof json.error === 'string' ? json.error : `HTTP ${res.status}`) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }
    return json;
  }

  account(): Promise<AuthView & { storage?: string }> { return this.req('GET', '/account', undefined, 5000); }
  accountSignIn(): Promise<{ state: string }> { return this.req('POST', '/account/sign-in', {}, 5000); }
  accountSignInState(): Promise<{ state: string; error?: string }> { return this.req('GET', '/account/sign-in', undefined, 5000); }
  accountSignInCancel(): Promise<{ state: string }> { return this.req('POST', '/account/sign-in/cancel', {}, 5000); }
  accountCall(method: string, args: unknown[]): Promise<{ result: unknown }> { return this.req('POST', '/account/call', { method, args }, 30_000); }
  accountMigrate(credential: Credential): Promise<{ migrated: boolean; reason?: string }> { return this.req('POST', '/account/migrate', { credential }, 10_000); }

  entitlement(action:'identity'|'claim'|'complete'|'fail'|'refresh',body:unknown={}):Promise<{pending?:{challenge:string;sessionId:string}|null;ok?:boolean;daemon_id?:string}> {
    return this.req('POST','/entitlement/'+action,body);
  }

  /** `links`: per live session — new (composer opens a ChatGPT chat), paired, unpaired / direct (receive only). */
  courierStatus(cached = false): Promise<{ connected: boolean; targets: CourierTargetView[]; links?: Record<string, SessionLink>; sites?: CourierSiteChoice[] }> {
    return this.req('GET', cached ? '/courier?cached=1' : '/courier', undefined, 6000);
  }

  /** Waits for the page to confirm (the daemon gives up after 45 s). */
  courierSend(body: { targetId: string; sessionId: string; text: string }): Promise<CourierSendResult> {
    return this.req('POST', '/courier/send', body, 50_000);
  }

  /** Asks the bound chat to press its own stop control (the page does the clicking; 12 s daemon cap). */
  courierStop(body: { targetId: string; sessionId: string }): Promise<CourierStopResult> {
    return this.req('POST', '/courier/stop', body, 20_000);
  }

  /** Answers the paired chat's open rating card with the auto-rate rule (15 s daemon cap). */
  courierCard(body: { sessionId: string; targetId?: string }): Promise<CourierStopResult> {
    return this.req('POST', '/courier/card', body, 25_000);
  }

  /** Force-reloads the paired chat (a closed one is reopened; 40 s daemon cap). */
  courierReload(sessionId: string): Promise<CourierStopResult> {
    return this.req('POST', '/courier/reload', { sessionId }, 50_000);
  }

  /** Chat thread of one session: sent messages and web agent replies. */
  /** One sent image as a data: URL (the sidebar webview has no network); null when gone. */
  async courierImage(messageId: string, n: number): Promise<string | null> {
    const res = await fetch(`${apiBase(this.cfg().port)}/courier/images/${encodeURIComponent(messageId)}/${n}`, { signal: AbortSignal.timeout(8000) });
    const mime = res.headers.get('content-type') ?? '';
    if (!res.ok || !/^image\/(png|jpeg|gif|webp)$/.test(mime)) return null;
    return `data:${mime};base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`;
  }

  courierMessages(sessionId: string): Promise<{ messages: CourierMessageView[] }> {
    return this.req('GET', `/courier/messages?sessionId=${encodeURIComponent(sessionId)}`, undefined, 6000);
  }

  /**
   * Live thread updates of one session (server-sent events): every added or updated message,
   * including reply text while it streams. Resolves when the daemon ends the stream.
   */
  async courierStream(sessionId: string, onMessage: (m: CourierMessageView) => void, signal: AbortSignal): Promise<void> {
    const res = await fetch(`${apiBase(this.cfg().port)}/courier/stream?sessionId=${encodeURIComponent(sessionId)}`, { signal, headers: { accept: 'text/event-stream' } });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += dec.decode(value, { stream: true });
      for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
        const data = buf.slice(0, i).split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
        buf = buf.slice(i + 2);
        if (!data) continue;
        try { onMessage(JSON.parse(data) as CourierMessageView); } catch { /* malformed event: skip */ }
      }
    }
  }

  /** First message of a session without a web chat: Courier opens one, binds it and sends. */
  /** template 'connector': `text` is the typed message; the daemon wraps it in the connector prompt. */
  courierStart(body: { sessionId: string; text: string; site?: string; display?: string; template?: 'connector' | 'sandbox' }): Promise<CourierSendResult> {
    return this.req('POST', '/courier/start', body, 100_000);
  }

  /** Cut a session's pairing with its web chat; the session stays and only receives afterwards. */
  courierUnpair(sessionId: string): Promise<{ ok: boolean; message: string }> {
    return this.req('POST', '/courier/unpair', { sessionId }, 10_000);
  }

  private readonly healthWatchers = new Set<(h: Health) => void>();
  /** Observe every health answer (status bar, sidebar and daemon polls share one request). */
  onHealth(fn: (h: Health) => void): { dispose(): void } {
    this.healthWatchers.add(fn);
    return { dispose: () => { this.healthWatchers.delete(fn); } };
  }

  health(timeoutMs = 8_000, port = this.cfg().port): Promise<Health> {
    return this.req<Health>('GET', '/health', undefined, timeoutMs, port).then((h) => {
      for (const fn of this.healthWatchers) { try { fn(h); } catch { /* observers never break health */ } }
      return h;
    });
  }

  listSessions(): Promise<{ sessions: SessionInfo[] }> {
    return this.req('GET', '/sessions');
  }

  reorderSessions(ids: string[]): Promise<{ sessions: SessionInfo[] }> {
    return this.req('POST', '/sessions/reorder', { ids });
  }

  createSession(workspacePath: string, name?: string, draft = false): Promise<CreatedSession> {
    return this.req('POST', '/sessions', {
      workspace_path: workspacePath,
      permission_mode: 'workspace-write',
      ...(name && name.trim() ? { name: name.trim() } : {}),
      ...(draft ? { draft: true } : {}),
    });
  }

  /** Rename a session; an empty name goes back to the default title. */
  renameSession(id: string, name: string): Promise<SessionInfo> {
    return this.req('PATCH', `/sessions/${encodeURIComponent(id)}/name`, { name });
  }

  getSession(id: string): Promise<SessionInfo> {
    return this.req('GET', `/sessions/${encodeURIComponent(id)}`);
  }

  sessionAction(id: string, action: SessionAction): Promise<SessionInfo & { mcp_url?: string }> {
    return this.req('POST', `/sessions/${encodeURIComponent(id)}/${action}`);
  }

  setSessionMode(id: string, mode: PermissionMode): Promise<SessionInfo> {
    return this.req('PATCH', `/sessions/${encodeURIComponent(id)}/mode`, { permission_mode: mode });
  }

  calls(id: string, after = 0, updatedAfter = 0): Promise<{ calls: CallRow[]; next_after: number }> {
    return this.req('GET', `/sessions/${encodeURIComponent(id)}/calls?after=${after}&updated_after=${updatedAfter}`);
  }

  /** 浏览分页：按锚定 seq 窗口取一页。anchor=0 表示未锚定，响应里的 max_seq 供首次锚定。 */
  callsPage(id: string, page: number, anchor: number, limit = 20): Promise<{ calls: CallRow[]; total: number; window_total?: number; max_seq: number }> {
    return this.req('GET', `/sessions/${encodeURIComponent(id)}/calls?anchor=${anchor}&page=${page}&limit=${limit}`);
  }

  /**
   * 会话 feed / history 的 GET（session-feed 计划 §7）：`path` 从 /sessions/... 开始。长轮询会挂起最多 wait 秒，
   * 所以超时要由调用方按 (wait+10) 秒传入（默认的 8 秒会把它掰断）；`signal` 中止时立即结束。
   * HTTP 失败抛带数字 `status` 的错误，网络错误没有 status。
   */
  async feedJson(path: string, signal: AbortSignal, timeoutMs: number): Promise<unknown> {
    const ctl = new AbortController();
    const onAbort = (): void => ctl.abort();
    if (signal.aborted) ctl.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(`${apiBase(this.cfg().port)}${path}`, { signal: ctl.signal });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const code = (json as { error?: unknown } | null)?.error;
        throw Object.assign(new Error(typeof code === 'string' ? code : `HTTP ${res.status}`), { status: res.status });
      }
      return json;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }

  handoff(id: string): Promise<HandoffSnapshot> {
    return this.req('GET', `/sessions/${encodeURIComponent(id)}/handoff`);
  }

  todos(id: string): Promise<TodoBoard> {
    return this.req('GET', `/sessions/${encodeURIComponent(id)}/todos`);
  }

  /** 变更门控：epoch 与上次相同 = 没有任何新东西，无需拉明细。 */
  changes(): Promise<{ epoch: number }> {
    return this.req('GET', '/changes');
  }

  semanticInfo(): Promise<SemanticInfo> {
    return this.req('GET', '/semantic');
  }

  semanticSaveKey(key: string): Promise<{ saved: boolean; key_file: string; note: string }> {
    return this.req('POST', '/semantic/key', { key });
  }

  semanticClear(): Promise<{ removed: boolean; key_file: string; note: string }> {
    return this.req('POST', '/semantic/clear', {});
  }

  /** MCP proxy 只读投影：运行状态 + 配置掩码（env 值已由 daemon 掩码为 ***）。 */
  proxies(): Promise<ProxiesInfo> {
    return this.req('GET', '/proxies');
  }

  /** 重跑启动同款校验管道：只报告，不改运行状态。 */
  proxiesRevalidate(): Promise<ProxiesRevalidateReport> {
    return this.req('POST', '/proxies/revalidate');
  }

  /** POST /api/proxies/add：新增 MCP server（表单字段，服务端校验+原子写回+热加载）。 */
  proxiesAdd(server: Record<string, unknown>): Promise<{ added: boolean; starting?: boolean; warning?: string }> {
    return this.req('POST', '/proxies/add', server);
  }

  /** POST /api/proxies/import：导入 Claude/Cursor 通用 mcpServers JSON。 */
  proxiesImport(json: string): Promise<{ imported: string[]; failed: { name: string; error: string; kept?: boolean }[] }> {
    return this.req('POST', '/proxies/import', { json });
  }

  /** POST /api/proxies/config/fields：白名单字段引导式编辑（服务端原位合并 + 原子写回 + 热加载）。 */
  proxiesEditFields(server: string, fields: Record<string, unknown>): Promise<ProxiesEditReport> {
    return this.req('POST', '/proxies/config/fields', { server, fields });
  }

  /**
   * POST /api/proxies/tools：单个 MCP 的工具目录（v2.6）。
   * 默认缓存优先（秒开、不启动上游）；`refresh=true` 才按需真实拉起上游拉取最新列表
   * ——首次 npx 下载可能很慢，故刷新走 65s 超时（与探活窗口同量级）。
   */
  proxiesTools(server: string, refresh = false): Promise<ProxyToolsResult> {
    return this.req('POST', '/proxies/tools', { server, refresh }, refresh ? 65_000 : 8_000);
  }

  /** POST /api/proxies/remove：从 mcp-proxies.yaml 摘除该 MCP（与「停用」分离）。 */
  proxiesRemove(server: string): Promise<{ removed: boolean }> {
    return this.req('POST', '/proxies/remove', { server });
  }

  confirmations(): Promise<{ confirmations: ConfirmationInfo[] }> {
    return this.req('GET', '/confirmations');
  }

  resolveConfirmation(id: string, action: 'approve' | 'deny', scope?: ApprovalScope): Promise<ConfirmationInfo> {
    return this.req('POST', `/confirmations/${encodeURIComponent(id)}/${action}`, action === 'approve' && scope ? { scope } : undefined);
  }

  /**
   * Cancel a proxy call (pending approval or in-flight upstream). 404 means
   * there is nothing cancellable left — callers silence that case.
   * `sessionId` should be supplied whenever known: the daemon uses it to check
   * that the call actually belongs to that session (call ids are sequential
   * tool-call row ids, so an unchecked id could cancel another session's call).
   */
  cancelCall(callId: string, sessionId?: string): Promise<{ cancelled: boolean }> {
    return this.req('POST', `/calls/${encodeURIComponent(callId)}/cancel`, sessionId === undefined ? undefined : { session_id: sessionId });
  }

  /** Effective standing grants: persistent machine-wide + in-memory per-session. */
  approvalGrants(): Promise<ApprovalGrantsInfo> {
    return this.req('GET', '/approvals');
  }

  /** Backward-compatible machine-wide view used by the status bar. */
  async alwaysGrants(): Promise<{ always: string[] }> {
    const grants = await this.approvalGrants();
    return { always: grants.always };
  }

  clearAlwaysGrants(): Promise<{ removed: number }> {
    return this.req('POST', '/approvals/clear', undefined);
  }

  removeAlwaysGrant(key: string): Promise<{ removed: number }> {
    return this.req('POST', `/approvals/${encodeURIComponent(key)}/remove`, undefined);
  }

  removeSessionGrant(sessionId: string, key: string): Promise<{ removed: number }> {
    return this.req('POST', '/approvals/session/remove', { session_id: sessionId, key });
  }

  tunnelStart(mode: TunnelKind): Promise<TunnelState> {
    return this.req('POST', '/tunnel/start', { mode });
  }

  tunnelStop(): Promise<TunnelState> {
    return this.req('POST', '/tunnel/stop');
  }

  /** 渠道总开关状态；旧版 daemon 没有这个接口时抛错（调用方按「不显示开关」处理）。 */
  channel(): Promise<ChannelSwitchView> {
    return this.req('GET', '/channel', undefined, 4000);
  }

  /** 开/关渠道总开关。缺少前提（409）或参数不对（400）时返回错误码，不抛错。 */
  async channelSwitch(on: boolean): Promise<{ ok: true; view: ChannelSwitchView } | { ok: false; error: string }> {
    try {
      return await this.req<{ ok: true; view: ChannelSwitchView }>('POST', '/channel', { on }, 20_000);
    } catch (e) {
      const err = e as Error & { status?: number };
      if (err.status === 409 || err.status === 400) return { ok: false, error: err.message };
      throw e;
    }
  }

  /**
   * Rotate the machine-level MCP token. The daemon persists the new value;
   * the old `/mcp/<token>` URL stops working immediately — connectors must be
   * re-configured with the new URL.
   */
  rotateMcpToken(): Promise<{ mcp_url: string }> {
    return this.req('POST', '/token/rotate');
  }

  /** Keep the channel watchdog fed while this extension host is alive. */
  heartbeat(): Promise<{ ok: boolean }> {
    return this.req('POST', '/heartbeat');
  }

  /** One-time login ticket for the local Web page (60 s, single use). */
  webBootstrap(): Promise<{ ticket: string; path: string; expires_at: string }> {
    return this.req('POST', '/web/bootstrap');
  }

  shutdown(daemonId: string, startFingerprint: string | null, port = this.cfg().port): Promise<{ ok: boolean }> {
    return this.req('POST', '/shutdown', { daemon_id: daemonId, start_fingerprint: startFingerprint }, 8_000, port);
  }
}
