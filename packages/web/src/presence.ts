/**
 * Local Web presence: while the console is open, one tab per browser keeps a
 * long-lived GET /web-api/v1/presence response open, so the daemon's channel
 * watchdog treats this page like an open VS Code window (hidden tabs included).
 * Web Locks elect that tab; without them every tab holds its own stream.
 * Reconnects back off 1s -> 30s and reset after a stream that stayed up.
 */
export const PRESENCE_PATH = '/web-api/v1/presence';
export const PRESENCE_LOCK = 'blackhole-web-presence';
const MIN_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;
const HEALTHY_MS = 60_000;

type LockManagerLike = {
  request(name: string, options: { signal?: AbortSignal }, fn: () => Promise<void> | void): Promise<unknown>;
};
export interface PresenceEnv {
  fetch: typeof fetch;
  locks?: LockManagerLike;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  now: () => number;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

function defaultEnv(): PresenceEnv {
  const nav = typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { locks?: LockManagerLike });
  return { fetch: (...a) => fetch(...a), locks: nav?.locks, sleep: defaultSleep, now: () => Date.now() };
}

/** Starts holding presence; returns the stop function (safe to call twice). */
export function startPresence(env: PresenceEnv = defaultEnv()): () => void {
  const stop = new AbortController();
  const hold = async (): Promise<void> => {
    let delay = MIN_DELAY_MS;
    while (!stop.signal.aborted) {
      const started = env.now();
      try {
        const res = await env.fetch(PRESENCE_PATH, {
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { 'x-blackhole-web': '1' },
          signal: stop.signal,
        });
        if (res.ok && res.body) {
          const reader = res.body.getReader();
          while (!(await reader.read()).done) { /* comments only; the open response is the signal */ }
        }
      } catch { /* aborted, daemon restarting, or offline */ }
      if (stop.signal.aborted) break;
      if (env.now() - started >= HEALTHY_MS) delay = MIN_DELAY_MS;
      await env.sleep(delay, stop.signal);
      delay = Math.min(delay * 2, MAX_DELAY_MS);
    }
  };
  if (env.locks) {
    // Waits for the lock while another tab holds presence; aborting drops the queued request.
    void env.locks.request(PRESENCE_LOCK, { signal: stop.signal }, hold).catch(() => undefined);
  } else {
    void hold();
  }
  return () => stop.abort();
}
