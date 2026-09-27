import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.env.BH_CONSOLELESS_FIXTURE === '1') {
  const { default: koffi } = await import('koffi');
  const kernel = koffi.load('kernel32.dll');
  const freeConsole = kernel.func('int32_t FreeConsole()');
  const getConsoleCP = kernel.func('uint32_t GetConsoleCP()');
  // Detach only this disposable child, never the operator's daemon or terminal.
  freeConsole();
  assert.equal(getConsoleCP(), 0, 'fixture must actually have no Win32 console');
  const { ProcessManager } = await import('../dist/process/manager.js');
  const { loadProcessBackend } = await import('../dist/process/backend.js');
  fs.mkdirSync('.cache/tests', { recursive: true });
  const root = fs.realpathSync(fs.mkdtempSync('.cache/tests/consoleless-'));
  const manager = new ProcessManager({ daemonId: 'consoleless-fixture', backend: await loadProcessBackend() });
  const owner = { sessionId: 'fixture', workspace: root, mode: 'workspace-write', writableDirs: [] };
  try {
    // Same condition as the GUI/PATH regression, without borrowing a host console.
    delete process.env.Path; delete process.env.path; process.env.PATH = root;
    const row = await manager.start(owner, { requestId: 'consoleless', script: "cmd.exe /d /c ver; Write-Output 'consoleless-中文'; exit 7" }, async () => {});
    let ended = row;
    const deadline = Date.now() + 7000;
    while (!['exited', 'failed', 'unknown'].includes(ended.state) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 30));
      ended = manager.status(owner.sessionId, row.processId);
    }
    assert.equal(ended.state, 'exited', JSON.stringify(ended));
    assert.equal(ended.exitCode, 7, JSON.stringify(ended));
    assert.ok(ended.output.stdout.includes('consoleless-中文'), JSON.stringify(ended));
    console.log(JSON.stringify({ consoleCodePage: getConsoleCP(), exitCode: ended.exitCode, stdout: ended.output.stdout }));
  } finally {
    await manager.dispose();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
} else {
  test('restricted Windows native commands complete from a console-less host', { skip: process.platform !== 'win32', timeout: 18000 }, () => {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: { ...process.env, BH_CONSOLELESS_FIXTURE: '1' }, encoding: 'utf8', timeout: 15000, windowsHide: true,
    });
    assert.equal(child.status, 0, child.error?.message || child.stderr || child.stdout);
    const result = JSON.parse(child.stdout.trim());
    assert.equal(result.exitCode, 7);
    assert.equal(typeof result.consoleCodePage, 'number', 'record the actual console state; do not require one when native execution succeeds');
  });
}
