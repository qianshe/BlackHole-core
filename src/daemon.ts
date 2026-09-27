import { randomUUID } from 'node:crypto';
import { ProcessManager, ownerFingerprint } from './process/manager.js';
import { loadProcessBackend, processRuntimeCapability } from './process/backend.js';
import { normalizePermissionMode } from './config.js';
import express from 'express';
import type { EntitlementGate } from './cloud/entitlement-gate.js';
import { ENTITLEMENT_ORIGIN } from './cloud/entitlement-public-key.js';
import { AccountService } from './account/service.js';
import { accountSecretFile, openSecretBackend, type SecretBackend } from './account/secret-store.js';
import { openUrl } from './account/open-url.js';
import fs from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';
import { loadConfig, type Config } from './config.js';
import { mountControl } from './control/api.js';
import { mcpPath, mcpUrl, type DaemonDeps } from './deps.js';
import { OpenAITunnelManager } from './tunnel/openai-manager.js';
import { openAITunnelSecretFile, openOpenAITunnelCredential } from './tunnel/openai-credential.js';
import { mountMcp } from './mcp/router.js';
import { ApprovalPins, PanelRegistry } from './panel/keys.js';
import { mountPanel } from './panel/index.js';
import { mountLocalWeb, sendRemotePage, sendRootPage } from './web/local-web.js';
import { ChannelIntent, migrateDecoupledTabs } from './tunnel/resume.js';
import { resolveConfirmation } from './control/api.js';
import { ConfirmationsRepo } from './storage/confirmations.js';
import { maintainDb, openDb, type Storage } from './storage/db.js';
import { EventsRepo } from './storage/events.js';
import { MachineStateRepo } from './storage/machineState.js';
import { applySettingsToConfig, SettingsStore } from './settings/store.js';
import { SessionsRepo } from './storage/sessions.js';
import { ChangeTracker } from './storage/changes.js';
import { SessionActivity } from './session-activity.js';
import { TodosRepo } from './storage/todos.js';
import { HandoffsRepo } from './storage/handoffs.js';
import { ToolCallsRepo } from './storage/toolCalls.js';
import { TunnelManager } from './tunnel/manager.js';
import { startChannelWatchdog } from './tunnel/watchdog.js';
import { detectExecutionEnvironment } from './execution.js';
import { probeSemantic } from './semantic/index.js';
import { setAccessTokenOverride } from './util/token.js';
import { loadProxyConfig, resolveProxyConfigPath } from './proxy/config.js';
import { createProxyRuntime, type ReloadReport } from './proxy/tool.js';
import { VERSION } from './version.js';

export interface Daemon {
  cfg: Config;
  deps: DaemonDeps;
  stop(): Promise<void>;
}

