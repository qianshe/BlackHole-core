import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import express, { type Express, type Request, type Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SessionRuntime } from '../runtime.js';
import { normalizePermissionMode, type Config } from '../config.js';
import type { DaemonDeps } from '../deps.js';
import { buildAccessRules } from '../workspace/rules.js';
import { PersistentShell } from '../workspace/pwsh.js';
import { detectExecutionEnvironment, finiteDescription } from '../execution.js';
import { deriveAccessToken, isSessionId } from '../util/token.js';
import { detectShell } from '../workspace/shell.js';
import { panelHtml, PANEL_RESOURCE_URI, RESOURCE_MIME_TYPE } from '../panel/appHtml.js';
import { publicBaseUrl } from '../deps.js';
import { KEYLESS_TOOLS, registerTools } from './tools.js';
import { VERSION } from '../version.js';
import { INTEGRITY_MESSAGE, integrityFailures } from '../integrity.js';


interface ProtocolPair {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  initialized: boolean;
  /** Last request time; idle pairs are swept by TTL (see PROTOCOL_TTL_MS). */
  lastActiveAt: number;
  /**
   * True once a bare POST has ridden this pair via the credential map — the
   * pair then serves as a warm pipe (bh.py fast path) and keeps the long TTL.
   */
  adopted?: boolean;
  /**
   * True for hosts that open one connection PER TOOL CALL (measured: the GPT
   * connector). Each such connection mints a full McpServer instance tree it
   * uses for a single call (~seconds); reaping them after a 60s grace window
   * instead of the 3-minute default keeps a busy agent session (30–100 calls,
   * seconds apart) from parking dozens of dead instance trees in memory.
   */
  ephemeral?: boolean;
}

type AccessFailure = { code: 403 | 404; message: string };

export interface ProtocolCleaner {
  closeAll(): Promise<void>;
}

