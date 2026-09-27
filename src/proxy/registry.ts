import type { ProxyManager, UpstreamToolInfo, UpstreamToolPage } from './manager.js';
import type { ProxyServerConfig } from './types.js';

/**
 * tool catalog 与名字解析（plan §6）：缓存 upstream 的 tools/list，处理
 * alias/expose/missing 语义，并产出 explain 的清洗视图。TTL 过期与
 * not-found 触发**单次**刷新；只刷元数据，绝不自动重放原 call（plan §6.3）。
 */

export const CATALOG_TTL_MS = 10 * 60_000;

interface CatalogEntry {
  tools: UpstreamToolInfo[];
  fetchedAt: number;
}

export interface CatalogView {
  tools: UpstreamToolInfo[];
  /** expose 显式列出但 upstream catalog 没有的 tool（degraded 的依据，plan §6.1）。 */
  missing: string[];
}

/** explain/call 共用的最小 server 形状（避免把整个 config 类型拖进签名）。 */
export interface ProxyServerConfigLike {
  name: string;
  surface: { expose?: string[]; aliases?: Record<string, string> };
}

export interface ProxyToolBinding {
  exposedName: string;
  server: ProxyServerConfig;
  upstreamTool: string;
  tool?: UpstreamToolInfo;
}

export type ProxyToolRegistryEntry =
  | { name: string; status: 'online' | 'offline'; binding: ProxyToolBinding }
  | { name: string; status: 'conflict'; bindings: ProxyToolBinding[] };

export class ProxyRegistry {
  private readonly catalogs = new Map<string, CatalogEntry>();
  /** in-flight 刷新去重：同 server 并发 miss 只打一次 upstream。 */
  private refreshes = new Map<string, Promise<CatalogView>>();
  private revisions = new Map<string, number>();

  invalidate(name: string): void {
    this.revisions.set(name, (this.revisions.get(name) ?? 0) + 1);
    this.catalogs.delete(name);
    this.refreshes.delete(name);
  }

  constructor(
    private readonly manager: ProxyManager,
    private readonly log: (line: string) => void,
  ) {}

  // ── catalog ──────────────────────────────────────────────

  /** 缓存命中（TTL 内）直接返回；否则连 child 刷新。绝不 spawn 之外的副作用。 */
  async catalog(server: ProxyServerConfig, sessionId: string): Promise<CatalogView> {
    const cached = this.catalogs.get(server.name);
    if (cached && Date.now() - cached.fetchedAt < CATALOG_TTL_MS) {
      return { tools: cached.tools, missing: this.missingTools(server, cached.tools) };
    }
    return this.refresh(server, sessionId);
  }

  /** not-found / TTL 过期触发：单次刷新去重。 */
  async refresh(server: ProxyServerConfig, sessionId: string, startIfMissing = false): Promise<CatalogView> {
    const inFlight = this.refreshes.get(server.name);
    if (inFlight) return inFlight;
    const revision = this.revisions.get(server.name) ?? 0;
    const p = (async (): Promise<CatalogView> => {
      // 分页聚合（plan §6.3）：SDK listTools 单页返回，cursor 追平以免大目录丢工具
      const tools: UpstreamToolInfo[] = [];
      let cursor: string | undefined;
      let page = 0;
      let res: UpstreamToolPage;
      do {
        res = await this.manager.listTools(server, sessionId, server.limits?.connectTimeoutMs ?? 15_000, cursor, startIfMissing);
        if ((this.revisions.get(server.name) ?? 0) !== revision) throw new Error('upstream configuration changed while loading tools');
        tools.push(...res.tools);
        cursor = res.nextCursor;
        page += 1;
        if (page > 20) break; // 病态 upstream 的防御上限（20 页）
      } while (cursor !== undefined && cursor !== '');
      const entry: CatalogEntry = { tools, fetchedAt: Date.now() };
      this.catalogs.set(server.name, entry);
      return { tools, missing: this.missingTools(server, tools) };
    })().catch((e) => {
      if ((this.revisions.get(server.name) ?? 0) !== revision) throw e;
      // 刷新失败保留旧缓存（stale 但可用）；没有旧缓存则向调用方抛错
      const cached = this.catalogs.get(server.name);
      if (cached) {
        this.log(`proxy: catalog refresh failed for "${server.name}", keeping stale cache (${e instanceof Error ? e.message : String(e)})`);
        return { tools: cached.tools, missing: this.missingTools(server, cached.tools) };
      }
      throw e;
    });
    this.refreshes.set(server.name, p);
    try {
      return await p;
    } finally {
      if (this.refreshes.get(server.name) === p) this.refreshes.delete(server.name);
    }
  }

