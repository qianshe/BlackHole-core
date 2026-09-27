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
  for (const [rel, want] of Object.entries(manifest)) {
    try {
      const file = path.join(dir, rel);
      const got = rel === 'cli.js' ? sha256(stripIntegritySlot(fs.readFileSync(file, 'latin1'))) : sha256(fs.readFileSync(file));
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
