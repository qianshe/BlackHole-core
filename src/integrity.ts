import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Install integrity self-check (plan 6.14 O4).
 *
 * The packaging build seals the bundled daemon: it hashes every shipped
 * runtime file and writes the manifest (base64 JSON) into the slot below.
 * cli.js hashes itself with the slot content removed, so the manifest can
 * live inside the file it covers. Unsealed builds (tsc dev output, tests
 * running the TypeScript sources) carry no manifest and skip the check.
 *
 * This raises the bar against casual patching; it is not tamper-proof.
 */
declare const __BLACKHOLE_INTEGRITY__: string | undefined;

// Built from pieces so the markers never appear literally in this module.
const OPEN = ['<<BH', 'I:'].join('');
const CLOSE = [':BH', 'I>>'].join('');

export const INTEGRITY_MESSAGE = 'install_corrupted: BlackHole 安装文件已损坏，请重新安装后重试';

/** Replace the slot content with nothing; used by both the build and the runtime. */
export function stripIntegritySlot(text: string): string {
  const i = text.indexOf(OPEN);
  const j = i < 0 ? -1 : text.indexOf(CLOSE, i + OPEN.length);
  return i < 0 || j < 0 ? text : text.slice(0, i + OPEN.length) + text.slice(j);
}

const sha256 = (buf: Buffer | string): string => createHash('sha256').update(buf).digest('hex');

let cached: string[] | undefined;

/** Files that fail the check (empty = intact or unsealed). Computed once per process. */
export function integrityFailures(): string[] {
  if (cached) return cached;
  cached = [];
  const raw = typeof __BLACKHOLE_INTEGRITY__ === 'string' ? __BLACKHOLE_INTEGRITY__ : '';
  const i = raw.indexOf(OPEN);
  const j = i < 0 ? -1 : raw.indexOf(CLOSE, i + OPEN.length);
  const body = i < 0 || j < 0 ? '' : raw.slice(i + OPEN.length, j).trim();
  if (!body) return cached;
  let manifest: Record<string, string>;
  try {
    manifest = JSON.parse(Buffer.from(body, 'base64').toString('utf8')) as Record<string, string>;
  } catch {
    return (cached = ['manifest']);
  }
  const self = typeof __filename === 'string' ? __filename : '';
  if (!self) return (cached = ['cli.js']);
  const dir = path.dirname(self);
  // The VS Code build is staged under dist/daemon/{cli.js,web/...}, but a
  // signed shared Core has {daemon/cli.js,web/...} as siblings. The Manager
  // validates the signed descriptor and every member before it starts Core.
  // Choose exactly ONE layout from the managed launch identity. Never try an
  // alternate path on a missing/hash-mismatched member: that could allow a
  // good shadow copy to conceal a damaged served Web asset.
  const managed = !!process.env.BLACKHOLE_MANAGED_RUNTIME_IDENTITY;
  const sharedRoot = path.resolve(dir, '..');
  if (managed && !fs.existsSync(path.join(sharedRoot, 'core-descriptor.json')))
    return (cached = ['core-descriptor.json']);
  for (const [rel, want] of Object.entries(manifest)) {
    // The seal is embedded in cli.js, but treat its contents as untrusted
    // until checked. No absolute paths, traversal, reparse points or arbitrary
    // file reads should be possible through the manifest.
    if (!rel || rel.includes('\\') || rel.includes(':') ||
      rel.split('/').some(part => part === '' || part === '.' || part === '..') ||
      typeof want !== 'string' || !/^[a-f0-9]{64}$/.test(want)) {
      cached.push('manifest');
      break;
    }
    try {
      const base = managed && rel.startsWith('web/') ? sharedRoot : dir;
      const file = path.join(base, rel);
      const got = rel === 'cli.js'
        ? sha256(stripIntegritySlot(fs.readFileSync(file, 'latin1')))
        : sha256(fs.readFileSync(file));
      if (got !== want) cached.push(rel);
    } catch {
      cached.push(rel);
    }
  }
  if (cached.length) console.error(`[blackhole] integrity check failed: ${cached.join(', ')}`);
  return cached;
}

/** Throws the neutral corruption error when the install fails its self-check. */
export function assertIntegrity(): void {
  if (integrityFailures().length) throw new Error(INTEGRITY_MESSAGE);
}
