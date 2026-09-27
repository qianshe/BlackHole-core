import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect } from 'node:net';
import { EventEmitter, ProgressLocation, env as vscodeEnv, window, workspace, type Disposable, type ExtensionContext, type OutputChannel } from 'vscode';
import type { ExtConfig } from './config';
import { resolveCloudEndpoint } from './cloudEnvironment';
import type { ControlApi, Health } from './controlApi';
import { pathFromEnvironment, prependToolDirectory, resolveExecutionRg } from './vscodeRipgrep';


type TerminalProfile = { path?: string | string[]; source?: string } | null;
function terminalPlatformKey(): 'windows'|'osx'|'linux' { return process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux'; }
/** Prefer the profile the user selected in VS Code over env.shell, which can be the OS fallback (PowerShell 5.1 on Windows). */
export function defaultTerminalShell(): string | undefined {
  const key = terminalPlatformKey(), terminal = workspace.getConfiguration('terminal.integrated');
  const selected = terminal.get<string>(`defaultProfile.${key}`);
  const profiles = terminal.get<Record<string, TerminalProfile>>(`profiles.${key}`) ?? {};
  const profile = selected ? profiles[selected] : undefined;
  const candidates = typeof profile?.path === 'string' ? [profile.path] : Array.isArray(profile?.path) ? profile.path : [];
  const explicit = candidates.find(value => value.trim() && !value.includes('${'))?.trim();
  if (explicit) return explicit;
  if (process.platform === 'win32') {
    if (profile?.source === 'PowerShell') return 'pwsh.exe';
    if (profile?.source === 'Git Bash') return 'bash.exe';
    if (selected === 'Command Prompt') return 'cmd.exe';
  }
  return vscodeEnv.shell || undefined;
}
export type DaemonState = 'stopped' | 'starting' | 'running' | 'error';

/** globalState key holding the fingerprint of the last daemon spawn. */
const FP_KEY = 'blackhole.daemonStartFingerprint';
const START_TIMEOUT_MS = 12_000;
const POST_START_HEALTH_RETRIES = 4;
const RECONCILE_BACKOFF_MS = 15_000;
const SHUTDOWN_TIMEOUT_MS = 12_000;
// Startup IO can make an otherwise healthy control endpoint slower than 500ms.
// Use a realistic per-request budget without extending the overall handoff bound.
const HANDOFF_HEALTH_TIMEOUT_MS = 2_000;
const SHUTDOWN_POLL_MS = 100;
const SHUTDOWN_SETTLE_MS = 150;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The daemon is a detached process that outlives VS Code windows: the
 * extension only ever spawns or attaches, never owns its lifetime.
 */
export class DaemonManager implements Disposable {
  private readonly events = new EventEmitter<DaemonState>();
  readonly onDidChangeState = this.events.event;
  private state: DaemonState = 'stopped';
  private lastError = '';
  /** Concurrent callers in one extension host share one spawn/health loop. */
  private startPending?: Promise<boolean>;
  /** A manual restart and the configuration watcher share one stop/start. */
  private restartPending?: Promise<boolean>;
  private syncPending?: Promise<void>;
  private syncAgain = false;
  private stopPending?: Promise<boolean>;
  private restartActivation = false;
  private strictRestartJoin?: Promise<boolean>;
  private lifecycleTail: Promise<void> = Promise.resolve();
  private lifecycleRevision = 0;
  private pendingOperations = 0;
  private disposed = false;
  /** Only a requested or unfinished handoff may retry; a passive health read
   * must not wrest ownership of a shared daemon from another VS Code window. */
  private reconcileNeeded = false;
  /** A failed explicit change must not later be accepted as an activation-only
   * terminal preference difference by a background health poll. */
  private requireExactReconcile = false;
  private nextReconcileAt = 0;
  private lastAutoRestartWarning?: string;
  /** Control requests keep using the old endpoint until its shutdown is confirmed. */
  private managedPort: number;

  constructor(
    private readonly context: ExtensionContext,
    private readonly cfg: () => ExtConfig,
    private readonly api: ControlApi,
    private readonly log: OutputChannel,
  ) {
    this.managedPort = cfg().port;
    // A window may be reopened after its configured port changed. The last
    // acknowledged launch still identifies the endpoint requiring teardown.
    try {
      const previous = JSON.parse(context.globalState.get<string>(FP_KEY) ?? '{}') as { port?: number };
      if (Number.isInteger(previous.port) && previous.port! > 0 && previous.port! <= 65535) this.managedPort = previous.port!;
    } catch { /* no acknowledged launch yet */ }
  }

  captureHealthObservation(): { revision: number; port: number } {
    return { revision: this.lifecycleRevision, port: this.cfg().port };
  }

  /** Polling can recover a late startup and detect replacement by another
   * window, but never accept an observation made before Stop or a port change. */
  observeHealth(health: Health, observation: { revision: number; port: number }): boolean {
    if (this.disposed || this.pendingOperations > 0 || observation.revision !== this.lifecycleRevision
      || observation.port !== this.cfg().port || observation.port !== this.managedPort
      || health.ok !== true || !health.daemon_id || typeof health.version !== 'string') return false;
    const desired = this.fingerprint();
    const verified = health.version === this.context.extension.packageJSON.version
      && health.start_fingerprint === desired;
    // An activation may have deliberately adopted another window's terminal
    // preference. Do not invent that exception after a failed explicit restart.
    const adopted = !verified && !this.requireExactReconcile && this.state === 'running'
      && this.sameInstalledCode(desired, health);
    const usable = verified || adopted;
    if (usable) this.setState('running');
    // A legacy listener attached for an authorized upgrade is not a failure.
    // Polls can land between attach and sync (outside the lifecycle queue).
    // Keep that transition pending, but never make the old listener usable or
    // clear a real failure from a previous lifecycle attempt.
    else if (!(this.state === 'starting' && this.reconcileNeeded)) {
      this.setState('error', 'daemon version or configuration differs from installed extension');
    }
    // A passive observation cannot authorize a handoff. An activation or
    // explicit setting/restart request must establish that intent first.
    // A failed or inconclusive sync keeps reconcileNeeded set. Polls are the
    // recovery clock, while this backoff prevents an old window from causing a
    // restart storm (and repeated notifications) on every one-second tick.
    if (this.reconcileNeeded && Date.now() >= this.nextReconcileAt) {
      this.nextReconcileAt = Date.now() + RECONCILE_BACKOFF_MS;
      void this.syncConfigRestart(!this.requireExactReconcile).catch(() => {
        if (!this.disposed) this.log.appendLine('warning: recovered daemon configuration could not be reconciled');
      });
    }
    // An incompatible listener is never ready; only an unfinished requested
    // handoff may retry it. The status bar cannot sync its account from it.
    return usable;
  }

  /** One lifecycle queue for Start/Stop/Restart. Health observations made before
   * an operation was requested are invalid even after that operation finishes. */
  private runLifecycle(work: () => Promise<boolean>): Promise<boolean> {
    this.lifecycleRevision++;
    this.pendingOperations++;
    const task = this.lifecycleTail.then(() => this.disposed ? false : work()).catch((error: unknown) => {
      if (!this.disposed) this.startFailure(error);
      return false;
    }).finally(() => { this.pendingOperations--; });
    this.lifecycleTail = task.then(() => undefined);
    return task;
  }

  private startFailure(error: unknown): false {
    const detail = error instanceof Error ? error.message : String(error);
    const code = (error as { code?: unknown } | null)?.code;
    const reason = `${typeof code === 'string' ? `${code}: ` : ''}${detail}`;
    if (!this.disposed) {
      this.setState('error', reason);
      this.log.appendLine(`daemon lifecycle failed: ${reason}`);
      void window.showErrorMessage(`BlackHole: daemon 启动或交接失败（${reason}），详见输出面板`);
    }
    return false;
  }

  get currentState(): DaemonState {
    return this.state;
  }

  get error(): string {
    return this.lastError;
  }

  private setState(state: DaemonState, error = ''): void {
    if (this.disposed || (this.state === state && this.lastError === error)) return;
    this.state = state;
    this.lastError = error;
    this.events.fire(state);
  }

  private entryPath(config = this.cfg()): string {
    const configured = config.daemonEntry;
    if (resolveCloudEndpoint().environment === 'test' && configured) return configured;
    return path.join(this.context.extensionPath, 'dist', 'daemon', 'cli.js');
  }

  /** Bundled cloudflared next to the extension's daemon bundle. */
  private bundledCloudflared(): string | undefined {
    const exe = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
    const p = path.join(this.context.extensionPath, 'dist', 'daemon', exe);
    return fs.existsSync(p) ? p : undefined;
  }

  private async health(timeoutMs = 8_000): Promise<Health | undefined> {
    try {
      const value = await this.api.health(timeoutMs, this.managedPort);
      return value.ok === true ? value : undefined;
    } catch {
      return undefined;
    }
  }

  async probe(): Promise<boolean> {
    return (await this.health()) !== undefined;
  }

  /** A single missed response immediately after readiness is not a failed
   * handoff. Wait briefly for a stable control endpoint before deciding. */
  private async healthAfterStart(): Promise<Health | undefined> {
    for (let attempt = 0; attempt < POST_START_HEALTH_RETRIES && !this.disposed; attempt++) {
      const current = await this.health(750);
      if (current) return current;
      if (attempt + 1 < POST_START_HEALTH_RETRIES) await sleep(200);
    }
    return undefined;
  }

  ensureRunning(): Promise<boolean> {
    if (this.startPending) return this.startPending;
    const task = this.runLifecycle(() => this.ensureRunningOnce());
    const shared = task.finally(() => {
      if (this.startPending === shared) this.startPending = undefined;
    });
    this.startPending = shared;
    return shared;
  }

  private async ensureRunningOnce(): Promise<boolean> {
    if (this.disposed) return false;
    if (this.managedPort !== this.cfg().port) {
      if (!(await this.stopOnce(false))) return false;
      this.managedPort = this.cfg().port;
    }
    const attached = await this.health();
    if (attached) {
      const desired = this.fingerprint();
      if (attached.version === this.context.extension.packageJSON.version
        && attached.start_fingerprint === desired) this.setState('running');
      else {
        // Attach to coordinate the upgrade, not to report an old daemon ready.
        this.reconcileNeeded = true;
        this.setState('starting');
      }
      return true;
    }
    if (this.disposed) return false;
    this.reconcileNeeded = true; // A failed spawn can be retried if a listener appears later.
    this.setState('starting');
    const c = { ...this.cfg(), port: this.managedPort };
    const entry = this.entryPath(c);
    if (!fs.existsSync(entry)) {
      this.setState('error', `daemon entry not found: ${entry}`);
      void window.showErrorMessage(
        `BlackHole: 找不到 daemon 入口（${entry}）。${resolveCloudEndpoint().environment === 'test' ? '开发场景请把 blackhole.daemonEntry 指向仓库 dist/cli.js。' : '请重新安装完整的正式版插件；正式版仅使用内置服务。'}`,
      );
      return false;
    }
    // Capture helpers once: the fingerprint and child environment must describe
    // the very same launch, even while VS Code is discovering terminal profiles.
    const terminalShell = defaultTerminalShell();
    const rg = resolveExecutionRg({ platform: process.platform, arch: process.arch, appRoot: vscodeEnv.appRoot, pathValue: pathFromEnvironment(process.env) });
    const spawnFingerprint = this.fingerprint({ config: c, entry, terminalShell, executionRg: rg });
    // process.execPath inside the extension host is VS Code's Electron binary;
    // ELECTRON_RUN_AS_NODE turns it into a plain Node runtime (no user Node needed).
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      BLACKHOLE_PORT: String(c.port),
      BLACKHOLE_START_FINGERPRINT: spawnFingerprint,
      // Custom selects the user-level library (project skills still merge).
      // Keep missing paths explicit; blank clears inherited overrides and uses
      // the daemon's default user library. Neither case changes session grants.
      BLACKHOLE_SKILLS_DIR: c.skillsDir || '',
      // the channel is user-driven from the sidebar: allow on-demand starts,
      // choice between persistent (named) and temporary (quick) is made there
      // Tabs never gate channels (plan §5.1): Cloudflare stays startable whichever
      // tab is the default; the OpenAI channel is an independent daemon subsystem.
      BLACKHOLE_TUNNEL: 'auto',
      BLACKHOLE_TUNNEL_NAME: c.namedTunnelName,
    };
    // Resolve the same default shell VS Code exposes to extensions. The daemon still owns
    // the process tree/sandbox; this only selects the interpreter for managed background scripts.
    // Prefer a user-installed rg already on PATH. Otherwise reuse ripgrep shipped by
    // this VS Code host. Only BlackHole's daemon environment is changed; system and
    // integrated-terminal PATH stay untouched. Internal VS Code layouts are probed
    // best-effort because appRoot is stable API but the bundled package layout is not.
    if (rg) {
      // Keep the absolute helper separate on Windows so a POSIX/MSYS parent PATH
      // is normalized by the daemon before anything is prepended to it.
      env.BLACKHOLE_RG = rg;
      if (process.platform !== 'win32') env.PATH = prependToolDirectory(env.PATH, rg, process.platform);
    }
    // Do not use existsSync here: WindowsApps/App Execution Aliases can be
    // executable while Node's stat-based existsSync reports false. The daemon
    // resolves and probes this candidate before using it.
    if (terminalShell) env.BLACKHOLE_PROCESS_SHELL = terminalShell;
    if (c.publicBaseUrl) env.BLACKHOLE_PUBLIC_URL = c.publicBaseUrl;
    // semantic search policy: 'explicit' is the daemon default, so only
    // the non-default choices need injecting (the key itself is stored in the
    // daemon's ~/.blackhole/semantic-key, never in a settings JSON)
    if (c.semanticMode !== 'explicit') env.BLACKHOLE_SEMANTIC = c.semanticMode;
    // explicit setting wins; otherwise use the binary bundled in the vsix;
    // otherwise leave unset so the daemon resolves 'cloudflared' from PATH
    const cloudflared = c.cloudflaredPath || this.bundledCloudflared();
    if (cloudflared) env.BLACKHOLE_CLOUDFLARED = cloudflared;
    // route the daemon's public-URL probe through a local HTTP proxy when asked
    // (TUN/fake-ip machines RST direct probes while the tunnel is healthy)
    if (c.tunnelProbeProxy) env.BLACKHOLE_TUNNEL_PROBE_PROXY = c.tunnelProbeProxy;
    // Git's usr/bin (grep/sed/awk/find) for the workspace shell; empty = leave
    // PATH alone. Validate loudly: a typo here used to fail silently forever.
    if (c.gitUsrBinPath) {
      if (fs.existsSync(c.gitUsrBinPath)) {
        env.BLACKHOLE_GIT_USR_BIN = c.gitUsrBinPath;
        const grep = process.platform === 'win32' ? 'grep.exe' : 'grep';
        if (!fs.existsSync(path.join(c.gitUsrBinPath, grep))) {
          this.log.appendLine(`warning: gitUsrBinPath set but ${grep} not found in ${c.gitUsrBinPath} — PATH prepended anyway`);
          void window.showWarningMessage(`BlackHole: gitUsrBinPath 目录里没有找到 ${grep}（${c.gitUsrBinPath}），PATH 仍会加上该目录`);
        }
      } else {
        this.log.appendLine(`warning: gitUsrBinPath does not exist, ignoring: ${c.gitUsrBinPath}`);
        void window.showWarningMessage(`BlackHole: gitUsrBinPath 目录不存在，已忽略 —— ${c.gitUsrBinPath}`);
      }
    }
    const bhPy = path.join(path.dirname(entry), 'bh.py');
    if (fs.existsSync(bhPy)) env.BLACKHOLE_BH_PY = bhPy;

    // detached + file stdio: the daemon must survive window close, and open
    // pipes to a dead parent would EPIPE-crash it the moment it logs.
    const logFile = path.join(os.tmpdir(), 'blackhole-daemon.log');
    let fd: number | undefined;
    let child: ChildProcess;
    let launchError: Error | undefined;
    let exited: string | undefined;
    try {
      fd = fs.openSync(logFile, 'a');
      child = spawn(process.execPath, [entry, 'serve', '--port', String(c.port)], {
        env,
        detached: true,
        windowsHide: true,
        stdio: ['ignore', fd, fd],
      });
      // spawn failures are normally asynchronous; a try/catch alone misses them.
      child.on('error', (error) => { launchError = error; });
      child.once('exit', (code, signal) => { exited = `daemon exited before ready (code=${code}, signal=${signal})`; });
      child.unref();
    } catch (error) {
      return this.startFailure(error);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }

    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline && !this.disposed) {
      const current = await this.health(750);
      if (this.disposed) return false;
      if (current) {
        const matchesLaunch = current.daemon_id && current.version === this.context.extension.packageJSON.version
          && current.start_fingerprint === spawnFingerprint;
        if (matchesLaunch) {
          // One response can arrive just before a competing window retires the
          // listener. Confirm the same identity before claiming this launch.
          const confirmed = await this.health(750);
          if (!confirmed || confirmed.daemon_id !== current.daemon_id
            || confirmed.version !== current.version || confirmed.start_fingerprint !== spawnFingerprint) {
            await sleep(100);
            continue;
          }
          this.setState('running');
          // This PID is only our ATTEMPT: another window can win with the same
          // fingerprint. Do not claim the observed listener belongs to our child.
          this.log.appendLine(`daemon healthy id=${current.daemon_id} attemptedSpawnPid=${child.pid} entry=${entry} log=${logFile}`);
          await this.context.globalState.update(FP_KEY, spawnFingerprint);
          return true;
        }
        if ((launchError || exited) && current.daemon_id && typeof current.version === 'string') {
          // Our candidate lost the port race. Attach to the actual listener so
          // activation can reconcile it; never persist OUR candidate's fingerprint
          // or report its PID as the live daemon's PID.
          this.reconcileNeeded = true;
          this.setState('starting');
          this.log.appendLine(`daemon candidate lost port race; attached to v${current.version} id=${current.daemon_id} attemptedSpawnPid=${child.pid} log=${logFile}`);
          return true;
        }
      }
      // A port-race loser can exit while the winner is still initializing. Wait
      // for that listener, but do not spend 12s on a failed spawn with no owner.
      if ((launchError || exited) && !(await this.listenerOpen())) {
        return this.startFailure(launchError ?? new Error(exited));
      }
      await sleep(250);
    }
    if (this.disposed) return false;
    this.setState('error', 'daemon did not become healthy (see log file)');
    void window.showErrorMessage(`BlackHole: daemon 启动后 12s 内未就绪，日志见 ${logFile}`);
    return false;
  }

  /** A failed /health request is not proof that the loopback listener is gone. */
  private listenerOpen(timeoutMs = 500): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const socket = connect({ host: '127.0.0.1', port: this.managedPort });
      const finish = (open: boolean): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(open);
      };
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
      // A loopback connect normally settles immediately. Timeouts are treated as
      // still-open so a slow daemon cannot be mistaken for a stopped one.
      socket.setTimeout(timeoutMs, () => finish(true));
    });
  }

  /** Resolve a live daemon identity, or prove that the loopback listener is closed. */
  private async waitForHealthOrClosed(): Promise<Health | null | undefined> {
    const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
    while (Date.now() < deadline && !this.disposed) {
      const current = await this.health(Math.min(HANDOFF_HEALTH_TIMEOUT_MS, Math.max(1, deadline - Date.now())));
      if (this.disposed) break;
      if (current) return current;
      if (!(await this.listenerOpen())) return null;
      await sleep(SHUTDOWN_POLL_MS);
    }
    // The port is still occupied but the control plane never became readable.
    return undefined;
  }

  private async waitForDaemonChange(targetId: string | undefined): Promise<boolean> {
    const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
    while (Date.now() < deadline && !this.disposed) {
      const current = await this.health(Math.min(HANDOFF_HEALTH_TIMEOUT_MS, Math.max(1, deadline - Date.now())));
      if (this.disposed) break;
      if (current && targetId && current.daemon_id && current.daemon_id !== targetId) {
        await sleep(SHUTDOWN_SETTLE_MS);
        return true;
      }
      if (!current && !(await this.listenerOpen())) {
        // /shutdown closes the HTTP listener just before its final audit write and
        // SQLite close. Give those synchronous tail operations a small grace period.
        await sleep(SHUTDOWN_SETTLE_MS);
        return true;
      }
      await sleep(SHUTDOWN_POLL_MS);
    }
    return false;
  }

  /**
   * Stop the current daemon. Restarts preserve a replacement that another VS
   * Code window already spawned; an explicit Stop command follows replacements
   * for a few bounded attempts so the operator's intent remains "stop it".
   */
  stop(preserveReplacement = false): Promise<boolean> {
    if (this.stopPending) return this.stopPending;
    // An explicit Stop revokes any outstanding permission to auto-reconcile.
    if (!preserveReplacement) { this.reconcileNeeded = false; this.requireExactReconcile = false; }
    const task = this.runLifecycle(() => this.stopOnce(preserveReplacement));
    const shared = task.finally(() => { if (this.stopPending === shared) this.stopPending = undefined; });
    this.stopPending = shared;
    return shared;
  }

  private async stopOnce(preserveReplacement = false): Promise<boolean> {
    const attempts = preserveReplacement ? 1 : 3;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const target = await this.waitForHealthOrClosed();
      if (this.disposed) return false;
      if (target && preserveReplacement && this.restartActivation && this.managedPort === this.cfg().port
        && this.sameInstalledCode(this.fingerprint(), target)) {
        this.setState('running');
        return true;
      }
      if (target === null) {
        this.setState('stopped');
        return true;
      }
      if (!target) {
        this.setState('error', 'daemon listener is open but health is unavailable');
        this.log.appendLine('warning: daemon listener stayed open but /health was unavailable for 12s (health probes allowed up to 2s each)');
        return false;
      }
      if (!target.daemon_id) {
        this.setState('error', 'daemon health has no identity; refusing unguarded shutdown');
        this.log.appendLine('warning: daemon health omitted daemon_id; refusing unsafe shutdown');
        return false;
      }
      try {
        await this.api.shutdown(target.daemon_id, target.start_fingerprint ?? null, this.managedPort);
      } catch (error) {
        const status = (error as Error & { status?: number }).status;
        if (status === 409) {
          this.log.appendLine('daemon changed before shutdown; preserving the replacement');
          if (preserveReplacement) {
            this.setState('running');
            return true;
          }
          continue;
        }
        // The request can lose its response while the target is already exiting;
        // the identity/health wait below decides the actual outcome.
      }
      if (!(await this.waitForDaemonChange(target.daemon_id))) {
        this.setState('error', 'daemon did not stop within 12s');
        this.log.appendLine(`warning: daemon ${target.daemon_id ?? '(unknown)'} did not stop within 12s`);
        return false;
      }
      const replacement = await this.waitForHealthOrClosed();
      if (this.disposed) return false;
      if (replacement === undefined) {
        this.setState('error', 'daemon listener reopened but health is unavailable');
        return false;
      }
      if (replacement && !preserveReplacement) continue;
      this.setState(replacement ? 'running' : 'stopped');
      return true;
    }
    this.setState('error', 'daemon kept changing while stop was requested');
    return false;
  }

  restart(activation = false): Promise<boolean> {
    this.reconcileNeeded = true;
    if (!activation) this.requireExactReconcile = true;
    if (this.requireExactReconcile) activation = false;
    if (this.restartPending) {
      if (!activation && this.strictRestartJoin) return this.strictRestartJoin;
      if (!activation && this.restartActivation) {
        this.restartActivation = false;
        // Also check late joiners: activation may have already made its looser
        // acceptance decision in the microtask before its Promise is delivered.
        const joined = this.restartPending.then(async ok => {
          if (!ok || this.disposed || this.managedPort !== this.cfg().port) return false;
          const fp = this.fingerprint(), live = await this.health(1_000);
          return this.liveFingerprintMatches(fp, live);
        });
        const shared = joined.finally(() => { if (this.strictRestartJoin === shared) this.strictRestartJoin = undefined; });
        this.strictRestartJoin = shared;
        return shared;
      }
      return this.restartPending;
    }
    this.restartActivation = activation;
    this.restartPending = this.runLifecycle(async () => {
      for (let attempt = 0; attempt < 3 && !this.disposed; attempt++) {
        const changingPort = this.managedPort !== this.cfg().port;
        // Port changes cannot preserve an old-port replacement using the same DB.
        if (!(await this.stopOnce(!changingPort))) return false;
        if (changingPort) this.managedPort = this.cfg().port;
        const beforeStart = this.fingerprint();
        if (!(await this.ensureRunningOnce())) return false;
        const desired = this.fingerprint();
        const current = await this.healthAfterStart();
        if (this.managedPort === this.cfg().port) {
          if (await this.liveFingerprintMatches(desired, current)) return true;
          if (this.restartActivation && current && this.sameInstalledCode(desired, current)) {
            this.reconcileNeeded = false;
            this.setState('running');
            return true;
          }
        }
        if (beforeStart !== desired || this.managedPort !== this.cfg().port) {
          this.log.appendLine('configuration changed during startup; reconciling the latest settings');
          continue;
        }
        if (current && attempt < 2) {
          // A competing old window can reclaim the port after shutdown but
          // before our candidate binds. Recheck its identity and retry the
          // guarded handoff, rather than declaring the old daemon "ready".
          this.log.appendLine(`daemon on port runs v${current.version} with another fingerprint; retrying handoff (${attempt + 2}/3)`);
          await sleep(SHUTDOWN_SETTLE_MS);
          continue;
        }
        const keys = this.fingerprintDifferences(desired, current?.start_fingerprint);
        this.setState('error', current ? 'daemon has a different configuration fingerprint' : 'daemon health unavailable after restart');
        this.log.appendLine(`warning: restart did not confirm the requested daemon fingerprint; fields=${keys.join(',')}; health=${current ? 'available' : 'unavailable'}`);
        return false;
      }
      if (!this.disposed) {
        this.setState('error', 'configuration kept changing during restart');
        this.log.appendLine('warning: configuration kept changing during restart; stopped after 3 reconciliations');
      }
      return false;
    }).finally(() => { this.restartPending = undefined; });
    return this.restartPending;
  }

  /**
   * Fingerprint of everything a daemon must be RESTARTED to pick up:
   * restart-relevant settings plus the extension version (new daemon code
   * ships with a new version). Stored after every spawn/restart; while the
   * stored value differs from the current one, the running daemon is stale.
   */
  private fingerprint(snapshot?: { config: ExtConfig; entry: string; terminalShell?: string; executionRg?: string }): string {
    const c = snapshot?.config ?? this.cfg();
    const entry = snapshot?.entry ?? this.entryPath(c);
    // The daemon is detached and outlives windows: a same-version reinstall
    // (or a dev rebuild) would otherwise keep the OLD process alive forever —
    // the version field alone never changes. The entry bundle's mtime flips
    // the fingerprint whenever the files behind it change, so an activation
    // or settings change recycles a stale daemon without touching VS Code.
    let bundleMtime = 0;
    try {
      bundleMtime = fs.statSync(entry).mtimeMs;
    } catch {
      /* missing entry: ensureRunning reports it on spawn */
    }
    return JSON.stringify({
      version: this.context.extension.packageJSON.version,
      bundleMtime,
      cloudEnvironment: resolveCloudEndpoint().environment,
      cloudOrigin: resolveCloudEndpoint().origin,
      entry,
      port: c.port,
      daemonEntry: resolveCloudEndpoint().environment === 'test' ? c.daemonEntry : '',
      executionRg: snapshot ? snapshot.executionRg : resolveExecutionRg({ platform: process.platform, arch: process.arch, appRoot: vscodeEnv.appRoot, pathValue: pathFromEnvironment(process.env) }),
      terminalShell: snapshot ? snapshot.terminalShell : defaultTerminalShell(),
      cloudflaredPath: c.cloudflaredPath,
      // channelMode is a view preference: changing tabs must not restart the daemon.
      gitUsrBinPath: c.gitUsrBinPath,
      publicBaseUrl: c.publicBaseUrl,
      namedTunnelName: c.namedTunnelName,
      tunnelProbeProxy: c.tunnelProbeProxy,
      skillsDir: c.skillsDir,
      // context_search 的注册是启动时决定的：模式变了必须重启才会出现/消失
      semanticMode: c.semanticMode,
    });
  }

  /** globalState is a cache, never proof of what currently owns the port.
   * Legacy daemons without a live fingerprint must be upgraded, even if this
   * window remembers an earlier successful launch of this same version. */
  private async liveFingerprintMatches(fp: string, current?: Health): Promise<boolean> {
    const health = current ?? await this.health(1_000);
    if (!health?.daemon_id || health.version !== this.context.extension.packageJSON.version
      || health.start_fingerprint !== fp) return false;
    if (this.context.globalState.get<string>(FP_KEY) !== fp) {
      await this.context.globalState.update(FP_KEY, fp);
    }
    this.reconcileNeeded = false;
    this.requireExactReconcile = false;
    this.lastAutoRestartWarning = undefined;
    this.setState('running');
    return true;
  }

  /** Log field names only, never paths, credentials or full configuration values. */
  private fingerprintDifferences(wanted: string, live?: string): string[] {
    if (!live) return ['missing'];
    try {
      const a = JSON.parse(wanted) as Record<string, unknown>;
      const b = JSON.parse(live) as Record<string, unknown>;
      if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return ['invalid'];
      return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(key => a[key] !== b[key]);
    } catch { return ['invalid']; }
  }

  /** A shared daemon may use another window's terminal preference. This is the
   * ONLY activation exception: real machine settings, build and Cloud origin
   * must still match. Explicit settings changes always use the full fingerprint. */
  private sameInstalledCode(fp: string, current: Health): boolean {
    try {
      const wanted = JSON.parse(fp) as { version?: unknown; bundleMtime?: unknown };
      return typeof wanted.version === 'string' && wanted.version === current.version
        && !!current.daemon_id && typeof wanted.bundleMtime === 'number'
        && wanted.bundleMtime > 0
        && this.fingerprintDifferences(fp, current.start_fingerprint).every(key => key === 'terminalShell');
    } catch { return false; }
  }

  /**
   * Restart a healthy daemon when the relevant configuration is stale. On
   * activation, adopt a same-build daemon already owned by another VS Code
   * window; explicit configuration changes still require the full fingerprint.
   */
  syncConfigRestart(activation = false): Promise<void> {
    if (!activation) { this.requireExactReconcile = true; this.reconcileNeeded = true; }
    if (this.requireExactReconcile) activation = false;
    if (this.syncPending) {
      this.syncAgain ||= !activation;
      return this.syncPending;
    }
    this.syncPending = (async () => {
      for (let pass = 0; pass < 3; pass++) {
        this.syncAgain = false;
        await this.syncConfigRestartOnce(pass === 0 && activation);
        if (!this.syncAgain) return;
      }
      this.log.appendLine('warning: config sync kept changing; waiting for the next explicit change');
    })().finally(() => { this.syncPending = undefined; });
    return this.syncPending;
  }

  private async syncConfigRestartOnce(activation: boolean): Promise<void> {
    // Do not mistake an in-flight spawn for stale configuration or start two
    // activation/config-watcher stop/start sequences in the same host.
    if (this.startPending) await this.startPending;
    if (this.restartPending) await this.restartPending;
    if (this.stopPending) await this.stopPending;
    if (this.disposed) return;
    if (this.managedPort !== this.cfg().port) {
      const ok = await this.restart(activation);
      if (!ok && !this.disposed) void window.showErrorMessage('BlackHole: 端口变更交接失败，旧 daemon 未确认停止，未启动新实例');
      return;
    }
    const fp = this.fingerprint();
    const current = await this.health(1_000);
    if (!current) return; // not running; next ensureRunning spawns with current config
    if (await this.liveFingerprintMatches(fp, current)) return;
    if (activation && this.sameInstalledCode(fp, current)) {
      this.reconcileNeeded = false;
      this.log.appendLine('daemon already runs this installed build; adopting its machine-wide configuration');
      this.setState('running');
      return;
    }
    this.log.appendLine('config/version changed since daemon start — restarting daemon');
    const ok = await window.withProgress(
      { location: ProgressLocation.Notification, title: 'BlackHole: 配置变更，正在重启 daemon 使其生效' },
      async () => {
        const desired = this.fingerprint();
        const live = await this.health(1_000);
        if (await this.liveFingerprintMatches(desired, live)) return true;
        if (activation && live && this.sameInstalledCode(desired, live)) {
          this.reconcileNeeded = false;
          return true;
        }
        return this.restart(activation); // Keep the caller's policy through replacement races.
      },
    );
    if (ok) {
      this.reconcileNeeded = false;
      this.lastAutoRestartWarning = undefined;
    } else if (!this.disposed) {
      this.reconcileNeeded = true;
      this.nextReconcileAt = Math.max(this.nextReconcileAt, Date.now() + RECONCILE_BACKOFF_MS);
      const warningKey = `${fp}:${current.daemon_id}`;
      if (this.lastAutoRestartWarning !== warningKey) {
        this.lastAutoRestartWarning = warningKey;
        void window.showErrorMessage('BlackHole: 配置变更后重启 daemon 失败，详见输出面板');
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.lifecycleRevision++;
    this.events.dispose();
  }
}
