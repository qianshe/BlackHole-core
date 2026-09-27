import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';

/**
 * Resolve an absolute target path and guarantee it stays inside the workspace root.
 * Rejects path traversal ("..") and symlink escapes by comparing realpath of the
 * nearest existing ancestor. All tool file operations must go through this.
 */
export class Workspace {
  constructor(root) {
    this.root = path.resolve(root);
    this.rootReal = existsSync(this.root) ? fs.realpath(this.root) : Promise.resolve(this.root);
  }

  async _realAncestor(target) {
    // Walk up until we find an existing path, then realpath it.
    let cur = target;
    const tail = [];
    while (!existsSync(cur)) {
      const parent = path.dirname(cur);
      if (parent === cur) break;
      tail.unshift(path.basename(cur));
      cur = parent;
    }
    const realCur = await fs.realpath(cur);
    return path.resolve(realCur, ...tail);
  }

  isWithin(resolvedPath) {
    const rel = path.relative(this.root, resolvedPath);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  }

  /** Returns the validated absolute path, or throws a BoundaryError. */
  async guard(absoluteOrRelative) {
    if (typeof absoluteOrRelative !== 'string' || absoluteOrRelative.length === 0) {
      throw new BoundaryError('path must be a non-empty string');
    }
    const abs = path.isAbsolute(absoluteOrRelative)
      ? path.resolve(absoluteOrRelative)
      : path.resolve(this.root, absoluteOrRelative);

    if (!this.isWithin(abs)) {
      throw new BoundaryError(`path escapes workspace root: ${abs}`);
    }
    const real = await this._realAncestor(abs);
    const rootReal = await this.rootReal;
    if (!this.isWithin(real) && !this._isWithinBase(real, rootReal)) {
      throw new BoundaryError(`path escapes workspace via symlink: ${real}`);
    }
    return abs;
  }

  _isWithinBase(p, base) {
    const rel = path.relative(base, p);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  }
}

export class BoundaryError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'BoundaryError';
  }
}
