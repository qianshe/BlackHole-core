/** Deterministic Manager refusals are not unknown shutdown results. Never
 * tell the user the Core was lost when the existing identity remains healthy. */
export function maintenanceRefusalMessage(code: string): string | undefined {
  switch (code) {
    case 'active_work': return 'Core 中仍有 Agent、工具或后台任务正在运行，已拒绝重启／停止；原服务仍在运行。请等待任务结束后重新确认。';
    case 'active_clients': return '其他 VS Code／Desktop 客户端仍连接共享 Core，已拒绝重启／停止；请先正常断开其他客户端。';
    case 'active_requests':
    case 'active_handlers': return 'Core 仍在处理请求或待审批操作，已拒绝重启／停止；完成这些操作后重试。';
    case 'settings_revision_conflict': return '设置在确认期间已经变化，未重启。请重新读取设置版本后再确认。';
    case 'lock_busy': return 'Manager 正在处理其他维护或启动操作，未重启。请稍后主动检查状态。';
    case 'core_update_required': return '当前 Core 不支持本次受保护维护协议，未尝试旧版强制停止。';
    case 'manager_key_mismatch': return 'Core 与 Manager 的维护身份不一致，已拒绝操作；请检查信任状态。';
    default: return undefined;
  }
}
