import type { MachineStateRepo } from '../storage/machineState.js';
import type { Config } from '../config.js';
import { SEMANTIC_MODES, type SemanticMode } from '../config.js';

/**
 * Daemon-owned user settings. The daemon is the source of truth; the VS Code
 * extension mirrors them into its own configuration so its settings panel and
 * restart fingerprint keep working, and the Local Web / app edit them directly.
 *
 * Stored as one versioned machine_state row. `seeded` lists the keys that have
 * received a first copy (from the extension or a save). Until a key is seeded
 * the daemon keeps using whatever the launching process passed in its
 * environment, and the extension may still hand over its value once. This is
 * what lets keys added later (the 0.3.178 five) migrate without overwriting
 * values users already set in VS Code.
 */
export const SETTINGS_KEY = 'settings.v1';

export interface CustomWebAgent {
  name: string;
  url: string;
}

/**
 * A web agent site added in the Courier extension (检测此页面). Courier owns the shape; the daemon
 * keeps the list so every UI can offer the site for a new chat and delete it (Courier then
 * unregisters its page scripts and gives the host permission back).
 */
export interface CourierSite {
  id: string;
  name: string;
  origin: string;
  newChatPath: string;
  dom: { editor: string; send: string; stop: string | null; model: null };
  key: { prefix: string } | null;
  detectedAt: number;
  v: 1;
}

export interface Settings {
  connectorName: string;
  publicBaseUrl: string;
  cloudflaredPath: string;
  skillsDir: string;
  /** Default connection info / editing preference only; never gates whether a channel may run (plan §5.1). */
  channelMode: 'cloudflare' | 'openai' | 'custom';
  semanticMode: SemanticMode;
  gitUsrBinPath: string;
  namedTunnelName: string;
  tunnelProbeProxy: string;
  webAgents: string[];
  customWebAgents: CustomWebAgent[];
  /** Phone access over the https public address (plan 6.13 R); off by default. */
  remoteAccess: boolean;
  /** OpenAI tunnel-client runtime path (plan §4); read at the next explicit OpenAI start. */
  openaiTunnelClientPath: string;
  /** Saved OpenAI Tunnel ID: not a URL and not a secret. */
  openaiTunnelId: string;
  /** Courier sites added by detection (daemon-owned, not a VS Code setting). */
  courierSites: CourierSite[];
}

export interface SettingsRecord {
  revision: number;
  migrated: boolean;
  seeded: SettingKey[];
  values: Settings;
  updated_at: string | null;
}

/** The first six keys (0.3.174). Records written before `seeded` existed had all of them. */
export const V1_SETTING_KEYS = ['connectorName', 'publicBaseUrl', 'cloudflaredPath', 'skillsDir', 'channelMode', 'semanticMode'] as const;
export const SETTING_KEYS = [...V1_SETTING_KEYS, 'gitUsrBinPath', 'namedTunnelName', 'tunnelProbeProxy', 'webAgents', 'customWebAgents', 'remoteAccess', 'openaiTunnelClientPath', 'openaiTunnelId', 'courierSites'] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

/**
 * Keys read only at daemon start: a change needs a restart to take effect.
 * channelMode is a view/default preference, not a restart key; OpenAI keys are
 * read at the next explicit OpenAI start, never through a daemon restart.
 */
export const RESTART_SETTING_KEYS: readonly SettingKey[] = [
  'publicBaseUrl', 'cloudflaredPath', 'skillsDir', 'semanticMode',
  'gitUsrBinPath', 'namedTunnelName', 'tunnelProbeProxy',
];

/** Same default as the extension's `blackhole.webAgents` (tests keep them equal). */
export const DEFAULT_WEB_AGENTS = ['ChatGPT', 'WorkBuddy', 'Manus', 'Trae CN', 'Trae AI', 'Arena'];

export const DEFAULT_SETTINGS: Settings = {
  connectorName: '',
  publicBaseUrl: '',
  cloudflaredPath: '',
  skillsDir: '',
  channelMode: 'cloudflare',
  semanticMode: 'explicit',
  gitUsrBinPath: '',
  namedTunnelName: 'blackhole',
  tunnelProbeProxy: '',
  webAgents: [...DEFAULT_WEB_AGENTS],
  customWebAgents: [],
  remoteAccess: true,
  openaiTunnelClientPath: '',
  openaiTunnelId: '',
  courierSites: [],
};

