import { z } from 'zod';

export const SETTINGS_PAGES = ['home', 'connections', 'network', 'agents', 'security', 'account', 'advanced'] as const;
export type SettingsPage = (typeof SETTINGS_PAGES)[number];
export const SETTINGS_LABELS: Readonly<Record<SettingsPage, string>> = {
  home: '首页', connections: '连接与渠道', network: '直连', agents: 'Agent 与工具',
  security: '安全', account: '账号与订阅', advanced: '高级',
};
export const CONNECTION_SECTION_ORDER = ['current', 'channels', 'default', 'connector'] as const;

/** Inline SVG primitives shared by the Web and VS Code settings renderers. */
export type SettingsIconName =
  | 'circle' | 'globe' | 'refresh' | 'todo' | 'shield' | 'card' | 'gear'
  | 'sidebar' | 'logout' | 'menu' | 'close' | 'phone-scan';
export type SettingsIconShape =
  | { readonly tag: 'path'; readonly d: string }
  | { readonly tag: 'circle'; readonly cx: number; readonly cy: number; readonly r: number }
  | { readonly tag: 'rect'; readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly rx?: number };

export const SETTINGS_ICON_SHAPES = {
  circle: [{ tag: 'circle', cx: 12, cy: 12, r: 8 }],
  globe: [{ tag: 'path', d: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3Z' }],
  refresh: [{ tag: 'path', d: 'M20 11a8 8 0 0 0-14.9-3M4 5v3h3M4 13a8 8 0 0 0 14.9 3M20 19v-3h-3' }],
  todo: [{ tag: 'path', d: 'M9 11l3 3 8-8M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9' }],
  shield: [{ tag: 'path', d: 'M12 3 5 6v5c0 4.5 3 8.3 7 9.5 4-1.2 7-5 7-9.5V6Z' }],
  card: [{ tag: 'path', d: 'M3 6h18v12H3zM3 10h18M7 15h4' }],
  gear: [{ tag: 'path', d: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 13.5l1.6 1.2-2 3.4-1.9-.7a7 7 0 0 1-2.2 1.3l-.3 2h-4l-.3-2a7 7 0 0 1-2.2-1.3l-1.9.7-2-3.4 1.6-1.2a7 7 0 0 1 0-3l-1.6-1.2 2-3.4 1.9.7a7 7 0 0 1 2.2-1.3l.3-2h4l.3 2a7 7 0 0 1 2.2 1.3l1.9-.7 2 3.4-1.6 1.2a7 7 0 0 1 0 3Z' }],
  sidebar: [{ tag: 'path', d: 'M4 5h16v14H4zM9 5v14' }],
  logout: [{ tag: 'path', d: 'M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l-4-4 4-4M6 12h10' }],
  menu: [{ tag: 'path', d: 'M4 7h16M4 12h16M4 17h16' }],
  close: [{ tag: 'path', d: 'M6 6l12 12M18 6 6 18' }],
  'phone-scan': [
    { tag: 'rect', x: 7, y: 2.8, width: 10, height: 18.4, rx: 2 },
    { tag: 'path', d: 'M10 5.8h4M11 18h2' },
    { tag: 'path', d: 'M2.8 8V4.8a2 2 0 0 1 2-2H8M16 2.8h3.2a2 2 0 0 1 2 2V8M21.2 16v3.2a2 2 0 0 1-2 2H16M8 21.2H4.8a2 2 0 0 1-2-2V16' },
  ],
} as const satisfies Readonly<Record<SettingsIconName, readonly SettingsIconShape[]>>;

export const SETTINGS_PAGE_ICONS: Readonly<Record<SettingsPage, SettingsIconName>> = {
  home: 'circle', connections: 'globe', network: 'refresh', agents: 'todo',
  security: 'shield', account: 'card', advanced: 'gear',
};

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char] ?? char));

export function renderSettingsIcon(name: SettingsIconName, size = 16, className?: string, strokeWidth = 1.8): string {
  const safeSize = Number.isFinite(size) ? Math.max(1, Math.min(64, Math.round(size))) : 16;
  const safeStrokeWidth = Number.isFinite(strokeWidth) ? Math.max(0.5, Math.min(4, strokeWidth)) : 1.8;
  const classAttr = className ? ` class="${escapeHtml(className)}"` : '';
  const children = SETTINGS_ICON_SHAPES[name].map((shape) => {
    if (shape.tag === 'path') return `<path d="${escapeHtml(shape.d)}"/>`;
    if (shape.tag === 'circle') return `<circle cx="${shape.cx}" cy="${shape.cy}" r="${shape.r}"/>`;
    return `<rect x="${shape.x}" y="${shape.y}" width="${shape.width}" height="${shape.height}"${shape.rx === undefined ? '' : ` rx="${shape.rx}"`}/>`;
  }).join('');
  return `<svg${classAttr} width="${safeSize}" height="${safeSize}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${safeStrokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${children}</svg>`;
}

export function renderSettingsNavItems(options: {
  page: SettingsPage;
  collapsed?: boolean;
  buttonClassName: string;
  iconClassName: string;
  labelClassName: string;
  itemClassName?: string;
}): string {
  const { page, collapsed = false, buttonClassName, iconClassName, labelClassName, itemClassName } = options;
  return SETTINGS_PAGES.map((id) => {
    const label = SETTINGS_LABELS[id];
    const current = page === id ? ' aria-current="page"' : '';
    const title = collapsed ? ` title="${escapeHtml(label)}"` : '';
    const itemClass = itemClassName ? ` class="${escapeHtml(itemClassName)}"` : '';
    return `<li${itemClass}><button type="button" class="${escapeHtml(buttonClassName)}" data-settings-target="${id}" aria-label="${escapeHtml(label)}"${title}${current}><span class="${escapeHtml(iconClassName)}">${renderSettingsIcon(SETTINGS_PAGE_ICONS[id], 17)}</span><span class="${escapeHtml(labelClassName)}">${escapeHtml(label)}</span></button></li>`;
  }).join('');
}

export const SettingsPageSchema = z.enum(SETTINGS_PAGES);
export const SettingsRouteSchema = z.object({
  page: SettingsPageSchema,
  section: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/).optional(),
  field: z.string().min(1).max(64).regex(/^[A-Za-z0-9_.-]+$/).optional(),
}).strict();
export type SettingsRoute = z.infer<typeof SettingsRouteSchema>;

const LEGACY: Readonly<Record<string, SettingsRoute>> = {
  overview: { page: 'home' },
  channel: { page: 'connections', section: 'channels' },
  mcp: { page: 'connections', section: 'mcp' },
  common: { page: 'agents', section: 'skills' },
  proxies: { page: 'agents', section: 'proxies' },
  grants: { page: 'security' },
  devices: { page: 'security', section: 'devices' },
  account: { page: 'account' },
  advanced: { page: 'advanced' },
};

export function normalizeSettingsRoute(input: unknown): SettingsRoute {
  const parsed = SettingsRouteSchema.safeParse(input);
  return parsed.success ? parsed.data : { page: 'home' };
}

export function settingsRouteFromLegacy(value: string | null | undefined): SettingsRoute {
  if (!value) return { page: 'home' };
  if ((SETTINGS_PAGES as readonly string[]).includes(value)) return { page: value as SettingsPage };
  return LEGACY[value] ?? { page: 'home' };
}
