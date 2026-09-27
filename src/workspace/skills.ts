import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/** Read-only skill resources. Explicit/user root junctions are intentional;
 * project roots also stay within their workspace. Each resource stays within
 * its selected real skill directory; scripts are never executed here. */
export interface SkillSummary {
  /** Callable folder identifier, never the frontmatter display name. */
  name: string;
  title?: string;
  description: string;
}
export interface SkillDetail extends SkillSummary {
  dir: string;
  content: string;
}
export type SkillErrorCode = 'invalid_path' | 'invalid_request' | 'not_found' | 'too_large' | 'not_text' | 'unreadable' | 'resource_changed';
export class SkillAccessError extends Error {
  constructor(public readonly code: SkillErrorCode, message: string) { super(message); }
}
export interface SkillFile extends SkillDetail {
  kind: 'document' | 'file';
  resource_id: string;
  version: string;
  path: string;
  bytes: number;
  /** Complete bytes decoded by this server, not a host/model delivery receipt. */
  complete: true;
}
export interface SkillDirectory {
  kind: 'directory';
  name: string;
  dir: string;
  path: string;
  entries: { name: string; path: string; kind: 'file' | 'directory' }[];
  count: number;
  total: number;
  complete: boolean;
  next_offset?: number;
}
const SKILL_MAX_BYTES = 256 * 1024;
const DIRECTORY_PAGE_SIZE = 200;
const SKILL_NAME = /^\w[\w.-]*$/;

/**
 * Minimal frontmatter scan for `name` / `description`. Skills are authored
 * downstream (Claude-style SKILL.md); pulling a YAML parser in for two
 * single-line fields is not worth a dependency, so folded lists and multiline
 * blocks degrade to '' and the folder name stands in.
 */
function frontmatter(text: string): { name?: string; description?: string } {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!block?.[1]) return {};
  const out: { name?: string; description?: string } = {};
  for (const line of block[1].split(/\r?\n/)) {
    const kv = /^(name|description):\s*(.*)$/.exec(line.trim());
    if (!kv?.[1] || !kv[2]) continue;
    let v = kv[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (v && !(out as Record<string, string>)[kv[1]]) (out as Record<string, string>)[kv[1]] = v;
  }
  return out;
}

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

/** Existing, real paths only. Check actual directory ancestry, not case-folded
 * path.relative(): Windows directories may be case-sensitive too. File IDs
 * preserve legitimate case/junction aliases. Missing IDs use exact native real
 * paths and fail closed rather than assuming a filesystem's case rules. */
export function withinSkillBoundary(root: string, target: string): boolean {
  const boundary = fs.statSync(root, { bigint: true });
  if (!boundary.isDirectory()) return false;
  let current = fs.statSync(target).isDirectory() ? target : path.dirname(target);
  for (;;) {
    const ancestor = fs.statSync(current, { bigint: true });
    const same = boundary.ino !== 0n && ancestor.ino !== 0n
      ? boundary.dev === ancestor.dev && boundary.ino === ancestor.ino
      : fs.realpathSync.native(root) === fs.realpathSync.native(current);
    if (same && ancestor.isDirectory()) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}
function fail(code: SkillErrorCode, reason: string): never { throw new SkillAccessError(code, reason); }
function filesystemError(error: unknown): never {
  if (error instanceof SkillAccessError) throw error;
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') fail('not_found', 'The skill or resource does not exist.');
  fail('unreadable', 'The skill resource could not be read.');
}
function relativeResource(input: string): string {
  const normalized = input.replace(/\\/g, '/');
  const parts = normalized.split('/');
  if (!input || path.posix.isAbsolute(normalized) || path.win32.isAbsolute(input) || /[\x00-\x1f:]/.test(input)
    || parts.some(p => p === '..' || (p !== '.' && /[. ]$/.test(p)))) {
    fail('invalid_path', 'Use a path relative to this skill root; absolute paths, parent traversal and alternate streams are not allowed.');
  }
  return parts.filter(p => p && p !== '.').join('/') || '.';
}
function containedRealPath(root: string, relative: string): string {
  const candidate = path.resolve(root, relative);
  if (!within(root, candidate)) fail('invalid_path', 'The resource is outside this skill.');
  const real = fs.realpathSync(candidate);
  if (!withinSkillBoundary(root, real)) fail('invalid_path', 'The resource link points outside this skill.');
  return real;
}
export function validateSkillName(name: string): void {
  if (!SKILL_NAME.test(name) || /[. ]$/.test(name)) fail('invalid_path', 'Use the exact skill folder identifier from the skill list.');
}
function skillRoot(dir: string, name: string, workspace?: string): { root: string; logical: string } {
  validateSkillName(name);
  const logical = path.resolve(dir, name);
  // Operator-configured root junctions may lead to a plugin cache outside dir.
  const root = fs.realpathSync(logical);
  if (workspace) {
    const boundary = fs.realpathSync(workspace);
    if (!withinSkillBoundary(boundary, fs.realpathSync(dir)) || !withinSkillBoundary(boundary, root)) {
      fail('invalid_path', 'The project skill points outside its workspace.');
    }
  }
  const main = containedRealPath(root, 'SKILL.md');
  const stat = fs.statSync(main);
  if (!stat.isFile() || stat.size === 0) fail('not_found', 'This directory has no non-empty SKILL.md.');
  if (stat.size > SKILL_MAX_BYTES) fail('too_large', 'SKILL.md exceeds the 256 KiB text limit; no partial content was returned.');
  return { root, logical };
}
const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
function filesystemIdentity(stat: fs.BigIntStats, realPath: string): string {
  // File IDs preserve Windows case/junction aliases without conflating distinct
  // files in case-sensitive directories. Fall back to native canonical paths
  // only on filesystems that do not supply inode identities.
  return stat.ino !== 0n ? `${stat.dev}:${stat.ino}` : fs.realpathSync.native(realPath);
}
export function readUtf8Resource(file: string): { content: string; bytes: number; identity: string } {
  // Bound the actual read, not only the prior stat (a file can grow meanwhile).
  const flags = fs.constants.O_RDONLY | (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW);
  const fd = fs.openSync(file, flags);
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isFile()) fail('not_text', 'Only regular UTF-8 text files can be read; scripts are never executed.');
    if (stat.size > SKILL_MAX_BYTES) fail('too_large', 'The resource exceeds the 256 KiB text limit; no partial content was returned.');
    const buffer = Buffer.alloc(SKILL_MAX_BYTES + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const n = fs.readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (!n) break;
      bytes += n;
    }
    if (bytes > SKILL_MAX_BYTES) fail('too_large', 'The resource exceeds the 256 KiB text limit; no partial content was returned.');
    const after = fs.fstatSync(fd, { bigint: true });
    if (stat.size !== after.size || BigInt(bytes) !== after.size || stat.mtimeNs !== after.mtimeNs || stat.ctimeNs !== after.ctimeNs) {
      fail('resource_changed', 'The resource changed while being read; no complete response was provided. Retry the read.');
    }
    let content: string;
    try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, bytes)); }
    catch { fail('not_text', 'The resource is not valid UTF-8 text.'); }
    if (/[\x00-\x08\x0b\x0e-\x1f]/.test(content)) fail('not_text', 'Binary resources are not supported; only UTF-8 text can be read.');
    return { content, bytes, identity: filesystemIdentity(stat, file) };
  } finally { fs.closeSync(fd); }
}

