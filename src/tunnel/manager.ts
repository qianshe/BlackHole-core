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
// Reconnect thresholds, in consecutive failed public probes (one per interval):
// - connector state unknown (no metrics server): the old 3-strike rule;
// - cloudflared reports 0 edge connections: 3 for named, 5 for quick, since a
//   quick reconnect throws away the URL while cloudflared may still heal itself;
// - cloudflared reports live connections but the edge still fails: a Cloudflare-side
//   problem a restart rarely fixes, so only after a long streak.
const HEALTH_FAILURE_THRESHOLD = 3;
const QUICK_DOWN_THRESHOLD = 5;
const EDGE_ONLY_THRESHOLD = 10;
const READY_TIMEOUT_MS = 2_000;
// cloudflared >= 2024.12 always starts its metrics server and prints this line.
const METRICS_RE = /Starting metrics server on (\S+?)\/metrics/i;
// Connection lifecycle lines worth keeping in the daemon log to explain a drop.
const CONNECTOR_EVENT_RE = /Registered tunnel connection|Unregistered tunnel connection|Connection terminated|Retrying connection|Serve tunnel error|Lost connection|fallback protocol|failed to (?:dial|serve|connect)/i;
const CONNECTOR_LOG_PER_MIN = 20;
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
/**
 * One-line description of an HTTP answer that is not BlackHole. Error pages are HTML
 * (Cloudflare's 530 page starts with <!doctype html>): never show markup, only the
 * status and, for Cloudflare, what its error code means.
 */
export function describeHttpFailure(status: number, body: string): string {
  const cf = /(?:Error|error code)[^0-9]{0,20}(10\d\d|52\d)\b/.exec(body)?.[1];
  if (status === 530 || cf === '1033') return `Cloudflare 找不到隧道连接器（HTTP ${status}${cf ? ` / ${cf}` : ''}）`;
  if (status === 502 || cf === '502') return `Cloudflare 连不上本机服务（HTTP ${status}）`;
  if (/^\s*</.test(body) || !body.trim()) return `HTTP ${status}${cf ? ` / Cloudflare ${cf}` : ''}`;
  return `HTTP ${status}（${body.replace(/\s+/g, ' ').trim().slice(0, 60)}）`;
}

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
          detail: describeHttpFailure(res.status, text),
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

/**
 * Status note when only this machine's self-probe failed (DNS/reset/timeout): the connector
 * is registered, so the channel stays online and is never rotated for it.
 */
function selfProbeNote(f: Exclude<ProbeFailure, { ok: true }>): string {
  const what = f.kind === 'dns' ? `本机暂时解析不了公网域名（${f.detail}）`
    : f.kind === 'reset' ? `本机检测公网地址被中断（${f.detail}）`
      : `本机检测公网地址失败（${f.detail}）`;
  const hint = f.kind === 'reset' ? '使用 Clash 等本机代理时，可在 高级设置 →「公网连通性检测代理」填写代理地址。' : '';
  return `在线，但${what}。连接器正常，通常无需处理。${hint}`;
}

/** Connector state from cloudflared's own /ready: true = ≥1 edge connection, false = none, null = unknown. */
export type ConnectorReady = boolean | null;

