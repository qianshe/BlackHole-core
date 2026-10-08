import express, { Router, type Express, type Request, type Response } from 'express';
import type { Server } from 'node:http';
import { nativeLoopbackRequest } from '../control/openai-tunnel-routes.js';
import { COURIER_PROTOCOL, MAX_IMAGE_BYTES, type CourierHub } from './hub.js';
import { acceptUpgrade, rejectUpgrade } from './ws.js';

/** The unpacked/published Courier extension (fixed by the manifest key). */
export const COURIER_EXTENSION_ORIGIN = 'chrome-extension://beeclkelnhfihhhekblfojimhbpolbpg';
export const COURIER_PATH = '/api/courier';

const HOST = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]{1,5})?$/i;
const PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'cf-connecting-ip', 'x-real-ip'];

type Headers = Record<string, string | string[] | undefined>;
const localHop = (headers: Headers, peer: string | undefined): boolean =>
  HOST.test(String(headers.host ?? '')) && PEERS.has(peer ?? '') && PROXY_HEADERS.every((h) => headers[h] === undefined);

export type CourierAudit = (data: Record<string, unknown>) => void;

/**
 * Ping + WebSocket for the extension, and the native-loopback send API for the
 * VS Code extension. Register before the `/api` control router.
 */
export function mountCourier(app: Express, server: Server, hub: CourierHub, audit: CourierAudit): void {
  // Courier asks here over plain HTTP before opening the socket (a failed handshake is logged as an extension error).
  app.get(`${COURIER_PATH}/ping`, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!localHop(req.headers, req.socket.remoteAddress)) { res.status(403).json({ error: 'local_only' }); return; }
    res.json({ service: 'blackhole', courier: COURIER_PROTOCOL });
  });

  server.on('upgrade', (req, socket, head: Buffer) => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== COURIER_PATH) { rejectUpgrade(socket, 404, 'Not Found'); return; }
    if (!localHop(req.headers, req.socket.remoteAddress) || req.headers.origin !== COURIER_EXTENSION_ORIGIN) {
      rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }
    const conn = acceptUpgrade(req, socket, head);
    if (conn) hub.attach(conn);
  });

  const native = Router();
  native.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!nativeLoopbackRequest(req)) { res.status(403).json({ error: 'native_loopback_required' }); return; }
    next();
  });
  native.use(express.json({ limit: 64 * 1024 }));
  native.use(courierRoutes(hub, (d) => audit({ ...d, via: 'vscode' }), { images: true }));
  app.use(COURIER_PATH, native);
}

/**
 * `GET /` status + targets, `GET /messages?sessionId=` the Chat page thread,
 * `GET /stream?sessionId=` live thread updates (server-sent events, one `message` event per added/updated message),
 * `POST /send` ({ targetId, text, sessionId }: only to chats bound to that session),
 * `POST /stop` ({ sessionId, targetId? }: press the paired chat's own stop control),
 * `POST /reload` ({ sessionId, targetId? }: force-reload the paired chat; a closed one is reopened),
 * `POST /card` ({ sessionId, targetId? }: answer the open rating card with the auto-rate rule),
 * `POST /start` ({ sessionId, text, site? }: open a new web chat for a session and send the first message),
 * `POST /unpair` ({ sessionId }: cut the session's pairing; it only receives afterwards).
 * Mounted on /api/courier, /web-api/courier and /remote-api/v1/courier.
 */
