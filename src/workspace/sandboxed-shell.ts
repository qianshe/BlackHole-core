import koffi from 'koffi';
import { AclSandbox, streamPipe } from '../win32/acl-sandbox.js';
import { cleanupOrphanSandboxTemps as cleanupOrphan } from '../win32/acl-sandbox.js';
import { allocUint32, decodeUint32, win32, type NativePtr, type Win32Bindings } from '../win32/ffi.js';
import { PersistentShell, powerShellEnvironment, type ShellProcessBackend, type ShellRunResult } from './pwsh.js';

/** Re-export: the router reaches the orphan sweep through this module. */
export { cleanupOrphan as cleanupOrphanSandboxTemps };

/**
 * The ACL-confined persistent PowerShell: the SAME marker/serialization
 * machinery as PersistentShell, but the shell process runs under a
 * WRITE_RESTRICTED token. workspace-write carries the workspace + private
 * temp capability SIDs; read-only carries NO write SID (the kernel denies
 * every write even when a heuristic misses the command). Fail-closed: if the
 * restricted token or grants cannot be established, the constructor throws
 * and no shell ever spawns unrestricted.
 */
export class SandboxedPersistentShell extends PersistentShell {
  private readonly sandbox: AclSandbox;
  private disposed = false;

  constructor(opts: {
    cwd: string;
    bin: string;
    workspaceRoot: string;
    /** The session's file-effect mode — selects the restricting-SID list. */
    mode: 'read-only' | 'workspace-write';
    /** M4.6 writableDirs：额外内核写授权目录（canonical，须已存在）。 */
    extraWritableDirs?: readonly string[];
    timeoutMs?: number;
    log?: (line: string) => void;
  }) {
    const sandbox = new AclSandbox({ mode: opts.mode, workspaceRoot: opts.workspaceRoot, extraWritableDirs: opts.extraWritableDirs });
    sandbox.init();
    super({
      cwd: opts.cwd,
      bin: opts.bin,
      timeoutMs: opts.timeoutMs,
      // the backend closure runs lazily at the first ensure(), so the sandbox
      // is guaranteed initialized before any spawn
      backend: (cwd) => {
        const backend = confinedBackend(sandbox.spawn({
          command: opts.bin,
          args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'],
          cwd,
          env: powerShellEnvironment(),
        }));
        // The ambient temp root is NOT a granted tree; point the shell's
        // TEMP/TMP at the sandbox's private dir as its very first stdin line
        // (per-shell state — concurrent sessions never clobber one another).
        // read-only grants no temp, so the variables stay ambient (writes
        // there are denied by the token anyway).
        const tempDir = sandbox.tempDir;
        if (tempDir) backend.write(`$env:TEMP = ${JSON.stringify(tempDir)}; $env:TMP = $env:TEMP\n`);
        return backend;
      },
    });
    this.sandbox = sandbox;
    opts.log?.(`sandbox: ACL ${opts.mode} write-restriction active`);
  }

  /** The session's private temp dir; the shell layer rewrites TEMP/TMP to it. */
  get tempDir(): string | null {
    return this.sandbox.tempDir;
  }

  /**
   * Run one command. A disposed shell (session revoked / mode switched /
   * daemon shutdown) refuses with a clear error instead of letting the
   * respawn path hit the disposed sandbox's low-level failure — the
   * fail-closed outcome is the same, the diagnosis is not.
   */
  override run(command: string, timeoutMs?: number, env?: Record<string, string>): Promise<ShellRunResult> {
    if (this.disposed) {
      return Promise.resolve({
        stdout: '',
        stderr: 'sandbox: the session\'s shell was torn down (mode switched or session ended); retry on the new session state',
        exit_code: -1,
      });
    }
    return super.run(command, timeoutMs, env);
  }

  /**
   * Kill the current shell PROCESS but keep the sandbox (token + standing
   * grants) alive: a respawn reuses them, so timeout resets and `exit`
   * recoveries do not pay a fresh token/grant cycle.
   */
  override kill(): void {
    super.kill();
  }

