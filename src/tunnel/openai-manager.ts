import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CredentialStoreError, type OpenAITunnelCredentialStore } from './openai-credential.js';
import { verifyOpenAITunnelClient } from './openai-tunnel-install.js';

/**
 * OpenAI Secure MCP Tunnel runtime manager (plan §5): an independent subsystem
 * next to the Cloudflare TunnelManager. It never touches cloudflared, the
 * public URL or daemon-wide state; each explicit start owns one run.
 */
export type OpenAITunnelStatus = 'off' | 'starting' | 'ready' | 'recovering' | 'stopping' | 'error' | 'unavailable';

/** Runtime validator in tunnel-client: `tunnel_` + 32 lowercase hex characters. */
export const OPENAI_TUNNEL_ID_PATTERN = /^tunnel_[0-9a-f]{32}$/;

export interface OpenAITunnelView {
  status: OpenAITunnelStatus;
  run_id: string | null;
  active_tunnel_id: string | null;
  /** null = the credential store could not be read; never reported as "not set". */
  credential_configured: boolean | null;
  credential_revision: number;
  pending_restart: boolean;
  reason_code: string | null;
  reason: string | null;
  client_version: string | null;
  started_at: string | null;
  ready_at: string | null;
}

export class OpenAITunnelError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
    this.name = 'OpenAITunnelError';
  }
}

interface SettingsSnapshot { revision: number; values: { openaiTunnelClientPath?: string; openaiTunnelId?: string } }

interface RunSnapshot {
  runId: string;
  clientPath: string;
  clientVersion: string;
  tunnelId: string;
  settingsRevision: number;
  credentialRevision: number;
  apiKey: string;
  target: string;
}

interface Timing {
  urlFileTimeoutMs: number;
  readyTimeoutMs: number;
  pollMs: number;
  monitorMs: number;
  restartDelaysMs: number[];
  killGraceMs: number;
}

