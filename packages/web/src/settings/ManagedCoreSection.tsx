import { useRef, useState } from 'react';
import type { SettingsView } from '../api';
import type { SettingsCoreAction } from '../../../contracts/src/settings-host';
import { hasNativeMaintenance } from './host';
import { runManagedCoreAction } from './managedCoreActions';

/** Saved settings and proven startup state stay separate. This component never
 * obtains a lifecycle grant, calls native HTTP or treats a UI click as approval. */
export function ManagedCoreSection({ settings, refresh }: { settings: SettingsView; refresh: () => Promise<unknown> }) {
  const native = hasNativeMaintenance();
  const locked = useRef(false);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  if (!settings.managed) return null;
  const action = async (value: SettingsCoreAction) => {
    if (locked.current || !native) return;
    locked.current = true; setBusy(true); setMessage('请在原生宿主提示中继续；网页点击不代替确认。');
    // Capture the visible revision. The native command must reject a stale view.
    const revision = value === 'apply-settings' ? settings.revision : undefined;
    try {
      const result = await runManagedCoreAction(value, revision);
      if (value === 'inspect-maintenance') setMessage('原生检查已返回。恢复结果以原生提示为准，本页不自动重试或启动 Core。');
      else setMessage(result.completed ? '原生操作已确认完成，正在重新读取状态。' : '未确认操作完成，请查看原生提示；本页不会自动重试。');
      try { await refresh(); } catch { setMessage('操作结果请查看原生提示；当前无法刷新，请重新连接后核对状态。'); }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '维护结果未确认，请检查事务，不要重复操作。');
    } finally { locked.current = false; setBusy(false); }
  };
  return <section aria-label="Shared Core 维护">
    <div className="sec">Shared Core<small>由 Manager 协调，关闭一个客户端不等于停止服务。</small></div>
    <div className="card">
      <div className="fgrid">
        <div className="f"><label>已保存的配置版本</label><div className="bhp-readonly">{settings.revision}</div></div>
        <div className="f"><label>当前实例启动时的配置版本</label><div className="bhp-readonly">{settings.application?.started_revision ?? '未报告'}</div></div>
      </div>
      <p className="hint">{settings.pending_restart.length ? '有已保存的设置尚待重启。应用会绑定所见版本，确认期间变更将被拒绝。' : '没有待重启设置；动态设置沿用现有生效机制。'}</p>
      <p className="hint">配置版本只覆盖共享 SettingsStore；独立凭据或密钥文件不在此版本范围内。端口必须在 Core 停止且无活跃租约后冷变更，不在窗口设置中覆盖。</p>
      {native ? <div className="btnrow">
        <button type="button" disabled={busy || !settings.pending_restart.length} onClick={() => void action('apply-settings')}>应用保存配置并重启</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => void action('configure-port')}>配置共享端口（停止后）</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => void action('inspect-maintenance')}>检查／恢复维护事务</button>
      </div> : <div className="hint warn" role="note">
        此页面无原生维护通道。请在 VS Code 运行 <code>BlackHole: Apply Shared Core Settings</code>，或在 BlackHole Desktop 设置-高级页操作；进行中的工作会阻止维护，不会被强制中断。
      </div>}
      <div className="hint" role="status" aria-live="polite">{message}</div>
    </div>
  </section>;
}
