import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { EntitlementGate } from '../cloud/entitlement-gate.js';
import type { MachineStateRepo } from '../storage/machineState.js';
import { CloudAuthClient, CloudAuthError, credentialKey, parseCredential, type AuthView } from './cloud-auth-client.js';
import { fileReceiptPort } from './receipts.js';
import type { SecretBackend } from './secret-store.js';

/** Bumped when the /api/account contract changes; the extension picks its backend from it. */
export const ACCOUNT_API_VERSION = 1;

/** Methods a local client may invoke by name. Arguments are validated again by CloudAuthClient itself. */
const CALLS = {
  view: 0, check: 0, restore: 0, signOut: 0,
  redeemCard: 2,
  membershipCatalogue: 1, membershipStatus: 1, membershipCheckout: 2,
  billingPlans: 1, billingOrders: 1, billingRefundableOrders: 2, createBillingOrder: 3,
  billingOrder: 2, reconcileBillingOrder: 2, billingCheckoutLink: 2, billingRefundQuote: 2, refundBillingOrder: 4,
} as const;
export type AccountCall = keyof typeof CALLS;
const CHANGES_GATE: ReadonlySet<string> = new Set(['check', 'restore', 'signOut', 'redeemCard']);

export type SignInState =
  | { state: 'idle' }
  | { state: 'running'; id: number; startedAt: number }
  | { state: 'done'; id: number; finishedAt: number }
  | { state: 'failed'; id: number; error: string; finishedAt: number };

export interface AccountDeps {
  origin: string;
  dataDir: string;
  machineState: Pick<MachineStateRepo, 'get' | 'set'>;
  secrets: SecretBackend;
  gate?: EntitlementGate;
  openExternal: (url: string) => Promise<boolean>;
  fetch?: typeof fetch;
  log: (line: string) => void;
}

export class AccountError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}

const errorCode = (e: unknown): string => (e instanceof CloudAuthError ? e.code : e instanceof AccountError ? e.code : 'invalid_response');

export class AccountService {
  private client?: CloudAuthClient;
  private clientFor?: string;
  private job: SignInState = { state: 'idle' };
  private abort?: AbortController;
  private chain: Promise<unknown> = Promise.resolve();
  /** Last login seen by syncGate(); lets the Local Web check its sessions without touching storage. */
  private signedIn: { userId: string; expiresAt: number } | null = null;
  // Web is granted only after this Core has actually verified the cloud account.
  // A saved credential is not proof; never persist this grant across process boots.
  private webVerified: { userId: string; expiresAt: number } | null = null;
  private webPhase: 'checking' | 'verified' | 'saved' | 'logged_out' | 'unavailable' = 'checking';
  private jobSeq = 0;
  private readonly signOutListeners: (() => void)[] = [];
  private observationTimer?: ReturnType<typeof setInterval>;
  private observationPending?: Promise<unknown>;
  private stopped = false;
  private readonly lifetime = new AbortController();
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private readonly views = new Set<Promise<unknown>>();

  constructor(private readonly deps: AccountDeps) {
    deps.gate?.setProver(async (challenge, sessionId) => {
      const c = this.maybeClient();
      if (!c) return null;
      const id = await c.gateIdentity().catch(() => null);
      if (!id || id.kind !== 'login' || id.sessionId !== sessionId) return null;
      return c.entitlementProof(challenge, sessionId);
    });
  }

  get storage(): 'available' | 'unavailable' {
    return this.deps.secrets.kind === 'unavailable' ? 'unavailable' : 'available';
  }

  get storageKind(): SecretBackend['kind'] {
    return this.deps.secrets.kind;
  }

  /** Stable per daemon data dir; replaced only by migrating an existing VS Code login (plan 6.11). */
  clientId(): string {
    const adopted = this.deps.machineState.get('account.client_id');
    if (adopted) return adopted;
    let install = this.deps.machineState.get('account.install_id');
    if (!install) {
      install = randomUUID();
      this.deps.machineState.set('account.install_id', install);
    }
    return createHash('sha256').update(`blackhole-daemon-installation-v1\0${this.deps.origin}\0${install}`).digest('base64url');
  }

  private maybeClient(): CloudAuthClient | undefined {
    if (this.deps.secrets.kind === 'unavailable') return undefined;
    const id = this.clientId();
    if (!this.client || this.clientFor !== id) {
      const dir = path.join(this.deps.dataDir, 'cloud-auth-v1', createHash('sha256').update(this.deps.origin).digest('hex'));
      this.client = new CloudAuthClient({
        origin: this.deps.origin,
        secrets: this.deps.secrets.port,
        receipts: fileReceiptPort(dir, this.deps.origin),
        clientId: id,
        fetch: this.deps.fetch ?? ((input, init) => globalThis.fetch(input, init)),
        openExternal: this.deps.openExternal,
      });
      this.clientFor = id;
    }
    return this.client;
  }

