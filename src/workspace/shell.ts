import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {PermissionMode} from '../config.js';
import {prepareShellProcess, shellEnvironment, type ShellProcessPlan} from './posix-sandbox.js';
import { resolveWindowsCommandShell } from './windows-env.js';

export interface ExecOptions {
  command: string;
  mode: PermissionMode;
  extraWritableDirs?: readonly string[];
  /** Tracked working directory from the previous call (absolute path). */
  cwd: string;
  /** Fallback when `cwd` no longer exists. */
  workspace: string;
  timeoutMs: number;
  env?: Record<string, string>;
  outputCapBytes: number;
}

export interface ExecResult {
  exit_code: number | null;
  stdout: string;
  stderr: string;
  /** Working directory after the command; feed back into the next call. */
  cwd: string;
  duration_ms: number;
  timed_out: boolean;
  truncated: boolean;
}

export interface ShellAdapter {
  name: string;
  readonly executable?: string;
  buildScript(cwd: string, workspace: string, command: string, marker?: string): string;
  toArgv(script: string): { argv: string[]; cleanup?: () => void };
}

const MARKER = '__BH_END__';

const singleQuote = (s: string) => `'` + s.replace(/'/g, `'\\''`) + `'`;

class BashAdapter implements ShellAdapter {
  get name(): 'bash' | 'zsh' | 'sh' { return this.syntax; }
  constructor(private bashPath = 'bash', private syntax: 'bash' | 'zsh' | 'sh' = 'bash') {}
  get executable(): string { return this.bashPath; }
  buildScript(cwd: string, workspace: string, command: string, marker = MARKER): string {
    return [
      `cd ${singleQuote(cwd)} 2>/dev/null || cd ${singleQuote(workspace)}`,
      command,
      `__bh_code=$?`,
      `printf '\\n${marker} %s %s' "$__bh_code" "$PWD"`,
      'exit "$__bh_code"',
      '',
    ].join('\n');
  }
  toArgv(script: string) {
    const args = process.platform === 'win32' ? ['-c', script] : posixShellArgs(this.syntax, script);
    return { argv: [this.bashPath, ...args] };
  }
}

class CmdAdapter implements ShellAdapter {
  name = 'cmd';
  private counter = 0;
  constructor(readonly executable: string) {}
  buildScript(cwd: string, workspace: string, command: string, marker = MARKER): string {
    return [
      '@echo off',
      `cd /d "${cwd}" 2>nul || cd /d "${workspace}"`,
      command,
      'set "__bh_code=%errorlevel%"',
      `echo ${marker} %__bh_code% %CD%`,
      'exit /b %__bh_code%',
      '',
    ].join('\r\n');
  }
  toArgv(script: string) {
    const file = path.join(os.tmpdir(), `blackhole-${process.pid}-${Date.now()}-${this.counter++}.cmd`);
    fs.writeFileSync(file, script, 'utf8');
    return {
      argv: [this.executable, '/d', '/c', file],
      cleanup: () => {
        try {
          fs.unlinkSync(file);
        } catch {
          /* best effort */
        }
      },
    };
  }
}

export function posixShellArgs(syntax: 'bash' | 'zsh' | 'sh', script: string): string[] {
  return syntax === 'bash' ? ['--noprofile', '--norc', '-c', script]
    : syntax === 'zsh' ? ['-f', '-c', script] : ['-c', script];
}

/** Resolve real executables, not a PATH-dependent promise that `bash` exists.
 * The VS Code profile is a preference: removed Homebrew paths must not hide
 * process while a supported system shell is still runnable. Do not start a
 * login/interactive shell or inherit daemon credentials during discovery.
 */
function pickPosixShell(): ShellAdapter | null {
  const env = process.env;
  const choices: Array<{ file: string; syntax?: 'bash' | 'zsh' | 'sh' }> = [
    { file: env.BLACKHOLE_BASH?.trim() ?? '', syntax: 'bash' },
    { file: env.BLACKHOLE_PROCESS_SHELL?.trim() ?? '' },
    { file: env.SHELL?.trim() ?? '' },
    ...(process.platform === 'darwin' ? [{ file: '/bin/zsh' }] : []),
    { file: '/bin/bash' }, { file: '/usr/bin/bash' }, { file: '/bin/sh' }, { file: '/usr/bin/sh' },
  ];
  const seen = new Set<string>();
  for (const choice of choices) {
    if (!choice.file || choice.file.includes('\0')) continue;
    const name = choice.syntax ?? path.posix.basename(choice.file);
    if (name !== 'bash' && name !== 'zsh' && name !== 'sh') continue;
    const candidates = path.posix.isAbsolute(choice.file) ? [choice.file]
      : choice.file.includes('/') ? []
        : (env.PATH ?? '').split(':').filter(p => path.posix.isAbsolute(p)).map(p => path.posix.join(p, choice.file));
    for (const file of candidates) {
      if (seen.has(file)) continue;
      seen.add(file);
      try {
        fs.accessSync(file, fs.constants.X_OK);
        if (!fs.statSync(file).isFile()) continue;
        const result = spawnSync(file, posixShellArgs(name, 'exit 0'), {
          env: shellEnvironment(env), encoding: 'utf8', timeout: 1500, maxBuffer: 8192,
        });
        if (!result.error && result.status === 0) return new BashAdapter(file, name);
      } catch { /* Try the next configured or system shell, never an unconfined command. */ }
    }
  }
  return null;
}

let cachedAdapter: ShellAdapter | null | undefined;

/** True when `bash` is an MSYS/Cygwin bash (WSL's bash.exe maps paths differently). */
function probeBash(bashPath: string): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const probe = spawnSync(bashPath, ['-c', 'printf %s "$OSTYPE"'], { timeout: 10_000, encoding: 'utf8' });
      if (probe.error) continue; // spawn trouble (AV scan, busy box) — retry once
      if (probe.status === 0 && /msys|cygwin/i.test(probe.stdout ?? '')) return true;
      return false; // bash ran but is not MSYS (e.g. WSL)
    } catch {
      continue;
    }
  }
  return false;
}