const MAX_TEXT = 1000;
const MAX_AGENTS = 50;
const MAX_AGENT_NAME = 64;
export const MAX_COURIER_SITES = 20;
/** Sites the Courier extension supports without detection. */
export const BUILTIN_COURIER_SITES = [{ id: 'arena', name: 'Arena', origin: 'https://arena.ai' }, { id: 'chatgpt', name: 'ChatGPT', origin: 'https://chatgpt.com' }] as const;
const COURIER_SITE_ID = /^c-[a-z0-9-]{1,30}$/;
const MAX_SELECTOR = 300;

function courierPath(v: unknown): string | null {
  return typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') && v.length <= 200 && !/[\s?#]/.test(v) ? v : null;
}
function selector(v: unknown): string | null {
  return typeof v === 'string' && v.trim() && v.length <= MAX_SELECTOR && !/[\u0000-\u001f]/.test(v) ? v.trim() : null;
}
/** One Courier site profile (same rules as the extension's sites.js cleanProfile), or an error. */
export function normalizeCourierSite(raw: unknown): { value: CourierSite } | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'courierSites items must be objects' };
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' && COURIER_SITE_ID.test(r.id) ? r.id : null;
  if (!id) return { error: 'courierSites id must look like c-example-com' };
  const name = typeof r.name === 'string' ? r.name.trim() : '';
  if (!name || name.length > 40 || /[\u0000-\u001f]/.test(name)) return { error: 'courierSites name must be 1-40 characters' };
  let origin: URL | null = null;
  try { origin = new URL(String(r.origin)); } catch { /* invalid */ }
  if (!origin || origin.protocol !== 'https:' || origin.origin !== r.origin) return { error: 'courierSites origin must be a bare https origin' };
  if (BUILTIN_COURIER_SITES.some((b) => b.origin === origin!.origin)) return { error: 'courierSites cannot replace a built-in site' };
  const newChatPath = courierPath(r.newChatPath);
  if (!newChatPath) return { error: 'courierSites newChatPath must be a path such as /' };
  const dom = (r.dom && typeof r.dom === 'object' ? r.dom : {}) as Record<string, unknown>;
  const editor = selector(dom.editor);
  const send = selector(dom.send);
  if (!editor || !send) return { error: 'courierSites dom.editor and dom.send are required selectors' };
  const stop = dom.stop == null ? null : selector(dom.stop);
  if (dom.stop != null && !stop) return { error: 'courierSites dom.stop must be a selector or null' };
  const prefix = r.key == null ? null : courierPath((r.key as { prefix?: unknown }).prefix);
  if (r.key != null && (!prefix || !prefix.endsWith('/'))) return { error: 'courierSites key.prefix must be a path ending in /' };
  const detectedAt = typeof r.detectedAt === 'number' && Number.isFinite(r.detectedAt) && r.detectedAt >= 0 ? Math.floor(r.detectedAt) : 0;
  return { value: { id, name, origin: origin.origin, newChatPath, dom: { editor, send, stop, model: null }, key: prefix ? { prefix } : null, detectedAt, v: 1 } };
}

export function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function text(key: string, raw: unknown): { value: string } | { error: string } {
  if (typeof raw !== 'string') return { error: `${key} must be a string` };
  const v = raw.trim();
  if (v.length > MAX_TEXT) return { error: `${key} is too long` };
  if (/[\u0000-\u001f]/.test(v)) return { error: `${key} contains control characters` };
  return { value: v };
}

function httpUrl(v: string): URL | null {
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u : null;
  } catch {
    return null;
  }
}

