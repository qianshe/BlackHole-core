/**
 * Public surface of the semantic-search subsystem.
 *
 * Two entry points, used at different times:
 *  - `probeSemantic()` at daemon startup, once. Its answer decides whether the
 *    `context_search` tool exists in `tools/list` at all. Doing this per call
 *    would not work: MCP clients (and `bh.py`, which opens a fresh protocol
 *    session per invocation) cache the tool list, and a tool that appears and
 *    disappears between calls is worse than one that is absent.
 *  - `runContextSearch()` per tool call: the search itself, under a wall-clock
 *    ceiling and an AbortSignal wired to the client connection.
 *
 * Everything else in this directory is internal to those two.
 */
import { resolveSemanticKey, type ResolvedKey } from './key.js';
import { describeSearchEngine } from './executor.js';
import { searchWithContext, type SearchReport } from './search.js';
import type { Config } from '../config.js';

export interface SemanticProbe {
  /** True only when a key resolved: the tool is registered iff this is true. */
  available: boolean;
  /** 'env' | 'file' | 'auto' | 'none' — where the key came from. */
  source: ResolvedKey['source'];
  /** Human-readable origin (path or env name); never the key itself. */
  detail: string;
  /** First/last four characters, for the settings page and the startup log. */
  preview: string;
  /** Held for the daemon's lifetime; a rotated key needs a restart. */
  apiKey: string;
  /** 'ripgrep <path> (source)' or the JS-scanner explanation. */
  engine: string;
}

const NOT_AVAILABLE: Omit<SemanticProbe, 'detail' | 'engine'> = {
  available: false,
  source: 'none',
  preview: '',
  apiKey: '',
};

/** Never leak a credential: `sk-abcdef123456` reports as `sk-a…3456`. */
function fingerprint(key: string): string {
  if (key.length <= 8) return '';
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/**
 * Resolve the search credential and the search backend. Called once during
 * startup; failures are reported as `available: false` with a reason, because
 * "no key" is an ordinary configuration state, not an error.
 */
export async function probeSemantic(cfg: Config): Promise<SemanticProbe> {
  const engine = describeSearchEngine();
  if (cfg.semantic === 'off') {
    return { ...NOT_AVAILABLE, detail: 'disabled (BLACKHOLE_SEMANTIC=off)', engine };
  }
  const resolved = await resolveSemanticKey(cfg);
  if (resolved.key === '') {
    return { ...NOT_AVAILABLE, detail: resolved.detail, engine };
  }
  return {
    available: true,
    source: resolved.source,
    detail: resolved.detail,
    preview: fingerprint(resolved.key),
    apiKey: resolved.key,
    engine,
  };
}

export interface RunParams {
  cfg: Config;
  probe: SemanticProbe;
  /** Absolute workspace path; the search never leaves it. */
  workspaceRoot: string;
  query: string;
  /** Directory to scope the repo map and the searches to (workspace-relative). */
  subPath?: string;
  treeDepth?: number;
  maxTurns?: number;
  maxResults?: number;
  excludePaths?: string[];
  includeContent?: boolean;
  signal?: AbortSignal | null;
}

export type RunOutcome = SearchReport;

/** One search, bounded by cfg.semanticTimeoutMs and the caller's signal. */
export async function runContextSearch(params: RunParams): Promise<RunOutcome> {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  if (params.signal) {
    if (params.signal.aborted) controller.abort();
    else params.signal.addEventListener('abort', onAbort, { once: true });
  }
  // The MCP client's own timeout is invisible to us and usually shorter than a
  // search, so the ceiling is explicit: without it an abandoned request keeps
  // spending quota and holding a subprocess.
  const timer = setTimeout(() => controller.abort(), params.cfg.semanticTimeoutMs);
  try {
    return await searchWithContext({
      query: params.query,
      workspaceRoot: params.workspaceRoot,
      apiKey: params.probe.apiKey,
      maxTurns: params.maxTurns ?? 3,
      maxResults: params.maxResults ?? 10,
      treeDepth: params.treeDepth ?? 3,
      excludePaths: params.excludePaths ?? [],
      includeContent: params.includeContent !== false,
      // A per-turn budget well under the ceiling, so the last round can still
      // produce an answer instead of being cut off mid-stream.
      timeoutMs: Math.max(10_000, Math.floor(params.cfg.semanticTimeoutMs / (params.maxTurns ?? 3) / 2)),
      signal: controller.signal,
      ...(params.subPath ? { subPath: params.subPath } : {}),
    });
  } catch (e) {
    if (controller.signal.aborted) {
      return {
        report: `Error: search was cancelled (client disconnected or exceeded ${params.cfg.semanticTimeoutMs} ms). Narrow the scope with \`path\`, or lower max_turns.`,
        fileCount: 0,
        meta: { treeDepth: params.treeDepth ?? 3, treeSizeKB: 0, fellBack: false, errorCode: 'CANCELLED' },
        files: [],
        truncatedFiles: 0,
      };
    }
    throw e;
  } finally {
    clearTimeout(timer);
    params.signal?.removeEventListener('abort', onAbort);
  }
}
