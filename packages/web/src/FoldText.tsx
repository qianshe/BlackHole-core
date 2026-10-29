// A long message of yours folds to a few lines with a toggle; short ones render as before.
import { useLayoutEffect, useRef, useState } from 'react';
import f from './Fold.module.css';

/** Folded height in px; a message only folds when it is clearly taller (no toggle for one extra line). */
export const FOLD_AT = 200;
const SLACK = 48;

export function FoldText({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [long, setLong] = useState(false);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = (): void => setLong(el.scrollHeight > FOLD_AT + SLACK);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text]);
  const folded = long && !open;
  return (
    <>
      <div ref={ref} className={`${className ?? ''} ${folded ? f.folded : ''}`}>{text}</div>
      {long && (
        <button type="button" className={f.toggle} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? '收起' : '展开全文'}
        </button>
      )}
    </>
  );
}