/** Validate one value; returns the normalized value or an error message. */
export function normalizeSetting(key: SettingKey, raw: unknown): { value: unknown } | { error: string } {
  if (key === 'webAgents') {
    if (!Array.isArray(raw)) return { error: 'webAgents must be an array of names' };
    const out: string[] = [];
    for (const item of raw) {
      const t = text('webAgents', item);
      if ('error' in t) return t;
      if (!t.value || t.value.length > MAX_AGENT_NAME) return { error: `webAgents names must be 1-${MAX_AGENT_NAME} characters` };
      if (!out.includes(t.value)) out.push(t.value);
    }
    return out.length > MAX_AGENTS ? { error: `at most ${MAX_AGENTS} webAgents` } : { value: out };
  }
  if (key === 'customWebAgents') {
    if (!Array.isArray(raw)) return { error: 'customWebAgents must be an array' };
    if (raw.length > MAX_AGENTS) return { error: `at most ${MAX_AGENTS} customWebAgents` };
    const out: CustomWebAgent[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return { error: 'customWebAgents items must be { name, url }' };
      const name = text('customWebAgents.name', (item as { name?: unknown }).name);
      const url = text('customWebAgents.url', (item as { url?: unknown }).url);
      if ('error' in name) return name;
      if ('error' in url) return url;
      if (!name.value || name.value.length > MAX_AGENT_NAME) return { error: `customWebAgents names must be 1-${MAX_AGENT_NAME} characters` };
      if (!httpUrl(url.value)) return { error: 'customWebAgents url must be a full http(s) URL' };
      out.push({ name: name.value, url: url.value });
    }
    return { value: out };
  }
  if (key === 'courierSites') {
    if (!Array.isArray(raw)) return { error: 'courierSites must be an array' };
    if (raw.length > MAX_COURIER_SITES) return { error: `at most ${MAX_COURIER_SITES} courierSites` };
    const out: CourierSite[] = [];
    for (const item of raw) {
      const n = normalizeCourierSite(item);
      if ('error' in n) return n;
      if (out.some((x) => x.id === n.value.id || x.origin === n.value.origin)) return { error: `courierSites has ${n.value.origin} twice` };
      out.push(n.value);
    }
    return { value: out };
  }
  if (key === 'remoteAccess') return typeof raw === 'boolean' ? { value: raw } : { error: 'remoteAccess must be true or false' };
  const t = text(key, raw);
  if ('error' in t) return t;
  const v = t.value;
  switch (key) {
    case 'connectorName':
      return v.replace(/^@+/, '').length > 64 ? { error: 'connectorName is too long (max 64)' } : { value: v.replace(/^@+/, '') };
    case 'publicBaseUrl': {
      if (!v) return { value: '' };
      const u = httpUrl(v);
      if (!u) return { error: 'publicBaseUrl must be a full http(s) URL' };
      if (u.username || u.password || u.search || u.hash || u.pathname.replace(/\/+$/, '') !== '') return { error: 'publicBaseUrl must be a bare origin such as https://example.com' };
      return { value: v.replace(/\/+$/, '') };
    }
    case 'tunnelProbeProxy': {
      if (!v) return { value: '' };
      const u = httpUrl(v);
      if (!u || !u.port || u.search || u.hash || u.pathname.replace(/\/+$/, '') !== '') return { error: 'tunnelProbeProxy must look like http://127.0.0.1:7890' };
      return { value: v.replace(/\/+$/, '') };
    }
    case 'namedTunnelName':
      return !v || /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v) ? { value: v || 'blackhole' } : { error: 'namedTunnelName may only use letters, digits, dot, dash and underscore (max 64)' };
    case 'channelMode':
      return v === 'cloudflare' || v === 'openai' || v === 'custom' ? { value: v } : { error: 'channelMode must be cloudflare, openai or custom' };
    case 'openaiTunnelId':
      // An identifier from Platform tunnel settings; a URL here is always a mistake (plan R6).
      return !v || /^tunnel_[0-9a-f]{32}$/.test(v) ? { value: v } : { error: 'openaiTunnelId must be the Tunnel ID from Platform tunnel settings (tunnel_ + 32 lowercase hex), not a URL' };
    case 'semanticMode':
      return (SEMANTIC_MODES as readonly string[]).includes(v) ? { value: v } : { error: `semanticMode must be one of ${SEMANTIC_MODES.join(', ')}` };
    default:
      return { value: v };
  }
}

/** Validate a partial update; unknown keys are an error. */
export function normalizeSettingsPatch(input: unknown): { values: Partial<Settings> } | { error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'values must be an object' };
  const out: Record<string, unknown> = {};
  for (const [k, raw] of Object.entries(input)) {
    if (!(SETTING_KEYS as readonly string[]).includes(k)) return { error: `unknown setting: ${k}` };
    const r = normalizeSetting(k as SettingKey, raw);
    if ('error' in r) return r;
    out[k] = r.value;
  }
  return { values: out as Partial<Settings> };
}

function seededKeys(parsed: Partial<SettingsRecord>): SettingKey[] {
  if (Array.isArray(parsed.seeded)) return SETTING_KEYS.filter((k) => (parsed.seeded as unknown[]).includes(k));
  return parsed.migrated === true ? [...V1_SETTING_KEYS] : [];
}

export class SettingsStore {
  constructor(private readonly state: MachineStateRepo) {}

