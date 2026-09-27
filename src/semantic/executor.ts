/**
 * The restricted command executor for semantic search: rg / readfile / tree /
 * ls / glob, run locally and fed back to the search agent.
 *
 * Ported from dsh-assistant-optimization `lib/fast-context/executor.js`
 * (itself from fast-context-mcp `src/executor.mjs`, MIT).
 * Changes for this host:
 *  - every path is resolved by the workspace guard, so a model-supplied path
 *    cannot leave the session's workspace (lexical + realpath checks, the same
 *    pair `editor` uses);
 *  - ripgrep resolution: explicit env, PATH, a copy bundled with a dsh
 *    installation, and finally a pure-JS scanner — blackhole ships no
 *    native dependency, so the fallback keeps `rg` working on a machine that
 *    has never seen ripgrep;
 *  - output is remapped from the virtual `/codebase` root to real workspace
 *    paths before it goes back to the model, so what it reads is what
 *    `editor` accepts;
 *  - a per-walk file budget bounds how much of the disk one call may touch.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { renderTree, VIRTUAL_ROOT } from './shared.js';
import { resolveInWorkspace } from '../util/fspaths.js';

const execFileAsync = promisify(execFile);

/** Tuning knobs; all clamped, all optional. Documented in README. */
function intEnv(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/** Lines returned per command (the reference's own ceiling; results are fed
 *  back into a prompt, so verbosity here costs turns on every later call). */
const RESULT_MAX_LINES = intEnv('BH_SEMANTIC_RESULT_MAX_LINES', 50, 1, 500);
const LINE_MAX_CHARS = intEnv('BH_SEMANTIC_LINE_MAX_CHARS', 250, 20, 10_000);
/** Files a single rg/tree/ls/glob walk may open. */
const WALK_FILE_BUDGET = intEnv('BH_SEMANTIC_WALK_FILE_BUDGET', 20_000, 100, 500_000);
/** Files above this size are skipped by the JS fallback scanner. */
const SCAN_MAX_FILE_BYTES = intEnv('BH_SEMANTIC_SCAN_MAX_FILE_BYTES', 2 * 1024 * 1024, 1024, 64 * 1024 * 1024);
/** Skip a directory by name (dot-entries are always skipped). */
const PRUNED_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', 'venv', '.venv', 'target', 'out', '__pycache__', 'vendor']);
const RG_TIMEOUT_MS = intEnv('BH_SEMANTIC_RG_TIMEOUT_MS', 30_000, 1_000, 300_000);
/**
 * Dirs excluded from `rg` unless the agent overrides them.
 * The reference relies on the prompt to say this ("Default EXCLUDES for
 * speed, apply via the exclude array") and on rg respecting .gitignore.
 * A workspace with no .gitignore (or with node_modules checked in) then
 * floods the result, so the tool enforces the list itself: an agent that
 * sees the promise kept does not have to spend a turn fixing it.
 */
const DEFAULT_RG_EXCLUDES = ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/coverage/**', '**/__pycache__/**', '**/.venv/**', '**/target/**'];

const TREE_DEFAULT_LEVELS = 3;
const TREE_MAX_LEVELS = 10;
const GLOB_MAX_MATCHES = 100;

// ─── ripgrep resolution ────────────────────────────────────

interface RgResolution {
  /** Absolute path to an rg binary, or '' when none was found. */
  bin: string;
  /** Where it came from: env | dependency | path | dsh-bundled | none. */
  source: string;
  /** Why nothing was found (only set when bin is ''). */
  problems: string[];
}

let _rg: RgResolution | null = null;

