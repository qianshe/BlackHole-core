import { createHash } from 'node:crypto';
import fs from 'node:fs';
import type { ToolCallRow } from '../storage/db.js';
import { isWorkspaceFileTool } from '../tool-routing.js';
import { checkedPathAnywhere, checkedPathInRoots, checkedPathInWorkspace } from '../util/fspaths.js';

export interface TurnDiffLine {
  type: 'context' | 'add' | 'remove' | 'hunk';
  oldLine?: number;
  newLine?: number;
  text: string;
}

export interface TurnDiffFile {
  path: string;
  status: 'ready' | 'deleted' | 'unavailable';
  added: number | null;
  removed: number | null;
  lines: TurnDiffLine[];
  callIds: string[];
  message?: string;
}

export interface TurnDiffResult {
  files: TurnDiffFile[];
  pending: number;
  uncertain: number;
}

export interface TurnDiffSession {
  workspace_path: string;
  permission_mode: string;
  writable_dirs?: readonly string[];
}

export type TurnDiffCall = ToolCallRow & { seq: number };

type ObjectValue = Record<string, unknown>;
type WriteKind = 'create' | 'str_replace' | 'insert' | 'delete';
interface Navigation extends ObjectValue {
  version: number;
  kind: string;
  path: string;
  startLine?: number;
  beforeSha256?: string;
  afterSha256?: string;
  deleted?: boolean;
}
interface EditorOperation {
  call: TurnDiffCall;
  path: string;
  displayPath: string;
  absolutePath?: string;
  pathError?: string;
  kind: WriteKind;
  args: ObjectValue;
  navigation?: Navigation;
}
interface DiffOp {
  type: 'context' | 'add' | 'remove';
  oldLine?: number;
  newLine?: number;
  text: string;
}

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_DIFF_CELLS = 4_000_000;
const SHA256 = /^[a-f0-9]{64}$/i;
const WRITE_KINDS = new Set<WriteKind>(['create', 'str_replace', 'insert', 'delete']);

