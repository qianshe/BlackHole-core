/**
 * Budget-limited content embedding and result formatting for context_search.
 *
 * Ported from dsh-assistant-optimization `lib/fast-context/content-embed.js`
 * (new in that port, not in the upstream MCP; same idea, typed).
 *
 * The search agent's prompt tells it to return ENTIRE semantic blocks, so a
 * range can be hundreds of lines. This module re-reads the ranges from disk at
 * format time (a cache hit therefore still returns fresh code) and emits two
 * independent sections:
 *
 *   Files:     one line per file with its ranges — scannable, code-free
 *   Contents:  the code of those ranges, fenced, `N:` line numbers
 *
 * The safety net is bytes, not lines: a range that fits the budget ships in
 * full, one that does not ships its head plus a marker saying what to `view`
 * for the rest. Every failure mode (missing file, binary, budget exhausted)
 * degrades to a marker line — embedding content must never fail the search.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { AnswerFile } from './shared.js';

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export interface Budgets {
  totalMaxBytes: number;
  fileMaxBytes: number;
  lineMaxChars: number;
}

/** Resolve the content budgets (env-tunable, clamped to sane bounds). */
export function resolveBudgets(): Budgets {
  return {
    // 128K/48K：一次摸底给足代码体（~32K token），面向长上下文 agent；
    // 报文走本机/自有隧道。截断有 meta.truncated_files + 续读行号，agent
    // 可自行收窄；再往上会挤压对话历史，交给 env 按需调。
    totalMaxBytes: intEnv('BH_SEMANTIC_CONTENT_MAX_BYTES', 131_072, 1024, 262_144),
    fileMaxBytes: intEnv('BH_SEMANTIC_CONTENT_FILE_MAX_BYTES', 49_152, 256, 131_072),
    lineMaxChars: intEnv('BH_SEMANTIC_CONTENT_LINE_MAX_CHARS', 400, 50, 10_000),
  };
}

/** Preview head for a salvaged file that came back with no ranges. */
const PREVIEW_LINES = 40;

/** Below this much budget there is no point writing a code fence. */
const MIN_USEFUL_BYTES = 256;

const LANG_BY_EXT: Record<string, string> = {
  '.ts': 'ts', '.mts': 'ts', '.cts': 'ts', '.tsx': 'tsx',
  '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'jsx',
  '.py': 'python', '.go': 'go', '.rs': 'rust', '.java': 'java',
  '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.hpp': 'cpp',
  '.cs': 'csharp', '.rb': 'ruby', '.php': 'php', '.swift': 'swift',
  '.kt': 'kotlin', '.sh': 'bash', '.yml': 'yaml', '.yaml': 'yaml',
  '.json': 'json', '.jsonc': 'json', '.md': 'markdown', '.css': 'css',
  '.scss': 'scss', '.less': 'less', '.html': 'html', '.vue': 'html',
  '.sql': 'sql', '.toml': 'toml', '.xml': 'xml', '.proto': 'protobuf',
  '.graphql': 'graphql',
};

function langTag(filePath: string): string {
  return LANG_BY_EXT[path.extname(String(filePath || '')).toLowerCase()] ?? 'text';
}

type ReadState = { state: 'missing' | 'binary' | 'ok'; lines: string[] | null };

function readFileLines(fullPath: string): ReadState {
  let content: string;
  try {
    content = fs.readFileSync(fullPath, 'utf-8');
  } catch {
    return { state: 'missing', lines: null };
  }
  if (content.slice(0, 8192).includes('\u0000')) return { state: 'binary', lines: null };
  return { state: 'ok', lines: content.split('\n') };
}

/**
 * One file's content block: fenced code with `N:` prefixes (the shape
 * `editor view` produces, so the agent can extend a range with a
 * view call), plus omission markers when a budget cut a range short.
 */
