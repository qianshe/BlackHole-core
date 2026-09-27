/**
 * Shared mechanics of the fast-context search loop: repo map, answer parsing,
 * model-facing command schemas.
 *
 * Ported from dsh-assistant-optimization `lib/fast-context/shared.js`
 * (itself from fast-context-mcp `src/shared.mjs`, MIT).
 * Changes:
 *  - the system prompt moved to ./prompt.ts (it is prose, not code);
 *  - paths resolve through this repo's workspace guard (../util/fspaths.js);
 *  - the tree walker prunes node_modules/dist/... and caps entries per
 *    directory: a remote agent must not be able to make the daemon walk the
 *    whole disk on one call.
 *
 * The virtual root stays `/codebase` internally: the prompt, the model's tool
 * calls and the answer XML all speak that path, and it is mapped back to real
 * workspace paths only at the boundary (executor output remap + parseAnswer).
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveInWorkspace } from '../util/fspaths.js';

export const VIRTUAL_ROOT = '/codebase';

/** Repo-map ceiling: the endpoint's payload limit is ~346KB with ~26KB overhead. */
export const MAX_TREE_BYTES = 250 * 1024;

/** Injected after the last effective search round to force an answer. */
export const FINAL_FORCE_ANSWER =
  'No research turns remain. Call `answer` now using only verified evidence; omit uncertain files instead of guessing.';

/** Pruned from the repo map by name (dot-entries are pruned as well). */
const PRUNED_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', 'venv', 'target', 'out', '__pycache__', 'vendor']);

/** Per-directory listing cap: one huge folder must not eat the whole budget. */
const MAX_ENTRIES_PER_DIR = 500;

/** Convert an exclude pattern (a name or a simple glob) to an anchored RegExp. */
export function excludePatternToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!/[*?]/.test(pattern)) return new RegExp('^' + escaped + '$');
  let regex = '^';
  for (const c of pattern) {
    if (c === '*') regex += '.*';
    else if (c === '?') regex += '.';
    else if ('.+^${}()|[]\\'.includes(c)) regex += '\\' + c;
    else regex += c;
  }
  return new RegExp(regex + '$');
}

/**
 * Render a directory tree: root label first, then ├──/└── branches with │
 * indentation, sorted by name, hidden and pruned directories skipped.
 */
export function renderTree(root: string, maxDepth: number, opts: { excludeRegexes?: RegExp[]; virtualRoot?: string } = {}): string {
  const { excludeRegexes = [], virtualRoot } = opts;
  const lines = [virtualRoot ?? (path.basename(root) || root)];
  const walk = (dir: string, depth: number, prefix: string): void => {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries = entries.filter((e) => !e.name.startsWith('.') && !PRUNED_DIRS.has(e.name));
    if (excludeRegexes.length) entries = entries.filter((e) => !excludeRegexes.some((rx) => rx.test(e.name)));
    entries.sort((a, b) => a.name.localeCompare(b.name));
    entries = entries.slice(0, MAX_ENTRIES_PER_DIR);
    entries.forEach((entry, idx) => {
      const last = idx === entries.length - 1;
      lines.push(prefix + (last ? '└── ' : '├── ') + entry.name + (entry.isDirectory() ? '/' : ''));
      if (entry.isDirectory() && depth < maxDepth) {
        walk(path.join(dir, entry.name), depth + 1, prefix + (last ? '    ' : '│   '));
      }
    });
  };
  walk(root, 1, '');
  return lines.join('\n');
}

export interface RepoMap {
  tree: string;
  depth: number;
  sizeBytes: number;
  fellBack: boolean;
}

/**
 * Build the repo map with adaptive depth fallback: try the requested depth,
 * shrink until the output fits MAX_TREE_BYTES, finally degrade to a flat list.
 * A monorepo must still get a usable map, so degradation is never an error.
 */
export function getRepoMap(projectRoot: string, targetDepth = 3, excludePaths: string[] = []): RepoMap {
  const excludeRegexes = excludePaths.length ? excludePaths.map(excludePatternToRegex) : [];

  for (let level = targetDepth; level >= 1; level -= 1) {
    try {
      const treeStr = renderTree(projectRoot, level, { excludeRegexes, virtualRoot: VIRTUAL_ROOT });
      const sizeBytes = Buffer.byteLength(treeStr, 'utf-8');
      if (sizeBytes <= MAX_TREE_BYTES) {
        return { tree: treeStr, depth: level, sizeBytes, fellBack: level < targetDepth };
      }
    } catch {
      /* shallow one level and try again */
    }
  }

  try {
    let entries = fs.readdirSync(projectRoot).sort();
    if (excludeRegexes.length) entries = entries.filter((e) => !excludeRegexes.some((rx) => rx.test(e)));
    const treeStr = [VIRTUAL_ROOT, ...entries.map((e) => `├── ${e}`)].join('\n');
    return { tree: treeStr, depth: 0, sizeBytes: Buffer.byteLength(treeStr, 'utf-8'), fellBack: true };
  } catch {
    const treeStr = `${VIRTUAL_ROOT}\n(empty or inaccessible)`;
    return { tree: treeStr, depth: 0, sizeBytes: treeStr.length, fellBack: true };
  }
}

