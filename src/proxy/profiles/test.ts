import { registerProfile, type ProxyProfile } from './registry.js';

/**
 * M1 内置的测试 profile（plan M1 验收 4 的"fake profile"）：唯一作用是在
 * E2E 里验证 §7.2 组合规则与 §7.3 审批单元覆盖，不对应任何真实上游语义。
 * 它只应被指向 fake upstream（scripts/fake-upstream.mjs）。
 *
 * 接管 `echo`（fake upstream 的低危回显工具）：
 * - payload 以 "safe" 开头 → allow（经 hook 的合法 allow 通道，无需审批）；
 * - 其他 payload → confirm（config `risk: { echo: allow }` 也不能旁路这一档）。
 */
export const TEST_PROFILE: ProxyProfile = {
  name: 'test',
  ownedTools: ['echo'],
  policy: {
    decide(req) {
      if (req.tool !== 'echo') return null;
      const payload = (req.canonicalArgs as { payload?: unknown } | null)?.payload;
      const safe = typeof payload === 'string' && payload.startsWith('safe');
      return safe
        ? { decision: 'allow', reason: 'test profile: safe-prefixed echo payload' }
        : { decision: 'confirm', reason: 'test profile: echo payload is not prefixed "safe"' };
    },
  },
};

export function registerTestProfile(): void {
  registerProfile(TEST_PROFILE);
}