export function courierRoutes(hub: CourierHub, audit: CourierAudit, opts: { images?: boolean } = {}): Router {
  const r = Router();
  // Sent images for the local UIs (this machine: no traffic). Not mounted for the phone.
  if (opts.images) {
    r.get('/images/:messageId/:n', (req, res) => {
      const n = Number(req.params.n);
      const img = Number.isInteger(n) && n >= 0 && n < 8 ? hub.sentImage(String(req.params.messageId), n) : null;
      if (!img) { res.status(404).json({ error: 'not_found' }); return; }
      res.setHeader('Content-Type', img.mime);
      res.setHeader('Cache-Control', 'private, max-age=86400');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.send(img.data);
    });
  }
  // ?cached=1: the last pushed list without asking Courier (for UIs that poll often).
  r.get('/', async (req, res) => {
    res.json(await hub.status(req.query.cached !== '1'));
  });
  r.get('/messages', (req, res) => {
    const id = typeof req.query.sessionId === 'string' ? req.query.sessionId : '';
    res.json({ messages: hub.messages(id) });
  });
  r.get('/stream', (req, res) => {
    const id = typeof req.query.sessionId === 'string' ? req.query.sessionId : '';
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    const stop = hub.watch(id, (m) => { res.write(`event: message\ndata: ${JSON.stringify(m)}\n\n`); });
    const beat = setInterval(() => res.write(': ping\n\n'), 15_000);
    beat.unref();
    const end = (): void => { clearInterval(beat); stop(); };
    req.on('close', end);
    res.on('error', end);
  });
  r.post('/start', async (req: Request, res: Response) => {
    const b = req.body as Record<string, unknown> | undefined;
    if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some((k) => !['sessionId', 'text', 'site', 'display', 'template'].includes(k))) {
      res.status(400).json({ error: 'invalid_body' });
      return;
    }
    const result = await hub.start({ sessionId: b.sessionId, text: b.text, site: b.site, display: b.display, template: b.template });
    if (result.code === 'invalid_input' || result.code === 'text_too_long') {
      res.status(400).json({ error: result.code, message: result.message });
      return;
    }
    audit({ site: typeof b.site === 'string' ? b.site : 'arena', ok: result.ok, code: result.code ?? null, start: true });
    res.json(result);
  });
  // Cut a session's pairing (the session stays and keeps receiving; Courier drops the binding).
  r.post('/unpair', (req: Request, res: Response) => {
    const b = req.body as Record<string, unknown> | undefined;
    if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some((k) => k !== 'sessionId')) {
      res.status(400).json({ error: 'invalid_body' });
      return;
    }
    const result = hub.unpair(b.sessionId);
    if (!result.ok) { res.status(400).json({ error: 'invalid_input', message: result.message }); return; }
    audit({ unpair: true });
    res.json(result);
  });
  // A pasted image: raw bytes (Content-Type image/*), kept in memory until /send names it by id.
  r.post('/attachments', express.raw({ type: 'image/*', limit: MAX_IMAGE_BYTES }), (req: Request, res: Response) => {
    const mime = String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    if (!Buffer.isBuffer(req.body)) { res.status(400).json({ error: 'invalid_input', message: '只支持 PNG、JPEG、WebP、GIF 图片' }); return; }
    const r = hub.addImage(mime, req.body);
    if ('code' in r) { res.status(r.code === 'busy' ? 429 : 400).json({ error: r.code, message: r.message }); return; }
    res.status(201).json(r);
  });
  r.post('/send', async (req: Request, res: Response) => {
    const b = req.body as Record<string, unknown> | undefined;
    if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some((k) => !['targetId', 'text', 'sessionId', 'activate', 'images'].includes(k))) {
      res.status(400).json({ error: 'invalid_body' });
      return;
    }
    const result = await hub.send({ targetId: b.targetId, text: b.text, sessionId: b.sessionId, activate: b.activate, images: b.images });
    if (result.code === 'invalid_input' || result.code === 'text_too_long') {
      res.status(400).json({ error: result.code, message: result.message });
      return;
    }
    const target = (await hub.status(false)).targets.find((t) => t.targetId === result.targetId);
    audit({ site: target?.site ?? null, ok: result.ok, code: result.code ?? null });
    res.json(result);
  });
  // Press the paired chat's own stop control. Shared by the VS Code panel, the web console and the
  // phone: whoever calls it, Courier finds the bound tab and the page reports what it pressed.
  r.post('/stop', async (req: Request, res: Response) => {
    const b = req.body as Record<string, unknown> | undefined;
    if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some((k) => !['sessionId', 'targetId'].includes(k))) {
      res.status(400).json({ error: 'invalid_body' });
      return;
    }
    const result = await hub.stop({ sessionId: b.sessionId, targetId: b.targetId });
    if (result.code === 'invalid_input') { res.status(400).json({ error: result.code, message: result.message }); return; }
    const target = (await hub.status(false)).targets.find((t) => t.targetId === result.targetId);
    audit({ site: target?.site ?? null, ok: result.ok, code: result.code ?? null, stop: true });
    res.json(result);
  });
  // Force-reload the paired chat (a closed one is opened again) and answer its open rating card with
  // the auto-rate rule. Same callers as /stop.
  for (const [path, kind] of [['/reload', 'reload'], ['/card', 'card']] as const) {
    r.post(path, async (req: Request, res: Response) => {
      const b = req.body as Record<string, unknown> | undefined;
      if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some((k) => !['sessionId', 'targetId'].includes(k))) {
        res.status(400).json({ error: 'invalid_body' });
        return;
      }
      const input = { sessionId: b.sessionId, targetId: b.targetId };
      const result = kind === 'reload' ? await hub.reload(input) : await hub.rateCard(input);
      if (result.code === 'invalid_input') { res.status(400).json({ error: result.code, message: result.message }); return; }
      const target = (await hub.status(false)).targets.find((t) => t.targetId === result.targetId);
      audit({ site: target?.site ?? null, ok: result.ok, code: result.code ?? null, [kind]: true });
      res.json(result);
    });
  }
  return r;
}

