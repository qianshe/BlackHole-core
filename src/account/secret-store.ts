import fs from 'node:fs';
import path from 'node:path';
import { openSecretFile } from '../util/secret-file.js';
import type { SecretPort } from './cloud-auth-client.js';
import { cloudAuthPrefix } from './cloud-origin.js';

/**
 * Where the daemon keeps the cloud account credential: a user-only file under
 * the daemon data dir (see util/secret-file.ts). `memory` is for isolated tests
 * (BLACKHOLE_ACCOUNT_SECRETS=memory) and never persists; `unavailable` means the
 * data dir cannot hold the file, and signing in is refused rather than degraded.
 */
export type SecretBackend =
  | { kind: 'file' | 'memory'; port: SecretPort }
  | { kind: 'unavailable'; reason: string };

export function memorySecretPort(): SecretPort {
  const vault = new Map<string, string>();
  return {
    get: async (key) => vault.get(key),
    store: async (key, value) => { vault.set(key, value); },
    delete: async (key) => { vault.delete(key); },
  };
}

/** One file per cloud origin so test and production builds never share a login. Throws on an invalid origin. */
export function accountSecretFile(dataDir: string, origin: string): string {
  return path.join(dataDir, 'secrets', `account-${cloudAuthPrefix(origin).slice(-16)}.json`);
}

export function openSecretBackend(file: string, mode = process.env.BLACKHOLE_ACCOUNT_SECRETS): SecretBackend {
  if (mode === 'memory') return { kind: 'memory', port: memorySecretPort() };
  if (mode === 'unavailable') return { kind: 'unavailable', reason: 'disabled' };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  } catch (e) {
    return { kind: 'unavailable', reason: `storage_unwritable: ${(e as NodeJS.ErrnoException).code ?? 'error'}` };
  }
  const store = openSecretFile(file);
  return {
    kind: 'file',
    port: {
      get: async (key) => store.get(key),
      store: async (key, value) => store.set(key, value),
      delete: async (key) => store.delete(key),
    },
  };
}
