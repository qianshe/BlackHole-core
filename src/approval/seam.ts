import type { ApprovalScope } from '../storage/db.js';
import type { ConfirmationsRepo } from '../storage/confirmations.js';
import { confirmationBus, CONFIRMATION_TTL_MS } from '../storage/confirmations.js';
import type { EventsRepo } from '../storage/events.js';
import type { ApprovalUnit } from '../workspace/risk.js';

/**
 * M0 抽取的通用"等待审批后执行"审批执行 seam：把原先内联在 exec 工具里的
 * 确认等待状态机（找/建确认 → 同步等决议 → ONCE 原子认领 → scope 记忆）
 * 收敛为一个 proxy 无关的内部服务。
 *
 * - 现有唯一消费者是 exec 工具（src/mcp/tools.ts）。
 * - editor 当前没有审批路径（read-only 模式直接拒绝，不弹确认），
 *   故无需迁移；它未来接入时只需提供 units/card/hooks。
 * - proxy（M1）将通过同一接口接入；seam 内禁止出现任何 proxy/upstream 概念，
 *   它只认识会话、工具名、审批单元键与参数哈希。
 *
 * 等待有三种结束方式：
 * 1. operator 决议（approve/deny）——confirmationBus 唤醒，走认领或拒绝分支；
 * 2. TTL 过期——兜底 timer 在确认行过期 +500ms 后唤醒，走 takeApproved 失败
 *    分支（同 operator 拒绝的收尾路径）；
 * 3. caller abort（opts.signal）——等待以 `{ outcome: 'denied' }` 提前结束，
 *   确认行保持 pending 交给 expireStale/TTL 收尾，不发 tool_call_denied 事件、
 *   不回调 onDenied（调用方自行决定收尾）。这只服务"调用方连接已断"的场景；
 *   M2 的 UI 取消走 control/api 的 resolveConfirmation 正常 deny 路径，不经此 signal。
 */
export interface ApprovalSeamDeps {
  beforeGrant?: () => Promise<void>;
  confirmations: ConfirmationsRepo;
  events: EventsRepo;
}

/** 一次"等待审批"请求。形状刻意与任何单一调用方解耦，proxy 复用时原样可用。 */
export interface ApprovalRequest {
  /** BlackHole 会话主键：确认行、scope grant 与事件的归属。 */
  sessionId: string;
  /** 展示/审计用工具名（进 confirmation 行与 confirmation_created 事件）。 */
  tool: string;
  /**
   * 审批单元键——scope grant 按单元键记忆与匹配，这是 seam 的核心抽象：
   * 授权粒度完全由调用方给什么键决定，seam 不感知键的形状（proxy 未来用
   * 自己的单元键形状 `proxy:<server>:<tool>:<policyGen>` 即可接入）。
   */
  units: readonly ApprovalUnit[];
  /**
   * 本次调用的参数身份：identical hash → 共享同一条 pending 确认 +
   * ONCE 原子认领（客户端超时重试与并发同参调用只有一个执行）。
   */
  argsHash: string;
  /** 已脱敏的存证参数（写入确认行 args_json，sessionId 等明文凭据不得混入）。 */
  argsJson: string;
  /** 审批卡展示载荷，透传进 confirmation_created 事件（面板据此渲染标签/高亮）。 */
  card: { command: string; matches?: unknown; categories?: string[] };
  /** 可选，接入调用追踪（tracking hooks 的回调参数）。 */
  callId?: string;
  /** 确认行 TTL；缺省用 CONFIRMATION_TTL_MS。 */
  ttlMs?: number;
}

/**
 * 调用追踪 hooks：seam 只在状态迁移点回调，落库方式归调用方所有
 * （exec 侧映射到 toolCalls：onAwaiting→awaitApproval；onGranted→
 * setApprovalScope+resume；onDenied→finish(callId,'denied',summaryJson)）。
 * 仅在请求带 callId 时回调。
 */
export interface ApprovalTracking {
  /** 确认行已就位、开始等待 operator。 */
  onAwaiting?(callId: string): void;
  /** 已获执行许可（既有 grant 或认领成功），scope 是本次生效范围。 */
  onGranted?(callId: string, scope: ApprovalScope): void;
  /** 未获许可（拒绝/过期/被并发认领），summaryJson 与既有 denied 摘要逐字一致。 */
  onDenied?(callId: string, summaryJson: string): void;
}

export interface ApprovalWaitOptions {
  tracking?: ApprovalTracking;
  /** caller 取消：abort 即放弃等待（见文件头第 3 种结束方式）。 */
  signal?: AbortSignal;
}

export type ApprovalOutcome =
  | { outcome: 'granted'; scope: ApprovalScope; confirmationId: string }
  | { outcome: 'denied'; reason: string; confirmationId: string };

/**
 * 唯一入口。granted 返回后调用方继续执行受管操作；denied 返回时事件与
 * denied 收尾（若带 callId）已由 seam/hooks 完成，调用方只需给出最终结果。
 */
