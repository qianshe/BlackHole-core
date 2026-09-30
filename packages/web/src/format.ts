// Pure helpers (no DOM, no React) so they run under `node --test` directly.

export interface SessionLike {
  name: string | null;
  workspace_path: string;
  status: string;
  id: string;
}

export interface CallLike {
  tool: string;
  status: string;
  result_summary: string | null;
  args: unknown;
}

export type StatusFilter = 'live' | 'all' | 'active' | 'paused' | 'ended';

export function baseName(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

export function sessionTitle(s: SessionLike): string {
  return s.name?.trim() || baseName(s.workspace_path);
}

export function matchSession(s: SessionLike, status: StatusFilter, query: string): boolean {
  const ended = s.status === 'revoked' || s.status === 'archived';
  if (status === 'live' && ended) return false;
  if (status === 'active' && s.status !== 'active') return false;
  if (status === 'paused' && s.status !== 'paused') return false;
  if (status === 'ended' && !ended) return false;
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [sessionTitle(s), s.workspace_path, s.id].some((v) => v.toLowerCase().includes(q));
}

export function matchCall(c: CallLike, tool: string, status: string, query: string): boolean {
  if (tool && c.tool !== tool) return false;
  if (status && c.status !== status) return false;
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [c.tool, c.result_summary ?? '', argsPreview(c.args, 10_000)].some((v) => v.toLowerCase().includes(q));
}

/** One-line preview of the most telling argument (command, path, query …). */
export function argsPreview(args: unknown, max = 140): string {
  let text: string;
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    const o = args as Record<string, unknown>;
    const key = ['command', 'path', 'query', 'pattern', 'url', 'action', 'operation'].find((k) => o[k] !== undefined);
    const v = key ? o[key] : o;
    text = typeof v === 'string' ? v : JSON.stringify(v);
  } else {
    text = typeof args === 'string' ? args : JSON.stringify(args ?? '');
  }
  text = (text ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** Absolute local time; today shows only the clock. */
export function formatTime(iso: string | null, now = Date.now()): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const d = new Date(t);
  const hms = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const today = new Date(now);
  const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  return sameDay ? hms : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hms}`;
}

/** Compact sidebar time: relative within a week, then "9月20日" (year only when different). */
export function shortTime(iso: string | null, now = Date.now()): string {
  const rel = relativeTime(iso, now);
  const t = Date.parse(iso ?? '');
  if (Number.isNaN(t) || now - t < 7 * 86_400_000) return rel;
  const d = new Date(t);
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  return d.getFullYear() === new Date(now).getFullYear() ? md : `${d.getFullYear()}年${md}`;
}

/** Default session: running first, then the most recently active live one, else the newest. */
export function pickDefaultSession<S extends SessionLike & { activity?: string | null; last_active_at: string | null; created_at: string | null }>(list: S[]): S | undefined {
  const stamp = (x: S): number => Date.parse(x.last_active_at ?? x.created_at ?? '') || 0;
  const live = list.filter((x) => x.status === 'active' || x.status === 'paused');
  const pool = live.length ? live : list;
  return [...pool].sort((a, b) => Number(b.activity === 'running') - Number(a.activity === 'running') || stamp(b) - stamp(a))[0];
}

/** Full timestamp for tooltips. */
export function formatFull(iso: string | null): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** "刚刚 / 3 分钟前 / 2 小时前 / 5 天前"; older than a week falls back to the date. */
export function relativeTime(iso: string | null, now = Date.now()): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const s = Math.round((now - t) / 1000);
  if (s < 10) return '刚刚';
  if (s < 60) return `${s} 秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} 天前`;
  return formatTime(iso, now);
}

export function percent(done: number, total: number): number {
  return total > 0 ? Math.round((done / total) * 100) : 0;
}

export type Tone = 'ok' | 'warn' | 'bad' | 'run' | 'muted';

export function sessionTone(status: string, running: boolean): Tone {
  if (running) return 'run';
  if (status === 'active') return 'ok';
  if (status === 'paused') return 'warn';
  return 'muted';
}

export function callTone(status: string): Tone {
  switch (status) {
    case 'completed':
      return 'ok';
    case 'awaiting':
      return 'warn';
    case 'failed':
    case 'denied':
      return 'bad';
    case 'started':
      return 'run';
    default:
      return 'muted';
  }
}

export function countByFilter<T extends SessionLike>(list: T[]): Record<StatusFilter, number> {
  const out: Record<StatusFilter, number> = { live: 0, active: 0, paused: 0, ended: 0, all: list.length };
  for (const s of list) {
    const ended = s.status === 'revoked' || s.status === 'archived';
    if (!ended) out.live++;
    if (s.status === 'active') out.active++;
    if (s.status === 'paused') out.paused++;
    if (ended) out.ended++;
  }
  return out;
}

export type ConsoleView = 'session' | 'channels';

export interface ViewState {
  /** selected session id */
  session: string | null;
  view: ConsoleView;
  /** open settings section, or null when the settings dialog is closed */
  settings: string | null;
}

// Same order as the VS Code settings page (phone access lives in the channel card and 高级).
export const SETTINGS_SECTIONS = ['overview', 'account', 'channel', 'mcp', 'proxies', 'common', 'grants', 'advanced'] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** View state lives in the query string (the fragment is reserved for the one-time ticket). */
export function readViewState(search: string): ViewState {
  const q = new URLSearchParams(search);
  const set = q.get('set');
  return {
    session: q.get('s') || null,
    view: q.get('v') === 'channels' ? 'channels' : 'session',
    settings: set && (SETTINGS_SECTIONS as readonly string[]).includes(set) ? set : null,
  };
}

export function writeViewState(v: ViewState): string {
  const q = new URLSearchParams();
  if (v.session) q.set('s', v.session);
  if (v.view === 'channels') q.set('v', 'channels');
  if (v.settings) q.set('set', v.settings);
  const s = q.toString();
  return s ? `?${s}` : '';
}

const norm = (p: string): string => p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();

/** true when `path` is `root` or inside it (case-insensitive, either slash). */
export function underPath(path: string, root: string): boolean {
  const a = norm(path);
  const b = norm(root);
  return a === b || a.startsWith(b + '/');
}

export interface ProjectLike { id: string; path: string; label: string; pinned: boolean }
export interface ProjectGroup<P, S> { project: P; sessions: S[] }

/**
 * Sidebar grouping: every live (active/paused) session sits under the deepest
 * project containing it; ended sessions go to "recent", newest first.
 * Pinned projects first, then by the latest activity inside them.
 */
export function groupSessions<P extends ProjectLike, S extends SessionLike & { last_active_at: string | null; created_at: string | null }>(
  projects: P[],
  sessions: S[],
  recentLimit = 6,
): { groups: ProjectGroup<P, S>[]; recent: S[]; loose: S[] } {
  const stamp = (x: S): number => Date.parse(x.last_active_at ?? x.created_at ?? '') || 0;
  const byDepth = [...projects].sort((a, b) => norm(b.path).length - norm(a.path).length);
  const groups = new Map<string, ProjectGroup<P, S>>(projects.map((p) => [p.id, { project: p, sessions: [] }]));
  const loose: S[] = [];
  const recent: S[] = [];
  for (const x of [...sessions].sort((a, b) => stamp(b) - stamp(a))) {
    if (x.status === 'revoked' || x.status === 'archived') {
      recent.push(x);
      continue;
    }
    const home = byDepth.find((p) => underPath(x.workspace_path, p.path));
    if (home) groups.get(home.id)!.sessions.push(x);
    else loose.push(x);
  }
  const latest = (g: ProjectGroup<P, S>): number => (g.sessions[0] ? stamp(g.sessions[0]) : 0);
  const ordered = [...groups.values()].sort((a, b) => Number(b.project.pinned) - Number(a.project.pinned) || latest(b) - latest(a) || a.project.label.localeCompare(b.project.label));
  return { groups: ordered, recent: recent.slice(0, recentLimit), loose };
}

/** Last `n` path segments, for the session header breadcrumb. */
export function pathCrumbs(path: string, n = 3): string[] {
  return path.split(/[\\/]+/).filter((x) => x && !/^[a-z]:$/i.test(x)).slice(-n);
}

/** Duration text for a finished call; null while it is still open. */
export function callDuration(c: { status: string; created_at: string | null; updated_at: string | null }): string | null {
  if (c.status === 'started' || c.status === 'awaiting') return null;
  const a = Date.parse(c.created_at ?? '');
  const b = Date.parse(c.updated_at ?? '');
  if (!a || !b || b < a) return null;
  const ms = b - a;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

export interface SearchHit { kind: 'session' | 'project'; id: string; title: string; detail: string; score: number }

/** Search palette: sessions by name/path/id, projects by label/path. Empty query lists live sessions. */
export function searchAll(
  query: string,
  sessions: (SessionLike & { last_active_at?: string | null })[],
  projects: ProjectLike[],
  limit = 12,
): SearchHit[] {
  const q = query.trim().toLowerCase();
  const hits: SearchHit[] = [];
  const rank = (fields: string[]): number => {
    if (!q) return 1;
    let best = 0;
    for (const f of fields) {
      const v = f.toLowerCase();
      if (v === q) best = Math.max(best, 4);
      else if (v.startsWith(q)) best = Math.max(best, 3);
      else if (v.includes(q)) best = Math.max(best, 2);
    }
    return best;
  };
  for (const x of sessions) {
    if (!q && (x.status === 'revoked' || x.status === 'archived')) continue;
    const score = rank([sessionTitle(x), x.workspace_path, x.id]);
    if (score) hits.push({ kind: 'session', id: x.id, title: sessionTitle(x), detail: x.workspace_path, score: score + 0.5 });
  }
  if (q) for (const p of projects) {
    const score = rank([p.label, p.path]);
    if (score) hits.push({ kind: 'project', id: p.id, title: p.label, detail: p.path, score });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

const ERROR_TEXT: Record<string, string> = {
  csrf_rejected: '页面已过期，请刷新后重试。',
  origin_rejected: '请求被拒绝，请刷新页面后重试。',
  unauthenticated: '登录已过期，请重新打开 BlackHole。',
  project_exists: '这个文件夹已经在项目列表里。',
  too_many_projects: '项目数量已达上限，请先移除一些。',
  project_not_found: '项目不存在，可能已被移除。',
  revision_conflict: '设置刚在别处被修改过，请刷新后重试。',
  settings_unavailable: '这个版本的 BlackHole 还不支持在网页里修改设置。',
  body_too_large: '内容太长。',
  network: '连不上 BlackHole，请确认它正在运行。',
};

/** User-facing text for an API failure: known code first, then the server's message. */
export function errorText(code: string, message?: string): string {
  return ERROR_TEXT[code] ?? (message ? message : `操作失败（${code}）`);
}

export const PERMISSION_LABEL: Record<string, string> = {
  'read-only': '只读',
  'workspace-write': '工作区可写',
  'danger-full-access': '完全访问',
};

export const SESSION_STATUS_LABEL: Record<string, string> = {
  active: '活动',
  paused: '已暂停',
  revoked: '已撤销',
  archived: '已归档',
};

export const CALL_STATUS_LABEL: Record<string, string> = {
  started: '执行中',
  awaiting: '待审批',
  completed: '完成',
  failed: '失败',
  denied: '已拒绝',
  unknown: '未知',
};

export const TODO_STATUS_LABEL: Record<string, string> = {
  pending: '待办',
  in_progress: '进行中',
  completed: '完成',
};

/**
 * The launcher opens `/ui/#<ticket>`: a bare base64url fragment survives any URI
 * re-encoding and never reaches the server. Anything else is ignored.
 */
