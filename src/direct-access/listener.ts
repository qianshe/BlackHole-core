// One data-plane listener for direct LAN/mesh/public access and an optional
// operator-managed reverse proxy. The daemon control listener remains separate.
import http from 'node:http';
import os from 'node:os';
import { isIP } from 'node:net';
import { DEFAULT_DIRECT_PORT, type DirectAccessView } from '../../packages/contracts/dist/connections.js';

export { DEFAULT_DIRECT_PORT };
export type { DirectAccessView };

export interface DirectAccessConfig {
  enabled: boolean;
  port: number;
  advertisedUrl: string;
  proxyOrigin: string;
}

/** Immutable snapshot: queued work must not read a later settings revision. */
export function directAccessConfig(values: {
  directAccessEnabled: boolean; directPort: number; directAccessUrl: string;
  publicBaseUrl: string; channelMode: string; aiDefaultRoute: string;
}): DirectAccessConfig {
  return {
    enabled: values.directAccessEnabled,
    port: values.directPort,
    advertisedUrl: values.directAccessUrl,
    proxyOrigin: values.channelMode === 'custom' || values.aiDefaultRoute === 'custom' ? values.publicBaseUrl : '',
  };
}

export function directAddresses(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string[] {
  return [...new Set(Object.values(ifaces).flatMap((list) => (list ?? [])
    .filter((a) => a.family === 'IPv4' && !a.internal && isIP(a.address) === 4 && !a.address.startsWith('169.254.'))
    .map((a) => a.address)))];
}

function bareOrigin(raw: string): string | null {
  if (!raw.trim()) return null;
  const u = new URL(raw.trim());
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.pathname !== '/' || u.search || u.hash) {
    throw new Error('对外地址必须是不带路径或凭据的 HTTP(S) 地址');
  }
  return u.origin;
}