  private need(): CloudAuthClient {
    const c = this.maybeClient();
    if (!c) throw new AccountError('storage_unavailable', 503);
    return c;
  }

  /** Serializes state-changing operations (migration, sign-in completion, sign-out). */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Record the signed-in account and feed the entitlement gate from it. Never throws. */
  async syncGate(): Promise<void> {
    if (this.stopped) return;
    const c = this.maybeClient();
    if (!c) { this.webVerified = null; this.webPhase = 'unavailable'; return; }
    try {
      const id = await c.gateIdentity();
      const view = await c.view(); // cached status; never starts another network check
      if (this.stopped) return;
      this.signedIn = id?.kind === 'login' ? { userId: id.userId, expiresAt: id.expiresAt } : null;
      this.webVerified = view.state === 'verified' && id?.kind === 'login' && view.userId === id.userId
        ? { userId: id.userId, expiresAt: id.expiresAt } : null;
      this.webPhase = view.state;
      this.deps.gate?.setIdentity(id);
    } catch {
      // Fail closed for browser sessions even if entitlement recovery preserves
      // its previous identity through an intermittent secret-storage failure.
      this.webVerified = null;
      this.webPhase = 'unavailable';
    }
  }

  /** Startup: bounded read-only recovery, then publish identity to the gate. */
  start(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return this.starting ??= this.startOnce();
  }

  private async startOnce(): Promise<void> {
    // Authentication belongs to Core. A waiting/minimized Desktop or a closed
    // VS Code view must not stop read-only renewal and recovery after backoff.
    // CloudAuthClient.observe owns single-flight and request backoff; this timer
    // also renews before the 60-second snapshot deadline when no UI polls.
    this.observationTimer ??= setInterval(() => {
      if (this.stopped || this.observationPending) return;
      const pending = this.view().catch(() => undefined).finally(() => {
        if (this.observationPending === pending) this.observationPending = undefined;
      });
      this.observationPending = pending;
    }, 15_000);
    this.observationTimer.unref();
    const c = this.maybeClient();
    if (!c) {
      this.webPhase = 'unavailable';
      this.deps.log(`account: cannot keep credentials (${this.deps.secrets.kind === 'unavailable' ? this.deps.secrets.reason : ''}); signing in is unavailable`);
      return;
    }
    await c.restore(this.lifetime.signal).catch(() => undefined);
    await this.syncGate();
  }

