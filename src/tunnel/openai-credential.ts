/**
 * Strict store for the OpenAI tunnel Runtime API key (plan §5.5), kept in a
 * user-only file next to the account credential (see util/secret-file.ts).
 *
 * Unlike the account secret port, failures are never swallowed: a write only
 * reports success after it reads back, and a delete is confirmed by reading
 * back. Callers get `CredentialStoreError` with a fixed code — never the secret
 * or a raw filesystem message — so they can report the true/unknown state
 * instead of claiming "cleared".
 */
import fs from 'node:fs';
import path from 'node:path';
import { openSecretFile } from '../util/secret-file.js';

const KEY = 'runtime-api-key';
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
  readonly kind: 'file' | 'memory' | 'unavailable';
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

export function strictStore(kind: 'file' | 'memory', entry: EntryFactory, timeoutMs = OP_TIMEOUT_MS): OpenAITunnelCredentialStore {
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

/** Separate file from the BlackHole account (plan §5.5), same directory and protection. */
export function fileEntryFactory(file: string): EntryFactory {
  const store = openSecretFile(file);
  const entry: Entry = {
    setPassword: async (v) => store.set(KEY, v),
    getPassword: async () => store.get(KEY),
    deletePassword: async () => { const had = store.get(KEY) !== undefined; store.delete(KEY); return had; },
  };
  return () => entry;
}

export function openAITunnelSecretFile(dataDir: string): string {
  return path.join(dataDir, 'secrets', 'openai-tunnel.json');
}

/** Test isolation follows the account store: `memory` only when explicitly requested. */
export async function openOpenAITunnelCredential(
  mode = process.env.BLACKHOLE_ACCOUNT_SECRETS,
  file?: string,
): Promise<OpenAITunnelCredentialStore> {
  if (mode === 'memory') return strictStore('memory', memoryEntryFactory());
  if (mode === 'unavailable' || !file) return unavailable('disabled');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  } catch {
    return unavailable('storage_unwritable');
  }
  return strictStore('file', fileEntryFactory(file));
}
