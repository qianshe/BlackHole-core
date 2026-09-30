import express, { Router, type NextFunction, type Request, type Response } from 'express';
import type { DaemonDeps } from '../deps.js';
import { OpenAITunnelError } from '../tunnel/openai-manager.js';

/**
 * OpenAI tunnel control routes (plan §5.2 / §5.2.2). Mounted BEFORE the shared
 * control-plane JSON parser: native-loopback checks run first, then a small
 * strict parser, and every parse/validation failure ends inside this router
 * with a fixed code. Request bodies (which may carry the API key) are never
 * echoed, logged or passed to the generic error output.
 */
const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const HOST = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]{1,5})?$/i;
const NON_NATIVE_HEADERS = ['origin', 'cookie', 'authorization', 'sec-fetch-site', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'cf-connecting-ip', 'x-real-ip'];
const API_KEY = /^[\x21-\x7e]{8,1024}$/;

export function nativeLoopbackRequest(req: Pick<Request, 'headers' | 'socket'>): boolean {
  if (!HOST.test(req.headers.host ?? '')) return false;
  if (!LOOPBACK_PEERS.has(req.socket?.remoteAddress ?? '')) return false;
  return NON_NATIVE_HEADERS.every((h) => req.headers[h] === undefined);
}

/** A loopback TCP peer (no network hop), whatever headers the caller sends. */
export function loopbackPeer(req: Pick<Request, 'socket'>): boolean {
  return LOOPBACK_PEERS.has(req.socket?.remoteAddress ?? '');
}

/**
 * The OpenAI tunnel routes behind a caller-specific guard (returns an error code
 * to refuse). The control API admits native loopback programs (VS Code); Local Web
 * admits its own signed-in page from a loopback peer, after that router's cookie,
 * Origin, CSRF and account checks. Never mounted on the phone surface.
 */
export function openAITunnelRouter(deps: DaemonDeps, daemonId: () => string, guard: (req: Request) => string | null): Router {
  const r = Router();
  r.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const denied = guard(req);
    if (denied) { res.status(403).json({ error: denied }); return; }
    if (req.method !== 'GET' && !req.is('application/json')) { res.status(415).json({ error: 'unsupported_media_type' }); return; }
    next();
  });
  r.use(express.json({ limit: '16kb', type: 'application/json', strict: true }));

  const manager = () => {
    const m = deps.openaiTunnel;
    if (!m) throw new OpenAITunnelError(503, 'openai_tunnel_unavailable');
    return m;
  };
  const body = (req: Request): Record<string, unknown> => {
    const b = req.body as unknown;
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw new OpenAITunnelError(400, 'invalid_request');
    const o = b as Record<string, unknown>;
    if (typeof o.daemon_id !== 'string' || !o.daemon_id) throw new OpenAITunnelError(400, 'invalid_request');
    if (o.daemon_id !== daemonId()) throw new OpenAITunnelError(409, 'daemon_changed');
    return o;
  };
  const revision = (v: unknown): number => {
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new OpenAITunnelError(400, 'invalid_request');
    return v;
  };
  const handle = (fn: (req: Request) => Promise<unknown> | unknown) => (req: Request, res: Response): void => {
    Promise.resolve().then(() => fn(req)).then((out) => { res.json(out); }, (e: unknown) => {
      if (e instanceof OpenAITunnelError) {
        res.status(e.status).json({ error: e.code, ...(deps.openaiTunnel ? { openai_tunnel: deps.openaiTunnel.view() } : {}) });
        return;
      }
      deps.log('openai-tunnel: control route failed');
      res.status(500).json({ error: 'internal_error' });
    });
  };

  r.get('/', handle(() => manager().view()));
  r.get('/diagnostics', handle(() => manager().diagnostics()));
  r.post('/start', handle((req) => {
    const b = body(req);
    const view = manager().start({ settingsRevision: revision(b.settings_revision), credentialRevision: revision(b.credential_revision) });
    // An explicit start comes from a heartbeat sender: keep the watchdog fed (like /tunnel/start).
    deps.lastHeartbeatAt = Date.now();
    return view;
  }));
  r.post('/stop', handle((req) => {
    const b = body(req);
    if (b.run_id !== null && typeof b.run_id !== 'string') throw new OpenAITunnelError(400, 'invalid_request');
    return manager().stop(b.run_id as string | null);
  }));
  r.put('/credential', handle((req) => {
    const b = body(req);
    const rev = revision(b.credential_revision);
    const key = typeof b.api_key === 'string' ? b.api_key.trim() : '';
    if (!API_KEY.test(key)) throw new OpenAITunnelError(400, 'invalid_api_key');
    return manager().setCredential(rev, key).then((v) => ({ credential_configured: v.credential_configured, credential_revision: v.credential_revision, pending_restart: v.pending_restart }));
  }));
  r.delete('/credential', handle((req) => {
    const b = body(req);
    return manager().removeCredential(revision(b.credential_revision)).then((v) => ({ credential_configured: v.credential_configured, credential_revision: v.credential_revision }));
  }));
  r.use((_req, res) => { res.status(404).json({ error: 'not_found' }); });
  // Parser failures (bad JSON, too large, bad charset): fixed codes, never the body or the raw error.
  r.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const type = (err as { type?: unknown } | null)?.type;
    if (type === 'entity.too.large') { res.status(413).json({ error: 'body_too_large' }); return; }
    res.status(400).json({ error: 'invalid_json' });
  });
  return r;
}

export function mountOpenAITunnel(app: Router, deps: DaemonDeps, daemonId: string): void {
  app.use('/openai-tunnel', openAITunnelRouter(deps, () => daemonId, (req) => (nativeLoopbackRequest(req) ? null : 'native_loopback_required')));
}
