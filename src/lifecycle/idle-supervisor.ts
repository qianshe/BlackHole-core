import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { DaemonDeps } from '../deps.js';

const TICK_MS = 10_000;
const MAX_REPLY_BYTES = 4096;

/**
 * Best-effort trigger, not a shutdown authority. Each short-lived Manager
 * invocation checks the exact daemon incarnation, all host leases, a 30-second
 * reconnect grace and the daemon's signed maintenance idle gate. The Core
 * cannot issue a lifecycle token or delete Manager state itself.
 *
 * Stop watching when daemon shutdown begins. Never kill a Manager that may
 * already have accepted a signed Stop; an unknown outcome is a recovery case.
 */
export function startManagedIdleSupervisor(
  deps: Pick<DaemonDeps, 'runtimeIdentity' | 'startFingerprint' | 'daemonId' | 'cfg' | 'log'>,
): { stop(): void } {
  const noop = { stop() {} };
  if (deps.runtimeIdentity?.lifecycleState !== 'managed' || !deps.startFingerprint || !deps.daemonId
    || process.env.BLACKHOLE_CORE_IDLE_SHUTDOWN === 'off') return noop;

  // The Manager bundled in the same signed, versioned Core is the only
  // implementation we invoke. No executable, host or URL is taken from Web.
  const entry = path.resolve(path.dirname(process.argv[1] ?? ''), '..', 'host', 'core-manager-cli.mjs');
  const trust = process.env.BH_CORE_TRUST_CONFIG;
  if (!path.isAbsolute(process.argv[1] ?? '') || !trust || !path.isAbsolute(trust)
    || !fs.existsSync(entry) || !fs.existsSync(trust)) {
    deps.log('core idle shutdown disabled: signed Manager/trust path unavailable');
    return noop;
  }
  const request = JSON.stringify({ command: 'stop-idle-core', request: {
    port: deps.cfg.port, daemonId: deps.daemonId, dataRootId: deps.runtimeIdentity.dataRootId,
    descriptorHash: deps.runtimeIdentity.descriptorHash, startFingerprint: deps.startFingerprint,
  } });
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) {
    if (['NODE_OPTIONS', 'NODE_PATH'].includes(name.toUpperCase())) delete env[name];
  }
  let closed = false;
  let inFlight = false;
  let lastError = '';
  let lastState = '';
  const tick = (): void => {
    if (closed || inFlight) return;
    inFlight = true;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(process.execPath, [entry], {
        // The child must outlive the daemon it is stopping. Without an
        // independent process group, Windows can terminate the Manager with
        // its parent after Core closes the port, leaving a 'stopping' journal.
        cwd: path.dirname(entry), env, windowsHide: true, detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      inFlight = false;
      return;
    }
    child.unref();
    let output = '', overflow = false;
    const collect = (chunk: Buffer): void => {
      if (Buffer.byteLength(output) + chunk.length > MAX_REPLY_BYTES) { overflow = true; return; }
      output += chunk.toString('utf8');
    };
    child.stdout!.on('data', collect);
    child.stderr!.resume(); // Manager errors are fixed-code; never log untrusted details.
    child.stdin!.on('error', () => {}); // If Manager exits, no retry in this invocation.
    child.once('error', () => { inFlight = false; });
    child.once('close', code => {
      inFlight = false;
      if (closed) return;
      let reply: { ok?: boolean; result?: { state?: string }; error?: { code?: string } } | undefined;
      if (!overflow) { try { reply = JSON.parse(output); } catch { /* unknown result */ } }
      if (code === 0 && reply?.ok === true) {
        lastError = '';
        const state = reply.result?.state;
        if (state === 'grace' || state === 'work') {
          if (state !== lastState) deps.log('core idle shutdown: ' + state);
        }
        if (typeof state === 'string') lastState = state;
        return;
      }
      const error = reply?.error?.code;
      const safe = typeof error === 'string' && /^[a-z][a-z0-9_]{0,99}$/.test(error) ? error : 'manager_unavailable';
      if (safe !== lastError) { lastError = safe; deps.log('core idle shutdown deferred: ' + safe); }
      // An unclear signed maintenance result leaves a Manager journal and
      // cannot be retried: the next call sees maintenance_recovery_required.
    });
    child.stdin!.end(request);
  };
  const timer = setInterval(tick, TICK_MS);
  timer.unref();
  return { stop() { closed = true; clearInterval(timer); } };
}
