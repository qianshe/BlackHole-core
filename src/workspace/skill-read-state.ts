/** A phase is a detached object rather than a counter that can be written back
 * by an old request. Never serialize workspace execution behind these locks. */
interface ReadPhase {
  completed: Map<string, string>;
  pending: Map<string, Promise<unknown>>;
}
const newPhase = (): ReadPhase => ({ completed: new Map(), pending: new Map() });
const MAX_COMPLETED_RESOURCES = 512;

export class SkillReadState {
  private phase = newPhase();
  capture(): ReadPhase { return this.phase; }
  reset(): void { this.phase = newPhase(); }

  /** Serialize only the same resource in the same phase. A failed/cancelled
   * response never suppresses the next reader. "Success" means the response
   * and its audit were constructed, not that a remote model retained it. */
  async provide<T extends { isError?: boolean }>(
    phase: ReadPhase, resource: string, version: string, reload: boolean,
    send: () => Promise<T>, duplicate: () => Promise<T>, cancelled: () => boolean = () => false,
  ): Promise<T> {
    const previous = phase.pending.get(resource) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(async () => {
      if (!cancelled() && !reload && phase.completed.get(resource) === version) return duplicate();
      const result = await send();
      if (result.isError !== true && !cancelled() && this.phase === phase) {
        phase.completed.delete(resource);
        phase.completed.set(resource, version);
        // This is a bounded loop guard, not an authorization/rate-limit system.
        // Eviction is fail-open: an old file can be provided again, never denied.
        if (phase.completed.size > MAX_COMPLETED_RESOURCES) phase.completed.delete(phase.completed.keys().next().value!);
      }
      return result;
    });
    phase.pending.set(resource, task);
    try { return await task; }
    finally { if (phase.pending.get(resource) === task) phase.pending.delete(resource); }
  }
}

// The router reuses one runtime object per logical session across MCP servers.
// Weak keys also isolate independent daemon/test runtimes with equal row IDs and
// release state when the runtime is discarded. No credentials or bodies stored.
const states = new WeakMap<object, SkillReadState>();
export function skillReadStateFor(runtime: object): SkillReadState {
  let state = states.get(runtime);
  if (!state) { state = new SkillReadState(); states.set(runtime, state); }
  return state;
}