export function mountMcp(app: Express, deps: DaemonDeps): ProtocolCleaner {
  const protocols = new Map<string, ProtocolPair>();
  const pending = new Set<ProtocolPair>();
  // A persistent PowerShell may back the stable `exec` tool on Windows.
  const execution = deps.execution ?? detectExecutionEnvironment();
  const pwshBin = execution.exec.pwshBin;
  if (pwshBin) deps.log(`exec: persistent PowerShell via ${pwshBin}`);
  const machine = { execDescription: finiteDescription(execution) };

  const getRuntime = (deps: DaemonDeps, row: SessionRuntime['session']): SessionRuntime => {
    let rt = deps.runtimes.get(row.id);
    if (!rt) {
      rt = new SessionRuntime(
        {
          id: row.id,
          token_hash: '',
          credential_id: row.credential_id,
          name: null,
          workspace_path: row.workspace_path,
          status: 'active',
          permission_mode: row.permission_mode,
          writable_dirs: row.writable_dirs ?? [],
          auto_approve: String(row.auto_approve ?? '') === '1' || row.auto_approve === true,
          cwd: row.cwd,
          created_at: 0,
          last_active_at: 0,
          sort_order: row.sort_order ?? 0,
          expires_at: null,
        },
        /* shell */ getShellAdapter(),
      );
      if (pwshBin) {
        const mode = normalizePermissionMode(rt.session.permission_mode);
        // Windows read-only/workspace-write sessions run under the ACL token;
        // danger-full-access is an explicit operator choice and therefore uses
        // the normal host shell with no workspace write restriction. POSIX
        // commands are confined separately by runShell's platform backend.
        rt.pwsh = process.platform === 'win32' && mode !== 'danger-full-access'
          ? makeSandboxedShell(deps, rt, pwshBin)
          : new PersistentShell({ cwd: rt.cwd, bin: pwshBin, timeoutMs: deps.cfg.execMaxTimeoutMs });
      }
      const runtime = rt;
      rt.beforeExecute = async () => {
        await deps.entitlement?.ensure();
        // Admission happens after queue/approval waits. Old runtime references
        // must never respawn a shell after revoke or a permission-mode change.
        const current = deps.sessions.get(row.id);
        if (!current || current.status !== 'active'
          || (current.expires_at !== null && current.expires_at < Date.now())
          || deps.runtimes.get(row.id) !== runtime) {
          throw new Error('Session execution context changed while waiting; command was not started.');
        }
      };
      deps.runtimes.set(row.id, rt);
    }
    return rt;
  };

  /**
   * The URL token is machine-level: any session may connect through it, and
   * which session a tool call operates on is decided per call by the `key`
   * argument (the session token, hashed in `sessions.token_hash`).
   */
  const checkAccess = (token: string): AccessFailure | undefined => {
    if (token !== deriveAccessToken()) return { code: 404, message: 'unknown MCP endpoint' };
    return undefined;
  };

  /** Row checks shared by both resolvers, so failures read the same either way. */
  const checkSession = (
    row: ReturnType<typeof deps.sessions.get>,
  ): SessionRuntime | { error: string } => {
    if (!row || row.status === 'revoked' || row.status === 'archived') {
      return { error: 'unknown or revoked session ID' };
    }
    if (row.expires_at !== null && row.expires_at < Date.now()) {
      return { error: 'session ID expired' };
    }
    if (row.status === 'paused') {
      return { error: 'session is paused' };
    }
    deps.sessions.touch(row.id);
    return getRuntime(deps, row);
  };

  /**
   * Resolve a work-tool `sessionId` (the numeric credential). The activation
   * value era is gone: this is the single routing surface, so the refusal
   * wording deliberately never confirms whether a value is a live id.
   */
  const resolveWorkSession = (ref: string): SessionRuntime | { error: string } => {
    if (!isSessionId(ref)) return { error: 'unknown or revoked session ID' };
    return checkSession(deps.sessions.byCredential(ref));
  };


  const fail = (res: Response, code: number, message: string): void => {
    res.status(code).json({ jsonrpc: '2.0', error: { code: code === 404 ? -32001 : -32002, message }, id: null });
  };

  /**
   * Per-request trace line (BlackHole output channel): one line per /mcp
   * request with the raw sequence facts the counters cannot show —
   * JSON-RPC method, tool name, whether the CLIENT sent a session header
   * (captured before warm-pair injection), the sessionId argument, and the
   * final status. This is the evidence needed to classify a host's
   * connection behavior (per-turn vs per-call vs pooled) from one live run.
   * Deliberately always-on: request rates are low and the output channel is
   * a rolling buffer, while post-mortem value is high during bring-up.
   */
  const traceMcp = (req: Request, res: Response): void => {
    const t0 = Date.now();
    const header = typeof req.headers['mcp-session-id'] === 'string' ? 'y' : 'n';
    const msgs = (Array.isArray(req.body) ? req.body : [req.body]) as { method?: string; params?: { name?: string; arguments?: { sessionId?: unknown } } }[];
    const desc = msgs
      .map((m) => {
        const tool = m?.params?.name ? `(${m.params.name})` : '';
        // full sid: post-mortem matching against a session's credential_id
        const sid = m?.params?.arguments?.sessionId;
        const arg = m?.params?.name === 'guide' ? '' : typeof sid === 'string' && sid.length > 0 ? ` sid=${sid}` : '';
        return `${m?.method ?? '-'}${tool}${arg}`;
      })
      .join(' | ');
    // the connecting client's self-reported name rides on the initialize line
    const client = header === 'n' && msgs.some((m) => m?.method === 'initialize') ? ` client=${clientNameOf(req.body)}` : '';
    res.on('finish', () => {
      const ms = Date.now() - t0;
      // a call holding for operator approval shows as a long duration — that
      // is the pause, not a transport problem; anything else slow is real
      const took = ms > 1000 ? ` ${ms}ms` : '';
      deps.log(`trace: ${req.method} [${desc}] header=${header}${client} -> ${res.statusCode}${took}`);
    });
  };

  /**
   * Hosts like the ChatGPT connector initialize a fresh protocol session per
   * turn and never DELETE, so protocol pairs accumulate forever. Sweep idle
   * ones; activity refreshes the window (see PROTOCOL_TTL_MS). The same TTL
   * bounds the credential→pair map below.
   */
  const PROTOCOL_TTL_MS = 30 * 60_000;
  /** Default idle reaping (unknown clients, idle SDK connections). */
  const IDLE_TTL_MS = 3 * 60_000;
  /**
   * Per-call-connection hosts (see EPHEMERAL_CLIENTS): one call ≈ seconds, but
   * a call paused for operator approval can legally hang for the whole
   * CONFIRMATION_TTL_MS window — the pipe must outlive the approval it might
   * be waiting on, or the approval resolves with nobody listening.
   */
  const EPHEMERAL_TTL_MS = 90_000;
  const sweepIdleProtocols = (): void => {
    const now = Date.now();
    for (const [protocolId, pair] of protocols) {
      const ttl = pair.adopted ? PROTOCOL_TTL_MS : pair.ephemeral ? EPHEMERAL_TTL_MS : IDLE_TTL_MS;
      const cutoff = now - ttl;
      if (pair.lastActiveAt >= cutoff) continue;
      protocols.delete(protocolId);
      // the map is credential→protocolId: drop entries pointing at this pair
      for (const [cred, pid] of credToProtocol) if (pid === protocolId) credToProtocol.delete(cred);
      deps.events.append(null, 'mcp_delete', { target: protocolId, swept: pair.adopted ? 'warm-ttl' : 'idle-ttl' });
      void pair.transport.close().catch(() => undefined);
      void pair.server.close().catch(() => undefined);
    }
  };
  const sweeper = setInterval(sweepIdleProtocols, 60_000);
  sweeper.unref();

  /**
   * credential → protocol session id. Lets a client that skipped the MCP
   * handshake ride an already-initialized pair: the request arrives bare (no
   * Mcp-Session-Id) but carries the numeric sessionId argument, so we inject
   * the mapped header and the call lands on a warm connection — one round trip
   * instead of initialize + initialized + call. Standard clients are unaffected
   * (their own state machine insists on the handshake; they simply never send
   * a bare call). For workspace calls a pair is just a warm pipe; the
   * sessionId argument alone decides which session the call touches. Entries
   * die with the TTL sweep and with credential rotation (the old key stops
   * arriving, and lookups miss).
   */
  const credToProtocol = new Map<string, string>();
  const sessionIdArgs = (body: unknown): string[] => {
    const msgs = Array.isArray(body) ? body : [body];
    const ids: string[] = [];
    for (const m of msgs as { method?: string; params?: { arguments?: { sessionId?: unknown } } }[]) {
      // tool-call shape: params.arguments.sessionId (the schema-level argument)
      const sid = m?.params?.arguments?.sessionId;
      if (m?.method === 'tools/call' && typeof sid === 'string' && sid.length > 0) ids.push(sid);
    }
    return ids;
  };
  /**
   * MCP request interceptor: restore a warm protocol before the MCP handler
   * resolves the session. This is deliberately before transport handling —
   * the transport only sees the final mcp-session-id value.
   */
  const resolveWarmProtocol = (req: Request, body: unknown): string | undefined => {
    // Guide and show depend on the caller's own capabilities. Never borrow a
    // native Apps handshake for a script or an unidentified bare request.
    // Existing bh.py handles -32002 by initializing its own connection.
    const messages = (Array.isArray(body) ? body : [body]) as { method?: string; params?: { name?: string } }[];
    if (messages.some(m => m?.method === 'tools/call' && (m.params?.name === 'guide' || m.params?.name === 'show'))) return undefined;
    for (const sid of sessionIdArgs(body)) {
      const mapped = credToProtocol.get(sid);
      const pair = mapped ? protocols.get(mapped) : undefined;
      if (pair && mapped) {
        // The SDK transport rebuilds headers from req.rawHeaders, so update
        // both views before the request enters MCP handling.
        req.headers['mcp-session-id'] = mapped;
        req.rawHeaders?.push('mcp-session-id', mapped);
        pair.adopted = true;
        deps.events.append(null, 'mcp_session_reused', { protocol_id: mapped, via: 'interceptor' });
        return mapped;
      }
      if (mapped) credToProtocol.delete(sid);
    }
    return undefined;
  };
  const rememberPairFor = (protocolId: string, body: unknown): void => {
    for (const sid of sessionIdArgs(body)) credToProtocol.set(sid, protocolId);
  };

  /**
   * Diagnosability for calls that die BEFORE any handler runs. A model that
   * keeps calling without the sessionId argument (or a host that drops the
   * session header) fails at the schema/route layer — invisible in the
   * session feed (no id to attribute) and indistinguishable from silence in
   * the counters. One machine-level row per rejected call makes the failure
   * visible where the operator already looks.
   */
  const noteCallRejection = (body: unknown, reason: string, detail: Record<string, unknown> = {}): void => {
    const msgs = (Array.isArray(body) ? body : [body]) as { method?: string; params?: { name?: string; arguments?: { sessionId?: unknown } } }[];
    for (const m of msgs) {
      if (m?.method !== 'tools/call') continue;
      const name = m.params?.name ?? '?';
      if (KEYLESS_TOOLS.has(name)) continue; // legitimately id-free
      if (reason !== 'no-session-header') {
        const sid = m.params?.arguments?.sessionId;
        if (typeof sid === 'string' && sid.length > 0) continue; // carries an id: handler-layer rejection is attributable
      }
      deps.events.append(null, 'mcp_call_rejected', { reason, tool: name, ...detail });
    }
  };

  /**
   * Client names (initialize clientInfo.name, case-insensitive substring)
   * that identify per-call-connection hosts → 60s TTL. Extend via
   * BLACKHOLE_EPHEMERAL_CLIENTS (comma-separated) when a new host shows the
   * same pattern; unknown names fall back to the default 3-minute TTL, so a
   * renamed host degrades to the old behaviour instead of breaking.
   */
  const EPHEMERAL_CLIENTS = [
    'chatgpt', 'openai', // measured: the connector re-initializes on every tool call
    ...(process.env.BLACKHOLE_EPHEMERAL_CLIENTS?.split(',').map((c) => c.trim().toLowerCase()).filter(Boolean) ?? []),
  ];
  const clientNameOf = (body: unknown): string => {
    const msgs = (Array.isArray(body) ? body : [body]) as { params?: { clientInfo?: { name?: unknown } } }[];
    for (const m of msgs) {
      const n = m?.params?.clientInfo?.name;
      if (typeof n === 'string' && n.length > 0) return n;
    }
    return '';
  };
  const isEphemeralClient = (body: unknown): boolean => {
    const name = clientNameOf(body).toLowerCase();
    return name !== '' && EPHEMERAL_CLIENTS.some((frag) => name.includes(frag));
  };

  const hostFromHeader = (value: string): string | undefined => {
    const first = value.split(',')[0]?.trim().replace(/^"(.*)"$/, '$1');
    if (!first) return undefined;
    try { return new URL(`http://${first}`).hostname.toLowerCase().replace(/^\[|\]$/g, ''); }
    catch { return undefined; }
  };
  const firstHeaderValue = (value: string | string[] | undefined): string | undefined => {
    const raw = Array.isArray(value) ? value[0] : value;
    return raw?.split(',')[0]?.trim().replace(/^"(.*)"$/, '$1') || undefined;
  };
  const panelBaseForRequest = (req: Request): string => {
    const fallback = `http://${deps.cfg.host ?? '127.0.0.1'}:${deps.cfg.port ?? 7306}`;
    const tunnelOrigin = (() => {
      const raw = deps.tunnel?.url;
      if (!raw) return undefined;
      try { return new URL(raw).origin; }
      catch { return undefined; }
    })();
    const fromCloudflare = req.headers['cf-ray'] !== undefined || req.headers['cf-connecting-ip'] !== undefined;
    const rawHost = firstHeaderValue(req.headers['x-forwarded-host']) ?? firstHeaderValue(req.headers.host);
    const hostname = rawHost ? hostFromHeader(rawHost) : undefined;
    if (!rawHost || !hostname) return fromCloudflare && tunnelOrigin ? tunnelOrigin : fallback;
    const localHosts = new Set(['localhost', '127.0.0.1', '::1', (deps.cfg.host ?? '127.0.0.1').toLowerCase()]);
    if (localHosts.has(hostname)) {
      if (fromCloudflare && tunnelOrigin) return tunnelOrigin;
      try { return new URL(`http://${rawHost}`).origin; }
      catch { return fallback; }
    }
    const configured = deps.cfg.publicBaseUrl?.trim();
    if (configured) {
      try {
        const url = new URL(configured);
        if (url.hostname.toLowerCase() === hostname) return url.origin;
      } catch { /* invalid configured base is ignored here and reported elsewhere */ }
    }
    if (tunnelOrigin) {
      const tunnelHost = new URL(tunnelOrigin).hostname.toLowerCase();
      if (tunnelHost === hostname) return tunnelOrigin;
    }
    return fallback;
  };
  const buildPair = (req: Request): ProtocolPair => {
    const presentationBase = panelBaseForRequest(req);
    const pair: ProtocolPair = {
      transport: undefined as unknown as StreamableHTTPServerTransport,
      server: undefined as unknown as McpServer,
      initialized: false,
      lastActiveAt: Date.now(),
    };
    const transport = new StreamableHTTPServerTransport({
      // JSON responses instead of SSE streams: every tool here returns one
      // synchronous result, so streaming buys nothing — while per-call hosts
      // (GPT connector) paid a stream setup per request. bh.py and SDK
      // clients both accept plain JSON (protocol-mandated), and an approval
      // pause is invisible to the transport (the handler simply has not
      // returned yet), so blocking approval flows are unaffected.
      enableJsonResponse: true,
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        pair.initialized = true;
        pending.delete(pair);
        protocols.set(id, pair);
        // v2.6：主机（重）连接代次自增——设置页据此自动重取每个 MCP 的工具列表，
        // 无需手动刷新（ChatGPT 连接器每轮都会 initialize，正好覆盖"重连即同步"）。
        deps.mcpConnGen = (deps.mcpConnGen ?? 0) + 1;
        // machine-level audit trail: one row per completed MCP handshake —
        // a client that re-initializes every turn (the ChatGPT connector
        // pattern) shows up here, which is what the status-bar counters read
        deps.events.append(null, 'mcp_initialize', { protocol_id: id });
      },
      onsessionclosed: (id) => {
        if (id) protocols.delete(id);
        pending.delete(pair);
      },
    });
    // One McpServer per connection — the SDK's Protocol.connect is strictly
    // one-transport-per-instance ("Already connected" otherwise), so sharing a
    // single server across pairs is not possible. Connector hosts may repeat
    // initialize for every tool call; keep this payload empty and use the
    // keyless guide tool for the full manual.
    const rules = buildAccessRules();
    const server = new McpServer(
      { name: 'blackhole', version: VERSION },
      {
        instructions: '',
        // MCP-Apps capability declaration: Apps hosts (ChatGPT) check
        // capabilities.extensions["io.modelcontextprotocol/ui"] on the
        // initialize result before they ever attempt to render a card; without
        // it the `_meta.ui.resourceUri` on tool results is dead weight (the
        // silent failure we saw in real-device testing). The old SDK never
        // strips unknown capability keys on the wire (verified), so the plain
        // object passes through to new-protocol clients.
        capabilities: {
          extensions: {
            'io.modelcontextprotocol/ui': { mimeTypes: [RESOURCE_MIME_TYPE] },
          },
        },
      } as ConstructorParameters<typeof McpServer>[1],
    );
    const widgetDomain = (() => {
      const raw = deps.cfg.publicBaseUrl?.trim();
      if (!raw) return undefined;
      try {
        const origin = new URL(raw).origin;
        return origin === presentationBase ? origin : undefined;
      } catch {
        return undefined;
      }
    })();
    // Keep the MCP Apps template URI stable. The show result reads the current
    // public base at call time; the resource body does the same when the host reads it.
    const panelResourceUri = PANEL_RESOURCE_URI;
    server.registerResource(
      'workspace_rules',
      'blackhole://rules',
      { title: 'Workspace Manual', description: 'Session addressing and operating conventions.', mimeType: 'text/markdown' },
      async (uri) => ({ contents: [{ uri: uri.href, text: rules }] }),
    );
    // MCP-Apps panel card: the iframe document behind the `_meta.ui.resourceUri`
    // that show attaches for Apps-capable hosts (ChatGPT). One
    // template resource — the panel key stays out of this static shell, and
    // the HTML discovers the current reachable base from the show result rather
    // than pinning one into the static registration.
    // Static panel shell (spec: ui:// scheme, discovered via the tool
    // DEFINITION's _meta.ui.resourceUri and preloadable before any call).
    // The shell knows nothing about sessions; the host pushes each
    // show CallToolResult into the iframe
    // (ui/notifications/tool-result), and the card extracts panel_key/base
    // from structuredContent to start polling its session.
    server.registerResource(
      'session_panel',
      panelResourceUri,
      {
        title: 'Session Panel',
        description: 'Live progress, tool calls and approvals for one workspace session.',
        mimeType: RESOURCE_MIME_TYPE,
        _meta: {
          ui: {
            // CSP belongs on the resource contents returned below; keeping it
            // out of the static registration avoids pinning a stale tunnel base.
            prefersBorder: true,
            ...(widgetDomain ? { domain: widgetDomain } : {}),
          },
          ...(widgetDomain ? { 'openai/widgetDomain': widgetDomain } : {}),
        },
      },
      async (uri) => ({
        contents: [
          {
            uri: uri.href,
            mimeType: RESOURCE_MIME_TYPE,
            text: panelHtml(),
            _meta: {
              ui: {
                csp: { resourceDomains: [], connectDomains: [presentationBase] },
                prefersBorder: true,
                ...(widgetDomain ? { domain: widgetDomain } : {}),
              },
              ...(widgetDomain ? { 'openai/widgetDomain': widgetDomain } : {}),
            },
          },
        ],
      }),
    );
    server.registerPrompt(
      'blackhole_operator',
      { title: 'Start operating a workspace', description: 'Session and safety discipline before making any change' },
      () => ({ messages: [{ role: 'user' as const, content: { type: 'text' as const, text: rules } }] }),
    );
    registerTools(server, resolveWorkSession, {
      ...deps,
      panelBase: () => presentationBase,
      panelResourceUri,
    }, machine);
    pair.transport = transport;
    pair.server = server;
    return pair;
  };

  app.post('/mcp/:token', expressJsonForMcp(deps.cfg), async (req: Request, res: Response) => {
    traceMcp(req, res);
    const denied = checkAccess(req.params.token as string);
    if (denied) return fail(res, denied.code, denied.message);
    const hasToolCall = Array.isArray(req.body) ? req.body.some(x => x?.method === 'tools/call') : req.body?.method === 'tools/call';
    if (hasToolCall && integrityFailures().length) return fail(res, 503, INTEGRITY_MESSAGE);
    if (hasToolCall && deps.entitlement) {
      try { await deps.entitlement.beforeToolCall(); }
      catch { return fail(res, 403, 'entitlement_verification_required: BlackHole 订阅已到期或账号需要重新登录，请打开 BlackHole 处理后重试'); }
    }
    const sessionId = req.headers['mcp-session-id'];
    // visibility for schema-layer rejections (missing sessionId argument)
    noteCallRejection(req.body, 'missing-session-id');
    let pair: ProtocolPair | undefined;
    if (typeof sessionId === 'string') {
      pair = protocols.get(sessionId);
      if (!pair) return fail(res, 404, 'stale MCP session; reconnect and initialize again');
      pair.lastActiveAt = Date.now();
      // reuse counter (the other half of the protocol stats: a host that
      // handshakes every turn still reuses nothing, a healthy one shows
      // reuse >> initialize)
      deps.events.append(null, 'mcp_session_reused', { protocol_id: sessionId, via: 'header' });
      rememberPairFor(sessionId, req.body);
    } else {
      // bare POST carrying the numeric sessionId: adopt a warm pair instead of
      // making the client re-handshake (bh.py's fast path)
      if (!resolveWarmProtocol(req, req.body)) {
        // Only a real initialize may open a protocol pair. Anything else
        // arriving bare (a stray notification, a call the map cannot place)
        // gets the same semantic error WITHOUT minting a throwaway pair —
        // one host turn must count as one initialize, nothing else.
        const msgs = (Array.isArray(req.body) ? req.body : [req.body]) as { method?: string }[];
        if (!msgs.some((m) => m?.method === 'initialize')) {
          // visibility for route-layer rejections (bare call the map cannot place)
          noteCallRejection(req.body, 'no-session-header');
          return fail(res, 400, 'no MCP session: initialize first, send the Mcp-Session-Id header, or carry the sessionId argument');
        }
        pair = buildPair(req);
        pair.ephemeral = isEphemeralClient(req.body); // per-call hosts get the 60s tier
        pending.add(pair);
        try {
          await pair.server.connect(pair.transport);
        } catch (e) {
          pending.delete(pair);
          deps.log(`mcp: failed to init protocol session: ${e instanceof Error ? e.message : e}`);
          return fail(res, 500, 'failed to initialize MCP transport');
        }
      } else {
        pair = protocols.get(req.headers['mcp-session-id'] as string);
        if (!pair) return fail(res, 500, 'internal error: warm pair vanished');
      }
    }
    res.on('close', () => {
      if (!pair?.initialized) {
        pending.delete(pair as ProtocolPair);
        void pair?.transport.close().catch(() => undefined);
        void pair?.server.close().catch(() => undefined);
      }
    });
    try {
      await pair.transport.handleRequest(req, res, req.body);
    } catch (e) {
      deps.log(`mcp: handleRequest error: ${e instanceof Error ? e.message : e}`);
      if (!res.headersSent) fail(res, 500, 'internal error');
    }
  });

  const handleExisting = async (req: Request, res: Response): Promise<void> => {
    traceMcp(req, res);
    const denied = checkAccess(req.params.token as string);
    if (denied) return fail(res, denied.code, denied.message);
    const sessionId = req.headers['mcp-session-id'];
    const pair = typeof sessionId === 'string' ? protocols.get(sessionId) : undefined;
    if (!pair) return fail(res, 404, 'unknown MCP session');
    pair.lastActiveAt = Date.now();
    try {
      await pair.transport.handleRequest(req, res);
    } catch (e) {
      deps.log(`mcp: handleRequest(${req.method}) error: ${e instanceof Error ? e.message : e}`);
      if (!res.headersSent) fail(res, 500, 'internal error');
    }
  };

  app.get('/mcp/:token', (req, res) => void handleExisting(req, res));
  // count EVERY DELETE at the route mouth (even ones that 404): the operator
  // watches for agents that DELETE frequently or against dead sessions —
  // whether the transport accepted it is secondary to the behavior itself
  app.delete('/mcp/:token', (req, res) => {
    deps.events.append(null, 'mcp_delete', { target: (req.headers['mcp-session-id'] as string) ?? null });
    void handleExisting(req, res);
  });

  // status-bar readout: pipes parked right now (busy GPT sessions park
  // dozens inside the 90s window before the sweep reclaims them)
  if (deps.livePipes) deps.livePipes = () => protocols.size;

  return {
    closeAll: async () => {
      clearInterval(sweeper);
      const all = [...protocols.values(), ...pending];
      protocols.clear();
      pending.clear();
      credToProtocol.clear();
      await Promise.allSettled(all.map((p) => Promise.all([p.transport.close(), p.server.close()])));
    },
  };
}

