/**
 * v2.6 daemon 同步锚点判定（纯逻辑，无 vscode 依赖，便于单测）。
 *
 * 每个 MCP 的工具列表必须属于"当前实际连接的 daemon"，因此三枚锚点都取自
 * GET /health，并由 1s 状态轮询驱动自动同步（不依赖任何手动按钮）：
 *   - daemonId 变了（重启 / 换 daemonEntry / 换端口）→ 'reload'：旧投影与旧工具
 *     列表一律作废，整块重读；webview 收到新 proxies 后为每张卡片自动重取工具列表。
 *   - surfaceGen 变了（reload 启停/增删、catalog 刷新、merged 预热）→ 'repush'：
 *     重读投影，renderProxies 顺带为每张卡片重取一次工具列表（缓存优先）。
 *   - connGen 变了（MCP 主机重连，每次 initialize）→ 'refresh-tools'：自动实时
 *     重取工具列表（调用方按 5s 去抖，避免连接器每轮握手造成拉取风暴）。
 *   - 否则 'none'。
 *
 * 锚点更新遵循"非空才覆盖"：daemon 短暂不可达（health 拿不到）不得清空锚点，
 * 否则恢复后会被误判成"首次就绪"，并在下一次真实变化时漏判。
 */
export interface SyncAnchors {
  daemonId: string | null;
  surfaceGen: number | null;
  connGen: number | null;
}

export type SyncAction = 'reload' | 'repush' | 'refresh-tools' | 'none';

export const EMPTY_ANCHORS: SyncAnchors = { daemonId: null, surfaceGen: null, connGen: null };

/** 从 overview 载荷读取三枚锚点；缺失/类型不符一律按 null（= 未知，不参与判定）。 */
export function readAnchors(ov: Record<string, unknown>): SyncAnchors {
  return {
    daemonId: typeof ov.daemon_id === 'string' ? ov.daemon_id : null,
    surfaceGen: typeof ov.proxy_surface_gen === 'number' ? ov.proxy_surface_gen : null,
    connGen: typeof ov.mcp_conn_gen === 'number' ? ov.mcp_conn_gen : null,
  };
}

/** 非空才覆盖：保留旧值，避免 daemon 短暂不可达时把锚点清空。 */
export function mergeAnchors(prev: SyncAnchors, next: SyncAnchors): SyncAnchors {
  return {
    daemonId: next.daemonId ?? prev.daemonId,
    surfaceGen: next.surfaceGen ?? prev.surfaceGen,
    connGen: next.connGen ?? prev.connGen,
  };
}

/** 依锚点差异决定同步动作；身份优先于表面、表面优先于连接。 */
export function decideSyncAction(prev: SyncAnchors, next: SyncAnchors): SyncAction {
  const daemonChanged = next.daemonId !== null && prev.daemonId !== null && next.daemonId !== prev.daemonId;
  const firstReady = prev.daemonId === null && next.daemonId !== null;
  const surfaceChanged = next.surfaceGen !== null && prev.surfaceGen !== null && next.surfaceGen !== prev.surfaceGen;
  const connChanged = next.connGen !== null && prev.connGen !== null && next.connGen !== prev.connGen;
  if (daemonChanged || firstReady) return 'reload';
  if (surfaceChanged) return 'repush';
  if (connChanged) return 'refresh-tools';
  return 'none';
}
