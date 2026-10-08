// 渠道总开关（用户 2026-10-03）：VS Code 侧边栏、本地 Web、设置页共用的「一键开/关」。
// 开 = 启动上次使用的渠道（没有就按当前标签选默认）；关 = 停止所有渠道，等同手动停止。
// 逻辑放在 daemon，多个窗口和页面看到的状态一致。
import fs from 'node:fs';
import path from 'node:path';
import type { MachineStateRepo } from '../storage/machineState.js';
import type { TunnelKind, TunnelStatus } from './manager.js';
import type { OpenAITunnelStatus } from './openai-manager.js';
import type { ChannelIntent } from './resume.js';

export type ChannelChoice = TunnelKind | 'openai';
const LAST_KEY = 'channel.last.v1';

/**
 * 上次手动启动的渠道。和 ChannelIntent（自动恢复用）不同：停止不清除，
 * 这样关掉以后还能一键再开。
 */
export class LastChannel {
  constructor(private readonly state: Pick<MachineStateRepo, 'get' | 'set'>) {}

  get(): ChannelChoice | null {
    const v = this.state.get(LAST_KEY);
    return v === 'quick' || v === 'named' || v === 'openai' ? v : null;
  }

  set(choice: ChannelChoice): void {
    if (this.get() !== choice) this.state.set(LAST_KEY, choice);
  }
}

const binCache = new Map<string, { at: number; ok: boolean }>();
const isFile = (p: string): boolean => {
  try { return fs.statSync(p).isFile(); } catch { return false; }
};

/**
 * cloudflared 是否在磁盘上（配置的路径，或 PATH 里的同名程序）。只看文件是否存在，
 * 不运行它：页面会反复轮询，结果缓存 10 秒。真正启动时渠道管理器还会再验证一次。
 */
export function cloudflaredOnDisk(bin: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, now = Date.now()): boolean {
  const key = `${platform}|${bin}|${env.PATH ?? ''}`;
  const hit = binCache.get(key);
  if (hit && now - hit.at < 10_000) return hit.ok;
  let ok: boolean;
  if (!bin) ok = false;
  else if (bin.includes('/') || bin.includes('\\')) ok = isFile(bin);
  else {
    const win = platform === 'win32';
    const exts = win && !/\.[a-z0-9]+$/i.test(bin) ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean) : [''];
    const dirs = (env.PATH ?? '').split(win ? ';' : ':').filter(Boolean);
    ok = dirs.some((d) => exts.some((e) => isFile(path.join(d, bin + e))));
  }
  binCache.set(key, { at: now, ok });
  return ok;
}

/** 打开开关前缺少的前提；页面据此引导安装或打开对应设置。 */
export type SwitchMissing = 'cloudflared' | 'named_url' | 'openai_setup' | 'openai_unavailable';
export type SwitchState = 'off' | 'starting' | 'on' | 'warn' | 'error';

export interface ChannelSwitchView {
  /** 有渠道在运行（含启动中）。 */
  on: boolean;
  state: SwitchState;
  running: ChannelChoice[];
  /** 正在运行的渠道；关着时为打开开关会启动的渠道。 */
  next: ChannelChoice;
  last: ChannelChoice | null;
  missing: SwitchMissing | null;
  reason: string | null;
}

export interface SwitchDeps {
  tunnel: { status: TunnelStatus; mode?: TunnelKind; reason?: string; start(kind: TunnelKind): unknown; stop(): Promise<unknown> };
  openai?: {
    status: OpenAITunnelStatus;
    live: boolean;
    credentialRevision: number;
    view(): { run_id: string | null; credential_configured: boolean | null; reason: string | null };
    start(req: { settingsRevision: number; credentialRevision: number }): Promise<unknown>;
    stop(runId: string | null): Promise<unknown>;
  };
  settings?: { get(): { revision: number; values: { channelMode: string; openaiTunnelId: string; openaiTunnelClientPath: string } } };
  /** 持久渠道的固定地址（daemon 启动时读入的 publicBaseUrl）。 */
  namedUrl: () => string | undefined;
  cloudflaredReady: () => boolean;
  last: LastChannel;
  intent?: ChannelIntent;
  /** 显式开启来自有心跳的客户端：喜一下看门狗（同 /tunnel/start）。 */
  heartbeat?: () => void;
}

