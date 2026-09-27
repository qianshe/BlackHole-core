export type SessionStatus = 'active' | 'paused' | 'revoked' | 'archived';
export type CallStatus = 'started' | 'awaiting' | 'completed' | 'failed' | 'denied' | 'unknown';

export interface SessionView {
  id: string;
  name: string | null;
  workspace_path: string;
  status: SessionStatus;
  activity: string | null;
  permission_mode: string;
  auto_approve: boolean;
  created_at: string | null;
  last_active_at: string | null;
  calls_total: number;
  todos_total: number;
  todos_done: number;
}

export interface CallView {
  id: string;
  seq: number;
  tool: string;
  status: CallStatus;
  args: unknown;
  result_summary: string | null;
  approval_scope: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface CallsPage {
  calls: CallView[];
  total: number;
  page: number;
  limit: number;
}

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

export interface TodoBoard {
  items: TodoItem[];
  contract: { goal: string; nonGoals?: string[]; successCriteria?: string[]; verification?: string[] } | null;
  updated_at: string | null;
}

export interface ProjectView {
  id: string;
  path: string;
  label: string;
  pinned: boolean;
  created_at: string;
  sessions: number;
  /** false: derived from existing sessions, not saved by the user */
  saved: boolean;
}

export interface DirListing {
  path: string | null;
  parent: string | null;
  dirs: { name: string; path: string }[];
  truncated: boolean;
  denied?: boolean;
}

export type PermissionMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface SettingsValues {
  connectorName: string;
  publicBaseUrl: string;
  cloudflaredPath: string;
  skillsDir: string;
  channelMode: 'cloudflare' | 'openai' | 'custom';
  semanticMode: 'off' | 'explicit' | 'auto';
  gitUsrBinPath: string;
  namedTunnelName: string;
  tunnelProbeProxy: string;
  webAgents: string[];
  customWebAgents: { name: string; url: string }[];
  remoteAccess: boolean;
  openaiTunnelClientPath: string;
  openaiTunnelId: string;
}

export interface SettingsView {
  revision: number;
  migrated: boolean;
  values: SettingsValues;
  updated_at: string | null;
  pending_restart: string[];
}

export interface NewSessionInput {
  workspace_path: string;
  permission_mode: PermissionMode;
  name?: string;
  auto_approve?: boolean;
}

export interface CreatedSession {
  session: SessionView;
  session_id: string;
  mcp_url: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail?: string,
  ) {
    super(code);
  }
}

const BASE = '/web-api/v1';
// Write token bound to the session cookie; kept in memory only.
let csrf = '';

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const write = init.method !== undefined && init.method !== 'GET';
  const res = await fetch(BASE + path, {
    ...init,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {
      'x-blackhole-web': '1',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(write && csrf ? { 'x-blackhole-csrf': csrf } : {}),
    },
  });
  const body = (await res.json().catch(() => ({}))) as { error?: unknown; message?: unknown; csrf?: unknown };
  if (!res.ok) throw new ApiError(res.status, typeof body.error === 'string' ? body.error : `http_${res.status}`, typeof body.message === 'string' ? body.message : undefined);
  if (typeof body.csrf === 'string') csrf = body.csrf;
  return body as T;
}

const json = (method: string, data: unknown): RequestInit => ({ method, body: JSON.stringify(data) });

