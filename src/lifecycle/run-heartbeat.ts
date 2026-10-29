import fs from 'node:fs';
import path from 'node:path';
import type { DaemonDeps } from '../deps.js';

const BEAT_MS = 10_000;

/**
 * Liveness lease for a Manager-spawned Core.
 *
 * The Manager cannot trust a recorded PID: Windows recycles them, so a stale
 * run record can end up naming a live but unrelated process. While this Core
 * runs it refreshes a small lease file; once the process is killed or the
 * machine reboots the file stops advancing, which is evidence the Manager can
 * act on without ever killing or duplicating a live Core.
 *
 * This is advisory state only. It carries no credential, never authorizes a
 * stop or a spawn by itself, and is written only when the Manager supplied an
 * absolute path for a managed lifecycle.
 */
export function startRunHeartbeat(
  deps: Pick<DaemonDeps, 'runtimeIdentity' | 'startFingerprint' | 'daemonId'>,
): { stop(): void } {
  const noop = { stop() {} };
  const file = process.env.BLACKHOLE_RUN_HEARTBEAT;
  const identity = deps.runtimeIdentity;
  if (identity?.lifecycleState !== 'managed' || !deps.startFingerprint || !deps.daemonId) return noop;
  if (!file || !path.isAbsolute(file)) return noop;
  const payload = `${JSON.stringify({
    schemaVersion: 1, dataRootId: identity.dataRootId, startFingerprint: deps.startFingerprint,
    daemonId: deps.daemonId, pid: process.pid, at: Date.now(),
  })}\n`;
  const beat = (): void => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, payload, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temp, file);
    } catch { /* advisory: the Manager then falls back to older evidence */ }
  };
  beat();
  const timer = setInterval(beat, BEAT_MS);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
      try { fs.rmSync(file, { force: true }); } catch { /* advisory */ }
    },
  };
}
