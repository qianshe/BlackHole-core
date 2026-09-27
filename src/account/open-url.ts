import { spawn } from 'node:child_process';

/** Opens an https URL in the user's default browser from the background daemon. Fixed argv, no shell. */
export function openUrl(url: string): Promise<boolean> {
  if (!/^https:\/\//.test(url)) return Promise.resolve(false);
  const [cmd, args]: [string, string[]] = process.platform === 'win32'
    ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { detached: true, windowsHide: true, stdio: 'ignore' });
    child.once('error', () => resolve(false));
    child.once('spawn', () => { child.unref(); resolve(true); });
  });
}