function isObject(value: unknown): value is ObjectValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseJson(value: string | null): unknown {
  if (!value) return null;
  try { return JSON.parse(value) as unknown; } catch { return null; }
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function logicalLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/** Like the editor's diff accounting, retain the terminal empty row so newline-only edits remain visible. */
function diffLines(text: string): string[] {
  return text === '' ? [] : text.replace(/\r\n/g, '\n').split('\n');
}

function lineAtOffset(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function startOfLine(text: string, line: number): number {
  if (!Number.isInteger(line) || line < 1) return -1;
  let offset = 0;
  for (let current = 1; current < line; current++) {
    const next = text.indexOf('\n', offset);
    if (next < 0) return -1;
    offset = next + 1;
  }
  return offset;
}

function reverseReplace(after: string, oldText: string, newText: string, navigation: Navigation): string | null {
  const beforeHash = navigation.beforeSha256;
  if (typeof beforeHash !== 'string' || !SHA256.test(beforeHash) || typeof navigation.startLine !== 'number') return null;
  const lineStart = startOfLine(after, navigation.startLine);
  if (lineStart < 0) return null;
  const lineEndAt = after.indexOf('\n', lineStart);
  const lineEnd = lineEndAt < 0 ? after.length : lineEndAt;
  const candidates: number[] = [];
  if (newText === '') {
    // An empty replacement has a possible insertion point at every column of its source line.
    if (lineEnd - lineStart > 50_000) return null;
    for (let i = lineStart; i <= lineEnd; i++) candidates.push(i);
  } else {
    let at = after.indexOf(newText, lineStart);
    while (at >= 0 && at <= lineEnd && candidates.length < 500) {
      if (lineAtOffset(after, at) === navigation.startLine) candidates.push(at);
      at = after.indexOf(newText, at + Math.max(1, newText.length));
    }
  }
  for (const at of candidates) {
    const candidate = after.slice(0, at) + oldText + after.slice(at + newText.length);
    if (sha256(candidate) === beforeHash) return candidate;
  }
  return null;
}

function reverseInsert(after: string, insertedText: string, navigation: Navigation): string | null {
  const beforeHash = navigation.beforeSha256;
  if (typeof beforeHash !== 'string' || !SHA256.test(beforeHash)) return null;
  const lines = logicalLines(after);
  const inserted = logicalLines(insertedText);
  let base = lines;
  if (inserted.length > 0) {
    if (typeof navigation.startLine !== 'number' || navigation.startLine < 1) return null;
    const start = navigation.startLine - 1;
    if (start + inserted.length > lines.length) return null;
    for (let i = 0; i < inserted.length; i++) if (lines[start + i] !== inserted[i]) return null;
    base = [...lines.slice(0, start), ...lines.slice(start + inserted.length)];
  }
  const joinedLf = base.join('\n');
  const candidates = [joinedLf, `${joinedLf}\n`, joinedLf.replace(/\n/g, '\r\n'), `${joinedLf.replace(/\n/g, '\r\n')}\r\n`];
  for (const candidate of new Set(candidates)) if (sha256(candidate) === beforeHash) return candidate;
  return null;
}

function diff(beforeText: string, afterText: string): { added: number; removed: number; lines: TurnDiffLine[] } | null {
  const before = diffLines(beforeText);
  const after = diffLines(afterText);
  const n = before.length, m = after.length, width = m + 1;
  if ((n + 1) * (m + 1) > MAX_DIFF_CELLS) return null;
  const dp = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const index = i * width + j;
      dp[index] = before[i] === after[j]
        ? dp[(i + 1) * width + j + 1]! + 1
        : Math.max(dp[(i + 1) * width + j]!, dp[index + 1]!);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0, j = 0, oldLine = 1, newLine = 1;
  while (i < n || j < m) {
    if (i < n && j < m && before[i] === after[j]) {
      ops.push({ type: 'context', oldLine, newLine, text: before[i]! }); i++; j++; oldLine++; newLine++;
    } else if (i < n && (j >= m || dp[(i + 1) * width + j]! >= dp[i * width + j + 1]!)) {
      ops.push({ type: 'remove', oldLine, text: before[i]! }); i++; oldLine++;
    } else {
      ops.push({ type: 'add', newLine, text: after[j]! }); j++; newLine++;
    }
  }
  const changed = ops.flatMap((op, index) => op.type === 'context' ? [] : [index]);
  if (changed.length === 0) return { added: 0, removed: 0, lines: [] };
  const ranges: [number, number][] = [];
  for (const index of changed) {
    const start = Math.max(0, index - 3), end = Math.min(ops.length - 1, index + 3);
    const previous = ranges[ranges.length - 1];
    if (previous && start <= previous[1] + 1) previous[1] = Math.max(previous[1], end);
    else ranges.push([start, end]);
  }
  const output: TurnDiffLine[] = [];
  for (const [start, end] of ranges) {
    const chunk = ops.slice(start, end + 1);
    const firstOld = chunk.find((op) => op.oldLine !== undefined)?.oldLine ?? 0;
    const firstNew = chunk.find((op) => op.newLine !== undefined)?.newLine ?? 0;
    const oldCount = chunk.filter((op) => op.type !== 'add').length;
    const newCount = chunk.filter((op) => op.type !== 'remove').length;
    output.push({ type: 'hunk', text: `@@ -${firstOld},${oldCount} +${firstNew},${newCount} @@` }, ...chunk);
  }
  return {
    added: ops.filter((op) => op.type === 'add').length,
    removed: ops.filter((op) => op.type === 'remove').length,
    lines: output,
  };
}

function resolveFile(session: TurnDiffSession, rawPath: string): string {
  if (session.permission_mode === 'danger-full-access') return checkedPathAnywhere(session.workspace_path, rawPath);
  if (session.permission_mode === 'workspace-write' && session.writable_dirs?.length) {
    return checkedPathInRoots(session.workspace_path, session.writable_dirs, rawPath);
  }
  return checkedPathInWorkspace(session.workspace_path, rawPath);
}

function unavailable(filePath: string, message: string, callIds: string[] = []): TurnDiffFile {
  return { path: filePath, status: 'unavailable', added: null, removed: null, lines: [], callIds, message };
}

function operationFor(call: TurnDiffCall, session: TurnDiffSession): EditorOperation | null {
  if (!isWorkspaceFileTool(call.tool)) return null;
  const parsedArgs = parseJson(call.args_json);
  const args = isObject(parsedArgs) ? parsedArgs : {};
  const operation = isObject(args.operation) ? args.operation : args;
  const command = typeof operation.command === 'string' ? operation.command : '';
  if (!WRITE_KINDS.has(command as WriteKind)) return null;
  const navigationValue = parseJson(call.navigation_json);
  const navigation = isObject(navigationValue) ? navigationValue as Navigation : undefined;
  const rawPath = typeof navigation?.path === 'string' ? navigation.path : typeof args.path === 'string' ? args.path : '';
  if (!rawPath) return null;
  let absolutePath: string | undefined, pathError: string | undefined;
  try { absolutePath = resolveFile(session, rawPath); }
  catch (error) { pathError = error instanceof Error ? error.message : 'path unavailable'; }
  return {
    call, path: rawPath, displayPath: rawPath, ...(absolutePath ? { absolutePath } : {}), ...(pathError ? { pathError } : {}),
    kind: command as WriteKind, args: operation, ...(navigation ? { navigation } : {}),
  };
}

function callDelta(call: TurnDiffCall): { added: number; removed: number } | null {
  const parsed = parseJson(call.result_summary);
  const result = isObject(parsed) && isObject(parsed.result) ? parsed.result : null;
  const d = result && isObject(result.diff) ? result.diff : null;
  return d && typeof d.added === 'number' && typeof d.removed === 'number' ? { added: d.added, removed: d.removed } : null;
}

function buildFileDiff(operations: EditorOperation[]): TurnDiffFile | null {
  const displayPath = operations[0]!.displayPath;
  const callIds = operations.map((operation) => operation.call.id);
  const unavailableForCalls = (message: string): TurnDiffFile => unavailable(displayPath, message, callIds);
  if (operations.some((op) => op.pathError || !op.absolutePath)) {
    return unavailableForCalls('文件路径当前不可读取。');
  }
  if (operations.some((op) => !op.navigation || op.navigation.version !== 1 || op.navigation.kind !== op.kind)) {
    return unavailableForCalls('缺少可验证的编辑记录，无法生成最终差异。');
  }
  const first = operations[0]!, last = operations.at(-1)!;
  const absolutePath = last.absolutePath!;
  const exists = fs.existsSync(absolutePath);
  if (!exists && last.kind === 'delete') {
    if (last.call.status !== 'completed') return unavailableForCalls('删除结果未确认，无法判断文件的最终状态。');
    if (first.kind === 'create' && first.call.status === 'completed') return null; // Created and deleted within the same turn: no net file change.
    if (operations.length === 1) {
      const delta = callDelta(last.call);
      return { path: displayPath, status: 'deleted', added: delta?.added ?? 0, removed: delta?.removed ?? null, lines: [], callIds, message: '文件已删除。' };
    }
    return unavailableForCalls('文件已删除，但无法验证本轮开始时的内容。');
  }
  if (!exists || last.kind === 'delete') return unavailableForCalls('文件状态与本轮编辑记录不一致。');
  let stat: fs.Stats;
  try { stat = fs.statSync(absolutePath); } catch { return unavailableForCalls('文件当前不可读取。'); }
  if (!stat.isFile()) return unavailableForCalls('目标不再是普通文件。');
  if (stat.size > MAX_FILE_BYTES) return unavailableForCalls('文件过大，无法安全生成差异。');
  let working: string;
  try { working = fs.readFileSync(absolutePath, 'utf8'); } catch { return unavailableForCalls('文件当前不可读取。'); }

  for (let index = operations.length - 1; index >= 0; index--) {
    const op = operations[index]!;
    const nav = op.navigation!;
    if (op.kind === 'delete') return unavailableForCalls('文件在本轮中被删除并重建，无法验证起始内容。');
    if (op.kind === 'create') {
      if (index !== 0 || typeof nav.afterSha256 !== 'string' || sha256(working) !== nav.afterSha256) {
        return unavailableForCalls('创建后的文件内容已变化，无法验证最终差异。');
      }
      working = '';
      continue;
    }
    if (typeof nav.beforeSha256 !== 'string' || typeof nav.afterSha256 !== 'string' || sha256(working) !== nav.afterSha256) {
      return unavailableForCalls('文件在编辑操作之间有其他变化，无法安全合并。');
    }
    let previous: string | null = null;
    if (op.kind === 'str_replace') {
      const oldText = op.args.old_text, newText = op.args.new_text;
      if (typeof oldText === 'string' && typeof newText === 'string') previous = reverseReplace(working, oldText, newText, nav);
    } else if (op.kind === 'insert') {
      const content = op.args.content;
      if (typeof content === 'string') previous = reverseInsert(working, content, nav);
    }
    if (previous === null || sha256(previous) !== nav.beforeSha256) {
      return unavailableForCalls('无法验证本轮编辑记录，未显示可能不准确的差异。');
    }
    working = previous;
  }

  const result = diff(working, fs.readFileSync(absolutePath, 'utf8'));
  if (!result) return unavailableForCalls('差异过大，无法安全展示。');
  if (result.added === 0 && result.removed === 0) return null;
  return { path: displayPath, status: 'ready', added: result.added, removed: result.removed, lines: result.lines, callIds };
}

export function buildTurnDiff(session: TurnDiffSession, calls: readonly TurnDiffCall[]): TurnDiffResult {
  const groups = new Map<string, EditorOperation[]>();
  let pending = 0, uncertain = 0;
  const group = (operation: EditorOperation): void => {
    const key = operation.absolutePath ? (process.platform === 'win32' ? operation.absolutePath.toLowerCase() : operation.absolutePath) : `unavailable:${operation.path}`;
    const items = groups.get(key) ?? [];
    items.push(operation);
    groups.set(key, items);
  };
  for (const call of [...calls].sort((a, b) => a.seq - b.seq)) {
    if (!isWorkspaceFileTool(call.tool)) continue;
    const operation = operationFor(call, session);
    if (!operation) continue;
    if (call.status === 'started' || call.status === 'awaiting') { pending++; continue; }
    if (call.status === 'unknown' || call.status === 'failed') { uncertain++; group(operation); continue; }
    if (call.status !== 'completed') continue;
    group(operation);
  }
  const files = [...groups.values()]
    .map((operations) => buildFileDiff(operations))
    .filter((file): file is TurnDiffFile => file !== null)
    .sort((a, b) => a.path.localeCompare(b.path));
  return { files, pending, uncertain };
}