export async function startDaemon(overrides: Partial<Config> = {}, log: (line: string) => void = console.error, entitlement?: EntitlementGate): Promise<Daemon> {
  const cfg = loadConfig(overrides);
  // Claim the loopback port before opening or migrating SQLite. The listening
  // socket is the kernel-owned singleton: concurrent extension hosts cannot both
  // enter recovery/retention writes and corrupt each other's startup state.
  const app = express();
  app.disable('x-powered-by');
  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(cfg.port, cfg.host, () => resolve(s));
    s.once('error', (err) => reject(err));
  });
  let startupStorage: Storage | undefined;
  try {
  const storage = openDb(cfg.dbPath);
  startupStorage = storage;

  const sessions = new SessionsRepo(storage.db);
  // 变更门控：任何会话级写入（事件/任务清单）→ epoch +1，扩展据此拉取
  const changes = new ChangeTracker();
  const panels = new PanelRegistry();
  const events = new EventsRepo(storage.db, cfg.eventPayloadCapBytes, () => changes.bump());
  const toolCalls = new ToolCallsRepo(storage.db);
  const machineState = new MachineStateRepo(storage.db);
  // 'always' approval grants persist across daemon restarts (machine_state);
  // session grants stay in memory by design
  const confirmations = new ConfirmationsRepo(storage.db, machineState);
  const todos = new TodosRepo(storage.db, (sessionId) => {
    changes.bump();
    panels.markTodosChanged(sessionId);
  });
  const handoffs = new HandoffsRepo(storage.db, () => changes.bump());
  // operator-set token override (settings page) survives restarts; the
  // derived default does not need persistence
  setAccessTokenOverride(machineState.get('mcp_token'));
  // Daemon-owned settings win over the launcher's environment once migrated.
  const settings = new SettingsStore(machineState);
  applySettingsToConfig(cfg, settings.get(), new Set(Object.keys(overrides).filter((k) => (overrides as Record<string, unknown>)[k] !== undefined)));
  const startedSettings = settings.get().values;

  const stale = toolCalls.markStaleStartedAsUnknown();
  if (stale > 0) log(`recovery: marked ${stale} in-flight tool call(s) as unknown`);
  // 幽灵确认清理：等待者的 HTTP 请求已随旧进程消亡，遗留 pending 永远不会被
  // 任何人批准——不清掉会一直挂在活动栏计数上。
  const ghosts = confirmations.markAllPendingExpired();
  if (ghosts > 0) log(`recovery: expired ${ghosts} ghost confirmation(s) left by the previous process`);
  confirmations.expireStale();

  // 存储保鲜（有界存储）：终止/归档会话的残留数据立即清除；存活会话的数据
  // 按 RETENTION_MS 保留期清扫。机器级事件是审计痕迹，不受保留期影响。
  const RETENTION_MS = 7 * 24 * 60 * 60_000;
  const cutoff = Date.now() - RETENTION_MS;
  let purgedCalls = 0;
  let purgedConf = 0;
  let purgedEvents = 0;
  let purgedTodos = 0;
  for (const s of sessions.list()) {
    if (s.status === 'revoked' || s.status === 'archived') {
      purgedCalls += toolCalls.purgeSession(s.id);
      purgedConf += confirmations.purgeSession(s.id);
      purgedEvents += events.purgeSession(s.id);
      purgedTodos += todos.purgeSession(s.id);
      handoffs.purgeSession(s.id);
    }
  }
  purgedCalls += toolCalls.purgeOlderThan(cutoff);
  purgedConf += confirmations.purgeOlderThan(cutoff);
  purgedEvents += events.purgeSessionScopedOlderThan(cutoff);
  purgedEvents += events.purgeMachineProtocolCountersOlderThan(cutoff);
  purgedTodos += todos.purgeOlderThan(cutoff);
  if (purgedCalls + purgedConf + purgedEvents + purgedTodos > 0) {
    log(`storage: retention purge — ${purgedCalls} tool call(s), ${purgedConf} confirmation(s), ${purgedEvents} event(s), ${purgedTodos} todo board(s)`);
  }
  const maintenance = maintainDb(storage.db, cfg.dbPath);
  if (maintenance.reclaimed) log(`storage: reclaimed database space (${Math.round(maintenance.freeRatio * 100)}% free pages)`);

  // Semantic search: resolve the credential BEFORE the MCP surface is built,
  // because it decides whether the tool exists. A failure is a configuration
  // state, not an error: the daemon runs on with one fewer tool.
  const semantic = await probeSemantic(cfg);
  if (semantic.available) {
    log(`context_search: enabled (key from ${semantic.detail}${semantic.preview ? `, ${semantic.preview}` : ''})`);
    log(`context_search: search backend ${semantic.engine}`);
    log('context_search: queries send file paths and code excerpts from this machine' +
        ' to the search service; changing the key needs a daemon restart');
  } else {
    log(`context_search: disabled — ${semantic.detail}`);
  }

  const execution = detectExecutionEnvironment();
  const shell = execution.exec.adapter;
  if (!shell) log('warning: no supported shell found (bash/cmd); workspace_exec will fail');
  else if (shell.name === 'cmd') log('warning: Git Bash not detected, falling back to cmd.exe (limited quoting); set BLACKHOLE_BASH to override');
  else log(`shell: ${shell.name}`);
  if (execution.sandbox.status === 'available') log(`sandbox: ${execution.sandbox.backend} available for restricted exec/process`);
  else if (execution.sandbox.status === 'deferred') log(`sandbox: ${execution.sandbox.backend} checked per launch`);
  else log(`warning: restricted exec/process sandbox unavailable — ${execution.sandbox.reason ?? execution.sandbox.status}${execution.sandbox.detail ? ` (${execution.sandbox.detail})` : ''}; commands remain fail-closed`);

  // Stable empty-capable proxy runtime: config errors isolate one server, and
  // adding/enabling the first server never requires recreating MCP connections.
  const proxyPath = resolveProxyConfigPath({ proxyConfigPath: overrides.proxyConfigPath });
  const proxyLoad = loadProxyConfig(proxyPath);
  // Keep one stable runtime even when empty. Existing MCP connections observe hot edits.
  const proxy = createProxyRuntime(proxyLoad, path.dirname(cfg.dbPath), log);
  if (proxy !== undefined) {
    proxy.manager.sweepOrphansAtBoot();
    // Enabled is a desired running state: do not idle-recycle an upstream and
    // surprise the next call with a process launch.
    proxy.manager.setIdleRecycle(0);
    log(`proxy: ${proxyLoad.servers.length} upstream server(s) configured (${proxyLoad.disabled.length} disabled, ${proxyLoad.quarantined.length} quarantined)`);
  }

  // M4 reload（plan §5.3）：文件监听（防抖 1s）+ 管理路由共用同一条管道；
  // 坏配置保留旧配置（绝不因 reload 拖垮 daemon），仅 config_error 报告
  let reloadDebounce: NodeJS.Timeout | undefined;
  const runReload = (trigger: string): ReloadReport | { error: string } => {
    const next = loadProxyConfig(proxyPath);
    if (next.servers.length === 0 && next.quarantined.length === 1 && next.quarantined[0]?.name === '(config)') {
      const detail = { error: next.quarantined[0].reason };
      log(`proxy: reload skipped (${trigger}): ${detail.error}`);
      return detail;
    }
    const report = proxy.applyReload(next);
    log(`proxy: reloaded (${trigger}): +${report.added.length} -${report.removed.length} hot:${report.hot.length} recycled:${report.recycled.length} gen=${report.policyGen}`);
    return report;
  };
  const scheduleReload = (): void => {
    if (reloadDebounce !== undefined) clearTimeout(reloadDebounce);
    reloadDebounce = setTimeout(() => {
      reloadDebounce = undefined;
      runReload('file-watch');
    }, 1000);
  };
  let proxyWatcher: fs.FSWatcher | undefined;
  const startProxyWatcher = (): void => {
    if (proxyWatcher !== undefined) return;
    try {
      // Watch the directory: atomic saves replace the file/inode, and it may not exist yet.
      fs.mkdirSync(path.dirname(proxyPath), { recursive: true });
      proxyWatcher = fs.watch(path.dirname(proxyPath), (_event, filename) => {
        if (filename === null || String(filename) === path.basename(proxyPath)) scheduleReload();
      });
      log(`proxy: watching ${proxyPath} for reload`);
    } catch (e) {
      log(`proxy: file watch unavailable: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  if (proxy !== undefined) startProxyWatcher();

  const daemonId = randomUUID();
  const processRuntime = await processRuntimeCapability(execution.platform, execution.arch);
  if (execution.process.available && !processRuntime.available) {
    execution.process.available = false;
    execution.process.reason = processRuntime.reason ?? 'runtime_asset_missing';
    log(`warning: process tool unavailable — ${execution.process.reason}`);
  }
  const processes = new ProcessManager({ daemonId, supported: execution.process.available, backend: await loadProcessBackend(execution.process.shell),
    event: (id, type, data) => { const row = sessions.get(id); if (row && row.status !== 'revoked' && row.status !== 'archived') events.append(id, type, data); } });
  const deps: DaemonDeps = {
    execution,
    daemonId,
    startFingerprint: process.env.BLACKHOLE_START_FINGERPRINT?.trim() || undefined,
    processes,
    entitlement,
    cfg,
    sessions,
    events,
    toolCalls,
    confirmations,
    todos,
    handoffs,
    changes,
    sessionActivity: new SessionActivity(() => changes.bump()),
    machineState,
    settings,
    startedSettings,
    semantic,
    // MCP-Apps panel cards: memory-only registries — a daemon restart kills
    // every card (the agent's next show re-attaches a fresh one)
    panels,
    approvalPins: new ApprovalPins(),
    runtimes: new Map(),
    tunnel: undefined as unknown as TunnelManager,
    livePipes: () => 0,
    log,
    lastHeartbeatAt: Date.now(),
    mcpConnGen: 0,
    ...(proxy !== undefined ? { proxy } : {}),
    reloadProxies: (trigger: string): ReloadReport | { error: string } => runReload(trigger),
  };

  deps.tunnel = new TunnelManager(cfg.port, {
    enabled: cfg.tunnel !== 'off',
    bin: cfg.cloudflaredBin,
    namedUrl: cfg.publicBaseUrl,
    tunnelName: cfg.tunnelName,
    probeProxy: cfg.tunnelProbeProxy,
    log,
    onEvent: (status, detail) => {
      events.append(null, 'tunnel_status', { status, ...detail });
      log(`tunnel: ${status}${detail.url ? ` ${String(detail.url)}` : ''}${detail.reason ? ` (${String(detail.reason)})` : ''}`);
    },
  });
  deps.channelIntent = new ChannelIntent(machineState);
  // One-time migration (plan §5.1): tabs no longer gate channels.
  if (migrateDecoupledTabs(machineState, settings.get().values.channelMode)) {
    log('channel: dropped the Cloudflare channel remembered under the custom tab (tabs no longer switch channels)');
  }

  app.get('/', (req, res) => {
    if (sendRootPage(req, res)) return;
    if (sendRemotePage(req, res)) return;
    res.type('text').send(`blackhole ${VERSION} daemon\nMCP endpoint: /mcp/<machine token> (same for all sessions; pass the session ID per tool call)\nControl API: /api/...\n`);
  });

  // Minimal public reachability contract for operator-managed tunnels. Keep it
  // deliberately free of version, paths, account state, sessions and tokens.
  app.get('/probe', (_req, res) => {
    res.json({ ok: true, service: 'blackhole' });
  });

  // Public agent surface, ported from the legacy daemon: the zero-dependency
  // python client and the per-session rules doc. The extension's no-connector
  // prompt template tells web agents to fetch both over the tunnel.
  app.get('/bh.py', (req, res) => {
    const scriptDir = path.dirname(process.argv[1] ?? '.');
    const candidates = [
      process.env.BLACKHOLE_BH_PY,
      path.resolve(scriptDir, '../client/bh.py'),
      path.resolve(scriptDir, 'bh.py'),
    ].filter((p): p is string => typeof p === 'string' && p.length > 0);
    // Escape a value for safe embedding inside a Python single-quoted string
    // literal so an injected URL/key can never break out of the assignment.
    const pyStr = (v: string): string => `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, '')}'`;
    // The session id is only known once a session exists, so it travels as an
    // optional ?sessionid= query param; without it the script falls back to
    // BH_SESSIONID.
    const rawId = req.query.sessionid;
    const sessionId = typeof rawId === 'string' ? rawId.trim() : '';
    for (const file of candidates) {
      try {
        let body = fs.readFileSync(file, 'utf8');
        body = body.replace("_INJECTED_URL = ''", `_INJECTED_URL = ${pyStr(mcpUrl(deps))}`);
        if (sessionId) body = body.replace("_INJECTED_SESSIONID = ''", `_INJECTED_SESSIONID = ${pyStr(sessionId)}`);
        res.type('text/x-python; charset=utf-8').send(body);
        return;
      } catch {
        /* try next candidate */
      }
    }
    res.status(404).type('text/plain').send('bh.py not found (set BLACKHOLE_BH_PY)');
  });

  // Plan 6.11: the daemon owns the cloud account; credentials live in user-only files under the data dir.
  const accountOrigin = entitlement?.cloudOrigin ?? ENTITLEMENT_ORIGIN;
  const dataDir = path.dirname(path.resolve(cfg.dbPath));
  // A bad origin disables the account only; it must never stop the daemon from serving.
  const openAccountSecrets = (origin: string): SecretBackend => {
    try { return openSecretBackend(accountSecretFile(dataDir, origin)); }
    catch { log('account: cloud origin rejected; signing in is unavailable'); return { kind: 'unavailable', reason: 'cloud_origin_invalid' }; }
  };
  deps.account = new AccountService({
    origin: accountOrigin,
    dataDir,
    machineState,
    secrets: openAccountSecrets(accountOrigin),
    gate: entitlement,
    openExternal: openUrl,
    // Isolated tests only: refuse every cloud request so fixtures never reach a real service.
    ...(process.env.BLACKHOLE_ACCOUNT_OFFLINE === '1' ? { fetch: (async () => { throw new TypeError('offline'); }) as typeof fetch } : {}),
    log,
  });
  void deps.account.start();

  // OpenAI Secure MCP Tunnel (plan §5): parallel to the Cloudflare channel, started only on request.
  deps.openaiTunnel = new OpenAITunnelManager({
    settings: () => settings.get(),
    credential: await openOpenAITunnelCredential(undefined, openAITunnelSecretFile(dataDir)),
    target: () => `http://127.0.0.1:${cfg.port}${mcpPath()}`,
    log,
    onEvent: (status, detail) => {
      events.append(null, 'openai_tunnel_status', { status, ...detail });
      log(`openai-tunnel: ${status}${detail.reason ? ` (${String(detail.reason)})` : ''}`);
    },
  });

  const mcp = mountMcp(app, deps);
  // Local Web: read-only page for this machine only (ticket login from VS Code).
  // Registered before /api so its native-only bootstrap route is matched first.
  const control = mountControl(express.Router(), deps);
  mountLocalWeb(app, deps, undefined, control);
  app.use('/api', control);
  // Panel-card surface (MCP Apps iframe polling + one-shot approval): public
  // by design — the path key IS the capability, same trust tier as the machine
  // token in the MCP URL. Lives outside /api (loopback-only) on purpose.
  // Approvals ride the SAME resolution path as the control plane (scope
  // capping, audit events) — one decision function, two surfaces.
  app.use(
    '/panel',
    mountPanel(
      express.Router(),
      deps,
      deps.panels!,
      deps.approvalPins!,
      (c, action, scope) => resolveConfirmation(deps, c, action, scope),
    ),
  );

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // express.json() parse errors and anything thrown by handlers land here
    log(`http error: ${err instanceof Error ? err.message : err}`);
    if (!res.headersSent) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'internal error' });
    }
  });

  // long-lived SSE streams (MCP GET) must not be cut by the default 5-min cap
  server.requestTimeout = 0;

  // no tunnel auto-start at boot: the channel is started on demand by the
  // extension sidebar / CLI (`tunnel start`), persistent or temporary.
  // The watchdog closes the public channel once every heartbeat sender is gone;
  // the detached daemon keeps serving locally until an explicit Stop.
  const watchdog = startChannelWatchdog(deps);
  // Lifetime sweep is independent of MCP requests, VS Code polling and channel heartbeats.
  const processSweep = setInterval(() => processes.reconcile(owner => {
    const row = sessions.get(owner.sessionId);
    if (!row || row.status !== 'active') return 'session_inactive';
    if (row.expires_at !== null && row.expires_at < Date.now()) return 'session_expired';
    try {
      const fresh = { sessionId: row.id, workspace: fs.realpathSync.native(row.workspace_path), mode: normalizePermissionMode(row.permission_mode),
        writableDirs: (row.writable_dirs ?? []).map(dir => fs.realpathSync.native(dir)) };
      if (ownerFingerprint(fresh) !== ownerFingerprint(owner)) return 'permission_changed';
    } catch { return 'workspace_unavailable'; }
    return undefined;
  }), 1000);
  processSweep.unref();

  events.append(null, 'daemon_started', { version: VERSION, port: cfg.port, tunnel: cfg.tunnel });
  log(`blackhole daemon v${VERSION} listening on http://${cfg.host}:${cfg.port} (db: ${cfg.dbPath})`);
  // Start every enabled MCP only after the loopback control plane is available,
  // so settings can observe `starting` immediately instead of daemon startup hanging.
  void proxy.startEnabled().catch((error) => log(`proxy: startup sweep failed: ${error instanceof Error ? error.message : String(error)}`));

  const stop = async (): Promise<void> => {
    clearInterval(processSweep);
    await processes.dispose();
    watchdog.stop();
    proxyWatcher?.close();
    if (reloadDebounce !== undefined) clearTimeout(reloadDebounce);
    await deps.tunnel.stop();
    await deps.openaiTunnel?.stop(null).catch(() => undefined);
    await deps.proxy?.manager.closeAll(); // upstream child 在进程退出前关闭（plan §8.1）
    deps.proxy?.attachments.clear(); // attachment 可见引用随 stop 全清（plan §9）
    await mcp.closeAll();
    for (const rt of deps.runtimes.values()) rt.pwsh?.dispose();
    deps.runtimes.clear();
    // close() only stops accepting; kept-alive clients could still reach this
    // retiring daemon's /health after a replacement starts. Drop them now.
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    events.append(null, 'daemon_stopped', {});
    deps.sessionActivity?.dispose();
    storage.close();
  };
  deps.shutdown = stop;

  return { cfg, deps, stop };
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try { startupStorage?.close(); } catch { /* preserve the startup error */ }
    throw error;
  }
}