/**
 * Git Bash discovery for environments whose PATH lacks it — a daemon spawned
 * by the VS Code extension host inherits VS Code's PATH, which often does not
 * include Git's bin dir even on machines with Git installed.
 */
function pickBash(): string | null {
  const pf = process.env.ProgramFiles ?? 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const lad = process.env.LOCALAPPDATA ?? '';
  const candidates = [
    path.join(pf, 'Git', 'bin', 'bash.exe'),
    path.join(pf, 'Git', 'usr', 'bin', 'bash.exe'),
    path.join(pf86, 'Git', 'bin', 'bash.exe'),
    path.join(lad, 'Programs', 'Git', 'bin', 'bash.exe'),
    'bash', // PATH fallback, still OSTYPE-verified to exclude WSL
  ];
  for (const c of candidates) {
    if (c !== 'bash' && !fs.existsSync(c)) continue;
    if (probeBash(c)) return c;
  }
  return null;
}

/** Resolve the configured/default POSIX shell; keep Git Bash/cmd Windows fallback. */
export function detectShell(): ShellAdapter | null {
  if (cachedAdapter !== undefined) return cachedAdapter;
  cachedAdapter = null;
  const explicit = process.env.BLACKHOLE_BASH;
  if (process.platform === 'win32' && explicit && fs.existsSync(explicit)) {
    cachedAdapter = new BashAdapter(explicit);
    return cachedAdapter;
  }
  if (process.platform !== 'win32') {
    cachedAdapter = pickPosixShell();
    return cachedAdapter;
  }
  const bash = pickBash();
  if (bash) cachedAdapter = new BashAdapter(bash);
  else {
    const cmd = resolveWindowsCommandShell();
    cachedAdapter = cmd ? new CmdAdapter(cmd) : null;
  }
  return cachedAdapter;
}

class CappedText {
  private chunks: Buffer[] = [];
  private size = 0;
  truncated = false;
  constructor(private cap: number) {}
  push(buf: Buffer): void {
    if (buf.length === 0) return;
    if (this.size >= this.cap) {
      this.truncated = true;
      return;
    }
    const room = this.cap - this.size;
    this.size += Math.min(buf.length, room);
    this.chunks.push(buf.length > room ? buf.subarray(0, room) : buf);
    if (buf.length > room) this.truncated = true;
  }
  text(end = this.size): string {
    return Buffer.concat(this.chunks).subarray(0, end).toString('utf8');
  }
}

