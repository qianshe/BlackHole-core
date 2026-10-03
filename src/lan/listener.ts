// 局域网直连：可选的第二个监听器，绑定 0.0.0.0，给另一台服务器上的 agent 直接用 MCP。
// 只把 MCP 端点转进同一个 app，其余路径（控制接口、本地 Web、Courier、面板、bh.py）一律 404；
// 主监听器始终只在 127.0.0.1 上，它同时是单实例锁。默认关闭，由用户在设置里打开。
import http from 'node:http';
import os from 'node:os';

export const DEFAULT_LAN_PORT = 7307;
/** 局域网监听器只放行 /mcp/<令牌>（含查询串）：这里的使用者是支持 MCP 的 agent，不需要 bh.py。 */
const LAN_PATH = /^\/mcp\/[^/?#]+(?:[?#].*)?$/;

export function lanAllowed(url: string | undefined): boolean {
  return typeof url === 'string' && LAN_PATH.test(url);
}

/** 本机可供其他机器访问的 IPv4 地址（排除回环和链路本地地址）。 */
export function lanAddresses(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string[] {
  const out: string[] = [];
  for (const list of Object.values(ifaces)) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push(a.address);
    }
  }
  return [...new Set(out)];
}

export interface LanView {
  enabled: boolean;
  port: number;
  listening: boolean;
  error: string | null;
  addresses: string[];
}

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

export class LanListener {
  private server: http.Server | null = null;
  private enabled = false;
  private port = DEFAULT_LAN_PORT;
  private error: string | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly app: Handler,
    private readonly mainPort: number,
    private readonly log: (line: string) => void = () => {},
    private readonly host = '0.0.0.0',
  ) {}

  /** 按设置开/关/换端口；多次调用按顺序执行。监听失败只记录错误，不影响守护进程。 */
  apply(enabled: boolean, port: number): Promise<void> {
    this.queue = this.queue.then(() => this.applyNow(enabled, port)).catch(() => {});
    return this.queue;
  }

  private async applyNow(enabled: boolean, port: number): Promise<void> {
    this.enabled = enabled;
    this.port = port;
    this.error = null;
    const current = this.server?.address();
    const boundPort = current && typeof current === 'object' ? current.port : null;
    if (this.server && (!enabled || boundPort !== port)) await this.closeServer();
    if (!enabled || this.server) return;
    if (port === this.mainPort) {
      this.error = `端口 ${port} 与主端口相同，请换一个`;
      return;
    }
    const server = http.createServer((req, res) => {
      if (!lanAllowed(req.url)) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found');
        return;
      }
      this.app(req, res);
    });
    server.requestTimeout = 0; // MCP 的 GET 是长连接 SSE，不能被默认 5 分钟上限切断
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, this.host, () => { server.off('error', reject); resolve(); });
      });
      this.server = server;
      this.log(`lan: listening on ${this.host}:${port} (MCP only)`);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      this.error = code === 'EADDRINUSE' ? `端口 ${port} 已被占用` : code === 'EACCES' ? `没有权限监听端口 ${port}` : String((e as Error).message ?? e);
      this.log(`lan: cannot listen on ${this.host}:${port}: ${this.error}`);
    }
  }

  private async closeServer(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (!s) return;
    s.closeAllConnections?.();
    await new Promise<void>((resolve) => s.close(() => resolve()));
    this.log('lan: stopped');
  }

  /** 正在监听的端口；没开时为 null。用来认出经局域网监听器进来的请求。 */
  localPort(): number | null {
    const a = this.server?.address();
    return a && typeof a === 'object' ? a.port : null;
  }

  view(): LanView {
    return { enabled: this.enabled, port: this.port, listening: !!this.server, error: this.error, addresses: this.server ? lanAddresses() : [] };
  }

  close(): Promise<void> {
    this.queue = this.queue.then(() => this.closeServer()).catch(() => {});
    return this.queue;
  }
}