export interface OpenAITunnelManagerOptions {
  settings: () => SettingsSnapshot | undefined;
  credential: OpenAITunnelCredentialStore;
  /** Loopback MCP URL (host:port + machine token path) for this daemon. */
  target: () => string;
  log: (line: string) => void;
  onEvent?: (status: OpenAITunnelStatus, detail: Record<string, unknown>) => void;
  spawnProcess?: typeof spawn;
  verifyClient?: (file: string) => Promise<string>;
  fetchHealth?: (url: string) => Promise<{ status: number; body: string }>;
  runDirRoot?: string;
  timing?: Partial<Timing>;
  /** Source of pass-through system/proxy variables (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_TIMING: Timing = {
  urlFileTimeoutMs: 20_000,
  readyTimeoutMs: 90_000,
  pollMs: 500,
  monitorMs: 10_000,
  restartDelaysMs: [2_000, 5_000, 15_000],
  killGraceMs: 3_000,
};

/** Codes that need a human: restarting would only repeat the failure (plan §5.4). */
const DETERMINISTIC = new Set(['auth_failed', 'permission_denied', 'tunnel_not_found', 'config_invalid']);

const REASONS: Record<string, string> = {
  tunnel_id_missing: '请先填写并保存 Tunnel ID。',
  tunnel_id_invalid: 'Tunnel ID 格式不正确（应为 tunnel_ 加 32 位小写十六进制）。',
  client_missing: '尚未安装 tunnel-client；请先点击“一键安装”。',
  client_invalid: 'tunnel-client 校验失败；请重新安装或检查路径。',
  credential_missing: '尚未保存 Runtime API Key。',
  credential_store_unavailable: '无法读取本机保存的 Runtime API Key。',
  spawn_failed: '无法启动 tunnel-client 进程。',
  auth_failed: 'OpenAI 拒绝了 Runtime API Key（401）；请检查后重新保存密钥。',
  permission_denied: '密钥缺少 Tunnels Read/Use 权限，或 Tunnel 未关联当前组织（403）。',
  tunnel_not_found: '找不到该 Tunnel ID；请在 Platform 隧道设置中核对。',
  config_invalid: 'tunnel-client 拒绝了当前配置；请查看诊断。',
  network_failed: '无法连接 OpenAI 控制面（网络或代理问题）。',
  not_ready_timeout: 'tunnel-client 长时间未就绪；已停止，请查看诊断。',
  not_ready: 'tunnel-client 暂未就绪，正在等待恢复。',
  exited: 'tunnel-client 意外退出，重试次数已用完。',
  credential_pending_restart: 'Runtime API Key 已更改；请重新启动 OpenAI 渠道。',
};

const PASS_ENV = ['SystemRoot', 'windir', 'ComSpec', 'PATH', 'Path', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'ProgramData',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR'];

export function classifyLog(text: string): string | null {
  if (/\b401\b|unauthori[sz]ed|invalid[_ ]api[_ ]key|incorrect api key/i.test(text)) return 'auth_failed';
  if (/\b403\b|forbidden|permission denied|insufficient[_ ]permissions?/i.test(text)) return 'permission_denied';
  if (/tunnel[^\n]{0,40}not[_ ]found|\b404\b[^\n]{0,60}tunnel/i.test(text)) return 'tunnel_not_found';
  if (/invalid[^\n]{0,30}(tunnel[_ ]?id|config)|validator|is required/i.test(text)) return 'config_invalid';
  if (/no such host|dial tcp|i\/o timeout|connection refused|tls handshake|proxyconnect|context deadline exceeded/i.test(text)) return 'network_failed';
  return null;
}

const LOOPBACK_BASE = /^http:\/\/(?:127\.0\.0\.1|\[::1\]):(\d{1,5})\/?$/;

const defaultFetchHealth = async (url: string): Promise<{ status: number; body: string }> => {
  const res = await fetch(url, { signal: AbortSignal.timeout(2_000), redirect: 'error' });
  const body = (await res.text()).slice(0, 16_384);
  return { status: res.status, body };
};

export class OpenAITunnelManager {
  private _status: OpenAITunnelStatus = 'off';
  private reasonCode: string | null = null;
  private reasonText: string | null = null;
  private snapshot?: RunSnapshot;
  private child?: ChildProcess;
  private attempt = 0;
  private restarts = 0;
  private runDir?: string;
  private healthBase?: string;
  private startedAt: string | null = null;
  private readyAt: string | null = null;
  private credRevision = 1;
  private configured: boolean | null = null;
  private stopGen = 0;
  private timers = new Set<NodeJS.Timeout>();
  private logLines: string[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private readonly timing: Timing;

  constructor(private readonly opts: OpenAITunnelManagerOptions) {
    this.timing = { ...DEFAULT_TIMING, ...opts.timing };
    void this.refreshConfigured();
  }

  get status(): OpenAITunnelStatus { return this._status; }
  get credentialRevision(): number { return this.credRevision; }
  get live(): boolean { return this._status === 'starting' || this._status === 'ready' || this._status === 'recovering'; }

  view(): OpenAITunnelView {
    return {
      status: this._status,
      run_id: this.snapshot?.runId ?? null,
      active_tunnel_id: this.snapshot?.tunnelId ?? null,
      credential_configured: this.configured,
      credential_revision: this.credRevision,
      pending_restart: this.pendingRestart(),
      reason_code: this.reasonCode,
      reason: this.reasonText,
      client_version: this.snapshot?.clientVersion ?? null,
      started_at: this.snapshot ? this.startedAt : null,
      ready_at: this.snapshot ? this.readyAt : null,
    };
  }

  /** Only fields that affect the running process, never unrelated settings revisions. */
  private pendingRestart(): boolean {
    const s = this.snapshot;
    if (!s || !this.live) return false;
    const v = this.opts.settings()?.values;
    return s.credentialRevision !== this.credRevision
      || (v !== undefined && ((v.openaiTunnelId ?? '').trim() !== s.tunnelId || (v.openaiTunnelClientPath ?? '').trim() !== s.clientPath));
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private setStatus(status: OpenAITunnelStatus, code: string | null = null, detail?: string): void {
    const text = code ? (detail ?? REASONS[code] ?? code) : null;
    if (this._status === status && this.reasonCode === code && this.reasonText === text) return;
    this._status = status;
    this.reasonCode = code;
    this.reasonText = text;
    this.opts.onEvent?.(status, { run_id: this.snapshot?.runId ?? null, ...(code ? { reason_code: code } : {}) });
    this.opts.log(`openai-tunnel: ${status}${code ? ` (${code})` : ''}`);
  }

  private async refreshConfigured(): Promise<void> {
    try { this.configured = await this.opts.credential.has(); } catch { this.configured = null; }
  }

  private redact(text: string): string {
    let out = text;
    const s = this.snapshot;
    if (s?.apiKey) out = out.split(s.apiKey).join('[redacted]');
    if (s?.target) out = out.split(s.target).join('[local-mcp]');
    return out.replace(/\/mcp\/[A-Za-z0-9_-]{16,}/g, '/mcp/[token]').replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-[redacted]');
  }

  private remember(chunk: Buffer): void {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      this.logLines.push(this.redact(line).slice(0, 500));
      if (this.logLines.length > 60) this.logLines.shift();
    }
  }

  private schedule(ms: number, fn: () => void): void {
    const t = setTimeout(() => { this.timers.delete(t); fn(); }, ms);
    t.unref?.();
    this.timers.add(t);
  }

  private clearTimers(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  /** Explicit start (plan §5.2.1): consistent snapshot, idempotent for the same run. */
  start(req: { settingsRevision: number; credentialRevision: number }): Promise<OpenAITunnelView> {
    return this.serial(async () => {
      const current = this.opts.settings();
      if (!current) throw new OpenAITunnelError(503, 'settings_unavailable');
      const tunnelId = (current.values.openaiTunnelId ?? '').trim();
      const clientPath = (current.values.openaiTunnelClientPath ?? '').trim();
      if (this.live && this.snapshot) {
        const same = this.snapshot.tunnelId === tunnelId && this.snapshot.clientPath === clientPath && this.snapshot.credentialRevision === this.credRevision;
        if (same) return this.view();
        throw new OpenAITunnelError(409, 'already_running');
      }
      if (req.settingsRevision !== current.revision) throw new OpenAITunnelError(409, 'settings_changed');
      if (req.credentialRevision !== this.credRevision) throw new OpenAITunnelError(409, 'credential_changed');
      const gen = this.stopGen;
      const fail = (code: string, detail?: string): never => {
        this.snapshot = undefined;
        this.setStatus('error', code, detail);
        throw new OpenAITunnelError(code.startsWith('credential_store') ? 503 : 400, code);
      };
      if (!tunnelId) fail('tunnel_id_missing');
      if (!OPENAI_TUNNEL_ID_PATTERN.test(tunnelId)) fail('tunnel_id_invalid');
      if (!clientPath) fail('client_missing');
      let clientVersion = '';
      try {
        clientVersion = await (this.opts.verifyClient ?? ((f: string) => verifyOpenAITunnelClient(f)))(clientPath);
      } catch (e) {
        fail('client_invalid', e instanceof Error ? e.message : undefined);
      }
      let apiKey: string | undefined;
      try {
        apiKey = await this.opts.credential.get();
        this.configured = apiKey !== undefined;
      } catch {
        this.configured = null;
        fail('credential_store_unavailable');
      }
      if (!apiKey) fail('credential_missing');
      // Anything changed while we were reading: never mix old and new (plan §5.2.1).
      const after = this.opts.settings();
      if (gen !== this.stopGen) throw new OpenAITunnelError(409, 'cancelled');
      if (!after || after.revision !== current.revision) throw new OpenAITunnelError(409, 'settings_changed');
      if (req.credentialRevision !== this.credRevision) throw new OpenAITunnelError(409, 'credential_changed');
      this.snapshot = {
        runId: randomUUID(), clientPath, clientVersion, tunnelId, settingsRevision: current.revision,
        credentialRevision: this.credRevision, apiKey: apiKey as string, target: this.opts.target(),
      };
      this.restarts = 0;
      this.logLines = [];
      this.startedAt = new Date().toISOString();
      this.readyAt = null;
      await this.spawnAttempt();
      return this.view();
    });
  }

  private async spawnAttempt(): Promise<void> {
    const s = this.snapshot;
    if (!s) return;
    const attempt = ++this.attempt;
    this.setStatus(this.restarts > 0 ? 'recovering' : 'starting');
    const dir = await mkdtemp(path.join(this.opts.runDirRoot ?? tmpdir(), 'bh-openai-'));
    await mkdir(path.join(dir, 'profiles'));
    this.runDir = dir;
    this.healthBase = undefined;
    const urlFile = path.join(dir, 'health-url');
    const args = [
      'run',
      '--control-plane.tunnel-id', s.tunnelId,
      '--control-plane.api-key', 'env:CONTROL_PLANE_API_KEY',
      '--health.listen-addr', '127.0.0.1:0',
      '--health.url-file', urlFile,
      // An empty private profile directory: never pick up the user's own tunnel-client profiles.
      '--profile-dir', path.join(dir, 'profiles'),
    ];
    const source = this.opts.env ?? process.env;
    const env: NodeJS.ProcessEnv = {};
    for (const k of PASS_ENV) if (source[k] !== undefined) env[k] = source[k];
    // Secrets and the machine-token URL travel only in the child environment, never in argv.
    env.CONTROL_PLANE_API_KEY = s.apiKey;
    env.MCP_SERVER_URL = s.target;
    let child: ChildProcess;
    try {
      child = (this.opts.spawnProcess ?? spawn)(s.clientPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env, cwd: dir, shell: false });
    } catch {
      await this.cleanupRunDir(dir);
      this.snapshot = undefined;
      this.setStatus('error', 'spawn_failed');
      return;
    }
    this.child = child;
    child.stdout?.on('data', (c: Buffer) => this.remember(c));
    child.stderr?.on('data', (c: Buffer) => this.remember(c));
    let exited = false;
    const onGone = (code: number | null): void => {
      if (exited) return;
      exited = true;
      void this.onExit(attempt, child, dir, code);
    };
    child.once('error', () => onGone(null));
    child.once('exit', (code) => onGone(code));
    void this.awaitReady(attempt, urlFile);
  }

  private current(attempt: number): boolean {
    return attempt === this.attempt && this.snapshot !== undefined && this._status !== 'stopping';
  }

  private async awaitReady(attempt: number, urlFile: string): Promise<void> {
    const deadline = Date.now() + this.timing.readyTimeoutMs;
    const urlDeadline = Date.now() + this.timing.urlFileTimeoutMs;
    const fetchHealth = this.opts.fetchHealth ?? defaultFetchHealth;
    while (this.current(attempt) && !this.healthBase) {
      const raw = await readFile(urlFile, 'utf8').catch(() => '');
      const m = LOOPBACK_BASE.exec(raw.trim());
      if (m && Number(m[1]) > 0 && Number(m[1]) < 65536) { this.healthBase = raw.trim().replace(/\/+$/, ''); break; }
      if (Date.now() > urlDeadline) return this.giveUp(attempt, 'not_ready_timeout');
      await new Promise((r) => setTimeout(r, this.timing.pollMs));
    }
    while (this.current(attempt)) {
      const ok = await fetchHealth(`${this.healthBase}/readyz`).then((r) => r.status === 200, () => false);
      if (!this.current(attempt)) return;
      if (ok) {
        this.readyAt = new Date().toISOString();
        this.restarts = 0;
        this.setStatus('ready');
        this.monitor(attempt);
        return;
      }
      if (Date.now() > deadline) return this.giveUp(attempt, classifyLog(this.logLines.join('\n')) ?? 'not_ready_timeout');
      await new Promise((r) => setTimeout(r, this.timing.pollMs));
    }
  }

  /** Readiness is an observation: losing it marks recovering, it does not restart a live process. */
  private monitor(attempt: number): void {
    let misses = 0;
    const tick = (): void => {
      if (!this.current(attempt) || !this.healthBase) return;
      void (this.opts.fetchHealth ?? defaultFetchHealth)(`${this.healthBase}/readyz`).then((r) => r.status === 200, () => false).then((ok) => {
        if (!this.current(attempt)) return;
        misses = ok ? 0 : misses + 1;
        if (ok && this._status === 'recovering') this.setStatus('ready');
        else if (misses >= 2 && this._status === 'ready') this.setStatus('recovering', classifyLog(this.logLines.slice(-10).join('\n')) ?? 'not_ready');
        this.schedule(this.timing.monitorMs, tick);
      });
    };
    this.schedule(this.timing.monitorMs, tick);
  }

  private async giveUp(attempt: number, code: string): Promise<void> {
    if (!this.current(attempt)) return;
    const child = this.child;
    this.attempt++; // invalidates this attempt's exit callback
    this.child = undefined;
    if (child) await this.terminate(child);
    if (this.runDir) await this.cleanupRunDir(this.runDir);
    this.snapshot = undefined;
    this.setStatus('error', code);
  }

  private async onExit(attempt: number, child: ChildProcess, dir: string, code: number | null): Promise<void> {
    await this.cleanupRunDir(dir);
    if (!this.current(attempt) || this.child !== child) return;
    this.child = undefined;
    const reason = classifyLog(this.logLines.slice(-20).join('\n'));
    const s = this.snapshot;
    if (reason && DETERMINISTIC.has(reason)) {
      this.snapshot = undefined;
      this.setStatus('error', reason);
      return;
    }
    // Never revive a run with a credential that has since been replaced (plan §5.2.1).
    if (!s || s.credentialRevision !== this.credRevision) {
      this.snapshot = undefined;
      this.setStatus('error', 'credential_pending_restart');
      return;
    }
    if (this.restarts >= this.timing.restartDelaysMs.length) {
      this.snapshot = undefined;
      this.setStatus('error', reason ?? 'exited', code === null ? undefined : `${REASONS[reason ?? 'exited']}（退出码 ${code}）`);
      return;
    }
    const delay = this.timing.restartDelaysMs[this.restarts++]!;
    this.setStatus('recovering', reason ?? 'not_ready');
    const gen = this.stopGen;
    this.schedule(delay, () => {
      void this.serial(async () => {
        if (gen !== this.stopGen || this.snapshot !== s || this.child) return;
        await this.spawnAttempt();
      });
    });
  }

  private terminate(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => { if (!done) { done = true; resolve(); } };
      child.once('exit', finish);
      try { child.kill(); } catch { finish(); return; }
      const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } finish(); }, this.timing.killGraceMs);
      t.unref?.();
    });
  }

  private async cleanupRunDir(dir: string): Promise<void> {
    if (this.runDir === dir) this.runDir = undefined;
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }

  /** Revokes the run first, then waits for its own process only (plan §5.4). */
  private async stopInternal(): Promise<void> {
    this.stopGen++;
    this.clearTimers();
    const child = this.child;
    const dir = this.runDir;
    const hadRun = this.snapshot !== undefined || child !== undefined;
    if (hadRun) this.setStatus('stopping');
    this.attempt++;
    this.child = undefined;
    if (child) await this.terminate(child);
    if (dir) await this.cleanupRunDir(dir);
    this.snapshot = undefined;
    this.healthBase = undefined;
    this.setStatus('off');
  }

  /** run_id guards against an old window stopping a newer run; null = unconditional (shutdown/watchdog). */
  stop(runId: string | null): Promise<OpenAITunnelView> {
    this.stopGen++; // cancel an in-flight start without waiting for the queue
    return this.serial(async () => {
      if (runId !== null && this.snapshot && this.snapshot.runId !== runId) throw new OpenAITunnelError(409, 'run_changed');
      await this.stopInternal();
      return this.view();
    });
  }

  /** Machine MCP token rotated: rebuild only a running OpenAI with the new local target (plan §5.4). */
  targetChanged(): Promise<void> {
    return this.serial(async () => {
      const s = this.snapshot;
      if (!s || !this.live) return;
      if (s.credentialRevision !== this.credRevision) {
        await this.stopInternal();
        this.setStatus('error', 'credential_pending_restart');
        return;
      }
      const child = this.child;
      this.attempt++;
      this.child = undefined;
      if (child) await this.terminate(child);
      if (this.runDir) await this.cleanupRunDir(this.runDir);
      s.target = this.opts.target();
      this.readyAt = null;
      await this.spawnAttempt();
    });
  }

  setCredential(credentialRevision: number, apiKey: string): Promise<OpenAITunnelView> {
    return this.serial(async () => {
      if (credentialRevision !== this.credRevision) throw new OpenAITunnelError(409, 'credential_changed');
      try {
        await this.opts.credential.set(apiKey);
        this.credRevision++;
        this.configured = true;
      } catch (e) {
        // A partial write is possible: invalidate older requests and re-read the truth.
        this.credRevision++;
        await this.refreshConfigured();
        throw new OpenAITunnelError(503, e instanceof CredentialStoreError ? e.code : 'credential_store_failed');
      }
      return this.view();
    });
  }

  removeCredential(credentialRevision: number): Promise<OpenAITunnelView> {
    return this.serial(async () => {
      if (credentialRevision !== this.credRevision) throw new OpenAITunnelError(409, 'credential_changed');
      await this.stopInternal();
      try {
        await this.opts.credential.remove();
        this.credRevision++;
        this.configured = false;
      } catch (e) {
        this.credRevision++;
        await this.refreshConfigured();
        throw new OpenAITunnelError(503, e instanceof CredentialStoreError ? e.code : 'credential_delete_unconfirmed');
      }
      return this.view();
    });
  }

  /** Bounded local read-only summary (plan §5.2): no cloud calls, no lifecycle changes. */
  async diagnostics(): Promise<Record<string, unknown>> {
    const v = this.opts.settings()?.values;
    let health: unknown = null;
    let ready: number | null = null;
    const base = this.healthBase;
    if (base && this.live) {
      const fetchHealth = this.opts.fetchHealth ?? defaultFetchHealth;
      ready = await fetchHealth(`${base}/readyz`).then((r) => r.status, () => null);
      health = await fetchHealth(`${base}/health?details=true`).then((r) => {
        const text = this.redact(r.body);
        try { return JSON.parse(text) as unknown; } catch { return text.slice(0, 4_000); }
      }, () => null);
    }
    return {
      observed_at: new Date().toISOString(),
      ...this.view(),
      credential_store: this.opts.credential.kind,
      client_path_configured: !!(v?.openaiTunnelClientPath ?? '').trim(),
      tunnel_id_saved: (v?.openaiTunnelId ?? '').trim() || null,
      readyz_status: ready,
      health,
      recent_log: this.logLines.slice(-20),
      note: '健康状态是本机观测，不代表 ChatGPT 已成功调用。',
    };
  }
}