  /** Cancel and drain account IO before daemon storage is closed. */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    if (this.observationTimer) clearInterval(this.observationTimer);
    this.observationTimer = undefined;
    this.lifetime.abort();
    this.abort?.abort();
    this.stopping = Promise.allSettled([
      this.starting, this.observationPending, this.chain, ...this.views,
    ]).then(() => undefined);
    return this.stopping;
  }

  view(): Promise<AuthView & { storage: 'available' | 'unavailable'; signIn: SignInState }> {
    if (this.stopped) return Promise.resolve({ state: 'unavailable', storage: this.storage, signIn: this.job });
    const pending = this.observedView().finally(() => this.views.delete(pending));
    this.views.add(pending);
    return pending;
  }

  private async observedView(): Promise<AuthView & { storage: 'available' | 'unavailable'; signIn: SignInState }> {
    // All native windows and the Core timer share one observer and its backoff.
    const base: AuthView = this.maybeClient() ? await this.need().observe(this.lifetime.signal).catch(() => ({ state: 'unavailable' as const })) : { state: 'unavailable' };
    await this.syncGate();
    return { ...base, storage: this.storage, signIn: this.job };
  }

  /** Account signed in on this machine right now; null when none or its login has lapsed. */
  currentUserId(now = Date.now()): string | null {
    const s = this.signedIn;
    return s && s.expiresAt * 1000 > now ? s.userId : null;
  }

  /** Browser-only status: no cloud requests, identity, ticket or credentials. */
  webAuthStatus(): 'checking' | 'verified' | 'saved' | 'logged_out' | 'unavailable' {
    return this.currentVerifiedUserId() ? 'verified' : this.webPhase === 'verified' ? 'logged_out' : this.webPhase;
  }

  /** A Web cookie requires a verified Core identity, not a saved token. */
  currentVerifiedUserId(now = Date.now()): string | null {
    const value = this.webVerified;
    return value && value.expiresAt * 1000 > now ? value.userId : null;
  }

  /** Called after an explicit sign-out (never for a lapsed login). */
  onSignOut(fn: () => void): void {
    this.signOutListeners.push(fn);
  }

  signInState(): SignInState {
    return this.job;
  }

  /** Account of the last login on this machine, lapsed or not; null after sign-out or when there never was one. */
  lastUserId(): string | null {
    return this.signedIn?.userId ?? null;
  }

  /**
   * Starts the browser login in the background; poll signInState().
   * `sameAccount`: while this machine holds an account (even a lapsed one) only that
   * account is accepted, so a Web login can never swap the machine's account.
   */
  beginSignIn(opts: { sameAccount?: boolean } = {}): SignInState & { state: 'running' } {
    if (this.stopped) throw new AccountError('account_unavailable', 503);
    const c = this.need();
    if (this.job.state === 'running') throw new AccountError('busy', 409);
    const abort = new AbortController();
    this.abort = abort;
    const id = ++this.jobSeq;
    const expect = opts.sameAccount ? this.lastUserId() ?? undefined : undefined;
    const job = { state: 'running' as const, id, startedAt: Date.now() };
    this.job = job;
    // The daemon exclusively opens the system browser and retains PKCE state;
    // neither browser Web nor Desktop supplies or receives an OAuth URL.
    void this.exclusive(() => c.signIn(abort.signal, expect))
      .then(async () => {
        await this.syncGate();
        if (!this.currentVerifiedUserId()) throw new AccountError('verification_required', 503);
        if (this.abort === abort) this.job = { state: 'done', id, finishedAt: Date.now() };
      })
      .catch((e) => {
        if (this.abort === abort) this.job = { state: 'failed', id, error: errorCode(e), finishedAt: Date.now() };
      });
    return job;
  }

  /** Open a cloud checkout page in the system browser (https only; the page itself is the cloud's). */
  async openCheckout(url: string): Promise<boolean> {
    let parsed: URL;
    try { parsed = new URL(url); } catch { return false; }
    if (parsed.protocol !== 'https:') return false;
    return this.deps.openExternal(parsed.href).catch(() => false);
  }

  cancelSignIn(): SignInState {
    if (this.job.state === 'running') this.abort?.abort();
    return this.job;
  }

  async call(method: string, args: unknown): Promise<unknown> {
    if (this.stopped) throw new AccountError('account_unavailable', 503);
    if (!Object.hasOwn(CALLS, method)) throw new AccountError('unknown_method', 400);
    const list = args === undefined ? [] : args;
    if (!Array.isArray(list) || list.length > CALLS[method as AccountCall]
      || list.some((v) => v !== null && v !== undefined && (typeof v !== 'string' || v.length > 1024))) {
      throw new AccountError('invalid_input', 400);
    }
    // The VS Code adapter uses the native call surface for view(). Route it
    // through the same Core observer as GET /account, not the expiring raw cache.
    const c = this.need();
    if (method === 'view') return this.view();
    const fn = (c as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[method]!;
    const run = () => method === 'check' || method === 'restore'
      ? c[method](this.lifetime.signal)
      : fn.apply(c, list.map((v) => (v === null ? undefined : v)));
    const result = method === 'signOut' ? await this.exclusive(run) : await run();
    if (CHANGES_GATE.has(method)) await this.syncGate();
    if (method === 'signOut') for (const fn of this.signOutListeners) fn();
    return result;
  }

  /**
   * One-time adoption of the login an older extension kept in VS Code SecretStorage.
   * Idempotent; never replaces a different account the daemon already holds.
   */
  migrate(raw: unknown): Promise<{ migrated: boolean; reason?: 'same_session' | 'daemon_has_account' }> {
    return this.exclusive(async () => {
      if (this.deps.secrets.kind === 'unavailable') throw new AccountError('storage_unavailable', 503);
      let cred;
      try {
        cred = parseCredential(raw);
      } catch {
        throw new AccountError('invalid_input', 400);
      }
      if (cred.expiresAt <= Math.floor(Date.now() / 1000)) throw new AccountError('expired', 400);
      const existing = await this.need().gateIdentity().catch(() => null);
      if (existing?.kind === 'login' && existing.expiresAt > Math.floor(Date.now() / 1000)) {
        return existing.sessionId === cred.sessionId ? { migrated: false, reason: 'same_session' as const } : { migrated: false, reason: 'daemon_has_account' as const };
      }
      this.deps.machineState.set('account.client_id', cred.clientId);
      const c = this.need();
      const origin = this.deps.origin;
      await this.deps.secrets.port.store(credentialKey(cred.sessionId, origin), JSON.stringify(cred));
      const dir = path.join(this.deps.dataDir, 'cloud-auth-v1', createHash('sha256').update(origin).digest('hex'));
      await fileReceiptPort(dir, origin).put({ version: 1, origin, loginOrder: cred.loginOrder, sessionId: cred.sessionId, kind: 'login' });
      void c.check().catch(() => undefined).then(() => this.syncGate());
      await this.syncGate();
      this.deps.log(`account: adopted VS Code login (session ${cred.sessionId.slice(0, 8)}…)`);
      return { migrated: true };
    });
  }
}

export { errorCode as accountErrorCode };

