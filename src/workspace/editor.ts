import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { checkedPathInWorkspace } from '../util/fspaths.js';

const MAX_OUTPUT_CHARS = 16_000;

function clip(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return text.slice(0, MAX_OUTPUT_CHARS) + `\n\n[... output truncated at ${MAX_OUTPUT_CHARS} chars ...]`;
}

/** Logical file lines: a terminal newline terminates the last line; it does not create a phantom extra line. */
function logicalLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function lineAtOffset(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** Diff accounting keeps the historical newline-sensitive behavior. */
function toLines(text: string): string[] {
  return text === '' ? [] : text.replace(/\r\n/g, '\n').split('\n');
}

/** cat -n style, one-based line numbers, tabs preserved. */
function numberLines(content: string, startLine = 1): string {
  return logicalLines(content).map((l, i) => `${String(startLine + i).padStart(6, ' ')}\t${l}`).join('\n');
}

/** Line-level diff stats via LCS DP with a rolling row (O(m) extra space).
 *  Falls back to a length-difference estimate above 4M matrix cells. */
function diffLines(before: string, after: string): { added: number; removed: number } {
  const a = toLines(before);
  const b = toLines(after);
  const n = a.length;
  const m = b.length;
  if (n * m > 4_000_000) {
    const d = n - m;
    return { added: d > 0 ? 0 : -d, removed: d > 0 ? d : 0 };
  }
  let prev = new Uint32Array(m + 1);
  let curr = new Uint32Array(m + 1);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      curr[j] = a[i] === b[j] ? prev[j + 1]! + 1 : Math.max(prev[j]!, curr[j + 1]!);
    }
    [prev, curr] = [curr, prev];
  }
  const common = prev[0]!;
  return { added: m - common, removed: n - common };
}

export interface EditorNavigationRecord {
  version: 1;
  kind: 'view' | 'create' | 'str_replace' | 'insert' | 'delete';
  /** Normalized workspace-relative path; never an absolute host path. */
  path: string;
  startLine?: number;
  endLine?: number;
  beforeSha256?: string;
  afterSha256?: string;
  deleted?: true;
  directory?: true;
}

export interface EditorResult {
  message: string;
  isError: boolean;
  code?: string;
  diff?: { added: number; removed: number };
  /** Internal audit/UI metadata. The MCP handler strips it from the public result. */
  navigation?: EditorNavigationRecord;
}

function ok(
  message: string,
  diff?: { added: number; removed: number },
  navigation?: EditorNavigationRecord,
): EditorResult {
  return {
    message,
    isError: false,
    ...(diff ? { diff } : {}),
    ...(navigation ? { navigation } : {}),
  };
}

function err(message: string, code = 'EDITOR_ERROR'): EditorResult {
  return { message: `Error: ${message}`, isError: true, code };
}

/**
 * editor over paths guarded to the workspace. Commands:
 * view | create | str_replace | insert | delete — the legacy DSH-minimal
 * surface, restored verbatim (including its error texts).
 */
export class WorkspaceEditor {
  constructor(private readonly workspace: string) {}

  private relativePath(abs: string): string {
    const rel = path.relative(this.workspace, abs);
    return (rel || '.').split(path.sep).join('/');
  }

  private navigation(
    kind: EditorNavigationRecord['kind'],
    abs: string,
    details: Omit<EditorNavigationRecord, 'version' | 'kind' | 'path'> = {},
  ): EditorNavigationRecord {
    return { version: 1, kind, path: this.relativePath(abs), ...details };
  }

  private guard(target: string): string {
    // One resolution: the realpath identity the containment check verified is
    // the exact path the caller writes through — a swapped ancestor symlink
    // cannot slide between the check and the mutation.
    return checkedPathInWorkspace(this.workspace, target);
  }

