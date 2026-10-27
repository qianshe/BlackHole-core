/**
 * Read-only directory browsing for the authenticated local session Inspector.
 * Paths are relative to one session's workspace, never arbitrary computer paths.
 */
import fs from 'node:fs';
import path from 'node:path';

export const MAX_WORKSPACE_ITEMS = 400;
export const MAX_PREVIEW_BYTES = 128 * 1024;

export class WorkspaceBrowseError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

export interface WorkspaceEntry {
  name: string;
  path: string;
  type: 'dir' | 'file';
}

function rootPath(workspace: string): string {
  try {
    const root = fs.realpathSync(workspace);
    if (!fs.statSync(root).isDirectory()) throw new WorkspaceBrowseError(404, 'workspace_not_found');
    return root;
  } catch (cause) {
    if (cause instanceof WorkspaceBrowseError) throw cause;
    throw new WorkspaceBrowseError(404, 'workspace_not_found');
  }
}

function withinRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
}

function resolveWorkspacePath(root: string, relative: string): string {
  if (typeof relative !== 'string' || relative.length > 4096 || relative.includes('\0') ||
    path.isAbsolute(relative) || path.win32.isAbsolute(relative) || /^[A-Za-z]:/.test(relative)) {
    throw new WorkspaceBrowseError(400, 'invalid_workspace_path');
  }
  const candidate = path.resolve(root, relative);
  if (!withinRoot(root, candidate)) throw new WorkspaceBrowseError(403, 'outside_workspace');
  let real: string;
  try { real = fs.realpathSync(candidate); }
  catch { throw new WorkspaceBrowseError(404, 'workspace_entry_not_found'); }
  if (!withinRoot(root, real)) throw new WorkspaceBrowseError(403, 'outside_workspace');
  return real;
}

function itemPath(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join('/');
}

export function listWorkspaceEntries(workspace: string, relative = ''): { path: string; entries: WorkspaceEntry[]; truncated: boolean } {
  const root = rootPath(workspace);
  const directory = resolveWorkspacePath(root, relative);
  try {
    if (!fs.statSync(directory).isDirectory()) throw new WorkspaceBrowseError(400, 'not_directory');
    const all = fs.readdirSync(directory, { withFileTypes: true })
      .filter((item) => !item.isSymbolicLink() && (item.isFile() || item.isDirectory()))
      .map((item) => ({ name: item.name, path: itemPath(root, path.join(directory, item.name)), type: item.isDirectory() ? 'dir' as const : 'file' as const }))
      .sort((a, b) => Number(a.type === 'file') - Number(b.type === 'file') || a.name.localeCompare(b.name));
    return { path: itemPath(root, directory), entries: all.slice(0, MAX_WORKSPACE_ITEMS), truncated: all.length > MAX_WORKSPACE_ITEMS };
  } catch (cause) {
    if (cause instanceof WorkspaceBrowseError) throw cause;
    throw new WorkspaceBrowseError(403, 'workspace_unreadable');
  }
}

export function readWorkspacePreview(workspace: string, relative: string): { path: string; content: string } {
  const root = rootPath(workspace);
  if (!relative) throw new WorkspaceBrowseError(400, 'invalid_workspace_path');
  const file = resolveWorkspacePath(root, relative);
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new WorkspaceBrowseError(400, 'not_file');
    if (stat.size > MAX_PREVIEW_BYTES) throw new WorkspaceBrowseError(413, 'workspace_file_too_large');
    const bytes = fs.readFileSync(file);
    if (bytes.includes(0)) throw new WorkspaceBrowseError(415, 'workspace_file_binary');
    let content: string;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new WorkspaceBrowseError(415, 'workspace_file_binary'); }
    return { path: itemPath(root, file), content };
  } catch (cause) {
    if (cause instanceof WorkspaceBrowseError) throw cause;
    throw new WorkspaceBrowseError(403, 'workspace_unreadable');
  }
}