function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
    setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }, 3000).unref();
  }
}

function parseMarker(tail: Buffer, marker: string): { code: number; cwd: string; offset: number } | null {
  const idx = tail.lastIndexOf(marker);
  if (idx === -1) return null;
  const rest = tail.subarray(idx + Buffer.byteLength(marker)).toString('utf8').replace(/^\s+/, '');
  const m = /^(-?\d+)\s([\s\S]*)$/.exec(rest);
  if (!m) return null;
  return { code: Number(m[1]), cwd: (m[2] ?? '').replace(/[\r\n]+$/, ''), offset: idx };
}

export async function runShell(opts: ExecOptions, adapter: ShellAdapter): Promise<ExecResult> {
  if (opts.command.includes('\0')) {
    throw new Error('invalid command: NUL byte');
  }
  // never fall back to running outside the workspace if it disappeared
  if (!fs.existsSync(opts.workspace)) {
    throw new Error(`workspace path no longer exists: ${opts.workspace}`);
  }
  const started = Date.now();
  // Per-call framing prevents ordinary output from being mistaken for shell metadata.
  const markerToken = `__BH_END_${randomUUID().replaceAll('-', '')}__`;
  const script = adapter.buildScript(opts.cwd, opts.workspace, opts.command, markerToken);
  const { argv, cleanup } = adapter.toArgv(script);
  const out = new CappedText(opts.outputCapBytes);
  const err = new CappedText(opts.outputCapBytes);
  // Metadata must survive display truncation; only a small bounded tail is retained.
  let stdoutTail = Buffer.alloc(0), stdoutBytes = 0;
  const metadataTailBytes = 16 * 1024;

  let plan: ShellProcessPlan;
  try {
    plan = prepareShellProcess({mode: opts.mode, workspace: opts.workspace,
      extraWritableDirs: opts.extraWritableDirs, argv}, opts.env);
  } catch (error) { cleanup?.(); throw error; }
  let child: ChildProcess;
  try {
    child = spawn(plan.argv[0]!, plan.argv.slice(1), {
      cwd: opts.workspace,
      env: plan.env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (error) { cleanup?.(); plan.cleanup(); throw error; }

  let timedOut = false;
  let settled = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killTree(child);
  }, opts.timeoutMs);
  timer.unref();

  child.stdout?.on('data', (b: Buffer) => {
    out.push(b);
    stdoutBytes += b.length;
    stdoutTail = Buffer.from(b.length >= metadataTailBytes
      ? b.subarray(-metadataTailBytes)
      : Buffer.concat([stdoutTail, b]).subarray(-metadataTailBytes));
  });
  child.stderr?.on('data', (b: Buffer) => err.push(b));

  const result = await new Promise<ExecResult>((resolve) => {
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exit_code: null,
        stdout: out.text(),
        stderr: `${err.text()}\n${e.message}`.trim(),
        cwd: opts.cwd,
        duration_ms: Date.now() - started,
        timed_out: false,
        truncated: out.truncated || err.truncated,
      });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const marker = parseMarker(stdoutTail, markerToken);
      const footerOffset = marker ? stdoutBytes - stdoutTail.length + marker.offset : stdoutBytes;
      const cleanStdout = marker && footerOffset <= opts.outputCapBytes
        ? out.text(footerOffset).replace(/\r?\n$/, '') : out.text();
      resolve({
        // The native process result is authoritative, even if output was capped or the script exited early.
        exit_code: code,
        stdout: cleanStdout,
        stderr: err.text(),
        cwd: marker && marker.cwd ? marker.cwd : opts.cwd,
        duration_ms: Date.now() - started,
        timed_out: timedOut,
        truncated: out.truncated || err.truncated,
      });
    });
  });
  cleanup?.();
  try { plan.cleanup(); } catch { result.stderr += '\nCould not remove the private command temp directory.'; }
  return result;
}
