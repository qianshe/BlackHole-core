import { resumeChannel } from '../tunnel/resume.js';
import { restartSelf } from '../util/self-restart.js';
import { mountProcesses } from './processes.js';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import express, { Router, type Request, type Response } from 'express';
import type { DaemonDeps } from '../deps.js';
import { mcpPath, mcpUrl } from '../deps.js';
import { generateToken, resetAccessTokenCache, setAccessTokenOverride } from '../util/token.js';
import { normalizePermissionMode, PERMISSION_MODES, type PermissionMode } from '../config.js';
import { clearKeyFile, keyFilePath, resolveSemanticKey, writeKeyFile } from '../semantic/key.js';
import { extractKey } from '../semantic/extract-key.js';
import { riskMatches } from '../workspace/risk.js';
import { loadProxyConfig, resolveProxyConfigPath } from '../proxy/config.js';

import { proxyConfigProjection, proxyStatusReport } from '../proxy/tool.js';
import { appendServerToYaml, removeServerFromYaml, mergeEditableFields } from '../proxy/yaml.js';
import { scanSecrets } from '../proxy/redact.js';
import type { UpstreamToolInfo } from '../proxy/manager.js';
import { convertMcpServersJson, validateServerEntry } from '../proxy/config.js';
import type { ApprovalScope, ConfirmationRow } from '../storage/db.js';
import { VERSION } from '../version.js';
import { processManagementCapability } from '../execution.js';
import { createWorkspaceSession, normalizeWritableDirs, type CreateSessionInput } from '../services/sessions.js';
import { migrateSettings, patchSettings, probePublicUrl, settingsView } from '../settings/service.js';
import { skillDirectoryStatus } from '../settings/skills-status.js';
import { ACCOUNT_API_VERSION, AccountError, accountErrorCode } from '../account/service.js';
import { loopbackPeer, mountOpenAITunnel } from './openai-tunnel-routes.js';
import { mountFeedRoutes } from '../feed/routes.js';
import { cloudflaredOnDisk, LastChannel, switchOff, switchOn, switchView, type SwitchDeps } from '../tunnel/switch.js';
import { resolveConnectionRoutes } from '../connection/resolve.js';
import { initializeCloudflared } from '../tunnel/cloudflared-install.js';
import { initializeOpenAITunnelClient } from '../tunnel/openai-tunnel-install.js';
import { withProxyFetch } from '../network/proxy-fetch.js';

/**
 * 设置页「查看工具列表」拉取用的专用 session 键（v2.6）。与 verifyServer 的
 * `__probe__` 同思路：只为 listTools 拉起一个一次性 child，取到 catalog 后立即
 * closeSession 回收——绝不复用业务 session 的 child，也不留常驻进程。
 */
const CONTROL_TOOLS_SESSION = '__control_tools__';

