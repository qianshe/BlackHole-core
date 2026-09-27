import fs from 'node:fs';
import path from 'node:path';

/** Case-insensitive lookup for Windows environment blocks (`Path` vs `PATH`). */
export function windowsEnvValue(host: NodeJS.ProcessEnv, key: string): string | undefined {
  const exact = host[key];
  if (exact !== undefined) return exact;
  const wanted = key.toLowerCase();
  for (const [name, value] of Object.entries(host)) {
    if (name.toLowerCase() === wanted && value !== undefined) return value;
  }
  return undefined;
}

/** Store aliases/packages can broker launches outside the caller's Job Object. */
export function isWindowsAppExecutionPath(file: string): boolean {
  return /(?:^|[\\/])WindowsApps(?:[\\/]|$)/i.test(file);
}
/** "/f/x/y" -> "F:\\x\\y"; null when not an MSYS drive path. */
export function msysPathToWindows(entry: string): string | null {
  // MSYS virtual roots such as /usr/bin are not Windows drive mounts. They are
  // unusable by native Windows process lookup and must not become bogus U:\\sr paths.
  if (/^\/(?:usr|bin|mingw\d*|etc|tmp|home|dev|proc)(?:\/|$)/i.test(entry)) return null;
  const match = /^\/([a-zA-Z])\/(.*)$/.exec(entry);
  return match ? `${match[1]!.toLowerCase()}:\\${match[2]!.replace(/\//g, '\\')}` : null;
}

function comparable(entry: string): string {
  const unquoted = entry.trim().replace(/^"(.*)"$/, '$1');
  return path.win32.normalize(unquoted).replace(/[\\/]+$/, '').toLowerCase();
}

function normalizedEntries(raw: string): string[] {
  const segments = raw.includes(';') ? raw.split(';') : [raw];
  return segments.flatMap(segment => {
    const value = segment.trim().replace(/^"(.*)"$/, '$1');
    if (!value) return [];
    // A VS Code helper may have been prepended with `;` to an inherited MSYS
    // PATH. Convert the remaining `/c/...:/d/...` segment instead of treating
    // it as one invalid Windows directory.
    const msysList = value.startsWith('/') && /(^|:)\/[a-zA-Z]\//.test(value);
    if (!msysList) return [value];
    return value.split(':').flatMap(entry => {
      const converted = msysPathToWindows(entry);
      return converted ? [converted] : [];
    });
  });
}

export function windowsSystemRoot(host: NodeJS.ProcessEnv = process.env): string | null {
  const direct = (windowsEnvValue(host, 'SystemRoot') ?? windowsEnvValue(host, 'WINDIR'))?.trim().replace(/^"(.*)"$/, '$1');
  if (direct && path.win32.isAbsolute(direct)) return path.win32.normalize(direct);
  const comSpec = windowsEnvValue(host, 'ComSpec');
  if (comSpec && path.win32.isAbsolute(comSpec)) {
    const systemDir = path.win32.dirname(comSpec);
    if (path.win32.basename(systemDir).toLowerCase() === 'system32') return path.win32.dirname(systemDir);
  }
  return null;
}

/**
 * Build the PATH used by every Windows exec/process child.
 *
 * Invariants:
 * - normalize pure or hybrid MSYS drive entries;
 * - keep operator/VS Code helpers ahead of inherited entries;
 * - preserve inherited ordering;
 * - guarantee the Windows runtime directories needed by cmd/chcp/taskkill;
 * - de-duplicate case-insensitively.
 */
export function windowsExecutionPath(raw: string, host: NodeJS.ProcessEnv = process.env): string {
  const entries: string[] = [];
  const seen = new Set<string>();
  const add = (entry: string | undefined, where: 'front' | 'back' = 'back') => {
    if (!entry) return;
    const clean = entry.trim().replace(/^"(.*)"$/, '$1');
    if (!clean) return;
    const key = comparable(clean);
    if (!key || seen.has(key)) return;
    seen.add(key);
    if (where === 'front') entries.unshift(clean);
    else entries.push(clean);
  };

  for (const entry of normalizedEntries(raw)) add(entry);

  const rg = windowsEnvValue(host, 'BLACKHOLE_RG')?.trim();
  if (rg && path.win32.isAbsolute(rg)) add(path.win32.dirname(rg), 'front');
  add(windowsEnvValue(host, 'BLACKHOLE_GIT_USR_BIN')?.trim(), 'front');

  const root = windowsSystemRoot(host);
  if (root) {
    add(path.win32.join(root, 'System32'));
    add(root);
  }
  return entries.join(';');
}

/** Resolve an executable against the same PATH that BlackHole children receive. */

/**
 * Whether Windows can address a path as an executable candidate.
 * `existsSync` is deliberately insufficient here: App Execution Aliases under
 * WindowsApps can be spawnable while Node's stat-based existsSync reports false.
 * Actual executability remains the caller's responsibility (probe/spawn).
 */
export function windowsExecutableAccessible(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
export function resolveWindowsExecutable(
  command: string,
  host: NodeJS.ProcessEnv = process.env,
  exists: (file: string) => boolean = windowsExecutableAccessible,
): string | null {
  const clean = command.trim().replace(/^"(.*)"$/, '$1');
  if (!clean) return null;
  if (path.win32.isAbsolute(clean)) return exists(clean) ? path.win32.normalize(clean) : null;
  if (/[\\/]/.test(clean)) return null;

  const hasExtension = path.win32.extname(clean) !== '';
  const extensions = hasExtension
    ? ['']
    : (windowsEnvValue(host, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const rawPath = windowsEnvValue(host, 'PATH') ?? '';
  for (const directory of windowsExecutionPath(rawPath, host).split(';').filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.win32.join(directory, clean + extension.toLowerCase());
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

/** Resolve the Windows command processor without relying on PATH lookup. */
export function resolveWindowsCommandShell(
  host: NodeJS.ProcessEnv = process.env,
  exists: (file: string) => boolean = windowsExecutableAccessible,
): string | null {
  const comSpec = windowsEnvValue(host, 'ComSpec')?.trim().replace(/^"(.*)"$/, '$1');
  if (comSpec && path.win32.isAbsolute(comSpec) && exists(comSpec)) return path.win32.normalize(comSpec);
  const root = windowsSystemRoot(host);
  const inbox = root ? path.win32.join(root, 'System32', 'cmd.exe') : null;
  if (inbox && exists(inbox)) return inbox;
  return resolveWindowsExecutable('cmd.exe', host, exists);
}
