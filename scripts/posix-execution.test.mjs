import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const posix = ['darwin', 'linux'].includes(process.platform);
const file = fileURLToPath(import.meta.url);

// A fresh native child exercises startup detection, not a mocked platform label.
if (process.env.BH_POSIX_EXECUTION_CHILD === '1') {
  const { detectExecutionEnvironment } = await import('../dist/execution.js');
  const { runShell } = await import('../dist/workspace/shell.js');
  const { loadProcessBackend } = await import('../dist/process/backend.js');
  const { ProcessManager } = await import('../dist/process/manager.js');
  fs.mkdirSync('.cache/tests', { recursive: true });
  const root = fs.realpathSync(fs.mkdtempSync('.cache/tests/posix-execution-'));
  let manager;
  try {
    const environment = detectExecutionEnvironment();
    const sub = path.join(root, "space and ' quote 中文");
    fs.mkdirSync(sub);
    const finite = await runShell({ command: "printf 'finite-中文\\n'; false", mode: 'danger-full-access',
      cwd: sub, workspace: root, timeoutMs: 3000, outputCapBytes: 8192 }, environment.exec.adapter);
    manager = new ProcessManager({ daemonId: 'native-shell-fixture', supported: environment.process.available,
      backend: await loadProcessBackend(environment.process.shell) });
    const owner = { sessionId: 'fixture', workspace: root, mode: 'danger-full-access', writableDirs: [] };
    let row = await manager.start(owner, { requestId: 'native-shell', script: "printf 'background-中文\\n'; exit 7" }, async () => {});
    const deadline = Date.now() + 7000;
    while (!['exited', 'failed', 'unknown'].includes(row.state) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
      row = manager.status(owner.sessionId, row.processId);
    }
    console.log(JSON.stringify({ platform: environment.platform, exec: environment.exec.shell,
      process: environment.process, finite, expectedCwd: sub, background: row }));
  } finally {
    await manager?.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
} else {
  function run(extra) {
    const env = { ...process.env, BLACKHOLE_BASH: '', BLACKHOLE_PROCESS_SHELL: '', SHELL: '',
      BH_POSIX_EXECUTION_CHILD: '1', ...extra };
    const child = spawnSync(process.execPath, [file], { env, encoding: 'utf8', timeout: 18000, maxBuffer: 65536 });
    assert.equal(child.status, 0, child.error?.message || child.stderr || child.stdout);
    const result = JSON.parse(child.stdout.trim());
    assert.equal(result.platform, process.platform);
    assert.ok(path.isAbsolute(result.exec.executable), 'finite execution must use a resolved system shell');
    assert.ok(path.isAbsolute(result.process.shell.executable), 'background execution must use a resolved system shell');
    assert.equal(result.process.available, true);
    assert.equal(result.finite.exit_code, 1, JSON.stringify(result.finite));
    assert.equal(result.finite.stdout.trim(), 'finite-中文');
    assert.equal(result.finite.cwd, result.expectedCwd);
    assert.equal(result.background.state, 'exited', JSON.stringify(result.background));
    assert.equal(result.background.exitCode, 7);
    assert.equal(result.background.output.stdout.trim(), 'background-中文');
    return result;
  }

  test('POSIX exec and process work with a GUI PATH that omits system shells', { skip: !posix, timeout: 22000 }, () => {
    run({ PATH: '/__blackhole_missing_gui_path__', SHELL: '/bin/sh' });
  });

  test('a missing preferred terminal shell does not remove process from the daemon', { skip: !posix, timeout: 22000 }, () => {
    run({ BLACKHOLE_PROCESS_SHELL: '/__blackhole_removed_profile__/zsh', SHELL: '/bin/sh' });
  });

  for (const shell of ['/bin/sh', '/bin/bash', '/bin/zsh']) {
    test('native exec and process use the selected terminal shell: ' + shell, { skip: !posix || !fs.existsSync(shell), timeout: 22000 }, () => {
      const result = run({ BLACKHOLE_PROCESS_SHELL: shell });
      assert.equal(result.exec.syntax, path.basename(shell));
      assert.equal(result.process.shell.syntax, path.basename(shell));
    });
  }
}
