import os from 'node:os';
import path from 'node:path';

export type TunnelMode = 'auto' | 'off';
/**
 * Session permission modes:
 * - `read-only`: reads/tests only; mutations are denied.
 * - `workspace-write`: ACL-confined writes to the workspace/private temp plus
 *   operator-granted writable dirs; risky/out-of-workspace shell commands ask.
 * - `danger-full-access`: operator-selected unrestricted host shell; no normal
 *   workspace ACL confinement or command approval gate.
 * Legacy `trusted`/`guarded` values remain conservative and normalize to
 * `workspace-write` so an upgrade never silently expands an existing session.
 */
export type PermissionMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export const PERMISSION_MODES: PermissionMode[] = ['read-only', 'workspace-write', 'danger-full-access'];

/**
 * Normalize a stored value. Unknown/legacy values fall back to
 * `workspace-write`; validation of NEW values happens at the API boundary.
 */
export function normalizePermissionMode(raw: string | null | undefined): PermissionMode {
  if (raw === 'read-only' || raw === 'danger-full-access') return raw;
  return 'workspace-write';
}

/**
 * Semantic-search credential policy (`context_search`):
 *  - `off`      never registers the tool;
 *  - `explicit` registers it only when an env key or the manual key file
 *               supplies a key (default — a local Devin/Windsurf install is
 *               never read without being asked);
 *  - `auto`     additionally reads the logged-in local installation.
 */
export type SemanticMode = 'off' | 'explicit' | 'auto';
export const SEMANTIC_MODES: SemanticMode[] = ['off', 'explicit', 'auto'];

export interface Config {
  port: number;
  host: '127.0.0.1';
  dbPath: string;
  tunnel: TunnelMode;
  cloudflaredBin?: string;
  /** Fixed public base URL (own frp/nginx/Tailscale/Named Tunnel); wins over the Quick Tunnel. */
  publicBaseUrl?: string;
  /** Name of the cloudflared named tunnel to `tunnel run` (persistent channel). */
  tunnelName: string;
  /** Local HTTP proxy for tunnel public-URL probes (http://host:port); bypasses TUN/fake-ip RSTs. */
  tunnelProbeProxy?: string;
  execTimeoutMs: number;
  execMaxTimeoutMs: number;
  execOutputCapBytes: number;
  readOutputCapBytes: number;
  eventPayloadCapBytes: number;
  bodyLimitBytes: number;
  /** Optional replacement for the default user library (~/.agents/skills).
   * Admitted sessions merge project + selected user library, with project names
   * taking precedence. Only an explicit library supports keyless reads. */
  skillsDir?: string;
  /** Credential policy for `context_search`; see SemanticMode. */
  semantic: SemanticMode;
  /** Absolute path of the manual semantic key file (~/.blackhole/semantic-key). */
  semanticKeyPath: string;
  /** Wall-clock ceiling for one `context_search` call. */
  semanticTimeoutMs: number;
  /** 通用 MCP proxy 的 YAML 配置文件路径（plan §5；默认 ~/.blackhole/mcp-proxies.yaml）。 */
  proxyConfigPath?: string;
}

/** Defaults are exported so user-facing copy (CLI help) derives from them
 *  instead of restating the numbers and drifting. */
export const DEFAULT_PORT = 7306;
export const DEFAULT_DB_PATH = path.join(os.homedir(), '.blackhole', 'blackhole.db');

function positiveInt(value: string | undefined, fallback: number): number {
  const n = value === undefined ? NaN : Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const dir = path.join(os.homedir(), '.blackhole');
  const publicUrl = process.env.BLACKHOLE_PUBLIC_URL?.replace(/\/+$/, '');
  const defaults: Config = {
    port: positiveInt(process.env.BLACKHOLE_PORT, DEFAULT_PORT),
    host: '127.0.0.1',
    dbPath: process.env.BLACKHOLE_DB ?? DEFAULT_DB_PATH,
    // a fixed public URL makes the Quick Tunnel redundant unless explicitly asked for
    tunnel: process.env.BLACKHOLE_TUNNEL ? (process.env.BLACKHOLE_TUNNEL === 'off' ? 'off' : 'auto') : publicUrl ? 'off' : 'auto',
    cloudflaredBin: process.env.BLACKHOLE_CLOUDFLARED,
    publicBaseUrl: publicUrl,
    tunnelName: process.env.BLACKHOLE_TUNNEL_NAME ?? 'blackhole',
    tunnelProbeProxy: process.env.BLACKHOLE_TUNNEL_PROBE_PROXY?.trim().replace(/\/+$/, '') || undefined,
    execTimeoutMs: positiveInt(process.env.BLACKHOLE_EXEC_TIMEOUT_MS, 120_000),
    execMaxTimeoutMs: 15 * 60_000,
    execOutputCapBytes: 512 * 1024,
    readOutputCapBytes: 256 * 1024,
    eventPayloadCapBytes: 8 * 1024,
    bodyLimitBytes: 2 * 1024 * 1024,
    skillsDir: process.env.BLACKHOLE_SKILLS_DIR?.trim() || undefined,
    semantic: SEMANTIC_MODES.includes(process.env.BLACKHOLE_SEMANTIC as SemanticMode)
      ? (process.env.BLACKHOLE_SEMANTIC as SemanticMode)
      : 'explicit',
    semanticKeyPath: process.env.BLACKHOLE_SEMANTIC_KEY_FILE?.trim() || path.join(dir, 'semantic-key'),
    semanticTimeoutMs: positiveInt(process.env.BLACKHOLE_SEMANTIC_TIMEOUT_MS, 120_000),
  };
  // proxy 配置路径与其它路径字段同构：env 覆盖 > 显式 override；缺省由
  // resolveProxyConfigPath 决定（~/.blackhole/mcp-proxies.yaml），故这里不设默认值
  const envProxyPath = process.env.BLACKHOLE_PROXY_CONFIG?.trim();
  if (envProxyPath !== undefined && envProxyPath !== '') defaults.proxyConfigPath = envProxyPath;
  // an explicit undefined in overrides must not clobber the defaults
  const clean = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined));
  return { ...defaults, ...clean } as Config;
}
