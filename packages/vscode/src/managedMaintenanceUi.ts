import { commands, window, type Disposable } from 'vscode';
import type { SharedCoreManager } from './sharedCoreManager';
import type { DaemonManager } from './daemonManager';
import type { ControlApi } from './controlApi';
import type { SettingsSync } from './settingsSync';
import { getConfig, useManagedPort } from './config';
import { maintenanceRefusalMessage } from './managedMaintenanceMessage';

/** Native commands only. A Web page cannot synthesize confirmation or a grant. */
export function registerManagedMaintenance(core: SharedCoreManager, daemon: DaemonManager, api: ControlApi, sync: SettingsSync): Disposable[] {
  const report = (e: unknown) => {
    const code = e instanceof Error && /^[a-z][a-z0-9_:-]{0,240}$/.test(e.message) ? e.message : 'managed_operation_failed';
    void window.showErrorMessage(`BlackHole: ${code}。未强制结束进程；结果不明请先检查事务，不要重复操作。`);
  };
  return [
    commands.registerCommand('blackhole.applyCoreSettings', async (expectedRevision?: unknown) => {
      try {
        if (!daemon.isManagedCore) throw Error('managed_core_required');
        if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 0)) throw Error('invalid_settings_revision');
        const target = daemon.managedCoreTarget;
        await sync.flush();
        const settings = await api.settings();
        if (expectedRevision !== undefined && settings.revision !== expectedRevision) throw Error('settings_revision_conflict');
        if (!settings.pending_restart.length) { void window.showInformationMessage('BlackHole: 没有待重启设置；动态设置沿用现有生效机制。'); return true; }
        const answer = await window.showWarningMessage(`应用共享配置版本 ${settings.revision} 并重启原版本 Core？待生效字段：${settings.pending_restart.join(', ')}。其他客户端或活动工作会阻止操作；确认期间配置变化会拒绝本次操作。`, { modal: true }, '应用并重启');
        if (answer !== '应用并重启') return false;
        const ok = await daemon.maintainSharedCore('restart', true, target, settings.revision);
        if (ok) await sync.sync();
        else { const message = maintenanceRefusalMessage(daemon.maintenanceRefusal);
          if (message) void window.showWarningMessage('BlackHole：' + message);
        }
        return ok;
      } catch (e) { report(e); return false; }
    }),
    commands.registerCommand('blackhole.configureCorePort', async () => {
      try {
        if (!core.enabled || !daemon.isManagedCore) throw Error('managed_core_required');
        const endpoint = await core.resolveEndpoint(getConfig().port);
        const input = await window.showInputBox({ title: 'Shared Core 端口（冷变更）', value: String(endpoint.port), prompt: '请先通过受保护 Stop 停止 Core。此操作不会停止或启动进程；所有宿主下次连接会读取 Manager 的端口。', validateInput: v => /^\d{1,5}$/.test(v) && Number(v) >= 1024 && Number(v) <= 65535 ? undefined : '请输入 1024–65535 的端口' });
        if (input === undefined) return false;
        const port = Number(input);
        if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('port_invalid');
        if (await window.showWarningMessage(`将共享端口从 ${endpoint.port} 改为 ${port}？Manager 会确认旧端口和新端口都已关闭，且没有运行记录、活租约或未解决的维护事务。`, { modal: true }, '确认修改端口') !== '确认修改端口') return false;
        const saved = await core.configureEndpoint(endpoint, port);
        useManagedPort(saved.port);
        void window.showInformationMessage('BlackHole: 共享端口已保存，尚未启动 Core。请显式连接或重载窗口。');
        return true;
      } catch (e) { report(e); return false; }
    }),
    commands.registerCommand('blackhole.inspectCoreMaintenance', async () => {
      try {
        if (!core.enabled) throw Error('managed_core_required');
        const pending = await core.inspectMaintenances();
        if (!pending.length) { void window.showInformationMessage('BlackHole: 没有未解决的维护事务。'); return; }
        const pick = await window.showQuickPick(pending.map(record => ({ label: `${record.operation} · ${record.state}`, description: record.requestId, detail: `端口 ${record.target.port} · Core ${record.target.versionName}`, record })), { title: '检查 Shared Core 维护事务', placeHolder: '选择事务查看；取消不会改变状态' });
        if (!pick) return;
        const current = await core.inspectStart();
        const accept = current?.status === 'ready' && current.startFingerprint !== pick.record.target.startFingerprint ? ['接纳已验证的新实例'] : [];
        const answer = await window.showWarningMessage(`事务 ${pick.record.requestId}：${pick.record.state}。恢复将解除本窗口租约；只有目标已退出且没有其他租约时才允许归档。不会强杀、自动重启或删除不同实例的记录。`, { modal: true }, '检查并恢复已退出实例', ...accept);
        if (answer !== '检查并恢复已退出实例' && answer !== '接纳已验证的新实例') return;
        const fingerprint = answer === '接纳已验证的新实例' ? current?.startFingerprint : undefined;
        if (fingerprint && await window.showWarningMessage('仅接纳当前已验证的新实例，不代表原配置申请已经生效。不会停止进程或修改配置；完成后请重新连接并核对设置。', { modal: true }, '确认接纳当前实例') !== '确认接纳当前实例') return;
        await daemon.releaseManagedClientForRecovery();
        await core.recoverMaintenance(pick.record.requestId, fingerprint);
        void window.showInformationMessage('BlackHole: 维护事务已恢复，本操作未启动 Core。需要使用时请手动重载窗口并核对配置。');
      } catch (e) { report(e); }
    }),
  ];
}
