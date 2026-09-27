/**
 * Strict OS-keychain adapter for the OpenAI tunnel Runtime API key (plan §5.5).
 *
 * Unlike the account secret port, failures are never swallowed: a write only
 * reports success after the store accepted it, and a delete is confirmed by
 * reading back. Callers get `CredentialStoreError` with a fixed code — never
 * the secret or a raw keyring message — so they can report the true/unknown
 * state instead of claiming "cleared".
 */
const SERVICE = 'BlackHole OpenAI Tunnel';
const ACCOUNT = 'runtime-api-key';
const OP_TIMEOUT_MS = 5_000;

export type CredentialErrorCode = 'credential_store_unavailable' | 'credential_store_timeout' | 'credential_store_failed' | 'credential_delete_unconfirmed';

export class CredentialStoreError extends Error {
  constructor(readonly code: CredentialErrorCode) {
    super(code);
    this.name = 'CredentialStoreError';
  }
}

interface Entry {
  setPassword(password: string): Promise<void>;
  getPassword(): Promise<string | undefined | null>;
  deletePassword(): Promise<boolean>;
}
export type EntryFactory = () => Entry;

export interface OpenAITunnelCredentialStore {
  readonly kind: 'keyring' | 'memory' | 'unavailable';
  readonly reason?: string;
  /** The key itself, only for building the child environment. */
  get(): Promise<string | undefined>;
  has(): Promise<boolean>;
  set(value: string): Promise<void>;
  /** 'absent' when nothing was stored; throws when deletion cannot be confirmed. */
  remove(): Promise<'deleted' | 'absent'>;
}

function withTimeout<T>(op: () => Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new CredentialStoreError('credential_store_timeout')), ms);
    timer.unref?.();
    op().then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e instanceof CredentialStoreError ? e : new CredentialStoreError('credential_store_failed')); },
    );
  });
}

export function strictStore(kind: 'keyring' | 'memory', entry: EntryFactory, timeoutMs = OP_TIMEOUT_MS): OpenAITunnelCredentialStore {
  const read = () => withTimeout(async () => (await entry().getPassword()) || undefined, timeoutMs);
  return {
    kind,
    get: read,
    has: async () => (await read()) !== undefined,
    set: async (value) => {
      await withTimeout(() => entry().setPassword(value), timeoutMs);
      // Only a value that reads back is "configured".
      if ((await read()) !== value) throw new CredentialStoreError('credential_store_failed');
    },
    remove: async () => {
      if ((await read()) === undefined) return 'absent';
      await withTimeout(() => entry().deletePassword(), timeoutMs).catch((e: unknown) => {
        throw e instanceof CredentialStoreError && e.code === 'credential_store_timeout' ? e : new CredentialStoreError('credential_delete_unconfirmed');
      });
      let after: string | undefined;
      try { after = await read(); } catch { throw new CredentialStoreError('credential_delete_unconfirmed'); }
      if (after !== undefined) throw new CredentialStoreError('credential_delete_unconfirmed');
      return 'deleted';
    },
  };
}

function unavailable(reason: string): OpenAITunnelCredentialStore {
  const fail = async (): Promise<never> => { throw new CredentialStoreError('credential_store_unavailable'); };
  return { kind: 'unavailable', reason, get: fail, has: fail, set: fail, remove: fail };
}

/** In-process store for isolated tests (BLACKHOLE_ACCOUNT_SECRETS=memory); never persists. */
export function memoryEntryFactory(): EntryFactory {
  let value: string | undefined;
  const entry: Entry = {
    setPassword: async (v) => { value = v; },
    getPassword: async () => value,
    deletePassword: async () => { const had = value !== undefined; value = undefined; return had; },
  };
  return () => entry;
}

interface KeyringModule { AsyncEntry: new (service: string, username: string) => Entry }

/**
 * Separate service name from the BlackHole account (plan §5.5). Test isolation
 * follows the account store: `memory` only when explicitly requested.
 */
export async function openOpenAITunnelCredential(
  mode = process.env.BLACKHOLE_ACCOUNT_SECRETS,
  load: () => Promise<unknown> = () => import('@napi-rs/keyring'),
): Promise<OpenAITunnelCredentialStore> {
  if (mode === 'memory') return strictStore('memory', memoryEntryFactory());
  if (mode === 'unavailable') return unavailable('disabled');
  let mod: KeyringModule;
  try { mod = (await load()) as KeyringModule; } catch { return unavailable('keyring_module_missing'); }
  if (typeof mod?.AsyncEntry !== 'function') return unavailable('keyring_module_missing');
  return strictStore('keyring', () => new mod.AsyncEntry(SERVICE, ACCOUNT));
}