async function checkReady(readyUrl: string): Promise<ConnectorReady> {
  try {
    const res = await fetch(readyUrl, { signal: AbortSignal.timeout(READY_TIMEOUT_MS) });
    await res.text().catch(() => '');
    // readiness.go: 200 iff ≥1 active edge connection, 503 iff none.
    return res.status === 200 ? true : res.status === 503 ? false : null;
  } catch {
    return null;
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
  /** Test seam; production asks cloudflared's metrics server (`/ready`). */
  readyCheck?: (readyUrl: string) => Promise<ConnectorReady>;
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
  /** cloudflared's /ready URL for the current child, parsed from its startup log. */
  private readyUrl?: string;
  /** Last reported connector state, logged only when it changes. */
  private lastReady: ConnectorReady = null;
  private connectorLogWindow = { start: 0, count: 0 };
  /** Set when a quick tunnel was rotated by auto-reconnect: the new URL must be re-shared. */
  private rotatedNotice?: string;

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
    this.readyUrl = undefined;
    this.lastReady = null;
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
          if (this.child === child) this.observeConnectorLine(rawLine);
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
                this.setStatus('online', this.rotatedNotice ? { reason: this.rotatedNotice, url_changed: true } : {});
                this.startHealthMonitor(child);
              } else if (verified.kind === 'http' && verified.status === 404) {
                this.child = undefined;
                this._url = undefined;
                this._kind = undefined;
                this.setStatus('error', {
                  reason: `${url} 一直返回 404：连接器正常，但 Cloudflare 没有把流量转进隧道（Cloudflare 侧故障）。稍后重试，或改用持久渠道。`,
                });
                void this.terminateChild(child).finally(() => isolatedConfig?.cleanup());
              } else if (verified.kind !== 'http') {
                // cloudflared only prints a Quick Tunnel URL after the connector
                // has registered. DNS/reset/timeout here describe this machine's
                // self-probe path, not connector health, so keep the channel online.
                this.setStatus('online', { reason: selfProbeNote(verified) });
                this.startHealthMonitor(child);
              } else {
                // An HTTP response proves the public edge was reached, so an
                // unexpected response is a meaningful routing-health signal.
                this.setStatus('unverified', {
                  reason: `公网地址已生成，但访问返回 ${verified.detail}。继续检测，持续异常会自动重连。`,
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
          this.rotatedNotice = undefined;
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

  /** Records cloudflared's metrics address and logs connection lifecycle lines (rate-limited). */
  private observeConnectorLine(rawLine: string): void {
    const m = METRICS_RE.exec(rawLine);
    if (m) {
      const addr = (m[1] ?? '').replace(/^0\.0\.0\.0:/, '127.0.0.1:').replace(/^\[::\]:/, '127.0.0.1:');
      this.readyUrl = `http://${addr}/ready`;
    }
    if (!CONNECTOR_EVENT_RE.test(rawLine)) return;
    const now = Date.now();
    if (now - this.connectorLogWindow.start > 60_000) this.connectorLogWindow = { start: now, count: 0 };
    if (++this.connectorLogWindow.count > CONNECTOR_LOG_PER_MIN) return;
    // Drop cloudflared's own timestamp; the line itself stays verbatim (no secrets in these lines).
    this.opts.log(`cloudflared: ${rawLine.replace(/^\S+Z\s+/, '').slice(0, 300)}`);
  }

  private async connectorReady(): Promise<ConnectorReady> {
    if (!this.readyUrl) return null;
    return (this.opts.readyCheck ?? checkReady)(this.readyUrl);
  }

  private async handleHealthResult(result: ProbeFailure, child: ChildProcess): Promise<void> {
    if (this.child !== child || !this._url || this.stopping || this.reconnecting) return;
    if (result.ok) {
      this.healthFailures = 0;
      this.reconnectAttempt = 0;
      this.lastReady = null;
      if (this._status === 'unverified' || this._reason !== this.rotatedNotice) {
        this.setStatus('online', this.rotatedNotice ? { reason: this.rotatedNotice, url_changed: true } : {});
      }
      return;
    }

    if (result.kind !== 'http') {
      // DNS/reset/timeout only prove that this machine cannot complete the self-probe.
      // They do not prove the cloudflared connector itself is unhealthy, so keep
      // the connector online and never rotate a possibly-good public URL for them.
      this.healthFailures = 0;
      this.setStatus('online', { reason: selfProbeNote(result) });
      return;
    }

    this.healthFailures += 1;
    // The edge answered with an error: ask cloudflared whether it still holds edge connections.
    const ready = await this.connectorReady();
    if (this.child !== child || !this._url || this.stopping || this.reconnecting) return;
    if (ready !== this.lastReady) {
      this.lastReady = ready;
      this.opts.log(`tunnel: public probe failed (${result.detail}); connector ${ready === true ? 'has live edge connections' : ready === false ? 'has 0 edge connections' : 'state unknown'}`);
    }
    const kind = this._kind;
    if (!kind) return;
    const threshold = this.opts.healthFailureThreshold
      ?? (ready === true ? EDGE_ONLY_THRESHOLD : ready === false && kind === 'quick' ? QUICK_DOWN_THRESHOLD : HEALTH_FAILURE_THRESHOLD);
    if (this.healthFailures < threshold) {
      // 单次失败多半是抖动：连接器没报告断开时，第一次失败不改状态，连续失败或确认断开才显示未验证。
      if (this.healthFailures === 1 && ready !== false) return;
      this.setStatus('unverified', {
        reason: ready === true
          ? `连接器在线，但公网访问返回 ${result.detail}（Cloudflare 侧）。继续检测，暂不重连。`
          : ready === false
            ? `连接器与 Cloudflare 断开，等待 cloudflared 自动恢复（第 ${this.healthFailures}/${threshold} 次检测）。`
            : `公网地址访问返回 ${result.detail}。继续检测，持续异常会自动重连。`,
      });
      return;
    }
    this.scheduleReconnect(kind, result, ready);
  }

  private scheduleReconnect(kind: TunnelKind, failure: Exclude<ProbeFailure, { ok: true }>, ready: ConnectorReady = null): void {
    if (this.reconnecting || this.stopping || !this.child) return;
    this.reconnecting = true;
    this.stopHealthMonitor();
    this.reconnectAttempt += 1;
    const base = this.opts.reconnectBackoffBaseMs ?? RECONNECT_BACKOFF_BASE_MS;
    const max = this.opts.reconnectBackoffMaxMs ?? RECONNECT_BACKOFF_MAX_MS;
    const delay = Math.min(max, base * 2 ** Math.min(this.reconnectAttempt - 1, 6));
    this.setStatus('starting', {
      reason: `${ready === false ? '连接器与 Cloudflare 断开，' : ''}公网地址连续 ${this.healthFailures} 次不可用（${failure.detail}），${Math.ceil(delay / 1000)} 秒后自动重连${kind === 'quick' ? '；临时地址会更换' : ''}`,
      reconnecting: true,
      reconnect_attempt: this.reconnectAttempt,
    });

    this.opts.log(`tunnel: reconnecting ${kind} channel after ${this.healthFailures} failed probes (${failure.detail}; connector ${ready === true ? 'live' : ready === false ? 'down' : 'unknown'})`);
    if (kind === 'quick') this.rotatedNotice = '临时公网地址已更换：手机需重新扫码，网页 AI 需更新 MCP 地址。';
    const child = this.child;
    this.child = undefined;
    this._url = undefined;
    this.readyUrl = undefined;
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
    this.rotatedNotice = undefined;
    this.setStatus('off');
    if (!child || child.exitCode !== null) return;
    await this.terminateChild(child);
  }
}
