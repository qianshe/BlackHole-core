/**
 * Result cache for semantic search.
 *
 * Ported from dsh-assistant-optimization `lib/fast-context/cache.js`
 * (itself from fast-context-mcp `src/cache.mjs`, MIT). Same behaviour, typed.
 *
 * Why it matters here specifically: a web agent that does not get an answer it
 * likes re-asks the same question in slightly different words, and an uncached
 * re-ask costs the operator another 30-120s of third-party quota. The key
 * includes an mtime/size fingerprint, so editing the workspace invalidates the
 * entry rather than returning a stale file list.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { excludePatternToRegex } from './shared.js';

interface CacheEntry {
  result: unknown;
  expiresAt: number;
}

const store = new Map<string, CacheEntry>();

function envFlag(name: string): boolean {
  const value = (process.env[name] ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function ttlMs(): number {
  const raw = process.env.BH_SEMANTIC_CACHE_TTL_MS;
  if (raw === undefined || raw.trim() === '') return 300_000;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 300_000;
}

function maxEntries(): number {
  const parsed = Number.parseInt(process.env.BH_SEMANTIC_CACHE_MAX_ENTRIES ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 200;
}

function disabled(): boolean {
  return envFlag('BH_SEMANTIC_CACHE_DISABLED') || ttlMs() <= 0;
}

/** Directories never worth fingerprinting: they change constantly and never affect an answer. */
const SKIPPED = new Set(['node_modules', 'dist', 'build', 'coverage', 'venv', '.venv', 'target', 'out', '__pycache__', '.git']);

/** Fingerprint cap: keeps the walk cheap on a huge workspace. */
const MAX_FINGERPRINT_FILES = 5000;

/**
 * Aggregate hash of every file path + mtime + size under the root. Catches
 * content changes the repo map (which is depth-limited) cannot see.
 */
export function computeMtimeHash(projectRoot: string, excludePaths: string[] = []): string {
  const excludeRegexes = excludePaths.map(excludePatternToRegex);
  const hash = createHash('sha256');
  let count = 0;

  const walk = (dir: string): void => {
    if (count >= MAX_FINGERPRINT_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (count >= MAX_FINGERPRINT_FILES) return;
      if (excludeRegexes.some((rx) => rx.test(entry.name)) || SKIPPED.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        try {
          const st = fs.statSync(full);
          hash.update(`${full}:${st.mtimeMs}:${st.size}\n`);
          count += 1;
        } catch {
          /* unreadable file: skip */
        }
      }
    }
  };

  walk(projectRoot);
  return hash.digest('hex');
}

export interface CacheKeyParams {
  query: string;
  model: string;
  maxTurns: number;
  maxResults: number;
  treeDepth: number;
  mtimeHash: string;
  excludePaths: string[];
}

/** Deterministic key over everything that can change the answer. */
export function buildCacheKey(params: CacheKeyParams): string {
  const excluded = [...params.excludePaths].sort().join(',');
  const input = [
    params.query,
    params.model,
    params.maxTurns,
    params.maxResults,
    params.treeDepth,
    params.mtimeHash,
    excluded,
  ].join('|');
  return createHash('sha256').update(input).digest('hex');
}

export function getCachedResult<T>(key: string): T | null {
  if (disabled()) return null;
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return null;
  }
  return entry.result as T;
}

export function setCachedResult(key: string, result: unknown): void {
  const ttl = ttlMs();
  if (disabled()) return;
  const capacity = maxEntries();
  while (store.size >= capacity) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
  store.set(key, { result, expiresAt: Date.now() + ttl });
}

export function clearCache(): void {
  store.clear();
}
