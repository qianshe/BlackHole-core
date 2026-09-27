import { authSleep, CloudAuthError, type AuthErrorCode, type AuthView, type CloudAuthClient, type Credential } from './cloudAuthClient';

/** Subset of ControlApi used by the daemon-backed account (plan 6.11). */
export interface AccountApi {
  account(): Promise<AuthView & { storage?: string }>;
  accountSignIn(): Promise<{ state: string }>;
  accountSignInState(): Promise<{ state: string; error?: string }>;
  accountSignInCancel(): Promise<{ state: string }>;
  accountCall(method: string, args: unknown[]): Promise<{ result: unknown }>;
  accountMigrate(credential: Credential): Promise<{ migrated: boolean; reason?: string }>;
}

const KNOWN: ReadonlySet<string> = new Set<AuthErrorCode>(['cancelled', 'busy', 'not_available', 'rate_limited', 'rejected', 'network', 'invalid_response', 'storage', 'browser_failed', 'expired',
  'card_unavailable', 'card_result_unknown', 'payment_not_available', 'payment_result_unknown', 'payment_card_unavailable', 'payment_review_required',
  'refund_not_available', 'refund_not_eligible', 'refund_result_unknown', 'refund_quote_changed']);

/** Maps a daemon error to the same fixed codes the UI already knows, so messages stay identical. */
export function toAuthError(e: unknown): CloudAuthError {
  if (e instanceof CloudAuthError) return e;
  const code = e instanceof Error ? e.message : '';
  if (KNOWN.has(code)) return new CloudAuthError(code as AuthErrorCode);
  if (code === 'storage_unavailable') return new CloudAuthError('storage');
  const status = (e as { status?: number })?.status;
  return new CloudAuthError(status === undefined ? 'network' : 'not_available');
}

/**
 * Same surface as CloudAuthClient, but the daemon owns the credential. Only
 * methods cloudAccount.ts/cloudBilling.ts use are provided; the entitlement
 * bridge is not used in this mode because the daemon proves entitlement itself.
 */
export class DaemonAuthClient {
  readonly daemonBacked = true;
  constructor(private readonly api: AccountApi) {}

  private async call<T>(method: string, ...args: unknown[]): Promise<T> {
    try {
      return (await this.api.accountCall(method, args)).result as T;
    } catch (e) {
      throw toAuthError(e);
    }
  }

  view(): Promise<AuthView> { return this.call('view'); }
  check(_signal?: AbortSignal): Promise<AuthView> { return this.call('check'); }
  restore(_signal?: AbortSignal): Promise<AuthView> { return this.call('restore'); }
  signOut(): Promise<AuthView> { return this.call('signOut'); }
  redeemCard(code: string, expectedUserId: string) { return this.call<Awaited<ReturnType<CloudAuthClient['redeemCard']>>>('redeemCard', code, expectedUserId); }
  billingPlans(u: string) { return this.call<Awaited<ReturnType<CloudAuthClient['billingPlans']>>>('billingPlans', u); }
  billingOrders(u: string) { return this.call<Awaited<ReturnType<CloudAuthClient['billingOrders']>>>('billingOrders', u); }
  billingRefundableOrders(u: string, cursor?: string) { return this.call<Awaited<ReturnType<CloudAuthClient['billingRefundableOrders']>>>('billingRefundableOrders', u, cursor ?? null); }
  createBillingOrder(u: string, sku: string, key: string, _signal?: AbortSignal) { return this.call<Awaited<ReturnType<CloudAuthClient['createBillingOrder']>>>('createBillingOrder', u, sku, key); }
  billingOrder(u: string, id: string) { return this.call<Awaited<ReturnType<CloudAuthClient['billingOrder']>>>('billingOrder', u, id); }
  reconcileBillingOrder(u: string, id: string, _signal?: AbortSignal) { return this.call<Awaited<ReturnType<CloudAuthClient['reconcileBillingOrder']>>>('reconcileBillingOrder', u, id); }
  billingCheckoutLink(u: string, id: string) { return this.call<Awaited<ReturnType<CloudAuthClient['billingCheckoutLink']>>>('billingCheckoutLink', u, id); }
  billingRefundQuote(u: string, id: string) { return this.call<Awaited<ReturnType<CloudAuthClient['billingRefundQuote']>>>('billingRefundQuote', u, id); }
  refundBillingOrder(u: string, id: string, key: string, quote: string) { return this.call<Awaited<ReturnType<CloudAuthClient['refundBillingOrder']>>>('refundBillingOrder', u, id, key, quote); }

  /** The daemon opens the system browser and polls the cloud; this window only waits and can cancel. */
  async signIn(signal?: AbortSignal): Promise<AuthView> {
    try {
      await this.api.accountSignIn();
    } catch (e) {
      throw toAuthError(e);
    }
    const cancel = () => { void this.api.accountSignInCancel().catch(() => undefined); };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      for (;;) {
        await authSleep(1000, signal);
        let st: { state: string; error?: string };
        try {
          st = await this.api.accountSignInState();
        } catch (e) {
          throw toAuthError(e);
        }
        if (st.state === 'done') return this.view();
        if (st.state === 'failed') throw toAuthError(new Error(st.error ?? 'invalid_response'));
        if (st.state !== 'running') throw new CloudAuthError('cancelled');
      }
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
  }
}
