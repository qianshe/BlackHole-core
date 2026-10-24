import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { ProjectView } from '../api';
import { Icon } from '../ui';
import p from './ProjectSwitcher.module.css';

/** Lightweight, searchable switcher for already known Core workspaces.
 * Filesystem browsing is deliberately a separate, less frequent action. */
export function ProjectSwitcher({ projects, currentPath, disabled, onSelect, onBrowse }: {
  projects: readonly ProjectView[];
  currentPath: string;
  disabled?: boolean;
  onSelect: (path: string) => void;
  onBrowse: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const current = projects.find(project => project.path === currentPath);
  const currentLabel = current?.label ?? (currentPath ? currentPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : null) ?? '选择项目';

  const filtered = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase();
    return projects.filter(project => !keyword ||
      project.label.toLocaleLowerCase().includes(keyword) ||
      project.path.toLocaleLowerCase().includes(keyword))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.sessions - a.sessions);
  }, [projects, query]);

  useEffect(() => {
    if (!open) return;
    search.current?.focus({ preventScroll: true });
    const closeOnOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutside, true);
    return () => document.removeEventListener('pointerdown', closeOnOutside, true);
  }, [open]);

  const hide = (restoreFocus = true) => {
    setOpen(false);
    setQuery('');
    setActive(0);
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  };
  const switchTo = (path: string) => {
    hide(false);
    onSelect(path);
  };
  const browse = () => {
    // The Drawer restores focus to the trigger if the user cancels it.
    hide();
    onBrowse();
  };
  const keys = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); hide(); }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const count = filtered.length + 1; // final entry = browse
      setActive(index => (index + (event.key === 'ArrowDown' ? 1 : count - 1)) % count);
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const project = filtered[active];
      if (project) switchTo(project.path); else browse();
    }
  };

  return (
    <div className={p.root} ref={root}>
      <button ref={trigger} type="button" className={p.trigger} disabled={disabled}
        aria-label="项目" aria-haspopup="dialog" aria-expanded={open}
        title={currentPath || '切换工作项目'} onClick={() => {
          if (open) hide();
          else { setOpen(true); setQuery(''); setActive(0); }
        }}>
        <Icon name="folder" size={15} />
        <span className={p.current}>{currentLabel}</span>
        <Icon name="chevron" size={13} className={p.chevron} />
      </button>

      {open && (
        <div className={p.panel} role="dialog" aria-label="选择项目" onKeyDown={keys}>
          <label className={p.search}>
            <Icon name="search" size={15} />
            <input ref={search} value={query} onChange={event => {
              setQuery(event.target.value);
              setActive(0);
            }} type="search" placeholder="搜索项目名称或路径" aria-label="搜索项目"
              autoComplete="off" />
          </label>
          <div className={p.list} role="listbox" aria-label="已保存项目">
            {filtered.length === 0 ? (
              <div className={p.empty} role="status">
                {query ? '没有匹配的项目，可以添加新目录。' : '还没有项目。添加一个文件夹来开始。'}
              </div>
            ) : (
              filtered.map((project, index) => (
                <button key={project.id} type="button" role="option"
                  aria-selected={project.path === currentPath}
                  className={`${p.item} ${index === active ? p.active : ''}`}
                  title={project.path} onMouseEnter={() => setActive(index)}
                  onClick={() => switchTo(project.path)}>
                  <Icon name="folder" size={16}/>
                  <span className={p.projectText}>
                    <span className={p.projectName}>{project.label}</span>
                    <span className={p.projectPath}>{project.path}</span>
                  </span>
                  {project.path === currentPath && <Icon name="check" size={15} />}
                </button>
              ))
            )}
          </div>
          <button type="button" className={`${p.addNew} ${active === filtered.length ? p.active : ''}`}
            onMouseEnter={() => setActive(filtered.length)} onClick={browse}>
            <Icon name="plus" size={16} />
            <span>添加新项目…</span>
            <span className={p.addHint}>浏览 Core 文件夹</span>
          </button>
        </div>
      )}
    </div>
  );
}
