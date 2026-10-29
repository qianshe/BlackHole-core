import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { statSync } from 'node:fs';
import path from 'node:path';
import { detectCodePage, encodeShellInput, psAsciiString, PROBE_TEXT, streamDecoder, UTF8 } from './shell-codepage.js';
import { msysPathToWindows, resolveWindowsCommandShell, resolveWindowsExecutable, windowsEnvValue, windowsExecutionPath, windowsSystemRoot } from './windows-env.js';

/**
 * Persistent PowerShell shell, ported from the legacy daemon. One long-lived
 * `pwsh` process keeps cwd and environment across calls (mirrors DSH minimal
 * `pwsh`). Each run ends both output streams with a sentinel; stdout also
 * carries the exit code and resulting cwd. Completion waits for BOTH pipes,
 * so a late stderr chunk cannot be attributed to the next command.
 */

/**
 * Minimal environment for the shell. NEVER pass process.env through — that
 * would leak every host secret to a remote caller. Forward only what a shell
 * needs to function.
 */
export function powerShellEnvironment(extra: Record<string, string> = {}, host: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const keys = ['PATH', 'PATHEXT', 'SystemRoot', 'ComSpec', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LANG', 'PSModulePath', 'APPDATA', 'LOCALAPPDATA'];
  const env: Record<string, string> = {};
  for (const k of keys) {
    const v = process.platform === 'win32' ? windowsEnvValue(host, k) : host[k];
    if (v !== undefined) env[k] = v;
  }
  env.PATH = env.PATH || '';
  // PowerShell command discovery REQUIRES PATHEXT (probe-verified: without it,
  // `node` is unresolvable even with a correct PATH).
  env.PATHEXT = env.PATHEXT || '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC';
  if (process.platform === 'win32') {
    env.PATH = windowsExecutionPath(env.PATH, host);
    if (env.HOME) env.HOME = msysPathToWindows(env.HOME) ?? env.HOME;
  }
  return { ...env, ...extra };
}

const psQuote = (s: string): string => `'` + s.replace(/'/g, `''`) + `'`;

export interface ShellRunResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  /** Working directory after the command (tracked for session persistence). */
  cwd?: string;
  timed_out?: boolean;
}

interface Waiter {
  marker: string;
  resolve: (r: ShellRunResult) => void;
  timer: NodeJS.Timeout;
}

/**
 * The process backend of one persistent shell, swappable so the SAME
 * marker/serialization machinery drives both a plain Node spawn and the
 * ACL-sandboxed koffi spawn (SandboxedPersistentShell).
 */
export interface ShellProcessBackend {
  /** Write one line to the shell's stdin (a Buffer is sent as-is, already encoded). */
  write(line: string | Buffer): void;
  /** Stdout data listener. Real process backends hand over raw bytes; the shell decodes them. */
  onStdout(cb: (chunk: string | Buffer) => void): void;
  /** Stderr data listener (string chunks). */
  onStderr(cb: (chunk: string | Buffer) => void): void;
  /** Exit listener; code null on signal/spawn failure. */
  onExit(cb: (code: number | null) => void): void;
  /** Kill the process and release backend resources (idempotent). */
  kill(): void;
}

/** The default backend: a plain Node child process. */
function nodeBackend(bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): ShellProcessBackend {
  const proc = spawn(bin, args, { cwd, env, windowsHide: true });
  return {
    write: (line) => proc.stdin?.write(line),
    onStdout: (cb) => proc.stdout?.on('data', (d: Buffer) => cb(d)),
    onStderr: (cb) => proc.stderr?.on('data', (d: Buffer) => cb(d)),
    onExit: (cb) => {
      proc.on('exit', (code) => cb(code));
      proc.on('error', () => cb(null));
    },
    kill: () => {
      if (proc.pid === undefined || proc.exitCode !== null || proc.signalCode !== null) return;
      if (process.platform === 'win32') {
        // Kill the owned tree before its root disappears; killing only the
        // PowerShell root leaves native commands running after revocation.
        const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
        const stopped = spawnSync(taskkill, ['/PID', String(proc.pid), '/T', '/F'], {
          windowsHide: true, stdio: 'ignore', timeout: 5000,
        });
        if (stopped.error || stopped.status !== 0) {
          try { process.kill(proc.pid, 0); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return; }
          throw new Error('Owned PowerShell process-tree cleanup could not be confirmed');
        }
      } else {
        proc.kill();
      }
    },
  };
}

export interface PersistentShellOptions {
  cwd: string;
  bin: string;
  timeoutMs?: number;
  /** Custom process backend factory (the ACL sandbox injects a confined one). */
  backend?: (cwd: string) => ShellProcessBackend;
  /**
   * Detect the console code page the shell really uses (Windows only) and
   * speak it on stdin/stdout. Default: on for the built-in process backend;
   * the ACL sandbox turns it on for its confined backend.
   */
  detectCodePage?: boolean;
}

/** Longest wait for the code-page probe before falling back to UTF-8. */
const PROBE_TIMEOUT_MS = 15_000;

export class PersistentShell {
  private proc: ShellProcessBackend | null = null;
  private buffer = '';
  private stderr = '';
  private waiter: Waiter | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private lastMarker = '';
  /** Encoder for stdin once the code page is known; null while probing or when not probing. */
  private encode: ((text: string) => Buffer) | null = null;
  private probing = false;
  private queued: string[] = [];
  /** Code page detected for the current shell process (diagnostics). */
  codePage: number | null = null;

  constructor(private readonly opts: PersistentShellOptions) {
    this.cwd = opts.cwd;
    if (opts.timeoutMs !== undefined) this.defaultTimeoutMs = opts.timeoutMs;
  }

  cwd: string;
  private defaultTimeoutMs = 300_000;

  private alive(): boolean {
    return this.proc !== null;
  }

  private failWaiter(err: Error, exitCode = -1, stdout = ''): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      clearTimeout(w.timer);
      w.resolve({ stdout, stderr: err.message, exit_code: exitCode });
    }
  }

  private spawnShell(): void {
    const backend = this.opts.backend
      ? this.opts.backend(this.cwd)
      : nodeBackend(this.opts.bin, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'], this.cwd, powerShellEnvironment());
    this.proc = backend;
    this.buffer = '';
    this.stderr = '';
    this.encode = null;
    this.queued = [];
    this.codePage = null;
    const deliverOut = (text: string): void => { if (this.proc === backend && text) this.onData(text); };
    const deliverErr = (text: string): void => {
      if (this.proc !== backend || !text) return;
      this.stderr += text;
      this.tryComplete();
    };
    // Legacy/test backends hand over strings: pass them through untouched.
    let outDecode: (b: Buffer) => string = streamDecoder(UTF8);
    let errDecode: (b: Buffer) => string = streamDecoder(UTF8);
    const probe = process.platform === 'win32' && (this.opts.detectCodePage ?? !this.opts.backend);
    this.probing = probe;
    let rawOut = Buffer.alloc(0);
    const rawErr: Buffer[] = [];
    const tag = `BHCP_${randomBytes(6).toString('hex')}`;
    let probeTimer: NodeJS.Timeout | undefined;
    const settle = (cp: number, pendingOut: Buffer): void => {
      if (!this.probing || this.proc !== backend) return;
      clearTimeout(probeTimer);
      this.probing = false;
      this.codePage = cp;
      outDecode = streamDecoder(cp);
      errDecode = streamDecoder(cp);
      this.encode = (text) => encodeShellInput(cp, text);
      deliverErr(rawErr.map((b) => errDecode(b)).join(''));
      rawErr.length = 0;
      deliverOut(outDecode(pendingOut));
      const queued = this.queued;
      this.queued = [];
      for (const line of queued) this.send(line);
    };
    backend.onStdout((chunk) => {
      if (this.proc !== backend) return;
      if (typeof chunk === 'string') { deliverOut(chunk); return; }
      if (!this.probing) { deliverOut(outDecode(chunk)); return; }
      rawOut = Buffer.concat([rawOut, chunk]);
      const start = rawOut.indexOf(`${tag}<`);
      const end = start === -1 ? -1 : rawOut.indexOf(`>${tag}`, start);
      if (end === -1) { if (rawOut.length > 64 * 1024) settle(UTF8, rawOut); return; }
      const cp = detectCodePage(rawOut.subarray(start + tag.length + 1, end)) ?? UTF8;
      let rest = rawOut.subarray(end + tag.length + 1);
      if (rest[0] === 0x0d) rest = rest.subarray(1);
      if (rest[0] === 0x0a) rest = rest.subarray(1);
      settle(cp, Buffer.concat([rawOut.subarray(0, start), rest]));
    });
    backend.onStderr((chunk) => {
      if (this.proc !== backend) return;
      if (typeof chunk === 'string') { deliverErr(chunk); return; }
      if (this.probing) { rawErr.push(chunk); return; }
      deliverErr(errDecode(chunk));
    });
    if (probe) {
      // ASCII-only line (works under ConstrainedLanguage): the shell renders the
      // probe characters in its own code page, which identifies that code page.
      backend.write(`Write-Host ${psAsciiString(`${tag}<${PROBE_TEXT}>${tag}`)}\n`);
      probeTimer = setTimeout(() => settle(UTF8, rawOut), PROBE_TIMEOUT_MS);
      probeTimer.unref?.();
    }
    backend.onExit((code) => {
      // A replaced process can report exit/data after the next run has started.
      if (this.proc !== backend) return;
      this.proc = null;
      // `exit` in the user command terminates the host process. Surface the
      // REAL exit code (not a blanket -1) plus whatever the command printed,
      // and say the session reset — the caller must not mistake this for a
      // command failure or silently lose state.
      const flushed = this.outputBeforeMarker(this.buffer);
      this.buffer = '';
      this.failWaiter(
        new Error(`persistent session ended by the command (exit ${code ?? 'signal'}); shell state was reset — the next call starts a fresh shell`),
        code ?? -1,
        flushed,
      );
    });
  }

  /** Write to the shell in its code page; lines wait while the code page is still being probed. */
  private send(text: string): void {
    if (!this.proc) return;
    if (this.probing) { this.queued.push(text); return; }
    this.proc.write(this.encode ? this.encode(text) : text);
  }

  /** Failure paths may run after only one fence arrived; never expose its framing. */
  private outputBeforeMarker(value: string, marker = this.waiter?.marker): string {
    const index = marker ? value.indexOf(marker) : -1;
    return (index < 0 ? value : value.slice(0, index)).replace(/\r/g, '');
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    this.tryComplete();
  }

  private tryComplete(): void {
    const w = this.waiter;
    if (!w) return;
    const idx = this.buffer.indexOf(w.marker);
    if (idx === -1) return;
    const body = this.buffer.slice(0, idx);
    const tail = this.buffer.slice(idx + w.marker.length);
    const nl = tail.indexOf('\n');
    if (nl === -1) return; // wait for the whole line, including fragmented CRLF
    const errIdx = this.stderr.indexOf(w.marker);
    if (errIdx === -1) return;
    const errTail = this.stderr.slice(errIdx + w.marker.length);
    // cmd.exe's `echo marker 1>&2` preserves one separator space before CRLF.
    // Accept horizontal whitespace only; arbitrary text after the marker still
    // cannot satisfy the fence.
    const errLineEnd = /^[\t ]*(?:\r\n|\n)/.exec(errTail)?.[0].length ?? 0;
    if (!errLineEnd) return;
    // Each pipe is ordered independently. Both fences are needed before the
    // shared buffers can be consumed and the next queued command admitted.
    const codeLine = tail.slice(0, nl).trim();
    this.buffer = tail.slice(nl + 1);
    // sentinel line: "code=<exit>;pwd=<cwd>". LASTEXITCODE is empty for
    // cmdlets (cd/echo), so label both fields — a bare "$code $pwd" would
    // misparse the whole line as the exit code when the code is blank.
    const sp = codeLine.indexOf(';');
    const codePart = sp === -1 ? codeLine : codeLine.slice(0, sp);
    const pwdPart = sp === -1 ? '' : codeLine.slice(sp + 1);
    const exit = Number.parseInt(codePart.replace(/^code=/, ''), 10);
    // ASCII UTF-16 code units survive legacy console code pages (including emoji).
    // Keep pwd= support for existing backend fixtures and older framing.
    const hex = pwdPart.startsWith('pwd16=') ? pwdPart.slice(6) : undefined;
    const reported = hex !== undefined
      ? (hex.length <= 131072 && /^(?:[a-f0-9]{4})+$/i.test(hex)
        ? hex.match(/.{4}/g)!.map(unit => String.fromCharCode(Number.parseInt(unit, 16))).join('') : undefined)
      : pwdPart.startsWith('pwd=') ? pwdPart.slice(4).trim() : undefined;
    // only a directory that exists: a mis-decoded path would poison every respawn
    const cwd = reported && existingDir(reported) ? reported : undefined;
    // Track the shell's cwd so a respawn (`exit`, crash, timeout kill) lands
    // back in the directory the session had reached, not the spawn-time one.
    if (cwd) this.cwd = cwd;
    const out = body.replace(/\r/g, '');
    const err = this.stderr.slice(0, errIdx).replace(/\r/g, '');
    this.stderr = errTail.slice(errLineEnd);
    this.waiter = null;
    clearTimeout(w.timer);
    w.resolve({ stdout: out, stderr: err, exit_code: Number.isNaN(exit) ? 0 : exit, cwd });
  }

  private ensure(): void {
    if (this.alive()) return;
    this.spawnShell();
  }

  /** Serialize runs so the shared buffer/marker are never interleaved. The deadline includes queue wait. */
  run(command: string, timeoutMs?: number, env?: Record<string, string>): Promise<ShellRunResult> {
    const limit = Math.max(1, timeoutMs ?? this.defaultTimeoutMs);
    const queuedAt = performance.now();
    const deadline = queuedAt + limit;
    let expired = false;
    let queueTimer!: NodeJS.Timeout;
    const queueTimeout = new Promise<ShellRunResult>((resolve) => {
      queueTimer = setTimeout(() => {
        expired = true;
        resolve({
          stdout: '',
          stderr: `timeout after ${limit} ms while waiting for the previous pwsh command; this command was not started`,
          exit_code: -1,
          timed_out: true,
          cwd: this.cwd,
        });
      }, limit);
      // Pending calls own a deadline: native Win32 handles are not libuv handles,
      // so an unreferenced timer can let Node exit before settling this promise.
    });
    const task = this.chain.then(() => {
      // A delayed timers phase must not admit work whose monotonic deadline has passed.
      if (expired || performance.now() >= deadline) {
        return {
          stdout: '',
          stderr: `timeout after ${limit} ms while waiting for the previous pwsh command; this command was not started`,
          exit_code: -1,
          timed_out: true,
          cwd: this.cwd,
        } satisfies ShellRunResult;
      }
      clearTimeout(queueTimer);
      const queuedMs = Math.max(0, performance.now() - queuedAt);
      return this.runOne(command, Math.max(1, limit - queuedMs), env, limit, queuedMs);
    });
    this.chain = task.catch(() => undefined);
    return Promise.race([task, queueTimeout]);
  }

  private runOne(command: string, timeoutMs: number, env?: Record<string, string>, totalTimeoutMs = timeoutMs, queuedMs = 0): Promise<ShellRunResult> {
    return new Promise<ShellRunResult>((resolve) => {
      this.ensure();
      let prefix = '';
      for (const [k, v] of Object.entries(env ?? {})) {
        prefix += `$env:${k} = ${psQuote(v)}\n`;
      }
      const marker = `BH_END_${randomBytes(6).toString('hex')}_`;
      this.lastMarker = marker;
      const w: Waiter = {
        marker,
        resolve,
        timer: setTimeout(() => {
          if (this.waiter && this.waiter.marker === marker) {
            this.waiter = null;
            const stdout = this.outputBeforeMarker(this.buffer, marker);
            const stderr = this.outputBeforeMarker(this.stderr, marker);
            // Reset the owned shell before returning a terminal timeout result.
            this.kill();
            const timing = queuedMs > 0 ? ` (${queuedMs} ms queued, ${timeoutMs} ms executing)` : '';
            resolve({ stdout, stderr: `${stderr}${stderr ? '\n' : ''}timeout after ${totalTimeoutMs} ms${timing}; shell state was reset`, exit_code: -1, timed_out: true, cwd: this.cwd });
          }
        }, timeoutMs),
      };
      // Keep the event loop alive only until this command completes or times out.
      // Idle shell polling remains unreferenced; completion clears this timer.
      this.waiter = w;
      // Zero $LASTEXITCODE before every command: cmdlets (echo, cd, ...) never
      // set it, so without this the marker reports the previous NATIVE
      // command's code and callers retry commands that actually succeeded.
      // Use the absolute inbox command processor for the stderr fence. Direct
      // .NET calls are blocked by ConstrainedLanguage, while process.execPath is
      // VS Code's Electron binary in a packaged daemon and would require leaking
      // ELECTRON_RUN_AS_NODE into the user shell. The ASCII-only marker is safe
      // for cmd.exe and keeps the two output pipes independently ordered.
      let fenceCommand: string;
      if (process.platform === 'win32') {
        const commandShell = resolveWindowsCommandShell();
        if (!commandShell) {
          this.waiter = null;
          clearTimeout(w.timer);
          resolve({ stdout: '', stderr: 'Windows command shell is unavailable for stderr synchronization', exit_code: -1, cwd: this.cwd });
          return;
        }
        fenceCommand = `& ${psQuote(commandShell)} /d /s /c ${psQuote(`echo ${marker} 1>&2`)}`;
      } else {
        // Persistent PowerShell is Windows-only in production, but the pure
        // lifecycle suite also runs on POSIX. Keep its fallback self-contained.
        const payload = Buffer.from(marker + '\n', 'utf8').toString('base64');
        fenceCommand = `& ${psQuote(process.execPath)} -e ${psQuote(`process.stderr.write(Buffer.from('${payload}','base64'))`)}`;
      }
      this.send(`${prefix}$global:LASTEXITCODE = 0\n${command}\n$__bh_exit = $LASTEXITCODE\n${fenceCommand}\nWrite-Host "${marker}code=$__bh_exit;pwd16=$(-join (([string]$PWD).ToCharArray() | Microsoft.PowerShell.Core\\ForEach-Object { '{0:x4}' -f [int]$_ }))"\n`);
    });
  }

  kill(): void {
    const backend = this.proc;
    const output = this.outputBeforeMarker(this.buffer);
    this.proc = null;
    let cleanupFailed = false;
    try { backend?.kill(); } catch { cleanupFailed = true; }
    finally {
      // Disposing/resetting must settle the active promise even when the backend emits no exit event.
      this.failWaiter(new Error(cleanupFailed
        ? 'shell reset failed; process cleanup could not be confirmed'
        : 'shell was reset; the current command was interrupted'), -1, output);
      this.buffer = '';
      this.stderr = '';
    }
  }

  /**
   * Irreversibly tear the shell down INCLUDING backend-owned resources
   * (restricted tokens, grants). The base implementation equals kill();
   * SandboxedPersistentShell overrides it to release the ACL sandbox after
   * the process is gone. Call this when a session ends (revoke, mode switch,
   * daemon shutdown) — call kill() alone only when the shell may respawn.
   */
  dispose(): void {
    this.kill();
  }
}

/** Find a PowerShell binary (pwsh 7 preferred, Windows PowerShell as fallback). */
export function detectPwshBin(): string | null { return detectPowerShell()?.executable ?? null; }

export function detectPowerShell(): { executable: string; version: string } | null {
  if (process.platform !== 'win32') return null;
  const candidates: string[] = [];
  const seen = new Set<string>();
  const add = (candidate: string | undefined) => {
    if (!candidate) return;
    const resolved = resolveWindowsExecutable(candidate);
    if (!resolved) return;
    const key = resolved.toLowerCase();
    if (!seen.has(key)) { seen.add(key); candidates.push(resolved); }
  };
  add(process.env.BLACKHOLE_PWSH);
  add('pwsh.exe');
  const root = windowsSystemRoot();
  if (root) add(path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
  add('powershell.exe');

  for (const bin of candidates) {
    try {
      const probe = spawnSync(bin, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], {
        timeout: 8_000, encoding: 'utf8', windowsHide: true,
      });
      const version = (probe.stdout ?? '').trim();
      if (!probe.error && probe.status === 0 && /^\d+(?:\.\d+){1,3}$/.test(version)) return { executable: bin, version };
    } catch {
      /* try next */
    }
  }
  return null;
}

function existingDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}