export interface AnswerFile {
  /** Workspace-relative path (forward slashes) — what the agent sees. */
  path: string;
  full_path: string;
  ranges: [number, number][];
}

/**
 * Turn the model's `<ANSWER><file path=".."><range>a-b</range></file></ANSWER>`
 * into real workspace paths. A path that escapes the workspace, or that does
 * not name an existing file, is dropped: the answer is a hypothesis, and only
 * verified candidates are handed back.
 */
export function parseAnswer(xmlText: string, projectRoot: string): { files: AnswerFile[] } {
  const files: AnswerFile[] = [];
  const fileRegex = /<file\s+path=(["'])([^"']+)\1>([\s\S]*?)<\/file>/g;
  let match: RegExpExecArray | null;
  while ((match = fileRegex.exec(xmlText)) !== null) {
    const virtual = match[2] as string;
    const rel = virtual.replace(/^\/codebase[/\\]?/, '').replace(/^[/\\]+/, '');
    let fullPath: string;
    try {
      fullPath = resolveInWorkspace(projectRoot, rel);
      if (path.relative(projectRoot, fullPath).startsWith('..')) continue;
      if (!fs.statSync(fullPath).isFile()) continue;
    } catch {
      continue;
    }

    const ranges: [number, number][] = [];
    const rangeRegex = /<range>(\d+)-(\d+)<\/range>/g;
    let rm: RegExpExecArray | null;
    while ((rm = rangeRegex.exec(match[3] as string)) !== null) {
      ranges.push([Number(rm[1]), Number(rm[2])]);
    }
    files.push({
      path: path.relative(projectRoot, fullPath).split(path.sep).join('/'),
      full_path: fullPath,
      ranges,
    });
  }
  return { files };
}

/** One restricted_exec slot: exactly one of rg / readfile / tree / ls / glob. */
function commandSchema(n: number): Record<string, unknown> {
  return {
    type: 'object',
    description: 'Command ' + n + ' to execute. Must be one of: rg, readfile, tree, ls, or glob.',
    oneOf: [
      {
        properties: {
          type: { type: 'string', const: 'rg', description: 'Search for patterns in files using ripgrep.' },
          pattern: { type: 'string', description: 'The regex pattern to search for.' },
          path: { type: 'string', description: 'The path to search in.' },
          include: { type: 'array', items: { type: 'string' }, description: 'File patterns to include.' },
          exclude: { type: 'array', items: { type: 'string' }, description: 'File patterns to exclude.' },
        },
        required: ['type', 'pattern', 'path'],
      },
      {
        properties: {
          type: { type: 'string', const: 'readfile', description: 'Read contents of a file with optional line range.' },
          file: { type: 'string', description: 'Path to the file to read.' },
          start_line: { type: 'integer', description: 'Starting line number (1-indexed).' },
          end_line: { type: 'integer', description: 'Ending line number (1-indexed).' },
        },
        required: ['type', 'file'],
      },
      {
        properties: {
          type: { type: 'string', const: 'tree', description: 'Display directory structure as a tree.' },
          path: { type: 'string', description: 'Path to the directory.' },
          levels: { type: 'integer', description: 'Number of directory levels.' },
        },
        required: ['type', 'path'],
      },
      {
        properties: {
          type: { type: 'string', const: 'ls', description: 'List files in a directory.' },
          path: { type: 'string', description: 'Path to the directory.' },
          long_format: { type: 'boolean' },
          all: { type: 'boolean' },
        },
        required: ['type', 'path'],
      },
      {
        properties: {
          type: { type: 'string', const: 'glob', description: 'Find files matching a glob pattern.' },
          pattern: { type: 'string' },
          path: { type: 'string' },
          type_filter: { type: 'string', enum: ['file', 'directory', 'all'] },
        },
        required: ['type', 'pattern', 'path'],
      },
    ],
  };
}

/**
 * The two tools the search agent may call: restricted_exec (the local command
 * fan-out) and answer (the terminal XML payload). JSON-encoded into the
 * request's tool-definitions field by the brain.
 */
export function buildToolSchemas(maxCommands = 8): { name: string; description: string; parameters: Record<string, unknown> }[] {
  const props: Record<string, unknown> = {};
  for (let i = 1; i <= maxCommands; i += 1) props['command' + i] = commandSchema(i);
  return [
    {
      name: 'restricted_exec',
      description: 'Execute restricted commands (rg, readfile, tree, ls, glob) in parallel.',
      parameters: { type: 'object', properties: props, required: ['command1'] },
    },
    {
      name: 'answer',
      description: 'Final answer with relevant files and line ranges.',
      parameters: {
        type: 'object',
        properties: { answer: { type: 'string', description: 'The final answer in XML format.' } },
        required: ['answer'],
      },
    },
  ];
}