/** Candidate locations of an rg binary shipped by an existing dsh install. */
function dshBundledCandidates(env: NodeJS.ProcessEnv): string[] {
  const home = env.USERPROFILE ?? env.HOME ?? '';
  if (home === '') return [];
  const pkg = path.join('@deepseek-ai', 'dsh', 'node_modules', '@vscode');
  const dirs = [
    path.join(home, 'AppData', 'Roaming', 'npm', 'node_modules'),
    path.join(home, '.dsh', 'profiles', 'node_modules'),
    path.join(home, '.dsh', 'profiles', 'web', 'node_modules'),
    '/usr/local/lib/node_modules',
    path.join(home, '.npm-global', 'node_modules'),
  ];
  const out: string[] = [];
  for (const dir of dirs) {
    for (const variant of ['ripgrep-win32-x64', 'ripgrep-darwin-x64', 'ripgrep-darwin-arm64', 'ripgrep-linux-x64', 'ripgrep']) {
      out.push(path.join(dir, pkg, variant, 'bin', 'rg'));
      out.push(path.join(dir, pkg, variant, 'bin', 'rg.exe'));
    }
    // @vscode/ripgrep's own main export resolves the platform binary; probing
    // the package dir directly avoids requiring it from an unknown cwd.
    out.push(path.join(dir, pkg, 'ripgrep', 'bin', 'rg'));
    out.push(path.join(dir, pkg, 'ripgrep', 'bin', 'rg.exe'));
  }
  return out;
}

/** Locate `rg` on PATH without spawning anything. */
function rgOnPath(env: NodeJS.ProcessEnv): string {
  const names = process.platform === 'win32' ? ['rg.exe', 'rg.cmd', 'rg.bat'] : ['rg'];
  for (const dir of (env.PATH ?? '').split(path.delimiter).filter((d) => d !== '')) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        /* an unreadable PATH entry is ordinary */
      }
    }
  }
  return '';
}

/**
 * Resolve the search binary once per process. A missing rg is not fatal:
 * `rg` commands fall back to the JS scanner below.
 *
 * No `import.meta` here on purpose: the vsix bundles the daemon as CJS, where
 * esbuild warns `import.meta.url` is unavailable. A `@vscode/ripgrep`
 * dependency probe would also be dead code in this repo (pnpm's strict layout
 * only exposes declared dependencies), so the ladder is: explicit env override
 * → PATH → an rg bundled with an existing dsh install → the JS scanner.
 */
export function resolveRg(env: NodeJS.ProcessEnv = process.env): RgResolution {
  if (_rg) return _rg;
  const problems: string[] = [];

  for (const [key, raw] of [['BH_SEMANTIC_RG', env.BH_SEMANTIC_RG], ['BLACKHOLE_RG', env.BLACKHOLE_RG]] as const) {
    const override = (raw ?? '').trim();
    if (override === '') continue;
    if (fs.existsSync(override)) {
      _rg = { bin: override, source: 'env', problems };
      return _rg;
    }
    problems.push(`${key} does not exist: ${override}`);
  }

  const onPath = rgOnPath(env);
  if (onPath !== '') {
    _rg = { bin: onPath, source: 'path', problems };
    return _rg;
  }

  for (const candidate of dshBundledCandidates(env)) {
    if (fs.existsSync(candidate)) {
      _rg = { bin: candidate, source: 'dsh-bundled', problems };
      return _rg;
    }
  }

  problems.push('no rg on PATH and no bundled copy found; using the built-in JS scanner');
  _rg = { bin: '', source: 'none', problems };
  return _rg;
}

/** One-line description of the search backend, for the daemon startup log. */
export function describeSearchEngine(): string {
  const rg = resolveRg();
  return rg.bin === '' ? `JS scanner (${rg.problems.join('; ')})` : `ripgrep ${rg.bin} (${rg.source})`;
}

/** Forget the cached rg resolution (tests). */
export function _resetRgCache(): void {
  _rg = null;
}

// ─── Executor ──────────────────────────────────────────────

export interface CommandResult {
  output: string;
}

/**
 * Executes one `restricted_exec` payload against one workspace. Constructed per
 * search so the collected rg patterns (the "how did you find this" trail) can
 * be reported with the answer.
 */
export class ToolExecutor {
  readonly root: string;
  private readonly signal: AbortSignal | null;
  /** Every rg pattern the agent used, for the answer's grep-keyword trail. */
  readonly collectedRgPatterns: string[] = [];

  constructor(workspaceRoot: string, opts: { signal?: AbortSignal | null } = {}) {
    this.root = path.resolve(workspaceRoot);
    this.signal = opts.signal ?? null;
  }

  /** Virtual `/codebase/...` (or any workspace-relative path) → absolute. */
  private real(virtual: string): string {
    const rel = String(virtual).replace(/^[/\\]codebase[/\\]?/, '').replace(/^[/\\]+/, '');
    return resolveInWorkspace(this.root, rel === '' ? '.' : rel);
  }

