import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import p from './Picker.module.css';

/**
 * Compact picker: the current value as text + a small chevron, opening a short menu. Used where
 * a native select is too wide and its OS popup cannot be styled (composer send method).
 * Keyboard: ↑/↓ open and move, Enter/Space picks, Esc closes; an outside click closes.
 */
export interface PickerItem { id: string; label: string; tag?: string; /** Divider above this item. */ sep?: boolean }

export function Picker({ items, value, onChange, label, disabled, placement = 'down', align = 'end', className, menuClassName }: {
  items: readonly PickerItem[];
  value: string;
  onChange: (id: string) => void;
  label: string;
  disabled?: boolean;
  placement?: 'up' | 'down';
  /** Menu edge aligned with the button: 'start' for pickers on the left of a row. */
  align?: 'start' | 'end';
  className?: string;
  menuClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const cur = items.find((x) => x.id === value) ?? items[0];
  const [act, setAct] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const list = useRef<HTMLUListElement>(null);

  // Long menus scroll: keep the highlighted row visible when moving with the keyboard.
  useEffect(() => {
    if (open) (list.current?.children[act] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
  }, [open, act]);

  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent): void => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', down, true);
    return () => document.removeEventListener('mousedown', down, true);
  }, [open]);

  const show = (): void => { setAct(Math.max(0, items.indexOf(cur!))); setOpen(true); };
  const choose = (i: number): void => {
    setOpen(false);
    btn.current?.focus();
    const it = items[i];
    if (it && it.id !== cur?.id) onChange(it.id);
  };
  const key = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); setOpen(false); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) { show(); return; }
      setAct((a) => (a + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length);
    } else if ((e.key === 'Enter' || e.key === ' ') && open) { e.preventDefault(); choose(act); }
  };

  return (
    <div ref={wrap} className={`${p.pick} ${open ? p.open : ''} ${className ?? ''}`}>
      <button ref={btn} type="button" className={p.btn} disabled={disabled} aria-label={label} title={label}
        aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined}
        onClick={() => (open ? setOpen(false) : show())} onKeyDown={key}>
        <span className={p.cur}>{cur?.label ?? ''}</span>
      </button>
      {open && (
        <ul ref={list} id={listId} role="listbox" aria-label={label}
          className={`${p.menu} ${placement === 'up' ? p.up : p.down} ${align === 'start' ? p.start : ''} ${menuClassName ?? ''}`}>
          {items.map((x, i) => (
            <li key={x.id} role="option" aria-selected={x.id === cur?.id} className={`${p.item} ${i === act ? p.act : ''} ${x.sep ? p.sep : ''}`} title={x.tag ? `${x.label}  ${x.tag}` : undefined}
              onMouseEnter={() => setAct(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(i)}>
              <span className={p.ck} aria-hidden="true">✓</span>
              <span className={p.lb}>{x.label}</span>
              {x.tag && <span className={p.tg}>{x.tag}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
