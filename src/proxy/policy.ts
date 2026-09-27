import { createHash } from 'node:crypto';
import { getProfile } from './profiles/registry.js';
import type { ProxyServerConfig } from './types.js';

/**
 * proxy 风险闸门（plan §7.1，v2.5 壳化：默认放行、收紧 opt-in）：
 *   config deny > profile hook（仅在显式配置策略时接管，如 allowedDomains）
 *   > config 显式 allow/confirm > unknown => ALLOW（纯透传）
 *
 * 上游是 operator 亲手配置的信任边界：壳不做默认干预。需要闸门时在 YAML 写
 * risk: {tool: confirm|deny}。本模块只产决策与审批单元键；等待 operator 的
 * 部分在 M0 的 approval seam。
 */

export interface ProxyPolicyDecision {
  decision: 'allow' | 'confirm' | 'deny';
  /** 决策来源（审批卡/审计可读）：config | profile | unknown-default。 */
  source: string;
  reason: string;
  /** 审批单元层级（plan §7.3）：hook 的 unitOverride 优先于配置。 */
  unitLevel: 'tool' | 'args';
}

/** M1 的配置代次：reload（M4）实现后 +1 使旧审批失效；当前恒 0。 */
export type PolicyGen = () => number;

export const POLICY_GEN_M1: PolicyGen = () => 0;

/** plan §7.3 的审批单元键。level 'warn'：不享受 critical 的 'always' 限制，但也绝不自动放行。 */
export function approvalUnitFor(
  server: string,
  tool: string,
  unitLevel: 'tool' | 'args',
  maskedArgsDigest: string | null,
  gen: number,
): { key: string; level: 'warn' } {
  const base = `proxy:${server}:${tool}`;
  return unitLevel === 'args' && maskedArgsDigest !== null
    ? { key: `${base}:${maskedArgsDigest}:${gen}`, level: 'warn' }
    : { key: `${base}:${gen}`, level: 'warn' };
}

/** 稳定掩码序列化后的 digest（plan §7.3）：同参同单元、异参异单元——掩码用固定占位符保证。 */
export function maskedArgsDigest(maskedArgsJson: string): string {
  return createHash('sha256').update(maskedArgsJson).digest('hex').slice(0, 16);
}

/**
 * 风险决策（plan §7.1 决策链）。
 * 注意：annotation 只在 explain/UI 里作 hint，永不进入授权判断——所以这里
 * 看不到 annotations 字段（这是特性，不是遗漏）。
 */
export function decideRisk(
  server: ProxyServerConfig,
  tool: string,
  args: unknown,
  catalogMeta: unknown,
  gen: PolicyGen = POLICY_GEN_M1,
): ProxyPolicyDecision & { gen: number } {
  const profile = server.profile !== undefined ? getProfile(server.profile) : undefined;

  const configDecision = server.risk[tool] ?? server.risk['*'];
  // config deny 绝对优先：任何 hook 不能覆盖（plan §7.1）
  if (configDecision === 'deny') {
    return { decision: 'deny', source: 'config', reason: `risk config denies "${tool}"`, unitLevel: unitLevelOf(server, tool), gen: gen() };
  }

  if (profile !== undefined) {
    const hookDecision = profile.policy.decide({ server: server.name, tool, canonicalArgs: args, catalogMeta });
    if (hookDecision !== null) {
      return {
        decision: hookDecision.decision === 'confirm' ? 'allow' : hookDecision.decision,
        source: `profile:${profile.name}`,
        reason: hookDecision.reason,
        unitLevel: hookDecision.unitOverride ?? unitLevelOf(server, tool),
        gen: gen(),
      };
    }
  }

  if (configDecision !== undefined) {
    return {
      decision: configDecision === 'confirm' ? 'allow' : configDecision,
      source: 'config',
      reason: `risk config sets "${tool}" to ${configDecision}`,
      unitLevel: unitLevelOf(server, tool),
      gen: gen(),
    };
  }

  return {
    decision: 'allow',
    source: 'unknown-default',
    reason: `no policy matched "${tool}"; shell default is pass-through`,
    unitLevel: unitLevelOf(server, tool),
    gen: gen(),
  };
}

function unitLevelOf(server: ProxyServerConfig, tool: string): 'tool' | 'args' {
  return server.approvalUnits?.[tool] ?? 'tool';
}
