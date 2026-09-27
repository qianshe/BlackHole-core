import type { SecretPort } from './cloud-auth-client.js';

/**
 * Where the daemon keeps cloud credentials. Only the OS credential store is a
 * real backend; there is deliberately no plaintext file fallback. `memory` is
 * for isolated tests (BLACKHOLE_ACCOUNT_SECRETS=memory) and never persists.
 */
export type SecretBackend =
  | { kind: 'keyring' | 'memory'; port: SecretPort }
  | { kind: 'unavailable'; reason: string };

export function memorySecretPort(): SecretPort {
  const vault = new Map<string, string>();
  return {
    get: async (key) => vault.get(key),
    store: async (key, value) => { vault.set(key, value); },
    delete: async (key) => { vault.delete(key); },
  };
}

interface KeyringModule {
  AsyncEntry: new (service: string, username: string) => {
    setPassword(password: string): Promise<void>;
    getPassword(): Promise<string | undefined | null>;
    deletePassword(): Promise<boolean>;
  };
}

/** Opens the OS credential store and proves a write/read/delete round-trip before trusting it. */
export async function openSecretBackend(service: string, mode = process.env.BLACKHOLE_ACCOUNT_SECRETS): Promise<SecretBackend> {
  if (mode === 'memory') return { kind: 'memory', port: memorySecretPort() };
  if (mode === 'unavailable') return { kind: 'unavailable', reason: 'disabled' };
  let mod: KeyringModule;
  try {
    mod = (await import('@napi-rs/keyring')) as unknown as KeyringModule;
  } catch {
    return { kind: 'unavailable', reason: 'keyring_module_missing' };
  }
  const entry = (key: string) => new mod.AsyncEntry(service, key);
  try {
    // Read-only probe: reaching the store is enough, and nothing is written to the user's keychain.
    await entry('probe').getPassword();
  } catch {
    return { kind: 'unavailable', reason: 'keyring_unavailable' };
  }
  return {
    kind: 'keyring',
    port: {
      get: async (key) => (await entry(key).getPassword()) ?? undefined,
      store: async (key, value) => { await entry(key).setPassword(value); },
      delete: async (key) => { await entry(key).deletePassword().catch(() => false); },
    },
  };
}
