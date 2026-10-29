import { useCallback, useState } from 'react';
import { FolderPicker } from '../FolderPicker';
import { Icon } from '../ui';
import { DialogHead, failText, Modal } from './common';
import p from './ProjectFolderDialog.module.css';

export function ProjectFolderDialog({ mode, start, onSelect, onClose }: {
  mode: 'add' | 'session';
  start: string;
  onSelect: (path: string) => Promise<void>;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const updateSelection = useCallback((path: string | null) => {
    setSelected(path);
    setError(null);
  }, []);
  const title = mode === 'add' ? '添加项目' : '选择工作目录';
  const action = mode === 'add' ? '添加项目' : '使用此目录';
  const finish = async () => {
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSelect(selected);
      onClose();
      // Native <dialog> restores its opener's focus on unmount. Move focus
      // back into the session composer after that cleanup has finished.
      requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="第一条消息"]')?.focus({ preventScroll: true }));
    } catch (e) {
      setError(failText(e));
      setBusy(false);
    }
  };

  return (
    <Modal label={title} className={p.dialog} onClose={() => { if (!busy) onClose(); }}>
      <DialogHead title={title} onClose={() => { if (!busy) onClose(); }} />
      <div className={p.body}>
        <p className={p.intro}>选择 Shared Core 所在电脑上的工作目录</p>
        <FolderPicker start={start} onCurrentChange={updateSelection} />
      </div>
      <div className={p.footer}>
        <div className={p.selected} aria-live="polite">
          {selected ? (
            <>
              <Icon name="check" size={14} />
              <span title={selected}>{selected}</span>
            </>
          ) : '请选择文件夹'}
        </div>
        {error && <p className={p.error} role="alert">{error}</p>}
        <div className={p.actions}>
          <button type="button" className={p.cancel} onClick={onClose} disabled={busy}>取消</button>
          <button type="button" className={p.confirm} onClick={() => void finish()} disabled={!selected || busy}>
            {busy ? '正在确认…' : action}
          </button>
        </div>
      </div>
    </Modal>
  );
}