  /** expose∖catalog 非空 → degraded（plan §6.1/§6.3-6）。 */
  private missingTools(server: { surface: { expose?: string[] } }, tools: UpstreamToolInfo[]): string[] {
    const expose = server.surface.expose;
    if (!expose) return [];
    const names = new Set(tools.map((t) => t.name));
    return expose.filter((t) => !names.has(t));
  }

/** 整份缓存 catalog（list 状态展示用）；没有缓存返回 undefined——调用方不得因此 spawn。 */
  cachedTools(server: string): UpstreamToolInfo[] | undefined {
    return this.catalogs.get(server)?.tools;
  }

  /** M4 指标：catalog 缓存年龄（ms）；无缓存 null。 */
  catalogAgeMs(server: string): number | null {
    const c = this.catalogs.get(server);
    return c ? Date.now() - c.fetchedAt : null;
  }

  // ── 名字解析（plan §6.0）──────────────────────────────────

  /**
   * alias/canonical 统一入口：Tool-first 模型下 list 输出 alias（Agent-visible
   * 名称，无 alias 时为 canonical）；explain/call 的输入先解析成 canonical 再走
   * expose/policy。返回 null = 输入既非 canonical 也非 alias。
   */
  resolveToolName(server: ProxyServerConfigLike, input: string): string | null {
    const expose = server.surface.expose;
    if (expose?.includes(input)) return input;
    const alias = server.surface.aliases?.[input];
    if (alias !== undefined) return alias;
    // expose 省略 = 全部暴露：catalog 里存在的 canonical 名直接认
    if (!expose) {
      const cached = this.catalogs.get(server.name)?.tools.some((t) => t.name === input);
      if (cached) return input;
    }
    return null;
  }

  /** hidden-tool 判定（plan §15.1-2）：canonical 不在 expose（expose 显式时）。 */
  isHidden(server: ProxyServerConfigLike, canonical: string): boolean {
    const expose = server.surface.expose;
    return expose !== undefined && !expose.includes(canonical);
  }

