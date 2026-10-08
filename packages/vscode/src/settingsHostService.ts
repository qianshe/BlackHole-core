import { createHash, randomUUID } from 'node:crypto';
import { nativeSettingsPath, validSettingsRequest, type SettingsRequest, type SettingsHostInfo } from '../../contracts/src/settings-host';
import type { ControlApi } from './controlApi';

export interface SettingsHostServices {
  api: ControlApi;
  info(): SettingsHostInfo;
  saveLocal(values: Record<string, unknown>, expected: Record<string, unknown>): Promise<void>;
  sync(): Promise<void>;
  restart(): Promise<boolean>;
  stop(): Promise<void>;
  copy(text: string): Promise<void>;
  open(url: string): Promise<boolean>;
  signIn(): Promise<unknown>;
  signOut(): Promise<unknown>;
  close(): void;
}
type Job = { state: 'idle' | 'running' | 'done' | 'error'; path?: string; installed?: boolean; version?: string; error?: string; started_at?: string; finished_at?: string };
const problem = (code: string, status = 400): Error => Object.assign(new Error(code), { status });
const str = (value: unknown, max = 2048): string => {
  if (typeof value !== 'string' || !value.length || value.length > max) throw problem('invalid_input');
  return value;
};

/** All native side effects are behind an explicit settings route. No page HTML lives here. */
export class SettingsHostService {
  private disposed = false;
  private localWrites: Promise<unknown> = Promise.resolve();
  private readonly jobs: Record<'cloudflared' | 'openai', Job> = { cloudflared: { state: 'idle' }, openai: { state: 'idle' } };
  private readonly duplicate = new Map<string, { signature: string; result: Promise<unknown> }>();
  constructor(private readonly host: SettingsHostServices) {}
  dispose(): void { this.disposed = true; this.duplicate.clear(); }
  private live(): void { if (this.disposed) throw problem('settings_closed', 410); }
  request(request: SettingsRequest): Promise<unknown> {
    this.live();
    if (!validSettingsRequest(request)) return Promise.reject(problem('settings_route_denied', 403));
    const signature = createHash('sha256').update(JSON.stringify([request.method, request.path, request.body ?? null])).digest('hex');
    const previous = this.duplicate.get(request.id);
    if (previous) return previous.signature === signature ? previous.result : Promise.reject(problem('settings_request_id_reused', 409));
    if (this.duplicate.size >= 4096) return Promise.reject(problem('settings_request_limit', 429));
    const pending = this.run(request);
    this.duplicate.set(request.id, { signature, result: pending });
    // Retain write IDs for the pane lifetime; reads can be discarded after completion.
    if (request.method === 'GET') void pending.then(() => this.duplicate.delete(request.id), () => this.duplicate.delete(request.id));
    return pending;
  }
  private async run(r: SettingsRequest): Promise<unknown> {
    this.live();
    const h = this.host, b = (r.body ?? {}) as Record<string, unknown>;
    const u = new URL(r.path, 'http://settings.invalid'), p = u.pathname;
    if (p === '/host/info') return h.info();
    if (p === '/host/settings') {
      if (!b.values || !b.expected || typeof b.values !== 'object' || Array.isArray(b.values) || typeof b.expected !== 'object' || Array.isArray(b.expected) || Object.keys(b).some(k => k !== 'values' && k !== 'expected')) throw problem('invalid_host_setting');
      const save = async () => { this.live(); await h.saveLocal(b.values as Record<string, unknown>, b.expected as Record<string, unknown>); this.live(); return h.info(); };
      const result = this.localWrites.then(save, save);
      this.localWrites = result.then(() => undefined, () => undefined);
      return result;
    }
    if (p === '/host/clipboard') { await h.copy(str(b.text, 65500)); return { copied: true }; }
    if (p === '/host/external') {
      const url = new URL(str(b.url));
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw problem('invalid_url');
      return { opened: await h.open(url.href) };
    }
    if (p === '/host/close') { h.close(); return { ok: true }; }
    if (p === '/host/sign-in') { await h.signIn(); this.live(); return h.api.account(); }
    if (p === '/host/sign-out') { await h.signOut(); this.live(); return h.api.account(); }
    if (p === '/daemon/restart' || p === '/daemon/stop') {
      if (b.confirm !== true) throw problem('confirmation_required');
      if (p.endsWith('/restart')) {
        if (!await h.restart()) throw problem('daemon_restart_failed', 503);
        return { ok: true };
      }
      await h.stop(); return { ok: true };
    }
    if (p === '/cloudflared/install' || p === '/openai-tunnel/install') {
      const runtime = p.startsWith('/cloudflared') ? 'cloudflared' : 'openai';
      if (r.method === 'POST' && this.jobs[runtime].state !== 'running') {
        // Reserve before await so simultaneous clicks cannot start two installations.
        this.jobs[runtime] = { state: 'running', started_at: new Date().toISOString() };
        void (async () => {
          try {
            const s = await h.api.settings(); this.live();
            if (runtime === 'cloudflared' && s.values.channelMode === 'custom') throw problem('custom_channel', 409);
            const key = runtime === 'cloudflared' ? 'cloudflaredPath' : 'openaiTunnelClientPath';
            const result = await h.api.installRuntime(runtime, String(s.values[key] ?? ''));
            this.jobs[runtime] = { state: 'done', ...result, finished_at: new Date().toISOString() };
          } catch (e) { this.jobs[runtime] = { state: 'error', error: e instanceof Error ? e.message : 'install_failed', finished_at: new Date().toISOString() }; }
        })();
      }
      return this.jobs[runtime];
    }
    if (nativeSettingsPath(r.method, r.path)) {
      const value = await h.api.settingsUiRequest(r.method, r.path, r.body);
      this.live();
      if (r.method === 'PATCH' && p === '/settings') await h.sync();
      return value;
    }
    // Billing identity comes from the daemon, never from the page's payload.
    const account = await h.api.account(); this.live();
    if (!account.userId) throw problem('account_required', 401);
    const uid = account.userId;
    const call = async (method: string, args: unknown[]): Promise<unknown> => {
      this.live(); return (await h.api.accountCall(method, args)).result;
    };
    const checkout = async (result: unknown) => {
      this.live();
      const row = result as { order: unknown; checkoutUrl: string };
      const url = new URL(row.checkoutUrl);
      if (url.protocol !== 'https:' || url.username || url.password) throw problem('checkout_url_rejected');
      return { order: row.order, opened: await h.open(url.href) };
    };
    if (p === '/account/refresh') { await call('check', []); return h.api.account(); }
    if (p === '/account/plans') return call('billingPlans', [uid]);
    if (p === '/account/orders' && r.method === 'GET') return call('billingOrders', [uid]);
    if (p === '/account/refundable') return call('billingRefundableOrders', u.searchParams.has('cursor') ? [uid, str(u.searchParams.get('cursor'), 200)] : [uid]);
    if (p === '/account/orders' && r.method === 'POST') return checkout(await call('createBillingOrder', [uid, str(b.sku, 64), randomUUID()]));
    if (p === '/account/redeem') return call('redeemCard', [str(b.code, 128), uid]);
    const order = /^\/account\/orders\/([^/]+)\/(checkout|reconcile|refund-quote|refund)$/.exec(p);
    if (order) {
      const id = str(decodeURIComponent(order[1]!), 100), action = order[2];
      if (action === 'checkout') return checkout(await call('billingCheckoutLink', [uid, id]));
      if (action === 'reconcile') return call('reconcileBillingOrder', [uid, id]);
      if (action === 'refund-quote') return call('billingRefundQuote', [uid, id]);
      return call('refundBillingOrder', [uid, id, randomUUID(), str(b.quoteToken, 1024)]);
    }
    throw problem('settings_route_denied', 403);
  }
}
