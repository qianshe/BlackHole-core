import { useEffect, useState } from 'react';
import { readDesktopUpdate, type DesktopUpdateStatus } from './desktopUpdateClient';

/** Optional native-only surface. Ordinary browsers/VS Code get no updater bridge. */
export function DesktopUpdates({ coreVersion }: { coreVersion: string }) {
  const [status, setStatus] = useState<DesktopUpdateStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    const refresh = () => { void readDesktopUpdate('status').then(value => { if (live) setStatus(value); }); };
    refresh();
    if (!open) return () => { live = false; };
    const timer = window.setInterval(refresh, 3000);
    return () => { live = false; window.clearInterval(timer); };
  }, [open]);
  if (!status) return null;
  const messages: Record<DesktopUpdateStatus['state'], string> = {
    idle: '尚未检查更新。', checking: '正在检查更新…', current: '当前已是最新发布版本。',
    available: `发现新版本 ${status.availableVersion ?? ''}。点击「下载并安装」后会自动完成下载、验证和安装，无需再次确认。`,
    error: '检查更新失败，请稍后重试；当前应用可继续使用。', unconfigured: '此构建尚未配置已签名的发布通道。',
    unsupported: '当前平台的自动更新尚未开放。', update_unavailable: '当前更新组件不可用。',
  };
  const unavailable = ['unconfigured', 'unsupported', 'update_unavailable'].includes(status.state);
  const download = status.download;
  const inDownload = !!download && ['downloading', 'verifying', 'cancelling'].includes(download.state);
  const cancelling = download?.state === 'cancelling';
  const autoInstalling = download?.state === 'ready';
  const canInstall = status.state === 'available' && (!download || !inDownload);
  const act = async (action: 'check' | 'download' | 'cancel-download') => {
    setBusy(true);
    try { const next = await readDesktopUpdate(action); if (next) setStatus(next); }
    finally { setBusy(false); }
  };
  const downloadLabel = download ? {
    downloading: `正在下载 v${download.version}：${(download.bytes / 1e6).toFixed(1)} / ${(download.totalBytes / 1e6).toFixed(1)} MB`,
    verifying: '下载完成，正在验证签名与完整性…', cancelling: '正在取消下载，当前任务继续运行…',
    ready: `v${download.version} 已下载并校验，正在自动安装：即将停止共享 Core 并运行安装器，窗口会自动关闭。若有 AI 任务或其他客户端仍在使用，会被明确拒绝并提示，不会强制中断。`,
    cancelled: '下载已取消，未停止 Core，也未安装更新。', error: '下载或完整性验证失败，当前应用继续运行。',
    interrupted: '上次下载已中断，请重新检查更新。未自动运行安装器。',
  }[download.state] : '';
  return <details className="card" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>关于 BlackHole · 更新</summary>
    <p className="hint">Desktop v{status.currentVersion} · Core v{coreVersion}</p>
    <p role="status" aria-live="polite">{messages[status.state]}</p>
    {download && <p role="status" aria-live="polite">{downloadLabel}</p>}
    {inDownload && <div className="bh-update-row">
      <progress className="bh-update-progress" aria-label="更新下载进度"
        {...(download!.state === 'downloading' ? { value: download!.bytes, max: download!.totalBytes } : {})} />
      {download!.state === 'downloading' && <span className="bh-update-num">{Math.floor(download!.bytes * 100 / download!.totalBytes)}%</span>}
      {download!.state === 'downloading' && <button type="button" className="secondary" disabled={busy || cancelling} onClick={() => { void act('cancel-download'); }}>取消下载</button>}
    </div>}
    {autoInstalling && <div className="bh-update-row"><progress className="bh-update-progress" aria-label="正在安装更新" /></div>}
    <div className="bh-update-actions">
      {canInstall && <button type="button" disabled={busy || status.state === 'checking'} onClick={() => { void act('download'); }}>下载并安装 v{status.availableVersion ?? ''}</button>}
      {!unavailable && !inDownload && !autoInstalling && <button type="button" className="secondary" disabled={busy || status.state === 'checking'} onClick={() => { void act('check'); }}>检查更新</button>}
    </div>
    <p className="hint">版本信息与安装包均来自 GitHub Releases，安装包经签名清单校验。后台检查只读取版本信息，不会自动下载安装，也不会中断当前任务。</p>
  </details>;
}
