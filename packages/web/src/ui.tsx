import { useEffect, useRef, useState, type ReactNode } from 'react';
import { SETTINGS_ICON_SHAPES, type SettingsIconName, type SettingsIconShape } from '../../contracts/src/settings-navigation';
import type { Tone } from './format';
import s from './ui.module.css';

export type IconName =
  | 'refresh'
  | 'logout'
  | 'login'
  | 'search'
  | 'close'
  | 'chevron'
  | 'copy'
  | 'check'
  | 'alert'
  | 'folder'
  | 'list'
  | 'todo'
  | 'clock'
  | 'shield'
  | 'circle'
  | 'dot'
  | 'play'
  | 'x'
  | 'pause'
  | 'plus'
  | 'pin'
  | 'more'
  | 'gear'
  | 'globe'
  | 'sidebar'
  | 'card'
  | 'receipt'
  | 'edit'
  | 'trash'
  | 'link';

const PATHS: Record<IconName, ReactNode> = {
  refresh: <path d="M20 11a8 8 0 0 0-14.9-3M4 5v3h3M4 13a8 8 0 0 0 14.9 3M20 19v-3h-3" />,
  logout: <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l-4-4 4-4M6 12h10" />,
  login: <path d="M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3M14 16l4-4-4-4M18 12H8" />,
  search: <path d="m20 20-4.2-4.2M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14Z" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  chevron: <path d="m9 6 6 6-6 6" />,
  copy: <path d="M9 9h10v11H9zM5 15V4h10" />,
  check: <path d="m5 12 5 5 9-10" />,
  alert: <path d="M12 8v5M12 16.5v.5M10.3 3.9 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />,
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />,
  list: <path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" />,
  todo: <path d="M9 11l3 3 8-8M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9" />,
  clock: <path d="M12 7v5l3 2M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18Z" />,
  shield: <path d="M12 3 5 6v5c0 4.5 3 8.3 7 9.5 4-1.2 7-5 7-9.5V6Z" />,
  circle: <circle cx="12" cy="12" r="8" />,
  dot: <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />,
  play: <path d="M8 5.5v13l10-6.5Z" fill="currentColor" stroke="none" />,
  x: <path d="M7 7l10 10M17 7 7 17" />,
  pause: <path d="M9 6v12M15 6v12" />,
  plus: <path d="M12 5v14M5 12h14" />,
  pin: <path d="M9 4h6l-1 6 3 3H7l3-3-1-6ZM12 16v5" />,
  more: <path d="M5.5 12h.01M12 12h.01M18.5 12h.01" strokeWidth={3} />,
  gear: <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 13.5l1.6 1.2-2 3.4-1.9-.7a7 7 0 0 1-2.2 1.3l-.3 2h-4l-.3-2a7 7 0 0 1-2.2-1.3l-1.9.7-2-3.4 1.6-1.2a7 7 0 0 1 0-3l-1.6-1.2 2-3.4 1.9.7a7 7 0 0 1 2.2-1.3l.3-2h4l.3 2a7 7 0 0 1 2.2 1.3l1.9-.7 2 3.4-1.6 1.2a7 7 0 0 1 0 3Z" />,
  globe: <path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3Z" />,
  sidebar: <path d="M4 5h16v14H4zM9 5v14" />,
  card: <path d="M3 6h18v12H3zM3 10h18M7 15h4" />,
  receipt: <path d="M6 3h12v18l-3-2-3 2-3-2-3 2ZM9 8h6M9 12h6" />,
  edit: <path d="M4 20h4L19 9l-4-4L4 16ZM13 7l4 4" />,
  trash: <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />,
  link: <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />,
};

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}

function renderSettingsShape(shape: SettingsIconShape, key: number) {
  if (shape.tag === 'path') return <path key={key} d={shape.d} />;
  if (shape.tag === 'circle') return <circle key={key} cx={shape.cx} cy={shape.cy} r={shape.r} />;
  return <rect key={key} x={shape.x} y={shape.y} width={shape.width} height={shape.height} rx={shape.rx} />;
}

/** Settings-only glyphs are shared with the VS Code Webview's HTML renderer. */
export function SettingsIcon({ name, size = 16, strokeWidth = 1.8, className }: {
  name: SettingsIconName; size?: number; strokeWidth?: number; className?: string;
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {SETTINGS_ICON_SHAPES[name].map(renderSettingsShape)}
    </svg>
  );
}

/** Brand mark, same geometry as the VS Code activity-bar icon. */
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="2.8" fill="currentColor" />
      <ellipse cx="12" cy="12" rx="7.8" ry="2.9" transform="rotate(-18 12 12)" stroke="currentColor" strokeWidth="1.6" />
      <path fill="currentColor" d="M13.53 8.99L16.48 2.64 12.8 1.66 12.17 8.63Z" />
      <circle cx="4.8" cy="18.4" r="0.9" fill="currentColor" />
    </svg>
  );
}

/** Status pill: colour + text, never colour alone. */
export function Badge({ tone, children, pulse }: { tone: Tone; children: ReactNode; pulse?: boolean }) {
  return (
    <span className={`${s.badge} ${s[`tone_${tone}`]}`}>
      <span className={`${s.badgeDot} ${pulse ? s.pulse : ''}`} aria-hidden="true" />
      {children}
    </span>
  );
}

export function ProgressBar({ value, label }: { value: number; label: string }) {
  return (
    <span className={s.progress} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value} aria-label={label}>
      <span className={s.progressFill} style={{ width: `${value}%` }} />
    </span>
  );
}

export function IconButton({
  icon,
  label,
  onClick,
  spinning,
  disabled,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  spinning?: boolean;
  disabled?: boolean;
}) {
  return (
    <button type="button" className={s.iconButton} onClick={onClick} aria-label={label} title={label} disabled={disabled}>
      <Icon name={icon} className={spinning ? s.spin : undefined} />
    </button>
  );
}

export function Button({ children, onClick, disabled, icon }: { children: ReactNode; onClick: () => void; disabled?: boolean; icon?: IconName }) {
  return (
    <button type="button" className={s.button} onClick={onClick} disabled={disabled}>
      {icon && <Icon name={icon} size={14} />}
      {children}
    </button>
  );
}

export function CopyButton({ text, label = '复制' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = (): void => {
    void navigator.clipboard?.writeText(text).then(() => {
      setDone(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setDone(false), 1500);
    });
  };
  return (
    <button type="button" className={s.copy} onClick={copy} aria-label={done ? '已复制' : label} title={done ? '已复制' : label}>
      <Icon name={done ? 'check' : 'copy'} size={14} />
      <span>{done ? '已复制' : label}</span>
    </button>
  );
}

export function Skeleton({ rows = 3, height = 44 }: { rows?: number; height?: number }) {
  return (
    <div className={s.skeletonWrap} aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={s.skeleton} style={{ height }} />
      ))}
    </div>
  );
}

export function EmptyState({ icon, title, children }: { icon: IconName; title: string; children?: ReactNode }) {
  return (
    <div className={s.empty}>
      <span className={s.emptyIcon}>
        <Icon name={icon} size={22} />
      </span>
      <div className={s.emptyTitle}>{title}</div>
      {children && <div className={s.emptyText}>{children}</div>}
    </div>
  );
}

export function ErrorBanner({ children, onRetry }: { children: ReactNode; onRetry?: () => void }) {
  return (
    <div className={s.error} role="alert">
      <Icon name="alert" />
      <span className={s.errorText}>{children}</span>
      {onRetry && (
        <button type="button" className={s.linkButton} onClick={onRetry}>
          重试
        </button>
      )}
    </div>
  );
}