function getShellAdapter(): NonNullable<ReturnType<typeof detectShell>> {
  const adapter = detectShell();
  if (!adapter) throw new Error('no supported shell found (need bash or cmd)');
  return adapter;
}

/**
 * Build the ACL-confined persistent shell. The sandbox module (and koffi) is
 * imported ONCE lazily at the first win32 session — non-Windows platforms
 * never load it (the plain PersistentShell path stays koffi-free). TEMP/TMP
 * point at the sandbox's private temp dir (the ambient temp root is not a
 * granted tree — writes there would fail); they are injected as the shell's
 * first stdin line, not the daemon's process env, so concurrent sessions
 * never clobber one another. Sandbox init failure is fatal for the session's
 * shell (fail-closed): the session still resolves, but every exec returns
 * the sandbox error instead of running unconfined.
 */
function makeSandboxedShell(deps: DaemonDeps, rt: SessionRuntime, pwshBin: string): PersistentShell {
  const Ctor = loadSandboxedShellCtor();
  return new Ctor({
    cwd: rt.cwd,
    bin: pwshBin,
    workspaceRoot: rt.workspace,
    mode: normalizePermissionMode(rt.session.permission_mode) === 'read-only' ? 'read-only' : 'workspace-write',
    extraWritableDirs: rt.session.writable_dirs,
    timeoutMs: deps.cfg.execMaxTimeoutMs,
    log: deps.log,
  });
}

