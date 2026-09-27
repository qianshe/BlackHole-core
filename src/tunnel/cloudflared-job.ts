import { initializeCloudflared, type CloudflaredInstallResult } from './cloudflared-install.js';

export type CloudflaredJobState =
  | { state: 'idle' }
  | { state: 'running'; started_at: string }
  | { state: 'done'; path: string; installed: boolean; finished_at: string }
  | { state: 'error'; error: string; finished_at: string };

type Installer = (configuredPath: string) => Promise<CloudflaredInstallResult>;

/**
 * One cloudflared initialization at a time, owned by the daemon: closing the
 * window that asked for it does not cancel it, and every client polls the same
 * state. It never saves settings or restarts anything by itself.
 */
export class CloudflaredJob {
  private current: CloudflaredJobState = { state: 'idle' };

  constructor(private readonly install: Installer = initializeCloudflared, private readonly log: (line: string) => void = () => {}) {}

  view(): CloudflaredJobState {
    return this.current;
  }

  /** Returns false when a run is already in progress (the caller just polls). */
  start(configuredPath: string): boolean {
    if (this.current.state === 'running') return false;
    this.current = { state: 'running', started_at: new Date().toISOString() };
    this.log('cloudflared: initialization started');
    void this.install(configuredPath).then(
      (r) => {
        this.current = { state: 'done', path: r.path, installed: r.installed, finished_at: new Date().toISOString() };
        this.log(`cloudflared: ${r.installed ? 'installed' : 'found'} ${r.path}`);
      },
      (e: unknown) => {
        this.current = { state: 'error', error: e instanceof Error ? e.message : String(e), finished_at: new Date().toISOString() };
        this.log('cloudflared: initialization failed');
      },
    );
    return true;
  }
}
