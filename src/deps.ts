import type { ExecutionEnvironment } from './execution.js';
import type { ProcessManager } from './process/manager.js';
import type { EntitlementGate } from './cloud/entitlement-gate.js';
import type { AccountService } from './account/service.js';
import type { Config } from './config.js';
import type { SessionRuntime } from './runtime.js';
import type { SessionActivity } from './session-activity.js';
import type { ChangeTracker } from './storage/changes.js';
import type { ConfirmationsRepo } from './storage/confirmations.js';
import type { EventsRepo } from './storage/events.js';
import type { MachineStateRepo } from './storage/machineState.js';
import type { Settings, SettingsStore } from './settings/store.js';
import type { SessionsRepo } from './storage/sessions.js';
import type { TodosRepo } from './storage/todos.js';
import type { HandoffsRepo } from './storage/handoffs.js';
import type { ToolCallsRepo } from './storage/toolCalls.js';
import type { TunnelManager } from './tunnel/manager.js';
import { deriveAccessToken } from './util/token.js';
import type { SemanticProbe } from './semantic/index.js';
import type { ApprovalPins, PanelRegistry } from './panel/keys.js';
import type { ProxyRuntime } from './proxy/tool.js';

export interface DaemonDeps {
  daemonId?: string;
  /** Browser Courier extension connection (sends text into bound web chats). */
  courier?: import('./courier/hub.js').CourierHub;
  /** 全会话共用的变更号与长轮询等待者（feed/history 接口用）；单元测试的依赖子集里可能没有。 */
  feed?: import('./storage/feedLog.js').FeedLog;
  /** 局域网直连监听器（设置 lanAccess 打开时才真正监听）。 */
  lan?: import('./lan/listener.js').LanListener;
  /** Extension/config fingerprint supplied by the process that spawned this daemon. */
  startFingerprint?: string;
  execution?: ExecutionEnvironment;
  processes?: ProcessManager;
  entitlement?: EntitlementGate;
  /** Plan 6.11: daemon-owned cloud account (OS credential store). */
  account?: AccountService;
  cfg: Config;
  sessions: SessionsRepo;
  events: EventsRepo;
  toolCalls: ToolCallsRepo;
  confirmations: ConfirmationsRepo;
  /** Per-session task boards (the MCP `todo` tool). */
  todos: TodosRepo;
  /** Latest unconsumed task context; independent of Todo and audit retention. */
  handoffs: HandoffsRepo;
  /** 变更门控：扩展侧据此判断"有没有新东西"，避免每秒盲拉全部数据。 */
  changes: ChangeTracker;
  /** Ephemeral tool activity; absent in older/unit-test dependency subsets. */
  sessionActivity?: SessionActivity;
  /** Machine-scoped persisted rows (mcp token override). */
  machineState: MachineStateRepo;
  /** Daemon-owned user settings; absent in unit-test dependency subsets. */
  settings?: SettingsStore;
  /** Settings values this daemon started with (restart-only keys are compared against them). */
  startedSettings?: Settings;
  /**
   * Semantic-search probe, resolved once at startup. `available` decides
   * whether the context_search tool is registered at all; the MCP server is
   * built per protocol session, so this has to be fixed before any client
   * connects. See src/semantic/index.ts.
   */
  semantic: SemanticProbe;
  /**
   * MCP-Apps panel cards: session → capability key (memory-only, daemon
   * lifetime). `undefined` in unit-test dependency subsets — the show tool
   * then omits `_meta` and no card is ever attached.
   */
  panels?: PanelRegistry;
  /** Approval PINs for panel cards (loopback-issued second factor). See panel/keys.ts. */
  approvalPins?: ApprovalPins;
  runtimes: Map<string, SessionRuntime>;
  tunnel: TunnelManager;
  /** OpenAI Secure MCP Tunnel runtime (plan §5); independent of `tunnel`, never auto-started. */
  openaiTunnel?: import('./tunnel/openai-manager.js').OpenAITunnelManager;
  /** Live protocol-pipe count for the status-bar footprint readout. */
  livePipes?: () => number;
  log: (line: string) => void;
  /**
   * Last time an extension host POSTed /api/heartbeat. The channel watchdog
   * stops the public tunnel when this goes stale — the channel is meant to
   * close when every VS Code window running this extension is gone. Daemon
   * boot sets it to now (a fresh daemon assumes an operator is present).
   */
  lastHeartbeatAt: number;
  /** Last heartbeat per client kind ('tray', or 'other' for VS Code and unmarked callers). */
  clientBeats?: Map<string, number>;
  /**
   * Open Local Web pages: one entry per live GET /web-api/v1/presence response.
   * While non-empty the channel watchdog treats an operator as present (like a
   * VS Code window). Not a tray "other": /api/clients others_active ignores it.
   */
  webPresence?: Set<object>;
  /** The public channel the operator started; resumed after restarts and watchdog stops. */
  channelIntent?: import('./tunnel/resume.js').ChannelIntent;
  /** Ends every paired phone; set by the Local Web mount (plan 6.13 R). */
  revokeRemoteDevices?: () => void;
  /** Phone access controls for the VS Code panel (plan 6.13 R4); set by mountLocalWeb. */
  remote?: {
    view(): unknown;
    pair(): { url: string; expires_at: string | null; kind: string } | null;
    revoke(id: string): boolean;
    /** 允许 / 拒绝 a phone that scanned the code; false when the request is gone */
    decide(id: string, allow: boolean): boolean;
  };
  /** wired by daemon.ts once the graceful stop path exists (POST /api/shutdown) */
  shutdown?: () => Promise<void>;
  /**
   * 通用 MCP proxy 运行时（plan M1）：仅当 proxy 配置文件存在且解析出 server
   * 时才创建——工具面像 context_search 一样在 boot 定死，不随运行期增删漂移。
   */
  proxy?: ProxyRuntime;
  /** M4 reload：文件监听与管理路由共用的同一条管道（daemon 装配）。 */
  reloadProxies?: (trigger: string) => import('./proxy/tool.js').ReloadReport | { error: string };
  /**
   * MCP 主机连接代次（v2.6）：每次协议握手（客户端新建/重连）自增，由 mcp/router
   * 在 onsessioninitialized 里维护。设置页轮询它——"MCP 重连"即自动重取工具列表，
   * 不依赖任何手动按钮（进程内计数，重启归零，故与 daemon_id 一起判定）。
   */
  mcpConnGen?: number;
}

/**
 * Public MCP endpoint for this machine: one stable, machine-derived URL
 * shared by all sessions (connectors cannot edit their URL later). Which
 * session a call operates on is decided per tool call by its `key` argument,
 * never by the URL. Only a VERIFIED-online channel wins, then the fixed base
 * URL, then loopback.
 */
export function mcpPath(): string {
  return `/mcp/${deriveAccessToken()}`;
}

export function mcpUrl(deps: Pick<DaemonDeps, 'cfg' | 'tunnel'>): string {
  return `${publicBaseUrl(deps)}${mcpPath()}`;
}

/**
 * The daemon's reachable base (tunnel online > fixed public base > loopback):
 * one precedence shared by the MCP URL and the panel card's polling base.
 */
export function publicBaseUrl(deps: Pick<DaemonDeps, 'cfg' | 'tunnel'>): string {
  const channelUrl = deps.tunnel.status === 'online' || deps.tunnel.status === 'unverified' ? deps.tunnel.url : undefined;
  return (channelUrl ?? deps.cfg.publicBaseUrl ?? `http://${deps.cfg.host}:${deps.cfg.port}`).replace(/\/+$/, '');
}
