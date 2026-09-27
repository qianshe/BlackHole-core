import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Set on the replacement process: wait for this pid to exit before binding the port. */
export const RESTART_WAIT_ENV = 'BLACKHOLE_RESTART_WAIT_PID';

type SpawnFn = typeof spawn;

/**
 * Start a replacement of this daemon with the same command line, environment
 * and working directory (so the start fingerprint is unchanged), detached and
 * logging to the same file VS Code uses. Resolves once the child is running;
 * the caller then shuts this process down and the child takes the port.
 */
export async function spawnReplacement(spawnFn: SpawnFn = spawn): Promise<ChildProcess> {
  const logFile = path.join(os.tmpdir(), 'blackhole-daemon.log');
  const fd = fs.openSync(logFile, 'a');
  try {
    const child = spawnFn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
      env: { ...process.env, [RESTART_WAIT_ENV]: String(process.pid) },
      cwd: process.cwd(),
      detached: true,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve());
      child.once('error', reject);
    });
    child.unref();
    return child;
  } finally {
    fs.closeSync(fd);
  }
}

/** In the replacement: block until the previous daemon released the port (bounded). */
export async function waitForPredecessor(timeoutMs = 15_000): Promise<void> {
  const pid = Number(process.env[RESTART_WAIT_ENV]);
  delete process.env[RESTART_WAIT_ENV];
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

interface RestartDeps {
  shutdown?: () => Promise<void>;
  events: { append(sessionId: string | null, type: string, data: Record<string, unknown>): unknown };
  log: (line: string) => void;
}

/**
 * Restart the daemon in place: used when settings that only apply at start
 * changed and no VS Code window is around to restart it. The replacement is
 * started first; if that fails this daemon keeps running.
 */
export async function restartSelf(deps: RestartDeps, source: string, spawnFn?: SpawnFn): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await spawnReplacement(spawnFn);
  } catch (e) {
    deps.log(`restart: replacement failed to start: ${e instanceof Error ? e.message : String(e)}`);
    return { ok: false, error: 'restart_failed' };
  }
  deps.events.append(null, 'daemon_restart_requested', { source });
  deps.log(`restart: requested by ${source}; handing the port to the replacement`);
  setTimeout(() => {
    void (deps.shutdown?.() ?? Promise.resolve()).catch(() => undefined).finally(() => process.exit(0));
  }, 100);
  return { ok: true };
}
