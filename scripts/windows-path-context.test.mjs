// Native regression matrix for the CI-only PowerShell/PATH stall. Each task
// uses only synthetic commands and its own workspace; failures retain trace output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ProcessManager } from '../dist/process/manager.js';
import { loadProcessBackend } from '../dist/process/backend.js';

for (const mode of ['danger-full-access', 'workspace-write']) {
  for (const pipeline of [false, true]) {
    test(`Windows minimal PATH native continuation: ${mode}, capture=${pipeline}`, { skip: process.platform !== 'win32', timeout: 45000 }, async t => {
      fs.mkdirSync('.cache/tests', { recursive: true });
      const root = fs.realpathSync(fs.mkdtempSync('.cache/tests/path-context-'));
      const keys = ['PATH', 'Path', 'path', 'BLACKHOLE_GIT_USR_BIN', 'BLACKHOLE_RG'];
      const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
      const manager = new ProcessManager({ daemonId: 'path-context', backend: await loadProcessBackend() });
      try {
        delete process.env.Path; delete process.env.path; process.env.PATH = root;
        delete process.env.BLACKHOLE_RG; delete process.env.BLACKHOLE_GIT_USR_BIN;
        const owner = { sessionId: 'fixture', workspace: root, mode, writableDirs: [] };
        const script = [
          "[Console]::Error.WriteLine('checkpoint-before-output')",
          "Write-Output 'before-native'",
          "[Console]::Error.WriteLine('checkpoint-before-native')",
          'try {',
          pipeline ? 'cmd.exe /d /c ver | Out-String -Stream' : 'cmd.exe /d /c ver',
          '} catch { [Console]::Error.WriteLine($_.Exception.ToString()); exit 86 }',
          "[Console]::Error.WriteLine('checkpoint-after-native')",
          "Write-Output 'after-native'",
          "[Console]::Error.WriteLine('checkpoint-after-output')",
          'exit 7',
        ].join('\n');
        let row = await manager.start(owner, { requestId: 'native-context', script }, async () => {});
        // This is a completion/correctness gate, not a seven-second cold-start
        // benchmark. Fresh Windows runners may still initialize PowerShell's
        // module cache when warm cases already finish in under a second.
        // Keep a hard bound, and never retry/relaunch the task being observed.
        const deadline = Date.now() + 20000;
        while (!['exited', 'failed', 'unknown'].includes(row.state) && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 30));
          row = manager.status(owner.sessionId, row.processId);
        }
        t.diagnostic(JSON.stringify({ mode, pipeline, state: row.state, exitCode: row.exitCode, stdout: row.output.stdout, stderr: row.output.stderr }));
        if (row.state === 'running' && mode === 'danger-full-access' && !pipeline) {
          const debuggerPath = String.raw`C:\Program Files (x86)\Windows Kits\10\Debuggers\x64\cdb.exe`;
          if (fs.existsSync(debuggerPath)) {
            const env = { ...process.env, PATH: saved.PATH ?? saved.Path ?? saved.path ?? '' };
            const debug = spawnSync(debuggerPath, ['-pv', '-p', String(row.pid), '-c', '.loadby sos clr;!eestack;qd' ], {
              env, encoding: 'utf8', windowsHide: true, timeout: 12000, maxBuffer: 128 * 1024,
            });
            t.diagnostic('synthetic process stack: ' + (debug.stdout || debug.stderr || debug.error?.message || '').slice(-65536));
          } else t.diagnostic('SDK debugger is not installed; no tool was downloaded');
        }
        assert.equal(row.state, 'exited', JSON.stringify(row));
        assert.equal(row.exitCode, 7);
        assert.match(row.output.stdout, /after-native/);
      } finally {
        for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
        await manager.dispose();
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });
  }
}