export function mountControl(app: Router, deps: DaemonDeps): Router {
  const bootTime = Date.now();
  /**
   * v2.6 daemon 身份：版本 + 启动时刻 + pid。设置页把工具列表与它绑定——只有当前
   * 实际连接的 daemon 的数据才作数；身份一变（重启/换 daemonEntry/换端口）即作废旧
   * 工具列表并重新拉取，杜绝"显示的是上一个 daemon 的工具"。
   */
  const daemonId = deps.daemonId ?? `${VERSION}-${bootTime}-${process.pid}`;
  // OpenAI tunnel routes carry an API key: own native-loopback guard + strict 16 KiB
  // parser, mounted before the shared parser so bodies never reach generic handlers.
  mountOpenAITunnel(app, deps, daemonId);
  app.use(express.json({ limit: deps.cfg.bodyLimitBytes }));

  // Control plane is local-only: reject requests whose Host header was not
  // addressed to the loopback interface (basic DNS-rebinding guard), and
  // reject proxy-forwarded requests in case someone fronts this daemon with
  // their own reverse proxy (lesson from codex-with-chatgpt).
  app.use((req, res, next) => {
    // Host 头可以伪造：先按 TCP 来源地址判断，只接受本机连接（局域网直连开着时也一样）。
    if (!loopbackPeer(req)) {
      res.status(403).json({ error: 'control API is loopback-only' });
      return;
    }
    if (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']) {
      res.status(403).json({ error: 'control API refuses proxied requests' });
      return;
    }
    const host = (req.headers.host ?? '').toLowerCase();
    if (host.startsWith('127.0.0.1') || host.startsWith('localhost') || host.startsWith('[::1]')) {
      next();
      return;
    }
    res.status(403).json({ error: `control API is loopback-only (got Host "${host}")` });
  });

  mountProcesses(app, deps.processes);

  // Public identities and challenge-bound signatures only; never forward a bearer here.
  // ─── account (plan 6.11) ───────────────────────────────────
  const accountFail = (res: Response, e: unknown) => {
    const code = accountErrorCode(e);
    res.status(e instanceof AccountError ? e.status : 502).json({ error: code });
  };
  app.use('/account', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  app.get('/account', (_req, res) => {
    if (!deps.account) { res.status(503).json({ error: 'account_unavailable' }); return; }
    void deps.account.view().then((v) => res.json(v), (e) => accountFail(res, e));
  });
  app.post('/account/sign-in', (_req, res) => {
    try { res.json(deps.account ? deps.account.beginSignIn() : { state: 'idle' }); } catch (e) { accountFail(res, e); }
  });
  app.get('/account/sign-in', (_req, res) => { res.json(deps.account?.signInState() ?? { state: 'idle' }); });
  app.post('/account/sign-in/cancel', (_req, res) => { res.json(deps.account?.cancelSignIn() ?? { state: 'idle' }); });
  app.post('/account/call', (req, res) => {
    if (!deps.account) { res.status(503).json({ error: 'account_unavailable' }); return; }
    const b = (req.body ?? {}) as { method?: unknown; args?: unknown };
    void deps.account.call(String(b.method ?? ''), b.args).then((result) => res.json({ result: result ?? null }), (e) => accountFail(res, e));
  });
  app.post('/account/migrate', (req, res) => {
    if (!deps.account) { res.status(503).json({ error: 'account_unavailable' }); return; }
    void deps.account.migrate((req.body as { credential?: unknown } | undefined)?.credential).then((r) => res.json(r), (e) => accountFail(res, e));
  });

  app.post('/entitlement/:action', (req, res) => {
    const host = req.headers.host ?? '';
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(?::[0-9]+)?$/.test(host) || req.headers.origin || req.headers.authorization || req.headers.cookie || req.headers['sec-fetch-site']) {
      res.status(403).json({error:'native_loopback_required'}); return;
    }
    const gate=deps.entitlement;
    if(!gate){res.status(503).json({error:'entitlement_bridge_unavailable'});return;}
    try {
      const b=req.body ?? {};
      // Binding is mandatory, including for legacy clients. An originless identity
      // can otherwise poison login ordering before a valid signature is checked.
      // Old windows must upgrade; rejection never mutates identity, lease or claims.
      if(typeof b.cloud_origin!=='string'||!b.cloud_origin){res.status(409).json({error:'entitlement_bridge_upgrade_required'});return;}
      if(b.cloud_origin!==gate.cloudOrigin){res.status(409).json({error:'cloud_environment_mismatch'});return;}
      if((req.params.action!=='identity'||b.daemon_id!==undefined)&&b.daemon_id!==daemonId){res.status(409).json({error:'daemon_changed'});return;}
      switch(req.params.action) {
        case 'identity': gate.setIdentity(b.identity); res.json({ok:true,daemon_id:daemonId}); return;
        case 'claim': res.json({pending:gate.claim(b.worker)}); return;
        case 'complete': gate.complete(b.challenge,b.ticket); res.json({ok:true}); return;
        case 'fail': gate.fail(b.challenge); res.json({ok:true}); return;
        case 'refresh': void gate.ensure(true).catch(()=>undefined); res.json({ok:true}); return;
        default: res.status(404).json({error:'not_found'});
      }
    }catch{res.status(403).json({error:'entitlement_rejected'});}
  });

  app.get('/health', (_req, res) => {
    // 当日 0 点按请求时本地时区现算：跨零点后下一次轮询自动切到新一天
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const activityStarts = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(dayStart);
      d.setDate(d.getDate() - (6 - i));
      return d.getTime();
    });
    const activityDays = deps.toolCalls.activityDays(activityStarts);
    const todayActivity = activityDays.find(day => day.start === dayStart.getTime());
    res.json({
      ok: true,
      version: VERSION,
      ...(deps.startFingerprint ? { start_fingerprint: deps.startFingerprint } : {}),
      ...(deps.openaiTunnel ? { openai_tunnel_api_version: 1, openai_tunnel: deps.openaiTunnel.view() } : {}),
      // Clients re-read settings when this moves (an edit made in another client).
      ...(deps.settings ? { settings_revision: deps.settings.get().revision } : {}),
      ...(deps.directAccess ? { direct_access: deps.directAccess.view() } : {}),
      ...(deps.entitlement ? { cloud_origin: deps.entitlement.cloudOrigin, entitlement_bridge_version: 2 } : {}),
      ...(deps.account ? { account_api_version: ACCOUNT_API_VERSION, account_storage: deps.account.storage } : {}),
      started_at: new Date(bootTime).toISOString(),
      // v2.6 身份与代次：设置页据此判定"当前用的是哪个 daemon"以及"表面/连接是否变了"
      daemon_id: daemonId,
      proxy_surface_gen: deps.proxy?.surfaceGen() ?? null,
      mcp_conn_gen: deps.mcpConnGen ?? 0,
      db_path: deps.cfg.dbPath,
      public_base_url: deps.cfg.publicBaseUrl ?? null,
      tunnel: deps.tunnel.status,
      tunnel_mode: deps.tunnel.mode ?? null,
      tunnel_url: deps.tunnel.url ?? null,
      tunnel_reason: deps.tunnel.reason ?? null,
      // machine-level and stable: the same URL for every session on this host
      mcp_url: mcpUrl(deps),
      connection_routes: resolveConnectionRoutes(deps, mcpPath()),
      mcp_path: mcpPath(),
      // whether context_search was offered to agents at boot
      semantic_search: deps.semantic.available,
      semantic_source: deps.semantic.source,
      // Execution capability facts are machine-level diagnostics. Tool discovery and
      // restricted runtime readiness are deliberately separate: an unavailable
      // sandbox does not remove exec/process from the server catalog.
      execution_runtime: (() => {
        const execution = deps.execution;
        const platform = execution?.platform ?? process.platform;
        const processAvailable = deps.processes?.supported === true;
        const sandbox = execution?.sandbox ?? {
          backend: 'none' as const,
          status: 'unsupported' as const,
          reason: 'sandbox_unsupported_platform',
          detail: 'execution environment unavailable',
        };
        return {
          platform,
          arch: execution?.arch ?? process.arch,
          execution_tools: ['exec', ...(processAvailable ? ['process'] : [])],
          exec_shell: execution?.exec.shell.executable ?? null,
          process_shell: execution?.process.shell.executable ?? null,
          process_available: processAvailable,
          process_unavailable_reason: processAvailable ? null : execution?.process.reason ?? 'backend_unavailable',
          sandbox: { ...sandbox, fail_closed: true as const },
          process_management: processManagementCapability(platform, processAvailable),
        };
      })(),
      // Today's counters share the seven-day read and survive detail/session purges.
      stats: {
        total: todayActivity?.total ?? 0,
        diff_added: todayActivity?.diff_added ?? 0,
        diff_removed: todayActivity?.diff_removed ?? 0,
        mcp_initializes: deps.events.countMachineSince('mcp_initialize', dayStart.getTime()),
        mcp_reuses: deps.events.countMachineSince('mcp_session_reused', dayStart.getTime()),
        mcp_rejected: deps.events.countMachineSince('mcp_call_rejected', dayStart.getTime()),
        mcp_deletes: deps.events.countMachineSince('mcp_delete', dayStart.getTime()),
        // live daemon footprint: how many protocol pipes are parked right now
        // (busy GPT sessions park dozens inside the 90s window) and what the
        // process actually occupies — the pair-reaping story at a glance.
        mcp_live_pipes: deps.livePipes?.() ?? 0,
        rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        heap_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      },
      activity_days: activityDays,
      // status-bar hover extras: daemon age (gives the memory numbers a
      // reference frame), live session/workload picture, and today's
      // operator-denied risky commands — a security signal distinct from
      // protocol-layer rejections.
      uptime_min: Math.round((Date.now() - bootTime) / 60_000),
      sessions_active: deps.sessions.list().filter((s) => s.status === 'active' && !('draft' in s)).length,
      sessions_running: deps.sessions.list().filter((s) => s.status === 'active' && deps.sessionActivity?.status(s.id) === 'running').length,
      approvals_pending: deps.confirmations.list().filter((c) => c.status === 'pending').length,
      approvals_denied: deps.confirmations.deniedSince(dayStart.getTime()),
    });
  });

  // ─── Semantic search (context_search) ───────────────────────
  //
  // GET reports what the daemon resolved AT BOOT plus what it would resolve
  // now; the distinction matters because the tool list is fixed at startup,
  // so saving a key here only takes effect after a restart. Never returns the
  // key — only its fingerprint — like the MCP token routes.
  app.get('/semantic', async (_req, res) => {
    const resolved = await resolveSemanticKey(deps.cfg);
    res.json({
      registered: deps.semantic.available,
      registered_source: deps.semantic.source,
      registered_detail: deps.semantic.detail,
      registered_preview: deps.semantic.preview,
      engine: deps.semantic.engine,
      mode: deps.cfg.semantic,
      key_file: keyFilePath(deps.cfg),
      timeout_ms: deps.cfg.semanticTimeoutMs,
      // would-be state: differs from `registered` right after a save, before
      // the restart that actually changes the tool surface
      would_resolve: resolved.key !== '',
      would_source: resolved.source,
      would_detail: resolved.detail,
    });
  });

  app.post('/semantic/key', (req, res) => {
    const key = (req.body as { key?: string } | undefined)?.key?.trim() ?? '';
    if (key === '') {
      res.status(400).json({ error: 'empty key' });
      return;
    }
    try {
      const path = writeKeyFile(deps.cfg, key);
      deps.events.append(null, 'semantic_key_saved', { path });
      res.json({ saved: true, key_file: path, note: 'takes effect after the daemon restarts (tool registration happens at boot)' });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post('/semantic/clear', (_req, res) => {
    const removed = clearKeyFile(deps.cfg);
    deps.events.append(null, 'semantic_key_cleared', { removed });
    res.json({ removed, key_file: keyFilePath(deps.cfg), note: 'restart the daemon to drop the tool' });
  });

  // 自动扫描：从本机 Devin/Windsurf 安装里提取已登录的 key 并直接写入手动
  // key 文件（设置页「自动扫描」）。原始 key 不过网络——响应只带指纹，与
  // token 路由同一纪律；写文件 0600，事件流留审计。
  app.post('/semantic/scan', async (_req, res) => {
    const found = await extractKey();
    if (!found.api_key) {
      res.json({ found: false, error: found.error ?? 'no key found', hint: found.hint, tried: found.tried_paths ?? [] });
      return;
    }
    try {
      const path = writeKeyFile(deps.cfg, found.api_key);
      deps.events.append(null, 'semantic_key_saved', { path, source: 'scan' });
      const key = found.api_key;
      res.json({
        found: true,
        saved: true,
        key_file: path,
        preview: key.length <= 8 ? '' : `${key.slice(0, 4)}…${key.slice(-4)}`,
        source_detail: found.db_path ?? '',
        note: 'takes effect after the daemon restarts (tool registration happens at boot)',
      });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.get('/tunnel', (_req, res) => {
    res.json({
      status: deps.tunnel.status,
      url: deps.tunnel.url ?? null,
      mode: deps.tunnel.mode ?? null,
      reason: deps.tunnel.reason ?? null,
    });
  });

  // The public channel is user-driven: pick persistent (named) or temporary
  // (quick) and start/stop it explicitly. No auto-start anywhere.
  app.post('/tunnel/start', async (req, res) => {
    const mode = (req.body as { mode?: string } | undefined)?.mode === 'named' ? 'named' : 'quick';
    await deps.tunnel.start(mode);
    deps.channelIntent?.set(mode);
    deps.lastChannel?.set(mode);
    // a heartbeat sender asked for the channel: keep the watchdog fed from now
    deps.lastHeartbeatAt = Date.now();
    res.json({ status: deps.tunnel.status, url: deps.tunnel.url ?? null, mode: deps.tunnel.mode ?? null });
  });

  app.post('/tunnel/stop', async (_req, res) => {
    deps.channelIntent?.clear();
    await deps.tunnel.stop();
    res.json({ status: deps.tunnel.status, url: deps.tunnel.url ?? null, mode: deps.tunnel.mode ?? null, reason: deps.tunnel.reason ?? null });
  });

  // 渠道总开关：VS Code 侧边栏、设置页和本地 Web（经 /panel 白名单）共用。
  // 开 = 启动上次使用的渠道，关 = 停止所有渠道；缺前提时返回 409 和缺少的那一项。
  const channelSwitch = (): SwitchDeps => ({
    tunnel: deps.tunnel,
    ...(deps.openaiTunnel ? { openai: deps.openaiTunnel } : {}),
    ...(deps.settings ? { settings: deps.settings } : {}),
    namedUrl: () => deps.cfg.publicBaseUrl || undefined,
    cloudflaredReady: () => cloudflaredOnDisk(deps.cfg.cloudflaredBin ?? 'cloudflared'),
    last: deps.lastChannel ?? new LastChannel(deps.machineState),
    ...(deps.channelIntent ? { intent: deps.channelIntent } : {}),
    heartbeat: () => { deps.lastHeartbeatAt = Date.now(); },
  });
  app.get('/channel', (_req, res) => {
    res.json(switchView(channelSwitch()));
  });
  app.post('/channel', async (req, res) => {
    const on = (req.body as { on?: unknown } | undefined)?.on;
    if (typeof on !== 'boolean') { res.status(400).json({ error: 'invalid_input', message: 'on must be true or false' }); return; }
    if (!on) { res.json({ ok: true, view: await switchOff(channelSwitch()) }); return; }
    const r = await switchOn(channelSwitch());
    if (r.ok) res.json({ ok: true, view: r.view });
    else res.status(409).json({ ok: false, error: r.code, view: r.view });
  });

  // Rotate the machine-level MCP token (settings page "刷新" button). The new
  // URL takes effect immediately; connectors configured with the old URL stop
  // working until the operator updates them.
  app.post('/token/rotate', (_req, res) => {
    const token = generateToken();
    deps.machineState.set('mcp_token', token);
    resetAccessTokenCache();
    setAccessTokenOverride(token);
    deps.events.append(null, 'mcp_token_rotated', {});
    // The OpenAI runtime's MCP_SERVER_URL embeds the token: restart a live run on the new target.
    void deps.openaiTunnel?.targetChanged().catch(() => undefined);
    res.json({ mcp_url: mcpUrl(deps), connection_routes: resolveConnectionRoutes(deps, mcpPath()) });
  });

  // Extension heartbeat: the channel should close when every VS Code window
  // running this extension is gone (daemon keeps serving locally).
  app.post('/heartbeat', (req, res) => {
    const now = Date.now();
    deps.lastHeartbeatAt = now;
    // Only the tray marks itself; every VS Code build (old ones too) sends no marker.
    const kind = req.headers['x-blackhole-client'] === 'tray' ? 'tray' : 'other';
    (deps.clientBeats ??= new Map()).set(kind, now);
    // A window is back: bring back the channel the operator started earlier.
    resumeChannel(deps);
    res.json({ ok: true });
  });

  /** Lets the tray quit on its own while VS Code (or another client) still uses this daemon. */
  app.get('/clients', (_req, res) => {
    const other = deps.clientBeats?.get('other');
    res.json({
      others_active: other !== undefined && Date.now() - other < 30_000,
      // Informational only: an open Local Web page does not keep the daemon for a tray quit.
      web_present: (deps.webPresence?.size ?? 0) > 0,
    });
  });

  // Graceful exit for the extension's "Stop Daemon": respond first, then tear
  // down (tunnel, MCP sessions, server, db) and exit. Bind every shutdown to
  // BOTH the observed incarnation and its launch fingerprint. 0.3.165 windows
  // sent neither; 0.3.167 sent only daemon_id. Neither may kill this daemon and
  // bring back its older build after an upgrade. This is a consistency check,
  // not an authentication secret: /health exposes the values on loopback.
  app.post('/shutdown', (req, res) => {
    const body = (req.body ?? {}) as { daemon_id?: unknown; start_fingerprint?: unknown };
    if (typeof body.daemon_id !== 'string' || !body.daemon_id
      || !Object.hasOwn(body, 'start_fingerprint')
      || (body.start_fingerprint !== null && typeof body.start_fingerprint !== 'string')) {
      res.status(409).json({ error: 'shutdown_precondition_required', daemon_id: daemonId });
      return;
    }
    if (body.daemon_id !== daemonId || body.start_fingerprint !== (deps.startFingerprint ?? null)) {
      res.status(409).json({ error: 'daemon_changed', daemon_id: daemonId });
      return;
    }
    res.json({ ok: true });
    setTimeout(() => {
      void deps.shutdown?.().catch(() => undefined).finally(() => process.exit(0));
    }, 50).unref();
  });

  // Restart in place (plan 6.12 S3b): same command line and port, new process.
  app.post('/restart', (req, res) => {
    if ((req.body as { confirm?: unknown } | undefined)?.confirm !== true) {
      res.status(400).json({ error: 'invalid_input', message: 'confirm must be true' });
      return;
    }
    void restartSelf(deps, 'control').then((r) => res.status(r.ok ? 200 : 500).json(r));
  });

  // The credential is included so the extension can render prompts with the
  // CURRENT id without storing anything (a rotated session serves the fresh
  // one on the next poll). The control plane binds to 127.0.0.1 only.
  const publicSession = (s: { id: string; credential_id: string; name: string | null; workspace_path: string; status: string; permission_mode: string; writable_dirs?: string[]; auto_approve?: string | number | boolean; created_at: number; last_active_at: number }, summary: { id: string; created_at: number } | null = deps.handoffs?.getSummary(s.id) ?? null) => ({
    id: s.id,
    session_id: s.credential_id,
    pending_handoff: s.status === 'revoked' || s.status === 'archived' ? null : summary,
    name: s.name,
    workspace_path: s.workspace_path,
    status: s.status,
    activity: deps.sessionActivity?.status(s.id),
    permission_mode: s.permission_mode,
    writable_dirs: s.writable_dirs ?? [],
    auto_approve: String(s.auto_approve ?? '') === '1' || s.auto_approve === true,
    /** Reserved, not stored yet: becomes a real session on the first tool call; closing it discards it. */
    draft: 'draft' in s && s.draft === true,
    created_at: new Date(s.created_at).toISOString(),
    last_active_at: new Date(s.last_active_at).toISOString(),
  });

  // One metadata-only query for a whole response, including reorder responses.
  const publicSessions = (rows: Parameters<typeof publicSession>[0][]) => {
    const summaries = deps.handoffs?.listSummaries();
    return rows.map(s => publicSession(s, summaries?.get(s.id) ?? null));
  };
  app.use('/sessions', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

  app.post('/sessions', (req: Request, res: Response) => {
    const created = createWorkspaceSession(deps, (req.body ?? {}) as CreateSessionInput);
    if ('error' in created) {
      res.status(400).json({ error: created.error });
      return;
    }
    const session = created.session;
    // M4 prewarm：on_session_start 的 upstream 提前预热（plan §8.4/§12-M4）
    // Creating a workspace session does not start MCP upstreams; proxy use is the trigger.
    res.status(201).json({
      ...publicSession(session),
      mcp_url: mcpUrl(deps),
      connection_routes: resolveConnectionRoutes(deps, mcpPath()),
      note: 'Use the numeric session_id as `sessionId` on every tool call so calls stay attached to this session. If it may have leaked, rotate the session: the old id stops resolving immediately while the session continues under a fresh id.',
    });
  });

  // Daemon-owned settings (the extension mirrors them into VS Code settings).
  app.get('/settings', (_req, res) => {
    if (!deps.settings) { res.status(503).json({ error: 'settings_unavailable' }); return; }
    res.setHeader('Cache-Control', 'no-store');
    res.json(settingsView(deps));
  });
  app.patch('/settings', (req, res) => {
    const r = patchSettings(deps, req.body, 'extension', false);
    res.status(r.status).json(r.body);
  });
  app.post('/settings/migrate', (req, res) => {
    const r = migrateSettings(deps, req.body);
    res.status(r.status).json(r.body);
  });

  // The shared settings renderer uses the same validation in both hosts.
  app.get('/settings/skills', (req, res) => {
    const dir = typeof req.query.dir === 'string' ? req.query.dir.slice(0, 1000) : (deps.settings?.get().values.skillsDir ?? '');
    const { cls, hint } = skillDirectoryStatus(dir.trim());
    res.json({ cls, hint });
  });
  app.post('/settings/probe', (req, res) => {
    const proxy = deps.settings?.get().values.channelProxyUrl || deps.settings?.get().values.tunnelProbeProxy || '';
    void probePublicUrl((req.body as { url?: unknown } | undefined)?.url, proxy).then(r => res.json(r));
  });
  // Runtime installation is daemon-owned so every UI uses the same proxy,
  // download verification and single network boundary. It never starts a channel.
  app.post('/runtime/install', async (req, res) => {
    const body = req.body as { runtime?: unknown; configured_path?: unknown } | undefined;
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some((k) => k !== 'runtime' && k !== 'configured_path')
      || (body.runtime !== 'cloudflared' && body.runtime !== 'openai')
      || typeof body.configured_path !== 'string'
      || body.configured_path.length > 4096) {
      res.status(400).json({ error: 'invalid_body' });
      return;
    }
    const proxy = deps.settings?.get().values.channelProxyUrl || undefined;
    try {
      const result = await withProxyFetch(proxy, (fetchFile) =>
        body.runtime === 'cloudflared'
          ? initializeCloudflared(body.configured_path as string, { fetch: fetchFile })
          : initializeOpenAITunnelClient(body.configured_path as string, { fetch: fetchFile }));
      res.json(result);
    } catch (error) {
      res.status(502).json({ error: 'install_failed', message: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/sessions', (_req, res) => {
    res.json({ sessions: publicSessions(deps.sessions.list()) });
  });

  app.post('/sessions/reorder', (req, res) => {
    const ids = ((req.body ?? {}) as { ids?: unknown }).ids;
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || id.length === 0)) {
      res.status(400).json({ error: 'ids must be an array of session ids' });
      return;
    }
    try {
      const sessions = deps.sessions.reorder(ids as string[]);
      deps.changes.bump();
      res.json({ sessions: publicSessions(sessions) });
    } catch (error) {
      if (error instanceof Error && error.message === 'session_order_stale') {
        res.status(409).json({ error: 'session list changed; refresh before reordering' });
        return;
      }
      throw error;
    }
  });

  app.get('/sessions/:id', (req, res) => {
    const s = deps.sessions.get(req.params.id as string);
    if (!s) {
      res.status(404).json({ error: 'session not found' });
      return;
    }
    res.json(publicSession(s));
  });

  type SessionAction = 'pause' | 'resume' | 'revoke' | 'rotate';
  const statusFor: Record<Exclude<SessionAction, 'rotate'>, 'paused' | 'active' | 'revoked'> = {
    pause: 'paused',
    resume: 'active',
    revoke: 'revoked',
  };

  app.post('/sessions/:id/:action(pause|resume|revoke|rotate)', async (req, res) => {
    const id = req.params.id as string;
    const action = req.params.action as SessionAction;
    const existing = deps.sessions.get(id);
    if (!existing) {
      res.status(404).json({ error: 'session not found' });
      return;
    }
    if (existing.status === 'revoked') {
      res.status(409).json({ error: 'session is already revoked' });
      return;
    }
    if ('draft' in existing) {
      // Nothing was stored or run yet: revoke just forgets the reservation.
      if (action === 'revoke') { deps.sessions.discardDraft(id); res.json({ ...publicSession(existing), status: 'revoked', draft: true }); return; }
      if (action !== 'rotate') { res.status(409).json({ error: 'session is still a draft' }); return; }
    }
    if (action === 'rotate') {
      deps.panels?.revokeSession(id, { keepAnswering: true, reason: 'credential_rotated' });
      const updated = deps.sessions.rotateCredential(id);
      deps.events.append(id, 'session_id_rotated', {});
      // No connection teardown: the machine URL is shared by every session,
      // so revocation happens at id lookup (the old id stops resolving).
      res.json({
        ...publicSession(updated as NonNullable<typeof updated>),
        mcp_url: mcpUrl(deps),
        connection_routes: resolveConnectionRoutes(deps, mcpPath()),
        note: 'The old session id no longer resolves; hand the new numeric session_id to the agent. The session (shell, todos, audit trail) continues unchanged.',
      });
      return;
    }
    const updated = deps.sessions.setStatus(id, statusFor[action]);
    const unconfirmed = action === 'pause' || action === 'revoke'
      ? await deps.processes?.stopSession(id, `session_${action}`, action === 'revoke') ?? [] : [];
    if (action === 'revoke') {
      deps.sessionActivity?.forget(id);
      // the key stops resolving at lookup; also drop the runtime so its
      // persistent shell does not outlive the session
      deps.runtimes.get(id)?.pwsh?.dispose();
      deps.runtimes.delete(id);
      // upstream proxy children belong to the session too (plan §8.1)
      void deps.proxy?.manager.closeSession(id);
      // attachment 可见引用随 revoke 立即清理（plan §9）
      deps.proxy?.attachments.dropSession(id);
      // A revoked session keeps its 410 answer for a live card (the registry
      // entry is moved to the graveyard lookup below instead of dropped).
      // graveyard: remember key→session so the card reads its own end state
      const panelKey = deps.panels?.keyFor(id);
      if (panelKey) deps.panels?.revokeSession(id, { keepAnswering: true });
      // 终止即清账：调用/确认/事件随会话一起清除，存储不再无界累积。
      // 先清账再落 session_revoked 标记（下方 append）—— 事件流只留终止审计。
      const purged = deps.toolCalls.purgeSession(id);
      deps.confirmations.purgeSession(id);
      deps.events.purgeSession(id);
      deps.todos.purgeSession(id);
      deps.handoffs?.purgeSession(id);
      if (purged > 0) deps.log(`session ${id} revoked: purged ${purged} tool call(s)`);
    }
    deps.events.append(id, `session_${action === 'pause' ? 'paused' : action === 'resume' ? 'resumed' : 'revoked'}`, {});
    if (unconfirmed.length) { res.status(503).json({ error: 'process_cleanup_unconfirmed', processIds: unconfirmed, sessionStatus: updated?.status }); return; }
    res.json(publicSession(updated as NonNullable<typeof updated>));
  });

  /**
   * Runtime permission-mode switch (the session log as the store: the
   * session log is the store, one event per switch, fold-by-read). Switching
   * respawns the session's persistent shell so the NEXT command runs under
   * the new confinement — a live pwsh keeps its old token until then.
   */
  app.patch('/sessions/:id/mode', async (req, res) => {
    const id = req.params.id as string;
    const raw = ((req.body ?? {}) as { permission_mode?: string }).permission_mode;
    const mode = normalizePermissionMode(raw);
    if (raw !== undefined && raw !== mode) {
      res.status(400).json({ error: `permission_mode must be one of ${PERMISSION_MODES.join(', ')}` });
      return;
    }
    const existing = deps.sessions.get(id);
    if (!existing) {
      res.status(404).json({ error: 'session not found' });
      return;
    }
    if (existing.status === 'revoked' || existing.status === 'archived') {
      res.status(409).json({ error: 'session is already terminated' });
      return;
    }
    if (existing.permission_mode === mode) {
      res.json(publicSession(existing));
      return;
    }
    const updated = deps.sessions.setPermissionMode(id, mode);
    // a live shell holds the OLD mode's restricted token; drop it so the next
    // call respawns under the new policy (cwd survives via the row)
    deps.runtimes.get(id)?.pwsh?.dispose();
    deps.runtimes.delete(id);
    const unconfirmed = await deps.processes?.stopSession(id, 'permission_changed') ?? [];
    deps.events.append(id, 'session_mode_switched', { permission_mode: mode, previous: existing.permission_mode });
    if (unconfirmed.length) { res.status(503).json({ error: 'process_cleanup_unconfirmed', processIds: unconfirmed, permissionMode: mode }); return; }
    res.json(publicSession(updated as NonNullable<typeof updated>));
  });

  // M4.6 writable_dirs：变更额外内核写授权目录 → respawn（旧 token 没有新目录的
  // capability SID，与会话模式切换同一套机制）
  app.patch('/sessions/:id/writable_dirs', async (req, res) => {
    const id = req.params.id as string;
    const existing = deps.sessions.get(id);
    if (!existing) {
      res.status(404).json({ error: 'session not found' });
      return;
    }
    if (existing.status === 'revoked' || existing.status === 'archived') {
      res.status(409).json({ error: 'session is already terminated' });
      return;
    }
    const dirs = normalizeWritableDirs((req.body as { writable_dirs?: unknown } | undefined)?.writable_dirs);
    if (!Array.isArray(dirs)) {
      res.status(400).json({ error: dirs.error });
      return;
    }
    const updated = deps.sessions.setWritableDirs(id, dirs);
    deps.runtimes.get(id)?.pwsh?.dispose();
    deps.runtimes.delete(id);
    const unconfirmed = await deps.processes?.stopSession(id, 'writable_dirs_changed') ?? [];
    deps.events.append(id, 'session_writable_dirs_changed', { writable_dirs: dirs });
    if (unconfirmed.length) { res.status(503).json({ error: 'process_cleanup_unconfirmed', processIds: unconfirmed }); return; }
    res.json(publicSession(updated as NonNullable<typeof updated>));
  });

  // Rename a session from VS Code or the Web console (empty name = back to the default title).
  app.patch('/sessions/:id/name', (req, res) => {
    const id = req.params.id as string;
    const existing = deps.sessions.get(id);
    if (!existing) {
      res.status(404).json({ error: 'session not found' });
      return;
    }
    const raw = ((req.body ?? {}) as { name?: unknown }).name;
    if (raw !== null && typeof raw !== 'string') {
      res.status(400).json({ error: 'name must be a string' });
      return;
    }
    const updated = deps.sessions.setName(id, raw);
    if (!('draft' in existing)) deps.events.append(id, 'session_renamed', { name: updated?.name ?? null });
    deps.changes.bump();
    res.json(publicSession(updated as NonNullable<typeof updated>));
  });

  // M4.6 auto_approve：confirm 级操作跳过审批卡（agent 摸不到——路由在 loopback 控制面）
  app.patch('/sessions/:id/auto_approve', (req, res) => {
    const id = req.params.id as string;
    const existing = deps.sessions.get(id);
    if (!existing) {
      res.status(404).json({ error: 'session not found' });
      return;
    }
    if (existing.status === 'revoked' || existing.status === 'archived') {
      res.status(409).json({ error: 'session is already terminated' });
      return;
    }
    const value = (req.body ?? {}) as { auto_approve?: unknown };
    const on = value.auto_approve === true || value.auto_approve === 1 || value.auto_approve === '1';
    const updated = deps.sessions.setAutoApprove(id, on);
    // runtime 缓存行同步（shell 不受影响：边界层不变）
    const rt = deps.runtimes.get(id);
    if (rt) rt.autoApprove = on;
    deps.events.append(id, 'session_auto_approve_changed', { auto_approve: on });
    res.json(publicSession(updated as NonNullable<typeof updated>));
  });

  app.get('/sessions/:id/events', (req, res) => {
    const id = req.params.id as string;
    if (!deps.sessions.get(id)) {
      res.status(404).json({ error: 'session not found' });
      return;
    }
    const after = Number(req.query.after ?? 0) || 0;
    const limit = Math.min(Number(req.query.limit ?? 200) || 200, 1000);
    const events = deps.events.listForSession(id, after, limit);
    res.json({
      events: events.map((e) => ({
        id: e.id,
        seq: e.seq,
        type: e.event_type,
        payload: safeParse(e.payload),
        created_at: new Date(e.created_at).toISOString(),
      })),
    });
  });

  app.get('/sessions/:id/calls', (req, res) => {
    const id = req.params.id as string;
    if (!deps.sessions.get(id)) {
      res.status(404).json({ error: 'session not found' });
      return;
    }
    // 浏览分页模式（VS Code 面板）：?anchor=&page= 按锚定 seq 窗口取一页，附 total/max_seq。
    // 旧会话只传输当前页（~20 条），不再每轮全量展开与重发。不带这两个参数 = 增量游标模式（原有语义不变）。
    if (req.query.anchor !== undefined || req.query.page !== undefined) {
      const limit = Math.min(Number(req.query.limit ?? 20) || 20, 200);
      const page = Math.max(0, Number(req.query.page ?? 0) || 0);
      const anchor = Number(req.query.anchor ?? 0) || 0;
      const calls = deps.toolCalls.listForSessionWindow(id, anchor, page, limit);
      // window_total：anchor 窗口内的行数（分页器页数依据）；total：全量（含锚定后新写入，
      // 第 0 页可见）。两个口径分开，深页不再因"全量多出的行"被误判越界钳回末页。
      res.json({
        calls,
        total: deps.toolCalls.countForSession(id),
        window_total: anchor > 0 ? deps.toolCalls.countForSession(id, anchor) : deps.toolCalls.countForSession(id),
        max_seq: deps.toolCalls.maxSeqForSession(id),
      });
      return;
    }
    // Cursor feed: pass back next_after as ?after= to fetch only new rows.
    // updated_after additionally re-flows older rows whose status changed
    // since the caller's last poll (a pure rowid cursor never re-sends
    // updates, so the UI would keep a stale badge until reload). Absent
    // updated_after means plain cursor mode: no re-flow — defaulting to 0
    // would re-send every row on every poll and defeat the cursor.
    const after = Number(req.query.after ?? 0) || 0;
    const updatedAfter = req.query.updated_after === undefined ? Number.MAX_SAFE_INTEGER : Number(req.query.updated_after) || 0;
    const calls = deps.toolCalls.listForSessionSince(id, after, 200, updatedAfter);
    // keep the cursor monotonic even when the batch ends with an updated older row
    const nextAfter = calls.reduce((m, c) => Math.max(m, c.seq), after);
    res.json({ calls, next_after: nextAfter });
  });

  // 会话时间线：feed（增量 + 长轮询）与 history（往上翻页），与 Web/手机共用一份处理函数（src/feed/）。
  // 调用原样输出行（含 navigation_json），和上面的 /calls 一致。
  mountFeedRoutes(app, deps, { mapCall: (c) => c });

  // A single synchronous snapshot for preview/copy: no stale credential or URL
  // from a webview message, and reading it never consumes the pending document.
  app.get('/sessions/:id/handoff', (req, res) => {
    const session = deps.sessions.get(req.params.id as string);
    if (!session) { res.status(404).json({ error: 'session not found' }); return; }
    if (!deps.handoffs) { res.status(503).json({ error: 'handoff unavailable' }); return; }
    const terminated = session.status === 'revoked' || session.status === 'archived';
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      handoff: terminated ? null : deps.handoffs.get(session.id),
      available: session.status === 'active' && (session.expires_at === null || session.expires_at >= Date.now()),
      session: publicSession(session),
      mcp_url: mcpUrl(deps),
      connection_routes: resolveConnectionRoutes(deps, mcpPath()),
      // Status only: a URL-free connector prompt also works over the OpenAI tunnel.
      openai_tunnel: deps.openaiTunnel ? { status: deps.openaiTunnel.view().status } : null,
    });
  });

  app.get('/sessions/:id/todos', (req, res) => {
    const id = req.params.id as string;
    if (!deps.sessions.get(id)) {
      res.status(404).json({ error: 'session not found' });
      return;
    }
    // 会话行存在即 200（哪怕已 revoked——行还在，板已随 revoke 清空）；
    // 404 只发生在 id 从不存在时。进度 N/M 由扩展端从 items 计算。
    const board = deps.todos.get(id);
    res.json({ items: board.items, ...(board.contract ? { contract: board.contract } : {}), updated_at: board.updated_at });
  });

  // 变更门控：扩展每 tick 只问 epoch，变了才拉会话/调用/确认的明细
  app.get('/changes', (_req, res) => {
    res.json({ epoch: deps.changes.epoch() });
  });

  app.get('/confirmations', (req, res) => {
    deps.confirmations.expireStale();
    const sessionId = typeof req.query.session_id === 'string' ? req.query.session_id : undefined;
    const rows = deps.confirmations.list(sessionId);
    // 审批卡的风险标签/高亮数据：创建时预计算在 confirmation_created 事件里，
    // 这里按 confirmation_id 反查最近一份（不改表结构，无 schema 迁移）
    const matchesBy = new Map<string, unknown>();
    for (const r of rows) {
      // Look the confirmation's own creation event up directly: a paged window
      // (listForSession) drops it once the session has >window events, leaving
      // the approval card with no tags or highlights.
      const row = deps.events.findConfirmationCreated(r.session_id, r.id);
      const ev = row ? (safeParse(row.payload) as { matches?: unknown }) : undefined;
      if (ev?.matches) matchesBy.set(r.id, ev.matches);
    }
    res.json({
      confirmations: rows.map((r) => ({
        ...r,
        risk_matches: matchesBy.get(r.id) ?? null,
        // The panel card's approval factor: loopback-only by construction
        // (this route refuses proxied/loopback-mismatched requests), so an
        // agent holding the public panelKey can never read it.
        ...(r.status === 'pending' ? { approval_pin: deps.approvalPins?.pinFor(r.session_id, r.id) ?? null } : {}),
      })),
    });
  });

  app.post('/confirmations/:id/:action(approve|deny)', (req, res) => {
    deps.confirmations.expireStale();
    const c = deps.confirmations.get(req.params.id as string);
    if (!c) {
      res.status(404).json({ error: 'confirmation not found' });
      return;
    }
    if (c.status !== 'pending') {
      res.status(409).json({ error: `confirmation is ${c.status}` });
      return;
    }
    if (c.expires_at <= Date.now()) {
      deps.confirmations.resolve(c.id, 'expired');
      res.status(409).json({ error: 'confirmation already expired' });
      return;
    }
    const action = req.params.action as 'approve' | 'deny';
    // approve may carry a scope (once / session / always); deny ignores it.
    // Unknown scope values are rejected, not silently downgraded to 'once'.
    const scope = (req.body as { scope?: string } | undefined)?.scope;
    if (action === 'approve' && scope !== undefined && !['once', 'session', 'always'].includes(scope)) {
      res.status(400).json({ error: 'scope must be one of once, session, always' });
      return;
    }
    const approvalScope = action === 'approve' && scope ? (scope as ApprovalScope) : action === 'approve' ? 'once' : undefined;
    const updated = resolveConfirmation(deps, c, action, approvalScope);
    res.json(updated);
  });

  // ─── standing approval grants ──────────────────────────────────
  // Both persistent machine-wide "always" grants and in-memory per-session
  // grants are effective no-ask permissions, so both must be visible to the
  // operator. Session grants intentionally disappear on daemon restart.
  // ─── phone access controls for the VS Code panel (plan 6.13 R4) ───────
  app.get('/remote', (_req, res) => {
    if (!deps.remote) { res.status(503).json({ error: 'remote_unavailable' }); return; }
    res.json(deps.remote.view());
  });
  app.post('/remote/probe', async (req, res) => {
    const body = req.body as { origin?: unknown } | undefined;
    if (!body || typeof body.origin !== 'string' || Object.keys(body).some((key) => key !== 'origin')) {
      res.status(400).json({ error: 'invalid_body' }); return;
    }
    const result = await deps.remote?.probe(body.origin);
    if (!result) { res.status(409).json({ error: 'remote_unavailable' }); return; }
    res.json(deps.remote!.view());
  });
  app.post('/remote/pair', (req, res) => {
    const origin = (req.body as { origin?: unknown } | undefined)?.origin;
    if (origin !== undefined && typeof origin !== 'string') { res.status(400).json({ error: 'invalid_body' }); return; }
    const r = deps.remote?.pair(typeof origin === 'string' ? origin : undefined);
    if (!r) { res.status(409).json({ error: 'remote_unavailable' }); return; }
    res.json(r);
  });
  app.post('/remote/requests/:id', (req, res) => {
    const allow = (req.body as { allow?: unknown } | undefined)?.allow;
    if (typeof allow !== 'boolean') { res.status(400).json({ error: 'invalid_body' }); return; }
    if (!deps.remote?.decide(String(req.params.id), allow)) { res.status(404).json({ error: 'request_not_found' }); return; }
    res.json(deps.remote.view());
  });
  app.post('/remote/devices/:id/revoke', (req, res) => {
    if (!deps.remote?.revoke(String(req.params.id))) { res.status(404).json({ error: 'device_not_found' }); return; }
    res.json(deps.remote.view());
  });

  app.get('/approvals', (_req, res) => {
    const sessions = new Map(deps.sessions.list().map((s) => [s.id, s]));
    res.json({
      always: deps.confirmations.listAlwaysGrants(),
      sessions: deps.confirmations.listSessionGrants().map(({ sessionId, grants }) => {
        const s = sessions.get(sessionId);
        return {
          session_id: sessionId,
          session_name: s?.name ?? null,
          workspace_path: s?.workspace_path ?? null,
          grants,
        };
      }),
    });
  });
  // the one-click reset valve for every persistent grant
  app.post('/approvals/clear', (_req, res) => {
    const removed = deps.confirmations.clearAlwaysGrants();
    deps.events.append(null, 'always_grants_cleared', { removed });
    res.json({ removed });
  });

  // Drop ONE in-memory session grant key. Session grants are scoped by the
  // stable session primary key used internally by approvals.
  app.post('/approvals/session/remove', (req, res) => {
    const body = (req.body ?? {}) as { session_id?: unknown; key?: unknown };
    if (typeof body.session_id !== 'string' || body.session_id === '' || typeof body.key !== 'string' || body.key === '') {
      res.status(400).json({ error: 'session_id and key are required' });
      return;
    }
    const removed = deps.confirmations.removeSessionGrant(body.session_id, body.key);
    if (!removed) {
      res.status(404).json({ error: 'no such session grant' });
      return;
    }
    deps.events.append(body.session_id, 'session_grant_removed', { key: body.key });
    res.json({ removed: 1 });
  });
  // drop ONE grant key (a row in the settings-page list)
  app.post('/approvals/:key/remove', (req, res) => {
    const key = decodeURIComponent(req.params.key as string);
    const removed = deps.confirmations.removeAlwaysGrant(key);
    if (!removed) {
      res.status(404).json({ error: 'no such always grant' });
      return;
    }
    deps.events.append(null, 'always_grant_removed', { key });
    res.json({ removed: 1 });
  });

  // ─── MCP Proxies（plan §5.2 设置页只读投影 + revalidate）─────
  // 单一事实源是 YAML 文件：这里只有掩码投影与校验报告，没有任何编辑入口
  //（file-only 红线：transport/command/args/env/scope/profile 的变更只能改文件）。
  app.get('/proxies', (_req, res) => {
    if (deps.proxy === undefined) {
      res.json({ configured: false });
      return;
    }
    res.json({
      configured: true,
      // v2.6：工具列表与 daemon 身份/表面代次同源——设置页据此判定数据是否仍属当前 daemon
      daemonId,
      surfaceGen: deps.proxy.surfaceGen(),
      status: proxyStatusReport(deps.proxy, true),
      disabled: deps.proxy.disabled.map((s) => s.name),
      config: proxyConfigProjection(deps.proxy),
      warnings: deps.proxy.warnings,
      metrics: deps.proxy.servers.map((s) => ({
        name: s.name,
        ...deps.proxy!.manager.metricsSnapshot(s.name),
        catalogAgeMs: deps.proxy!.registry.catalogAgeMs(s.name),
      })),
    });
  });

  // revalidate：重跑启动同款校验管道，只报告不触发 child 回收（plan §5.2）
  app.post('/proxies/revalidate', (_req, res) => {
    const load = loadProxyConfig(resolveProxyConfigPath({ proxyConfigPath: deps.cfg.proxyConfigPath }));
    res.json({
      servers: load.servers.map((s) => ({ name: s.name, transport: s.transport, ok: true })),
      quarantined: load.quarantined,
      warnings: load.warnings,
      note: 'report only — this does not touch running upstreams; use POST /proxies/reload (or the settings page) to apply a file change',
    });
  });

  // ─── M4 reload（管理路由，plan §5.3）+ 引导式编辑的原子写回（plan §5.2 第二步）──
  // 引导式编辑（plan §5.2 第二步）：UI 只送白名单字段 → 服务端原位合并进 YAML
  //（注释保留、机密不过网）→ 同款校验 → 原子写回 → reload（policyGen+1）
  app.post('/proxies/config/fields', (req, res) => {
    const body = (req.body ?? {}) as { server?: unknown; fields?: unknown };
    if (deps.reloadProxies === undefined) {
      res.status(409).json({ error: 'proxy runtime not configured' });
      return;
    }
    if (typeof body.server !== 'string' || body.server === '' || body.fields === null || typeof body.fields !== 'object' || Array.isArray(body.fields)) {
      res.status(400).json({ error: 'server (string) and fields (object) required' });
      return;
    }
    const target = resolveProxyConfigPath({ proxyConfigPath: deps.cfg.proxyConfigPath });
    let merged: string;
    try {
      merged = mergeEditableFields(fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '', body.server, body.fields as Record<string, unknown>);
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
      return;
    }
    const staging = `${target}.staging-${Date.now()}`;
    try {
      fs.writeFileSync(staging, merged);
      const preview = loadProxyConfig(staging);
      if (preview.quarantined.length > 0) {
        res.status(400).json({ error: 'config validation failed', quarantined: preview.quarantined });
        return;
      }
      fs.rmSync(staging, { force: true });
      fs.writeFileSync(staging, merged);
      fs.renameSync(staging, target);
      const report = deps.reloadProxies('guided-edit');
      deps.events.append(null, 'proxies_config_written', { source: 'guided-edit', server: body.server });
      res.json({ written: true, report });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      try { fs.rmSync(staging, { force: true }); } catch { /* already renamed */ }
    }
  });

  // ─── M4.6 设置页「新增 MCP」：表单字段 → 同款校验 → 追加进 YAML → 原子写回 → 热加载 ──
  // 红线修订记录（plan §5.2 v2.3）：应用户要求，新增/导入/启停走 loopback 管理路由；
  // 白名单编辑（/config/fields）依旧不含 file-only 字段；env 值落文件但所有输出掩码。
  app.post('/proxies/add', async (req, res) => {
    if (deps.reloadProxies === undefined) {
      res.status(409).json({ error: 'proxy runtime not configured' });
      return;
    }
    // body 即 server 条目本身：{ name, transport, command, args, env:{set}, enabled, ... }
    const entry = (req.body ?? {}) as Record<string, unknown>;
    if (typeof entry.name !== 'string' || entry.name.trim() === '') {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    const target = resolveProxyConfigPath({ proxyConfigPath: deps.cfg.proxyConfigPath });
    // v2.5 修复：文件可能尚不存在（设置页首次添加）——裸 readFileSync 会崩掉整个 daemon
    const beforeContent = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : ''; // 探活失败回滚用
    const seen = new Set<string>();
    try {
      const current = loadProxyConfig(target);
      for (const s of [...current.servers, ...current.disabled]) seen.add(s.name);
      for (const q of current.quarantined) seen.add(q.name);
    } catch { /* 没读到就当没有重名 */ }
    const checked = validateServerEntry(entry, seen);
    if (checked.error !== undefined || checked.server === undefined) {
      res.status(400).json({ error: checked.error ?? 'validation failed' });
      return;
    }
    const staging = `${target}.staging-${Date.now()}`;
    try {
      const merged = appendServerToYaml(beforeContent, entry);
      fs.writeFileSync(staging, merged);
      const preview = loadProxyConfig(staging);
      if (preview.quarantined.length > 0) {
        res.status(400).json({ error: 'config validation failed', quarantined: preview.quarantined });
        return;
      }
      fs.rmSync(staging, { force: true });
      fs.writeFileSync(staging, merged);
      fs.renameSync(staging, target);
      const report = deps.reloadProxies('proxies-add');
      // enabled=true is the operator's explicit instruction to start this MCP;
      // applyReload has already scheduled its connection and tools/list.
      deps.events.append(null, 'proxies_config_written', { source: 'proxies-add', server: entry.name });
      res.json({ added: true, starting: checked.server.enabled, warnings: checked.warnings, report });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      try { fs.rmSync(staging, { force: true }); } catch { /* renamed */ }
    }
  });

  // ─── M4.6 设置页「导入 JSON」：Claude Desktop / Cursor 通用 mcpServers 格式，
  // 批量转换 → 逐条校验 → 一次原子写回 → 一次热加载；失败条目不影响其他条目。
  app.post('/proxies/import', async (req, res) => {
    if (deps.reloadProxies === undefined) {
      res.status(409).json({ error: 'proxy runtime not configured' });
      return;
    }
    const text = (req.body as { json?: unknown } | undefined)?.json;
    if (typeof text !== 'string' || text.trim() === '') {
      res.status(400).json({ error: 'json body required' });
      return;
    }
    const { entries, errors } = convertMcpServersJson(text);
    if (entries.length === 0) {
      res.status(400).json({ error: 'no importable entries', failed: errors });
      return;
    }
    const target = resolveProxyConfigPath({ proxyConfigPath: deps.cfg.proxyConfigPath });
    const seen = new Set<string>();
    try {
      const current = loadProxyConfig(target);
      for (const s of [...current.servers, ...current.disabled]) seen.add(s.name);
      for (const q of current.quarantined) seen.add(q.name);
    } catch { /* 同上 */ }
    const staging = `${target}.staging-${Date.now()}`;
    try {
      let merged = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
      const added: string[] = [];
      const failed: { name: string; error: string; kept?: boolean }[] = [...errors];
      for (const { name, entry } of entries) {
        if (seen.has(name)) {
          failed.push({ name, error: 'duplicate server name' });
          continue;
        }
        try {
          merged = appendServerToYaml(merged, entry);
          seen.add(name);
          added.push(name);
        } catch (e) {
          failed.push({ name, error: e instanceof Error ? e.message : String(e) });
        }
      }
      if (added.length === 0) {
        res.status(400).json({ error: 'nothing imported', failed });
        return;
      }
      fs.writeFileSync(staging, merged);
      const preview = loadProxyConfig(staging);
      if (preview.quarantined.length > 0) {
        res.status(400).json({ error: 'config validation failed', quarantined: preview.quarantined });
        return;
      }
      fs.rmSync(staging, { force: true });
      fs.writeFileSync(staging, merged);
      fs.renameSync(staging, target);
      const report = deps.reloadProxies('proxies-import');
      // Enabled imports start immediately; disabled entries remain inert.
      deps.events.append(null, 'proxies_config_written', { source: 'proxies-import', servers: added });
      res.json({ imported: added, failed, report });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      try { fs.rmSync(staging, { force: true }); } catch { /* renamed */ }
    }
  });

  // ─── v2.6 设置页「查看工具列表」：数据永远属于当前 daemon ──
  // 语义分离：停用（enabled=false）只把 server 卸载出运行时、配置保留；工具目录若
  // 已在缓存里就照常展示。响应带上 daemonId + surfaceGen，设置页据此判定数据是否
  // 仍属当前 daemon，并在代次变化（MCP 重连 / 表面变化）时自动重取——不依赖手动按钮。
  app.post('/proxies/tools', async (req, res) => {
    const rt = deps.proxy;
    if (rt === undefined) {
      res.json({ configured: false, daemonId, surfaceGen: null, name: '', disabled: false, cachedOnly: true, tools: [] });
      return;
    }
    const body = (req.body ?? {}) as { server?: unknown; refresh?: unknown };
    const name = typeof body.server === 'string' ? body.server.trim() : '';
    if (name === '') {
      res.status(400).json({ error: 'server (string) required' });
      return;
    }
    const meta = { daemonId, surfaceGen: rt.surfaceGen() };
    const enabled = rt.servers.find((s) => s.name === name);
    const off = rt.disabled.find((s) => s.name === name);
    const server = enabled ?? off;
    if (server === undefined) {
      // 校验失败的条目也允许"查看"：回它的 config_error 原因，而不是 404
      const broken = rt.quarantined.find((q) => q.name === name);
      if (broken !== undefined) {
        res.json({ ...meta, configured: true, name, disabled: false, cachedOnly: true, tools: [], error: `config_error: ${broken.reason}` });
        return;
      }
      res.status(404).json({ error: `no server named "${name}"` });
      return;
    }
    // 掩码管道（plan §7.4）：描述里若混入已知机密，出网前统一替换
    const clean = (text: string): string => scanSecrets(text, rt.secretValues);
    const rowsOf = (tools: readonly UpstreamToolInfo[]): Record<string, unknown>[] => {
      // Operator catalog includes hidden tools; otherwise a checkbox cannot restore them.
      const { expose: _expose, ...surface } = server.surface;
      const bindings = rt.registry.bindingsForServer({ ...server, surface }, [...tools]);
      const sourceNames = (exposedName: string): string[] => rt.servers
        .filter((candidate) => rt.registry.bindingsForServer(candidate, rt.registry.cachedTools(candidate.name)).some((binding) => binding.exposedName === exposedName))
        .map((candidate) => candidate.name)
        .sort((a, b) => a.localeCompare(b));
      return bindings.map((binding) => {
        const sources = sourceNames(binding.exposedName);
        return {
          name: binding.exposedName,
          upstreamTool: binding.upstreamTool,
          description: clean(String(binding.tool?.description ?? binding.tool?.title ?? '')).slice(0, 400),
          enabled: server.surface.expose === undefined || server.surface.expose.includes(binding.upstreamTool),
          callable: (server.surface.expose === undefined || server.surface.expose.includes(binding.upstreamTool)) && sources.length <= 1,
          conflictSources: sources.length > 1 ? sources : [],
        };
      });
    };
    // Disabled means no catalog work, even when an old client asks to refresh.
    if (enabled === undefined) {
      res.json({ ...meta, configured: true, name, disabled: true, cachedOnly: true, tools: [] });
      return;
    }
    const cached = rt.registry.cachedTools(name);
    const wantRefresh = body.refresh === true;
    if (!wantRefresh) {
      res.json({ ...meta, configured: true, name, disabled: false, cachedOnly: true, tools: rowsOf(cached ?? []), ageMs: rt.registry.catalogAgeMs(name) });
      return;
    }
    const controlSession = CONTROL_TOOLS_SESSION + ':' + name + ':' + randomUUID();
    try {
      const view = await rt.registry.refresh(server, controlSession);
      if (!rt.servers.some(s => s.name === name)) {
        res.json({ ...meta, configured: true, name, disabled: true, cachedOnly: true, tools: [] });
        return;
      }
      rt.notifySurfaceChanged();
      res.json({
        ...meta, surfaceGen: rt.surfaceGen(),
        configured: true, name, disabled: false, cachedOnly: false,
        tools: rowsOf(view.tools), missing: view.missing, ageMs: rt.registry.catalogAgeMs(name),
      });
    } catch (e) {
      if (!rt.servers.some(s => s.name === name)) {
        res.json({ ...meta, configured: true, name, disabled: true, cachedOnly: true, tools: [] });
        return;
      }
      const currentCache = rt.registry.cachedTools(name);
      res.json({
        ...meta,
        configured: true, name, disabled: false, cachedOnly: currentCache !== undefined,
        tools: rowsOf(currentCache ?? []),
        error: clean(e instanceof Error ? e.message : String(e)),
      });
    } finally {
      // 一次性 child 回收（shared scope 的 child 不受影响，closeSession 只匹配自己的键）
      try { await rt.manager.closeSession(controlSession); } catch { /* best effort */ }
    }
  });

  // ─── v2.6 设置页「删除 MCP」：与"停用"分离 —— 停用只停不删，删除才从 YAML 摘除 ──
  // 与 /proxies/add 对称：先摘除条目（注释保留）→ 同款校验 → 原子写回 → reload。
  app.post('/proxies/remove', (req, res) => {
    if (deps.reloadProxies === undefined) {
      res.status(409).json({ error: 'proxy runtime not configured' });
      return;
    }
    const name = (req.body as { server?: unknown } | undefined)?.server;
    if (typeof name !== 'string' || name.trim() === '') {
      res.status(400).json({ error: 'server (string) required' });
      return;
    }
    const target = resolveProxyConfigPath({ proxyConfigPath: deps.cfg.proxyConfigPath });
    if (!fs.existsSync(target)) {
      res.status(404).json({ error: 'no proxy config file' });
      return;
    }
    // 存在性以文件加载结果为准（removeServerFromYaml 会规范化文本，不能拿"文本是否
    // 变化"当依据）；quarantined 条目也可删——这正是清理坏条目的入口
    const current = loadProxyConfig(target);
    const known =
      [...current.servers, ...current.disabled].some((s) => s.name === name) ||
      current.quarantined.some((q) => q.name === name);
    if (!known) {
      res.status(404).json({ error: `no server named "${name}" in config` });
      return;
    }
    const before = fs.readFileSync(target, 'utf8');
    const merged = removeServerFromYaml(before, name);
    const staging = `${target}.staging-${Date.now()}`;
    try {
      fs.writeFileSync(staging, merged);
      const preview = loadProxyConfig(staging);
      if (preview.quarantined.length > 0) {
        res.status(400).json({ error: 'config validation failed', quarantined: preview.quarantined });
        return;
      }
      fs.rmSync(staging, { force: true });
      fs.writeFileSync(staging, merged);
      fs.renameSync(staging, target);
      const report = deps.reloadProxies('proxies-remove');
      deps.events.append(null, 'proxies_removed', { server: name, source: 'settings-page' });
      res.json({ removed: true, report });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      try { fs.rmSync(staging, { force: true }); } catch { /* renamed */ }
    }
  });

  app.post('/proxies/reload', (_req, res) => {
    if (deps.reloadProxies === undefined) {
      res.status(409).json({ error: 'proxy runtime not configured' });
      return;
    }
    res.json(deps.reloadProxies('admin-route'));
  });

  /**
   * 管理命令入口（plan §5.3 三入口之一：文件监听 / 设置页 / 管理命令），**整文件**写回。
   *
   * 红线（plan §5.2/§16）：file-only 字段（transport/command/args/env/scope/profile）
   * 永远不得出现在**设置页**——设置页只能走下面的 /proxies/config/fields 白名单路径。
   * 本路由是 operator 的管理通道（loopback-only + 同款校验 + 原子写回），
   * 不得被任何 UI 客户端接线；E2E 用它验证"坏配置拒绝落盘"。
   */
  app.post('/proxies/config', (req, res) => {
    const yaml = (req.body as { yaml?: unknown } | undefined)?.yaml;
    if (typeof yaml !== 'string' || yaml.trim() === '') {
      res.status(400).json({ error: 'yaml body required' });
      return;
    }
    if (deps.reloadProxies === undefined) {
      res.status(409).json({ error: 'proxy runtime not configured' });
      return;
    }
    // 先校验后落盘：写临时文件走同款加载管道，结构/引用错误不落盘（plan §5.2）
    const target = resolveProxyConfigPath({ proxyConfigPath: deps.cfg.proxyConfigPath });
    const staging = `${target}.staging-${Date.now()}`;
    try {
      fs.writeFileSync(staging, yaml);
      const preview = loadProxyConfig(staging);
      // 校验失败不落盘（plan §5.2）：解析级错误与 per-server 隔离项都算失败，
      // 字段级 reason 一并回传
      if (preview.quarantined.length > 0) {
        res.status(400).json({ error: 'config validation failed', quarantined: preview.quarantined });
        return;
      }
      if (preview.servers.length === 0) {
        res.status(400).json({ error: 'config has no server entries' });
        return;
      }
      fs.rmSync(staging, { force: true });
      // 原子写回：临时文件 + rename（plan §5.2）
      fs.writeFileSync(staging, yaml);
      fs.renameSync(staging, target);
      const report = deps.reloadProxies('config-write');
      deps.events.append(null, 'proxies_config_written', {});
      res.json({ written: true, report });
    } finally {
      try { fs.rmSync(staging, { force: true }); } catch { /* rename already moved it */ }
    }
  });

  // ─── M2 取消入口：pending 审批与 in-flight call 均可取消（plan §8.3）──
  // VS Code（loopback）与 panel（capabilities 路由）共用 runtime.cancelCall。
  // body.session_id 可选但强烈建议带上：callId 是 tool_calls 行 id（自增整数），
  // 带上它即做归属校验，避免一个 session 的 UI 取消到别的 session 的调用。
  app.post('/calls/:callId/cancel', (req, res) => {
    const callId = req.params.callId as string;
    const body = (req.body ?? {}) as { session_id?: unknown };
    const sessionId = typeof body.session_id === 'string' && body.session_id !== '' ? body.session_id : undefined;
    const okCancel = deps.proxy?.cancelCall(callId, sessionId) ?? false;
    if (!okCancel) {
      res.status(404).json({ error: 'no cancellable call with this id' });
      return;
    }
    deps.events.append(sessionId ?? null, 'proxy_call_cancelled', { call_id: callId, source: 'control-api' });
    res.json({ cancelled: true });
  });

  return app;
}

/**
 * True when the confirmation's command matched at least one CRITICAL risk
 * pattern (the card stores the precomputed matches on the event; the row only
 * keeps args). Re-derives from the command text — same patterns, so the same
 * verdict the card showed.
 */
function hasCriticalMatch(argsJson: string): boolean {
  let command = '';
  try {
    command = (JSON.parse(argsJson) as { command?: string }).command ?? '';
  } catch {
    return false;
  }
  if (!command) return false;
  for (const m of riskMatches(command)) {
    if (m.level === 'critical') return true;
  }
  return false;
}

/**
 * Apply an approve/deny decision to a pending confirmation — the single
 * resolution path shared by the loopback control API and the public panel-card
 * route (src/panel/index.ts), so the critical-pattern 'always' downgrade and
 * the audit events can never drift between the two surfaces. The caller has
 * already validated status/expiry and the action's authenticity.
 */
export function resolveConfirmation(
  deps: Pick<DaemonDeps, 'confirmations' | 'events'>,
  c: { id: string; session_id: string; args_json: string },
  action: 'approve' | 'deny',
  approvalScope: ApprovalScope | undefined,
): ConfirmationRow | undefined {
  // A critical-pattern command may never earn an 'always' grant (its
  // no-ask window must not survive a restart). Answer 200 with the
  // downgrade instead of an error: the operator already chose, the call
  // must not hang on a policy detail.
  const capped = approvalScope === 'always' && hasCriticalMatch(c.args_json) ? 'session' : approvalScope;
  if (capped !== approvalScope) {
    deps.events.append(c.session_id, 'confirmation_resolved', {
      confirmation_id: c.id,
      status: 'approved',
      scope: 'session',
      note: 'critical patterns cannot be granted "always"; downgraded to session',
    });
  }
  const status = action === 'approve' ? 'approved' : 'denied';
  const updated = deps.confirmations.resolve(c.id, status, capped);
  deps.events.append(c.session_id, 'confirmation_resolved', { confirmation_id: c.id, status, scope: capped ?? null });
  return updated;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
