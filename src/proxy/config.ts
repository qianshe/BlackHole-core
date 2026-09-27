import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { DEFAULT_PROXY_LIMITS, type ProxyConfigLoad, type ProxyServerConfig } from './types.js';
import { getProfile, profileNames } from './profiles/registry.js';

import './profiles/builtins.js';

/**
 * proxy 配置加载与启动校验（plan §5/§5.1）。单一事实源是 YAML 文件；
 * 校验在 daemon 启动时执行一次，**单 server 配置错误只隔离该 server**
 * （config_error，list 可见原因），绝不拖垮 daemon 启动或其他 server。
 */

export const PROXY_CONFIG_ENV = 'BLACKHOLE_PROXY_CONFIG';

/** 默认配置路径与 db/key 文件同目录（~/.blackhole/mcp-proxies.yaml）。 */
export function defaultProxyConfigPath(): string {
  return path.join(os.homedir(), '.blackhole', 'mcp-proxies.yaml');
}

export function resolveProxyConfigPath(overrides: { proxyConfigPath?: string } = {}): string {
  return overrides.proxyConfigPath ?? process.env[PROXY_CONFIG_ENV]?.trim() ?? defaultProxyConfigPath();
}

/** file does not exist = never configured any proxy (the proxy tool is not registered at all). */
export function proxyConfigFileExists(p: string): boolean {
  return fs.existsSync(p);
}

/**
 * The child's minimal env allowlist. Do not inherit the daemon's full environment (plan §5.1/§15.1-6);
 * a per-server `env.inherit` REPLACES this default rather than merging.
 */
export const DEFAULT_ENV_INHERIT = ['PATH', 'TEMP', 'TMP', 'SYSTEMROOT', 'HOME', 'USERPROFILE'];

/**
 * `${ENV_VAR}` 机密引用展开（plan §12-M4 secret source）：仅展开一层，缺失 → 空串。
 * 单一事实源：配置校验（存在性）、child 环境注入（manager）、HTTP headers 共用本函数。
 * 默认敏感键列表的唯一事实源是 redact.ts（此处不再重复定义，避免两份漂移）。
 */
export function expandEnvRefs(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => process.env[name] ?? '');
}

/** 值里出现的所有 `${ENV_VAR}` 引用名（配置校验用）。 */
function envRefsOf(value: string): string[] {
  return [...value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1] ?? '');
}

const serverSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .refine((v) => !/\s/.test(v), 'name must not contain whitespace'),
    transport: z.enum(['stdio', 'http']),
    url: z.string().min(1).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).default([]),
    env: z
      .object({
        inherit: z.array(z.string().min(1)).default(DEFAULT_ENV_INHERIT),
        set: z.record(z.string(), z.string()).default({}),
        setFromFile: z.record(z.string(), z.string()).optional(),
      })
      .default({}),
    surface: z
      .object({
        expose: z.array(z.string().min(1)).optional(),
        aliases: z.record(z.string(), z.string().min(1)).optional(),
      })
      .default({}),
    risk: z.record(z.string().min(1), z.enum(['allow', 'confirm', 'deny'])).default({}),
    approvalUnits: z.record(z.string().min(1), z.enum(['tool', 'args'])).optional(),
    redactPaths: z.array(z.string().min(1)).default([]),
    sensitiveKeys: z.array(z.string().min(1)).default([]),
    // One enabled MCP owns one daemon-managed upstream connection. Keep the
    // legacy field parseable, but runtime materialization normalizes to shared.
    scope: z.enum(['session', 'shared']).default('shared'),
    profile: z.string().min(1).optional(),
    browser: z.object({ allowedDomains: z.array(z.string().min(1)).default([]) }).optional(),
    limits: z
      .object({
        connectTimeoutMs: z.number().int().positive().optional(),
        callTimeoutMs: z.number().int().positive().optional(),
        approvalTimeoutMs: z.number().int().positive().optional(),
        maxChildren: z.number().int().positive().optional(),
      })
      .optional(),
    prewarm: z.enum(['never', 'on_session_start']).default('never'),
    enabled: z.boolean().default(true),
    // Legacy compatibility only. Proxy-first never publishes upstream tools to host tools/list.
    merge: z.boolean().default(false),
  })
  .strict()
  .superRefine((s, ctx) => {
    // transport 专属约束（plan §3.1：command-specific 约束在 runtime 校验——
    // 配置层同类：http 必须有 url，stdio 必须有 command）
    if (s.transport === 'http' && (s.url === undefined || s.url.trim() === '')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['url'], message: 'http transport requires url' });
    }
    if (s.transport === 'stdio' && (s.command === undefined || s.command.trim() === '')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['command'], message: 'stdio transport requires command' });
    }
  });

