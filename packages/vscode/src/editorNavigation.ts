import { createHash } from 'node:crypto';
import { isWorkspaceFileTool } from './toolNames';
import type { CallRow } from './controlApi';

export type EditorOperationKind = 'view' | 'create' | 'str_replace' | 'insert' | 'delete';

export interface StoredEditorNavigation {
  version: 1;
  kind: EditorOperationKind;
  path: string;
  startLine?: number;
  endLine?: number;
  beforeSha256?: string;
  afterSha256?: string;
  deleted?: true;
  directory?: true;
}

export interface EditorNavigationPreview {
  kind: EditorOperationKind;
  path: string;
  startLine?: number;
  endLine?: number;
  deleted?: true;
  legacy: boolean;
  enabled: boolean;
  label: string;
  ariaLabel: string;
}

export type EditorNavigationState = 'exact' | 'relocated' | 'approximate' | 'file_only' | 'deleted' | 'missing';

export interface ResolvedEditorNavigation {
  state: EditorNavigationState;
  startLine?: number;
  endLine?: number;
  notice?: string;
}

type ObjectValue = Record<string, unknown>;

const kinds = new Set<EditorOperationKind>(['view', 'create', 'str_replace', 'insert', 'delete']);
const isPositiveLine = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 1;
const isSha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);

function objectFromJson(json: string | null | undefined): ObjectValue | undefined {
  if (!json) return undefined;
  try {
    const value: unknown = JSON.parse(json);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : undefined;
  } catch {
    return undefined;
  }
}

function logicalLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function logicalLineCount(text: string): number {
  return logicalLines(text).length;
}

