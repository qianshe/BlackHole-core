import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { CoreLifecycle } from './core-lifecycle.ts';
import { HeartbeatCoreRequestSchema } from '../../contracts/src/manager-protocol.ts';
import { resolveDataPaths } from '../../../src/data-paths.ts';
import { localWebUrl, writeRedirect, REDIRECT_TTL_MS } from './redirect.ts';

export async function openManagedBrowser(lifecycle: CoreLifecycle, input: unknown, openFile: (file: string) => Promise<boolean> = open): Promise<{ opened: boolean }> {
  const request = HeartbeatCoreRequestSchema.parse(input);
  await lifecycle.heartbeat(request); // Never starts or restarts a daemon.
  const body = await ticket(request.port);
  const url = localWebUrl(request.port, body.path ?? '', body.ticket ?? '');
  const file = writeRedirect(resolveDataPaths({ env: lifecycle.env }).runtimeState, url);
  try {
    if (!await openFile(file)) throw new Error('browser_unavailable');
    // Failure to schedule deletion does not invalidate an already-opened
    // browser; expired tickets are also swept on the next attempt.
    await lifecycle.scheduleRedirectCleanup(request.handle, file, REDIRECT_TTL_MS).catch(() => undefined);
    return { opened: true };
  } catch (e) { fs.rmSync(file, { force: true }); throw e; }
}
function ticket(port: number): Promise<{ ticket?: string; path?: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/web/bootstrap', method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': 2 } }, res => {
      const chunks: Buffer[] = []; let size = 0;
      res.on('data', (value: Buffer) => { size += value.length; if (size > 4096) res.destroy(new Error('web_ticket_invalid')); else chunks.push(value); });
      res.on('error', () => reject(new Error('web_ticket_unavailable')));
      res.on('end', () => { try { if (res.statusCode !== 200) throw new Error(); const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!body || typeof body.ticket !== 'string' || typeof body.path !== 'string') throw new Error(); resolve(body); } catch { reject(new Error('web_ticket_invalid')); } });
    });
    const timer = setTimeout(() => req.destroy(new Error('web_ticket_timeout')), 5000);
    req.once('close', () => clearTimeout(timer)); req.once('error', () => reject(new Error('web_ticket_unavailable'))); req.end('{}');
  });
}

function open(file: string): Promise<boolean> {
  const command = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'rundll32.exe') : process.platform === 'darwin' ? '/usr/bin/open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', file] : [file];
  return new Promise(resolve => { const child = spawn(command, args, { detached: true, windowsHide: true, stdio: 'ignore' }); child.once('error', () => resolve(false)); child.once('spawn', () => { child.unref(); resolve(true); }); });
}
