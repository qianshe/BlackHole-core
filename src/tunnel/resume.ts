import type { MachineStateRepo } from '../storage/machineState.js';
import type { TunnelKind, TunnelStatus } from './manager.js';

const KEY = 'tunnel.desired.v1';

/**
 * The public channel the operator explicitly started, remembered across
 * daemon restarts and watchdog stops. Cleared only by an explicit stop.
 */
export class ChannelIntent {
  constructor(private readonly state: Pick<MachineStateRepo, 'get' | 'set'>) {}

  get(): TunnelKind | null {
    const v = this.state.get(KEY);
    return v === 'quick' || v === 'named' ? v : null;
  }

  set(kind: TunnelKind): void {
    if (this.get() !== kind) this.state.set(KEY, kind);
  }

  clear(): void {
    if (this.get() !== null) this.state.set(KEY, '');
  }
}

const TABS_DECOUPLED_KEY = 'channel.tabs_decoupled.v1';

/**
 * One-time upgrade step (plan §5.1). The custom tab used to keep Cloudflare off
 * at spawn; tabs no longer gate channels, so a Cloudflare channel remembered
 * while that tab was selected must not come back on its own after the upgrade.
 * Runs once per machine; returns true when a remembered channel was dropped.
 */
export function migrateDecoupledTabs(state: Pick<MachineStateRepo, 'get' | 'set'>, channelMode: string): boolean {
  if (state.get(TABS_DECOUPLED_KEY)) return false;
  const intent = new ChannelIntent(state);
  const dropped = channelMode === 'custom' && intent.get() !== null;
  if (dropped) intent.clear();
  state.set(TABS_DECOUPLED_KEY, '1');
  return dropped;
}

interface ResumeDeps {
  channelIntent?: ChannelIntent;
  tunnel: { status: TunnelStatus; start(kind?: TunnelKind): unknown };
  cfg: { tunnel: string };
  log: (line: string) => void;
}

/**
 * Called on every client heartbeat: a remembered channel that is simply off
 * (daemon restarted, or the watchdog closed it while no window was open) is
 * started again. Never after an error or while one is starting/running, and
 * never when the launcher turned the channel off.
 */
export function resumeChannel(deps: ResumeDeps): boolean {
  const kind = deps.channelIntent?.get();
  if (!kind || deps.cfg.tunnel === 'off' || deps.tunnel.status !== 'off') return false;
  deps.log(`channel: resuming the ${kind === 'quick' ? 'temporary' : 'persistent'} public channel started earlier`);
  deps.tunnel.start(kind);
  return true;
}