type RawServer = z.infer<typeof serverSchema>;

interface ParsedEntry {
  index: number;
  raw: unknown;
}

/** First zod issue → a reason that locates the field ("limits.callTimeoutMs: ..."). */
function zodReason(error: z.ZodError): string {
  const first = error.issues[0];
  if (!first) return 'invalid server entry';
  const where = first.path.length > 0 ? `${first.path.join('.')}: ` : '';
  return `${where}${first.message}`;
}

/**
 * Load and validate the whole file. Anything the parser can't attribute to a
 * single server (YAML syntax, top-level shape) quarantines as one synthetic
 * entry so `list` still surfaces the reason.
 */
export function loadProxyConfig(file: string): ProxyConfigLoad {
  if (!proxyConfigFileExists(file)) {
    return { servers: [], disabled: [], quarantined: [], warnings: [], secretValues: [] };
  }
  let doc: unknown;
  try {
    doc = parseYaml(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return {
      servers: [],
      disabled: [],
      quarantined: [{ name: '(config)', reason: `YAML parse failed: ${e instanceof Error ? e.message : String(e)}` }],
      warnings: [],
      secretValues: [],
    };
  }
  const list = (doc as { proxies?: unknown } | null)?.proxies;
  if (!Array.isArray(list)) {
    return {
      servers: [],
      disabled: [],
      quarantined: [{ name: '(config)', reason: 'top-level shape must be `proxies:` + a list of server entries' }],
      warnings: [],
      secretValues: [],
    };
  }

  const out: ProxyConfigLoad = { servers: [], disabled: [], quarantined: [], warnings: [], secretValues: [] };
  const seenNames = new Set<string>();
  const entries: ParsedEntry[] = list.map((raw, index) => ({ index, raw }));

  for (const entry of entries) {
    const rawName = (entry.raw as { name?: unknown } | null)?.name;
    const displayName = typeof rawName === 'string' && rawName.trim() !== '' ? rawName : `(proxies[${entry.index}])`;
    const parsed = serverSchema.safeParse(entry.raw);
    if (!parsed.success) {
      out.quarantined.push({ name: displayName, reason: zodReason(parsed.error) });
      continue;
    }
    const problem = validateServer(parsed.data, seenNames);
    if (problem) {
      out.quarantined.push({ name: parsed.data.name, reason: problem });
      continue;
    }
    seenNames.add(parsed.data.name);
    const materialized = materialize(parsed.data);
    // 启停开关（M4.6）：enabled=false 的 server 保留在 disabled 分区——配置与
    // 策略都在，只是不加载进运行时（agent 不可见，设置页可一键启用）
    (materialized.enabled ? out.servers : out.disabled).push(materialized);

    // env.set/setFromFile 值注册为已知 secret（plan §5.1/§7.4）：env.set 注册的是
    // **展开后的真值**——注册模板串等于值扫描永远扫不到真正要掩码的东西
    for (const raw of Object.values(parsed.data.env.set)) {
      const resolved = expandEnvRefs(raw);
      if (resolved !== '') out.secretValues.push(resolved);
      if (resolved !== raw && raw !== '') out.secretValues.push(raw);
    }
    for (const [key, file] of Object.entries(parsed.data.env.setFromFile ?? {})) {
      try {
        // 单行值约定：读文件首行 trim；避免明文长期躺在配置里
        const value = fs.readFileSync(file, 'utf8').split(/\r?\n/, 1)[0]?.trim() ?? '';
        if (value !== '') out.secretValues.push(value);
      } catch (e) {
        out.warnings.push({ name: parsed.data.name, reason: `env.setFromFile[${key}]: cannot read ${file}: ${e instanceof Error ? e.message : String(e)}` });
      }
    }
    if (parsed.data.env.setFromFile && Object.keys(parsed.data.env.setFromFile).length > 0) {
      out.warnings.push({ name: parsed.data.name, reason: `env.setFromFile keys: ${Object.keys(parsed.data.env.setFromFile).join(', ')} (values resolved per spawn)` });
    }
    if (parsed.data.browser && !parsed.data.profile) {
      out.warnings.push({ name: parsed.data.name, reason: 'browser: block requires profile: browser; ignored' });
    }
  }
  return out;
}

/** Cross-field validation after the per-server schema passed. A truthy return quarantines. */
function validateServer(s: RawServer, seenNames: Set<string>): string | undefined {
  if (seenNames.has(s.name)) return `duplicate server name "${s.name}"`;
  // 机密引用展开（plan §12-M4 secret source）：${ENV_VAR} 在加载时即可校验存在性
  for (const [k, v] of Object.entries(s.env.set)) {
    const missing = envRefsOf(v).filter((name) => name === '' || process.env[name] === undefined);
    if (missing.length > 0) return `env.set["${k}"]: missing env refs: ${missing.join(', ')}`;
  }
  // profile 必须存在于构建产物（plan §5）：registry 只收 src/proxy/profiles/*
  // 里随构建发布的实现；unknown → config_error。
  if (s.profile !== undefined && getProfile(s.profile) === undefined) {
    return `unknown profile: ${s.profile} (built-in: ${profileNames().join(', ') || 'none'})`;
  }
  const expose = s.surface.expose ?? [];
  const aliases = s.surface.aliases ?? {};
  const canonical = new Set(expose);
  const seenAliases = new Set<string>();
  for (const [alias, target] of Object.entries(aliases)) {
    if (alias === target) return `alias "${alias}" maps to itself`;
    if (canonical.has(alias)) return `alias "${alias}" conflicts with a canonical tool name in expose`;
    if (seenAliases.has(alias)) return `duplicate alias "${alias}"`;
    seenAliases.add(alias);
    // Keep aliases for currently hidden tools so toggling exposure is reversible.
    // bindingsForServer still filters by canonical expose before applying aliases.
  }
  return undefined;
}

/**
 * M4.6 JSON 导入（plan §5.2 修订）：解析 Claude Desktop / Cursor 通用
 * `{"mcpServers": {...}}` 格式并转换为我们的 server 条目。
 * - stdio：command/args/env → command/args/env.set（env 值注册为机密）
 * - url（Streamable HTTP）：url → transport http
 * - 其余字段（type/headers）尽力映射；无法识别的条目进 errors，不阻断其他条目
 */
export function convertMcpServersJson(
  text: string,
): { entries: { name: string; entry: Record<string, unknown> }[]; errors: { name: string; error: string }[] } {
  const errors: { name: string; error: string }[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { entries: [], errors: [{ name: '(json)', error: `not valid JSON: ${e instanceof Error ? e.message : String(e)}` }] };
  }
  const root = (parsed ?? {}) as Record<string, unknown>;
  const servers = (root.mcpServers ?? parsed) as Record<string, unknown>;
  if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) {
    return { entries: [], errors: [{ name: '(json)', error: 'expected {"mcpServers": {...}} or a single server object' }] };
  }
  const entries: { name: string; entry: Record<string, unknown> }[] = [];
  for (const [name, raw] of Object.entries(servers)) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push({ name, error: 'server entry must be an object' });
      continue;
    }
    const s = raw as Record<string, unknown>;
    const entry: Record<string, unknown> = { name, enabled: true };
    if (typeof s.url === 'string' && s.url !== '') {
      entry.transport = 'http';
      entry.url = s.url;
      if (s.headers !== undefined && typeof s.headers === 'object' && !Array.isArray(s.headers)) entry.headers = s.headers;
    } else if (typeof s.command === 'string' && s.command !== '') {
      entry.transport = 'stdio';
      entry.command = s.command;
      if (Array.isArray(s.args)) entry.args = s.args.filter((a): a is string => typeof a === 'string');
      if (s.env !== undefined && typeof s.env === 'object' && !Array.isArray(s.env)) {
        const env: Record<string, string> = {};
        for (const [k, v] of Object.entries(s.env as Record<string, unknown>)) {
          if (typeof v === 'string') env[k] = v;
        }
        entry.env = { inherit: ['PATH', 'SYSTEMROOT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE'], set: env };
      }
    } else {
      errors.push({ name, error: 'entry needs either "command" (stdio) or "url" (http)' });
      continue;
    }
    entries.push({ name, entry });
  }
  return { entries, errors };
}