/** Omit resourcePath for SKILL.md; use '.' or a directory for paged discovery.
 * Resource paths always resolve from the skill root, not the current workspace.
 * The configured library is operator-controlled, not an OS sandbox against a
 * local process concurrently replacing ancestor directories or creating hardlinks.
 */
export function readSkillResource(dir: string, name: string, resourcePath = 'SKILL.md', offset = 0, workspace?: string): SkillFile | SkillDirectory {
  try {
    const relative = relativeResource(resourcePath);
    if (!Number.isSafeInteger(offset) || offset < 0) fail('invalid_request', 'Directory offset must be a nonnegative integer.');
    const { root, logical } = skillRoot(dir, name, workspace);
    const real = containedRealPath(root, relative);
    const stat = fs.statSync(real);
    if (stat.isDirectory()) {
      const entries: SkillDirectory['entries'] = [];
      for (const child of fs.readdirSync(real).sort()) {
        const childPath = relative === '.' ? child : `${relative}/${child}`;
        try {
          const childReal = containedRealPath(root, relativeResource(childPath));
          const info = fs.statSync(childReal);
          if (info.isFile() || info.isDirectory()) entries.push({ name: child, path: childPath, kind: info.isDirectory() ? 'directory' : 'file' });
        } catch { /* Unreadable, broken or escaping links are not advertised. */ }
      }
      const page = entries.slice(offset, offset + DIRECTORY_PAGE_SIZE);
      const next = offset + page.length;
      const complete = next >= entries.length;
      return { kind: 'directory', name, dir: logical, path: relative, entries: page, count: page.length, total: entries.length, complete,
        ...(!complete ? { next_offset: next } : {}) };
    }
    if (offset !== 0) fail('invalid_request', 'Offset applies only to directory listings; text files are returned in full.');
    if (!stat.isFile()) fail('not_text', 'Only regular UTF-8 text files can be read.');
    const body = readUtf8Resource(real);
    const document = relative === 'SKILL.md';
    const rootIdentity = filesystemIdentity(fs.statSync(root, { bigint: true }), root);
    const fm = document ? frontmatter(body.content.replace(/^\uFEFF/, '')) : {};
    return { kind: document ? 'document' : 'file', name, ...(fm.name ? { title: fm.name } : {}), description: fm.description ?? '',
      dir: logical, path: relative, content: body.content, bytes: body.bytes,
      resource_id: digest(`${rootIdentity}\0${body.identity}`), version: digest(body.content), complete: true };
  } catch (error) { return filesystemError(error); }
}

/** Compatible full-document helper. Missing/unreadable skills remain null. */
export function readSkill(dir: string, name: string): SkillDetail | null {
  try {
    const result = readSkillResource(dir, name);
    return result.kind === 'directory' ? null : result;
  } catch { return null; }
}

/** Names are stable, callable folder IDs. A root junction remains supported. */
export function listSkills(dir: string): SkillSummary[] {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const skills: SkillSummary[] = [];
  for (const name of names) {
    const doc = readSkill(dir, name);
    if (doc) skills.push({ name: doc.name, ...(doc.title ? { title: doc.title } : {}), description: doc.description });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}
