import fs from 'node:fs';
import type { DaemonDeps } from '../deps.js';
import { normalizePermissionMode, PERMISSION_MODES } from '../config.js';

/**
 * Session creation shared by the control API (/api/sessions) and the Local Web
 * (/web-api/v1/sessions): one set of path and mode checks for both callers.
 */
export interface CreateSessionInput {
  workspace_path?: unknown;
  permission_mode?: unknown;
  expires_in_s?: unknown;
  name?: unknown;
  writable_dirs?: unknown;
  auto_approve?: unknown;
  /** Reserve only: nothing is stored until the first tool call uses the credential. */
  draft?: unknown;
}

type Created = ReturnType<DaemonDeps['sessions']['create']>;

/** writableDirs: realpath + existing directory + dedupe + at most 8. */
export function normalizeWritableDirs(input: unknown): string[] | { error: string } {
  if (input === undefined) return [];
  if (!Array.isArray(input)) return { error: 'writable_dirs must be an array of directory paths' };
  const out: string[] = [];
  for (const raw of input.slice(0, 8)) {
    if (typeof raw !== 'string' || raw.trim() === '') return { error: 'writable_dirs entries must be non-empty strings' };
    let real: string;
    try {
      real = fs.realpathSync(raw);
      if (!fs.statSync(real).isDirectory()) throw new Error('not a directory');
    } catch (e) {
      return { error: `writable_dirs "${raw}": ${e instanceof Error ? e.message : String(e)}` };
    }
    if (!out.some((d) => d.toLowerCase() === real.toLowerCase())) out.push(real);
  }
  return out;
}

/** Canonical existing directory, or an error message. */
export function canonicalDir(input: unknown): { path: string } | { error: string } {
  if (typeof input !== 'string' || input.length === 0) return { error: 'workspace_path is required' };
  try {
    const real = fs.realpathSync(input);
    if (!fs.statSync(real).isDirectory()) throw new Error('not a directory');
    return { path: real };
  } catch (e) {
    return { error: `invalid workspace_path: ${e instanceof Error ? e.message : e}` };
  }
}

export function createWorkspaceSession(deps: DaemonDeps, body: CreateSessionInput): { session: Created } | { error: string } {
  const dir = canonicalDir(body.workspace_path);
  if ('error' in dir) return dir;
  const workspace = dir.path;
  // legacy trusted/guarded spellings normalize to workspace-write
  const mode = normalizePermissionMode(typeof body.permission_mode === 'string' ? body.permission_mode : 'workspace-write');
  if (!PERMISSION_MODES.includes(mode)) return { error: `permission_mode must be one of ${PERMISSION_MODES.join(', ')}` };
  // optional task text: becomes the display name and lands in the prompt
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 500) : '';
  const expiresAt = typeof body.expires_in_s === 'number' && body.expires_in_s > 0 ? Date.now() + body.expires_in_s * 1000 : null;
  const writableDirs = normalizeWritableDirs(body.writable_dirs);
  if (!Array.isArray(writableDirs)) return { error: writableDirs.error };
  const input = {
    workspace_path: workspace,
    permission_mode: mode,
    name: name || null,
    expires_at: expiresAt,
    writable_dirs: writableDirs,
    auto_approve: body.auto_approve === true || body.auto_approve === 1 || body.auto_approve === '1',
  };
  // A draft is only reserved; SessionsRepo stores it (and daemon.ts logs session_created) on first use.
  if (body.draft === true) return { session: deps.sessions.createDraft(input) };
  const session = deps.sessions.create(input);
  deps.events.append(session.id, 'session_created', {
    workspace_path: workspace,
    permission_mode: mode,
    name: name || null,
    expires_at: expiresAt,
    writable_dirs: writableDirs,
  });
  return { session };
}