const CF_LIVE: readonly TunnelStatus[] = ['starting', 'online', 'unverified'];

function running(d: SwitchDeps): ChannelChoice[] {
  const out: ChannelChoice[] = [];
  if (CF_LIVE.includes(d.tunnel.status)) out.push(d.tunnel.mode === 'named' ? 'named' : 'quick');
  if (d.openai?.live) out.push('openai');
  return out;
}

/** 打开时要启动的渠道：上次使用的；从没用过时 OpenAI 标签用 OpenAI，其余有持久地址用持久，否则临时。 */
export function nextChannel(d: SwitchDeps): ChannelChoice {
  const last = d.last.get();
  if (last) return last;
  if (d.settings?.get().values.channelMode === 'openai') return 'openai';
  return d.namedUrl() ? 'named' : 'quick';
}

export function missingFor(d: SwitchDeps, choice: ChannelChoice): SwitchMissing | null {
  if (choice === 'openai') {
    if (!d.openai) return 'openai_unavailable';
    const v = d.settings?.get().values;
    if (!v?.openaiTunnelId?.trim() || !v?.openaiTunnelClientPath?.trim() || d.openai.view().credential_configured === false) return 'openai_setup';
    return null;
  }
  if (!d.cloudflaredReady()) return 'cloudflared';
  if (choice === 'named' && !d.namedUrl()) return 'named_url';
  return null;
}

export function switchView(d: SwitchDeps): ChannelSwitchView {
  const run = running(d);
  const cf = d.tunnel.status;
  const oa = d.openai?.status;
  let state: SwitchState;
  if (!run.length) state = cf === 'error' || cf === 'unavailable' || oa === 'error' ? 'error' : 'off';
  else if (cf === 'starting' || oa === 'starting' || oa === 'recovering') state = 'starting';
  else if (cf === 'unverified') state = 'warn';
  else state = 'on';
  const reason = state === 'error'
    ? (cf === 'error' || cf === 'unavailable' ? d.tunnel.reason : d.openai?.view().reason) ?? null
    : state === 'warn' ? d.tunnel.reason ?? null : null;
  const next = run[0] ?? nextChannel(d);
  return { on: run.length > 0, state, running: run, next, last: d.last.get(), missing: run.length ? null : missingFor(d, next), reason };
}

export type SwitchResult = { ok: true; view: ChannelSwitchView } | { ok: false; code: string; view: ChannelSwitchView };

/** 打开：已有渠道在运行就不动；缺前提时不启动，返回缺少的那一项。 */
export async function switchOn(d: SwitchDeps): Promise<SwitchResult> {
  const before = switchView(d);
  if (before.on) return { ok: true, view: before };
  const choice = before.next;
  const missing = missingFor(d, choice);
  if (missing) return { ok: false, code: missing, view: before };
  if (choice === 'openai') {
    const s = d.settings!.get();
    try {
      await d.openai!.start({ settingsRevision: s.revision, credentialRevision: d.openai!.credentialRevision });
    } catch (e) {
      const code = (e as { code?: unknown } | null)?.code;
      return { ok: false, code: typeof code === 'string' ? code : 'start_failed', view: switchView(d) };
    }
  } else {
    d.tunnel.start(choice);
    // 管理器在启动前就拒绝了（例如 cloudflared 跑不起来）：不记入「上次使用」。
    if (!CF_LIVE.includes(d.tunnel.status)) return { ok: false, code: 'start_failed', view: switchView(d) };
    d.intent?.set(choice);
  }
  d.last.set(choice);
  d.heartbeat?.();
  return { ok: true, view: switchView(d) };
}

/** 关闭：停止所有渠道，并清掉自动恢复（等同手动停止）；「上次使用」保留。 */
export async function switchOff(d: SwitchDeps): Promise<ChannelSwitchView> {
  d.intent?.clear();
  await d.tunnel.stop();
  if (d.openai?.live) await d.openai.stop(d.openai.view().run_id);
  return switchView(d);
}
