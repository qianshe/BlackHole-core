import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Same format and lifetime as packages/vscode/src/localWeb.ts (see plan T1 deviation).
export const REDIRECT_PREFIX = 'local-web-';
export const REDIRECT_TTL_MS = 60_000;

/** Target URL for a fresh ticket. The bare base64url fragment is never sent to the server. */
export function localWebUrl(port: number, pagePath: string, ticket: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) throw new Error('invalid ticket');
  if (pagePath !== '/ui/') throw new Error('invalid page path');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid port');
  return `http://127.0.0.1:${port}${pagePath}#${ticket}`;
}

/** Tiny redirect page: keeps the ticket out of the browser's command line. */
export function redirectHtml(url: string): string {
  const safe = url.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="refresh" content="0;url=${safe}"><title>BlackHole 本地 Web</title></head><body><a href="${safe}">打开 BlackHole</a></body></html>`;
}

/** Removes redirect files older than the ticket lifetime. */
export function sweepRedirects(dir: string, now = Date.now()): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(REDIRECT_PREFIX) || !name.endsWith('.html')) continue;
    const file = path.join(dir, name);
    try {
      if (now - fs.statSync(file).mtimeMs > REDIRECT_TTL_MS) fs.rmSync(file, { force: true });
    } catch {
      /* best effort */
    }
  }
}

/** Writes a user-only one-time redirect file; the caller schedules its removal. */
export function writeRedirect(dir: string, url: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  sweepRedirects(dir);
  const file = path.join(dir, `${REDIRECT_PREFIX}${randomUUID()}.html`);
  fs.writeFileSync(file, redirectHtml(url), { flag: 'wx', mode: 0o600 });
  return file;
}
