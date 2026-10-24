import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, type DirListing } from './api';
import { errorText } from './format';
import { folderCrumbs } from './folderCrumbs';
import { Icon } from './ui';
import f from './Forms.module.css';

/**
 * Browse directories on the Core computer, not on the browser's device.
 * Parent can confirm only a successfully loaded, accessible Core directory.
 */
export function FolderPicker({ start, onCurrentChange }: {
  start: string;
  onCurrentChange: (path: string | null) => void;
}) {
  const inputId = useId();
  const [at, setAt] = useState(start);
  const [reload, setReload] = useState(0);
  const crumbsRef = useRef<HTMLElement>(null);
  const [address, setAddress] = useState(start);
  const [data, setData] = useState<DirListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const navigate = (destination: string): void => {
    if (destination === at) setReload((n) => n + 1);
    setAt(destination);
    setAddress(destination);
    setError(null);
    setData(null);
    setLoading(true);
    onCurrentChange(null);
  };

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    setData(null);
    onCurrentChange(null);
    api.dirs(at, ctrl.signal).then(
      (listing) => {
        if (ctrl.signal.aborted) return;
        setData(listing);
        setAddress(listing.path ?? '');
        setLoading(false);
        onCurrentChange(!listing.denied ? listing.path : null);
      },
      (cause: unknown) => {
        if (ctrl.signal.aborted) return;
        setError(cause instanceof ApiError ? errorText(cause.code, cause.detail) : errorText('network'));
        setLoading(false);
        onCurrentChange(null);
      },
    );
    return () => ctrl.abort();
  }, [at, reload, onCurrentChange]);

  useEffect(() => {
    // Long Windows paths should expose the current directory rather than
    // cutting off the final breadcrumb at the right edge of the modal.
    if (crumbsRef.current) crumbsRef.current.scrollLeft = crumbsRef.current.scrollWidth;
  }, [data?.path]);

  const goToAddress = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = address.trim();
    if (next) navigate(next);
  };
  const crumbs = folderCrumbs(data?.path ?? '');
  const dirs = data?.dirs ?? [];

  return (
    <div className={f.folderBrowser}>
      <div className={f.folderNavigation}>
        <nav ref={crumbsRef} className={f.folderCrumbs} aria-label="文件夹层级">
          <button type="button" className={f.folderCrumb} onClick={() => navigate('')} disabled={!at && !loading}>此电脑</button>
          {crumbs.map((part) => (
            <span className={f.folderCrumbPiece} key={part.path}>
              <Icon name="chevron" size={12} />
              <button type="button" className={f.folderCrumb}
                aria-current={part.path === data?.path ? 'location' : undefined}
                disabled={part.path === data?.path} onClick={() => navigate(part.path)} title={part.path}>
                {part.label}
              </button>
            </span>
          ))}
        </nav>
        <form className={f.folderAddress} onSubmit={goToAddress}>
          <label className={f.folderSectionLabel} htmlFor={inputId}>目录路径</label>
          <div className={f.folderAddressRow}>
            <input id={inputId} value={address} onChange={(e) => {
              setAddress(e.target.value);
              // Editing does not change the validated directory. Require
              // "转到" before the bottom confirmation can use this path.
              onCurrentChange(e.target.value.trim() === data?.path ? data.path : null);
            }}
              spellCheck={false} autoComplete="off" placeholder="输入 Core 电脑上的绝对路径" aria-label="目录路径" />
            <button type="submit" disabled={!address.trim()} className={f.folderGo}>转到</button>
          </div>
        </form>
      </div>

      <section className={f.folderDirectory} aria-label="浏览文件夹">
        <div className={f.folderDirectoryHead}>
          <div className={f.folderDirectoryTitle}>
            <Icon name="folder" size={16} />
            <span>{data?.path ? '文件夹' : '磁盘与根目录'}</span>
          </div>
        </div>
        <ul className={f.folderDirectoryList} role="list" aria-label="文件夹列表" aria-busy={loading}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
            const entries = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
            const current = entries.indexOf(document.activeElement as HTMLButtonElement);
            if (!entries.length || current < 0) return;
            event.preventDefault();
            entries[(current + (event.key === 'ArrowDown' ? 1 : entries.length - 1)) % entries.length]?.focus();
          }}>
          {loading && <li className={f.folderNote} role="status">正在读取目录…</li>}
          {!loading && error && <li className={f.folderError} role="alert">{error}。可输入其他路径，或返回此电脑。</li>}
          {!loading && data?.denied && <li className={f.folderError} role="alert">没有权限读取该文件夹，请选择其他目录。</li>}
          {!loading && !error && data && dirs.length === 0 && !data.denied && (
            <li className={f.folderNote}>没有子文件夹，可以直接选择当前目录。</li>
          )}
          {!loading && dirs.map((dir) => (
            <li key={dir.path}>
              <button type="button" className={f.folderDirectoryItem} onClick={() => navigate(dir.path)}
                title={dir.path} aria-label={`进入 ${dir.name}`}>
                <Icon name="folder" size={17} />
                <span>{dir.name}</span>
                <Icon name="chevron" size={15} />
              </button>
            </li>
          ))}
          {!loading && data?.truncated && <li className={f.folderNote}>当前仅显示前 500 个子文件夹，可输入完整路径继续导航。</li>}
        </ul>
      </section>
    </div>
  );
}