export const api = {
  exchange: (ticket: string) => request<{ ok: true; expires_at: string }>('/auth/exchange', { method: 'POST', body: JSON.stringify({ ticket }) }),
  session: (signal?: AbortSignal) => request<{ authenticated: true; account_required?: boolean; expires_at: string; version: string }>('/auth/session', { signal }),
  /** Local browser: enter with this machine's signed-in account. */
  localLogin: () => request<{ ok: true; expires_at: string }>('/auth/local', json('POST', {})),
  /** Browser login with the machine's cloud account (no session needed). */
  login: () => request<{ attempt: string }>('/auth/login', json('POST', {})),
  loginPoll: (attempt: string) => request<{ state: 'running' | 'done' | 'failed'; error?: string }>('/auth/login/' + encodeURIComponent(attempt)),
  logout: () => request<{ ok: true }>('/auth/logout', { method: 'POST' }),
  sessions: (signal?: AbortSignal) => request<{ sessions: SessionView[]; version: string }>('/sessions', { signal }),
  calls: (id: string, page: number, limit: number, signal?: AbortSignal) =>
    request<CallsPage>(`/sessions/${encodeURIComponent(id)}/calls?page=${page}&limit=${limit}`, { signal }),
  todos: (id: string, signal?: AbortSignal) => request<TodoBoard>(`/sessions/${encodeURIComponent(id)}/todos`, { signal }),
  createSession: (input: NewSessionInput) => request<CreatedSession>('/sessions', json('POST', input)),
  dirs: (path: string, signal?: AbortSignal) => request<DirListing>(`/fs/dirs${path ? `?path=${encodeURIComponent(path)}` : ''}`, { signal }),
  projects: (signal?: AbortSignal) => request<{ projects: ProjectView[] }>('/projects', { signal }),
  addProject: (path: string, label?: string) => request<{ project: ProjectView }>('/projects', json('POST', { path, label })),
  updateProject: (id: string, patch: { label?: string; pinned?: boolean }) => request<{ project: ProjectView }>(`/projects/${encodeURIComponent(id)}`, json('PATCH', patch)),
  removeProject: (id: string) => request<{ ok: true }>(`/projects/${encodeURIComponent(id)}`, json('DELETE', {})),
  settings: (signal?: AbortSignal) => request<SettingsView>('/settings', { signal }),
  saveSettings: (revision: number, values: Partial<SettingsValues>) => request<SettingsView>('/settings', json('PATCH', { revision, values })),
  probePublicUrl: (url: string) => request<{ ok: boolean; detail: string }>('/settings/probe', json('POST', { url })),
  account: () => request<AccountView>('/account'),
  accountSignIn: () => request<AccountView['signIn']>('/account/sign-in', json('POST', {})),
  accountCancelSignIn: () => request<AccountView['signIn']>('/account/sign-in/cancel', json('POST', {})),
  accountSignOut: () => request<AccountView>('/account/sign-out', json('POST', {})),
  stopDaemon: () => request<{ ok: true }>('/daemon/stop', json('POST', { confirm: true })),
  // approvals and session header controls (plan 6.15)
  confirmations: (sessionId?: string, signal?: AbortSignal) =>
    request<{ confirmations: ConfirmationView[] }>(`/confirmations${sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : ''}`, { signal }),
  resolveConfirmation: (id: string, action: 'approve' | 'deny', scope?: ApprovalScope) =>
    request<{ id: string; status: string | null }>(`/confirmations/${encodeURIComponent(id)}/${action}`, json('POST', action === 'approve' ? { scope: scope ?? 'once' } : {})),
  sessionCredential: (id: string) => request<{ session_id: string; name: string | null }>(`/panel/sessions/${encodeURIComponent(id)}`),
  setSessionMode: (id: string, mode: PermissionMode) => request<unknown>(`/panel/sessions/${encodeURIComponent(id)}/mode`, json('PATCH', { permission_mode: mode })),
  sessionAction: (id: string, action: 'pause' | 'resume' | 'revoke' | 'rotate') => request<unknown>(`/panel/sessions/${encodeURIComponent(id)}/${action}`, json('POST', {})),
};

export type ApprovalScope = 'once' | 'session' | 'always';
export interface RiskMatch { label: string; level: 'critical' | 'warn' | 'info'; tone: 'red' | 'yellow' | 'blue'; range: [number, number] }
export interface ConfirmationView {
  id: string;
  session_id: string;
  tool: string;
  args: unknown;
  status: 'pending' | 'approved' | 'denied' | 'expired' | string;
  scope: string | null;
  /** approval card text; matches' ranges index into it */
  command: string | null;
  categories: string[];
  risk_matches: RiskMatch[] | null;
  created_at: string | null;
  expires_at: string | null;
}

export interface AccountView {
  state: 'logged_out' | 'saved' | 'verified' | 'unavailable';
  userId?: string;
  remainingSeconds?: number;
  account?: { name: string; email: string; status: string };
  storage: 'available' | 'unavailable';
  signIn: { state: 'idle' } | { state: 'running'; startedAt: number } | { state: 'done'; finishedAt: number } | { state: 'failed'; error: string; finishedAt: number };
}

