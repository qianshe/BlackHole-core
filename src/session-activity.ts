/** Session activity is daemon-local, independent of credentials and MCP pipes. */
export type SessionActivityStatus = 'idle' | 'running';
export interface ActivityClock {
  now(): number;
  /** Schedule once and return a cancellation function. */
  schedule(callback: () => void, delayMs: number): () => void;
}
const DEFAULT_CLOCK: ActivityClock = {
  now: () => performance.now(),
  schedule: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return () => clearTimeout(timer);
  },
};
interface Entry {
  pending: number;
  lastStart: number;
  timer?: { cancel(): void };
}
const WINDOW_MS = 60_000;

export class SessionActivity {
  private readonly entries = new Map<string, Entry>();
  private disposed = false;
  constructor(private readonly changed: () => void, private readonly clock: ActivityClock = DEFAULT_CLOCK) {}

  status(id: string): SessionActivityStatus {
    const entry = this.entries.get(id);
    if (!entry) return 'idle';
    if (entry.pending > 0 || this.clock.now() - entry.lastStart < WINDOW_MS) return 'running';
    // Correct even if the event loop has not delivered the expiry timer yet.
    this.forget(id);
    return 'idle';
  }

  /** Count the whole accepted handler, including queue/approval waits. Finish is idempotent. */
  begin(id: string): () => void {
    if (this.disposed) return () => {};
    const wasRunning = this.status(id) === 'running';
    let entry = this.entries.get(id);
    if (!entry) {
      entry = { pending: 0, lastStart: this.clock.now() };
      this.entries.set(id, entry);
    }
    entry.timer?.cancel();
    entry.timer = undefined;
    entry.pending += 1;
    entry.lastStart = this.clock.now();
    if (!wasRunning) this.changed();
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      // Revoke/dispose may have discarded this entry. A late reply cannot revive it.
      if (this.entries.get(id) !== entry) return;
      entry.pending -= 1;
      if (entry.pending === 0) this.settle(id, entry);
    };
  }

  private settle(id: string, entry: Entry): void {
    const remaining = WINDOW_MS - (this.clock.now() - entry.lastStart);
    if (remaining <= 0) { this.forget(id); return; }
    const timer = { cancel: () => {} };
    entry.timer = timer;
    timer.cancel = this.clock.schedule(() => {
      if (this.entries.get(id) !== entry || entry.timer !== timer) return;
      entry.timer = undefined;
      // Timers can fire early; derive the decision from the monotonic clock.
      this.settle(id, entry);
    }, remaining);
  }

  /**
   * The agent says its turn is over (a bound web chat stopped being busy): end the 60 s window now,
   * but never while a tool call of this session is still being handled.
   */
  endTurn(id: string): void {
    const entry = this.entries.get(id);
    if (entry && entry.pending === 0) this.forget(id);
  }

  forget(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.timer?.cancel();
    this.entries.delete(id);
    this.changed();
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.entries.values()) entry.timer?.cancel();
    this.entries.clear();
  }
}
