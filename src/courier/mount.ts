import express, { Router, type Express, type Request, type Response } from 'express';
import type { Server } from 'node:http';
import { nativeLoopbackRequest } from '../control/openai-tunnel-routes.js';
import { COURIER_PROTOCOL, type CourierHub } from './hub.js';
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
  native.use(courierRoutes(hub, (d) => audit({ ...d, via: 'vscode' })));
  app.use(COURIER_PATH, native);
}

/** `GET /` status + targets, `POST /send`. Mounted on /api/courier, /web-api/courier and /remote-api/v1/courier. */
export function courierRoutes(hub: CourierHub, audit: CourierAudit): Router {
  const r = Router();
  r.get('/', async (_req, res) => {
    res.json(await hub.status());
  });
  r.post('/send', async (req: Request, res: Response) => {
    const b = req.body as Record<string, unknown> | undefined;
    if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some((k) => !['targetId', 'text', 'activate'].includes(k))) {
      res.status(400).json({ error: 'invalid_body' });
      return;
    }
    const result = await hub.send({ targetId: b.targetId, text: b.text, activate: b.activate });
    if (result.code === 'invalid_input' || result.code === 'text_too_long') {
      res.status(400).json({ error: result.code, message: result.message });
      return;
    }
    const target = (await hub.status(false)).targets.find((t) => t.targetId === result.targetId);
    audit({ site: target?.site ?? null, ok: result.ok, code: result.code ?? null });
    res.json(result);
  });
  return r;
}
