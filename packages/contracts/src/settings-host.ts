/** Host bridge surface for the shared settings renderer. No arbitrary URLs or commands. */
export interface SettingsRequest { id: string; method: string; path: string; body?: unknown }
export interface SettingsReply { id: string; ok: boolean; value?: unknown; error?: { status: number; code: string; detail?: string } }
export interface SettingsHostInfo { kind: 'vscode'; version: string; environment: 'test' | 'production'; cloudOrigin: string; port: number; pollIntervalMs: number; daemonEntry?: string }

const nativeRoutes: ReadonlyArray<readonly [string, RegExp]> = [
  ['GET', /^\/(health|settings|semantic|tunnel|channel|approvals|proxies|account|remote)$/],
  ['PATCH', /^\/settings$/],
  ['POST', /^\/semantic\/(key|clear)$/],
  ['POST', /^\/tunnel\/(start|stop)$/],
  ['POST', /^\/(channel|token\/rotate)$/],
  ['POST', /^\/approvals\/(clear|session\/remove|[^/]+\/remove)$/],
  ['POST', /^\/proxies\/(revalidate|config\/fields|add|import|tools|remove)$/],
  ['GET', /^\/openai-tunnel(?:\/diagnostics)?$/],
  ['POST', /^\/openai-tunnel\/(start|stop)$/],
  ['PUT', /^\/openai-tunnel\/credential$/], ['DELETE', /^\/openai-tunnel\/credential$/],
  ['POST', /^\/remote\/(probe|pair|revoke-all|requests\/[^/]+|devices\/[^/]+\/revoke)$/],
  ['GET', /^\/settings\/skills$/], ['POST', /^\/settings\/probe$/],
];
const hostRoutes: ReadonlyArray<readonly [string, RegExp]> = [
  ['GET', /^\/host\/info$/], ['PATCH', /^\/host\/settings$/],
  ['POST', /^\/host\/(clipboard|external|close|sign-in|sign-out)$/],
  ['POST', /^\/daemon\/(restart|stop)$/],
  ['GET', /^\/(cloudflared|openai-tunnel)\/install$/], ['POST', /^\/(cloudflared|openai-tunnel)\/install$/],
  ['GET', /^\/account\/(plans|orders|refundable)$/],
  ['POST', /^\/account\/(refresh|orders|redeem)$/],
  ['POST', /^\/account\/orders\/[^/]+\/(checkout|reconcile|refund-quote|refund)$/],
];
export function nativeSettingsPath(method: string, path: string): string | null {
  const raw = path.startsWith('/panel/') ? path.slice(6) : path;
  const pathname = raw.split('?')[0]!;
  return nativeRoutes.some(([m, re]) => m === method && re.test(pathname)) ? raw : null;
}
export function validSettingsRequest(input: unknown): input is SettingsRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const r = input as Record<string, unknown>;
  if (Object.keys(r).some(k => !['id', 'method', 'path', 'body'].includes(k))) return false;
  if (typeof r.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(r.id) || typeof r.method !== 'string' || typeof r.path !== 'string') return false;
  if (r.path.length > 2048 || !r.path.startsWith('/') || r.path.startsWith('//') || /[\\#\r\n]/.test(r.path)) return false;
  const [head, query, extra] = r.path.split('?');
  if (!head || extra !== undefined || /\s|%(?:2e|2f|5c|25)/i.test(head) || /(?:^|\/)\.{1,2}(?:\/|$)/.test(head)) return false;
  try {
    if (JSON.stringify(r.body ?? {}).length > 65536) return false;
    if (query !== undefined) {
      const key = head === '/settings/skills' ? 'dir' : head === '/account/refundable' ? 'cursor' : null;
      if (r.method !== 'GET' || !key || query.includes('&') || decodeURIComponent(query.split('=')[0]!) !== key) return false;
      decodeURIComponent(query);
    }
  } catch { return false; }
  if (r.body !== undefined && (r.body === null || typeof r.body !== 'object' || Array.isArray(r.body))) return false;
  if (r.method === 'GET' && r.body !== undefined) return false;
  return !!nativeSettingsPath(r.method, r.path) || hostRoutes.some(([m, re]) => m === r.method && re.test(head));
}
