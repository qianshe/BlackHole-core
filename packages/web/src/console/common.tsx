import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../api';
import { errorText } from '../format';
import { Icon } from '../ui';
import c from './console.module.css';

// ─── toasts ───────────────────────────────────────────────────────────
type ToastTone = 'ok' | 'warn' | 'bad';
type ToastFn = (text: string, tone?: ToastTone) => void;
const ToastCtx = createContext<ToastFn>(() => undefined);
export const useToast = (): ToastFn => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ text: string; tone: ToastTone; n: number } | null>(null);
  const show = useCallback<ToastFn>((text, tone = 'ok') => setToast((t) => ({ text, tone, n: (t?.n ?? 0) + 1 })), []);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), toast.tone === 'bad' ? 5200 : 2600);
    return () => clearTimeout(id);
  }, [toast]);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      <div aria-live="polite" role="status">
        {toast && (
          <div key={toast.n} className={toast.tone === 'ok' ? c.toast : c[`toast_${toast.tone}`]}>
            {toast.text}
          </div>
        )}
      </div>
    </ToastCtx.Provider>
  );
}

/** User-facing text for any thrown value. */
export const failText = (e: unknown): string => (e instanceof ApiError ? errorText(e.code, e.detail) : errorText('network'));

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // clipboard API needs focus/permission; the textarea path covers the WebView
    const t = document.createElement('textarea');
    t.value = text;
    t.style.position = 'fixed';
    t.style.opacity = '0';
    document.body.appendChild(t);
    t.select();
    const ok = document.execCommand('copy');
    t.remove();
    return ok;
  }
}

// ─── modal dialog (native <dialog>: focus trap, Esc, top layer) ───────
export function Modal({
  label,
  onClose,
  children,
  className,
  top,
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  /** anchor near the top (search palette) instead of centred */
  top?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className={top ? c.overlayTop : c.overlay}
      aria-label={label}
      onCancel={(e) => {
        e.preventDefault();
        closeRef.current();
      }}
      onMouseDown={(e) => {
        // backdrop click: the dialog element itself is the full-screen scrim
        if (e.target === e.currentTarget) closeRef.current();
      }}
    >
      <div className={className ?? c.dialog}>{children}</div>
    </dialog>
  );
}

export function DialogHead({ title, onClose, id }: { title: string; onClose: () => void; id?: string }) {
  return (
    <div className={c.dialogHead}>
      <h2 className={c.dialogTitle} id={id}>
        {title}
      </h2>
      <button type="button" className={c.close} aria-label="关闭" onClick={onClose}>
        <Icon name="close" />
      </button>
    </div>
  );
}

export interface ConfirmSpec {
  title: string;
  body: ReactNode;
  action: string;
  danger?: boolean;
  run: () => Promise<unknown>;
}

/** Confirmation for destructive actions; stays open with the error when the action fails. */
export function ConfirmDialog({ spec, onClose }: { spec: ConfirmSpec; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = (): void => {
    setBusy(true);
    setError(null);
    spec.run().then(onClose, (e: unknown) => {
      setError(failText(e));
      setBusy(false);
    });
  };
  return (
    <Modal label={spec.title} onClose={() => !busy && onClose()}>
      <DialogHead title={spec.title} onClose={onClose} />
      <div className={c.dialogBody}>
        {typeof spec.body === 'string' ? <p>{spec.body}</p> : spec.body}
        {error && (
          <p role="alert" style={{ color: 'var(--bad)' }}>
            {error}
          </p>
        )}
      </div>
      <div className={c.dialogActions}>
        <button type="button" className={c.btn} onClick={onClose} disabled={busy}>
          取消
        </button>
        <button type="button" className={spec.danger ? c.btnDanger : c.btnPrimary} onClick={go} disabled={busy} autoFocus>
          {busy ? '请稍候…' : spec.action}
        </button>
      </div>
    </Modal>
  );
}

export function PromptDialog({
  title,
  label,
  initial,
  action,
  onSubmit,
  onClose,
}: {
  title: string;
  label: string;
  initial: string;
  action: string;
  onSubmit: (value: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal label={title} onClose={() => !busy && onClose()}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!value.trim() || busy) return;
          setBusy(true);
          setError(null);
          onSubmit(value.trim()).then(onClose, (err: unknown) => {
            setError(failText(err));
            setBusy(false);
          });
        }}
      >
        <DialogHead title={title} onClose={onClose} />
        <div className={c.dialogBody}>
          <label style={{ display: 'grid', gap: 6, fontSize: 12 }}>
            {label}
            <input className={c.miniSearch} style={{ width: '100%', minHeight: 36, fontSize: 13 }} value={value} maxLength={80} autoFocus onChange={(e) => setValue(e.target.value)} />
          </label>
          {error && (
            <p role="alert" style={{ color: 'var(--bad)', marginTop: 8 }}>
              {error}
            </p>
          )}
        </div>
        <div className={c.dialogActions}>
          <button type="button" className={c.btn} onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="submit" className={c.btnPrimary} disabled={busy || !value.trim()}>
            {action}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ─── popup menu: outside click / Esc close, arrow keys move focus ─────
export function useMenu(): {
  open: boolean;
  toggle: () => void;
  close: () => void;
  wrapRef: React.RefObject<HTMLDivElement | null>;
  onKeyDown: (e: React.KeyboardEvent) => void;
} {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    // focus the first item so keyboard users land inside the menu
    requestAnimationFrame(() => wrapRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus());
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (!open) return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      setOpen(false);
      wrapRef.current?.querySelector<HTMLElement>('[aria-haspopup]')?.focus();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...(wrapRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  };
  return { open, toggle: () => setOpen((o) => !o), close: () => setOpen(false), wrapRef, onKeyDown };
}
