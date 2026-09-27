import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, type CreatedSession, type PermissionMode, type ProjectView } from './api';
import { errorText, PERMISSION_LABEL } from './format';
import { FolderPicker } from './FolderPicker';
import { CopyButton, Icon } from './ui';
import f from './Forms.module.css';

const MODES: [PermissionMode, string][] = [
  ['workspace-write', '只能改这个文件夹里的文件'],
  ['read-only', '只能查看，不能修改'],
  ['danger-full-access', '可以改电脑上的任何文件'],
];

export function NewSessionDialog({ initialPath, onClose, onCreated }: { initialPath?: string; onClose: () => void; onCreated: (id: string) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [path, setPath] = useState(initialPath ?? '');
  const [name, setName] = useState('');
  const [mode, setMode] = useState<PermissionMode>('workspace-write');
  const [autoApprove, setAutoApprove] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedSession | null>(null);

  useEffect(() => {
    ref.current?.showModal();
    const ctrl = new AbortController();
    api.projects(ctrl.signal).then((r) => setProjects(r.projects), () => undefined);
    return () => ctrl.abort();
  }, []);

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (!path.trim() || busy) return;
    setBusy(true);
    setError(null);
    api
      .createSession({ workspace_path: path.trim(), permission_mode: mode, name: name.trim() || undefined, auto_approve: autoApprove })
      .then(setCreated, (err: unknown) => setError(err instanceof ApiError ? errorText(err.code, err.detail) : errorText('network')))
      .finally(() => setBusy(false));
  };

  return (
    <dialog ref={ref} className={f.dialog} aria-labelledby="new-session-title" onClose={onClose} onCancel={onClose}>
      <div className={f.dialogHead}>
        <h2 id="new-session-title" className={f.dialogTitle}>
          {created ? '会话已创建' : '新建会话'}
        </h2>
        <button type="button" className={f.close} aria-label="关闭" onClick={() => ref.current?.close()}>
          <Icon name="close" />
        </button>
      </div>

      {created ? (
        <div className={f.body}>
          <p className={f.help}>把下面的会话 ID 发给你的 AI，它每次调用工具都要带上这个 ID。这个 ID 只显示这一次。</p>
          <div className={f.secretRow}>
            <code className={f.secret}>{created.session_id}</code>
            <CopyButton text={created.session_id} label="复制 ID" />
          </div>
          <div className={f.secretRow}>
            <code className={f.secretMuted}>{created.mcp_url}</code>
            <CopyButton text={created.mcp_url} label="复制连接地址" />
          </div>
          <div className={f.actions}>
            <button
              type="button"
              className={f.primary}
              onClick={() => {
                onCreated(created.session.id);
                ref.current?.close();
              }}
            >
              查看会话
            </button>
          </div>
        </div>
      ) : (
        <form className={f.body} onSubmit={submit}>
          <label className={f.label} htmlFor="ns-path">
            文件夹
          </label>
          <div className={f.inline}>
            <input
              id="ns-path"
              name="workspace-path"
              className={f.input}
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="粘贴路径，或点“浏览”选择"
              spellCheck={false}
              autoComplete="off"
              required
            />
            <button type="button" className={f.secondary} aria-expanded={browsing} onClick={() => setBrowsing((b) => !b)}>
              <Icon name="folder" size={14} /> 浏览
            </button>
          </div>
          {projects.length > 0 && !browsing && (
            <div className={f.chips} aria-label="项目">
              {projects.slice(0, 8).map((p) => (
                <button key={p.id} type="button" className={path === p.path ? f.chipOn : f.chip} onClick={() => setPath(p.path)} title={p.path}>
                  {p.label}
                </button>
              ))}
            </div>
          )}
          {browsing && (
            <FolderPicker
              start={path}
              onPick={(p) => {
                setPath(p);
                setBrowsing(false);
              }}
            />
          )}

          <label className={f.label} htmlFor="ns-name">
            任务（可选）
          </label>
          <input id="ns-name" name="session-name" className={f.input} value={name} maxLength={500} onChange={(e) => setName(e.target.value)} placeholder="例如：修复登录页样式" autoComplete="off" />

          <fieldset className={f.fieldset}>
            <legend className={f.label}>权限</legend>
            {MODES.map(([value, hint]) => (
              <label key={value} className={f.radio}>
                <input type="radio" name="permission-mode" value={value} checked={mode === value} onChange={() => setMode(value)} />
                <span>
                  <strong>{PERMISSION_LABEL[value]}</strong>
                  <span className={f.hint}>{hint}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <label className={f.radio}>
            <input type="checkbox" name="auto-approve" checked={autoApprove} onChange={(e) => setAutoApprove(e.target.checked)} />
            <span>
              <strong>自动批准</strong>
              <span className={f.hint}>需要确认的操作不再弹出审批，直接执行。</span>
            </span>
          </label>

          {error && (
            <div className={f.fieldError} role="alert">
              {error}
            </div>
          )}
          <div className={f.actions}>
            <button type="button" className={f.secondary} onClick={() => ref.current?.close()}>
              取消
            </button>
            <button type="submit" className={f.primary} disabled={busy || !path.trim()}>
              {busy ? '正在创建…' : '创建会话'}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}
