import fs from 'node:fs';
import path from 'node:path';

export interface RipgrepHost {
  platform: NodeJS.Platform;
  arch: string;
  appRoot: string;
  pathValue?: string;
}

const executableName = (platform: NodeJS.Platform): string => platform === 'win32' ? 'rg.exe' : 'rg';
export function pathFromEnvironment(env: NodeJS.ProcessEnv): string | undefined {
  const direct = env.PATH;
  if (direct !== undefined) return direct;
  const entry = Object.entries(env).find(([key, value]) => key.toLowerCase() === 'path' && value !== undefined);
  return entry?.[1];
}


/** Resolve an existing rg from PATH without spawning a shell. */
export function rgOnPath(host: RipgrepHost, exists: (file: string) => boolean = fs.existsSync): string | undefined {
  const name = executableName(host.platform), delimiter = host.platform === 'win32' ? ';' : ':';
  const paths = host.platform === 'win32' ? path.win32 : path.posix;
  for (const entry of (host.pathValue ?? '').split(delimiter).filter(Boolean)) {
    const dir = entry.trim().replace(/^"(.*)"$/, '$1');
    const candidate = paths.join(dir, name);
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Best-effort lookup of the ripgrep binary shipped by the current VS Code host.
 * appRoot is stable API; package layout is not, so every known layout is probed
 * and absence simply falls back to grep/Select-String instead of failing startup.
 */
export function bundledVsCodeRg(host: RipgrepHost, exists: (file: string) => boolean = fs.existsSync): string | undefined {
  if (!host.appRoot) return undefined;
  const name = executableName(host.platform), platformArch = `${host.platform}-${host.arch}`;
  const paths = host.platform === 'win32' ? path.win32 : path.posix;
  const roots = ['node_modules.asar.unpacked', 'node_modules'];
  const candidates: string[] = [];
  for (const modules of roots) {
    candidates.push(paths.join(host.appRoot, modules, '@vscode', 'ripgrep-universal', 'bin', platformArch, name));
    candidates.push(paths.join(host.appRoot, modules, '@vscode', 'ripgrep', 'bin', name));
    candidates.push(paths.join(host.appRoot, modules, '@vscode', 'ripgrep', 'bin', platformArch, name));
    candidates.push(paths.join(host.appRoot, modules, 'vscode-ripgrep', 'bin', name));
  }
  return candidates.find(exists);
}

/** Existing PATH always wins; otherwise return the current VS Code host's rg. */
export function resolveExecutionRg(host: RipgrepHost, exists: (file: string) => boolean = fs.existsSync): string | undefined {
  return rgOnPath(host, exists) ?? bundledVsCodeRg(host, exists);
}

export function prependToolDirectory(pathValue: string | undefined, executable: string, platform: NodeJS.Platform): string {
  const delimiter = platform === 'win32' ? ';' : ':', paths = platform === 'win32' ? path.win32 : path.posix;
  const dir = paths.dirname(executable);
  const comparable = (value: string): string => {
    const normalized = paths.normalize(value.trim().replace(/^"(.*)"$/, '$1')).replace(/[\\/]+$/, '');
    return platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  const entries = (pathValue ?? '').split(delimiter).filter(Boolean);
  if (entries.some(entry => comparable(entry) === comparable(dir))) return pathValue ?? '';
  return [dir, ...entries].join(delimiter);
}
