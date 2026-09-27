/**
 * Response repair: recover commands/evidence from malformed model responses.
 *
 * Ported from dsh-assistant-optimization `lib/fast-context/repair.js`
 * (itself from fast-context-mcp `src/response-repair.mjs`, MIT).
 * Change: paths resolve through this repo's workspace guard instead of the
 * reference's own path-safety module; otherwise no logic changes.
 */
import path from 'node:path';
import { resolveInWorkspace } from '../util/fspaths.js';

const BACKSLASH = String.fromCharCode(92);

/** Repair the JSON defects models actually produce (unquoted keys, trailing commas). */
export function repairJsonText(text: string): string {
  return String(text)
    .replace(/([{,]\s*)([A-Za-z_$][\w$-]*)"\s*:/g, '$1"$2":')
    .replace(/([{,]\s*)([A-Za-z_$][\w$-]*)\s*:/g, '$1"$2":')
    .replace(/,\s*([}\]])/g, '$1');
}

/** Parse JSON, falling back to the repaired form; null when both fail. */
export function parseJsonWithRepair(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    try {
      return JSON.parse(repairJsonText(text)) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}

/** Slice out the object starting at `start` by brace balance (quote-aware). */
function extractBalancedObject(text: string, start: number): string {
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === BACKSLASH) escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return text.slice(start);
}

interface CommandPair {
  key: string;
  command: Record<string, unknown>;
}

function collectCommands(text: string): CommandPair[] {
  const commands: CommandPair[] = [];
  const commandKey = /["']?(command\d+)["']?\s*:\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = commandKey.exec(text)) !== null) {
    const start = text.indexOf('{', match.index);
    const value = parseJsonWithRepair(extractBalancedObject(text, start));
    if (value && typeof value.type === 'string') commands.push({ key: match[1] as string, command: value });
    commandKey.lastIndex = Math.max(commandKey.lastIndex, start + 1);
  }
  return commands;
}

/** Readfile calls that survive only as loose `"file": "/codebase/..."` fragments. */
function collectLooseReadfiles(text: string): Record<string, unknown>[] {
  const commands: Record<string, unknown>[] = [];
  const filePattern = /["']?file["']?\s*:\s*["'](\/codebase(?:\/[^"'\r\n,}]+)+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = filePattern.exec(text)) !== null) {
    const from = Math.max(0, match.index - 240);
    const window = text.slice(from, Math.min(text.length, filePattern.lastIndex + 240));
    const startLine = Number(window.match(/["']?start_line["']?\s*:\s*(\d+)/)?.[1] || 0);
    const endLine = Number(window.match(/["']?end_line["']?\s*:\s*(\d+)/)?.[1] || 0);
    commands.push({
      type: 'readfile',
      file: (match[1] as string).replaceAll(BACKSLASH + '/', '/'),
      ...(startLine ? { start_line: startLine } : {}),
      ...(endLine ? { end_line: endLine } : {}),
    });
  }
  return commands;
}

/**
 * Recover executable restricted_exec arguments from a malformed response.
 * Null when nothing usable survives — the caller then falls back to the
 * plain-text evidence salvage below.
 */
export function salvageRestrictedExecArgs(text: string): Record<string, unknown> | null {
  const result: Record<string, unknown> = {};
  const seen = new Set<string>();
  const add = (key: string | null, command: Record<string, unknown>): void => {
    const signature = JSON.stringify(command);
    if (seen.has(signature)) return;
    seen.add(signature);
    const slot = key && !result[key] ? key : `command${Object.keys(result).length + 1}`;
    result[slot] = command;
  };

  for (const { key, command } of collectCommands(String(text))) add(key, command);
  for (const command of collectLooseReadfiles(String(text))) add(null, command);
  return Object.keys(result).length ? result : null;
}

export interface FoundFile {
  path: string;
  full_path: string;
  ranges: [number, number][];
}

/**
 * Last-resort evidence recovery: when structured parsing fails entirely, pull
 * file paths and rg patterns out of the raw text so the caller still returns
 * something grounded in commands that really ran. Paths that leave the
 * workspace are dropped rather than reported.
 */
export function salvageSearchEvidence(text: string, workspaceRoot: string): { files: FoundFile[]; rg_patterns: string[] } {
  const source = String(text);
  const commands = (salvageRestrictedExecArgs(source) ?? {}) as Record<string, Record<string, unknown>>;
  const byPath = new Map<string, FoundFile>();
  const rgPatterns: string[] = [];

  const addFile = (virtualPath: string, ranges: [number, number][] = []): void => {
    let fullPath: string;
    try {
      fullPath = resolveInWorkspace(workspaceRoot, virtualPath.replace(/^\/codebase\/?/, ''));
    } catch {
      return;
    }
    if (path.relative(workspaceRoot, fullPath).startsWith('..')) return;
    const relPath = path.relative(workspaceRoot, fullPath).split(path.sep).join('/');
    const current = byPath.get(fullPath) ?? { path: relPath, full_path: fullPath, ranges: [] };
    for (const range of ranges) {
      if (!current.ranges.some(([s, e]) => s === range[0] && e === range[1])) current.ranges.push(range);
    }
    byPath.set(fullPath, current);
  };

  for (const command of Object.values(commands)) {
    if (command.type === 'readfile' && typeof command.file === 'string') {
      const s = Number(command.start_line || 0);
      const e = Number(command.end_line || 0);
      addFile(command.file, s && e ? [[s, e]] : []);
    }
    if (command.type === 'rg' && typeof command.pattern === 'string') rgPatterns.push(command.pattern);
  }

  const loosePath = /\/codebase\/[A-Za-z0-9_@+.,()\[\]{} !#$%&'=-]+(?:\/[A-Za-z0-9_@+.,()\[\]{} !#$%&'=-]+)*\.[A-Za-z0-9]{1,16}/g;
  for (const match of source.matchAll(loosePath)) addFile(match[0].trim());
  for (const match of source.matchAll(/["']?pattern["']?\s*:\s*["']([^"'\r\n]+)["']/g)) {
    rgPatterns.push(match[1] as string);
  }

  return { files: [...byPath.values()].slice(0, 30), rg_patterns: [...new Set(rgPatterns)] };
}
