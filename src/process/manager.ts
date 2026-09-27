import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ProcessOutput, safeLabel } from './output.js';
import { PROCESS_LIMITS, ProcessError, isTerminalState, type ProcessBackend, type ProcessHandle, type ProcessOwner,
  type ProcessSpec, type ProcessSnapshot, type ProcessSummary, type StartInput, type TerminalState } from './types.js';

interface RecordState {
  spec: ProcessSpec; fingerprint: string; snapshot: ProcessSummary; output: ProcessOutput;
  handle?: ProcessHandle; start?: Promise<ProcessSnapshot>; stopping?: Promise<void>;
  cancel: AbortController; closedView: boolean; closeRequested?: boolean; hadViewLease?: boolean; lease?: { clientId: string; until: number }; callId?: string;
}
interface RequestState { sessionId: string; processId: string; fingerprint: string }
export interface ManagerOptions {
  daemonId: string; backend: ProcessBackend; supported?: boolean;
  limits?: Partial<Record<keyof typeof PROCESS_LIMITS, number>>;
  now?: () => number;
  event?: (sessionId: string, type: string, data: Record<string, unknown>) => void;
}
export const canonicalDirectory = (value: string): string => {
  try { const real = fs.realpathSync.native(value); if (!fs.statSync(real).isDirectory()) throw new Error(); return real; }
  catch { throw new ProcessError('invalid_cwd', 'Working directory must exist and be a directory'); }
};
export function inside(root: string, value: string): boolean {
  const rel = path.relative(root, value);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep));
}
export function ownerFingerprint(owner: ProcessOwner): string {
  return JSON.stringify([owner.workspace, owner.mode, [...owner.writableDirs].sort()]);
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

const launchFailureReason=(reason:string|null|undefined):boolean=>reason==='spawn_failed'||reason==='sandbox_runner_missing'||reason==='sandbox_runner_nested'||reason==='sandbox_runner_failed'||reason==='sandbox_configuration_error'||reason==='sandbox_unsupported_platform';
/** In-memory, daemon-owned registry. Never awaits process exit while holding a session/global lock. */
export class ProcessManager {
  readonly daemonId: string;
  readonly supported: boolean;
  private readonly records = new Map<string, RecordState>();
  private readonly requests = new Map<string, RequestState>();
  private readonly limits;
  private readonly now: () => number;
  private readonly viewWatch: ReturnType<typeof setInterval>;
  private closing = false;
  constructor(private readonly options: ManagerOptions) {
    this.daemonId = options.daemonId; this.supported = options.supported ?? true;
    this.limits = { ...PROCESS_LIMITS, ...options.limits }; this.now = options.now ?? Date.now;
    this.viewWatch = setInterval(() => { this.stopOrphanedViews(); }, 1000); this.viewWatch.unref();
  }
  private stopOrphanedViews(): void {
    if (this.closing) return;
    const now = this.now();
    for (const r of this.records.values()) {
      if (!r.hadViewLease || !r.lease || r.lease.until > now || isTerminalState(r.snapshot.state) || r.stopping) continue;
      void this.stop(r.spec.sessionId, r.spec.processId, 'terminal_disconnected');
    }
  }
  private requestKey(sessionId: string, requestId: string): string { return sessionId + '\0' + requestId; }
  private endedAt(r: RecordState): number {
    const value = r.snapshot.endedAt ? Date.parse(r.snapshot.endedAt) : Number.NaN;
    return Number.isFinite(value) ? value : this.now();
  }
  private viewProtected(r: RecordState, now: number): boolean {
    return !r.closedView && r.lease !== undefined && r.lease.until > now;
  }
  private requestCapacityError(sessionId: string): ProcessError | undefined {
    const sessionLimit = Math.max(0, this.limits.sessionRequestHistory);
    const globalLimit = Math.max(0, this.limits.requestHistory);
    let sessionCount = 0;
    for (const request of this.requests.values()) if (request.sessionId === sessionId) sessionCount += 1;
    if (sessionCount < sessionLimit && this.requests.size < globalLimit) return undefined;
    return new ProcessError(
      'idempotency_capacity_reached',
      'The managed-process idempotency ledger is full; no launch was accepted. Create a new session or restart the daemon before using a new requestId.',
    );
  }
  private evictRecord(r: RecordState): void {
    // Keep the lightweight request ledger entry for the daemon/session lifetime:
    // forgetting it would turn a retry into a second launch with side effects.
    this.records.delete(r.spec.processId);
  }
  /** Keep active/unknown work and visible terminals; trim only completed history. */
  private pruneHistory(): void {
    const now = this.now();
    const terminal = [...this.records.values()].filter(r => isTerminalState(r.snapshot.state));
    const removable = terminal.filter(r => !this.viewProtected(r, now)).sort((a, b) => this.endedAt(a) - this.endedAt(b));
    const remove = new Set<RecordState>();
    const retention = Math.max(0, this.limits.historyRetentionMs);
    for (const r of removable) if (now - this.endedAt(r) >= retention) remove.add(r);

    const bySession = new Map<string, RecordState[]>();
    for (const r of terminal) {
      const rows = bySession.get(r.spec.sessionId) ?? [];
      rows.push(r); bySession.set(r.spec.sessionId, rows);
    }
    const sessionHistory = Math.max(0, this.limits.sessionHistory);
    for (const rows of bySession.values()) {
      let excess = rows.filter(r => !remove.has(r)).length - sessionHistory;
      if (excess <= 0) continue;
      for (const r of removable) {
        if (excess <= 0) break;
        if (r.spec.sessionId !== rows[0]!.spec.sessionId || remove.has(r)) continue;
        remove.add(r); excess -= 1;
      }
    }
    let excess = terminal.filter(r => !remove.has(r)).length - Math.max(0, this.limits.history);
    if (excess > 0) for (const r of removable) {
      if (excess <= 0) break;
      if (remove.has(r)) continue;
      remove.add(r); excess -= 1;
    }
    for (const r of remove) this.evictRecord(r);
  }
  private emit(r: RecordState, type: string, detail: Record<string, unknown> = {}): void {
    if (!this.records.has(r.spec.processId)) return;
    try { this.options.event?.(r.spec.sessionId, 'process_' + type, { processId: r.spec.processId, ...(r.callId ? { call_id: r.callId } : {}), ...detail }); }
    catch { /* audit availability cannot leak owned processes */ }
  }
  private record(sessionId: string, processId: string): RecordState {
    const r = this.records.get(processId);
    if (!r || r.spec.sessionId !== sessionId) throw new ProcessError('process_not_found', 'Process is unavailable in this session/daemon');
    return r;
  }
  private summary(r: RecordState): ProcessSummary {
    const terminal = r.snapshot.terminal;
    const view = !r.closedView && r.lease && r.lease.until <= this.now()
      ? { state: 'unavailable' as const, reason: 'vscode_disconnected' } : { ...terminal };
    return { ...r.snapshot, terminal: view };
  }
  private snapshot(r: RecordState): ProcessSnapshot { return { ...this.summary(r), output: r.output.snapshot() }; }
  list(sessionId: string): ProcessSummary[] {
    return [...this.records.values()].filter(r => r.spec.sessionId === sessionId).map(r => this.summary(r));
  }
  status(sessionId: string, processId: string): ProcessSnapshot { return this.snapshot(this.record(sessionId, processId)); }

  start(owner: ProcessOwner, input: StartInput, authorize: (spec: ProcessSpec, signal: AbortSignal) => Promise<void>, secrets: readonly string[] = [], callId?: string): Promise<ProcessSnapshot> {
    if (this.closing) return Promise.reject(new ProcessError('daemon_stopping', 'Daemon is shutting down'));
    if (!this.supported) return Promise.reject(new ProcessError('unsupported_platform', 'Managed processes are unavailable on this daemon platform or interpreter'));
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(input.requestId) || !input.script.trim() || Buffer.byteLength(input.script) > 8192 || input.script.includes('\0')) {
      return Promise.reject(new ProcessError('invalid_request', 'Use a stable requestId and a nonempty script of at most 8192 UTF-8 bytes'));
    }
    const fingerprint = digest([input.script, input.cwd ?? '.', input.name ?? '']);
    const key = this.requestKey(owner.sessionId, input.requestId);
    const existingRequest = this.requests.get(key);
    if (existingRequest) {
      if (existingRequest.fingerprint !== fingerprint) return Promise.reject(new ProcessError('idempotency_conflict', 'This requestId already describes a different launch'));
      const existing = this.records.get(existingRequest.processId);
      if (existing?.spec.sessionId === owner.sessionId) return existing.start ?? Promise.resolve(this.snapshot(existing));
      return Promise.reject(new ProcessError('idempotency_history_expired', 'This requestId was already accepted but its detailed history expired; verify the original outcome and use a new requestId for a new launch'));
    }
    // Prune only completed, non-visible history before enforcing hard record quotas.
    const requestCapacity = this.requestCapacityError(owner.sessionId);
    if (requestCapacity) return Promise.reject(requestCapacity);
    this.pruneHistory();
    // All admission and reservation below are synchronous: concurrent starts cannot exceed quotas.
    const rows = [...this.records.values()], owned = rows.filter(r => r.spec.sessionId === owner.sessionId);
    if (rows.length >= this.limits.records || owned.length >= this.limits.sessionRecords) return Promise.reject(new ProcessError('process_record_limit', 'Process history limit reached; use another session'));
    if (rows.filter(r => !isTerminalState(r.snapshot.state)).length >= this.limits.running || owned.filter(r => !isTerminalState(r.snapshot.state)).length >= this.limits.sessionRunning) {
      return Promise.reject(new ProcessError('process_limit_reached', 'Stop an existing managed process before starting another'));
    }
    let cwd: string, workspace: string, writableDirs: string[];
    try {
      workspace = canonicalDirectory(owner.workspace);
      cwd = canonicalDirectory(path.resolve(workspace, input.cwd ?? '.'));
      writableDirs = owner.writableDirs.map(canonicalDirectory);
      if (owner.mode !== 'danger-full-access' && ![workspace, ...(owner.mode === 'workspace-write' ? writableDirs : [])].some(root => inside(root, cwd))) {
        throw new ProcessError('cwd_outside_workspace', 'Working directory is outside the authorized workspace');
      }
    } catch (error) { return Promise.reject(error); }
    const currentPolicy = ownerFingerprint({ ...owner, workspace, writableDirs });
    if (owned.some(r => !isTerminalState(r.snapshot.state) && ownerFingerprint(r.spec) !== currentPolicy)) {
      return Promise.reject(new ProcessError('process_cleanup_pending', 'Old-permission processes must be confirmed stopped before launching under the new policy'));
    }
    const processId = 'proc_' + randomUUID();
    let name = safeLabel(input.name?.trim() || 'background').slice(0, 80);
    for (const secret of secrets.filter(s => s.length >= 4)) name = name.split(secret).join('[redacted]');
    const spec: ProcessSpec = { ...owner, workspace, writableDirs, cwd, processId, name, requestId: input.requestId, script: input.script };
    const r: RecordState = {
      spec, fingerprint, output: new ProcessOutput(secrets), cancel: new AbortController(), closedView: false, callId,
      snapshot: { processId, daemonId: this.daemonId, requestId: input.requestId, name, cwd, state: 'starting', pid: null,
        startedAt: new Date(this.now()).toISOString(), endedAt: null, exitCode: null, signal: null, reason: null,
        terminal: { state: 'unavailable', reason: 'no_matching_vscode' } },
    };
    this.records.set(processId, r); this.requests.set(key, { sessionId: owner.sessionId, processId, fingerprint });
    const run = async () => {
      try {
        const cancelled = new Promise<never>((_, reject) => r.cancel.signal.addEventListener('abort', () => reject(new ProcessError('cancelled', 'Launch cancelled before spawn')), { once: true }));
        await Promise.race([authorize(spec, r.cancel.signal), cancelled]);
        if (r.cancel.signal.aborted || this.closing || isTerminalState(r.snapshot.state)) throw new ProcessError('cancelled', 'Launch cancelled before spawn');
        // Re-resolve directories immediately before native spawn; no async work between this and spawn.
        if (canonicalDirectory(spec.cwd) !== cwd || canonicalDirectory(spec.workspace) !== workspace) throw new ProcessError('cwd_changed', 'Working directory changed during launch approval');
        r.handle = this.options.backend(spec, {
          output: (stream, bytes) => r.output.push(stream, bytes),
          fault: message => { r.snapshot.state = 'unknown'; r.snapshot.reason = 'monitor_error'; r.output.push('stderr', Buffer.from(message + '\n')); this.emit(r, 'monitor_failed'); },
          exit: result => {
            if (isTerminalState(r.snapshot.state)) return;
            r.output.end(); r.snapshot.state = result.cleanupConfirmed ? (launchFailureReason(result.reason) ? 'failed' : 'exited') : 'unknown';
            r.snapshot.exitCode = result.exitCode; r.snapshot.signal = result.signal ?? null;
            r.snapshot.reason = r.snapshot.reason ?? result.reason ?? null;
            r.snapshot.endedAt = new Date(this.now()).toISOString();
            this.emit(r, 'exited', { exitCode: result.exitCode, cleanupConfirmed: result.cleanupConfirmed });
          },
        });
        r.snapshot.pid = r.handle.pid;
        await r.handle.ready; // POSIX confirms the guarded child spawn; Windows already spawned synchronously.
        if (r.snapshot.state === 'starting') r.snapshot.state = 'running';
        this.emit(r, 'started');
        // Collect immediate failures, never wait for service readiness or process completion.
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        if (!isTerminalState(r.snapshot.state)) {
          r.snapshot.state = 'failed'; r.snapshot.reason = error instanceof ProcessError ? error.code : 'spawn_failed';
          r.snapshot.endedAt = new Date(this.now()).toISOString();
          r.output.push('stderr', Buffer.from((error instanceof Error ? error.message : String(error)) + '\n')); r.output.end();
          this.emit(r, 'start_failed', { reason: r.snapshot.reason });
        }
      }
      return this.snapshot(r);
    };
    r.start = run().finally(() => { r.start = undefined; });
    return r.start;
  }

  async stop(sessionId: string, processId: string, reason = 'operator_stop', closeTerminal = false): Promise<ProcessSnapshot> {
    const r = this.record(sessionId, processId);
    if (isTerminalState(r.snapshot.state)) {
      if (closeTerminal && ['open', 'pending'].includes(r.snapshot.terminal.state)) r.closeRequested = true;
      return this.snapshot(r);
    }
    if (!r.stopping) {
      r.snapshot.reason = reason; this.emit(r, 'stop_requested', { reason });
      if (!r.handle) {
        r.snapshot.state = 'exited'; r.snapshot.endedAt = new Date(this.now()).toISOString();
        r.snapshot.reason = 'cancelled_before_spawn'; r.output.end(); r.cancel.abort();
      } else {
        r.snapshot.state = 'stopping';
        r.stopping = r.handle.stop().catch(error => {
          r.snapshot.state = 'unknown'; r.snapshot.reason = 'stop_failed';
          r.output.push('stderr', Buffer.from((error instanceof Error ? error.message : String(error)) + '\n')); this.emit(r, 'stop_failed');
        }).finally(() => { r.stopping = undefined; });
      }
    }
    await r.stopping;
    if (closeTerminal && isTerminalState(r.snapshot.state) && ['open', 'pending'].includes(r.snapshot.terminal.state)) r.closeRequested = true;
    return this.snapshot(r);
  }
  async stopSession(sessionId: string, reason: string, purge = false): Promise<string[]> {
    const owned = [...this.records.values()].filter(r => r.spec.sessionId === sessionId);
    await Promise.all(owned.map(r => this.stop(sessionId, r.spec.processId, reason)));
    if (purge) {
      for (const key of this.requests.keys()) if (key.startsWith(sessionId + '\0')) this.requests.delete(key);
      for (const r of owned) if (isTerminalState(r.snapshot.state)) this.records.delete(r.spec.processId);
    }
    return owned.filter(r => !isTerminalState(r.snapshot.state)).map(r => r.spec.processId);
  }
  reconcile(validate: (owner: ProcessOwner) => string | undefined): void {
    for (const r of this.records.values()) {
      if (isTerminalState(r.snapshot.state) || r.stopping) continue;
      const reason = validate(r.spec); if (reason) void this.stop(r.spec.sessionId, r.spec.processId, reason);
    }
  }
  async dispose(): Promise<void> {
    this.closing = true; clearInterval(this.viewWatch);
    await Promise.all([...this.records.values()].map(r => this.stop(r.spec.sessionId, r.spec.processId, 'daemon_stopped')));
    if ([...this.records.values()].some(r => !isTerminalState(r.snapshot.state))) throw new ProcessError('cleanup_unconfirmed', 'One or more owned process trees could not be confirmed stopped');
  }

  /** Native UI bridge only. Lease ownership controls DISPLAY, never process execution. */
  syncView(clientId: string, roots: readonly string[], cursors: Record<string, number>, acknowledgements: { processId: string; state: TerminalState }[] = [], reopen?: string) {
    const now = this.now();
    const matches = (r: RecordState) => roots.some(root => path.relative(root, r.spec.workspace) === '');
    for (const ack of acknowledgements) {
      const r = this.records.get(ack.processId);
      // The same window may report a close after a brief outage. Reject only if ownership changed.
      if (!r || !matches(r) || r.lease?.clientId !== clientId) continue;
      r.snapshot.terminal = { state: ack.state };
      if (ack.state === 'closed') {
        r.closedView = true; r.closeRequested = false;
        if (!isTerminalState(r.snapshot.state)) void this.stop(r.spec.sessionId, r.spec.processId, 'terminal_closed');
      }
    }
    const items = [];
    let budget = 128 * 1024;
    const share = Math.max(512, Math.floor(budget / Math.max(1, [...this.records.values()].filter(r => matches(r) && !r.closedView).length)));
    for (const r of this.records.values()) {
      if (!matches(r)) continue;
      if (r.hadViewLease && r.lease && r.lease.until <= now && r.lease.clientId !== clientId && !isTerminalState(r.snapshot.state) && !r.stopping) {
        void this.stop(r.spec.sessionId, r.spec.processId, 'terminal_disconnected');
      }
      if (reopen === r.spec.processId && (!r.lease || r.lease.until <= now || r.lease.clientId === clientId)) {
        r.closedView = false; r.snapshot.terminal = { state: 'pending' };
      }
      const canAcquire = !r.lease || r.lease.clientId === clientId || (!r.hadViewLease && r.lease.until <= now);
      if (!r.closedView && canAcquire && (!r.lease || r.lease.until <= now)) {
        // Only the same controller may recover an expired lease. A new VS Code host cannot
        // adopt an orphaned task after reload; the daemon stops it instead.
        if (r.lease?.clientId !== clientId) r.snapshot.terminal = { state: 'pending' };
        r.lease = { clientId, until: now + 5000 }; r.hadViewLease = true;
      }
      const owned = r.lease?.clientId === clientId && !r.closedView;
      if (owned) r.lease!.until = now + 5000;
      const output = owned && budget > 0 ? r.output.read(cursors[r.spec.processId] ?? 0, Math.min(16 * 1024, share, budget))
        : { events: [], next: cursors[r.spec.processId] ?? 0, gap: false };
      budget -= output.events.reduce((sum, event) => sum + Buffer.byteLength(event.text), 0);
      items.push({ ...this.summary(r), sessionId: r.spec.sessionId, workspace: r.spec.workspace, owned, ...(owned && r.closeRequested ? { closeTerminal: true } : {}), output });
    }
    return { daemonId: this.daemonId, supported: this.supported, items };
  }
  stopFromView(clientId: string, roots: readonly string[], processId: string): Promise<ProcessSnapshot> {
    const r = this.records.get(processId);
    if (!r || !roots.some(root => path.relative(root, r.spec.workspace) === '') || r.lease?.clientId !== clientId || r.lease.until <= this.now()) {
      return Promise.reject(new ProcessError('process_not_found', 'No matching process view'));
    }
    return this.stop(r.spec.sessionId, processId);
  }
}
