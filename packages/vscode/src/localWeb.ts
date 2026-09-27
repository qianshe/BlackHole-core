import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { env, Uri, window } from 'vscode';
import type { ControlApi } from './controlApi';
import type { DaemonManager } from './daemonManager';

const REDIRECT_PREFIX = 'local-web-';
const REDIRECT_TTL_MS = 60_000;

/** Target URL for a fresh ticket. The bare base64url fragment is never re-encoded and never sent to the server. */
export function localWebUrl(port: number, pagePath: string, ticket: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) throw new Error('invalid ticket');
  if (pagePath !== '/ui/') throw new Error('invalid page path');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid port');
  return `http://127.0.0.1:${port}${pagePath}#${ticket}`;
}

/** Tiny redirect page: keeps the ticket out of the browser's command line. */
export function redirectHtml(url: string): string {
  const safe = url.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="refresh" content="0;url=${safe}"><title>BlackHole 本地 Web</title></head><body><a href="${safe}">继续打开 BlackHole 本地 Web</a></body></html>`;
}

/** Writes a user-only redirect file under ~/.blackhole/runtime-state and removes it after the ticket expires. */
function writeRedirect(url: string): string {
  const dir = path.join(os.homedir(), '.blackhole', 'runtime-state');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Leftovers from a crashed window: their tickets are long expired.
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith(REDIRECT_PREFIX) || !name.endsWith('.html')) continue;
    const file = path.join(dir, name);
    try {
      if (Date.now() - fs.statSync(file).mtimeMs > REDIRECT_TTL_MS) fs.rmSync(file, { force: true });
    } catch {
      /* best effort */
    }
  }
  const file = path.join(dir, `${REDIRECT_PREFIX}${randomUUID()}.html`);
  fs.writeFileSync(file, redirectHtml(url), { flag: 'wx', mode: 0o600 });
  setTimeout(() => fs.rm(file, { force: true }, () => undefined), REDIRECT_TTL_MS);
  return file;
}

/** Opens the read-only local Web page in the default browser, signed in. */
export async function openLocalWeb(api: ControlApi, daemon: DaemonManager, port: () => number): Promise<void> {
  if (env.remoteName) {
    void window.showInformationMessage('BlackHole：远程窗口暂不支持本地 Web，请在本机 VS Code 窗口中打开。');
    return;
  }
  if (!(await daemon.ensureRunning())) {
    void window.showErrorMessage('BlackHole：daemon 未运行，无法打开本地 Web。详见输出面板。');
    return;
  }
  let url: string;
  try {
    const issued = await api.webBootstrap();
    url = localWebUrl(port(), issued.path, issued.ticket);
  } catch (e) {
    const code = e instanceof Error ? e.message : String(e);
    const status = (e as { status?: number }).status;
    void window.showErrorMessage(
      code === 'web_assets_missing'
        ? 'BlackHole：本地 Web 页面缺失，请重新安装扩展。'
        : status === 404
          ? 'BlackHole：当前 daemon 版本不支持本地 Web，请重启 daemon 后再试。'
          : `BlackHole：打开本地 Web 失败（${code}）`,
    );
    return;
  }
  let opened = false;
  try {
    opened = await env.openExternal(Uri.file(writeRedirect(url)));
  } catch {
    opened = false;
  }
  if (opened) return;
  const pick = await window.showWarningMessage('BlackHole：无法通过临时文件打开浏览器。', '直接打开');
  if (pick === '直接打开') {
    // The first ticket may have expired while the prompt was open.
    try {
      const issued = await api.webBootstrap();
      await env.openExternal(Uri.parse(localWebUrl(port(), issued.path, issued.ticket)));
    } catch (e) {
      void window.showErrorMessage(`BlackHole：打开本地 Web 失败（${e instanceof Error ? e.message : String(e)}）`);
    }
  }
}
