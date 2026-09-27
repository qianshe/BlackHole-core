import path from 'node:path';
import { createHash } from 'node:crypto';
import express, { Router, type Request, type Response } from 'express';
import type { DaemonDeps } from '../deps.js';
import type { ApprovalPins, PanelRegistry } from './keys.js';
import type { ApprovalScope } from '../storage/db.js';
import { isWorkspaceFileTool, displayToolName } from '../tool-routing.js';

const SECRET_KEY_RE = /(token|secret|password|passwd|authorization|api[_-]?key|cookie)/i;
const SECRET_TEXT_RE = /(bearer\s+)[A-Za-z0-9._~+\/-]+|((?:token|secret|password|passwd|api[_-]?key)\s*[=:]\s*)[^\s'\"]+|\bsk-[A-Za-z0-9_-]{8,}\b|\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b|https?:\/\/[^\s'\"]+/gi;

function redactText(value: string): string {
  return value.replace(SECRET_TEXT_RE, (_m, bearer, keyed) => bearer ? bearer + '[redacted]' : keyed ? keyed + '[redacted]' : '[redacted]');
}

function maskSensitiveText(value: string): string {
  return value.replace(SECRET_TEXT_RE, (match) => '*'.repeat(match.length));
}

function safeArgs(tool: string, argsJson: string): string {
  let parsed: Record<string, unknown> = {};
  try {
    const value = JSON.parse(argsJson) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value as Record<string, unknown>;
  } catch {
    return '{}';
  }
  const clean = (v: unknown, maxString = 500): unknown => {
    if (typeof v === 'string') return redactText(v).slice(0, maxString);
    if (Array.isArray(v)) return v.slice(0, 20).map((item) => clean(item, maxString));
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => !SECRET_KEY_RE.test(k)).map(([k, val]) => [k, clean(val, maxString)]));
    }
    return v;
  };
  if (tool === 'exec') return JSON.stringify({ command: clean(parsed.command, 8192) });
  if (tool === 'process') return JSON.stringify({
    command: clean(parsed.command),
    ...(parsed.name ? { name: clean(parsed.name) } : {}),
    ...(parsed.script ? { script: clean(parsed.script, 8192) } : {}),
    ...(parsed.processId ? { processId: clean(parsed.processId) } : {}),
    ...(parsed.closeTerminal === true ? { closeTerminal: true } : {}),
  });
  if (isWorkspaceFileTool(tool)) {
    // editor keeps the command-specific payload under `operation`.
    // Flatten only the display fields here so the panel can remain agnostic of
    // the MCP input schema while preserving the command in every call row.
    const operation = parsed.operation && typeof parsed.operation === 'object' && !Array.isArray(parsed.operation)
      ? parsed.operation as Record<string, unknown>
      : parsed;
    const rawPath = typeof parsed.path === 'string' ? parsed.path : undefined;
    const p = rawPath ? path.basename(rawPath) : undefined;
    const pathKey = rawPath ? createHash('sha256').update(path.normalize(rawPath), 'utf8').digest('hex').slice(0, 16) : undefined;
    const viewRange = operation.command === 'view' && Array.isArray(operation.view_range) && operation.view_range.length === 2
      ? clean(operation.view_range)
      : undefined;
    return JSON.stringify({
      command: clean(operation.command),
      ...(p ? { path: p } : {}),
      ...(pathKey ? { path_key: pathKey } : {}),
      ...(viewRange ? { view_range: viewRange } : {}),
    });
  }
  if (tool === 'context_search') return JSON.stringify({ query: clean(parsed.query), ...(parsed.path ? { path: clean(parsed.path) } : {}) });
  if (tool === 'todo') return JSON.stringify({
    command: clean(parsed.command),
    ...(Array.isArray(parsed.todos) ? { todos: clean(parsed.todos) } : {}),
    ...(Array.isArray(parsed.updates) ? { updates: clean(parsed.updates) } : {}),
    ...(parsed.contract && typeof parsed.contract === 'object' && !Array.isArray(parsed.contract)
      ? { contract: { goal: clean((parsed.contract as Record<string, unknown>).goal, 2000) } } : {}),
  });
  if (tool === 'skill') return JSON.stringify({ ...(parsed.name ? { name: clean(parsed.name) } : {}), ...(parsed.path ? { path: clean(parsed.path) } : {}) });
  if (tool === 'guide') return JSON.stringify({
    ...(parsed.workflow ? { workflow: clean(parsed.workflow) } : {}),
    ...(parsed.tool ? { tool: clean(parsed.tool) } : {}),
  });
  if (tool === 'show') return '{}';
  if (tool === 'proxy') {
    return JSON.stringify({
      command: clean(parsed.command),
      ...(parsed.server ? { server: clean(parsed.server) } : {}),
      ...(parsed.tool ? { tool: clean(parsed.tool) } : {}),
      ...(typeof parsed.argsJson === 'string' ? { argsJson: redactText(parsed.argsJson).slice(0, 1024) } : {}),
    });
  }
  const cleaned = clean(parsed, 500);
  return typeof cleaned === 'object' && cleaned !== null ? JSON.stringify(cleaned) : '{}';
}