  /** Absolute workspace path → `/codebase`-prefixed, as the prompt speaks it. */
  private virtual(abs: string): string {
    const rel = path.relative(this.root, abs).split(path.sep).join('/');
    return rel === '' ? VIRTUAL_ROOT : `${VIRTUAL_ROOT}/${rel}`;
  }

  /** 50-line / 250-char-per-line ceiling: results re-enter the prompt. */
  private static truncate(text: string): string {
    const lines = String(text).split('\n');
    const limit = Math.min(lines.length, RESULT_MAX_LINES);
    const kept = lines.slice(0, limit).map((l) => (l.length > LINE_MAX_CHARS ? l.slice(0, LINE_MAX_CHARS) : l));
    let out = kept.join('\n');
    if (lines.length > RESULT_MAX_LINES) out += '\n... (lines truncated) ...';
    return out;
  }

  /**
   * Rewrite command output into the virtual root.
   *
   * `rg --no-heading` lines are `<path>:<line>:<text>`, and only the path
   * part gets separator-normalised: code text is copied verbatim, since
   * backslashes inside it are the agent's business, not ours. Anything that
   * does not start with the root (stderr, a tree render) is passed through
   * with plain root replacement.
   */
  private toVirtual(text: string): string {
    const forward = this.root.split(path.sep).join('/');
    const out: string[] = [];
    for (const line of String(text).split('\n')) {
      const match = line.match(/^(.+?):(\d+):([\s\S]*)$/);
      if (match) {
        const asFile = match[1] as string;
        const native = asFile.replace(/[\\\/]/g, path.sep);
        if (native.startsWith(this.root + path.sep)) {
          const rel = native.slice(this.root.length + 1);
          out.push(`${VIRTUAL_ROOT}/${rel.split(path.sep).join('/')}:${match[2]}:${match[3]}`);
          continue;
        }
      }
      out.push(line.split(this.root).join(VIRTUAL_ROOT).split(forward).join(VIRTUAL_ROOT));
    }
    return out.join('\n');
  }