  view(rawPath: string, viewRange?: number[]): EditorResult {
    let abs: string;
    try {
      abs = this.guard(rawPath);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e), 'INVALID_PATH');
    }
    if (!fs.existsSync(abs)) {
      return err(`FS_NOT_FOUND: ${abs} does not exist`, 'NOT_FOUND');
    }
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      if (Array.isArray(viewRange)) {
        return err('The `view_range` parameter is not allowed when `path` points to a directory.', 'INVALID_ARGUMENT');
      }
      const entries = fs
        .readdirSync(abs, { withFileTypes: true })
        .filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules')
        .map((e) => `${e.name}${e.isDirectory() ? '/' : ''}`)
        .sort();
      return ok(`Directory: ${abs}\n${entries.join('\n') || '(empty)'}`);
    }
    const content = fs.readFileSync(abs, 'utf8');
    if (Array.isArray(viewRange) && viewRange.length === 2) {
      const [start, end] = viewRange as [number, number];
      const allLines = logicalLines(content);
      if (!Number.isInteger(start) || !Number.isInteger(end)) {
        return err('Invalid `view_range`. It should be a list of two integers.', 'INVALID_ARGUMENT');
      }
      if (start < 1 || start > allLines.length) {
        return err(`Invalid \`view_range\`: start \`${start}\` should be within [1, ${allLines.length}].`, 'OUT_OF_RANGE');
      }
      if (end !== -1 && end < start) {
        return err(`Invalid \`view_range\`: end \`${end}\` should be >= start \`${start}\` (or -1 for EOF).`, 'INVALID_ARGUMENT');
      }
      const stopLine = end === -1 ? allLines.length : Math.min(end, allLines.length);
      const selected = allLines.slice(start - 1, stopLine).join('\n');
      return ok(`${abs} with view_range=[${start}, ${stopLine}]\n${clip(numberLines(selected, start))}`);
    }
    return ok(`${abs}\n${clip(numberLines(content))}`);
  }

  create(rawPath: string, content: string): EditorResult {
    let abs: string;
    try {
      abs = this.guard(rawPath);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e), 'INVALID_PATH');
    }
    if (fs.existsSync(abs)) {
      return err(`File already exists at: ${abs}. Cannot overwrite files using command \`create\`.`, 'ALREADY_EXISTS');
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
    const lineCount = logicalLines(content).length;
    return ok(
      `Created file at ${abs} (${content.length} chars).`,
      diffLines('', content),
      this.navigation('create', abs, {
        afterSha256: sha256(content),
        ...(lineCount > 0 ? { startLine: 1, endLine: lineCount } : {}),
      }),
    );
  }

  strReplace(rawPath: string, oldText: string, newText: string): EditorResult {
    let abs: string;
    try {
      abs = this.guard(rawPath);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e), 'INVALID_PATH');
    }
    if (!fs.existsSync(abs)) return err(`FS_NOT_FOUND: ${abs} does not exist`, 'NOT_FOUND');
    const original = fs.readFileSync(abs, 'utf8');
    if (oldText === newText) return err('old_text and new_text must differ', 'INVALID_ARGUMENT');
    const count = original.split(oldText).length - 1;
    if (count === 0) return err(`old_text not found in ${abs}`, 'NOT_FOUND');
    if (count > 1) return err(`old_text must be unique; found ${count} occurrences in ${abs}`, 'NON_UNIQUE_MATCH');
    const startLine = lineAtOffset(original, original.indexOf(oldText));
    const replacementLines = logicalLines(newText).length;
    const updated = original.replace(oldText, newText);
    fs.writeFileSync(abs, updated, 'utf8');
    return ok(
      `The file ${abs} has been edited. Replaced 1 occurrence.`,
      diffLines(original, updated),
      this.navigation('str_replace', abs, {
        startLine,
        endLine: startLine + Math.max(1, replacementLines) - 1,
        beforeSha256: sha256(original),
        afterSha256: sha256(updated),
      }),
    );
  }

  insert(rawPath: string, line: number, content: string): EditorResult {
    let abs: string;
    try {
      abs = this.guard(rawPath);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e), 'INVALID_PATH');
    }
    if (!fs.existsSync(abs)) return err(`FS_NOT_FOUND: ${abs} does not exist`, 'NOT_FOUND');
    const original = fs.readFileSync(abs, 'utf8');
    const lines = logicalLines(original);
    if (!Number.isInteger(line) || line < 0 || line > lines.length) {
      return err(`Invalid \`line\` parameter: ${line}. Use 0 for the beginning or a one-based existing line in [1, ${lines.length}].`, 'OUT_OF_RANGE');
    }
    const inserted = logicalLines(content);
    const updatedLines = [...lines.slice(0, line), ...inserted, ...lines.slice(line)];
    const preserveTerminalNewline = /(?:\r?\n)$/.test(original) || (line === lines.length && /(?:\r?\n)$/.test(content));
    const updated = updatedLines.join('\n') + (preserveTerminalNewline && updatedLines.length > 0 ? '\n' : '');
    fs.writeFileSync(abs, updated, 'utf8');
    return ok(
      `Inserted content after line ${line} in ${abs}.`,
      diffLines(original, updated),
      this.navigation('insert', abs, {
        beforeSha256: sha256(original),
        afterSha256: sha256(updated),
        ...(inserted.length > 0 ? { startLine: line + 1, endLine: line + inserted.length } : {}),
      }),
    );
  }

  /** Delete ONE regular file inside the workspace (never directories). */
  delete(rawPath: string): EditorResult {
    let abs: string;
    try {
      abs = this.guard(rawPath);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e), 'INVALID_PATH');
    }
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      return err(`FS_NOT_FOUND: ${abs} does not exist`, 'NOT_FOUND');
    }
    if (!st.isFile()) return err(`Refusing to delete: not a regular file (directories are out of scope): ${abs}`, 'INVALID_ARGUMENT');
    const original = fs.readFileSync(abs, 'utf8');
    fs.unlinkSync(abs);
    return ok(
      `Deleted ${abs}`,
      diffLines(original, ''),
      this.navigation('delete', abs, { beforeSha256: sha256(original), deleted: true }),
    );
  }
}
