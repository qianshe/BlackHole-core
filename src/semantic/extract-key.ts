/**
 * Devin / Windsurf API key extraction from a local installation.
 *
 * Ported from dsh-assistant-optimization `lib/fast-context/extract-key.js`
 * (itself from fast-context-mcp `src/extract-key.mjs`, MIT; that port already
 * replaced the reference's sql.js WASM dependency with Node's built-in
 * `node:sqlite`, which blackhole uses for its own storage anyway — so this
 * stays zero-dependency).
 *
 * Used ONLY when the operator opts in with `BLACKHOLE_SEMANTIC=auto`; see
 * ./key.ts for why local credential discovery is not the default here.
 *
 * Non-official protocol note: the key this reads belongs to a proprietary
 * editor/CLI, and ./brain.ts calls an undocumented endpoint with it. Endpoint
 * changes, rate limits and ToS are the operator's risk, not a contract.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** Fields a credentials.toml may carry the key under. */
const TOML_API_KEY_FIELDS = [
  'api_key',
  'apiKey',
  'devin_api_key',
  'devinApiKey',
  'windsurf_api_key',
  'windsurfApiKey',
  'access_token',
  'accessToken',
  'token',
];

export interface ExtractOptions {
  platformName?: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}

export interface CredentialSource {
  type: 'toml' | 'sqlite';
  path: string;
}

export interface KeyResult {
  api_key?: string;
  db_path: string;
  source_type?: string;
  error?: string;
  hint?: string;
  tried_paths?: string[];
}

/**
 * Candidate state.vscdb paths per platform. "Devin" is the current product
 * name; Deviv/Windsurf stay as compatibility fallbacks.
 */
export function getDbPathCandidates(opts: ExtractOptions = {}): string[] {
  const plat = opts.platformName ?? os.platform();
  const home = opts.homeDir ?? os.homedir();
  const env = opts.env ?? process.env;

  if (plat === 'darwin') {
    return ['Devin', 'Deviv', 'Windsurf'].map((app) =>
      path.join(home, 'Library', 'Application Support', app, 'User', 'globalStorage', 'state.vscdb'),
    );
  }
  if (plat === 'win32') {
    const appdata = env.APPDATA ?? '';
    if (appdata === '') throw new Error('Cannot determine APPDATA path');
    return ['Devin', 'Deviv', 'Windsurf'].map((app) =>
      path.join(appdata, app, 'User', 'globalStorage', 'state.vscdb'),
    );
  }
  const config = env.XDG_CONFIG_HOME ?? path.join(home, '.config');
  return ['Devin', 'Deviv', 'Windsurf'].map((app) =>
    path.join(config, app, 'User', 'globalStorage', 'state.vscdb'),
  );
}

/** Preferred state.vscdb path for this platform. */
export function getDbPath(): string {
  return getDbPathCandidates()[0] as string;
}

/**
 * Devin CLI credential candidates. WSL presents as Linux, so the CLI login
 * path is the Linux one.
 */
export function getCliCredentialPathCandidates(opts: ExtractOptions = {}): string[] {
  const plat = opts.platformName ?? os.platform();
  const home = opts.homeDir ?? os.homedir();
  if (plat !== 'linux') return [];
  return [path.join(home, '.local', 'share', 'devin', 'credentials.toml')];
}

/** Every credential source in lookup order (CLI login first, then editors). */
export function getCredentialSources(opts: ExtractOptions = {}): CredentialSource[] {
  const toml = getCliCredentialPathCandidates(opts).map((p) => ({ type: 'toml' as const, path: p }));
  const sqlite = getDbPathCandidates(opts).map((p) => ({ type: 'sqlite' as const, path: p }));
  return [...toml, ...sqlite];
}

