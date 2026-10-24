import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { CoreDescriptor } from '../../contracts/src/core-runtime.js';

// The manager itself executes under either Desktop's Node or VS Code's
// Electron/Node host. Never accept an executable path from a Web request or
// configuration file as a replacement for the signed Core runtime.
export function selectCoreNodeRuntime(
  descriptor: CoreDescriptor,
  coreRoot: string,
  host: { execPath: string; versions: { node?: string; electron?: string } } = process,
): { executable: string; electronRunAsNode: boolean } {
  if (descriptor.formatVersion === 1) {
    return { executable: path.join(coreRoot, descriptor.nodeEntry), electronRunAsNode: false };
  }
  const validVersion = /^[0-9]+[.][0-9]+[.][0-9]+$/;
  if (!validVersion.test(descriptor.nodeMinVersion) || !validVersion.test(host.versions.node ?? '')) throw new Error('core_host_node_version_invalid');
  const have = (host.versions.node ?? '').split('.').map(Number);
  const need = descriptor.nodeMinVersion.split('.').map(Number);
  if (have.some((v, i) => have.slice(0, i).every((n, j) => n === need[j]) && v < (need[i] ?? Number.POSITIVE_INFINITY))) throw new Error('core_host_node_incompatible');
  let hostBinaryValid = false;
  if (path.isAbsolute(host.execPath)) {
    try { hostBinaryValid = fs.statSync(host.execPath).isFile(); } catch { /* fail closed */ }
  }
  if (!hostBinaryValid) throw new Error('core_host_node_path_invalid');
  // The full daemon and native dependencies are still signed members. Only the
  // runtime executable is provided by the already-running host.
  // Load SQLite only for a new v2 spawn. Older hosts may still attach to an
  // existing compatible Core without evaluating an unavailable builtin.
  try {
    const { DatabaseSync } = createRequire(process.execPath)('node:sqlite') as typeof import('node:sqlite');
    if (typeof DatabaseSync !== 'function') throw Error('sqlite_unavailable');
    const db = new DatabaseSync(':memory:');
    try { db.exec('SELECT 1'); } finally { db.close(); }
  } catch { throw new Error('core_host_node_sqlite_unavailable'); }
  return { executable: host.execPath, electronRunAsNode: Boolean(host.versions.electron) };
}

export function coreNodeEnvironment(input: NodeJS.ProcessEnv, runAsNode: boolean): NodeJS.ProcessEnv {
  const output = { ...input };
  for (const name of Object.keys(output)) {
    if (['NODE_OPTIONS','NODE_PATH','ELECTRON_RUN_AS_NODE'].includes(name.toUpperCase())) delete output[name];
  }
  if (runAsNode) output.ELECTRON_RUN_AS_NODE = '1';
  return output;
}
