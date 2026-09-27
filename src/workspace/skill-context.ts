import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSkillResource, readUtf8Resource, validateSkillName, withinSkillBoundary, SkillAccessError, type SkillSummary } from './skills.js';

export type SkillSource = 'project' | 'user' | 'custom';
export interface SkillLocation { directory: string; source: SkillSource; workspace?: string }
export interface LocatedSkill extends SkillSummary { source: SkillSource }
export interface SkillIssue { name: string; source: SkillSource; code: SkillAccessError['code']; reason: string }
export interface SkillCatalog { skills: LocatedSkill[]; issues: SkillIssue[] }

/** Pass only an admitted session's workspace. No workspace means no automatic
 * discovery: only an explicit operator library retains keyless access. Custom
 * replaces the user default, never the project. Missing paths do not change
 * source selection. Relative custom paths use the daemon's launch directory. */
export function skillLocations(configured?: string, workspace?: string, home = os.homedir(), cwd = process.cwd()): SkillLocation[] {
  const custom = configured?.trim();
  const locations: SkillLocation[] = workspace
    ? [{ directory: path.join(workspace, '.agents', 'skills'), source: 'project', workspace }] : [];
  if (custom) {
    const expanded = custom === '~' ? home
      : /^~[\\/]/.test(custom) ? path.join(home, custom.slice(2).replace(/[\\/]/g, path.sep)) : custom;
    locations.push({ directory: path.resolve(cwd, expanded), source: 'custom' });
  } else if (workspace) {
    locations.push({ directory: path.join(home, '.agents', 'skills'), source: 'user' });
  }
  return locations;
}

function failure(error: unknown): SkillAccessError {
  if (error instanceof SkillAccessError) return error;
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR'
    ? new SkillAccessError('not_found', 'The skill or project instructions do not exist.')
    : new SkillAccessError('unreadable', 'The skill or project instructions could not be read.');
}
function libraryFailure(location: SkillLocation, error: unknown): SkillAccessError {
  if (error instanceof SkillAccessError) return error;
  const code = (error as NodeJS.ErrnoException)?.code;
  return new SkillAccessError(code === 'ENOTDIR' ? 'invalid_path' : 'unreadable',
    `The ${location.source} skill library could not be read as a directory; discovery is not complete.`);
}
function checkLibraryDirectory(location: SkillLocation, directory: string): void {
  try {
    const real = fs.realpathSync(directory);
    if (location.workspace && !withinSkillBoundary(fs.realpathSync(location.workspace), real)) {
      throw new SkillAccessError('invalid_path', 'The project skill library points outside its workspace.');
    }
    if (!fs.statSync(real).isDirectory()) {
      throw new SkillAccessError('invalid_path', `The ${location.source} skill library must be a directory.`);
    }
  } catch (error) { throw libraryFailure(location, error); }
}
function checkLibrary(location: SkillLocation): boolean {
  let current = location.directory;
  for (;;) {
    try { fs.lstatSync(current); }
    catch (error) {
      const parent = path.dirname(current);
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT' || parent === current) throw libraryFailure(location, error);
      // Windows also reports ENOENT for a file used as a parent. Validate the
      // nearest existing ancestor so wrong-type/dangling/escaping paths do not
      // masquerade as optional missing libraries on any platform.
      current = parent;
      continue;
    }
    checkLibraryDirectory(location, current);
    return current === location.directory;
  }
}

/** Shared name-claim rule for listing and reads. Plain files are not skills.
 * Directories and links claim a name before validation, so a broken/escaping
 * override cannot reveal a lower version. Native lookup respects volume case. */
function claimsName(location: SkillLocation, name: string): boolean {
  try {
    const entry = fs.lstatSync(path.join(location.directory, name));
    return entry.isDirectory() || entry.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
    throw failure(error);
  }
}

/** Catalog completeness means discovery finished, not that every entry is
 * healthy. Report invalid selected entries separately; never advertise them or
 * silently replace them. Library-level failures abort the entire catalog. */
export function listContextSkills(locations: SkillLocation[]): SkillCatalog {
  const skills: LocatedSkill[] = [], issues: SkillIssue[] = [], preceding: SkillLocation[] = [];
  for (const location of locations) {
    if (!checkLibrary(location)) continue;
    let names: string[];
    try { names = fs.readdirSync(location.directory); }
    catch (error) { throw libraryFailure(location, error); }
    for (const name of names) {
      try { validateSkillName(name); } catch { continue; }
      if (preceding.some(higher => claimsName(higher, name))) continue;
      try {
        if (!claimsName(location, name)) continue;
        const doc = readSkillResource(location.directory, name, 'SKILL.md', 0, location.workspace);
        if (doc.kind !== 'directory') skills.push({ name: doc.name, ...(doc.title ? { title: doc.title } : {}), description: doc.description, source: location.source });
      } catch (error) {
        const issue = failure(error);
        issues.push({ name, source: location.source, code: issue.code, reason: issue.message });
      }
    }
    preceding.push(location);
  }
  return { skills: skills.sort((a, b) => a.name.localeCompare(b.name)), issues: issues.sort((a, b) => a.name.localeCompare(b.name)) };
}

export function readContextSkill(locations: SkillLocation[], name: string, resourcePath?: string, offset?: number) {
  validateSkillName(name);
  for (const location of locations) {
    if (!checkLibrary(location) || !claimsName(location, name)) continue;
    const resource = readSkillResource(location.directory, name, resourcePath, offset, location.workspace);
    return { ...resource, source: location.source };
  }
  throw new SkillAccessError('not_found', 'No skill with this folder identifier exists in the selected libraries.');
}

export interface ProjectInstructions {
  status: 'ok' | SkillAccessError['code'];
  path?: string;
  content?: string;
  bytes?: number;
  complete?: true;
  reason?: string;
}

/** Only the admitted session's root, never a parent repository or user home.
 * Missing is optional; existing but unsafe/unreadable is an explicit failure. */
export function readProjectInstructions(workspace: string): ProjectInstructions | undefined {
  let filename: string | undefined;
  try {
    const root = fs.realpathSync(workspace);
    const names = fs.readdirSync(root);
    filename = names.includes('AGENTS.md') ? 'AGENTS.md' : names.includes('agents.md') ? 'agents.md' : undefined;
    if (!filename) return undefined;
    const file = fs.realpathSync(path.join(root, filename));
    if (!withinSkillBoundary(root, file)) throw new SkillAccessError('invalid_path', 'Project instructions point outside the workspace.');
    if (!fs.statSync(file).isFile()) throw new SkillAccessError('not_text', 'Project instructions must be a regular UTF-8 text file.');
    const { content, bytes } = readUtf8Resource(file);
    return { status: 'ok', path: filename, content, bytes, complete: true };
  } catch (error) {
    const issue = failure(error);
    if (!filename && issue.code === 'not_found') return undefined;
    return { status: issue.code, ...(filename ? { path: filename } : {}), reason: issue.message };
  }
}