/**
 * The panel card's public HTTP surface: `GET /panel/:key/data` (epoch-gated
 * polling) and `POST /panel/:key/confirmations/:id/:action` (UI capability or
 * loopback-PIN approval). Deliberately mounted OUTSIDE `/api`: the control plane is
 * loopback-only and refuses proxy headers, while these routes serve the
 * sandboxed iframe over the public tunnel. The capability model differs too —
 * the panelKey in the path is a bearer credential (like the machine token in
 * the MCP URL), so there is nothing else to authenticate.
 *
 * CORS is open (`*`): the iframe has an opaque origin in every Apps host, so
 * nothing narrower can work; the key already carries the authority.
 */
export function mountPanel(
  app: Router,
  deps: DaemonDeps,
  panels: PanelRegistry,
  pins: ApprovalPins,
  /** Resolve + apply an approve/deny decision (shared with the control plane). */
  resolveConfirmation: (c: { id: string; session_id: string; args_json: string }, action: 'approve' | 'deny', scope: ApprovalScope | undefined) => void,
): Router {
  // The daemon does not parse JSON bodies globally; /api mounts its own parser,
  // so this surface needs one too (approval actions carry a UI token or
  // loopback PIN, plus an optional scope).
  app.use(express.json({ limit: '4kb' }));
  const pinAttempts = new Map<string, { failures: number; blockedUntil: number }>();
  const pinAttemptKey = (req: Request): string => {
    const forwarded = req.headers['cf-connecting-ip'];
    const client = typeof forwarded === 'string' ? forwarded : req.ip ?? 'unknown';
    return (req.params.key as string) + ':' + (req.params.id as string) + ':' + client;
  };

  app.use((req, res, next) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('cache-control', 'no-store, private');
    res.setHeader('pragma', 'no-cache');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  /**
   * Session row behind a panel key, or an error response already sent.
   * Order matters for the revoked card: the key dies WITH the session, so a
   * revoked session no longer resolves through the registry — yet the card
   * must learn "session over" (410), not "no such panel" (404). Resolving via
   * the key's remembered session first, then checking status, gives both.
   */
  const sessionOf = (req: Request, res: Response) => {
    const key = req.params.key as string;
    const terminal = panels.terminalReason(key);
    if (terminal) {
      const error = terminal === 'superseded' ? 'panel superseded'
        : terminal === 'credential_rotated' ? 'session credential rotated'
          : terminal === 'expired' ? 'panel expired'
            : terminal === 'panel_closed' ? 'panel closed' : 'session terminated';
      res.status(410).json({ error });
      return undefined;
    }
    const sessionId = panels.sessionOf(key);
    const row = sessionId ? deps.sessions.get(sessionId) : undefined;
    if (row && (row.status === 'revoked' || row.status === 'archived')) {
      res.status(410).json({ error: `session ${row.status}` });
      return undefined;
    }
    if (!row) {
      // unknown key: indistinguishable from a dead one, no oracle for probing
      res.status(404).json({ error: 'no such panel' });
      return undefined;
    }
    return row;
  };

  app.get('/:key/data', (req, res) => {
    const row = sessionOf(req, res);
    if (!row) return;
    const epoch = deps.changes.epoch();
    // epoch gate: the caller's epoch still current AND it did not ask for a
    // first fetch — respond weightless. Safe for approvals too: creating a
    // confirmation appends `confirmation_created` through EventsRepo, whose
    // onChange bumps the epoch, so a new pending always reads as a change.
    // (force=1 skips the gate.)
    const callerEpoch = Number(req.query.epoch ?? NaN);
    const force = req.query.force !== undefined || Number.isNaN(callerEpoch);
    if (!force && callerEpoch === epoch) {
      res.status(204).end();
      return;
    }

    // The explicit show call establishes the beginning of the currently mounted card.
    // Treat the registry cursor as an authoritative lower bound: the browser
    // normally echoes `calls_from`, but a stale/hostile client must not lower it
    // to zero and recover persisted calls from before this card was mounted.
    // A larger caller cursor is still allowed for normal incremental paging.
    const requestedCallsFrom = Math.max(0, Number(req.query.calls_from ?? 0) || 0);
    const callsFrom = Math.max(panels.startSeqFor(row.id), requestedCallsFrom);
    const callsAfter = Math.max(callsFrom, Number(req.query.calls_after ?? 0) || 0);
    const callsUpdatedAfter = Number(req.query.calls_updated_after ?? 0) || 0;

    const calls = deps.toolCalls.listForSessionSince(row.id, callsAfter, 200, callsUpdatedAfter, callsFrom);
    const nextCallsAfter = calls.reduce((m, c) => Math.max(m, c.seq), callsAfter);
    const callsUpdatedAt = calls.reduce((m, c) => Math.max(m, c.updated_at), callsUpdatedAfter);
    // Lean call rows: raw result_summary never leaves the daemon. For editor
    // writes, extract only the numeric line delta the panel needs.
    const leanCalls = calls.map((c) => {
      const result = c.result_summary ? safeParse(c.result_summary) as { result?: { diff?: { added?: unknown; removed?: unknown } } } : {};
      const diff = result.result?.diff;
      const added = typeof diff?.added === 'number' && Number.isFinite(diff.added) ? Math.max(0, Math.trunc(diff.added)) : undefined;
      const removed = typeof diff?.removed === 'number' && Number.isFinite(diff.removed) ? Math.max(0, Math.trunc(diff.removed)) : undefined;
      return {
        id: c.id,
        tool: displayToolName(c.tool),
        args_json: safeArgs(c.tool, c.args_json),
        status: c.status,
        duration_ms: c.updated_at - c.created_at,
        ...(isWorkspaceFileTool(c.tool) && (added !== undefined || removed !== undefined)
          ? { diff: { added: added ?? 0, removed: removed ?? 0 } }
          : {}),
      };
    });

    // pending approvals with the card payload (command/matches pre-computed
    // at creation; see tools.ts confirmation_created)
    deps.confirmations.expireStale();
    const pending = deps.confirmations
      .list(row.id)
      .filter((c) => c.status === 'pending' && c.expires_at > Date.now());
    const confirmations = pending.map((c) => {
      const ev = deps.events.findConfirmationCreated(row.id, c.id);
      const p = (ev ? safeParse(ev.payload) : {}) as { command?: unknown; categories?: unknown; matches?: unknown };
      return {
        id: c.id,
        status: c.status,
        command: typeof p.command === 'string' ? maskSensitiveText(p.command) : '',
        categories: Array.isArray(p.categories) ? p.categories : [],
        matches: Array.isArray(p.matches) ? p.matches : [],
        expires_at: c.expires_at,
        // NOTE: no PIN here. Everything this route returns must be assumed
        // agent-readable (a nonconforming host may leak `_meta`, handing the
        // panelKey to the model); the approval factor stays loopback-only.
      };
    });
    pins.pruneSession(row.id, new Set(pending.map((c) => c.id)));

    const board = deps.todos.get(row.id);
    const unchangedThisRound = !panels.todosChangedSinceMount(row.id);
    const hideTodos = unchangedThisRound && (
      (board.items.length === 0 && !board.contract)
      || (board.items.length > 0 && board.items.every((item) => item.status === 'completed'))
    );
    res.json({
      epoch,
      session: {
        workspace_name: row.name,
        mode: row.permission_mode,
        status: row.status,
      },
      ...(!hideTodos ? { todos: { items: board.items, ...(board.contract ? { contract: board.contract } : {}) } } : {}),
      calls: leanCalls,
      next_calls_after: nextCallsAfter,
      calls_updated_after: callsUpdatedAt,
      call_total: deps.toolCalls.countForSessionAfter(row.id, callsFrom),
      confirmations,
    });
  });

  app.post('/:key/close', (req, res) => {
    const key = req.params.key as string;
    const body = req.body as { app_token?: unknown } | undefined;
    const appToken = typeof body?.app_token === 'string' ? body.app_token : '';
    if (!appToken || panels.sessionForAppToken(key, appToken) === undefined) {
      const terminal = panels.terminalReason(key);
      if (terminal) {
        res.status(410).json({ error: 'panel already closed' });
        return;
      }
      res.status(403).json({ error: 'invalid panel app token' });
      return;
    }
    // M3：panel close 即清理该 session 的 attachment 可见引用（plan §9）
    const closedSession = panels.sessionOf(key);
    if (closedSession) deps.proxy?.attachments.dropSession(closedSession);
    if (!panels.closeKey(key)) {
      res.status(404).json({ error: 'no such panel' });
      return;
    }
    res.status(204).end();
  });

  app.post('/:key/confirmations/:id/:action(approve|deny)', (req, res) => {
    const row = sessionOf(req, res);
    if (!row) return;
    const body = req.body as { app_token?: unknown; pin?: unknown; scope?: unknown } | undefined;
    const action = req.params.action as 'approve' | 'deny';
    // Approve escalates capability (a blocked command runs). The iframe sends
    // its UI-only result token directly to this HTTP endpoint. The
    // loopback-issued PIN remains the non-Apps/local fallback. Deny never
    // escalates and stays friction-free.
    deps.confirmations.expireStale();
    const c = deps.confirmations.get(req.params.id as string);
    if (!c || c.session_id !== row.id) {
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
    if (action === 'approve' && body?.scope !== undefined && !['once', 'session', 'always'].includes(String(body.scope))) {
      res.status(400).json({ error: 'scope must be one of once, session, always' });
      return;
    }
    const scope = action === 'approve' ? ((body?.scope as ApprovalScope | undefined) ?? 'once') : undefined;
    const appToken = typeof body?.app_token === 'string' ? body.app_token : '';
    const appAuthorized = action === 'approve' && appToken.length > 0
      && panels.sessionForAppToken(req.params.key as string, appToken) === row.id;
    // Burn the PIN at the decision point when the local fallback is used — a
    // race that reaches here twice gets exactly one decision. App-authorized
    // requests are already bound to the live panel key + hidden UI token.
    if (action === 'approve' && !appAuthorized) {
      const attemptKey = pinAttemptKey(req);
      const now = Date.now();
      const attempt = pinAttempts.get(attemptKey);
      if (attempt && attempt.blockedUntil > now) {
        res.status(429).json({ error: 'too many invalid approval attempts' });
        return;
      }
      if (!pins.consume(row.id, c.id, (body?.pin as string) ?? '')) {
        const failures = (attempt?.failures ?? 0) + 1;
        pinAttempts.set(attemptKey, failures >= 5 ? { failures: 0, blockedUntil: now + 30_000 } : { failures, blockedUntil: 0 });
        res.status(403).json({ error: 'invalid approval PIN' });
        return;
      }
      pinAttempts.delete(attemptKey);
    }
    resolveConfirmation(c, action, scope);
    pins.forget(row.id, c.id);
    res.json({ epoch: deps.changes.epoch() });
  });

  // ─── M3 attachment 授权路由：字节只进 Panel（app token），agent 拿不到 ───
  app.get('/:key/attachments/:id', (req, res) => {
    const row = sessionOf(req, res);
    if (!row) return;
    const appToken = typeof req.query.app_token === 'string' ? req.query.app_token : '';
    if (appToken.length === 0 || panels.sessionForAppToken(req.params.key as string, appToken) !== row.id) {
      res.status(403).json({ error: 'invalid app token' });
      return;
    }
    const attachment = deps.proxy?.attachments.get(row.id, req.params.id as string);
    if (attachment === undefined) {
      res.status(404).json({ error: 'no such attachment (expired or foreign session)' });
      return;
    }
    res.setHeader('content-type', attachment.mimeType);
    res.setHeader('cache-control', 'no-store, private');
    res.send(attachment.bytes);
  });

  // ─── M2 取消入口（panel 侧）：in-flight proxy call 的取消按钮 ───
  // 与 approve 同级的能力（释放队列槽位），因此要求 app token——面板 UI 能力
  // 凭证；PIN 是批准的本地回退，取消不提供 PIN 回退（无升级语义的场景）。
  app.post('/:key/calls/:callId/cancel', (req, res) => {
    const row = sessionOf(req, res);
    if (!row) return;
    const body = req.body as { app_token?: unknown } | undefined;
    const appToken = typeof body?.app_token === 'string' ? body.app_token : '';
    if (appToken.length === 0 || panels.sessionForAppToken(req.params.key as string, appToken) !== row.id) {
      res.status(403).json({ error: 'invalid app token' });
      return;
    }
    const callId = req.params.callId as string;
    // 归属校验：panel 只代表自己这个 session，不能取消别的 session 的调用
    const cancelled = deps.proxy?.cancelCall(callId, row.id) ?? false;
    if (!cancelled) {
      res.status(404).json({ error: 'no cancellable call with this id' });
      return;
    }
    deps.events.append(row.id, 'proxy_call_cancelled', { call_id: callId, source: 'panel' });
    res.json({ cancelled: true });
  });

  return app;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
