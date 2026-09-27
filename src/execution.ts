import path from 'node:path';
import { WORKSPACE_FILE_TOOL } from './tool-routing.js';
import { spawnSync } from 'node:child_process';
import { detectPowerShell } from './workspace/pwsh.js';
import { processPlatformSupported } from './process/backend.js';
import { detectShell, type ShellAdapter } from './workspace/shell.js';
import { isWindowsAppExecutionPath, resolveWindowsExecutable, windowsEnvValue, windowsSystemRoot } from './workspace/windows-env.js';
import { sandboxCapability, type SandboxCapability } from './workspace/posix-sandbox.js';

export interface ShellMetadata {
  executable: string;
  syntax: 'powershell' | 'bash' | 'zsh' | 'sh' | 'cmd';
  version: string | null;
}
export interface ExecutionEnvironment {
  platform: NodeJS.Platform;
  arch: string;
  exec: { shell: ShellMetadata; state: 'session' | 'cwd-only'; adapter: ShellAdapter | null; pwshBin: string | null; helpers: { rg: boolean; grep: boolean } };
  process: { available: boolean; shell: ShellMetadata; state: 'independent'; reason?: string };
  /** Restricted-mode enforcement fact captured once at daemon startup. */
  sandbox: SandboxCapability;
}
export interface ProcessManagementCapability {
  owner: 'job-object' | 'process-group-supervisor' | 'unavailable';
  cleanup_guarantee: 'kernel-owned' | 'confirmed-or-unknown' | 'unavailable';
}
export function processManagementCapability(platform:string,available:boolean):ProcessManagementCapability {
  if(!available)return {owner:'unavailable',cleanup_guarantee:'unavailable'};
  if(platform==='win32')return {owner:'job-object',cleanup_guarantee:'kernel-owned'};
  if(platform==='linux'||platform==='darwin')return {owner:'process-group-supervisor',cleanup_guarantee:'confirmed-or-unknown'};
  return {owner:'unavailable',cleanup_guarantee:'unavailable'};
}

function probe(executable: string, syntax: ShellMetadata['syntax']): { shell: ShellMetadata; available: boolean } {
  const args = syntax === 'powershell'
    ? ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()']
    : syntax === 'cmd' ? ['/d', '/c', 'ver'] : syntax === 'sh' ? ['-c', 'exit 0'] : ['--version'];
  try {
    const result = spawnSync(executable, args, { encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 8192 });
    const version = (result.stdout ?? '').match(/\d+\.\d+(?:\.\d+){0,2}/)?.[0] ?? null;
    return { shell: { executable, syntax, version }, available: !result.error && result.status === 0 };
  } catch { return { shell: { executable, syntax, version: null }, available: false }; }
}
function preferredProcessShell(): { executable: string; syntax: ShellMetadata['syntax'] } | undefined {
  const configured = process.env.BLACKHOLE_PROCESS_SHELL?.trim();
  if (!configured) return undefined;
  const executable = process.platform === 'win32' ? resolveWindowsExecutable(configured) : configured;
  if (!executable) return undefined;
  const base = path.basename(executable).toLowerCase();
  if (process.platform === 'win32') {
    if (base === 'powershell.exe' || base === 'pwsh.exe') return { executable, syntax: 'powershell' };
    if (base === 'cmd.exe') return { executable, syntax: 'cmd' };
    if (base === 'bash.exe') return { executable, syntax: 'bash' };
    return undefined;
  }
  if (base === 'bash') return { executable, syntax: 'bash' };
  if (base === 'zsh') return { executable, syntax: 'zsh' };
  if (base === 'sh') return { executable, syntax: 'sh' };
  return undefined;
}


function executableOnPath(name: 'rg' | 'grep', env: NodeJS.ProcessEnv = process.env): boolean {
  if (process.platform === 'win32') {
    const explicit = name === 'rg' ? windowsEnvValue(env, 'BLACKHOLE_RG') : undefined;
    const candidate = (explicit ? resolveWindowsExecutable(explicit, env) : null)
      ?? resolveWindowsExecutable(name, env);
    if (!candidate) return false;
    try {
      const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 1500, maxBuffer: 4096 });
      return !probe.error && probe.status === 0;
    } catch { return false; }
  }
  const pathValue = env.PATH ?? '';
  for (const raw of pathValue.split(':').filter(Boolean)) {
    const candidate = path.join(raw, name);
    try {
      const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 1500, maxBuffer: 4096 });
      if (!probe.error && probe.status === 0) return true;
    } catch { /* keep probing */ }
  }
  return false;
}