  get(): SettingsRecord {
    try {
      const parsed = JSON.parse(this.state.get(SETTINGS_KEY) ?? 'null') as Partial<SettingsRecord> | null;
      if (parsed && typeof parsed === 'object') {
        const values = structuredClone(DEFAULT_SETTINGS);
        for (const k of SETTING_KEYS) {
          const stored = (parsed.values as Record<string, unknown> | undefined)?.[k];
          if (stored === undefined) continue;
          const r = normalizeSetting(k, stored);
          if ('value' in r) (values as unknown as Record<string, unknown>)[k] = r.value;
        }
        return {
          revision: Number(parsed.revision) || 0,
          migrated: parsed.migrated === true,
          seeded: seededKeys(parsed),
          values,
          updated_at: typeof parsed.updated_at === 'string' ? parsed.updated_at : null,
        };
      }
    } catch {
      /* corrupt row: treat as empty */
    }
    return { revision: 0, migrated: false, seeded: [], values: structuredClone(DEFAULT_SETTINGS), updated_at: null };
  }

  /**
   * Apply a validated patch. `expectedRevision` (when given) must match the
   * stored revision, so two editors never silently overwrite each other.
   * Every key in the patch counts as seeded, even when its value is unchanged.
   */
  update(patch: Partial<Settings>, expectedRevision?: number): { record: SettingsRecord; changed: SettingKey[] } | { conflict: SettingsRecord } {
    const current = this.get();
    if (expectedRevision !== undefined && expectedRevision !== current.revision) return { conflict: current };
    const changed = SETTING_KEYS.filter((k) => patch[k] !== undefined && !sameValue(patch[k], current.values[k]));
    const newlySeeded = SETTING_KEYS.filter((k) => patch[k] !== undefined && !current.seeded.includes(k));
    if (changed.length === 0 && newlySeeded.length === 0 && current.migrated) return { record: current, changed };
    const record: SettingsRecord = {
      revision: current.revision + 1,
      migrated: true,
      seeded: SETTING_KEYS.filter((k) => current.seeded.includes(k) || newlySeeded.includes(k)),
      values: { ...current.values, ...patch },
      updated_at: new Date().toISOString(),
    };
    this.state.set(SETTINGS_KEY, JSON.stringify(record));
    return { record, changed };
  }
}

/** Keys the extension may still hand over once (not yet seeded). */
export function unseededKeys(record: SettingsRecord): SettingKey[] {
  return SETTING_KEYS.filter((k) => !record.seeded.includes(k) && !DAEMON_ONLY_KEYS.includes(k));
}

/** Owned by the daemon from the start: never handed over by the extension. */
export const DAEMON_ONLY_KEYS: readonly SettingKey[] = ['remoteAccess', 'courierSites'];

/**
 * Startup overlay: seeded daemon-owned settings win over the launcher's
 * environment; unseeded keys keep the launcher's value. Explicit programmatic
 * overrides (tests, CLI flags) still win. An empty cloudflared path keeps the
 * launcher's value (the extension passes its bundled binary there). The
 * overlay can switch the public tunnel off but never on: whether to start one
 * stays with the launcher.
 */
export function applySettingsToConfig(cfg: Config, record: SettingsRecord, explicit: ReadonlySet<string> = new Set(), env: NodeJS.ProcessEnv = process.env): void {
  if (!record.migrated) return;
  const v = record.values;
  const own = (k: SettingKey) => record.seeded.includes(k);
  if (own('publicBaseUrl') && !explicit.has('publicBaseUrl')) cfg.publicBaseUrl = v.publicBaseUrl || undefined;
  if (own('cloudflaredPath') && !explicit.has('cloudflaredBin') && v.cloudflaredPath) cfg.cloudflaredBin = v.cloudflaredPath;
  if (own('skillsDir') && !explicit.has('skillsDir')) cfg.skillsDir = v.skillsDir || undefined;
  if (own('semanticMode') && !explicit.has('semantic')) cfg.semantic = v.semanticMode;
  // channelMode no longer switches Cloudflare off: tabs are views, each channel has its own start/stop (plan §5.1).
  if (own('tunnelProbeProxy') && !explicit.has('tunnelProbeProxy')) cfg.tunnelProbeProxy = v.tunnelProbeProxy || undefined;
  if (own('namedTunnelName') && !explicit.has('tunnelName')) cfg.tunnelName = v.namedTunnelName || 'blackhole';
  // The Windows shell environment reads BLACKHOLE_GIT_USR_BIN from the process env.
  if (own('gitUsrBinPath')) {
    if (v.gitUsrBinPath) env.BLACKHOLE_GIT_USR_BIN = v.gitUsrBinPath;
    else delete env.BLACKHOLE_GIT_USR_BIN;
  }
}

/** Which restart-only keys differ from what this daemon started with. */
export function pendingRestartKeys(startedWith: Settings, now: Settings): SettingKey[] {
  return RESTART_SETTING_KEYS.filter((k) => !sameValue(startedWith[k], now[k]));
}
