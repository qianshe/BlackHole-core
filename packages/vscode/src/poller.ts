import { window, type Disposable } from 'vscode';

/**
 * Shared heartbeat for daemon-facing UI. Ticks at the configured interval
 * while the window is focused, backs off 5x when it is not.
 */
export class Poller implements Disposable {
  private timer: NodeJS.Timeout | undefined;
  private counter = 0;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly intervalMs: () => number) {}

  onTick(fn: () => void): Disposable {
    this.listeners.add(fn);
    return { dispose: () => void this.listeners.delete(fn) };
  }

  start(): void {
    this.stop();
    this.timer = setInterval(() => {
      this.counter += 1;
      if (!window.state.focused && this.counter % 5 !== 0) return;
      for (const fn of this.listeners) fn();
    }, this.intervalMs());
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  dispose(): void {
    this.stop();
    this.listeners.clear();
  }
}