export function detectSearchHelpers(env: NodeJS.ProcessEnv = process.env): { rg: boolean; grep: boolean } {
  return { rg: executableOnPath('rg', env), grep: executableOnPath('grep', env) };
}
/** Resolve once at daemon startup; permissions remain per call, while sandbox capability is an explicit cached fact. */
export function detectExecutionEnvironment(): ExecutionEnvironment {
  const adapter = detectShell(), powershell = detectPowerShell();
  const selected = powershell
    ? { shell: { ...powershell, syntax: 'powershell' as const }, available: true }
    : adapter
      ? probe(adapter.executable ?? adapter.name, adapter.name === 'cmd' ? 'cmd' : adapter.name === 'zsh' ? 'zsh' : adapter.name === 'sh' ? 'sh' : 'bash')
      : null;
  if (!selected?.available) throw new Error(`No supported finite command shell is available${selected?.shell.executable ? ` (${selected.shell.executable})` : ''}`);
  // POSIX detection already selected and verified the configured/default shell.
  // Re-probing an invalid preference here used to disable process despite a
  // working fallback, making the native MCP tool disappear from discovery.
  let background = selected;
  if (process.platform === 'win32') {
    const root = windowsSystemRoot();
    const candidates = [
      preferredProcessShell(),
      root ? { executable: path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), syntax: 'powershell' as const } : undefined,
      selected.shell,
      adapter ? { executable: adapter.executable ?? adapter.name, syntax: adapter.name === 'cmd' ? 'cmd' as const : 'bash' as const } : undefined,
    ];
    background = { shell: selected.shell, available: false };
    const seen = new Set<string>();
    for (const candidate of candidates) {
      if (!candidate || isWindowsAppExecutionPath(candidate.executable)) continue;
      const identity = candidate.executable.toLowerCase();
      if (seen.has(identity)) continue;
      seen.add(identity);
      // Store aliases can escape Job ownership. Try another direct interpreter,
      // not an unconfined/brokered launch, when a saved profile or inbox probe fails.
      const checked = identity === selected.shell.executable.toLowerCase() ? selected : probe(candidate.executable, candidate.syntax);
      if (checked.available) { background = checked; break; }
    }
  }
  const implemented = processPlatformSupported(process.platform, process.arch);
  const sandbox=sandboxCapability(process.platform);
  return {
    platform: process.platform, arch: process.arch,
    exec: { shell: selected.shell, state: powershell ? 'session' : 'cwd-only', adapter, pwshBin: powershell?.executable ?? null, helpers: detectSearchHelpers() },
    process: { available: implemented && background.available, shell: background.shell, state: 'independent',
      ...(!implemented ? { reason: 'unsupported_platform' } : !background.available ? { reason: 'shell_unavailable' } : {}) },
    sandbox,
  };
}

export function shellLabel(shell: ShellMetadata): string {
  return (shell.syntax === 'powershell' ? 'PowerShell' : shell.syntax === 'cmd' ? 'cmd.exe' : shell.syntax)
    + (shell.version ? ' ' + shell.version : '');
}

export function finiteDescription(environment: ExecutionEnvironment): string {
  const state = environment.exec.state === 'session' ? 'cwd, variables and functions persist within the session.' : 'Only cwd persists; variables and functions do not.';
  // Keep this as a tiny capability hint, not a command tutorial: coding agents
  // already know rg/grep syntax; naming only helpers verified at startup is enough.
  const helpers = (['rg', 'grep'] as const).filter((name) => environment.exec.helpers[name]);
  const search = helpers.length ? ` Search: ${helpers.join(', ')}.` : '';
  return `Run a finite command and wait for its result. Shell: ${shellLabel(environment.exec.shell)}.${search} ${state} Start in the workspace. Use ${WORKSPACE_FILE_TOOL} for file inspection/editing.`
    + (environment.process.available ? ' Use process for background servers/watch.' : '');
}
