import type { DaemonDeps } from '../deps.js';
import { managedCoreHasActiveWork } from '../lifecycle/idle-work.js';

/**
 * Legacy, non-managed daemons use extension/CLI heartbeats to decide whether
 * an otherwise idle public tunnel should close. For a managed Core, client
 * presence is tracked by the Manager's renewable leases and the signed idle
 * shutdown gate instead: a delayed Extension Host heartbeat is NOT evidence
 * that the operator turned off a channel. Managed channels therefore remain
 * under explicit user control for as long as the managed Core is alive.
 */
const TICK_MS = 15_000;
/** Exported so user-facing copy (CLI note) derives the number instead of
 *  restating it and drifting. */
export const STALE_MS = 45_000;

/** Only stop a public channel after lost host heartbeat if no ACTIVE work is
 * known. A lost VS Code lease cannot cut off a still-running remote Agent,
 * pending approval, background process or active Courier exchange.
 * Unknown activity state is NOT authorization to keep a public listener open:
 * unlike a Manager's local process stop, public exposure fails closed.
 */
export function channelWatchdogMayStop(
  deps: Pick<DaemonDeps, 'lastHeartbeatAt' | 'runtimeIdentity' | 'webPresence' | 'sessionActivity' |
    'sessions' | 'processes' | 'courier' | 'confirmations'>,
  now = Date.now(),
): boolean {
  // Managed Core idle shutdown already checks leases, running Agents and open
  // Web pages. A separate 45s channel watchdog would erroneously disconnect
  // a healthy, explicitly started named/quick/OpenAI channel during a sleeping
  // or temporarily blocked VS Code Extension Host. The Manager remains the
  // sole authority to stop an unused managed process.
  if (deps.runtimeIdentity?.lifecycleState === 'managed') return false;
  if (deps.webPresence?.size || now - deps.lastHeartbeatAt <= STALE_MS) return false;
  try { return !managedCoreHasActiveWork(deps); }
  catch { return true; }
}

export function startChannelWatchdog(deps: DaemonDeps): { stop(): void } {
  // Managed Core owns the channel; its signed Manager handles idle exit.
  // Do not keep a redundant tunnel-shutdown timer alive in that mode.
  if (deps.runtimeIdentity?.lifecycleState === 'managed') return { stop() {} };
  let stopping = false;
  const timer = setInterval(() => {
    // An open Local Web page (a live /web-api/v1/presence response) counts as a window.
    const staleFor = deps.webPresence?.size ? 0 : Date.now() - deps.lastHeartbeatAt;
    const live = deps.tunnel.status === 'starting' || deps.tunnel.status === 'online' || deps.tunnel.status === 'unverified';
    const canStop = channelWatchdogMayStop(deps);
    if (canStop && live) {
      deps.log(`watchdog: no extension heartbeat for ${Math.round(staleFor / 1000)}s — stopping the public channel (daemon stays local-only)`);
      void deps.tunnel.stop().catch(() => undefined);
    }
    if (canStop && deps.openaiTunnel?.live) {
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
