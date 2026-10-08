import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { courierRoutes } from '../courier/mount.js';
import { mountFeedRoutes } from '../feed/routes.js';
import express, { Router, type Request, type Response, type NextFunction } from 'express';
import type { DaemonDeps } from '../deps.js';
import { VERSION } from '../version.js';
import { mcpPath, mcpUrl } from '../deps.js';
import { PERMISSION_MODES, type PermissionMode } from '../config.js';
import { canonicalDir, createWorkspaceSession } from '../services/sessions.js';
import { patchSettings, probePublicUrl, settingsView } from '../settings/service.js';
import { AccountError, accountErrorCode } from '../account/service.js';
import { WebSessionStore, WEB_SESSION_TTL_MS } from './web-sessions.js';
import type { MachineStateRepo } from '../storage/machineState.js';
import { CloudflaredJob } from '../tunnel/cloudflared-job.js';
import { initializeCloudflared } from '../tunnel/cloudflared-install.js';
import { initializeOpenAITunnelClient } from '../tunnel/openai-tunnel-install.js';
import { withProxyFetch } from '../network/proxy-fetch.js';
import { loopbackPeer, openAITunnelRouter } from '../control/openai-tunnel-routes.js';
import { restartSelf } from '../util/self-restart.js';
import { pickFolder } from '../util/pick-folder.js';
import { skillDirectoryStatus } from '../settings/skills-status.js';
import { resolveConfirmation } from '../control/api.js';
import { resumeChannel } from '../tunnel/resume.js';
import { DEVICE_COOKIE, DEVICE_IDLE_MS, RateLimiter, RemoteAccess, deviceName, httpsOrigin, publicOrigin, type PublicChannel } from './remote-access.js';
import { INTEGRITY_MESSAGE, integrityFailures } from '../integrity.js';
import { resolveConnectionRoutes } from '../connection/resolve.js';
import { networkScope } from '../connection/scope.js';
import { RemoteProbeRegistry } from './remote-probe.js';
import { buildTurnDiff } from '../workspace/turnDiff.js';
import type { SetupSummary } from '../../packages/contracts/dist/connections.js';

export { WEB_SESSION_TTL_MS };

/**
 * Local Web (read-only slice).
 *
 * - `/api/web/bootstrap` (native loopback callers only) issues a one-time ticket.
 * - `/web-api/v1/auth/exchange` swaps the ticket for an HttpOnly session cookie.
 * - `/web-api/v1/*` serves read-only data; `/ui/` serves the built page.
 *
 * Nothing here is reachable through a tunnel: proxied requests and non-loopback
 * Host headers are refused before any route runs.
 */

export const TICKET_TTL_MS = 60_000;
const MAX_TICKETS = 16;
export const WEB_COOKIE = 'bh_web';
const CLIENT_HEADER = 'x-blackhole-web';
const CSRF_HEADER = 'x-blackhole-csrf';
const PROJECTS_KEY = 'web.projects';
const MAX_PROJECTS = 200;
/** Keeps the /presence response alive through proxies and re-checks the session. */
const PRESENCE_PING_MS = 20_000;
const MAX_DIR_ENTRIES = 500;

const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(?::([0-9]{1,5}))?$/;
const PROXY_HEADERS = ['cf-connecting-ip', 'cf-ray', 'x-forwarded-for', 'x-forwarded-host', 'forwarded', 'x-real-ip'];

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();
const newSecret = (): string => randomBytes(32).toString('base64url');

/** In-memory secrets keyed by their sha256; the raw value never stays in memory. */
class SecretStore {
  private readonly rows = new Map<string, number>();
  constructor(private readonly max: number) {}

  issue(ttlMs: number, now = Date.now()): { secret: string; expiresAt: number } {
    this.sweep(now);
    while (this.rows.size >= this.max) {
      const oldest = this.rows.keys().next().value;
      if (oldest === undefined) break;
      this.rows.delete(oldest);
    }
    const secret = newSecret();
    const expiresAt = now + ttlMs;
    this.rows.set(digest(secret).toString('hex'), expiresAt);
    return { secret, expiresAt };
  }

  /** Expiry of a live secret, or null. */
  check(secret: unknown, now = Date.now()): number | null {
    if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(secret)) return null;
    // Lookup by hash: timing reveals nothing about the raw secret.
    const key = digest(secret).toString('hex');
    const expiresAt = this.rows.get(key);
    if (expiresAt === undefined) return null;
    if (expiresAt <= now) {
      this.rows.delete(key);
      return null;
    }
    return expiresAt;
  }

  consume(secret: unknown, now = Date.now()): number | null {
    const expiresAt = this.check(secret, now);
    if (expiresAt !== null) this.rows.delete(digest(secret as string).toString('hex'));
    return expiresAt;
  }

  revoke(secret: unknown): void {
    if (typeof secret === 'string') this.rows.delete(digest(secret).toString('hex'));
  }

  private sweep(now: number): void {
    for (const [key, expiresAt] of this.rows) if (expiresAt <= now) this.rows.delete(key);
  }
}

export interface LocalWebState {
  tickets: SecretStore;
  sessions: WebSessionStore;
  /** Persisted with the sessions: the CSRF token is derived from the session cookie, so nothing extra is stored. */
  csrfKey: Buffer;
}

export function createLocalWebState(machineState?: Pick<MachineStateRepo, 'get' | 'set'>): LocalWebState {
  const sessions = new WebSessionStore(machineState);
  return { tickets: new SecretStore(MAX_TICKETS), sessions, csrfKey: sessions.csrfKey };
}

export function csrfFor(state: LocalWebState, cookie: string): string {
  return createHmac('sha256', state.csrfKey).update(cookie).digest('base64url');
}

export interface WebProject {
  id: string;
  path: string;
  label: string;
  pinned: boolean;
  created_at: string;
}

const samePath = (a: string, b: string): boolean => (process.platform === 'win32' || process.platform === 'darwin' ? a.toLowerCase() === b.toLowerCase() : a === b);

/** Directory roots for the picker: drive letters on Windows, / elsewhere, plus home. */
function dirRoots(): { name: string; path: string }[] {
  const out: { name: string; path: string }[] = [];
  const home = os.homedir();
  if (home) out.push({ name: home, path: home });
  if (process.platform === 'win32') {
    for (let c = 65; c <= 90; c++) {
      const drive = `${String.fromCharCode(c)}:\\`;
      try {
        if (fs.statSync(drive).isDirectory()) out.push({ name: drive, path: drive });
      } catch {
        /* no such drive */
      }
    }
  } else {
    out.push({ name: '/', path: '/' });
  }
  return out;
}

function hostOf(req: Request): string | null {
  const host = (req.headers.host ?? '').toLowerCase();
  return LOOPBACK_HOST.test(host) ? host : null;
}

function proxied(req: Request): boolean {
  return PROXY_HEADERS.some((h) => req.headers[h] !== undefined);
}

/** Loopback Host, no proxy hop. Applied to every Local Web route. */
function loopbackOnly(req: Request, res: Response, next: NextFunction): void {
  if (proxied(req) || !hostOf(req)) {
    res.status(403).json({ error: 'local_only' });
    return;
  }
  next();
}

/** A non-browser local caller (the VS Code extension). Browsers send Origin on POST and Sec-Fetch-Site; Node fetch sends neither. */
export function isNativeLoopback(req: Request): boolean {
  return (
    hostOf(req) !== null &&
    !proxied(req) &&
    !req.headers.origin &&
    !req.headers.referer &&
    !req.headers.cookie &&
    !req.headers.authorization &&
    !req.headers['sec-fetch-site']
  );
}

/**
 * Every value sent under `name`, in the browser's order. Browsers also send same-named
 * cookies from longer paths first (e.g. one left by an older build; cookies ignore the
 * port, so anything on this host counts), and such a stale entry must not hide the
 * valid session cookie.
 */
function readCookies(req: Request, name: string): string[] {
  const raw = req.headers.cookie;
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) out.push(part.slice(i + 1).trim());
  }
  return out;
}

function readCookie(req: Request, name: string): string | undefined {
  return readCookies(req, name)[0];
}

/** Same-origin browser request from our own page (exact Origin when present, custom header always). */
function sameOriginClient(req: Request): boolean {
  if (req.headers[CLIENT_HEADER] !== '1') return false;
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin') return false;
  const origin = req.headers.origin;
  if (origin === undefined) return req.method === 'GET' || req.method === 'HEAD';
  return origin === `http://${hostOf(req)}`;
}

