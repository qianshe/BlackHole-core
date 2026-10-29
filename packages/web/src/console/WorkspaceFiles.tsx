import { useEffect, useState } from 'react';
import { api, ApiError, type WorkspaceEntries } from '../api';
import { Icon } from '../ui';
import c from './console.module.css';

function displayError(reason: unknown): string {
  if (reason instanceof ApiError) {
    const known: Record<string, string> = {
      workspace_not_found: '当前会话的工作区不可用。',
      workspace_entry_not_found: '文件或目录已被移动或删除。',
      workspace_unreadable: '没有权限读取此目录或文件。',
      workspace_file_too_large: '文件超过 128 KB，暂不提供内联预览。',
      workspace_file_binary: '这是二进制或非 UTF-8 文件，不能作为文本预览。',
      outside_workspace: '不能访问工作区以外的路径。',
    };
    return known[reason.code] ?? '读取文件失败，请重试。';
  }
  return '无法连接本地文件服务。';
}

function Folder({ sessionId, path, label, depth, onFile, root = false }: {
  sessionId: string;
  path: string;
  label: string;
  depth: number;
  onFile: (relative: string) => void;
  root?: boolean;
}) {
  const [expanded, setExpanded] = useState(root);
  const [listing, setListing] = useState<WorkspaceEntries | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!expanded) return;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void api.workspaceEntries(sessionId, path, controller.signal).then(
      (rows) => { if (!controller.signal.aborted) setListing(rows); },
      (reason: unknown) => { if (!controller.signal.aborted) setError(displayError(reason)); },
    ).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [expanded, sessionId, path, attempt]);
  return (
    <div className={c.workspaceFolder}>
      {!root && (
        <button className={c.workspaceRow} type="button" style={{ paddingLeft: 12 + depth * 14 }}
          aria-expanded={expanded} title={path} onClick={() => setExpanded((value) => !value)}>
          <span className={c.workspaceChevron} data-expanded={expanded}><Icon name="chevron" size={12} /></span>
          <Icon name="folder" size={14} /><span className={c.workspaceName}>{label}</span>
        </button>
      )}
      {expanded && (
        <div role={root ? 'tree' : 'group'} aria-label={root ? '工作区文件' : undefined}>
          {loading && !listing && <p className={c.workspaceNote} role="status">正在读取目录…</p>}
          {error && <div className={c.workspaceNote} role="alert">{error} <button type="button" onClick={() => setAttempt((n) => n + 1)}>重试</button></div>}
          {listing?.entries.map((entry) => entry.type === 'dir' ? (
            <Folder key={entry.path} sessionId={sessionId} path={entry.path} label={entry.name}
              depth={depth + 1} onFile={onFile} />
          ) : (
            <button key={entry.path} className={c.workspaceRow} type="button"
              style={{ paddingLeft: 12 + (depth + 1) * 14 }}
              title={entry.path} onClick={() => onFile(entry.path)}>
              <span className={c.workspaceFileGlyph} aria-hidden="true">▤</span>
              <span className={c.workspaceName}>{entry.name}</span>
            </button>
          ))}
          {listing?.truncated && <p className={c.workspaceNote}>当前目录条目过多，仅展示前 400 项。</p>}
          {!loading && listing?.entries.length === 0 && <p className={c.workspaceNote}>此目录没有可预览的文件。</p>}
        </div>
      )}
    </div>
  );
}

export function WorkspaceExplorer({ sessionId, workspacePath, onFile }: {
  sessionId: string;
  workspacePath: string;
  onFile: (relative: string) => void;
}) {
  const root = workspacePath.split(/[\\/]/).filter(Boolean).pop() || workspacePath;
  return (
    <section aria-label="工作区文件浏览" className={c.workspaceExplorer}>
      <div className={c.workspaceRoot} title={workspacePath}><Icon name="folder" size={14} />{root}</div>
      <Folder key={sessionId} root sessionId={sessionId} path="" label={root} depth={0} onFile={onFile} />
    </section>
  );
}

export function WorkspaceFileView({ sessionId, path: relative }: { sessionId: string; path: string }) {
  const [state, setState] = useState<{ path: string; content: string } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setState(null);
    setError('');
    void api.workspaceFile(sessionId, relative, controller.signal).then(
      (content) => { if (!controller.signal.aborted) setState(content); },
      (reason: unknown) => { if (!controller.signal.aborted) setError(displayError(reason)); },
    );
    return () => controller.abort();
  }, [sessionId, relative]);
  const lines = state?.content.split('\n') ?? [];
  return (
    <section className={c.workspacePreview} aria-label={relative}>
      <div className={c.workspacePreviewHeading} title={relative}>
        <span>{relative}</span><small>只读</small>
      </div>
      {error && <p className={c.workspaceNote} role="alert">{error}</p>}
      {!state && !error && <p className={c.workspaceNote} role="status">正在读取文件…</p>}
      {state && <div className={c.workspaceCode} role="region" aria-label="文件只读内容">
        <pre className={c.workspaceLineNumbers} aria-hidden="true">{lines.map((_, index) => index + 1).join('\n')}</pre>
        <pre className={c.workspaceCodeText}>{state.content}</pre>
      </div>}
    </section>
  );
}