/** One file's content block plus whether any range was cut short by a budget. */
export function embedFileContent(
  file: AnswerFile,
  budgets: Budgets,
  totalLeft: { left: number },
): { block: string; truncated: boolean } {
  const ranges: [number, number][] =
    Array.isArray(file.ranges) && file.ranges.length > 0
      ? file.ranges.map(([s, e]) => [Math.max(1, Number(s) || 1), Math.max(1, Number(e) || 1)])
      : [[1, PREVIEW_LINES]];

  const blocks: string[] = [];
  let fileLeft = budgets.fileMaxBytes;
  let read: ReadState | null = null;
  let truncated = false;

  for (const [rawStart, rawEnd] of ranges) {
    if (fileLeft <= MIN_USEFUL_BYTES || totalLeft.left <= MIN_USEFUL_BYTES) {
      blocks.push(`(content omitted: budget exhausted; use view L${rawStart}-${rawEnd})`);
      truncated = true;
      continue;
    }
    if (read === null) {
      read = readFileLines(file.full_path);
      if (read.state === 'missing') {
        blocks.push('(content unavailable: file no longer exists)');
        return { block: blocks.join('\n'), truncated: false };
      }
      if (read.state === 'binary') {
        blocks.push('(content skipped: binary file)');
        return { block: blocks.join('\n'), truncated: false };
      }
    }

    const allLines = read.lines as string[];
    const lineCount = allLines.length;
    // A range starting past EOF is not clampable: the file shrank since the
    // search. Report it as stale instead of silently returning nothing.
    if (rawStart > lineCount) {
      blocks.push(`(range L${rawStart}-${rawEnd} is out of file bounds)`);
      continue;
    }
    const start = rawStart;
    const end = Math.min(rawEnd, lineCount);
    if (start > end) {
      blocks.push(`(range L${rawStart}-${rawEnd} is out of file bounds)`);
      continue;
    }

    const lines: string[] = [];
    for (let i = start; i <= end; i += 1) {
      const text = allLines[i - 1] ?? '';
      lines.push(`${i}: ${text.length > budgets.lineMaxChars ? text.slice(0, budgets.lineMaxChars) : text}`);
    }

    const fenceOpen = '```' + langTag(file.full_path) + '\n';
    const fenceClose = '```\n';
    const sizeOf = (body: string): number => Buffer.byteLength(fenceOpen + body + fenceClose, 'utf-8');
    const limit = Math.min(fileLeft, totalLeft.left);

    let body = lines.join('\n') + '\n';
    while (lines.length > 1 && sizeOf(body) > limit) {
      lines.pop();
      body = lines.join('\n') + '\n';
    }
    if (sizeOf(body) > limit) {
      blocks.push(`(content omitted: budget exhausted; use view L${start}-${end})`);
      truncated = true;
      continue;
    }

    const size = sizeOf(body);
    fileLeft -= size;
    totalLeft.left -= size;
    blocks.push(fenceOpen + body + fenceClose);
    const embedded = lines.length;
    if (embedded < end - start + 1) {
      blocks.push(`(L${start + embedded}-${end} omitted: content budget; use view for the rest)`);
      truncated = true;
    } else if (end < rawEnd) {
      blocks.push(`(L${end + 1}-${rawEnd} omitted: beyond end of file)`);
    }
  }

  return { block: blocks.join('\n'), truncated };
}

function rangeLabel(entry: AnswerFile): string {
  return Array.isArray(entry.ranges) && entry.ranges.length > 0
    ? entry.ranges.map(([s, e]) => `L${s}-${e}`).join(', ')
    : 'preview';
}

/**
 * The tool's payload: the file list first (complete, no code), then the code
 * section. Never interleaved — the agent scans the list to decide what to
 * read, and only then consumes tokens on bodies. includeContent=false ships the
 * list alone, which is the right call when the agent just wants paths.
 *
 * Paths are workspace-relative (`src/foo.ts`), the same form
 * `editor` accepts.
 */
export interface FormattedResult {
  report: string;
  /** 截断统计：agent 据此判断是否缩小范围重搜或转 view 逐文件读。 */
  truncatedFiles: number;
  totalBudgetBytes: number;
}

export function formatResult(files: AnswerFile[], opts: { includeContent?: boolean; budgets?: Budgets } = {}): FormattedResult {
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return { report: 'No files found.', truncatedFiles: 0, totalBudgetBytes: 0 };
  const budgets = opts.budgets ?? resolveBudgets();
  const n = list.length;

  const parts: string[] = [`Found ${n} relevant files.`, '', 'Files:'];
  list.forEach((file, i) => {
    parts.push(`  [${i + 1}/${n}] ${file.path} (${rangeLabel(file)})`);
  });

  let truncatedFiles = 0;
  if (opts.includeContent !== false) {
    parts.push('', 'Contents:');
    const totalLeft = { left: budgets.totalMaxBytes };
    list.forEach((file, i) => {
      parts.push(`  [${i + 1}/${n}] ${file.path} (${rangeLabel(file)})`);
      const embedded = embedFileContent(file, budgets, totalLeft);
      parts.push(embedded.block);
      if (embedded.truncated) truncatedFiles += 1;
      parts.push('');
    });
    // 总预算状态：agent 看得见"这次被截了多少"，才会主动收窄重搜
    if (truncatedFiles > 0) {
      parts.push(
        `(result truncated: ${truncatedFiles} of ${n} files lost some content to the ${Math.round(budgets.totalMaxBytes / 1024)}KB budget; ` +
          'consider a narrower query or path, or set include_content=false for a path+range list only)',
      );
    }
  }

  return { report: parts.join('\n').replace(/\n+$/, ''), truncatedFiles, totalBudgetBytes: budgets.totalMaxBytes };
}