// ─── settings panel (plan 6.12 S3–S5): same daemon actions as the VS Code panel ───
export interface Health {
  ok: boolean;
  version: string;
  daemon_id: string;
  tunnel: string;
  tunnel_mode: 'quick' | 'named' | null;
  tunnel_url: string | null;
  tunnel_reason: string | null;
  public_base_url: string | null;
  /** present when the daemon has the OpenAI tunnel manager (see src/tunnel/openai-manager.ts) */
  openai_tunnel_api_version?: number;
  openai_tunnel?: { status: string; reason: string | null; reason_code?: string | null; active_tunnel_id?: string | null; pending_restart?: boolean } | null;
  mcp_url: string;
  mcp_path: string;
  stats?: { total: number; diff_added: number; diff_removed: number } | null;
  activity_days?: { start: number; total: number; diff_added: number; diff_removed: number }[];
}
export interface SemanticInfo { registered: boolean; registered_source: string; registered_preview: string; would_resolve: boolean }
export interface GrantsInfo { always: string[]; sessions: { session_id: string; session_name: string | null; workspace_path: string | null; grants: string[] }[] }
export interface ProxyStatusRow { name: string; status: string; tools?: string[]; catalogCount?: number | null; missingTools?: string[]; reason?: string }
export interface ProxyConfigRow { name: string; transport?: string; url?: string; command?: string; args?: string[]; surface?: { expose?: string[]; [k: string]: unknown }; warnings?: string[]; [k: string]: unknown }
export interface ProxiesInfo { configured: boolean; daemonId?: string; surfaceGen?: number | null; status?: ProxyStatusRow[]; config?: ProxyConfigRow[]; disabled?: string[] }
export interface ProxyToolRow { name: string; upstreamTool?: string; description?: string; enabled?: boolean; conflictSources?: string[] }
export interface ProxyToolsResult { daemonId?: string; disabled?: boolean; cachedOnly?: boolean; tools?: ProxyToolRow[]; ageMs?: number | null; error?: string | null }
export interface RevalidateReport { servers?: { name: string; ok: boolean }[]; quarantined?: { name: string; reason: string }[]; warnings?: { name: string; reason: string }[] }
export type CloudflaredJob =
  | { state: 'idle' }
  | { state: 'running' }
  | { state: 'done'; path: string; installed: boolean }
  | { state: 'error'; error: string };
export type BillingSku = 'pro_day' | 'pro_week' | 'pro_month';
export interface BillingPlan { sku: BillingSku; amountMinor: number; currency: 'CNY'; durationSeconds: number }
export interface BillingOrder { id: string; sku: BillingSku; amountMinor: number; durationSeconds: number; status: 'payment_pending' | 'paid' | 'fulfilled' | 'expired' | 'review' | 'refunded'; environment: 'sandbox' | 'production'; createdAt: number; expiresAt: number }
export interface RefundQuote { orderId: string; amountMinor: number; unusedSeconds: number; refundableSeconds: number; existingStatus: string | null; quoteToken: string }
export interface RefundResult { refundId: string; orderId: string; amountMinor: number; status: 'requested' | 'provider_succeeded' | 'refunded' | 'provider_failed' | 'failed'; duplicate: boolean }

