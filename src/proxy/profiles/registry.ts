import type { ProxyRiskDecision } from '../types.js';

/**
 * Profile 机制（plan §7.2）：trusted local profile = 随 BlackHole 一起构建发布
 * （src/proxy/profiles/*）、且由 operator 在 config 中显式 `profile: <name>`
 * 启用的策略代码。外部/第三方代码不构成 profile。
 *
 * Generic Core 只依赖这里的接口，不认识 domain/password/uid 等具体语义
 * （plan §2.1）；M3 的 browser profile 是唯一预期的新增实现。
 *
 * 注册入口是 `builtins.ts`（静态 import 会被 ESM 提升到本模块体之前执行，
 * 在这里 import 具体 profile 会踩 TDZ）。
 */

export interface ProfilePolicyRequest {
  server: string;
  tool: string;
  /** 本次调用的 upstream args（未经 redact 的原始形态，只进不出）。 */
  canonicalArgs: unknown;
  /** registry 缓存的 upstream catalog 元数据（title/annotations 等），可为 null。 */
  catalogMeta: unknown;
}

export interface ProfilePolicyDecision {
  decision: ProxyRiskDecision;
  reason: string;
  /** 覆盖本次审批单元层级（plan §7.3）；缺省沿用配置。 */
  unitOverride?: 'tool' | 'args';
}

export interface ProfilePolicyHook {
  /** 无决策时返回 null——落回 config 显式配置 / annotation hint / unknown=confirm。 */
  decide(req: ProfilePolicyRequest): ProfilePolicyDecision | null;
}

export interface ProfileRedactionRequest {
  server: string;
  tool: string;
  args: unknown;
  catalogMeta: unknown;
}

export interface ProfileRedactionDecision {
  /** 可能被替换/掩码后的 args（值位置机密，plan §7.4）。 */
  args: unknown;
  /** 本次被强制掩码的点路径，进审计/教学输出。 */
  maskedPaths: string[];
}

export interface ProfileRedactionHook {
  redact(req: ProfileRedactionRequest): ProfileRedactionDecision | null;
}

export interface ProxyProfile {
  name: string;
  /**
   * §7.2 接管 tool 集合：这些 tool 上 config `risk: allow` 不生效（启动校验
   * 降级 confirm + warning）——白名单语义不允许被一行 tool 级 allow 静默旁路。
   */
  ownedTools: readonly string[];
  policy: ProfilePolicyHook;
  redaction?: ProfileRedactionHook;
}

const REGISTRY = new Map<string, ProxyProfile>();

export function registerProfile(profile: ProxyProfile): void {
  REGISTRY.set(profile.name, profile);
}

export function getProfile(name: string): ProxyProfile | undefined {
  return REGISTRY.get(name);
}

export function profileNames(): string[] {
  return [...REGISTRY.keys()].sort();
}