/** Pull the first api-key-looking field out of credentials.toml content. */
export function extractApiKeyFromToml(text: string): string {
  for (const field of TOML_API_KEY_FIELDS) {
    const re = new RegExp('^\\s*' + field + '\\s*=\\s*(?:"([^"]+)"|\'([^\']+)\'|([^\\s#]+))', 'm');
    const match = text.match(re);
    const value = (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim();
    if (value !== '') return value;
  }
  return text.match(/\bsk-[A-Za-z0-9_-]+\b/)?.[0] ?? '';
}

function extractKeyFromToml(credentialsPath: string): KeyResult {
  if (!fs.existsSync(credentialsPath)) {
    return {
      error: `Devin CLI credentials not found: ${credentialsPath}`,
      hint: 'Run devin login inside WSL/Linux, then retry.',
      db_path: credentialsPath,
      source_type: 'devin_cli_credentials',
    };
  }
  let text: string;
  try {
    text = fs.readFileSync(credentialsPath, 'utf8');
  } catch (e) {
    return {
      error: `Failed to read Devin CLI credentials: ${e instanceof Error ? e.message : String(e)}`,
      db_path: credentialsPath,
      source_type: 'devin_cli_credentials',
    };
  }
  const apiKey = extractApiKeyFromToml(text);
  if (apiKey === '') {
    return {
      error: 'Devin CLI credentials did not contain an API key',
      hint: 'Run devin login inside WSL/Linux, then retry.',
      db_path: credentialsPath,
      source_type: 'devin_cli_credentials',
    };
  }
  return { api_key: apiKey, db_path: credentialsPath, source_type: 'devin_cli_credentials' };
}

/**
 * Load `node:sqlite` with its ExperimentalWarning suppressed.
 *
 * Node 22 still marks node:sqlite experimental and prints a warning on first
 * import. The daemon uses it for storage too, but this path runs during
 * startup key discovery, where a stray warning line is confusing. The filter
 * is installed for the import only, restored right after, and matches nothing
 * but the SQLite warning.
 */
async function loadNodeSqlite(): Promise<{ DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => SqliteDb }> {
  const emit = process.emit;
  process.emit = function patched(name: string | symbol, ...args: unknown[]): boolean | void {
    const warning = args[0] as { name?: string; message?: string } | undefined;
    if (name === 'warning' && warning?.name === 'ExperimentalWarning' && /SQLite/i.test(String(warning.message ?? ''))) {
      return false;
    }
    return (emit as (n: string | symbol, ...a: unknown[]) => boolean).apply(process, [name, ...args]);
  } as typeof process.emit;
  try {
    const mod = (await import('node:sqlite')) as unknown as {
      DatabaseSync: new (p: string, o?: { readOnly?: boolean }) => SqliteDb;
    };
    // The warning may land one tick after the import resolves.
    await new Promise((r) => setTimeout(r, 0));
    return mod;
  } finally {
    process.emit = emit;
  }
}

interface SqliteDb {
  prepare(sql: string): { get(param: string): { value: unknown } | undefined };
  close(): void;
}

/**
 * Read the key out of a Devin/Windsurf state.vscdb.
 *
 * The live file is write-locked by the running editor, so it is copied to a
 * temp snapshot first and that snapshot opened read-only — the reason this
 * module works while the editor is open.
 */
async function extractKeyFromDb(dbPath: string): Promise<KeyResult> {
  if (!fs.existsSync(dbPath)) {
    return {
      error: `Windsurf/Devin database not found: ${dbPath}`,
      hint: 'Ensure Windsurf or Devin is installed and logged in.',
      db_path: dbPath,
    };
  }

  let DatabaseSync: new (p: string, o?: { readOnly?: boolean }) => SqliteDb;
  try {
    ({ DatabaseSync } = await loadNodeSqlite());
  } catch (e) {
    return {
      error: `node:sqlite unavailable: ${e instanceof Error ? e.message : String(e)}`,
      hint: 'Node 22.5+ is required for local key discovery; set BLACKHOLE_SEMANTIC_KEY instead.',
      db_path: dbPath,
    };
  }

  const snapshot = path.join(os.tmpdir(), `blackhole-key-${process.pid}-${Date.now()}.vscdb`);
  let db: SqliteDb | undefined;
  try {
    fs.copyFileSync(dbPath, snapshot);
    db = new DatabaseSync(snapshot, { readOnly: true });
  } catch (e) {
    try {
      fs.rmSync(snapshot, { force: true });
    } catch {
      /* best effort */
    }
    return { error: `Failed to open database: ${e instanceof Error ? e.message : String(e)}`, db_path: dbPath };
  }

  try {
    const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get('windsurfAuthStatus');
    if (!row) {
      return {
        error: 'windsurfAuthStatus record not found',
        hint: 'Ensure Windsurf or Devin is logged in.',
        db_path: dbPath,
      };
    }
    let data: { apiKey?: string };
    try {
      data = JSON.parse(String(row.value)) as { apiKey?: string };
    } catch {
      return { error: 'windsurfAuthStatus data parse failed', db_path: dbPath };
    }
    const apiKey = data.apiKey ?? '';
    if (apiKey === '') return { error: 'apiKey field is empty', db_path: dbPath };
    return { api_key: apiKey, db_path: dbPath };
  } catch (e) {
    return { error: `Extraction failed: ${e instanceof Error ? e.message : String(e)}`, db_path: dbPath };
  } finally {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    try {
      fs.rmSync(snapshot, { force: true });
    } catch {
      /* best effort */
    }
  }
}

/**
 * Extract the key from the first available credential source. Reports every
 * failure as data; a missing installation is an ordinary outcome, not an error.
 */
export async function extractKey(dbPath?: string): Promise<KeyResult> {
  const sources: CredentialSource[] = dbPath
    ? [{ type: dbPath.endsWith('.toml') ? 'toml' : 'sqlite', path: dbPath }]
    : getCredentialSources();
  const triedPaths: string[] = [];
  let firstExistingError: KeyResult | null = null;

  for (const source of sources) {
    triedPaths.push(source.path);
    if (!fs.existsSync(source.path)) continue;
    const result = source.type === 'toml' ? extractKeyFromToml(source.path) : await extractKeyFromDb(source.path);
    if (result.api_key) return result;
    if (!firstExistingError) firstExistingError = result;
  }

  if (firstExistingError) return { ...firstExistingError, tried_paths: triedPaths };
  return {
    error: 'Windsurf/Devin credential source not found',
    hint: 'Ensure Devin or Windsurf is installed and logged in.',
    db_path: sources[0]?.path ?? '',
    tried_paths: triedPaths,
  };
}
