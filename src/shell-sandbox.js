import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { PersistentShell } from './shell.js';

/**
 * SandboxShell — the security boundary. Runs pwsh inside a throwaway Docker
 * container so a remote caller physically cannot touch the host: only the
 * session workspace is mounted (at /workspace), there is NO network, the root
 * filesystem is read-only, all capabilities are dropped, no-new-privileges is
 * set, and CPU/memory/PID limits cap abuse. The container is removed on exit.
 *
 * Inside the container the workspace appears at /workspace (pwsh on Linux).
 * editor still runs host-side with the real absolute path — both
 * refer to the same files via the bind mount.
 */
export class SandboxShell extends PersistentShell {
  constructor({ workspacePath, timeoutMs = 300000, image = 'mcr.microsoft.com/powershell:7.4-ubuntu-22.04', network = false }) {
    super({ cwd: '/workspace', timeoutMs });
    this.image = image;
    this.network = network;
    // Bind host workspace -> /workspace. Docker Desktop accepts a Windows path.
    this.mount = `${workspacePath}:/workspace`;
  }

  _spawn() {
    const name = `bh-${randomBytes(5).toString('hex')}`;
    const args = [
      'run', '-i', '--rm',
      '--name', name,
      '--network', this.network ? 'bridge' : 'none',
      '--memory', '512m',
      '--cpus', '1.0',
      '--pids-limit', '128',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--read-only',
      '--tmpfs', '/tmp:rw,size=64m',
      '-v', this.mount,
      '-w', '/workspace',
      this.image,
      'pwsh', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-',
    ];
    return spawn('docker', args, { windowsHide: true });
  }
}
