import { Icon } from '../ui';
import { useEffect, useRef, useState } from 'react';
import { readDesktopUpdate, type DesktopUpdateStatus } from '../settings/desktopUpdateClient';
import c from './console.module.css';

/**
 * Sidebar-bottom update rail, rendered only inside the native Desktop window
 * (the bridge is absent in browsers and VS Code). The silent startup check
 * fills the status; when a newer release exists the row offers the same
 * click-authorized download-and-install flow as the settings card. Hidden
 * entirely while current — the rail never idles in the sidebar.
 */
export function SidebarUpdate({ collapsed }: { collapsed: boolean }) {
  const [status, setStatus] = useState<DesktopUpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    let live = true;
    const refresh = (): void => { void readDesktopUpdate('status').then(value => { if (live) setStatus(value); }); };
    refresh();
    timer.current = window.setInterval(refresh, 2000);
    return () => { live = false; window.clearInterval(timer.current); };
  }, []);
  if (!status) return null;
  const download = status.download;
  const available = status.state === 'available';
  const downloading = download?.state === 'downloading';
  const inProgress = !!download && ['downloading', 'verifying', 'cancelling'].includes(download.state);
  const installing = download?.state === 'ready';
  if (!available && !inProgress && !installing) return null;
  const pct = downloading && download.totalBytes > 0
    ? Math.max(2, Math.floor(download.bytes * 100 / download.totalBytes)) : undefined;
  const label = installing ? '正在安装更新…'
    : download?.state === 'verifying' ? '正在验证更新…'
    : download?.state === 'cancelling' ? '正在取消下载…'
    : downloading ? `正在下载 v${download.version}`
    : `下载更新 v${status.availableVersion ?? ''}`;
  const start = (): void => {
    if (busy || inProgress || installing) return;
    setBusy(true);
    void readDesktopUpdate('download').then(next => { if (next) setStatus(next); }).finally(() => setBusy(false));
  };
  const interactive = available && !inProgress && !installing;
  // Download progress fills the row background left-to-right — one mechanism
  // for the state, no stacked chrome.
  const fill = pct !== undefined
    ? { background: `linear-gradient(to right, var(--sel) ${pct}%, var(--surface-2) ${pct}%)` }
    : undefined;
  return (
    <button
      type="button"
      className={`${c.updateRow} ${collapsed ? c.updateRowCollapsed : ''} ${interactive ? c.updateRowReady : c.updateRowBusy}`}
      disabled={!interactive}
      onClick={start}
      title={label}
    >
      <span className={c.updateGlyph} aria-hidden="true"><Icon name="download" /></span>
      {!collapsed && <span className={c.updateLabel}>{label}</span>}
      {!collapsed && downloading && pct !== undefined && <span className={c.updatePct}>{pct}%</span>}
      {collapsed && !interactive && <span className={c.updateDot} aria-hidden="true" />}
      {installing && <span className={c.updateIndeterminate} aria-hidden="true" />}
      {fill && <span className={c.updateFill} style={fill} aria-hidden="true" />}
    </button>
  );
}
