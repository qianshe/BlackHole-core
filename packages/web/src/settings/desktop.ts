import { installSettingsHost } from './host';

type DesktopBridge = (action: string, revision: number) => Promise<unknown>;

declare global {
  interface Window {
    blackholeDesktopCoreAction?: DesktopBridge;
    /** Available only inside the native Desktop window, never browser Web. */
    blackholeDesktopWelcomeAction?: (action: 'status' | 'sign-in' | 'verify' | 'cancel') => Promise<unknown>;
  }
}

/** The Desktop window process binds exactly one native function into its
 * WebView before navigation. When present, this page is hosted natively:
 * maintenance clicks are handed to that host, which confirms natively,
 * re-checks the target and calls the Manager. The bridge cannot be reached
 * from a browser tab and accepts no token, command or confirmation flag. */
export function installDesktopHost(): boolean {
  const bridge = window.blackholeDesktopCoreAction;
  if (typeof bridge !== 'function') return false;
  installSettingsHost({
    kind: 'desktop',
    coreAction: async (action, revision) => {
      const raw = await bridge(action, revision ?? -1);
      if (typeof raw === 'string') {
        try { return JSON.parse(raw) as { completed: boolean }; } catch { throw new Error('maintenance_result_unknown'); }
      }
      return raw as { completed: boolean };
    },
  });
  return true;
}
