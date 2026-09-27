import type { Config } from './config.js';
import type { SessionRow } from './storage/db.js';
import type { ShellAdapter } from './workspace/shell.js';
import type { PersistentShell } from './workspace/pwsh.js';

/** In-memory companion of a logical session; rebuilt lazily after daemon restart. */
export class SessionRuntime {
  session: SessionRow;
  autoApprove?: boolean;
  cwd: string;
  pwsh?: PersistentShell;
  beforeExecute?: () => Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(session: SessionRow, readonly shell: ShellAdapter) {
    this.session = session;
    this.cwd = session.cwd ?? session.workspace_path;
    this.autoApprove = String(session.auto_approve ?? '') === '1' || session.auto_approve === true;
  }

  /** Serialize session mutations. An optional deadline includes queue wait and admission validation. */
  serialize<T>(
    fn: (remainingMs?: number) => Promise<T>,
    options?: { timeoutMs: number; onTimeout: () => T | Promise<T> },
  ): Promise<T> {
    if (!options) {
      const run = async (): Promise<T> => { await this.beforeExecute?.(); return fn(); };
      const next = this.queue.then(run, run);
      this.queue = next.catch(() => undefined);
      return next;
    }
    const limit = Math.max(1, options.timeoutMs);
    const deadline = performance.now() + limit;
    let admitted = false;
    const run = async (): Promise<T> => {
      if (performance.now() >= deadline) return options.onTimeout();
      await this.beforeExecute?.();
      if (performance.now() >= deadline) return options.onTimeout();
      admitted = true;
      return fn(Math.max(1, deadline - performance.now()));
    };
    const task = this.queue.then(run, run);
    this.queue = task.catch(() => undefined);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!admitted) Promise.resolve(options.onTimeout()).then(resolve, reject);
      }, limit);
      timer.unref();
      task.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
    });
  }

  get workspace(): string { return this.session.workspace_path; }
}
