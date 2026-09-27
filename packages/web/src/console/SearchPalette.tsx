import { useMemo, useState } from 'react';
import type { ProjectView, SessionView } from '../api';
import { searchAll } from '../format';
import { Icon } from '../ui';
import { Modal } from './common';
import c from './console.module.css';

export function SearchPalette({
  sessions,
  projects,
  onPick,
  onClose,
}: {
  sessions: SessionView[];
  projects: ProjectView[];
  onPick: (kind: 'session' | 'project', id: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const hits = useMemo(() => searchAll(q, sessions, projects), [q, sessions, projects]);
  const pick = (i: number): void => {
    const h = hits[i];
    if (h) onPick(h.kind, h.id);
  };
  return (
    <Modal label="搜索" onClose={onClose} className={c.searchBox} top>
      <div className={c.searchInputRow}>
        <Icon name="search" />
        <input
          className={c.searchInput}
          autoFocus
          placeholder="搜索会话、项目、路径或会话 ID"
          role="combobox"
          aria-expanded="true"
          aria-controls="search-results"
          aria-activedescendant={hits[sel] ? `hit-${sel}` : undefined}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setSel((s) => Math.min(s + 1, hits.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setSel((s) => Math.max(s - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              pick(sel);
            }
          }}
        />
      </div>
      <ul className={c.results} id="search-results" role="listbox" aria-label="搜索结果">
        {hits.length === 0 && <li className={c.sideEmpty}>{q ? '没有匹配的结果' : '还没有进行中的会话'}</li>}
        {hits.map((h, i) => (
          <li key={`${h.kind}:${h.id}`} role="presentation">
            <button type="button" id={`hit-${i}`} role="option" aria-selected={i === sel} className={c.result} onMouseEnter={() => setSel(i)} onClick={() => pick(i)}>
              <Icon name={h.kind === 'project' ? 'folder' : 'list'} size={14} />
              <span style={{ minWidth: 0 }}>
                {h.title}
                <small>{h.detail}</small>
              </span>
              <span className={c.resultKind}>{h.kind === 'project' ? '项目' : '会话'}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className={c.searchFoot}>
        <span>↑↓ 选择</span>
        <span>Enter 打开</span>
        <span>Esc 关闭</span>
      </div>
    </Modal>
  );
}