export function createApprovalSeam(deps: ApprovalSeamDeps): {
  waitForApproval(req: ApprovalRequest, opts?: ApprovalWaitOptions): Promise<ApprovalOutcome>;
} {
  const { confirmations, events } = deps;

  const waitForApproval = async (
    req: ApprovalRequest,
    opts?: ApprovalWaitOptions,
  ): Promise<ApprovalOutcome> => {
    const track = opts?.tracking;
    const callId = req.callId;

    // 既有 scope grant（"本会话"/"始终"）已覆盖全部单元：不建确认直接放行，
    // 但记录这次是在哪个 scope 下运行的。
    const granted = confirmations.matchGrant(req.sessionId, req.units);
    if (granted) {
      if (callId !== undefined) track?.onGranted?.(callId, granted);
      events.append(req.sessionId, 'approval_grant_applied', {
        call_id: callId,
        tool: req.tool,
        scope: granted,
        categories: req.card.categories,
      });
      // grant 路径没有确认行，confirmationId 为空串
      await deps.beforeGrant?.();
      return { outcome: 'granted', scope: granted, confirmationId: '' };
    }

    // 同会话同参数共享一条在途确认：agent 客户端超时重试会带着相同
    // args_hash 在原确认仍 pending 时再入此分支，若各自建确认，旧确认
    // 会在用户批准后仍以 pending 滞留到 TTL（活动栏计数不清零的根源）。
    let c = confirmations.findPending(req.sessionId, req.argsHash);
    if (!c) {
      c = confirmations.create(req.sessionId, req.tool, req.argsJson, req.argsHash, req.ttlMs ?? CONFIRMATION_TTL_MS);
      events.append(req.sessionId, 'confirmation_created', {
        confirmation_id: c.id,
        tool: req.tool,
        command: req.card.command,
        categories: req.card.categories,
        // 审批卡的风险标签 + 命令内高亮：命中区间在此预计算一次
        matches: req.card.matches,
        expires_at: c.expires_at,
      });
    }
    // the row now waits on the operator, not on the command
    if (callId !== undefined) track?.onAwaiting?.(callId);
    // Synchronous approval: block until the operator approves/denies, the
    // confirmation expires, or the caller aborts. Several blocked requests
    // may share one confirmation (client-timeout retries): they all wake
    // with the same verdict.
    const cancelled = opts?.signal?.aborted === true
      ? true
      : await new Promise<boolean>((resolveWait) => {
        const cleanup = (): void => {
          confirmationBus.off('resolved', onResolved);
          clearTimeout(timer);
          opts?.signal?.removeEventListener('abort', onAbort);
        };
        const onResolved = (rid: string): void => {
          if (rid === c.id) {
            cleanup();
            resolveWait(false);
          }
        };
        const timer = setTimeout(() => {
          cleanup();
          resolveWait(false);
        }, c.expires_at - Date.now() + 500);
        const onAbort = (): void => {
          cleanup();
          resolveWait(true);
        };
        confirmationBus.on('resolved', onResolved);
        opts?.signal?.addEventListener('abort', onAbort, { once: true });
      });
    if (cancelled) {
      // 确认行保持 pending：expireStale / TTL 兜底 timer 负责终态收尾
      return { outcome: 'denied', reason: 'cancelled before approval', confirmationId: c.id };
    }

    // takeApproved() atomically claims the approved confirmation for
    // exactly one waiter — client-timeout retries and concurrent
    // identical calls share one approval; only the claimer executes.
    const claimed = confirmations.takeApproved(req.sessionId, req.argsHash);
    if (claimed) {
      const scope = claimed.scope ?? 'once';
      if (scope !== 'once') confirmations.grant(req.sessionId, req.units, scope);
      if (callId !== undefined) track?.onGranted?.(callId, scope);
      await deps.beforeGrant?.();
      return { outcome: 'granted', scope, confirmationId: c.id };
    }
    const row = confirmations.get(c.id);
    // 兜底 timer 在 expires_at+500ms 唤醒；若 expireStale 尚未跑过，row 仍是
    // pending——按"已过 TTL"判定为审批超时（plan §4.1 的 denied 固定 hint）
    const timedOut = row !== undefined && row.status === 'pending' && row.expires_at <= Date.now();
    const reason = row?.status === 'denied'
      ? 'denied by operator'
      : row?.status === 'expired' || timedOut
        ? 'approval timed out; queue slot released'
        : row?.status === 'consumed'
          ? 'an identical call already consumed this approval'
          : 'confirmation was not approved';
    if (callId !== undefined) track?.onDenied?.(callId, JSON.stringify({ status: 'superseded', reason }));
    events.append(req.sessionId, 'tool_call_denied', { call_id: callId, tool: req.tool, confirmation_id: c.id, reason });
    return { outcome: 'denied', reason, confirmationId: c.id };
  };

  return { waitForApproval };
}
