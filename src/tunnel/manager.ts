import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetch as undiciFetch, ProxyAgent } from 'undici';
import { cloudflaredInstallHint } from './install-guide.js';

export type TunnelStatus = 'off' | 'starting' | 'online' | 'unverified' | 'error' | 'unavailable';
export type TunnelKind = 'quick' | 'named';

const TRYCLOUDFLARE_RE = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i;
const NAMED_READY_RE = /registered tunnel connection/i;
const URL_TIMEOUT_MS = 25_000;
const PROBE_TIMEOUT_MS = 4_000;
const PROBE_TRIES = 4;
// Public self-probes are a coarse routing-health signal, not the extension heartbeat.
// Keep the local 10s heartbeat/45s watchdog responsive while avoiding 8,640 edge
// requests per day from an otherwise healthy always-on tunnel.
const HEALTH_CHECK_INTERVAL_MS = 60_000;
const HEALTH_FAILURE_THRESHOLD = 3;
const RECONNECT_BACKOFF_BASE_MS = 5_000;
const RECONNECT_BACKOFF_MAX_MS = 120_000;

type TemporaryConfig = {
  path: string;
  cleanup: () => void;
};

/**
 * Quick tunnels must not inherit a user's named-tunnel ingress rules.
 * Keep the empty config private to this connector and remove it after the
 * child exits so named-tunnel configuration remains untouched.
 */
function createQuickTunnelConfig(): TemporaryConfig {
  const directory = mkdtempSync(join(tmpdir(), 'blackhole-quick-tunnel-'));
  const path = join(directory, 'config.yml');
  writeFileSync(path, '{}\n', { encoding: 'utf8', mode: 0o600 });
  let cleaned = false;
  return {
    path,
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup; the next start uses a fresh isolated directory.
      }
    },
  };
}

/** Failure mode of the public-URL probe, for honest error messages. */
export type ProbeFailure =
  | { ok: true }
  | { ok: false; kind: 'dns' | 'http' | 'reset' | 'timeout' | 'other'; status?: number; detail: string };

/**
 * Best-effort check that the public URL actually routes back to us.
 * Returns a failure classification instead of a bare boolean so the error
 * message can tell DNS poisoning, upstream edge failure, and real routing
 * issues apart — "wrong local port" is only one of several causes and
 * claiming it for every failure misled users during the 2026-09
 * trycloudflare.com outage (edge answered 404 for every quick tunnel
 * while the connector looked perfectly healthy).
 *
 * `proxy` routes the probe through a local HTTP proxy (undici ProxyAgent).
 * Reason: on machines whose outbound traffic is captured by a TUN/fake-ip
 * proxy (Clash/mihomo etc.), the daemon's direct fetch to the public URL
 * is intermittently RST'd by that link even though the tunnel itself is
 * healthy — the named channel works while every quick probe dies with
 * ECONNRESET (seen 2026-09-08). Going through the proxy's own egress
 * sidesteps that.
 */
