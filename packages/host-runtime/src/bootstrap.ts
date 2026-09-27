/**
 * Short-lived bootstrap run by the desktop launcher with a plain `node`:
 *   node bootstrap.cjs --daemon-entry <cli.js> [--port N] [--no-browser]
 * Attaches to a healthy daemon or starts one detached, issues a one-time local
 * Web ticket, opens the browser through a redirect file and prints exactly one
 * bounded LaunchResult JSON line on stdout. Never prints the ticket.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  HOST_PROTOCOL_VERSION,
  LAUNCH_RESULT_MAX_BYTES,
  LaunchResultSchema,
  type LaunchErrorCode,
  type LaunchResult,
  type ReadyReceipt,
} from '../../contracts/src/host-protocol.ts';
import { localWebUrl, REDIRECT_TTL_MS, writeRedirect } from './redirect.ts';

const DEFAULT_PORT = 7306;
const READY_TIMEOUT_MS = 30_000;

class LaunchError extends Error {
  constructor(readonly code: LaunchErrorCode, message: string, readonly logPath?: string, readonly receipt?: ReadyReceipt) {
    super(message);
  }
}

export interface Args {
  daemonEntry: string;
  port: number;
  openBrowser: boolean;
  readyTimeoutMs: number;
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv): Args {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const daemonEntry = flag('--daemon-entry');
  if (!daemonEntry) throw new LaunchError('runtime_asset_missing', '缺少 --daemon-entry');
  const port = Number(flag('--port') ?? env.BLACKHOLE_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new LaunchError('port_conflict', `端口无效：${String(port)}`);
  const timeout = Number(flag('--ready-timeout') ?? READY_TIMEOUT_MS);
  return {
    daemonEntry: path.resolve(daemonEntry),
    port,
    openBrowser: !argv.includes('--no-browser'),
    readyTimeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : READY_TIMEOUT_MS,
  };
}

/** Same data dir rule as the daemon: next to BLACKHOLE_DB, else ~/.blackhole. */
export function dataDir(env: NodeJS.ProcessEnv): string {
  return env.BLACKHOLE_DB ? path.dirname(path.resolve(env.BLACKHOLE_DB)) : path.join(os.homedir(), '.blackhole');
}

interface Health {
  ok: boolean;
  version: string;
  daemon_id: string;
  db_path?: string;
}

type Probe = { state: 'down' } | { state: 'foreign' } | { state: 'ok'; health: Health };

async function probe(port: number): Promise<Probe> {
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
  } catch {
    return { state: 'down' };
  }
  const body = (await res.json().catch(() => null)) as Partial<Health> | null;
  if (res.ok && body?.ok === true && typeof body.daemon_id === 'string' && typeof body.version === 'string') {
    return { state: 'ok', health: body as Health };
  }
  return { state: 'foreign' };
}

function startDaemon(args: Args, logPath: string): { exited: () => number | null } {
  if (!fs.existsSync(args.daemonEntry)) throw new LaunchError('runtime_asset_missing', `找不到 daemon 入口：${args.daemonEntry}`);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const log = fs.openSync(logPath, 'a');
  const child = spawn(process.execPath, [args.daemonEntry, 'serve', '--port', String(args.port)], {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', log, log],
    env: { ...process.env, BLACKHOLE_PORT: String(args.port) },
  });
  let code: number | null = null;
  child.on('exit', (c) => {
    code = c ?? -1;
  });
  child.on('error', () => {
    code = -1;
  });
  child.unref();
  fs.closeSync(log);
  return { exited: () => code };
}

