import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * Small secrets (the cloud account token, the OpenAI Runtime API key) kept in a
 * user-only file: one JSON map per file, written atomically (temp file + rename).
 *
 * macOS/Linux: directory 0700, file 0600. Windows: the user-profile ACL applies
 * and the content is also sealed with DPAPI (bound to this Windows user), so a
 * copied or synced file cannot be read elsewhere. Same code path everywhere
 * else; no OS credential store, no native module outside Windows.
 */
export interface SecretFile {
  readonly file: string;
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
}

/** Seals bytes for this OS user; null when the platform offers nothing beyond file permissions. */
export interface Sealer {
  readonly name: 'dpapi';
  seal(plain: Buffer): Buffer;
  unseal(sealed: Buffer): Buffer;
}

interface Envelope {
  v: 1;
  enc: 'dpapi' | 'none';
  data: string;
}

export function openSecretFile(file: string, sealer: Sealer | null = defaultSealer()): SecretFile {
  const dir = path.dirname(file);

  const read = (): Record<string, string> => {
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw e;
    }
    // Anything unreadable (corrupt, or sealed for another user/machine) counts as empty.
    try {
      const env = JSON.parse(raw) as Envelope;
      if (env?.v !== 1 || typeof env.data !== 'string') return {};
      let bytes: Buffer = Buffer.from(env.data, 'base64');
      if (env.enc === 'dpapi') {
        if (!sealer) return {};
        bytes = sealer.unseal(bytes);
      } else if (env.enc !== 'none') {
        return {};
      }
      const map = JSON.parse(bytes.toString('utf8')) as unknown;
      if (!map || typeof map !== 'object' || Array.isArray(map)) return {};
      return Object.fromEntries(Object.entries(map).filter((e): e is [string, string] => typeof e[1] === 'string'));
    } catch {
      return {};
    }
  };

  const write = (map: Record<string, string>): void => {
    if (Object.keys(map).length === 0) {
      fs.rmSync(file, { force: true });
      return;
    }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
    const plain = Buffer.from(JSON.stringify(map), 'utf8');
    const env: Envelope = sealer
      ? { v: 1, enc: 'dpapi', data: sealer.seal(plain).toString('base64') }
      : { v: 1, enc: 'none', data: plain.toString('base64') };
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(env), { mode: 0o600, flag: 'wx' });
      renameWithRetry(tmp, file);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
  };

  return {
    file,
    get: (key) => read()[key],
    set: (key, value) => { const map = read(); map[key] = value; write(map); },
    delete: (key) => { const map = read(); if (key in map) { delete map[key]; write(map); } },
  };
}

/** Windows may briefly refuse a replace while a scanner holds the target open. */
function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1));
    }
  }
}

let cachedSealer: Sealer | null | undefined;

/** DPAPI on Windows when the bundled FFI module loads; otherwise file permissions only. */
export function defaultSealer(): Sealer | null {
  if (cachedSealer !== undefined) return cachedSealer;
  cachedSealer = null;
  if (process.platform !== 'win32') return cachedSealer;
  try {
    // Never load a Windows native dependency when the same bundle runs elsewhere.
    const require = createRequire(typeof __filename === 'string' ? __filename : import.meta.url);
    const koffi = require('koffi') as typeof import('koffi');
    const crypt32 = koffi.load('crypt32.dll');
    const kernel32 = koffi.load('kernel32.dll');
    const BLOB = koffi.struct('BH_SECRET_BLOB', { cbData: 'uint32', pbData: 'void *' });
    const blobFn = (name: string) => crypt32.func('__stdcall', name, 'bool',
      [koffi.pointer(BLOB), 'void *', 'void *', 'void *', 'void *', 'uint32', koffi.out(koffi.pointer(BLOB))]);
    const protect = blobFn('CryptProtectData');
    const unprotect = blobFn('CryptUnprotectData');
    const localFree = kernel32.func('__stdcall', 'LocalFree', 'void *', ['void *']);
    const CRYPTPROTECT_UI_FORBIDDEN = 0x1;
    const run = (fn: (...args: unknown[]) => boolean, data: Buffer): Buffer => {
      const out: { cbData?: number; pbData?: unknown } = {};
      if (!fn({ cbData: data.length, pbData: data }, null, null, null, null, CRYPTPROTECT_UI_FORBIDDEN, out)) throw new Error('dpapi_failed');
      try {
        return Buffer.from(koffi.decode(out.pbData, koffi.array('uint8', out.cbData ?? 0, 'Typed')) as Uint8Array);
      } finally {
        localFree(out.pbData);
      }
    };
    const sealer: Sealer = { name: 'dpapi', seal: (b) => run(protect, b), unseal: (b) => run(unprotect, b) };
    // Self-check once: a sealer that cannot round-trip must not be used for writes.
    const probe = Buffer.from('blackhole');
    if (!sealer.unseal(sealer.seal(probe)).equals(probe)) return cachedSealer;
    cachedSealer = sealer;
  } catch {
    cachedSealer = null;
  }
  return cachedSealer;
}