export function directAccessAllowed(raw: string | undefined): boolean {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || /[\\#\u0000-\u0020]/.test(raw)) return false;
  const head = raw.split('?')[0]!;
  if (/%2f|%5c/i.test(head)) return false;
  let p: string;
  try { p = new URL(raw, 'http://127.0.0.1').pathname; } catch { return false; }
  return p === '/' || p === '/probe' || p === '/bh.md' || p === '/bh.py'
    || p === '/ui' || p.startsWith('/ui/')
    || p === '/remote-api/v1' || p.startsWith('/remote-api/v1/')
    || /^\/mcp\/[^/]+$/.test(p) || /^\/panel\/[^/]+(?:\/.*)?$/.test(p);
}

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;
type Applied = {
  config: DirectAccessConfig;
  origin: string | null;
  proxyOrigin: string | null;
  mode: DirectAccessView['mode'];
  bindHost: DirectAccessView['bind_host'];
};
const EMPTY: DirectAccessConfig = { enabled: false, port: DEFAULT_DIRECT_PORT, advertisedUrl: '', proxyOrigin: '' };

export class DirectAccessListener {
  private server: http.Server | null = null;
  private requested = { ...EMPTY };
  private active: Applied | null = null;
  private state: DirectAccessView['state'] = 'off';
  private error: string | null = null;
  private generation = 0;
  private queue: Promise<void> = Promise.resolve();
  private readonly requestOrigins = new WeakMap<http.IncomingMessage, string>();

  constructor(
    private readonly app: Handler,
    private readonly mainPort: number,
    private readonly log: (line: string) => void = () => {},
    private readonly addresses: () => string[] = directAddresses,
  ) {}

  apply(config: DirectAccessConfig): Promise<void> {
    const generation = ++this.generation;
    const snapshot = { ...config };
    this.requested = snapshot;
    this.state = 'applying';
    this.error = null;
    const run = async () => {
      if (generation !== this.generation) return;
      try { await this.applyNow(snapshot, generation); }
      catch (error) {
        await this.closeSocket();
        this.active = null;
        if (generation !== this.generation) return;
        const e = error as NodeJS.ErrnoException;
        this.error = e.code === 'EADDRINUSE' ? `端口 ${snapshot.port} 已被占用`
          : e.code === 'EACCES' ? `没有权限监听端口 ${snapshot.port}` : String(e.message ?? error);
        this.state = 'error';
        this.log(`direct-access: ${this.error}`);
      }
    };
    this.queue = this.queue.then(run, run);
    return this.queue;
  }

  private async applyNow(config: DirectAccessConfig, generation: number): Promise<void> {
    if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) throw new Error('直连端口必须在 1024–65535 之间');
    if (config.port === this.mainPort) throw new Error(`端口 ${config.port} 与主端口相同，请换一个`);
    const advertised = bareOrigin(config.advertisedUrl);
    const proxyOrigin = bareOrigin(config.proxyOrigin);
    const mode = config.enabled ? 'direct' : proxyOrigin ? 'proxy' : 'off';
    const next: Applied = { config, mode, origin: config.enabled ? advertised : proxyOrigin, proxyOrigin, bindHost: config.enabled ? '0.0.0.0' : '127.0.0.1' };
    const socketChanged = !this.active || this.active.bindHost !== next.bindHost || this.active.config.port !== config.port;
    if (this.server && (mode === 'off' || socketChanged)) await this.closeSocket();
    if (generation !== this.generation) return;
    if (mode === 'off') { this.active = next; this.state = 'off'; return; }
    if (!this.server) {
      const server = http.createServer((req, res) => this.serve(req, res));
      server.requestTimeout = 0; // MCP SSE connections are intentionally long-lived.
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(config.port, next.bindHost, () => { server.off('error', reject); resolve(); });
        });
      } catch (error) { server.close(); throw error; }
      this.server = server;
      this.log(`direct-access: listening on ${next.bindHost}:${config.port}`);
    }
    // URL-only changes are hot: do not tear down MCP connections for copy metadata.
    this.active = next;
    if (generation === this.generation) this.state = 'listening';
  }

  private serve(req: http.IncomingMessage, res: http.ServerResponse): void {
    const fail = (status: number, error: string) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error }));
    };
    if (!directAccessAllowed(req.url)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('not found'); return;
    }
    const active = this.active;
    if (!active || this.state !== 'listening') { fail(503, 'direct_access_applying'); return; }
    const origin = this.originForHost(String(req.headers.host ?? ''), active);
    if (!origin) { fail(421, 'direct_origin_mismatch'); return; }
    if (req.url?.startsWith('/mcp/') && req.headers.origin !== undefined && req.headers.origin !== origin) {
      fail(403, 'origin_rejected'); return;
    }
    // Authentication still happens in each data-plane router. Never accept a
    // client-supplied proxy identity or an internal marker as evidence of origin.
    for (const name of ['cf-ray', 'cf-connecting-ip', 'x-real-ip', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'x-blackhole-public-gateway', 'x-blackhole-direct-access']) delete req.headers[name];
    this.requestOrigins.set(req, origin);
    this.app(req, res);
  }

  private originForHost(raw: string, active: Applied): string | null {
    if (!raw || /[\s,/@\\?#]/.test(raw)) return null;
    let u: URL;
    try { u = new URL(`http://${raw}`); } catch { return null; }
    const host = raw.toLowerCase();
    for (const origin of [active.origin, active.proxyOrigin]) {
      if (origin && new URL(origin).host.toLowerCase() === host) return origin;
    }
    if (active.mode !== 'direct') return null;
    // IP access needs no separate URL setting, including a user's NAT mapping.
    // Arbitrary DNS aliases must be declared, so DNS rebinding/stale ingress
    // cannot turn a foreign website into the same-origin BlackHole surface.
    const hostname = u.hostname.replace(/^\[|\]$/g, '');
    return isIP(hostname) || hostname === 'localhost' ? u.origin : null;
  }

  /** Only requests that actually passed this listener have an origin here. */
  requestOrigin(req: http.IncomingMessage): string | null { return this.requestOrigins.get(req) ?? null; }

  localPort(): number | null {
    const a = this.server?.address();
    return a && typeof a === 'object' ? a.port : null;
  }

  view(): DirectAccessView {
    const requested = this.requested;
    let origin: string | null = null, proxyOrigin: string | null = null;
    try { origin = bareOrigin(requested.advertisedUrl); proxyOrigin = bareOrigin(requested.proxyOrigin); } catch { /* error is exposed separately */ }
    const mode = requested.enabled ? 'direct' : proxyOrigin ? 'proxy' : 'off';
    const port = Number.isInteger(requested.port) && requested.port >= 1024 && requested.port <= 65535 ? requested.port : DEFAULT_DIRECT_PORT;
    const listening = this.state === 'listening' && this.server !== null;
    return {
      enabled: requested.enabled, port, state: this.state, listening, mode,
      bind_host: requested.enabled ? '0.0.0.0' : '127.0.0.1',
      target: `http://127.0.0.1:${port}`,
      origin: requested.enabled ? origin : proxyOrigin, proxy_origin: proxyOrigin,
      addresses: listening && requested.enabled ? this.addresses() : [], error: this.error,
    };
  }

  private async closeSocket(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  close(): Promise<void> { return this.apply({ ...this.requested, enabled: false, proxyOrigin: '' }); }
}