export function takeTicket(hash: string): string | null {
  const value = hash.replace(/^#/, '');
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}



// ── call result presentation, same rules as packages/vscode/src/callFormat.ts ──
const CSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;?]*[ -/]*[@-~]', 'g');
const stripAnsi = (text: string): string => text.replace(CSI, '');

/** +added / -removed for editor writes, else null (same payload shape VS Code reads). */
export function resultDiff(summary: string | null): { added: number; removed: number } | null {
  if (!summary) return null;
  try {
    const d = (JSON.parse(summary) as { result?: { diff?: { added?: unknown; removed?: unknown } } }).result?.diff;
    if (!d || typeof d.added !== 'number' || typeof d.removed !== 'number') return null;
    return d.added > 0 || d.removed > 0 ? { added: d.added, removed: d.removed } : null;
  } catch {
    return null;
  }
}

/** Readable result text for the expanded row (never raw JSON when a message exists). */
export function resultBody(summary: string | null): string {
  if (!summary) return '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(summary);
  } catch {
    return stripAnsi(summary);
  }
  const t = parsed as { truncated?: boolean; preview?: string };
  if (t && t.truncated && typeof t.preview === 'string') return stripAnsi(t.preview) + '\n\n…… 结果已截断（存证上限 32KB），完整输出已交付 AI。';
  const r = parsed as { result?: { message?: string }; stdout?: string; stderr?: string };
  if (r && r.result && typeof r.result.message === 'string') return stripAnsi(r.result.message);
  if (r && (typeof r.stdout === 'string' || typeof r.stderr === 'string')) {
    const out = [r.stdout ?? '', r.stderr ? `[stderr]\n${r.stderr}` : ''].filter(Boolean).join('\n');
    return stripAnsi(out) || '(无输出)';
  }
  if (parsed && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>;
    if (typeof o.reason === 'string') return stripAnsi(o.reason);
    if (typeof o.message === 'string') return stripAnsi(o.message);
    if (typeof o.status === 'string') {
      const parts = [o.status, typeof o.state === 'string' ? o.state : '', typeof o.processId === 'string' ? o.processId : '', typeof o.exitCode === 'number' ? `exit ${o.exitCode}` : ''].filter(Boolean);
      return stripAnsi(parts.join(' · '));
    }
  }
  return stripAnsi(summary);
}

const SHELL_TOOLS = new Set(['exec', 'pwsh', 'bash', 'cmd']);

/**
 * Split a call into the compact tool label ("editor create", "proxy call")
 * and its target, so the row reads left to right without a wide empty column.
 */
export function callHeadline(tool: string, args: unknown, summary: string): { label: string; target: string } {
  const a = args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
  const op = a.operation && typeof a.operation === 'object' && !Array.isArray(a.operation) ? (a.operation as Record<string, unknown>) : a;
  const raw = SHELL_TOOLS.has(tool) ? '' : typeof op.command === 'string' ? op.command : typeof a.command === 'string' ? a.command : '';
  const sub = /^[a-z][a-z_-]{0,19}$/i.test(raw) ? raw : '';
  let target = summary;
  if (sub && target.startsWith(sub + ' ')) target = target.slice(sub.length + 1);
  else if (sub === 'call' && target.startsWith('调用 ')) target = target.slice(3);
  return { label: sub ? `${tool} ${sub}` : tool, target };
}