  private guardPath(input: string, kind: 'path' | 'file'): string | CommandResult {
    if (typeof input !== 'string' || input.trim() === '') {
      return { output: `Error: missing or invalid ${kind}` };
    }
    try {
      return this.real(input);
    } catch (e) {
      return { output: `Error: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  // ─── rg ───────────────────────────────────────────────────

  /**
   * ripgrep with the reference's flags, or the JS scanner when no rg exists.
   * `include`/`exclude` are globs applied to workspace-relative paths.
   */
  async rg(pattern: string, searchPath: string, include: string[] | null = null, exclude: string[] | null = null): Promise<string> {
    if (typeof pattern !== 'string' || pattern === '') return 'Error: missing or invalid pattern';
    const target = this.guardPath(searchPath, 'path');
    if (typeof target !== 'string') return target.output;
    if (!fs.existsSync(target)) return `Error: path does not exist: ${searchPath}`;
    this.collectedRgPatterns.push(pattern);

    const rg = resolveRg();
    if (rg.bin === '') return this.rgFallback(pattern, target, include, exclude);

    const args = ['--no-heading', '-n', '--max-count', '50', pattern, target];
    for (const g of include ?? []) args.push('--glob', g);
    const excludes = exclude?.length ? exclude : DEFAULT_RG_EXCLUDES;
    for (const g of excludes) args.push('--glob', `!${g}`);

    try {
      const { stdout } = await execFileAsync(rg.bin, args, {
        timeout: RG_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, RIPGREP_CONFIG_PATH: '' },
        encoding: 'utf-8',
        ...(this.signal ? { signal: this.signal } : {}),
      });
      return ToolExecutor.truncate(this.toVirtual(stdout || '(no matches)'));
    } catch (e) {
      const err = e as { code?: number; status?: number; name?: string; message?: string; stderr?: string };
      if (err.name === 'AbortError' || err.code === undefined && err.status === undefined && /aborted/i.test(err.message ?? '')) {
        return 'Error: aborted';
      }
      // rg exits 1 on "no matches" — an ordinary answer, not a failure.
      if (err.code === 1 || err.status === 1) return this.rgFallback(pattern, target, include, exclude);
      if (err.stderr) return ToolExecutor.truncate(this.toVirtual(String(err.stderr)));
      return `Error: ${err.message}`;
    }
  }

  /**
   * Pure-JS stand-in for `rg`: same output shape (`path:line:text`), fixed
   * regex semantics, pruned directories, and the same walk budget. Used only
   * when no ripgrep binary can be found.
   */
  private async rgFallback(
    pattern: string,
    target: string,
    include: string[] | null,
    exclude: string[] | null,
  ): Promise<string> {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern);
    } catch (e) {
      return `Error: invalid regex (${e instanceof Error ? e.message : String(e)}); ripgrep is not available on this machine`;
    }
    const stat = fs.statSync(target);
    const files = stat.isDirectory() ? this.walk(target) : [target];
    const includeRx = (include ?? []).map(globToRegex);
    const effectiveExclude = exclude?.length ? exclude : DEFAULT_RG_EXCLUDES;
    const excludeRx = effectiveExclude.map(globToRegex);

    const hits: string[] = [];
    for (const file of files) {
      if (this.signal?.aborted) return 'Error: aborted';
      const rel = path.relative(this.root, file).split(path.sep).join('/');
      if (includeRx.length && !includeRx.some((rx) => rx.test(rel))) continue;
      if (excludeRx.some((rx) => rx.test(rel))) continue;
      let content: string;
      try {
        if (fs.statSync(file).size > SCAN_MAX_FILE_BYTES) continue;
        content = fs.readFileSync(file, 'utf-8');
      } catch {
        continue;
      }
      if (content.includes('\u0000')) continue; // binary
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        if (!regex.test(lines[i] as string)) continue;
        hits.push(`${this.virtual(file)}:${i + 1}:${lines[i]}`);
        if (hits.length >= RESULT_MAX_LINES) {
          return ToolExecutor.truncate(this.toVirtual(hits.join('\n')));
        }
      }
    }
    return hits.length ? ToolExecutor.truncate(this.toVirtual(hits.join('\n'))) : '(no matches)';
  }

  /** Bounded recursive file walk: dot/pruned dirs skipped, budget-capped. */
  private walk(dir: string): string[] {
    const out: string[] = [];
    const stack = [dir];
    while (stack.length && out.length < WALK_FILE_BUDGET) {
      const current = stack.pop() as string;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (out.length >= WALK_FILE_BUDGET) return out;
        if (entry.name.startsWith('.') || PRUNED_DIRS.has(entry.name)) continue;
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isFile()) out.push(full);
      }
    }
    return out;
  }

  // ─── readfile ─────────────────────────────────────────────

  readfile(file: string, startLine: number | null = null, endLine: number | null = null): string {
    const target = this.guardPath(file, 'file');
    if (typeof target !== 'string') return target.output;
    try {
      if (!fs.statSync(target).isFile()) return `Error: file not found: ${file}`;
    } catch {
      return `Error: file not found: ${file}`;
    }
    let content: string;
    try {
      content = fs.readFileSync(target, 'utf-8');
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
    const lines = content.split('\n');
    const start = Math.max(1, startLine ?? 1);
    const end = Math.min(lines.length, endLine ?? lines.length);
    if (start > lines.length) return '(range beyond end of file)';
    const body: string[] = [];
    for (let i = start; i <= end; i += 1) {
      const text = (lines[i - 1] ?? '').length > LINE_MAX_CHARS ? (lines[i - 1] as string).slice(0, LINE_MAX_CHARS) : lines[i - 1] ?? '';
      body.push(`${i}:${text}`);
    }
    return ToolExecutor.truncate(body.join('\n'));
  }

  // ─── tree / ls / glob ─────────────────────────────────────

  tree(treePath: string, levels: number | null = null): string {
    const target = this.guardPath(treePath, 'path');
    if (typeof target !== 'string') return target.output;
    try {
      if (!fs.statSync(target).isDirectory()) return `Error: dir not found: ${treePath}`;
    } catch {
      return `Error: dir not found: ${treePath}`;
    }
    const depth = Math.min(Math.max(levels ?? TREE_DEFAULT_LEVELS, 1), TREE_MAX_LEVELS);
    try {
      // Root the render at the virtual path so the output is re-enterable.
      return ToolExecutor.truncate(renderTree(target, depth, { virtualRoot: this.virtual(target) }));
    } catch {
      return `Error: failed to generate tree for ${treePath}`;
    }
  }

  ls(listPath: string, longFormat = false, all = false): string {
    const target = this.guardPath(listPath, 'path');
    if (typeof target !== 'string') return target.output;
    let entries: string[];
    try {
      if (!fs.statSync(target).isDirectory()) return `Error: not a directory: ${listPath}`;
      entries = fs.readdirSync(target).sort();
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
    if (!all) entries = entries.filter((e) => !e.startsWith('.'));
    if (!longFormat) return ToolExecutor.truncate(entries.join('\n'));

    const lines = [`total ${entries.length}`];
    for (const name of entries) {
      try {
        const st = fs.statSync(path.join(target, name));
        lines.push(`${st.isDirectory() ? 'd' : '-'}rwxr-xr-x  1 user  staff ${String(st.size).padStart(8)} ${name}`);
      } catch {
        lines.push(`?---------  ? ?     ?        ? ${name}`);
      }
    }
    return ToolExecutor.truncate(lines.join('\n'));
  }

  glob(pattern: string, globPath: string, typeFilter = 'all'): string {
    if (typeof pattern !== 'string' || pattern === '') return 'Error: missing or invalid pattern';
    const target = this.guardPath(globPath, 'path');
    if (typeof target !== 'string') return target.output;
    const rx = globToRegex(pattern);
    const matches: string[] = [];
    for (const file of this.walk(target)) {
      const rel = path.relative(target, file).split(path.sep).join('/');
      const base = path.basename(file);
      if (!rx.test(rel) && !rx.test(base)) continue;
      try {
        const st = fs.statSync(file);
        if (typeFilter === 'file' && !st.isFile()) continue;
        if (typeFilter === 'directory' && !st.isDirectory()) continue;
      } catch {
        continue;
      }
      matches.push(file);
      if (matches.length >= GLOB_MAX_MATCHES) break;
    }
    if (!matches.length) return '(no matches)';
    return matches.sort().map((m) => this.virtual(m)).join('\n');
  }

  // ─── dispatch ─────────────────────────────────────────────

  /** One command object from the agent's restricted_exec call. */
  async execCommand(cmd: Record<string, unknown> | undefined): Promise<string> {
    if (!cmd || typeof cmd !== 'object') return 'Error: missing or invalid command';
    const type = typeof cmd.type === 'string' ? cmd.type : '';
    switch (type) {
      case 'rg':
        return this.rg(String(cmd.pattern ?? ''), String(cmd.path ?? ''), asStringArray(cmd.include), asStringArray(cmd.exclude));
      case 'readfile':
        return this.readfile(String(cmd.file ?? ''), asInt(cmd.start_line), asInt(cmd.end_line));
      case 'tree':
        return this.tree(String(cmd.path ?? ''), asInt(cmd.levels));
      case 'ls':
        return this.ls(String(cmd.path ?? ''), cmd.long_format === true, cmd.all === true);
      case 'glob':
        return this.glob(String(cmd.pattern ?? ''), String(cmd.path ?? ''), typeof cmd.type_filter === 'string' ? cmd.type_filter : 'all');
      default:
        return `Error: unknown command type '${type}'`;
    }
  }

  /**
   * Run every `commandN` slot in parallel and format them the way the prompt
   * shows them: `<commandN_result>` blocks.
   */
  async execToolCall(args: Record<string, unknown>): Promise<string> {
    if (!args || typeof args !== 'object') return 'Error: missing or invalid tool args';
    const keys = Object.keys(args).filter((k) => k.startsWith('command')).sort();
    const results = await Promise.all(
      keys.map(async (key) => `<${key}_result>\n${await this.execCommand(args[key] as Record<string, unknown>)}\n</${key}_result>`),
    );
    return results.join('');
  }
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out = value.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
  return out.length ? out : null;
}

function asInt(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** Glob → RegExp over '/'-separated relative paths (** crosses directories). */
export function globToRegex(pattern: string): RegExp {
  let re = '^';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i] as string;
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i += 2;
        if (pattern[i] === '/') i += 1;
        continue;
      }
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '[') {
      const end = pattern.indexOf(']', i);
      if (end === -1) re += '\\[';
      else {
        re += pattern.slice(i, end + 1);
        i = end;
      }
    } else if ('.+^${}()|\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
    i += 1;
  }
  re += '$';
  try {
    return new RegExp(re);
  } catch {
    return new RegExp('^\\.$');
  }
}
