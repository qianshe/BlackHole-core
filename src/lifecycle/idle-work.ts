import type { DaemonDeps } from '../deps.js';

/** One fail-closed activity predicate for the HTTP readiness hint and the
 * Manager-signed stop gate. "No in-flight tool" alone is NOT task completion:
 * the same Core publishes a 60-second running window after the last tool
 * begins, unless its agent explicitly ends the turn.
 */
/** A positive work signal, shared between the signed Manager stop guard and
 * the public-channel watchdog. An initialized MCP pair without a pending tool
 * is only a cache entry; it is not an Agent turn or an active session. */
type WorkDeps = Pick<DaemonDeps, 'sessionActivity' | 'sessions' | 'processes' | 'courier' | 'webPresence' | 'confirmations'>;

/** A page being open keeps idle shutdown from firing, but does not by itself
 * prevent a selected software update. Real work remains protected in both. */
export function managedCoreUpgradeBlockers(deps: WorkDeps): string[] {
  if (!deps.sessionActivity || !deps.sessions || !deps.processes || !deps.courier || !deps.confirmations)
    throw new Error('activity_unknown');
  const blockers: string[] = [];
  if (deps.sessionActivity.pendingCount > 0) blockers.push('tools_running');
  if (deps.processes.maintenanceBusy()) blockers.push('background_processes');
  if (deps.courier.maintenanceBusy()) blockers.push('agent_work');
  if (deps.confirmations.pendingCount() > 0) blockers.push('pending_approvals');
  // The 60-second recent-tool window is a conservative *idle shutdown*
  // heuristic, not proof of an executing operation. Upgrades seal admission
  // atomically and independently protect pending tools, tasks and handlers.
  return blockers;
}
export function managedCoreHasActiveWork(deps: WorkDeps): boolean {
  if (managedCoreUpgradeBlockers(deps).length > 0 || (deps.webPresence?.size ?? 0) > 0) return true;
  return deps.sessions.list().some(session =>
    session.status === 'active' && deps.sessionActivity!.status(session.id) === 'running');
}
export function assertManagedCoreUpgradeable(deps: WorkDeps & Pick<DaemonDeps,'shutdown' | 'livePipes'>): void {
  if (!deps.shutdown || !deps.livePipes) throw new Error('activity_unknown');
  if (managedCoreUpgradeBlockers(deps).length > 0) throw new Error('active_work');
}

export function assertManagedCoreIdle(deps: Pick<DaemonDeps,
  'shutdown' | 'sessionActivity' | 'sessions' | 'processes' | 'courier' |
  'livePipes' | 'webPresence' | 'confirmations'
>): void {
  if (!deps.shutdown || !deps.livePipes) throw new Error('activity_unknown');
  // Cached MCP protocol pairs must not keep a detached Core alive. In-flight
  // handlers/Agent turns are still protected by the single work predicate.
  if (managedCoreHasActiveWork(deps)) throw new Error('active_work');
}