  /**
   * Irreversibly release the sandbox: kill the process FIRST (closing the
   * kill-on-close job terminates the child), THEN revoke the revocable temp
   * grant and remove the private temp dir — revoking an ACE under a live
   * child would strip its remaining write allowance mid-run, and removing a
   * temp dir the child still holds fails on Windows.
   */
  override dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.kill();
    this.sandbox.dispose();
  }
}

/** Keep native pipe I/O and exit waiting off the daemon event loop so its deadline can fire. */
function confinedBackend(native: { pid: number; process: NativePtr; stdoutRead: NativePtr; stderrRead: NativePtr; stdinWrite: NativePtr; job: NativePtr }): ShellProcessBackend {
  const api = win32();
  let stdoutCb: ((chunk: string) => void) | undefined;
  let stderrCb: ((chunk: string) => void) | undefined;
  let exitCb: ((code: number | null) => void) | undefined;
  let stopped = false, exiting = false, jobClosed = false;
  let writes: Promise<void> = Promise.resolve();
  const out = streamPipe(api, native.stdoutRead, chunk => stdoutCb?.(chunk.toString('utf8')));
  const err = streamPipe(api, native.stderrRead, chunk => stderrCb?.(chunk.toString('utf8')));
  const close = (handle: NativePtr) => { try { api.closeHandle(handle); } catch { /* already released */ } };
  const closeJob = () => { if (!jobClosed) { jobClosed = true; close(native.job); } };
  const finish = (code: number | null) => {
    if (stopped) return;
    stopped = true;
    clearInterval(poll);
    // Terminate the owned job first. This wakes a blocked async stdin write.
    // Do not close/reuse its handle while WriteFile is still operating on it.
    closeJob();
    out.stop(); err.stop(); close(native.process);
    void writes.then(() => close(native.stdinWrite), () => close(native.stdinWrite));
    exitCb?.(code);
  };
  const poll = setInterval(() => {
    if (stopped || exiting) return;
    try {
      const state = api.waitForSingleObject(native.process, 0);
      if (state === 258) return; // WAIT_TIMEOUT: still running, never block JS.
      if (state !== 0) { finish(null); return; }
      const slot = allocUint32();
      let code: number | null = null;
      try { if (api.getExitCodeProcess(native.process, slot)) code = decodeUint32(slot); }
      finally { koffi.free(slot); }
      exiting = true;
      closeJob(); // descendants must not hold output pipes open indefinitely
      const drainDeadline = setTimeout(() => finish(code), 250);
      void Promise.all([out.done.catch(() => undefined), err.done.catch(() => undefined)]).then(() => {
        clearTimeout(drainDeadline); finish(code);
      });
    } catch { finish(null); }
  }, 25);
  poll.unref();

  return {
    write: line => {
      writes = writes.then(async () => {
        const input = Buffer.from(line, 'utf8');
        for (let offset = 0; offset < input.length && !stopped;) {
          const chunk = input.subarray(offset, offset + 8192);
          offset += await writePipe(api, native.stdinWrite, chunk);
        }
      });
      void writes.catch(() => finish(null));
    },
    onStdout: cb => { stdoutCb = cb; },
    onStderr: cb => { stderrCb = cb; },
    onExit: cb => { exitCb = cb; },
    kill: () => finish(null),
  };
}

/** Koffi runs the blocking Win32 write on its native worker pool, not on the JS timer thread. */
async function writePipe(api: Win32Bindings, handle: NativePtr, chunk: Buffer): Promise<number> {
  const slot = allocUint32();
  const nativeWrite = api.writeFile as typeof api.writeFile & {
    async(file: NativePtr, buffer: Buffer, count: number, bytes: NativePtr, overlapped: null,
      callback: (error: Error | null, result: number) => void): void;
  };
  try {
    const ok = await new Promise<number>((resolve, reject) => {
      nativeWrite.async(handle, chunk, chunk.length, slot, null, (error, result) => error ? reject(error) : resolve(result));
    });
    const count = decodeUint32(slot);
    if (!ok || count < 1 || count > chunk.length) throw new Error('shell stdin write failed');
    return count;
  } finally { koffi.free(slot); }
}