function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'no-store');
  next();
}

/** Built page location: env override, packaged beside the daemon bundle, or the repo build. */
export function resolveWebDir(): string | null {
  const scriptDir = path.dirname(process.argv[1] ?? '.');
  const candidates = [
    process.env.BLACKHOLE_WEB_DIR,
    path.resolve(scriptDir, 'web'),
    path.resolve(scriptDir, '../packages/web/dist'),
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);
  for (const dir of candidates) {
    try {
      if (fs.statSync(path.join(dir, 'index.html')).isFile()) return dir;
    } catch {
      /* try next */
    }
  }
  return null;
}

const MAX_ARG_STRING = 4_000;
const SECRET_KEYS = /^(sessionid|session_id|credential(_id)?|token|access_token|authorization|password|secret|api_key|apikey)$/i;

/** Defensive projection of recorded args: drop credential-like keys, cap long strings. */
export function projectArgs(raw: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw.length > MAX_ARG_STRING ? `${raw.slice(0, MAX_ARG_STRING)}…` : raw;
  }
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === 'string') return v.length > MAX_ARG_STRING ? `${v.slice(0, MAX_ARG_STRING)}…` : v;
    if (depth > 6 || v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.slice(0, 200).map((x) => walk(x, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (!SECRET_KEYS.test(k)) out[k] = walk(x, depth + 1);
    return out;
  };
  return walk(parsed, 0);
}

const iso = (t: number | null | undefined): string | null => (typeof t === 'number' ? new Date(t).toISOString() : null);

/**
 * The page lives at `/` for a browser on this machine. Everything else asking
 * for `/` (tunnel traffic, scripts, agents) keeps the plain-text daemon banner.
 * Returns true when the page was sent.
 */
export function sendRootPage(req: Request, res: Response): boolean {
  if (proxied(req) || !hostOf(req) || !req.accepts('html') || req.accepts(['text', 'html']) !== 'html') return false;
  const dir = resolveWebDir();
  if (!dir) return false;
  securityHeaders(req, res, () => {});
  res.sendFile('index.html', { root: dir, dotfiles: 'deny', etag: false, lastModified: false });
  return true;
}

/** Set by mountLocalWeb: true when this request is for the phone page on the enabled public address. */
let remotePageFor: ((req: Request) => boolean) | null = null;

/**
 * The phone page: public `/` on the enabled https address, for a browser asking
 * for HTML. Everything else there keeps the plain-text banner.
 */
export function sendRemotePage(req: Request, res: Response): boolean {
  if (!remotePageFor?.(req) || !req.accepts('html') || req.accepts(['text', 'html']) !== 'html') return false;
  const dir = resolveWebDir();
  if (!dir) return false;
  securityHeaders(req, res, () => {});
  res.sendFile('index.html', { root: dir, dotfiles: 'deny', etag: false, lastModified: false });
  return true;
}

export function mountLocalWeb(app: express.Express, deps: DaemonDeps, state: LocalWebState = createLocalWebState(deps.machineState), control?: Router): LocalWebState {
  const accountUser = () => deps.account?.currentUserId() ?? null;
  const accountGate = () => deps.account?.storage === 'available';
  deps.account?.onSignOut(() => state.sessions.revokeAll());
  // ─── phone access (plan 6.13 R) ───────────────────────────
  const remoteAccess = new RemoteAccess(deps.machineState);
  deps.account?.onSignOut(() => { remoteAccess.revokeAll(); });
  deps.revokeRemoteDevices = () => { remoteAccess.revokeAll(); };
  /**
   * Phone-capable origins. Unified direct access may use an explicit advertised
   * origin or the listener's discovered LAN/mesh addresses; managed/custom
   * public channels remain independent alternatives.
   */
  const remoteChannels = (): PublicChannel[] => {
    const values = deps.settings?.get().values;
    const out: PublicChannel[] = [];
    const listener = deps.directAccess?.view();
    const ready = listener?.state === 'listening' && listener.listening;
    const add = (origin: string | null, kind: PublicChannel['kind']) => {
      if (origin && !out.some((x) => x.origin === origin)) out.push({ origin, kind });
    };
    if (values?.directAccessEnabled && ready && listener.mode === 'direct' && listener.port === values.directPort) {
      // The operator's URL is the first choice. Local interfaces remain usable
      // at the same time, without a second listener or a LAN address setting.
      if (listener.origin === publicOrigin(values.directAccessUrl)) add(listener.origin, 'fixed');
      for (const address of listener.addresses) add(publicOrigin(`http://${address}:${listener.port}`), 'fixed');
    }
    const customSelected = values?.channelMode === 'custom' || values?.aiDefaultRoute === 'custom';
    const customOrigin = publicOrigin(values?.publicBaseUrl);
    if (customSelected && ready && listener.proxy_origin === customOrigin) add(customOrigin, 'fixed');
    const t = deps.tunnel;
    if (t && (t.status === 'online' || t.status === 'unverified')) {
      add(httpsOrigin(t.url), t.mode === 'quick' ? 'quick' : 'fixed');
    }
    return out;
  };
  const phoneScope = (origin: string) => networkScope(new URL(origin).hostname, 'public');
  const remoteProbes = new RemoteProbeRegistry(() => {
    const settings = deps.settings?.get();
    const proxy = settings?.values.channelProxyUrl || '';
    return remoteChannels().map((ch) => ({
      origin: ch.origin, proxy,
      key: JSON.stringify([ch.origin, ch.kind, phoneScope(ch.origin), settings?.revision ?? 0, proxy]),
    }));
  });
  // Phone access is always on (pairing still needs 允许 on this computer). A stored
  // remoteAccess=false from older builds must not lock it off with no switch left.
  const remoteEnabled = () => true;
  const defaultRemoteChannel = (): PublicChannel | null => (remoteEnabled() ? remoteChannels()[0] ?? null : null);
  /** The enabled entry point addressed by this request's Host. */
  const remoteChannel = (req: Request): PublicChannel | null => {
    const directOrigin = deps.directAccess?.requestOrigin(req);
    const host = (req.headers.host ?? '').toLowerCase();
    return remoteChannels().find((ch) => directOrigin ? ch.origin === directOrigin : new URL(ch.origin).host.toLowerCase() === host) ?? null;
  };
  remotePageFor = (req) => remoteChannel(req) !== null;
  // ─── ticket issuance (VS Code extension only) ──────────────
  app.post('/api/web/bootstrap', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!isNativeLoopback(req)) {
      res.status(403).json({ error: 'native_loopback_required' });
      return;
    }
    if (!resolveWebDir()) {
      res.status(503).json({ error: 'web_assets_missing' });
      return;
    }
    const { secret, expiresAt } = state.tickets.issue(TICKET_TTL_MS);
    res.json({ ticket: secret, path: '/ui/', expires_at: iso(expiresAt) });
  });

  // ─── page ──────────────────────────────────────────────────
  const ui = Router();
  // Page assets are also served to a paired-phone origin (they hold no data).
  ui.use((req, res, next) => (remoteChannel(req) ? next() : loopbackOnly(req, res, next)), securityHeaders);
  ui.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.status(405).end();
      return;
    }
    // The page moved to `/`; old links and launchers still open /ui/#<ticket>
    // (the browser keeps the fragment across the redirect). Assets stay here.
    if (req.path === '/' || req.path === '/index.html') {
      const q = req.originalUrl.indexOf('?');
      res.redirect(302, '/' + (q >= 0 ? req.originalUrl.slice(q) : ''));
      return;
    }
    const dir = resolveWebDir();
    if (!dir) {
      res.status(503).type('text/plain').send('Local Web assets are missing. Rebuild or reinstall the extension.');
      return;
    }
    express.static(dir, { index: 'index.html', dotfiles: 'deny', fallthrough: false, etag: false, lastModified: false })(req, res, next);
  });
  app.use('/ui', ui);

  // ─── read-only API ─────────────────────────────────────────
  const api = Router();
  api.use(loopbackOnly, securityHeaders);
  api.use(express.json({ limit: 64 * 1024 }));

  api.post('/auth/exchange', (req, res) => {
    const origin = req.headers.origin;
    if (req.headers[CLIENT_HEADER] !== '1' || origin !== `http://${hostOf(req)}`) {
      res.status(403).json({ error: 'origin_rejected' });
      return;
    }
    const ticket = (req.body as { ticket?: unknown } | undefined)?.ticket;
    if (state.tickets.consume(ticket) === null) {
      res.status(401).json({ error: 'ticket_invalid' });
      return;
    }
    const { secret, expiresAt } = state.sessions.issue(accountUser());
    res.setHeader(
      'Set-Cookie',
      `${WEB_COOKIE}=${secret}; Path=/web-api; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(WEB_SESSION_TTL_MS / 1000)}`,
    );
    deps.events.append(null, 'local_web_login', {});
    res.json({ ok: true, expires_at: iso(expiresAt), csrf: csrfFor(state, secret) });
  });

  // ── local browser: this machine's signed-in account is enough ──
  // Same trust as the loopback control API (/api), which any local program can
  // already reach; browsers cannot forge Origin/Sec-Fetch-Site, and tunnel or
  // proxied requests never get here (loopbackOnly).
  api.post('/auth/local', (req, res) => {
    if (req.headers[CLIENT_HEADER] !== '1' || req.headers.origin !== `http://${hostOf(req)}`
      || (req.headers['sec-fetch-site'] !== undefined && req.headers['sec-fetch-site'] !== 'same-origin')) {
      res.status(403).json({ error: 'origin_rejected' });
      return;
    }
    const user = accountUser();
    if (!accountGate() || !user) {
      res.status(401).json({ error: 'account_required' });
      return;
    }
    const { secret, expiresAt } = state.sessions.issue(user);
    res.setHeader('Set-Cookie', `${WEB_COOKIE}=${secret}; Path=/web-api; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(WEB_SESSION_TTL_MS / 1000)}`);
    deps.events.append(null, 'local_web_login', { via: 'local' });
    res.json({ ok: true, expires_at: iso(expiresAt), csrf: csrfFor(state, secret) });
  });

  // ── browser login (no session yet): the machine's cloud account is the key ──
  // Starting one opens the cloud sign-in in the system browser; only the account
  // this machine already holds is accepted (any account when it holds none).
  const attempts = new Map<string, { job: number; exp: number }>();
  let loginHits: number[] = [];
  api.post('/auth/login', (req, res) => {
    if (req.headers[CLIENT_HEADER] !== '1' || req.headers.origin !== `http://${hostOf(req)}`) {
      res.status(403).json({ error: 'origin_rejected' });
      return;
    }
    const now = Date.now();
    loginHits = loginHits.filter((t) => now - t < 60_000);
    if (loginHits.length >= 5) {
      res.status(429).json({ error: 'rate_limited' });
      return;
    }
    loginHits.push(now);
    if (!accountGate()) {
      res.status(503).json({ error: 'account_unavailable' });
      return;
    }
    try {
      const job = deps.account!.beginSignIn({ sameAccount: true });
      for (const [k, a] of attempts) if (a.exp <= now) attempts.delete(k);
      const attempt = randomBytes(32).toString('base64url');
      attempts.set(attempt, { job: job.id, exp: now + 11 * 60_000 });
      res.status(202).json({ attempt });
    } catch (e) {
      res.status(e instanceof AccountError ? e.status : 500).json({ error: accountErrorCode(e) });
    }
  });
  api.get('/auth/login/:attempt', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!sameOriginClient(req)) {
      res.status(403).json({ error: 'origin_rejected' });
      return;
    }
    const a = attempts.get(req.params.attempt);
    if (!a || a.exp <= Date.now() || !deps.account) {
      res.status(404).json({ error: 'attempt_unknown' });
      return;
    }
    const job = deps.account.signInState();
    if (job.state === 'idle' || job.id !== a.job) {
      attempts.delete(req.params.attempt);
      res.json({ state: 'failed', error: 'superseded' });
      return;
    }
    if (job.state === 'running') {
      res.json({ state: 'running' });
      return;
    }
    attempts.delete(req.params.attempt);
    const user = accountUser();
    if (job.state === 'failed' || !user) {
      res.json({ state: 'failed', error: job.state === 'failed' ? job.error : 'account_required' });
      return;
    }
    const { secret, expiresAt } = state.sessions.issue(user);
    res.setHeader('Set-Cookie', `${WEB_COOKIE}=${secret}; Path=/web-api; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(WEB_SESSION_TTL_MS / 1000)}`);
    deps.events.append(null, 'local_web_login', { via: 'account' });
    res.json({ state: 'done', expires_at: iso(expiresAt), csrf: csrfFor(state, secret) });
  });

  // Login-page setup summary: same-origin loopback only, no addresses, paths or credentials.
  // Runtime online/offline does not affect this result; a saved intent suppresses first-install UI.
  api.get('/auth/setup', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!sameOriginClient(req)) {
      res.status(403).json({ error: 'origin_rejected' });
      return;
    }
    try {
      const values = deps.settings?.get().values;
      if (!values) {
        res.json({ configuration: 'unknown' });
        return;
      }
      const configured = values.directAccessEnabled === true
        || values.directAccessUrl.trim().length > 0
        || values.publicBaseUrl.trim().length > 0
        || values.cloudflaredPath.trim().length > 0
        || values.openaiTunnelId.trim().length > 0
        || values.openaiTunnelClientPath.trim().length > 0;
      const summary: SetupSummary = { configuration: configured ? 'present' : 'absent' };
      res.json(summary);
    } catch {
      res.json({ configuration: 'unknown' });
    }
  });

  // Everything below requires the session cookie and our own page as caller.
  api.use((req, res, next) => {
    if (!sameOriginClient(req)) {
      res.status(403).json({ error: 'origin_rejected' });
      return;
    }
    // The first valid one of the same-named cookies wins (see readCookies).
    const user = accountUser();
    const cookies = readCookies(req, WEB_COOKIE);
    let cookie = cookies[0];
    let checked = state.sessions.check(cookie, user);
    for (const other of cookies.slice(1)) {
      if (checked.ok) break;
      const next = state.sessions.check(other, user);
      if (next.ok) {
        checked = next;
        cookie = other;
      }
    }
    if (!checked.ok) {
      res.status(401).json({ error: checked.error });
      return;
    }
    res.locals.webExpiresAt = checked.expiresAt;
    res.locals.webCookie = cookie;
    next();
  });

  // Writes: JSON body plus the CSRF token bound to this cookie (logout stays exempt).
  api.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.path === '/auth/logout') {
      next();
      return;
    }
    const expected = Buffer.from(csrfFor(state, res.locals.webCookie as string));
    const given = Buffer.from(String(req.headers[CSRF_HEADER] ?? ''));
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      res.status(403).json({ error: 'csrf_rejected' });
      return;
    }
    // JSON only, except a pasted image's raw bytes on the one upload route (CSRF checked above).
    const imageUpload = req.method === 'POST' && req.path === '/courier/attachments' && !!req.is('image/*');
    if (!imageUpload && !req.is('application/json')) {
      res.status(415).json({ error: 'json_required' });
      return;
    }
    next();
  });

  // No business data until this machine's cloud account is signed in. Skipped only
  // where the daemon cannot hold an account at all (no OS credential store).
  const GATE_FREE = new Set(['/auth/session', '/auth/logout', '/account', '/account/sign-in', '/account/sign-in/cancel']);
  api.use((req, res, next) => {
    if (accountGate() && accountUser() === null && !GATE_FREE.has(req.path)) {
      res.status(401).json({ error: 'account_required' });
      return;
    }
    next();
  });

  // Presence: while this response stays open the page counts as an open window for
  // the channel watchdog (the page elects one tab per browser). Local Web only; the
  // phone surface has no such route. The session is re-checked on every ping.
  api.get('/presence', (req, res) => {
    const cookie = res.locals.webCookie as string;
    const present = (deps.webPresence ??= new Set());
    const entry = {};
    present.add(entry);
    deps.lastHeartbeatAt = Date.now();
    resumeChannel(deps);
    res.status(200).set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.write(': present\n\n');
    const ping = setInterval(() => {
      if (!state.sessions.check(cookie, accountUser()).ok) res.end();
      else res.write(': ping\n\n');
    }, PRESENCE_PING_MS);
    let done = false;
    const leave = () => {
      if (done) return;
      done = true;
      clearInterval(ping);
      present.delete(entry);
      // The grace period (watchdog STALE_MS) starts when the last page goes away.
      deps.lastHeartbeatAt = Date.now();
    };
    req.on('close', leave);
    res.on('close', leave);
    res.on('finish', leave);
  });

  api.get('/auth/session', (_req, res) => {
    res.json({
      authenticated: true,
      account_required: accountGate() && accountUser() === null,
      expires_at: iso(res.locals.webExpiresAt as number),
      version: VERSION,
      csrf: csrfFor(state, res.locals.webCookie as string),
      platform: process.platform,
    });
  });

  api.post('/auth/logout', (req, res) => {
    state.sessions.revoke(res.locals.webCookie as string);
    res.setHeader('Set-Cookie', `${WEB_COOKIE}=; Path=/web-api; HttpOnly; SameSite=Strict; Max-Age=0`);
    res.json({ ok: true });
  });

  type Row = NonNullable<ReturnType<DaemonDeps['sessions']['get']>>;
  const sessionView = (s: Row) => {
    const board = deps.todos.get(s.id);
    return {
      id: s.id,
      name: s.name,
      workspace_path: s.workspace_path,
      status: s.status,
      activity: deps.sessionActivity?.status(s.id) ?? null,
      permission_mode: s.permission_mode,
      auto_approve: String(s.auto_approve ?? '') === '1' || s.auto_approve === true,
      draft: 'draft' in s && s.draft === true,
      created_at: iso(s.created_at),
      last_active_at: iso(s.last_active_at),
      calls_total: deps.toolCalls.countForSession(s.id),
      todos_total: board.items.length,
      todos_done: board.items.filter((t) => t.status === 'completed').length,
      // Handoff summary only (no content): the console shows a bar and fetches the snapshot on demand.
      pending_handoff: s.status === 'revoked' || s.status === 'archived' ? null : handoffSummary(s.id),
    };
  };
  const handoffSummary = (id: string): { id: string; created_at: string | null } | null => {
    try { const h = deps.handoffs?.getSummary(id); return h ? { id: h.id, created_at: iso(h.created_at) } : null; } catch { return null; }
  };

  // Web-only current-turn review; the shared data router also serves Remote and must not gain this UI feature.
  api.get('/sessions/:id/current-turn-diff', (req, res) => {
    const id = String(req.params.id);
    const session = deps.sessions.get(id);
    if (!session) { res.status(404).json({ error: 'session_not_found' }); return; }
    res.setHeader('Cache-Control', 'no-store');
    const turnAt = deps.courier?.messageStore?.latestUserAt(id) ?? null;
    if (turnAt === null) { res.json({ files: [], pending: 0, uncertain: 0, incomplete: false, turnAt: null }); return; }
    const rows = deps.toolCalls.listEditorCallsAfter(id, turnAt, 501);
    if (rows.length > 500) { res.json({ files: [], pending: 0, uncertain: 0, incomplete: true, turnAt }); return; }
    try { res.json({ ...buildTurnDiff(session, rows), incomplete: false, turnAt }); }
    catch { res.status(500).json({ error: 'turn_diff_failed' }); }
  });

  // Read routes shared with the phone surface (/remote-api/v1).
  const data = Router();
  api.use(data);
  data.get('/sessions', (_req, res) => {
    // Ended sessions are gone for users: never list them on any surface (phone included).
    res.json({ sessions: deps.sessions.list().filter((s) => s.status !== 'revoked' && s.status !== 'archived').map(sessionView), version: VERSION });
  });

  data.get('/sessions/:id', (req, res) => {
    const s = deps.sessions.get(String(req.params.id));
    if (!s) {
      res.status(404).json({ error: 'session_not_found' });
      return;
    }
    res.json(sessionView(s));
  });

  // 会话时间线：feed（增量 + 长轮询）与 history（往上翻页）。Web 控制台与手机共用（remote.use(data)），
  // VS Code 的 control API 挂的是同一份处理函数；见 src/feed/。
  mountFeedRoutes(data, deps, {
    mapCall: (c) => ({
      id: c.id,
      seq: c.seq,
      tool: c.tool,
      status: c.status,
      args: projectArgs(c.args_json),
      result_summary: c.result_summary,
      approval_scope: c.approval_scope,
      created_at: iso(c.created_at),
      updated_at: iso(c.updated_at),
    }),
  });

  data.get('/sessions/:id/calls', (req, res) => {
    const id = String(req.params.id);
    if (!deps.sessions.get(id)) {
      res.status(404).json({ error: 'session_not_found' });
      return;
    }
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 200);
    // page is 0-based (page 0 = newest), like the VS Code sidebar. Deep pages pass
    // anchor = the max_seq seen on page 0 so calls written meanwhile never shift history.
    const page = Math.max(0, Math.floor(Number(req.query.page ?? 0) || 0));
    const anchor = Math.max(0, Math.floor(Number(req.query.anchor ?? 0) || 0));
    const rows = deps.toolCalls.listForSessionWindow(id, anchor, page, limit);
    res.json({
      calls: rows.map((c) => ({
        id: c.id,
        seq: c.seq,
        tool: c.tool,
        status: c.status,
        args: projectArgs(c.args_json),
        result_summary: c.result_summary,
        approval_scope: c.approval_scope,
        created_at: iso(c.created_at),
        updated_at: iso(c.updated_at),
      })),
      total: deps.toolCalls.countForSession(id),
      window_total: anchor > 0 ? deps.toolCalls.countForSession(id, anchor) : deps.toolCalls.countForSession(id),
      max_seq: deps.toolCalls.maxSeqForSession(id),
      page,
      limit,
    });
  });

  data.get('/sessions/:id/todos', (req, res) => {
    const id = String(req.params.id);
    if (!deps.sessions.get(id)) {
      res.status(404).json({ error: 'session_not_found' });
      return;
    }
    const board = deps.todos.get(id);
    res.json({ items: board.items, contract: board.contract ?? null, updated_at: iso(board.updated_at) });
  });

  // ─── new session ──────────────────────────────────────────
  const SESSION_KEYS = new Set(['workspace_path', 'permission_mode', 'name', 'writable_dirs', 'auto_approve', 'draft']);
  api.post('/sessions', (req, res) => {
    if (integrityFailures().length) { res.status(503).json({ error: 'install_corrupted', message: INTEGRITY_MESSAGE }); return; }
    const body = req.body as Record<string, unknown> | undefined;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((k) => !SESSION_KEYS.has(k))) {
      res.status(400).json({ error: 'invalid_body' });
      return;
    }
    // Stricter than /api: no silent fallback for unknown modes or non-boolean flags.
    if ((body.permission_mode !== undefined && !PERMISSION_MODES.includes(body.permission_mode as PermissionMode)) || (body.auto_approve !== undefined && typeof body.auto_approve !== 'boolean') || (body.draft !== undefined && typeof body.draft !== 'boolean')) {
      res.status(400).json({ error: 'invalid_input', message: `permission_mode must be one of ${PERMISSION_MODES.join(', ')}` });
      return;
    }
    const created = createWorkspaceSession(deps, body);
    if ('error' in created) {
      res.status(400).json({ error: 'invalid_input', message: created.error });
      return;
    }
    if (!('draft' in created.session)) deps.events.append(created.session.id, 'local_web_session_created', {});
    // The numeric id is the credential the user hands to their AI; returned once, never listed.
    res.status(201).json({ session: sessionView(created.session), session_id: created.session.credential_id, mcp_url: mcpUrl(deps), connection_routes: resolveConnectionRoutes(deps, mcpPath()) });
  });

  // ─── settings ─────────────────────────────────────────────
  // ─── approvals on this computer (plan 6.15 W1) ─────────────────────────
  // Same resolution as the VS Code panel (resolveConfirmation), without the
  // approval pin: the web session itself is the user's proof. Lasting
  // ("always") grants are allowed here, unlike on a paired phone.
  api.get('/confirmations', (req, res) => {
    deps.confirmations.expireStale();
    const sessionId = typeof req.query.session_id === 'string' ? req.query.session_id : undefined;
    res.json({
      confirmations: deps.confirmations.list(sessionId).map((c) => {
        const ev = deps.events.findConfirmationCreated(c.session_id, c.id);
        // the approval card's command text, tags and highlight spans, computed once at creation
        let card: { command?: unknown; categories?: unknown; matches?: unknown } = {};
        try { card = ev ? (JSON.parse(ev.payload) as typeof card) : {}; } catch { card = {}; }
        return {
          id: c.id, session_id: c.session_id, tool: c.tool, args: projectArgs(c.args_json), status: c.status, scope: c.scope,
          command: typeof card.command === 'string' ? card.command : null,
          categories: Array.isArray(card.categories) ? card.categories : [],
          risk_matches: Array.isArray(card.matches) ? card.matches : null,
          created_at: iso(c.created_at), expires_at: iso(c.expires_at),
        };
      }),
    });
  });
  api.post('/confirmations/:id/:action(approve|deny)', (req, res) => {
    deps.confirmations.expireStale();
    const c = deps.confirmations.get(String(req.params.id));
    if (!c) {
      res.status(404).json({ error: 'confirmation_not_found' });
      return;
    }
    if (c.status !== 'pending' || c.expires_at <= Date.now()) {
      if (c.status === 'pending') deps.confirmations.resolve(c.id, 'expired');
      res.status(409).json({ error: 'confirmation_closed' });
      return;
    }
    const action = req.params.action as 'approve' | 'deny';
    const scope = (req.body as { scope?: unknown } | undefined)?.scope;
    if (action === 'approve' && scope !== undefined && scope !== 'once' && scope !== 'session' && scope !== 'always') {
      res.status(400).json({ error: 'invalid_input', message: 'scope must be once, session or always' });
      return;
    }
    const updated = resolveConfirmation(deps, c, action, action === 'approve' ? ((scope as 'once' | 'session' | 'always' | undefined) ?? 'once') : undefined);
    res.json({ id: c.id, status: updated?.status ?? null });
  });

  api.get('/settings', (_req, res) => {
    if (!deps.settings) {
      res.status(503).json({ error: 'settings_unavailable' });
      return;
    }
    res.json(settingsView(deps));
  });
  api.patch('/settings', (req, res) => {
    const r = patchSettings(deps, req.body, 'local_web', true);
    res.status(r.status).json(r.body);
  });
  api.get('/settings/skills', (req, res) => {
    const dir = typeof req.query.dir === 'string' ? req.query.dir.slice(0, 1000) : (deps.settings?.get().values.skillsDir ?? '');
    const { cls, hint } = skillDirectoryStatus(dir.trim());
    res.json({ cls, hint });
  });
  api.post('/settings/probe', (req, res) => {
    const proxy = deps.settings?.get().values.channelProxyUrl || deps.settings?.get().values.tunnelProbeProxy || '';
    void probePublicUrl((req.body as { url?: unknown } | undefined)?.url, proxy).then((r) => res.json(r));
  });

  // ─── account (plan 6.11): same daemon-owned login VS Code uses ─────────
  const accountFail = (res: Response, e: unknown) => {
    res.status(e instanceof AccountError ? e.status : 502).json({ error: accountErrorCode(e) });
  };
  api.get('/account', (_req, res) => {
    if (!deps.account) { res.status(503).json({ error: 'account_unavailable' }); return; }
    void deps.account.view().then((v) => res.json(v), (e) => accountFail(res, e));
  });
  api.post('/account/sign-in', (_req, res) => {
    try { res.json(deps.account ? deps.account.beginSignIn({ sameAccount: true }) : { state: 'idle' }); } catch (e) { accountFail(res, e); }
  });
  api.post('/account/sign-in/cancel', (_req, res) => { res.json(deps.account?.cancelSignIn() ?? { state: 'idle' }); });
  api.post('/account/sign-out', (_req, res) => {
    if (!deps.account) { res.status(503).json({ error: 'account_unavailable' }); return; }
    void deps.account.call('signOut', []).then(() => deps.account!.view()).then((v) => res.json(v), (e) => accountFail(res, e));
  });

  // ─── subscription (plan 6.12 S4): same daemon calls VS Code uses ───────
  // The signed-in user id is always the daemon's own; the page never names one.
  const billing = (res: Response, run: (uid: string, account: NonNullable<DaemonDeps['account']>) => Promise<unknown>) => {
    const account = deps.account;
    const uid = account?.currentUserId() ?? null;
    if (!account || !uid) { res.status(401).json({ error: 'account_required' }); return; }
    void run(uid, account).then((v) => res.json(v), (e) => accountFail(res, e));
  };
  const str = (v: unknown, max = 200): string | null => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);
  const orderId = (req: Request) => str(req.params.id, 100);
  // Checkout opens in the system browser (Alipay), never inside the app window.
  const withCheckout = async (account: NonNullable<DaemonDeps['account']>, r: unknown) => {
    const { order, checkoutUrl } = r as { order: unknown; checkoutUrl: string };
    return { order, opened: await account.openCheckout(checkoutUrl) };
  };
  api.post('/account/refresh', (_req, res) => billing(res, async (_uid, a) => { await a.call('check', []); return a.view(); }));
  api.get('/account/plans', (_req, res) => billing(res, (uid, a) => a.call('billingPlans', [uid])));
  api.get('/account/orders', (_req, res) => billing(res, (uid, a) => a.call('billingOrders', [uid])));
  api.get('/account/refundable', (req, res) => {
    const cursor = req.query.cursor === undefined ? undefined : str(req.query.cursor);
    if (cursor === null) { res.status(400).json({ error: 'invalid_input' }); return; }
    billing(res, (uid, a) => a.call('billingRefundableOrders', cursor ? [uid, cursor] : [uid]));
  });
  api.post('/account/orders', (req, res) => {
    const sku = str((req.body as { sku?: unknown } | undefined)?.sku, 64);
    if (!sku) { res.status(400).json({ error: 'invalid_input' }); return; }
    billing(res, async (uid, a) => withCheckout(a, await a.call('createBillingOrder', [uid, sku, randomUUID()])));
  });
  api.post('/account/orders/:id/checkout', (req, res) => {
    const id = orderId(req);
    if (!id) { res.status(400).json({ error: 'invalid_input' }); return; }
    billing(res, async (uid, a) => withCheckout(a, await a.call('billingCheckoutLink', [uid, id])));
  });
  api.post('/account/orders/:id/reconcile', (req, res) => {
    const id = orderId(req);
    if (!id) { res.status(400).json({ error: 'invalid_input' }); return; }
    billing(res, (uid, a) => a.call('reconcileBillingOrder', [uid, id]));
  });
  api.post('/account/orders/:id/refund-quote', (req, res) => {
    const id = orderId(req);
    if (!id) { res.status(400).json({ error: 'invalid_input' }); return; }
    billing(res, (uid, a) => a.call('billingRefundQuote', [uid, id]));
  });
  api.post('/account/orders/:id/refund', (req, res) => {
    const id = orderId(req);
    const quote = str((req.body as { quoteToken?: unknown } | undefined)?.quoteToken, 1024);
    if (!id || !quote) { res.status(400).json({ error: 'invalid_input' }); return; }
    billing(res, (uid, a) => a.call('refundBillingOrder', [uid, id, randomUUID(), quote]));
  });
  api.post('/account/redeem', (req, res) => {
    const code = str((req.body as { code?: unknown } | undefined)?.code, 128);
    if (!code) { res.status(400).json({ error: 'invalid_input' }); return; }
    billing(res, (uid, a) => a.call('redeemCard', [code, uid]));
  });

  // ─── stop the background service (plan 6.11 B1) ───────────────────────
  // Same graceful path as VS Code "Stop Daemon": respond, then close channel, sessions and DB.
  api.post('/daemon/stop', (req, res) => {
    if ((req.body as { confirm?: unknown } | undefined)?.confirm !== true) {
      res.status(400).json({ error: 'invalid_input', message: 'confirm must be true' });
      return;
    }
    deps.events.append(null, 'daemon_stop_requested', { source: 'local_web' });
    res.json({ ok: true });
    setTimeout(() => {
      void (deps.shutdown?.() ?? Promise.resolve()).catch(() => undefined).finally(() => process.exit(0));
    }, 100);
  });

  // ─── folder picker ────────────────────────────────────────
  api.get('/fs/dirs', (req, res) => {
    const raw = typeof req.query.path === 'string' ? req.query.path : '';
    if (!raw) {
      res.json({ path: null, parent: null, dirs: dirRoots(), truncated: false });
      return;
    }
    const dir = canonicalDir(raw);
    if ('error' in dir) {
      res.status(400).json({ error: 'invalid_input', message: dir.error });
      return;
    }
    let entries: fs.Dirent[] = [];
    let denied = false;
    try {
      entries = fs.readdirSync(dir.path, { withFileTypes: true });
    } catch {
      denied = true;
    }
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => ({ name: e.name, path: path.join(dir.path, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const parent = path.dirname(dir.path);
    res.json({
      path: dir.path,
      parent: parent === dir.path ? null : parent,
      dirs: dirs.slice(0, MAX_DIR_ENTRIES),
      truncated: dirs.length > MAX_DIR_ENTRIES,
      denied,
    });
  });

  // ─── projects ─────────────────────────────────────────────
  const loadProjects = (): WebProject[] => {
    try {
      const parsed = JSON.parse(deps.machineState.get(PROJECTS_KEY) ?? '[]') as unknown;
      return Array.isArray(parsed) ? (parsed as WebProject[]).filter((p) => p && typeof p.id === 'string' && typeof p.path === 'string') : [];
    } catch {
      return [];
    }
  };
  const saveProjects = (rows: WebProject[]) => deps.machineState.set(PROJECTS_KEY, JSON.stringify(rows));
  const cleanLabel = (v: unknown, fallback: string): string => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 120) : fallback);

  const projectList = () => {
    const saved = loadProjects();
    const sessions = deps.sessions.list().filter((s) => s.status !== 'revoked' && s.status !== 'archived');
    const counts = (p: string) => sessions.filter((s) => samePath(s.workspace_path, p)).length;
    const projects = saved.map((p) => ({ ...p, sessions: counts(p.path), saved: true }));
    for (const s of sessions) {
      if (projects.some((p) => samePath(p.path, s.workspace_path))) continue;
      projects.push({ id: `s:${s.id}`, path: s.workspace_path, label: path.basename(s.workspace_path) || s.workspace_path, pinned: false, created_at: iso(s.created_at) ?? '', sessions: counts(s.workspace_path), saved: false });
    }
    projects.sort((a, b) => Number(b.pinned) - Number(a.pinned) || Number(b.saved) - Number(a.saved) || a.label.localeCompare(b.label));
    return projects;
  };
  api.get('/projects', (_req, res) => {
    res.json({ projects: projectList() });
  });

  // 添加项目: the computer's own folder dialog (loopback-only router, like everything under api).
  let picking = false;
  api.post('/projects/pick', (_req, res) => {
    if (picking) { res.status(409).json({ error: 'picker_busy', message: '电脑上已经打开了一个选择文件夹窗口。' }); return; }
    picking = true;
    void pickFolder().then(
      (r) => res.json(r),
      () => res.json({ unavailable: true }),
    ).finally(() => { picking = false; });
  });

  api.post('/projects', (req, res) => {
    const body = (req.body ?? {}) as { path?: unknown; label?: unknown };
    const dir = canonicalDir(body.path);
    if ('error' in dir) {
      res.status(400).json({ error: 'invalid_input', message: dir.error.replace('workspace_path', 'path') });
      return;
    }
    const rows = loadProjects();
    if (rows.some((p) => samePath(p.path, dir.path))) {
      res.status(409).json({ error: 'project_exists' });
      return;
    }
    if (rows.length >= MAX_PROJECTS) {
      res.status(409).json({ error: 'too_many_projects' });
      return;
    }
    const project: WebProject = { id: randomUUID(), path: dir.path, label: cleanLabel(body.label, path.basename(dir.path) || dir.path), pinned: false, created_at: new Date().toISOString() };
    saveProjects([...rows, project]);
    res.status(201).json({ project });
  });

  api.patch('/projects/:id', (req, res) => {
    const rows = loadProjects();
    const p = rows.find((r) => r.id === req.params.id);
    if (!p) {
      res.status(404).json({ error: 'project_not_found' });
      return;
    }
    const body = (req.body ?? {}) as { label?: unknown; pinned?: unknown };
    if (body.label !== undefined) p.label = cleanLabel(body.label, p.label);
    if (typeof body.pinned === 'boolean') p.pinned = body.pinned;
    saveProjects(rows);
    res.json({ project: p });
  });

  api.delete('/projects/:id', (req, res) => {
    const rows = loadProjects();
    const next = rows.filter((r) => r.id !== req.params.id);
    if (next.length === rows.length) {
      res.status(404).json({ error: 'project_not_found' });
      return;
    }
    saveProjects(next);
    res.json({ ok: true });
  });

  // Apply settings that only take effect at start, when no VS Code window restarts it (S3b).
  api.post('/daemon/restart', (req, res) => {
    if ((req.body as { confirm?: unknown } | undefined)?.confirm !== true) {
      res.status(400).json({ error: 'invalid_input', message: 'confirm must be true' });
      return;
    }
    void restartSelf(deps, 'local_web').then((r) => res.status(r.ok ? 200 : 500).json(r));
  });

  // ─── settings panel actions (plan 6.12 S3) ─────────────────────────────
  // The same handlers VS Code's panel uses, reached in-process after this
  // router's session, CSRF and account checks. Only the listed routes pass.
  const PANEL_ROUTES: ReadonlyArray<readonly [string, RegExp]> = [
    ['GET', /^\/health$/],
    ['GET', /^\/semantic$/],
    ['POST', /^\/semantic\/(key|clear)$/],
    ['GET', /^\/tunnel$/],
    ['POST', /^\/tunnel\/(start|stop)$/],
    ['GET', /^\/channel$/],
    ['POST', /^\/channel$/],
    ['POST', /^\/token\/rotate$/],
    ['GET', /^\/approvals$/],
    ['POST', /^\/approvals\/(clear|session\/remove|[^/]+\/remove)$/],
    ['GET', /^\/proxies$/],
    // session controls in the Web console header (plan 6.15 W1)
    ['GET', /^\/sessions\/[^/]+$/],
    ['GET', /^\/sessions\/[^/]+\/handoff$/],
    ['POST', /^\/sessions\/[^/]+\/(pause|resume|revoke|rotate)$/],
    ['PATCH', /^\/sessions\/[^/]+\/(mode|name)$/],
    ['POST', /^\/proxies\/(revalidate|config\/fields|add|import|tools|remove)$/],
  ];
  api.use('/panel', (req, res, next) => {
    if (!PANEL_ROUTES.some(([method, route]) => method === req.method && route.test(req.path))) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (!control) {
      res.status(503).json({ error: 'panel_unavailable' });
      return;
    }
    control(req, res, next);
  });

  // Channel runtime initialization runs in the daemon: closing the page does not stop it.
  // Download traffic uses only the daemon-owned application proxy and never mutates global fetch/env.
  const installWithProxy = <T extends { path: string; installed: boolean; version?: string }>(
    installer: (configuredPath: string, overrides?: { fetch?: typeof fetch }) => Promise<T>,
  ) => (configuredPath: string) =>
    withProxyFetch(deps.settings?.get().values.channelProxyUrl || undefined, (fetchFile) => installer(configuredPath, { fetch: fetchFile }));
  const cloudflared = new CloudflaredJob(installWithProxy(initializeCloudflared), deps.log);
  api.get('/cloudflared/install', (_req, res) => { res.json(cloudflared.view()); });
  api.post('/cloudflared/install', (_req, res) => {
    const current = deps.settings?.get().values;
    if (current && current.channelMode === 'custom') {
      res.status(409).json({ error: 'custom_channel' });
      return;
    }
    cloudflared.start(current?.cloudflaredPath ?? '');
    res.status(202).json(cloudflared.view());
  });

  // ─── OpenAI tunnel (web settings): the handlers VS Code's panel uses, behind this
  // router's cookie, Origin, CSRF and account checks, and only from a loopback peer.
  // Not mounted on the phone surface; request bodies (the API key) are never echoed.
  const openaiLocal = (req: Request): string | null => (loopbackPeer(req) ? null : 'local_only');
  const openaiInstall = new CloudflaredJob(installWithProxy(initializeOpenAITunnelClient), deps.log, 'openai tunnel-client');
  api.get('/openai-tunnel/install', (req, res) => {
    const denied = openaiLocal(req);
    if (denied) { res.status(403).json({ error: denied }); return; }
    res.setHeader('Cache-Control', 'no-store');
    res.json(openaiInstall.view());
  });
  // Pinned plain runtime, SHA-256 verified (src/tunnel/openai-tunnel-install.ts); saves nothing, starts nothing.
  api.post('/openai-tunnel/install', (req, res) => {
    const denied = openaiLocal(req);
    if (denied) { res.status(403).json({ error: denied }); return; }
    openaiInstall.start(deps.settings?.get().values.openaiTunnelClientPath ?? '');
    res.status(202).json(openaiInstall.view());
  });
  api.use('/openai-tunnel', openAITunnelRouter(deps, () => deps.daemonId ?? '', openaiLocal));

  // ─── phone access: this computer's controls (plan 6.13 R4) ─────────────
  const decidePair = (id: string, allow: boolean): boolean => {
    const ok = remoteAccess.decide(id, allow);
    if (ok) deps.events.append(null, allow ? 'remote_pair_allowed' : 'remote_pair_denied', {});
    return ok;
  };
  const remoteView = () => {
    const enabled = remoteEnabled();
    const channels = enabled ? remoteChannels() : [];
    const ch = channels[0] ?? null;
    if (!enabled) remoteAccess.revokeAll();
    else remoteAccess.prune(channels);
    const values = deps.settings?.get().values;
    const customSelected = values?.channelMode === 'custom' || values?.aiDefaultRoute === 'custom';
    const listener = deps.directAccess?.view();
    const reason = !enabled ? 'off'
      : ch ? null
      : listener?.state === 'applying' ? 'direct_applying'
      : values?.directAccessEnabled ? (listener?.listening ? 'direct_no_address' : 'direct_unavailable')
      : customSelected ? 'custom_unavailable'
      : 'channel_offline';
    return {
      enabled,
      available: enabled && channels.length > 0,
      reason,
      origin: ch?.origin ?? null,
      kind: ch?.kind ?? null,
      // available is configuration-level compatibility, never a reachability claim.
      endpoints: channels.map((x) => ({ origin: x.origin, kind: x.kind, scope: phoneScope(x.origin), verification: remoteProbes.view(x.origin) })),
      devices: enabled ? remoteAccess.list() : [],
      requests: enabled ? remoteAccess.pending(channels) : [],
    };
  };
  deps.remote = {
    view: remoteView,
    probe: (origin: string) => remoteProbes.probe(origin),
    pair: (origin?: string) => {
      const channels = remoteChannels();
      const ch = origin ? channels.find((x) => x.origin === origin) ?? null : defaultRemoteChannel();
      if (!ch) return null;
      const { code, expiresAt } = remoteAccess.issueCode(ch);
      return { url: `${ch.origin}/#pair=${code}`, expires_at: iso(expiresAt), kind: ch.kind };
    },
    revoke: (id) => {
      const ok = remoteAccess.revoke(id);
      if (ok) deps.events.append(null, 'remote_device_revoked', {});
      return ok;
    },
    decide: (id, allow) => decidePair(id, allow),
  };
  api.get('/remote', (_req, res) => { res.json(remoteView()); });
  api.post('/remote/probe', async (req, res) => {
    const body = req.body as { origin?: unknown } | undefined;
    if (!body || typeof body.origin !== 'string' || Object.keys(body).some((key) => key !== 'origin')) {
      res.status(400).json({ error: 'invalid_body' }); return;
    }
    const result = await remoteProbes.probe(body.origin);
    if (!result) { res.status(409).json({ error: 'remote_unavailable' }); return; }
    res.json(remoteView());
  });
  api.post('/remote/pair', (req, res) => {
    const origin = (req.body as { origin?: unknown } | undefined)?.origin;
    if (origin !== undefined && typeof origin !== 'string') { res.status(400).json({ error: 'invalid_body' }); return; }
    const channels = remoteChannels();
    const ch = typeof origin === 'string' ? channels.find((x) => x.origin === origin) ?? null : defaultRemoteChannel();
    if (!ch) {
      res.status(409).json({ error: 'remote_unavailable', ...remoteView() });
      return;
    }
    const { code, expiresAt } = remoteAccess.issueCode(ch);
    res.json({ url: `${ch.origin}/#pair=${code}`, expires_at: iso(expiresAt), kind: ch.kind });
  });
  api.post('/remote/devices/:id/revoke', (req, res) => {
    const ok = remoteAccess.revoke(String(req.params.id));
    if (ok) deps.events.append(null, 'remote_device_revoked', {});
    res.status(ok ? 200 : 404).json(ok ? remoteView() : { error: 'device_not_found' });
  });
  // 允许 / 拒绝 a phone that just scanned the code
  api.post('/remote/requests/:id', (req, res) => {
    const allow = (req.body as { allow?: unknown } | undefined)?.allow;
    if (typeof allow !== 'boolean') {
      res.status(400).json({ error: 'invalid_body' });
      return;
    }
    if (!decidePair(String(req.params.id), allow)) {
      res.status(404).json({ error: 'request_not_found', ...remoteView() });
      return;
    }
    res.json(remoteView());
  });
  api.post('/remote/revoke-all', (_req, res) => {
    const n = remoteAccess.revokeAll();
    if (n) deps.events.append(null, 'remote_device_revoked', { count: n });
    res.json(remoteView());
  });

  if (deps.courier) api.use('/courier', courierRoutes(deps.courier, (d) => deps.events.append(null, 'courier_send', { ...d, via: 'web' }), { images: true }));
  api.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });
  // Body parser and handler errors: accurate status, no internal detail.
  api.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (err as { status?: unknown })?.status;
    if (status === 413) res.status(413).json({ error: 'body_too_large' });
    else if (typeof status === 'number' && status >= 400 && status < 500) res.status(400).json({ error: 'invalid_body' });
    else {
      deps.log(`local web: ${err instanceof Error ? err.message : String(err)}`);
      res.status(500).json({ error: 'internal_error' });
    }
  });
  app.use('/web-api/v1', api);
  // ─── phone surface: /remote-api/v1 (plan 6.13 R1–R3) ───────────────────
  // Only on the enabled public HTTP(S) address, only for a paired device, and
  // only the routes a phone needs (R-D1): read sessions and calls, answer
  // approvals, start a session in a known project. Everything else is 404.
  const remote = Router();
  // Pair/claim use high-entropy one-time capabilities and RemoteAccess keeps
  // their server-side state strictly bounded (MAX_CODES/MAX_REQUESTS). There is
  // no trustworthy client IP at this local gateway, so unauthenticated requests
  // are deliberately not keyed by forwarded headers. Authenticated traffic is
  // rate-limited by the verified device id instead.
  const pairLimit = new RateLimiter(20, 60_000);
  const claimLimit = new RateLimiter(60, 60_000);
  const remoteLimit = new RateLimiter(300, 60_000);
  const deviceCookie = (secret: string, maxAge: number, channel: PublicChannel) => {
    const secure = new URL(channel.origin).protocol === 'https:' ? '; Secure' : '';
    return `${DEVICE_COOKIE}=${secret}; Path=/remote-api; HttpOnly${secure}; SameSite=Strict; Max-Age=${maxAge}`;
  };
  remote.use(securityHeaders);
  remote.use((req, res, next) => {
    const ch = remoteChannel(req);
    if (!ch) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    // Our own page only: the custom header forces a CORS preflight we never answer.
    const site = req.headers['sec-fetch-site'];
    const origin = req.headers.origin;
    const read = req.method === 'GET' || req.method === 'HEAD';
    if (req.headers[CLIENT_HEADER] !== '1' || (site !== undefined && site !== 'same-origin') || (origin === undefined ? !read : origin !== ch.origin)) {
      res.status(403).json({ error: 'origin_rejected' });
      return;
    }
    res.locals.channel = ch;
    next();
  });
  remote.use(express.json({ limit: 16 * 1024 }));
  remote.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD' && !req.is('application/json')) {
      res.status(415).json({ error: 'json_required' });
      return;
    }
    next();
  });

  remote.post('/pair', (req, res) => {
    const code = (req.body as { code?: unknown } | undefined)?.code;
    if (!pairLimit.allow(typeof code === 'string' ? code : 'invalid')) { res.status(429).json({ error: 'rate_limited' }); return; }
    const user = accountUser();
    if (accountGate() && !user) {
      res.status(401).json({ error: 'account_required' });
      return;
    }
    const name = deviceName(req.headers['user-agent']);
    // The code alone grants nothing: it files a request someone on the computer must allow.
    const pending = remoteAccess.requestPair(code, res.locals.channel as PublicChannel, name, user);
    if (!pending) {
      res.status(401).json({ error: 'pair_invalid' });
      return;
    }
    deps.events.append(null, 'remote_pair_requested', { name });
    res.status(202).json({ state: 'pending', token: pending.token, device: name, expires_at: iso(pending.expiresAt) });
  });

  // The phone polls here until the computer answers.
  remote.post('/pair/claim', (req, res) => {
    const token = (req.body as { token?: unknown } | undefined)?.token;
    if (!claimLimit.allow(typeof token === 'string' ? token : 'invalid')) { res.status(429).json({ error: 'rate_limited' }); return; }
    const channel = res.locals.channel as PublicChannel;
    const r = remoteAccess.claim(token, channel);
    if (r.state === 'approved') {
      res.setHeader('Set-Cookie', deviceCookie(r.secret, Math.floor(DEVICE_IDLE_MS / 1000), channel));
      deps.events.append(null, 'remote_device_paired', { name: r.device.name, kind: r.device.kind });
      res.json({ state: 'approved', device: r.device.name });
      return;
    }
    if (r.state === 'pending') {
      res.json({ state: 'pending' });
      return;
    }
    res.status(r.state === 'denied' ? 403 : 401).json({ error: r.state === 'denied' ? 'pair_denied' : 'pair_expired' });
  });

  // Everything below needs a paired device on this origin.
  remote.use((req, res, next) => {
    const device = remoteAccess.check(readCookie(req, DEVICE_COOKIE), res.locals.channel as PublicChannel);
    if (!device) {
      res.status(401).json({ error: 'unpaired' });
      return;
    }
    if (!remoteLimit.allow(device.id)) {
      res.status(429).json({ error: 'rate_limited' });
      return;
    }
    const user = accountUser();
    if (user && device.user_id && device.user_id !== user) {
      remoteAccess.revoke(device.id);
      res.status(401).json({ error: 'unpaired' });
      return;
    }
    // The computer's sign-in lapsed: pause, keep the pairing.
    if (accountGate() && !user) {
      res.status(401).json({ error: 'account_required' });
      return;
    }
    res.locals.device = device;
    next();
  });

  remote.get('/session', async (_req, res) => {
    const view = await deps.account?.view().catch(() => null);
    res.json({ paired: true, device: (res.locals.device as { name: string }).name, version: VERSION, remaining_seconds: view?.remainingSeconds ?? null });
  });
  remote.post('/logout', (req, res) => {
    remoteAccess.revoke((res.locals.device as { id: string }).id);
    res.setHeader('Set-Cookie', deviceCookie('', 0, res.locals.channel as PublicChannel));
    res.json({ ok: true });
  });
  remote.use((_req, res, next) => {
      if (integrityFailures().length) { res.status(503).json({ error: 'install_corrupted', message: INTEGRITY_MESSAGE }); return; }
    next();
  });
  remote.use(data);
  remote.get('/projects', (_req, res) => {
    res.json({ projects: projectList().map((p) => ({ id: p.id, label: p.label, path: p.path, sessions: p.sessions })) });
  });
  remote.get('/confirmations', (req, res) => {
    deps.confirmations.expireStale();
    const sessionId = typeof req.query.session_id === 'string' ? req.query.session_id : undefined;
    res.json({
      confirmations: deps.confirmations.list(sessionId).map((c) => ({
        id: c.id, session_id: c.session_id, tool: c.tool, args: projectArgs(c.args_json), status: c.status, scope: c.scope,
        created_at: iso(c.created_at), expires_at: iso(c.expires_at),
      })),
    });
  });
  remote.post('/confirmations/:id/:action(approve|deny)', (req, res) => {
    deps.confirmations.expireStale();
    const c = deps.confirmations.get(String(req.params.id));
    if (!c) {
      res.status(404).json({ error: 'confirmation_not_found' });
      return;
    }
    if (c.status !== 'pending' || c.expires_at <= Date.now()) {
      if (c.status === 'pending') deps.confirmations.resolve(c.id, 'expired');
      res.status(409).json({ error: 'confirmation_closed' });
      return;
    }
    const action = req.params.action as 'approve' | 'deny';
    // A phone may approve once or for this session; lasting grants stay on the computer.
    const scope = (req.body as { scope?: unknown } | undefined)?.scope;
    if (action === 'approve' && scope !== undefined && scope !== 'once' && scope !== 'session') {
      res.status(400).json({ error: 'invalid_input', message: 'scope must be once or session' });
      return;
    }
    const updated = resolveConfirmation(deps, c, action, action === 'approve' ? ((scope as 'once' | 'session' | undefined) ?? 'once') : undefined);
    deps.events.append(c.session_id, 'remote_confirmation', { action, device: (res.locals.device as { name: string }).name });
    res.json({ id: c.id, status: updated?.status ?? null });
  });
  remote.post('/sessions', (req, res) => {
    if (integrityFailures().length) { res.status(503).json({ error: 'install_corrupted', message: INTEGRITY_MESSAGE }); return; }
    const body = req.body as Record<string, unknown> | undefined;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((k) => !['project_id', 'permission_mode', 'name', 'draft'].includes(k))) {
      res.status(400).json({ error: 'invalid_body' });
      return;
    }
    const project = projectList().find((p) => p.id === body.project_id);
    if (!project) {
      res.status(400).json({ error: 'invalid_input', message: 'project not found' });
      return;
    }
    if (body.permission_mode !== undefined && !PERMISSION_MODES.includes(body.permission_mode as PermissionMode)) {
      res.status(400).json({ error: 'invalid_input', message: `permission_mode must be one of ${PERMISSION_MODES.join(', ')}` });
      return;
    }
    const created = createWorkspaceSession(deps, { workspace_path: project.path, permission_mode: body.permission_mode, name: body.name, draft: body.draft === true });
    if ('error' in created) {
      res.status(400).json({ error: 'invalid_input', message: created.error });
      return;
    }
    // A draft (new chat page) needs no credential on the phone: the daemon renders the
    // connector prompt when its first message is sent (/courier/start template=connector).
    if (body.draft === true) { res.status(201).json({ session: sessionView(created.session) }); return; }
    deps.events.append(created.session.id, 'remote_session_created', { device: (res.locals.device as { name: string }).name });
    res.status(201).json({ session: sessionView(created.session), session_id: created.session.credential_id, mcp_url: mcpUrl(deps), connection_routes: resolveConnectionRoutes(deps, mcpPath()) });
  });
  // Rename from the phone session menu (empty = back to the default title).
  remote.post('/sessions/:id/rename', (req, res) => {
    const id = req.params.id as string;
    const existing = deps.sessions.get(id);
    const name = (req.body as { name?: unknown } | undefined)?.name;
    if (!existing) { res.status(404).json({ error: 'not_found' }); return; }
    if (typeof name !== 'string') { res.status(400).json({ error: 'invalid_body' }); return; }
    const updated = deps.sessions.setName(id, name);
    if (!('draft' in existing)) deps.events.append(id, 'session_renamed', { name: updated?.name ?? null, device: (res.locals.device as { name: string }).name });
    deps.changes.bump();
    res.json({ session: sessionView(updated as NonNullable<typeof updated>) });
  });
  // A new-chat draft whose first message did not go out: forget it (stored sessions are untouched).
  remote.post('/sessions/:id/discard', (req, res) => {
    res.json({ discarded: deps.sessions.discardDraft(req.params.id as string) });
  });
  if (deps.courier) remote.use('/courier', courierRoutes(deps.courier, (d) => deps.events.append(null, 'courier_send', { ...d, via: 'phone' })));
  remote.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });
  remote.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (err as { status?: unknown })?.status;
    if (status === 413) res.status(413).json({ error: 'body_too_large' });
    else if (typeof status === 'number' && status >= 400 && status < 500) res.status(400).json({ error: 'invalid_body' });
    else {
      deps.log(`remote web: ${err instanceof Error ? err.message : String(err)}`);
      res.status(500).json({ error: 'internal_error' });
    }
  });
  app.use('/remote-api/v1', remote);
  return state;
}