/** The win32-only sandboxed shell constructor, imported once and cached. */
let sandboxedShellCtor: typeof import('../workspace/sandboxed-shell.js').SandboxedPersistentShell | undefined;
function loadSandboxedShellCtor(): typeof import('../workspace/sandboxed-shell.js').SandboxedPersistentShell {
  if (sandboxedShellCtor !== undefined) return sandboxedShellCtor;
  // createRequire is the ONLY synchronous ESM import channel; the sandbox
  // module (and koffi) loads only on this win32-only call path, never at
  // module scope, so Mac/Linux never touch the FFI dependency graph.
  // Resolution base: this FILE at runtime. Dev: src/mcp/router.ts (require
  // ../workspace). vsix bundle: dist/daemon/cli.js with the sandbox chain
  // shipped as real files at dist/daemon/workspace/ (esbuild external) —
  // import.meta.url is undefined inside the CJS bundle, so the bundled form
  // detects itself via __filename and requires the sibling files.
  const bundled = typeof __filename === 'string' && __filename.length > 0 && __filename.endsWith('cli.js');
  const base = bundled ? __filename : import.meta.url;
  const req = createRequire(base);
  const mod = req(bundled ? './workspace/sandboxed-shell.js' : '../workspace/sandboxed-shell.js') as typeof import('../workspace/sandboxed-shell.js');
  // First load = first win32 shell of this daemon lifetime: no live private
  // temp dirs exist yet in THIS process, so every leftover s-* dir under
  // bh-sandbox belongs to a crashed/killed previous lifetime — sweep it.
  mod.cleanupOrphanSandboxTemps([]);
  sandboxedShellCtor = mod.SandboxedPersistentShell;
  return sandboxedShellCtor;
}

function expressJsonForMcp(cfg: Config) {
  return express.json({ limit: cfg.bodyLimitBytes });
}