async function waitReady(args: Args, logPath: string, exited: () => number | null): Promise<Health> {
  const deadline = Date.now() + args.readyTimeoutMs;
  while (Date.now() < deadline) {
    const code = exited();
    if (code !== null) throw new LaunchError('kernel_exited', `daemon 启动后退出（代码 ${code}）`, logPath);
    const p = await probe(args.port);
    if (p.state === 'ok') return p.health;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new LaunchError('ready_timeout', `daemon 在 ${Math.round(args.readyTimeoutMs / 1000)} 秒内未就绪`, logPath);
}

async function api<T>(port: number, method: string, route: string): Promise<{ status: number; body: T }> {
  const res = await fetch(`http://127.0.0.1:${port}/api${route}`, {
    method,
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(5000),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
}

async function buildReceipt(port: number, health: Health, spawned: boolean): Promise<ReadyReceipt> {
  const settings = await api<{ revision?: number }>(port, 'GET', '/settings').catch(() => null);
  const instanceSource = health.db_path ?? `127.0.0.1:${port}`;
  return {
    protocolVersion: HOST_PROTOCOL_VERSION,
    instanceKey: createHash('sha256').update(instanceSource).digest('hex').slice(0, 16),
    daemonId: health.daemon_id,
    daemonVersion: health.version,
    // T1: /api/health does not report the runtime yet; an attached daemon may be VS Code's (T2 handshake).
    runtimeKind: spawned ? 'standalone-node' : 'vscode-electron',
    uiVersion: health.version,
    configRevision: Number.isInteger(settings?.body.revision) ? (settings!.body.revision as number) : 0,
    localUrl: `http://127.0.0.1:${port}/`,
    webApiBase: '../web-api/v1/',
    capabilities: ['web-ui'],
  };
}

function openerFor(file: string): [string, string[]] {
  if (process.platform === 'win32') return ['rundll32.exe', ['url.dll,FileProtocolHandler', file]];
  if (process.platform === 'darwin') return ['open', [file]];
  return ['xdg-open', [file]];
}

function openBrowser(file: string): Promise<boolean> {
  const [cmd, argv] = openerFor(file);
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { detached: true, windowsHide: true, stdio: 'ignore' });
    child.once('error', () => resolve(false));
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}

/** The bootstrap exits right away; a detached helper removes the redirect file once the ticket has expired. */
function scheduleRemoval(file: string): void {
  const script = `setTimeout(()=>{try{require('fs').rmSync(${JSON.stringify(file)},{force:true})}catch{}},${REDIRECT_TTL_MS})`;
  const child = spawn(process.execPath, ['-e', script], { detached: true, windowsHide: true, stdio: 'ignore' });
  child.on('error', () => undefined);
  child.unref();
}

export async function launch(argv: string[], env: NodeJS.ProcessEnv): Promise<LaunchResult> {
  const args = parseArgs(argv, env);
  const dir = dataDir(env);
  const logPath = path.join(dir, 'logs', 'launcher-daemon.log');

  let spawned = false;
  let health: Health;
  const first = await probe(args.port);
  if (first.state === 'foreign') throw new LaunchError('port_conflict', `端口 ${args.port} 已被其他程序占用`);
  if (first.state === 'ok') {
    health = first.health;
  } else {
    const child = startDaemon(args, logPath);
    spawned = true;
    health = await waitReady(args, logPath, child.exited);
  }

  const receipt = await buildReceipt(args.port, health, spawned);
  if (!args.openBrowser) return { ok: true, receipt, browserOpened: false };

  const issued = await api<{ ticket?: string; path?: string; error?: string }>(args.port, 'POST', '/web/bootstrap');
  if (issued.status === 404) throw new LaunchError('protocol_incompatible', `正在运行的 BlackHole（${health.version}）版本较旧，不支持网页界面。请把 VS Code 扩展更新到最新版，并重启 BlackHole 后再试。`, undefined, receipt);
  if (issued.body.error === 'web_assets_missing') throw new LaunchError('runtime_asset_missing', '本地 Web 页面缺失，请重新安装', undefined, receipt);
  if (issued.status !== 200 || !issued.body.ticket || !issued.body.path) {
    throw new LaunchError('protocol_incompatible', `无法获取登录凭据（${issued.body.error ?? issued.status}）`, undefined, receipt);
  }
  const url = localWebUrl(args.port, issued.body.path, issued.body.ticket);
  const file = writeRedirect(path.join(dir, 'runtime-state'), url);
  scheduleRemoval(file);
  if (!(await openBrowser(file))) {
    return { ok: false, code: 'browser_unavailable', message: `无法打开浏览器，请手动访问 ${receipt.localUrl}`, receipt };
  }
  return { ok: true, receipt, browserOpened: true };
}

export interface StopResult { ok: boolean; stopped: boolean; code?: 'not_running' | 'port_conflict' | 'stop_rejected' | 'stop_timeout'; message?: string }

/** `--stop`: the same graceful shutdown VS Code "Stop Daemon" uses; waits until the port is released. */
export async function stop(argv: string[], env: NodeJS.ProcessEnv, timeoutMs = 15_000): Promise<StopResult> {
  const i = argv.indexOf('--port');
  const port = Number((i >= 0 ? argv[i + 1] : undefined) ?? env.BLACKHOLE_PORT ?? DEFAULT_PORT);
  const first = await probe(port);
  if (first.state === 'down') return { ok: true, stopped: false, code: 'not_running' };
  if (first.state === 'foreign') return { ok: false, stopped: false, code: 'port_conflict', message: `port ${port} is used by another program` };
  const h = first.health as Health & { start_fingerprint?: string };
  const res = await fetch(`http://127.0.0.1:${port}/api/shutdown`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ daemon_id: h.daemon_id, start_fingerprint: h.start_fingerprint ?? null }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => null);
  if (res && !res.ok) return { ok: false, stopped: false, code: 'stop_rejected', message: `HTTP ${res.status}` };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await probe(port)).state === 'down') return { ok: true, stopped: true };
    await new Promise((r) => setTimeout(r, 250));
  }
  return { ok: false, stopped: false, code: 'stop_timeout' };
}


function emit(result: LaunchResult): void {
  const parsed = LaunchResultSchema.parse(result);
  let line = JSON.stringify(parsed);
  if (Buffer.byteLength(line) > LAUNCH_RESULT_MAX_BYTES) {
    line = JSON.stringify({ ok: false, code: 'kernel_exited', message: 'launch result too large' });
  }
  process.stdout.write(`${line}\n`);
}

async function main(): Promise<void> {
  if (process.argv.includes('--stop')) {
    const r = await stop(process.argv.slice(2), process.env).catch((e: unknown) => ({ ok: false, stopped: false, code: 'stop_rejected', message: String(e) }) as StopResult);
    process.stdout.write(`${JSON.stringify(r)}\n`);
    process.exitCode = r.ok ? 0 : 1;
    return;
  }
  let result: LaunchResult;
  try {
    result = await launch(process.argv.slice(2), process.env);
  } catch (e) {
    result = e instanceof LaunchError
      ? { ok: false, code: e.code, message: e.message.slice(0, 2000), ...(e.logPath ? { logPath: e.logPath } : {}), ...(e.receipt ? { receipt: e.receipt } : {}) }
      : { ok: false, code: 'kernel_exited', message: (e instanceof Error ? e.message : String(e)).slice(0, 2000) || 'unknown error' };
  }
  emit(result);
  process.exitCode = result.ok ? 0 : 1;
}

void main();