async function probePublicUrl(base: string, proxy?: string): Promise<ProbeFailure> {
  if (proxy && !/^https?:\/\//i.test(proxy)) {
    return { ok: false, kind: 'other', detail: `probe proxy must be an http(s) URL, got: ${proxy}` };
  }
  const dispatcher: ProxyAgent | undefined = proxy ? new ProxyAgent(proxy) : undefined;
  try {
    let last: ProbeFailure = { ok: false, kind: 'other', detail: 'no response' };
    for (let i = 0; i < PROBE_TRIES; i++) {
      try {
        const res = dispatcher
          ? await undiciFetch(`${base}/`, { redirect: 'error', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), dispatcher })
          : await fetch(`${base}/`, { redirect: 'error', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        const text = await res.text();
        if (text.includes('blackhole')) return { ok: true };
        last = {
          ok: false,
          kind: 'http',
          status: res.status,
          detail: `edge answered ${res.status}${text ? ` (${text.slice(0, 60)})` : ''}`,
        };
      } catch (e) {
        const code = (e as { cause?: { code?: string } })?.cause?.code ?? '';
        last = /ENOTFOUND|EAI_AGAIN/.test(code)
          ? { ok: false, kind: 'dns', detail: `cannot resolve the public hostname locally (${code})` }
          : /ECONNRESET|EPIPE|ECONNABORTED/.test(code)
            ? { ok: false, kind: 'reset', detail: code }
            : { ok: false, kind: 'timeout', detail: code || (e instanceof Error ? e.message.slice(0, 60) : String(e).slice(0, 60)) };
      }
      if (i < PROBE_TRIES - 1) await new Promise((r) => setTimeout(r, 700));
    }
    return last;
  } finally {
    try {
      await dispatcher?.close();
    } catch {
      /* best-effort cleanup */
    }
  }
}

export interface TunnelOptions {
  enabled: boolean;
  bin?: string;
  /** Public URL served by the named tunnel (BLACKHOLE_PUBLIC_URL). */
  namedUrl?: string;
  /** cloudflared named tunnel name for the persistent channel. */
  tunnelName?: string;
  /** Local HTTP proxy (http://host:port) for the public-URL probe (BLACKHOLE_TUNNEL_PROBE_PROXY). */
  probeProxy?: string;
  /** Test seam; production uses the real public-URL probe. */
  probe?: (base: string, proxy?: string) => Promise<ProbeFailure>;
  /** Test seams for keeping recovery tests deterministic. */
  healthCheckIntervalMs?: number;
  healthFailureThreshold?: number;
  reconnectBackoffBaseMs?: number;
  reconnectBackoffMaxMs?: number;
  spawnProcess?: typeof spawn;
  onEvent: (status: TunnelStatus, detail: Record<string, unknown>) => void;
  log: (line: string) => void;
}

/**
 * The public channel, started strictly on demand (boot never spawns it — the
 * user chooses persistent vs temporary from the extension or the CLI; channels
 * are mutually exclusive, so the current one must be stopped before starting another).
 * - quick: one shared cloudflared quick tunnel, random URL per start.
 * - named: `cloudflared tunnel run <name>` serving `namedUrl`; survives
 *   daemon restarts when run as an external service, and starting it here is
 *   harmless alongside external instances.
 */
export class TunnelManager {
  private child?: ChildProcess;
  private _status: TunnelStatus = 'off';
  private _url?: string;
  private _kind?: TunnelKind;
  private _reason?: string;
  private stopping = false;
  private healthTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private healthProbeInFlight = false;
  private healthFailures = 0;
  private reconnectAttempt = 0;
  private reconnecting = false;

  constructor(
    private port: number,
    private opts: TunnelOptions,
  ) {}

  get status(): TunnelStatus {
    return this._status;
  }

  get url(): string | undefined {
    return this._url;
  }

  get mode(): TunnelKind | undefined {
    return this._kind;
  }

  get reason(): string | undefined {
    return this._reason;
  }

  private setStatus(status: TunnelStatus, detail: Record<string, unknown> = {}): void {
    const nextReason = typeof detail.reason === 'string' ? detail.reason : undefined;
    if (this._status === status && this._reason === nextReason) return;
    this._status = status;
    this._reason = nextReason;
    this.opts.onEvent(status, { url: this._url ?? null, kind: this._kind ?? null, ...detail });
  }

  /**
   * Validate and kick off a channel start; returns immediately. Synchronous
   * problems (disabled, missing named URL, cloudflared not runnable) settle
   * the status before returning; the actual connection completes in the
   * background and is observed through `status` polling.
   */
  start(kind: TunnelKind = 'quick'): void {
    if (this.child) {
      // Channels are strictly mutually exclusive. Starting while any connector
      // is live is always a no-op; the operator must stop it first, then choose
      // quick or named explicitly.
      return;
    }
    if (!this.opts.enabled) {
      this.setStatus('off', { reason: '公网渠道当前已关闭。请在 BlackHole 设置的「公网渠道」中启用后重试。' });
      return;
    }
    if (kind === 'named' && !this.opts.namedUrl) {
      this.setStatus('unavailable', { reason: '启动持久渠道前，请先在 BlackHole 设置的「公网渠道 → 公网地址」填写已绑定到 Cloudflare Tunnel 的固定 HTTPS 地址。' });
      return;
    }
    const bin = this.opts.bin ?? 'cloudflared';
    // Production validates the configured binary before changing state. Tests
    // that inject spawnProcess already own process creation and must not escape
    // the seam through a real spawnSync preflight.
    if (!this.opts.spawnProcess) {
      try {
        const probe = spawnSync(bin, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
        if (probe.error || probe.status !== 0) {
          const detail = probe.error?.message ?? `exit ${probe.status}`;
          this.setStatus('unavailable', {
            reason: `找不到可用的 cloudflared（${detail}）。${cloudflaredInstallHint()}`,
          });
          return;
        }
      } catch (e) {
        this.setStatus('unavailable', { reason: e instanceof Error ? e.message : String(e) });
        return;
      }
    }
    this._kind = kind;
    this.setStatus('starting');
    void this.doStart(kind, bin);
  }

  private async doStart(kind: TunnelKind, bin: string): Promise<void> {
    let isolatedConfig: TemporaryConfig | undefined;
    let child: ChildProcess;
    try {
      isolatedConfig = kind === 'quick' ? createQuickTunnelConfig() : undefined;
      const args =
        kind === 'named'
          ? ['tunnel', '--no-autoupdate', 'run', this.opts.tunnelName ?? 'blackhole']
          : ['tunnel', '--config', isolatedConfig!.path, '--no-autoupdate', '--url', `http://127.0.0.1:${this.port}`];
      child = (this.opts.spawnProcess ?? spawn)(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      isolatedConfig?.cleanup();
      this._url = undefined;
      this._kind = undefined;
      this.setStatus('error', { reason: e instanceof Error ? e.message : String(e) });
      return;
    }
    this.child = child;
    this.stopping = false;
    let lastError: string | undefined;
    let startupProbeStarted = false;

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (this.child === child) {
          this.child = undefined;
          this._url = undefined;
          this._kind = undefined;
          this.setStatus('error', { reason: `timed out waiting for ${kind} tunnel URL${lastError ? `: ${lastError}` : ''}` });
          void this.terminateChild(child).finally(() => isolatedConfig?.cleanup());
        }
        resolve();
      }, URL_TIMEOUT_MS);
      timer.unref();

      const onData = async (buf: Buffer): Promise<void> => {
        for (const rawLine of buf.toString('utf8').split(/\r?\n/)) {
          if (!rawLine) continue;
          if (/\b(ERR|error|failed|fatal)\b/i.test(rawLine)) {
            lastError = rawLine.slice(0, 400);
            continue;
          }
          const url = kind === 'quick' ? TRYCLOUDFLARE_RE.exec(rawLine)?.[0] : NAMED_READY_RE.test(rawLine) ? this.opts.namedUrl : undefined;
          if (!url) continue;
          if (!startupProbeStarted && this._status === 'starting' && this.child === child) {
            startupProbeStarted = true;
            this._url = url;
            // URL printed ≠ traffic flowing: probe the public URL before
            // declaring online (lesson from codex-with-chatgpt). An unverified
            // edge must NOT read 'online' — that's how a wrong ingress port
            // used to hide behind a green light.
            const verified = await (this.opts.probe ?? probePublicUrl)(url, this.opts.probeProxy);
            if (this._status === 'starting' && this.child === child) {
              clearTimeout(timer);
              if (verified.ok) {
                this.setStatus('online');
                this.startHealthMonitor(child);
              } else if (verified.kind === 'http' && verified.status === 404) {
                this.child = undefined;
                this._url = undefined;
                this._kind = undefined;
                this.setStatus('error', {
                  reason: `${url} 一直返回 404 —— 连接器本身是健康的（已注册、请求有到达），但公网边缘没有把流量路由进隧道（Cloudflare 侧故障的典型特征，非本机配置问题）。稍后重试，或改用命名隧道。`,
                });
                void this.terminateChild(child).finally(() => isolatedConfig?.cleanup());
              } else if (verified.kind !== 'http') {
                // cloudflared only prints a Quick Tunnel URL after the connector
                // has registered. DNS/reset/timeout here describe this machine's
                // self-probe path, not connector health, so keep the channel online.
                const cause = verified.kind === 'reset'
                  ? `本机无法完成公网地址检测，连接被中途重置（${verified.detail}；常见于 Clash、mihomo 等本机代理环境）`
                  : verified.kind === 'dns'
                    ? `本机无法解析刚生成的公网域名（${verified.detail}）`
                    : `本机暂时无法完成公网地址检测（${verified.detail}）`;
                this.setStatus('online', {
                  reason: `${cause}；临时公网地址已经生成，cloudflared 连接器仍保持在线，因此不会仅凭本机检测失败判定渠道离线。通常无需处理；如果你的电脑使用了 Clash、mihomo 等本机代理，并希望继续检测公网地址，请到 BlackHole 设置 → 高级设置 →「公网连通性检测代理（排障用）」填写本机 HTTP 代理地址。`,
                });
                this.startHealthMonitor(child);
              } else {
                // An HTTP response proves the public edge was reached, so an
                // unexpected response is a meaningful routing-health signal.
                this.setStatus('unverified', {
                  reason: `${url} 已注册，但 Cloudflare 边缘返回 HTTP ${verified.status ?? '错误'}（${verified.detail}）。渠道保持运行并继续探测；若持续异常会自动重连。`,
                });
                this.startHealthMonitor(child);
              }
              resolve();
            }
          }
        }
      };
      child.stdout?.on('data', (b) => void onData(b));
      child.stderr?.on('data', (b) => void onData(b));

      child.once('exit', (code) => {
        clearTimeout(timer);
        isolatedConfig?.cleanup();
        const current = this.child === child;
        if (current) {
          this.child = undefined;
          this._url = undefined;
          this._kind = undefined;
          this.stopHealthMonitor();
          this.setStatus(this.stopping ? 'off' : 'error', {
            reason: `cloudflared exited with code ${code}${lastError && !this.stopping ? `: ${lastError}` : ''}`,
          });
        }
        resolve();
      });
      child.once('error', (e) => {
        clearTimeout(timer);
        isolatedConfig?.cleanup();
        const current = this.child === child;
        if (current) {
          this.child = undefined;
          this._url = undefined;
          this._kind = undefined;
          this.stopHealthMonitor();
          this.setStatus('error', { reason: e.message });
        }
        resolve();
      });
    });
  }

  private startHealthMonitor(child: ChildProcess): void {
    this.stopHealthMonitor();
    this.healthFailures = 0;
    this.healthProbeInFlight = false;
    const interval = this.opts.healthCheckIntervalMs ?? HEALTH_CHECK_INTERVAL_MS;
    this.healthTimer = setInterval(() => {
      if (this.healthProbeInFlight || this.child !== child || !this._url || this.reconnecting || this.stopping) return;
      this.healthProbeInFlight = true;
      void (this.opts.probe ?? probePublicUrl)(this._url, this.opts.probeProxy)
        .then((result) => this.handleHealthResult(result, child))
        .catch((error) => this.handleHealthResult({ ok: false, kind: 'other', detail: error instanceof Error ? error.message : String(error) }, child))
        .finally(() => {
          this.healthProbeInFlight = false;
        });
    }, interval);
    this.healthTimer.unref();
  }

  private stopHealthMonitor(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = undefined;
    this.healthProbeInFlight = false;
  }

  private handleHealthResult(result: ProbeFailure, child: ChildProcess): void {
    if (this.child !== child || !this._url || this.stopping || this.reconnecting) return;
    if (result.ok) {
      this.healthFailures = 0;
      this.reconnectAttempt = 0;
      if (this._status === 'unverified' || this._reason) this.setStatus('online');
      return;
    }

    if (result.kind !== 'http') {
      // DNS/reset/timeout only prove that this machine cannot complete the self-probe.
      // They do not prove the cloudflared connector itself is unhealthy, so keep
      // the connector online and never rotate a possibly-good public URL for them.
      this.healthFailures = 0;
      this.setStatus('online', { reason: `本机暂时无法检测公网地址（${result.detail}），但 cloudflared 连接器仍保持在线，不会因此自动重连。通常无需处理；如本机代理影响检测，可在 BlackHole 设置 → 高级设置 →「公网连通性检测代理（排障用）」中填写本机 HTTP 代理地址。` });
      return;
    }

    this.healthFailures += 1;
    const threshold = this.opts.healthFailureThreshold ?? HEALTH_FAILURE_THRESHOLD;
    if (this.healthFailures < threshold) return;

    const kind = this._kind;
    if (!kind) return;
    this.scheduleReconnect(kind, result);
  }

  private scheduleReconnect(kind: TunnelKind, failure: Exclude<ProbeFailure, { ok: true }>): void {
    if (this.reconnecting || this.stopping || !this.child) return;
    this.reconnecting = true;
    this.stopHealthMonitor();
    this.reconnectAttempt += 1;
    const base = this.opts.reconnectBackoffBaseMs ?? RECONNECT_BACKOFF_BASE_MS;
    const max = this.opts.reconnectBackoffMaxMs ?? RECONNECT_BACKOFF_MAX_MS;
    const delay = Math.min(max, base * 2 ** Math.min(this.reconnectAttempt - 1, 6));
    this.setStatus('starting', {
      reason: `公网探测连续 ${this.healthFailures} 次失败（${failure.detail}），${Math.ceil(delay / 1000)} 秒后自动重连`,
      reconnecting: true,
      reconnect_attempt: this.reconnectAttempt,
    });

    const child = this.child;
    this.child = undefined;
    this._url = undefined;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.stopping || this.child || this._kind !== kind) {
        this.reconnecting = false;
        return;
      }
      this.reconnecting = false;
      this.start(kind);
    }, delay);
    this.reconnectTimer.unref();
    void this.terminateChild(child);
  }

  private async terminateChild(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      child.once('exit', finish);
      try {
        child.kill();
      } catch {
        finish();
        return;
      }
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        finish();
      }, 3000).unref();
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.stopHealthMonitor();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.reconnecting = false;
    const child = this.child;
    this.child = undefined;
    this._url = undefined;
    this._kind = undefined;
    this.setStatus('off');
    if (!child || child.exitCode !== null) return;
    await this.terminateChild(child);
  }
}
