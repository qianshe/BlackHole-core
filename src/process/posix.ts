import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';
import { SandboxError, classifySandboxStderr, prepareShellProcess, shellEnvironment, type ShellProcessPlan } from '../workspace/posix-sandbox.js';
import { detectShell, posixShellArgs } from '../workspace/shell.js';
import { ProcessError, type BackendCallbacks, type ProcessHandle, type ProcessSpec } from './types.js';

interface Receipt { type: 'result'; exitCode: number | null; signal: NodeJS.Signals | null; reason: string; started: boolean; group: boolean }

/** Both tsc/ESM and the installed single-file daemon use a shipped, trusted sidecar. */
export function supervisorPath(): string {
  return typeof __dirname === 'string'
    ? path.join(__dirname, 'process-supervisor.cjs')
    : fileURLToPath(new URL('./supervisor.cjs', import.meta.url));
}

export function startPosixProcess(spec: ProcessSpec, callbacks: BackendCallbacks, shell = detectShell()?.executable ?? '/bin/sh'): ProcessHandle {
  if (!['linux', 'darwin'].includes(process.platform)) throw new ProcessError('unsupported_platform', 'POSIX backend requires Linux or macOS');
  const sidecar = supervisorPath();
  if (!fs.existsSync(sidecar)) throw new ProcessError('runtime_asset_missing', 'The managed process supervisor is missing; repair the installation');
  // This is the same file-write policy as finite execution. A missing sandbox
  // throws before any supervisor or command is created; never run unconfined.
  const base = path.basename(shell).toLowerCase();
  const shellArgs = posixShellArgs(base === 'bash' || base === 'zsh' ? base : 'sh', spec.script);
  let plan:ShellProcessPlan;
  try {
    plan = prepareShellProcess({ mode: spec.mode, workspace: spec.workspace, extraWritableDirs: spec.writableDirs,
      argv: [shell, ...shellArgs] });
  } catch (error) {
    if (error instanceof SandboxError) throw new ProcessError(error.code, error.message);
    throw error;
  }
  let child;
  try {
    child = fork(sidecar, [], { execArgv: [], cwd: spec.cwd, detached: true,
      env: { ...shellEnvironment(), ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  } catch (error) { plan.cleanup(); throw error; }
  let closed = false, planSent = false, stopRequested = false, drainTimedOut = false;
  let receipt: Receipt | undefined, spawnError: string | undefined;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  let readyResolve!: () => void, doneResolve!: () => void;
  const ready = new Promise<void>(resolve => { readyResolve = resolve; });
  const done = new Promise<void>(resolve => { doneResolve = resolve; });
  const fault = (message: string) => { callbacks.fault(message); readyResolve(); };
  const send = (value: object) => {
    if (!child.connected) return;
    try { child.send(value, error => { if (error && !closed) fault('Supervisor control channel unavailable'); }); }
    catch { if (!closed) fault('Supervisor control channel unavailable'); }
  };
  const requestStop = () => { stopRequested = true; send({ type: 'stop' }); };
  const startupTimer = setTimeout(() => { fault('Supervisor startup deadline exceeded'); requestStop(); }, 10000);
  let stderrTail='';
  child.stdout?.on('data', (bytes: Buffer) => callbacks.output('stdout', bytes));
  child.stderr?.on('data', (bytes: Buffer) => {
    stderrTail=(stderrTail+bytes.toString('utf8')).slice(-8192);
    callbacks.output('stderr', bytes);
  });
  child.on('message', raw => {
    if (!raw || typeof raw !== 'object') return;
    const message = raw as { type?: string };
    if (message.type === 'ready') {
      if (stopRequested) requestStop();
      else if (!planSent) { planSent = true; send({ type: 'start', argv: plan.argv, cwd: spec.cwd, env: plan.env }); }
    } else if (message.type === 'started') {
      clearTimeout(startupTimer); readyResolve();
    } else if (message.type === 'result') receipt = raw as Receipt;
  });
  child.once('error', error => {
    spawnError=error.message;stderrTail=(stderrTail+error.message+'\n').slice(-8192);
    callbacks.output('stderr', Buffer.from(error.message + '\n'));
  });
  child.once('exit', () => {
    // A deliberately escaped descendant holding stdout cannot hang cleanup.
    // It is outside the foreground contract and must not yield a false success.
    drainTimer = setTimeout(() => {
      drainTimedOut = true; child.stdout?.destroy(); child.stderr?.destroy();
      fault('Supervisor exited but output pipes did not close; cleanup is unconfirmed');
    }, 2000);
  });
  child.once('close', (code, signal) => {
    closed = true; clearTimeout(startupTimer); if (drainTimer) clearTimeout(drainTimer);
    let confirmed = !drainTimedOut && (!planSent || Boolean(receipt && (receipt.group ? signal === 'SIGKILL' : code === 0)));
    if (confirmed) try { plan.cleanup(); } catch { confirmed = false; }
    // Output may quote errors even on success. Never let it overwrite a stop,
    // lost supervisor, or the native success result with a false launch failure.
    const sandboxFailure=receipt?.reason==='command_exited'
      ? classifySandboxStderr(stderrTail,plan.backend,spec.mode,receipt.exitCode) : undefined;
    callbacks.exit({ exitCode: receipt?.exitCode ?? null, signal: receipt?.signal ?? signal,
      reason: sandboxFailure?.code ?? receipt?.reason ?? (spawnError || !planSent ? 'spawn_failed' : 'supervisor_lost'), cleanupConfirmed: confirmed });
    readyResolve(); doneResolve();
  });
  return {
    pid: child.pid ?? 0,
    ready,
    async stop() {
      if (closed) return;
      requestStop();
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([done, new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new ProcessError('stop_failed', 'POSIX task termination has not been confirmed')), 5000);
      })]); } finally { if (deadline) clearTimeout(deadline); }
    },
  };
}
