import type { ProfileRedactionDecision } from './profiles/registry.js';

/**
 * Secret redaction（plan §7.4）：从 rawArgs 派生 recordedArgs / approvalArgs 的脱敏视图。
 * 全部纯函数、零 IO；同构输入必须产出字节级相同的输出——这是 digest 稳定的前提，
 * 也是掩码用固定占位符（而非按长度打码）的原因。宁可多掩，不追求精确。
 */

/** 固定掩码占位符（plan §7.4）：不随原值长度/内容变化，digest 才稳定、也不泄漏长度。 */
export const MASK = '***';

/** 循环引用在 maskedPaths 里的占位条目：不是真实路径，仅作审计信号（防御性要求）。 */
const CIRCULAR_PATH = '$circular';

/** 全局默认敏感键（plan §7.4）；与 per-server sensitiveKeys（opts.extraKeys）合并使用。 */
export const DEFAULT_SENSITIVE_KEYS: readonly string[] = [
  'authorization',
  'cookie',
  'password',
  'secret',
  'token',
  'apikey',
  'accesskey',
];

export interface RedactOptions {
  /** per-server sensitiveKeys：与默认列表合并后做键启发式（同样做归一化）。 */
  extraKeys?: readonly string[];
  /** 路径级强制掩码（点路径，段通配符 `*`），与键名无关——覆盖 fill.value 类值位置机密。 */
  redactPaths?: readonly string[];
  /** ProfileRedactionDecision（plan §7.2/§7.4）：maskedPaths 强制掩码；给了 args 就以它为基础。 */
  profile?: ProfileRedactionDecision | null;
}

/** maskedPaths = 本次实际被掩码的点路径（键启发式记具体路径；路径规则保持通配写法），供审计。 */
export interface RedactedArgs {
  recorded: unknown;
  maskedPaths: string[];
}

interface ForcedPath {
  /** 规则原样写法：命中时进 maskedPaths（`*` 不展开，plan §7.4 e）。 */
  raw: string;
  segs: string[];
}

interface WalkCtx {
  forced: ForcedPath[];
  candidates: string[];
  seen: WeakSet<object>;
  masked: Set<string>;
}

/** 键归一化：小写并去掉 -/_/. 分隔符，让 apiKey / api_key / X-Token 落到同一形态再比对。 */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_.]/g, '');
}

/** 保守键启发式：归一化后"包含"任一候选键即命中——保守设计，接受误伤（plan §7.4）。 */
function keyIsSensitive(key: string, candidates: readonly string[]): boolean {
  const norm = normalizeKey(key);
  return candidates.some((c) => norm.includes(c));
}

/** 段级匹配：长度相等，`*` 匹配任意单一段（对象键或数组下标都算一段）。 */
function pathMatches(path: readonly string[], segs: readonly string[]): boolean {
  if (path.length !== segs.length) return false;
  return segs.every((seg, i) => seg === '*' || seg === path[i]);
}

/** Map/Set/Date 等宿主/自定义对象不展开（upstream args 应为 JSON，此为防御）。 */
function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function maskCircular(ctx: WalkCtx): string {
  ctx.masked.add(CIRCULAR_PATH);
  return MASK;
}

/**
 * 递归遍历容器并产出新结构（不可变：绝不改写输入）。被掩码的位置一律换成 MASK；
 * 其余位置要么是新建容器，要么是原样保留的 JSON 叶子值——原始敏感值不会出现在返回结构中。
 */
function walkValue(value: unknown, path: readonly string[], ctx: WalkCtx): unknown {
  // 函数/undefined 原样保留，交给 JSON.stringify 自行丢弃（plan §7.4 g）。
  if (value === null || typeof value !== 'object') return value;
  const obj = value as object;

  if (Array.isArray(obj)) {
    if (ctx.seen.has(obj)) return maskCircular(ctx);
    ctx.seen.add(obj);
    return obj.map((el, i) => visitChild(el, [...path, String(i)], ctx));
  }

  if (!isPlainObject(obj)) return obj;

  if (ctx.seen.has(obj)) return maskCircular(ctx);
  ctx.seen.add(obj);

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    out[key] = visitChild(val, [...path, key], ctx, key);
  }
  return out;
}

/**
 * 访问一个子节点（对象属性与数组元素的唯一入口，根节点也走这里）：
 * 先判路径级强制规则（与键名无关，优先于键启发式，plan §7.4 b/c），
 * 有 key 时再做键启发式（数组元素没有键，跳过）。
 */
function visitChild(value: unknown, path: readonly string[], ctx: WalkCtx, key?: string): unknown {
  const hit = ctx.forced.find((f) => pathMatches(path, f.segs));
  if (hit !== undefined) {
    ctx.masked.add(hit.raw);
    return MASK;
  }
  if (key !== undefined && keyIsSensitive(key, ctx.candidates)) {
    ctx.masked.add(path.join('.'));
    return MASK;
  }
  return walkValue(value, path, ctx);
}

/**
 * 从 rawArgs 产出脱敏视图（plan §7.4）：递归键掩码 + 路径级规则 + profile 决策合并。
 * profile.args 存在时以其为基础（profile 可能已替换/掩码过 args），其 maskedPaths 与
 * redactPaths 合并成同一组强制路径。maskedPaths 顺序即遍历命中顺序，已去重。
 */
export function redactArgs(args: unknown, opts: RedactOptions): RedactedArgs {
  const profile = opts.profile;
  const base = profile !== null && profile !== undefined && profile.args !== undefined ? profile.args : args;

  const candidates = [...DEFAULT_SENSITIVE_KEYS, ...(opts.extraKeys ?? [])]
    .map(normalizeKey)
    .filter((k) => k !== '');

  const forced = [...(opts.redactPaths ?? []), ...(opts.profile?.maskedPaths ?? [])].map((raw) => ({
    raw,
    segs: raw.split('.'),
  }));

  const ctx: WalkCtx = { forced, candidates, seen: new WeakSet(), masked: new Set() };
  return { recorded: visitChild(base, [], ctx), maskedPaths: [...ctx.masked] };
}

/** 值扫描（plan §7.4）：已知 secret 值在 text 中的精确子串替换为 MASK；短于 4 的值跳过（误伤概率高）。 */
export function scanSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s.length >= 4) out = out.replaceAll(s, MASK);
  }
  return out;
}