  /** Build the agent-visible, tool-first registry from enabled server catalogs. */
  async globalEntries(servers: ProxyServerConfig[], sessionId: string, refreshMissing = false): Promise<ProxyToolRegistryEntry[]> {
    const grouped = new Map<string, ProxyToolBinding[]>();
    for (const server of servers) {
      let tools = this.cachedTools(server.name);
      if (tools === undefined && refreshMissing) {
        try {
          tools = (await this.catalog(server, sessionId)).tools;
        } catch (e) {
          this.log(`proxy: unable to load catalog for tool registry from "${server.name}": ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      for (const binding of this.bindingsForServer(server, tools)) {
        const list = grouped.get(binding.exposedName) ?? [];
        list.push(binding);
        grouped.set(binding.exposedName, list);
      }
    }
    const entries: ProxyToolRegistryEntry[] = [];
    for (const name of [...grouped.keys()].sort((a, b) => a.localeCompare(b))) {
      const bindings = grouped.get(name)!.sort((a, b) => `${a.server.name}/${a.upstreamTool}`.localeCompare(`${b.server.name}/${b.upstreamTool}`));
      if (bindings.length > 1) entries.push({ name, status: 'conflict', bindings });
      else {
        const binding = bindings[0]!;
        entries.push({ name, status: binding.tool !== undefined && this.manager.hasLiveChild(binding.server.name) ? 'online' : 'offline', binding });
      }
    }
    return entries;
  }

  /** Resolve one agent-visible tool name without exposing the server identity. */
  async resolveGlobal(servers: ProxyServerConfig[], sessionId: string, exposedName: string): Promise<ProxyToolRegistryEntry | undefined> {
    const entries = await this.globalEntries(servers, sessionId, false);
    return entries.find((entry) => entry.name === exposedName);
  }

  /**
   * Convert one server catalog into agent-visible bindings. aliases are alias -> canonical.
   * If a canonical tool has one or more aliases, only the aliases are agent-visible.
   */
  bindingsForServer(server: ProxyServerConfig, tools: UpstreamToolInfo[] | undefined): ProxyToolBinding[] {
    const catalogNames = tools?.map((t) => t.name);
    const exposedCanonical = server.surface.expose ?? catalogNames ?? [];
    const aliases = server.surface.aliases ?? {};
    const aliasesByTarget = new Map<string, string[]>();
    for (const [alias, target] of Object.entries(aliases)) {
      const list = aliasesByTarget.get(target) ?? [];
      list.push(alias);
      aliasesByTarget.set(target, list);
    }
    const out: ProxyToolBinding[] = [];
    for (const upstreamTool of exposedCanonical) {
      if (tools !== undefined && !tools.some((t) => t.name === upstreamTool)) continue;
      const names = aliasesByTarget.get(upstreamTool)?.slice().sort((a, b) => a.localeCompare(b)) ?? [upstreamTool];
      const tool = tools?.find((t) => t.name === upstreamTool);
      for (const exposedName of names) out.push({ exposedName, server, upstreamTool, tool });
    }
    return out;
  }
}

/**
 * argsExample 生成顺序（plan §6.2）：upstream schema 自带 example → 由 schema
 * 生成 required 字段的类型骨架 → 省略该字段。schema 非 JSON-Schema 形状时省略。
 */
export function argsExample(schema: unknown): string | undefined {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return undefined;
  const s = schema as Record<string, unknown>;
  const builtin = s.examples ?? s.example;
  if (builtin !== undefined) {
    const candidate = Array.isArray(builtin) ? builtin[0] : builtin;
    if (candidate !== undefined) {
      const json = JSON.stringify(candidate);
      if (json !== undefined && Buffer.byteLength(json, 'utf8') <= 4 * 1024) return json;
    }
  }
  const props = typeof s.properties === 'object' && s.properties !== null ? (s.properties as Record<string, Record<string, unknown>>) : undefined;
  const required = Array.isArray(s.required) ? s.required.filter((v): v is string => typeof v === 'string') : [];
  if (!props || required.length === 0) return undefined;
  const out: Record<string, unknown> = {};
  for (const name of required) {
    const type = props[name]?.type;
    out[name] = type === 'number' || type === 'integer' ? 1 : type === 'boolean' ? true : '...';
  }
  return JSON.stringify(out);
}

/**
 * 相似名建议（unknown-tool / hidden-tool 教学错误用，plan §6.3-6）。
 * 只有分数达阈值才给建议——否则"最接近的三个"是噪声，反而误导弱模型。
 */
export function similarNames(input: string, names: string[]): string[] {
  const lower = input.toLowerCase();
  const head = lower.slice(0, 4);
  const scored = names
    .map((n) => {
      const nl = n.toLowerCase();
      return { n, score: commonPrefix(lower, nl) + (nl.includes(head) ? 1 : 0) };
    })
    .filter((x) => x.score >= 2)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.n);
  return scored.slice(0, 3);
}

function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
}
