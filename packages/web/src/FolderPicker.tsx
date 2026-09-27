import { useEffect, useState } from 'react';
import { api, ApiError, type DirListing } from './api';
import { errorText } from './format';
import { Icon } from './ui';
import f from './Forms.module.css';

/** Browse folders on this computer. Only folders are listed; the chosen path is what the session uses. */
export function FolderPicker({ start, onPick }: { start: string; onPick: (path: string) => void }) {
  const [at, setAt] = useState(start);
  const [data, setData] = useState<DirListing | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    setError(null);
    api.dirs(at, ctrl.signal).then(
      (d) => setData(d),
      (e: unknown) => {
        if (ctrl.signal.aborted) return;
        setError(e instanceof ApiError ? errorText(e.code, e.detail) : errorText('network'));
        if (at) setAt(''); // unreadable start: fall back to the top level
      },
    );
    return () => ctrl.abort();
  }, [at]);

  return (
    <div className={f.picker}>
      <div className={f.pickerBar}>
        <button type="button" className={f.small} disabled={!data?.path} onClick={() => setAt(data?.parent ?? '')}>
          <Icon name="chevron" size={12} className={f.flip} /> 上一级
        </button>
        <span className={f.pickerPath} title={data?.path ?? ''}>
          {data?.path ?? '此电脑'}
        </span>
        {data?.path && (
          <button type="button" className={f.primarySmall} onClick={() => onPick(data.path as string)}>
            选这个文件夹
          </button>
        )}
      </div>
      {error && <div className={f.fieldError}>{error}</div>}
      <ul className={f.pickerList} aria-label="文件夹">
        {data?.denied && <li className={f.pickerNote}>没有权限读取这个文件夹。</li>}
        {data && data.dirs.length === 0 && !data.denied && <li className={f.pickerNote}>没有子文件夹。</li>}
        {data?.dirs.map((d) => (
          <li key={d.path}>
            <button type="button" className={f.pickerItem} onClick={() => setAt(d.path)} title={d.path}>
              <Icon name="folder" size={14} />
              <span>{d.name}</span>
            </button>
          </li>
        ))}
        {data?.truncated && <li className={f.pickerNote}>只显示前 500 个，请直接输入路径。</li>}
      </ul>
    </div>
  );
}
