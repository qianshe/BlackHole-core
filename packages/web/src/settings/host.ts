import type { SettingsCoreAction, SettingsHostInfo } from '../../../contracts/src/settings-host';

/** Actions a native host may execute after its own confirmation. The first
 * three mirror the VS Code message-bridge routes; stop/restart are only
 * available where the host exposes a direct native bridge (Desktop). */
export type NativeCoreAction = SettingsCoreAction | 'stop' | 'restart';

export interface SettingsHostAdapter {
  readonly kind: 'web' | 'vscode' | 'desktop';
  coreAction?(action: NativeCoreAction, revision?: number): Promise<{ completed: boolean }>;
  request?<T>(path: string, init?: RequestInit): Promise<T>;
  copy?(text: string): Promise<boolean>;
  readState?(key: string): string | null;
  saveState?(key: string, value: string): void;
}
let adapter: SettingsHostAdapter = { kind: 'web' };
/** Set once before mounting the shared application. Browser builds retain cookie/CSRF fetch. */
export function installSettingsHost(next: SettingsHostAdapter): void { adapter = next; }
export function settingsHost(): SettingsHostAdapter { return adapter; }
/** True when this page is hosted by a native shell that can confirm and run
 * Manager maintenance. A plain browser tab cannot, even on the same machine. */
export function hasNativeMaintenance(): boolean { return adapter.kind === 'vscode' || adapter.kind === 'desktop'; }
export type { SettingsHostInfo };
