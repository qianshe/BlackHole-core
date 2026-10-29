import fs from 'node:fs';
import path from 'node:path';

/**
 * Resolves a user-supplied path against the workspace and rejects anything
 * that lexically escapes it (`..`, absolute paths pointing outside).
 * Returns an absolute OS path that may still contain symlinked segments.
 */
export function resolveInWorkspace(workspace: string, target: string): string {
  if (target.includes('\0')) {
    throw new Error('invalid path');
  }
  const base = path.resolve(workspace);
  const resolved = path.isAbsolute(target) ? path.resolve(target) : path.resolve(base, target);
  const rel = path.relative(base, resolved);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`path escapes workspace: ${target}`);
  }
  return resolved;
}

/**
 * Resolves a user-supplied path against the workspace and returns the
 * REAL path the caller must use: lexical containment first, then symlink
 * containment on the freshly-resolved identity. Check-then-write must go
 * through here (never resolveInWorkspace + assertRealPathInWorkspace in
 * sequence) so the checked path IS the mutated path — the containment
 * re-check happens in the same resolution the write will use, closing the
 * check-here-write-there race (an ancestor symlink swapped between a
 * separate check and the write).
 */
export function checkedPathInWorkspace(workspace: string, target: string): string {
  const resolved = resolveInWorkspace(workspace, target);
  assertRealPathInWorkspace(workspace, resolved);
  return realPathOf(resolved);
}

/**
 * Full-access sessions: any path on this machine, resolved against the workspace when
 * relative. Still returns the REAL path the caller writes through (same rule as above).
 */
export function checkedPathAnywhere(workspace: string, target: string): string {
  if (target.includes('\0')) throw new Error('invalid path');
  const resolved = path.isAbsolute(target) ? path.resolve(target) : path.resolve(workspace, target);
  return realPathOf(resolved);
}

/**
 * Workspace-write sessions with operator-granted directories: the target must sit inside
 * the workspace or one of `roots` (lexically and through symlinks). Throws the workspace
 * error when none matches, so the message stays the familiar one.
 */
export function checkedPathInRoots(workspace: string, roots: readonly string[], target: string): string {
  try {
    return checkedPathInWorkspace(workspace, target);
  } catch (first) {
    if (target.includes('\0')) throw first;
    const abs = path.isAbsolute(target) ? path.resolve(target) : path.resolve(workspace, target);
    for (const root of roots) {
      try {
        return checkedPathInWorkspace(root, abs);
      } catch {
        /* try the next granted root */
      }
    }
    throw first;
  }
}

/** Realpath of `resolved`, or its nearest-existing-ancestor resolution for not-yet-created files. */
function realPathOf(resolved: string): string {
  try {
    return fs.realpathSync(resolved);
  } catch {
    let dir = path.dirname(resolved);
    let existing: string | null = null;
    for (;;) {
      try {
        existing = fs.realpathSync(dir);
        break;
      } catch {
        const parent = path.dirname(dir);
        if (parent === dir) {
          throw new Error('workspace root is unavailable');
        }
        dir = parent;
      }
    }
    return path.join(existing as string, path.relative(dir, resolved));
  }
}

/**
 * Symlink escape check. Resolves the real path of the target (or of its
 * nearest existing ancestor for not-yet-created files) and verifies it stays
 * inside the real workspace root.
 */
export function assertRealPathInWorkspace(workspace: string, resolved: string): void {
  const baseReal = fs.realpathSync(workspace);
  const real = realPathOf(resolved);
  const rel = path.relative(baseReal, real);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`path escapes workspace via symlink: ${resolved}`);
  }
}
