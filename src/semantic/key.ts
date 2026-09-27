/**
 * Windsurf/Devin API key resolution for semantic search.
 *
 * The key decides whether `context_search` exists at all: with nothing
 * resolved, the daemon does not register the tool, so a remote agent is never
 * told about a capability that would fail (and never spends the operator's
 * quota by accident).
 *
 * Sources, first hit wins:
 *   1. `BLACKHOLE_SEMANTIC_KEY` env (aliases: DEVIN_API_KEY, WINDSURF_API_KEY).
 *   2. `~/.blackhole/semantic-key`, written by `blackhole semantic <KEY>`
 *   3. Only with `BLACKHOLE_SEMANTIC=auto`: the local Devin/Windsurf
 *      installation (state.vscdb / CLI credentials.toml).
 *
 * Source 3 is opt-in on purpose. dsh's plugin reads the local editor credential
 * by default because there the key owner and the code owner are the same person
 * on the same box. Here the query arrives from a machine the operator happens
 * to be chatting with, and answering it means sending a repo map and file
 * excerpts to a third-party endpoint using the operator's own quota. That trade
 * is the operator's to make explicitly, not a side effect of having Devin
 * installed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { extractKey, getCredentialSources } from './extract-key.js';
import type { Config, SemanticMode } from '../config.js';

/** Manual key file inside ~/.blackhole (write half: `writeKeyFile`). */
export const KEY_FILE_NAME = 'semantic-key';

export type KeySource = 'env' | 'file' | 'auto' | 'none';

export interface ResolvedKey {
  key: string;
  source: KeySource;
  /** Human-readable origin for logs, the tool output and the settings page. */
  detail: string;
  /** Every source consulted, in order — shown when nothing resolved. */
  tried: string[];
}

const ENV_ALIASES = ['BLACKHOLE_SEMANTIC_KEY', 'DEVIN_API_KEY', 'WINDSURF_API_KEY'];

/** Absolute path of the manual key file. */
export function keyFilePath(cfg: Pick<Config, 'semanticKeyPath'>): string {
  return cfg.semanticKeyPath;
}

/** Read the manual key file; absent or blank is not an error. */
export function readKeyFile(cfg: Pick<Config, 'semanticKeyPath'>): string {
  try {
    // Tolerate a trailing newline or a key wrapped in quotes when pasted in.
    return fs.readFileSync(cfg.semanticKeyPath, 'utf8').trim().replace(/^["']|["']$/g, '');
  } catch {
    return '';
  }
}

/**
 * Write the manual key file (0600 — it is a bearer credential), creating
 * ~/.blackhole when needed.
 */
export function writeKeyFile(cfg: Pick<Config, 'semanticKeyPath'>, key: string): string {
  fs.mkdirSync(path.dirname(cfg.semanticKeyPath), { recursive: true });
  fs.writeFileSync(cfg.semanticKeyPath, `${key.trim()}\n`, { encoding: 'utf8', mode: 0o600 });
  return cfg.semanticKeyPath;
}

/** Remove the manual key file; returns whether one was there. */
export function clearKeyFile(cfg: Pick<Config, 'semanticKeyPath'>): boolean {
  if (!fs.existsSync(cfg.semanticKeyPath)) return false;
  try {
    fs.rmSync(cfg.semanticKeyPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the key from every enabled source. Never throws: a failure is data
 * (`source: 'none'` with a reason), because the caller decides whether to
 * register a tool rather than whether to crash.
 */
export async function resolveSemanticKey(cfg: Config, env: NodeJS.ProcessEnv = process.env): Promise<ResolvedKey> {
  const tried: string[] = [];

  for (const name of ENV_ALIASES) {
    tried.push(`env:${name}`);
    const value = (env[name] ?? '').trim();
    if (value !== '') return { key: value, source: 'env', detail: `env:${name}`, tried };
  }

  tried.push(`file:${cfg.semanticKeyPath}`);
  const fileKey = readKeyFile(cfg);
  if (fileKey !== '') return { key: fileKey, source: 'file', detail: cfg.semanticKeyPath, tried };

  if (cfg.semantic !== 'auto') {
    return {
      key: '',
      source: 'none',
      detail: cfg.semantic === 'off'
        ? 'semantic search disabled (BLACKHOLE_SEMANTIC=off)'
        : `no explicit key; add one with \`blackhole semantic <KEY>\` or set ${ENV_ALIASES[0]} (local-app discovery is off; BLACKHOLE_SEMANTIC=auto enables it)`,
      tried,
    };
  }

  try {
    const found = await extractKey();
    for (const source of found.tried_paths ?? getCredentialSources().map((s) => s.path)) tried.push(`auto:${source}`);
    if (found.api_key) return { key: found.api_key, source: 'auto', detail: found.db_path ?? 'local installation', tried };
    return { key: '', source: 'none', detail: found.error ?? 'no key in the local Devin/Windsurf installation', tried };
  } catch (e) {
    return { key: '', source: 'none', detail: `local discovery failed: ${e instanceof Error ? e.message : String(e)}`, tried };
  }
}

/** Default ~/.blackhole location, shared with the DB path convention. */
export function defaultKeyFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.BLACKHOLE_HOME?.trim() || path.join(os.homedir(), '.blackhole');
  return path.join(dir, KEY_FILE_NAME);
}

export type { SemanticMode };
