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
    available: `发现新版本 ${status.availableVersion ?? ''}。请从 BlackHole 托盘的“检查更新”下载和安装。`,
    error: '检查更新失败，当前应用可继续使用。', unconfigured: '此构建尚未配置已签名的发布通道。',
    unsupported: '当前平台的自动更新尚未开放。', update_unavailable: '当前更新组件不可用。',
  };
  const unavailable = ['unconfigured', 'unsupported', 'update_unavailable'].includes(status.state);
  const download = status.download;
  const downloading = !!download && ['downloading', 'verifying', 'cancelling'].includes(download.state);
  const act = async (action: 'check' | 'cancel-download') => {
    setBusy(true);
    try { const next = await readDesktopUpdate(action); if (next) setStatus(next); }
    finally { setBusy(false); }
  };
  const downloadLabel = download ? {
    downloading: `正在下载 v${download.version}：${(download.bytes / 1e6).toFixed(1)} / ${(download.totalBytes / 1e6).toFixed(1)} MB`,
    verifying: '下载完成，正在验证文件完整性…', cancelling: '正在取消下载，当前任务继续运行…',
    ready: `v${download.version} 已下载并校验。安装前会再次确认发布状态，请从托盘继续。`,
    cancelled: '下载已取消，未停止 Core，也未安装更新。', error: '下载或完整性验证失败，当前应用继续运行。',
    interrupted: '上次下载已中断，请重新检查更新。未自动运行安装器。',
  }[download.state] : '';
  return <details className="card" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>关于 BlackHole · 更新</summary>
    <p className="hint">Desktop v{status.currentVersion} · Core v{coreVersion}</p>
    <p role="status" aria-live="polite">{messages[status.state]}</p>
    {status.checkedAt && <p className="hint">上次检查：{new Date(status.checkedAt).toLocaleString()}</p>}
    {download && <div>
      <p role="status" aria-live="polite">{downloadLabel}</p>
      {downloading && <progress aria-label="更新下载进度" value={download.bytes} max={download.totalBytes} />}
      {downloading && <button type="button" disabled={busy || download.state === 'cancelling'} onClick={() => { void act('cancel-download'); }}>取消下载</button>}
    </div>}
    {!unavailable && <button type="button" disabled={busy || downloading || status.state === 'checking'} onClick={() => { void act('check'); }}>检查更新</button>}
    <p className="hint">版本信息由 Cloud 提供，安装包来自 GitHub Releases。后台检查不会自动下载安装，也不会中断当前任务。</p>
  </details>;
}