/**
 * 校验并物化单条 server 原始条目（设置页「新增 MCP」/「JSON 导入」复用启动同款
 * 校验管道）。seenNames 用于重名检查（调用方传入当前文件已占用的名字集合）。
 */
export function validateServerEntry(
  raw: unknown,
  seenNames: Set<string>,
): { server?: ProxyServerConfig; error?: string; warnings: { name: string; reason: string }[] } {
  const displayName = (raw as { name?: unknown } | null)?.name;
  const name = typeof displayName === 'string' && displayName.trim() !== '' ? displayName : '(unnamed)';
  const parsed = serverSchema.safeParse(raw);
  if (!parsed.success) return { error: zodReason(parsed.error), warnings: [] };
  const problem = validateServer(parsed.data, seenNames);
  if (problem) return { error: problem, warnings: [] };
  const server = materialize(parsed.data);
  return { server, warnings: [] };
}

/** Schema defaults + limit defaults → the shape the rest of src/proxy consumes. */
function materialize(s: RawServer): ProxyServerConfig {
  return {
    name: s.name,
    enabled: s.enabled,
    merge: s.merge,
    transport: s.transport,
    ...(s.url !== undefined ? { url: s.url } : {}),
    ...(s.headers !== undefined ? { headers: s.headers } : {}),
    command: s.command ?? '',  // http transport 无 command（superRefine 已按 transport 校验）
    args: s.args,
    env: {
      inherit: s.env.inherit,
      set: s.env.set,
      ...(s.env.setFromFile ? { setFromFile: s.env.setFromFile } : {}),
    },
    surface: {
      ...(s.surface.expose ? { expose: s.surface.expose } : {}),
      ...(s.surface.aliases ? { aliases: s.surface.aliases } : {}),
    },
    risk: s.risk,
    ...(s.approvalUnits ? { approvalUnits: s.approvalUnits } : {}),
    redactPaths: s.redactPaths,
    sensitiveKeys: s.sensitiveKeys,
    // Enabled means one live upstream owned by the daemon, independent of a
    // BlackHole session. Accept legacy `scope: session` files but normalize the
    // effective lifecycle to shared so calls never spawn a process on demand.
    scope: 'shared',
    ...(s.profile ? { profile: s.profile } : {}),
    ...(s.browser ? { browser: s.browser } : {}),
    limits: { ...DEFAULT_PROXY_LIMITS, ...(s.limits ?? {}) },
    prewarm: s.prewarm,
  };
}

/** Effective limit values for a server (per-server override > global defaults). */
export function limitsOf(s: ProxyServerConfig): typeof DEFAULT_PROXY_LIMITS {
  return { ...DEFAULT_PROXY_LIMITS, ...(s.limits ?? {}) };
}
