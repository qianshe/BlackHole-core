import type { SettingsHostInfo } from '../../../contracts/src/settings-host';

export interface SettingsHostAdapter {
  readonly kind: 'web' | 'vscode';
  request?<T>(path: string, init?: RequestInit): Promise<T>;
  copy?(text: string): Promise<boolean>;
  readState?(key: string): string | null;
  saveState?(key: string, value: string): void;
}
let adapter: SettingsHostAdapter = { kind: 'web' };
/** Set once before mounting the shared application. Browser builds retain cookie/CSRF fetch. */
export function installSettingsHost(next: SettingsHostAdapter): void { adapter = next; }
export function settingsHost(): SettingsHostAdapter { return adapter; }
export type { SettingsHostInfo };
