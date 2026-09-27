import { ConfigurationTarget, Disposable, window, workspace, type OutputChannel } from 'vscode';
import type { ControlApi, DaemonSettings } from './controlApi';

/**
 * The daemon owns these settings. This keeps VS Code's copy in step:
 * - first contact: the daemon receives the current VS Code values for every
 *   key it has not seeded yet (keys added by a later version get one copy too);
 * - afterwards the daemon wins and is mirrored into VS Code settings, so the
 *   settings panel shows it and the existing restart fingerprint applies it;
 * - edits made in VS Code (settings panel or settings.json) are pushed back.
 * Only keys the running daemon reports are mirrored or pushed, so an older
 * daemon never sees keys it does not know.
 */
export const SYNCED_KEYS = [
  'connectorName', 'publicBaseUrl', 'cloudflaredPath', 'skillsDir', 'channelMode', 'semanticMode',
  'gitUsrBinPath', 'namedTunnelName', 'tunnelProbeProxy', 'webAgents', 'customWebAgents',
  'openaiTunnelClientPath', 'openaiTunnelId',
] as const;
type Key = (typeof SYNCED_KEYS)[number];
type Values = Record<Key, unknown>;

const str = (raw: unknown): string => (typeof raw === 'string' ? raw.trim() : '');

/** Same normalization the daemon applies, so equal values never ping-pong. */
export function normalizeLocal(key: Key, raw: unknown): unknown {
  if (key === 'webAgents') {
    const out: string[] = [];
    for (const n of Array.isArray(raw) ? raw : []) if (str(n) && !out.includes(str(n))) out.push(str(n));
    return out;
  }
  if (key === 'customWebAgents') {
    return (Array.isArray(raw) ? raw : [])
      .filter((a): a is { name?: unknown; url?: unknown } => !!a && typeof a === 'object')
      .map((a) => ({ name: str(a.name), url: str(a.url) }));
  }
  const v = str(raw);
  if (key === 'publicBaseUrl' || key === 'tunnelProbeProxy') return v.replace(/\/+$/, '');
  if (key === 'connectorName') return v.replace(/^@+/, '');
  if (key === 'namedTunnelName') return v || 'blackhole';
  if (key === 'channelMode') return v === 'custom' || v === 'openai' ? v : 'cloudflare';
  if (key === 'semanticMode') return ['off', 'explicit', 'auto'].includes(v) ? v : 'explicit';
  return v;
}

export function localValues(get: (k: Key) => unknown): Values {
  const out = {} as Values;
  for (const k of SYNCED_KEYS) out[k] = normalizeLocal(k, get(k));
  return out;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Keys the daemon owns (it reports them and has seeded them) whose VS Code value differs. */
export function diffValues(local: Values, daemon: Pick<DaemonSettings, 'values'> & { unseeded?: string[] }): Key[] {
  return SYNCED_KEYS.filter((k) => k in daemon.values && !daemon.unseeded?.includes(k) && !same(local[k], daemon.values[k]));
}

export class SettingsSync implements Disposable {
  private mirroring = false;
  private running: Promise<void> | null = null;
  private last: DaemonSettings | null = null;
  private readonly disposables: Disposable[] = [];
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly api: ControlApi,
    private readonly log: OutputChannel,
    intervalMs = 15_000,
  ) {
    this.timer = setInterval(() => void this.sync(), intervalMs);
    this.disposables.push(
      workspace.onDidChangeConfiguration((e) => {
        if (this.mirroring) return;
        if (SYNCED_KEYS.some((k) => e.affectsConfiguration(`blackhole.${k}`))) void this.push();
      }),
      window.onDidChangeWindowState((s) => {
        if (s.focused) void this.sync();
      }),
    );
  }

  private read(): Values {
    const c = workspace.getConfiguration('blackhole');
    return localValues((k) => c.get(k));
  }

  /** Pull from the daemon (handing over unseeded keys first) and mirror into VS Code. */
  sync(): Promise<void> {
    this.running ??= (async () => {
      try {
        let s = await this.api.settings();
        if (!s.migrated || s.unseeded?.length) {
          const local = this.read();
          const open = s.migrated ? s.unseeded ?? [] : SYNCED_KEYS.filter((k) => k in s.values);
          const values = Object.fromEntries(SYNCED_KEYS.filter((k) => open.includes(k)).map((k) => [k, local[k]]));
          if (Object.keys(values).length || !s.migrated) s = await this.api.migrateSettings(values);
        }
        this.last = s;
        await this.mirror(s);
      } catch {
        /* daemon down or older daemon without /settings: try again later */
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  private async mirror(s: DaemonSettings): Promise<void> {
    const changed = diffValues(this.read(), s);
    if (changed.length === 0) return;
    const c = workspace.getConfiguration('blackhole');
    this.mirroring = true;
    try {
      for (const k of changed) await c.update(k, s.values[k], ConfigurationTarget.Global);
      this.log.appendLine(`settings: applied from BlackHole (${changed.join(', ')})`);
    } finally {
      this.mirroring = false;
    }
  }

  /** A VS Code-side edit: send only what differs from the daemon's last known values. */
  private async push(): Promise<void> {
    await this.running;
    const local = this.read();
    const base = this.last;
    if (!base) {
      void this.sync();
      return;
    }
    const keys = diffValues(local, base);
    if (keys.length === 0) return;
    const values = Object.fromEntries(keys.map((k) => [k, local[k]]));
    try {
      this.last = await this.api.patchSettings(values);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.log.appendLine(`settings: BlackHole rejected ${keys.join(', ')}: ${message}`);
      void window.showWarningMessage(`BlackHole: 设置未保存（${message}），已恢复为当前值。`);
      if (this.last) await this.mirror(this.last);
    }
  }

  dispose(): void {
    clearInterval(this.timer);
    for (const d of this.disposables) d.dispose();
  }
}
