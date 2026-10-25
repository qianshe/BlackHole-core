import { useEffect, useRef, useState } from 'react';
import { readDesktopUpdate, type DesktopUpdateStatus } from '../settings/desktopUpdateClient';
import c from './console.module.css';

/**
 * Sidebar-bottom update rail, rendered only inside the native Desktop window
 * (the bridge is absent in browsers and VS Code). The silent daily check
 * fills the status; when a newer release exists the row offers the same
 * click-authorized download-and-install flow as the settings card, so the
 * user never has to open settings. Hidden entirely while current — no clutter.
 */
export function SidebarUpdate({ collapsed }: { collapsed: boolean }) {
  const [status, setStatus] = useState<DesktopUpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    let live = true;
    const refresh = (): void => { void readDesktopUpdate('status').then(value => { if (live) setStatus(value); }); };
    refresh();
    timer.current = window.setInterval(refresh, 3000);
    return () => { live = false; window.clearInterval(timer.current); };
  }, []);
  if (!status) return null;
  const download = status.download;
  const available = status.state === 'available';
  const inDownload = !!download && ['downloading', 'verifying', 'cancelling'].includes(download.state);
  const installing = download?.state === 'ready';
  if (!available && !inDownload && !installing) return null;
  const pct = download && download.state === 'downloading' && download.totalBytes > 0
    ? Math.max(1, Math.floor(download.bytes * 100 / download.totalBytes)) : undefined;
  const label = installing ? '正在安装更新…'
    : download?.state === 'verifying' ? '正在验证更新…'
    : download?.state === 'cancelling' ? '正在取消下载…'
    : pct !== undefined ? `正在下载 v${download!.version} ${pct}%`
    : `下载更新 v${status.availableVersion ?? ''}`;
  const start = (): void => {
    if (busy || inDownload || installing) return;
    setBusy(true);
    void readDesktopUpdate('download').then(next => { if (next) setStatus(next); }).finally(() => setBusy(false));
  };
  const interactive = available && !inDownload && !installing;
  return (
    <button
      type="button"
      className={`${c.updateRow} ${collapsed ? c.updateRowIcon : ''}`}
      disabled={!interactive}
      onClick={start}
      title={label}
      aria-label={interactive ? label : label}
    >
      {collapsed ? (
        <span className={c.updateBadgeDot} aria-hidden="true" />
      ) : (
        <>
          <span className={c.updateLabel}>{label}</span>
          {pct !== undefined && <span className={c.updatePct} aria-hidden="true">{pct}%</span>}
        </>
      )}
      {(inDownload || installing) && <span className={c.updateProgress} aria-hidden="true" style={pct !== undefined ? { width: `${pct}%` } : undefined} />}
      {installing && <span className={c.updateProgressIndet} aria-hidden="true" />}
    </button>
  );
}