function lineAtOffset(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function rangeFromAnchor(content: string, anchor: string): { startLine: number; endLine: number } | undefined {
  if (!anchor) return undefined;
  // VS Code documents and tool arguments can differ only by CRLF/LF encoding.
  // Relocation is line-based, so normalize both without weakening uniqueness.
  const haystack = content.replace(/\r\n/g, '\n');
  const needle = anchor.replace(/\r\n/g, '\n');
  const first = haystack.indexOf(needle);
  if (first < 0 || haystack.indexOf(needle, first + needle.length) >= 0) return undefined;
  const startLine = lineAtOffset(haystack, first);
  return { startLine, endLine: startLine + Math.max(1, logicalLineCount(needle)) - 1 };
}

function resultMessage(call: CallRow): string | undefined {
  const result = objectFromJson(call.result_summary);
  const wrapped = result?.result;
  return wrapped && typeof wrapped === 'object' && !Array.isArray(wrapped) && typeof (wrapped as ObjectValue).message === 'string'
    ? (wrapped as ObjectValue).message as string
    : undefined;
}

function argsFor(call: CallRow): { path?: string; operation?: ObjectValue } {
  const args = objectFromJson(call.args_json);
  if (!args) return {};
  const operation = args.operation && typeof args.operation === 'object' && !Array.isArray(args.operation)
    ? args.operation as ObjectValue
    : args;
  return { path: typeof args.path === 'string' ? args.path : undefined, operation };
}

export function parseStoredEditorNavigation(json: string | null | undefined): StoredEditorNavigation | undefined {
  const value = objectFromJson(json);
  if (!value || value.version !== 1 || typeof value.kind !== 'string' || !kinds.has(value.kind as EditorOperationKind) || typeof value.path !== 'string' || value.path === '') return undefined;
  const startLine = isPositiveLine(value.startLine) ? value.startLine : undefined;
  const endLine = isPositiveLine(value.endLine) ? value.endLine : undefined;
  return {
    version: 1,
    kind: value.kind as EditorOperationKind,
    path: value.path,
    ...(startLine ? { startLine } : {}),
    ...(endLine && (!startLine || endLine >= startLine) ? { endLine } : {}),
    ...(isSha(value.beforeSha256) ? { beforeSha256: value.beforeSha256 } : {}),
    ...(isSha(value.afterSha256) ? { afterSha256: value.afterSha256 } : {}),
    ...(value.deleted === true ? { deleted: true } : {}),
    ...(value.directory === true ? { directory: true } : {}),
  };
}

function legacyRecord(call: CallRow): StoredEditorNavigation | undefined {
  const { path, operation } = argsFor(call);
  const command = operation && typeof operation.command === 'string' ? operation.command : '';
  if (!path || !kinds.has(command as EditorOperationKind)) return undefined;
  const kind = command as EditorOperationKind;
  const record: StoredEditorNavigation = { version: 1, kind, path };
  if (kind === 'view' && resultMessage(call)?.startsWith('Directory:')) {
    record.directory = true;
  } else if (kind === 'view' && Array.isArray(operation?.view_range) && operation.view_range.length === 2) {
    const [start, end] = operation.view_range;
    if (isPositiveLine(start)) {
      record.startLine = start;
      if (isPositiveLine(end) && end >= start) record.endLine = end;
    }
  } else if (kind === 'create' && typeof operation?.content === 'string') {
    const count = logicalLineCount(operation.content);
    if (count > 0) { record.startLine = 1; record.endLine = count; }
  } else if (kind === 'insert' && Number.isInteger(operation?.line) && Number(operation?.line) >= 0 && typeof operation?.content === 'string') {
    const count = logicalLineCount(operation.content);
    if (count > 0) { record.startLine = Number(operation.line) + 1; record.endLine = Number(operation.line) + count; }
  } else if (kind === 'delete' && call.status === 'completed') {
    record.deleted = true;
  }
  return record;
}

function recordFor(call: CallRow): { record: StoredEditorNavigation; legacy: boolean } | undefined {
  if (!isWorkspaceFileTool(call.tool)) return undefined;
  const stored = parseStoredEditorNavigation(call.navigation_json);
  const record = stored ?? legacyRecord(call);
  return record ? { record, legacy: !stored } : undefined;
}

export function editorNavigationPreview(call: CallRow): EditorNavigationPreview | undefined {
  const found = recordFor(call);
  if (!found || found.record.directory) return undefined;
  const { record, legacy } = found;
  // View is read-only context: keep it in the call feed without a file-open affordance.
  if (record.kind === 'view') return undefined;
  const range = record.startLine ? ` · L${record.startLine}${record.endLine && record.endLine !== record.startLine ? `-${record.endLine}` : ''}` : '';
  const enabled = !['started', 'awaiting', 'denied'].includes(call.status);
  return {
    kind: record.kind,
    path: record.path,
    ...(record.startLine ? { startLine: record.startLine } : {}),
    ...(record.endLine ? { endLine: record.endLine } : {}),
    ...(record.deleted ? { deleted: true } : {}),
    legacy,
    enabled,
    label: `${record.path}${range}`,
    ariaLabel: record.deleted
      ? `查看已删除文件 ${record.path} 的操作状态`
      : `打开 ${record.path}${record.startLine ? `，第 ${record.startLine}${record.endLine && record.endLine !== record.startLine ? ` 到 ${record.endLine}` : ''} 行` : ''}`,
  };
}

export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function resolveEditorNavigation(call: CallRow, currentContent: string | null): ResolvedEditorNavigation {
  const found = recordFor(call);
  if (!found || found.record.directory) return { state: 'missing', notice: '该调用没有可用的文件导航信息' };
  const { record, legacy } = found;
  if (currentContent === null) {
    return record.deleted
      ? { state: 'deleted', notice: '该调用已删除此文件' }
      : { state: 'missing', notice: '文件当前不存在，可能已被移动或删除' };
  }
  if (record.deleted) {
    return { state: 'file_only', notice: '该调用曾删除此文件，但该路径后来被重新创建；已打开当前版本' };
  }
  if (call.status === 'failed') return { state: 'file_only', notice: '该文件操作失败；已打开目标文件当前版本' };
  if (call.status === 'unknown') return { state: 'file_only', notice: '调用结果无法确认；已打开文件当前版本' };
  if (record.afterSha256 && sha256Text(currentContent) === record.afterSha256) {
    return { state: 'exact', ...(record.startLine ? { startLine: record.startLine } : {}), ...(record.endLine ? { endLine: record.endLine } : {}) };
  }

  const { operation } = argsFor(call);
  const anchor = record.kind === 'str_replace' && typeof operation?.new_text === 'string'
    ? operation.new_text
    : record.kind === 'insert' && typeof operation?.content === 'string'
      ? logicalLines(operation.content).join('\n')
      : record.kind === 'create' && typeof operation?.content === 'string'
        ? operation.content
        : '';
  const relocated = rangeFromAnchor(currentContent, anchor);
  if (relocated) return { state: 'relocated', ...relocated, notice: '文件已变化，已重新定位相关内容' };

  if (legacy && record.startLine) {
    return {
      state: 'approximate',
      startLine: record.startLine,
      ...(record.endLine ? { endLine: record.endLine } : {}),
      notice: '这是旧调用记录，位置可能已变化',
    };
  }
  return { state: 'file_only', notice: record.afterSha256 ? '原修改位置已变化，已打开文件当前版本' : '已打开文件当前版本' };
}
