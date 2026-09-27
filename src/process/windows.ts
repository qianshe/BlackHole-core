import koffi from 'koffi';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AclSandbox, openCurrentProcessToken, spawnSandboxed, streamPipe, type SpawnedNative } from '../win32/acl-sandbox.js';
import { allocUint32, decodeUint32, win32 } from '../win32/ffi.js';
import { isWindowsAppExecutionPath, windowsEnvValue, windowsExecutionPath, windowsSystemRoot } from '../workspace/windows-env.js';
import type { ShellMetadata } from '../execution.js';
// Use the inbox executable, not an App Execution Alias (Store pwsh may broker outside the Job).
export function managedPowerShellPath(): string {
  const root = windowsSystemRoot();
  if (!root) throw new ProcessError('shell_unavailable', 'Windows system directory is unavailable');
  const binary = path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (!fs.existsSync(binary)) throw new ProcessError('shell_unavailable', 'Windows PowerShell executable is unavailable');
  return binary;
}
import { ProcessError, type BackendCallbacks, type ProcessHandle, type ProcessSpec } from './types.js';

/** Explicit snapshot, never inherit credentials, loader hooks or Electron's node-mode switch. */
export function processEnvironment(temp: string | null, host: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = { NO_COLOR: '1', TERM: 'dumb', PAGER: 'cat', GIT_PAGER: 'cat' };
  for (const key of ['PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'ComSpec', 'HOME', 'USERPROFILE', 'LANG', 'PSModulePath', 'APPDATA', 'LOCALAPPDATA']) {
    const value = windowsEnvValue(host, key); if (value !== undefined) env[key] = value;
  }
  env.PATH = windowsExecutionPath(env.PATH ?? '', host);
  env.PATHEXT ||= '.COM;.EXE;.BAT;.CMD';
  if (temp) env.TEMP = env.TMP = temp;
  return env;
}
export function powerShellArgs(script: string): string[] {
  // Do not launch chcp before user code. A shared/redirected Windows console
  // can leave that utility blocked indefinitely; PowerShell can set its own
  // text encoding without introducing an extra native child at startup.
  const wrapped = [
    // Resolve built-in cmdlets from this interpreter before inherited modules.
    // An intermediate Node host does not apply PowerShell's version-path cleanup.
    '$env:PSModulePath = [System.IO.Path]::Combine($PSHOME, "Modules") + [System.IO.Path]::PathSeparator + $env:PSModulePath',
    '$ErrorActionPreference = "Stop"', '$ProgressPreference = "SilentlyContinue"',
    '$OutputEncoding = [System.Text.Encoding]::UTF8',
    'try { [Console]::OutputEncoding = $OutputEncoding } catch { }',
    '$PSNativeCommandUseErrorActionPreference = $false', '$global:LASTEXITCODE = 0',
    'try {', '& {', script, '}', 'exit $LASTEXITCODE',
    '} catch { Write-Error -ErrorAction Continue ($_ | Out-String); exit 1 }',
  ].join('\n');
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand', Buffer.from(wrapped, 'utf16le').toString('base64')];
}
export function managedShellArgs(shell: ShellMetadata, script: string): string[] {
  if (shell.syntax === 'powershell') return powerShellArgs(script);
  if (shell.syntax === 'cmd') return ['/d', '/s', '/c', script];
  return ['--noprofile', '--norc', '-c', script];
}

/** One independent Job per invocation. No PersistentShell, sentinel, global cwd or lifetime queue. */
export function startWindowsProcess(spec: ProcessSpec, cb: BackendCallbacks, shell: ShellMetadata = { executable: managedPowerShellPath(), syntax: 'powershell', version: null }): ProcessHandle {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new ProcessError('unsupported_platform', 'Windows x64 backend required');
  const shellExecutable = shell.executable;
  if (!shellExecutable) throw new ProcessError('shell_unavailable', 'Managed shell is unavailable');
  if (isWindowsAppExecutionPath(shellExecutable)) throw new ProcessError('shell_unavailable', 'A Store/App Execution Alias cannot guarantee managed Job ownership; use a direct shell executable.');
  const api = win32();
  let sandbox: AclSandbox | undefined, temp: string | null = null, native: SpawnedNative;
  const cleanup = () => { if (sandbox) sandbox.dispose(); else if (temp) fs.rmSync(temp, { recursive: true, force: true }); };
  try {
    if (spec.mode !== 'danger-full-access') {
      sandbox = new AclSandbox({ mode: spec.mode, workspaceRoot: spec.workspace, extraWritableDirs: [...spec.writableDirs] });
      sandbox.init(); temp = sandbox.tempDir;
      native = sandbox.spawn({ command: shellExecutable, args: managedShellArgs(shell, spec.script), cwd: spec.cwd, env: processEnvironment(temp) });
    } else {
      temp = fs.mkdtempSync(path.join(os.tmpdir(), 'blackhole-process-'));
      const token = openCurrentProcessToken(api);
      try { native = spawnSandboxed(api, token, { command: shellExecutable, args: managedShellArgs(shell, spec.script), cwd: spec.cwd, env: processEnvironment(temp) }); }
      finally { api.closeHandle(token); }
    }
  } catch (error) { cleanup(); throw error; }
  // Non-interactive v1: EOF immediately, never leave a program awaiting arbitrary terminal input.
  api.closeHandle(native.stdinWrite);
  const stdout = streamPipe(api, native.stdoutRead, bytes => cb.output('stdout', bytes));
  const stderr = streamPipe(api, native.stderrRead, bytes => cb.output('stderr', bytes));
  const slot = allocUint32(), accounting = Buffer.alloc(48);
  let ending = false, closed = false, rootExited = false, code: number | null = null;
  let stopRequested = false, faultReported = false;
  let resolveDone!: () => void;
  const done = new Promise<void>(resolve => { resolveDone = resolve; });
  const fault = (error: unknown) => {
    if (!faultReported) { faultReported = true; cb.fault(error instanceof Error ? error.message : String(error)); }
  };
  void stdout.done.catch(fault); void stderr.done.catch(fault);
  const active = () => {
    // JOBOBJECT_BASIC_ACCOUNTING_INFORMATION.ActiveProcesses (x64) at byte 40.
    if (!api.queryInformationJobObject(native.job, 1, accounting, accounting.length, null)) throw new Error('QueryInformationJobObject failed: ' + api.getLastError());
    return accounting.readUInt32LE(40);
  };
  const terminate = () => {
    if (closed) return;
    if (!api.terminateJobObject(native.job, 1)) throw new Error('TerminateJobObject failed: ' + api.getLastError());
  };
  const finish = async () => {
    if (ending || closed) return;
    ending = true; clearInterval(poll);
    // All job members have exited. Drain final output, but never hang on an inherited pipe.
    let deadline: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.allSettled([stdout.done, stderr.done]), new Promise<void>(resolve => { deadline = setTimeout(resolve, 500); })]);
    if (deadline) clearTimeout(deadline);
    stdout.stop(); stderr.stop();
    await Promise.allSettled([stdout.done, stderr.done]);
    let confirmed = true;
    for (const h of [native.process, native.job]) { try { if (!api.closeHandle(h)) confirmed = false; } catch { confirmed = false; } }
    koffi.free(slot); closed = true;
    try { cleanup(); } catch (error) { fault(error); }
    cb.exit({ exitCode: code, signal: null, cleanupConfirmed: confirmed,
      reason: stopRequested ? 'job_terminated' : faultReported ? 'output_or_monitor_error' : null });
    resolveDone();
  };
  const poll = setInterval(() => {
    if (ending || closed) return;
    try {
      if (!rootExited) {
        const result = api.waitForSingleObject(native.process, 0);
        if (result === 0xffffffff) throw new Error('WaitForSingleObject failed: ' + api.getLastError());
        if (result === 0) {
          rootExited = true;
          if (!api.getExitCodeProcess(native.process, slot)) throw new Error('GetExitCodeProcess failed: ' + api.getLastError());
          code = decodeUint32(slot);
          // A shell exiting must not leave detached descendants or held pipes behind.
          if (active() > 0) terminate();
        }
      }
      if (rootExited && active() === 0) void finish().catch(fault);
    } catch (error) { fault(error); }
  }, 25);
  return {
    pid: native.pid,
    async stop() {
      if (closed) return;
      stopRequested = true;
      terminate();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([done, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ProcessError('stop_failed', 'Job termination has not been confirmed')), 5000); })]);
      } finally { if (timer) clearTimeout(timer); }
    },
  };
}