const enc = encodeURIComponent;
export const panel = {
  health: () => request<Health>('/panel/health'),
  semantic: () => request<SemanticInfo>('/panel/semantic'),
  semanticSave: (key: string) => request<{ saved: boolean }>('/panel/semantic/key', json('POST', { key })),
  semanticClear: () => request<{ removed: boolean }>('/panel/semantic/clear', json('POST', {})),
  tunnelStart: (mode: 'quick' | 'named') => request<{ status: string }>('/panel/tunnel/start', json('POST', { mode })),
  tunnelStop: () => request<{ status: string }>('/panel/tunnel/stop', json('POST', {})),
  rotateToken: () => request<{ mcp_url: string }>('/panel/token/rotate', json('POST', {})),
  grants: () => request<GrantsInfo>('/panel/approvals'),
  grantsClear: () => request<{ removed: number }>('/panel/approvals/clear', json('POST', {})),
  grantRemove: (key: string) => request<{ removed: number }>(`/panel/approvals/${enc(key)}/remove`, json('POST', {})),
  sessionGrantRemove: (sessionId: string, key: string) => request<{ removed: number }>('/panel/approvals/session/remove', json('POST', { session_id: sessionId, key })),
  proxies: () => request<ProxiesInfo>('/panel/proxies'),
  proxiesRevalidate: () => request<RevalidateReport>('/panel/proxies/revalidate', json('POST', {})),
  proxiesAdd: (server: Record<string, unknown>) => request<{ added: boolean; warning?: string }>('/panel/proxies/add', json('POST', server)),
  proxiesImport: (text: string) => request<{ imported: string[]; failed?: { name: string; error: string }[] }>('/panel/proxies/import', json('POST', { json: text })),
  proxiesEdit: (server: string, fields: Record<string, unknown>) => request<{ written: boolean }>('/panel/proxies/config/fields', json('POST', { server, fields })),
  proxiesTools: (server: string, refresh: boolean) => request<ProxyToolsResult>('/panel/proxies/tools', json('POST', { server, refresh })),
  proxiesRemove: (server: string) => request<{ removed: boolean }>('/panel/proxies/remove', json('POST', { server })),
  cloudflared: () => request<CloudflaredJob>('/cloudflared/install'),
  cloudflaredStart: () => request<CloudflaredJob>('/cloudflared/install', json('POST', {})),
  restart: () => request<{ ok: boolean }>('/daemon/restart', json('POST', { confirm: true })),
  skills: (dir: string) => request<{ cls: '' | 'ok' | 'bad'; hint: string }>(`/settings/skills?dir=${enc(dir)}`),
  accountRefresh: () => request<AccountView>('/account/refresh', json('POST', {})),
  plans: () => request<{ enabled: boolean; environment?: 'sandbox' | 'production'; plans: BillingPlan[] }>('/account/plans'),
  orders: () => request<BillingOrder[]>('/account/orders'),
  createOrder: (sku: BillingSku) => request<{ order: BillingOrder; opened: boolean }>('/account/orders', json('POST', { sku })),
  checkout: (id: string) => request<{ order: BillingOrder; opened: boolean }>(`/account/orders/${enc(id)}/checkout`, json('POST', {})),
  reconcile: (id: string) => request<BillingOrder>(`/account/orders/${enc(id)}/reconcile`, json('POST', {})),
  refundable: (cursor?: string) => request<{ orders: BillingOrder[]; nextCursor: string | null }>(`/account/refundable${cursor ? `?cursor=${enc(cursor)}` : ''}`),
  refundQuote: (id: string) => request<RefundQuote>(`/account/orders/${enc(id)}/refund-quote`, json('POST', {})),
  refund: (id: string, quoteToken: string) => request<RefundResult>(`/account/orders/${enc(id)}/refund`, json('POST', { quoteToken })),
  redeem: (code: string) => request<{ expiresAt: number; duplicate: boolean }>('/account/redeem', json('POST', { code })),
};

// ─── phone access (plan 6.13 R4) ─────────────────────────────────────────
export interface RemoteDevice { id: string; name: string; created_at: string; last_seen_at: string }
export interface RemotePairRequest { id: string; name: string; created_at: string; expires_at: string }
export interface RemoteView { enabled: boolean; available: boolean; reason: string | null; origin: string | null; kind: 'quick' | 'fixed' | null; devices: RemoteDevice[]; requests?: RemotePairRequest[] }
export const remoteAdmin = {
  view: () => request<RemoteView>('/remote'),
  pair: () => request<{ url: string; expires_at: string; kind: string }>('/remote/pair', json('POST', {})),
  revoke: (id: string) => request<RemoteView>(`/remote/devices/${encodeURIComponent(id)}/revoke`, json('POST', {})),
  revokeAll: () => request<RemoteView>('/remote/revoke-all', json('POST', {})),
  decide: (id: string, allow: boolean) => request<RemoteView>(`/remote/requests/${encodeURIComponent(id)}`, json('POST', { allow })),
};
