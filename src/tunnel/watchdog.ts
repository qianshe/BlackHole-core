import type { DaemonDeps } from '../deps.js';

/**
 * Channel watchdog: the public tunnel is an extension-driven affordance —
 * when every VS Code window running this extension is gone (or a CLI-spawned
 * channel stops sending heartbeats), the channel closes itself. The daemon
 * itself keeps serving locally.
 *
 * Contract: heartbeat senders (extension poller, CLI `tunnel` commands)
 * POST /api/heartbeat at least every ~15s. A channel whose heartbeats went
 * stale for STALE_MS is stopped once. A channel the operator started stays
 * remembered (tunnel/resume.ts): the next heartbeat brings it back.
 */
const TICK_MS = 15_000;
/** Exported so user-facing copy (CLI note) derives the number instead of
 *  restating it and drifting. */
export const STALE_MS = 45_000;

export function startChannelWatchdog(deps: DaemonDeps): { stop(): void } {
  let stopping = false;
  const timer = setInterval(() => {
    // An open Local Web page (a live /web-api/v1/presence response) counts as a window.
    const staleFor = deps.webPresence?.size ? 0 : Date.now() - deps.lastHeartbeatAt;
    const live = deps.tunnel.status === 'starting' || deps.tunnel.status === 'online' || deps.tunnel.status === 'unverified';
    if (staleFor > STALE_MS && live) {
      deps.log(`watchdog: no extension heartbeat for ${Math.round(staleFor / 1000)}s — stopping the public channel (daemon stays local-only)`);
      void deps.tunnel.stop().catch(() => undefined);
    }
    if (staleFor > STALE_MS && deps.openaiTunnel?.live) {
      deps.log(`watchdog: no extension heartbeat for ${Math.round(staleFor / 1000)}s — stopping the OpenAI tunnel`);
      void deps.openaiTunnel.stop(null).catch(() => undefined);
    }
  }, TICK_MS);
  return {
    stop() {
      if (stopping) return;
      stopping = true;
      clearInterval(timer);
    },
  };
}
