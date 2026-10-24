import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const source = fs.readFileSync(new URL('../src/hostCoreUi.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText;

function setup(choice) {
  const warnings = [], commands = [];
  const module = { exports: {} };
  vm.runInNewContext(js, {
    module, exports: module.exports, Error,
    require(name) {
      assert.equal(name, 'vscode');
      return {
        window: { showWarningMessage: async (...args) => { warnings.push(args); return choice; } },
        commands: { executeCommand: async (...args) => { commands.push(args); } },
        ProgressLocation: { Notification: 1 },
      };
    },
  });
  return { warnings, commands, report: module.exports.reportHostCoreFailure };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('unknown daemon state offers guarded start recovery only after user selection', async () => {
  const h = setup('检查并恢复启动记录');
  h.report(new Error('daemon_state_unknown'));
  assert.equal(h.commands.length, 0);
  assert.match(h.warnings[0][0], /运行记录/);
  assert.ok(h.warnings[0].includes('检查并恢复启动记录'));
  await flush();
  assert.deepEqual(h.commands, [['blackhole.repairCoreStart']]);
});

test('temporary unknown state can retry connection without repairing records', async () => {
  const h = setup('重试连接');
  h.report(new Error('daemon_state_unknown'));
  assert.equal(h.commands.length, 0);
  assert.match(h.warnings[0][0], /暂时无法连接/);
  await flush();
  assert.deepEqual(h.commands, [['blackhole.retrySharedCore']]);
});

test('dismissing unknown-state warning leaves runtime and records untouched', async () => {
  const h = setup(undefined);
  h.report(new Error('daemon_state_unknown'));
  await flush();
  assert.deepEqual(h.commands, []);
});

test('other ambiguous or identity errors never offer start-record recovery', async () => {
  for (const code of ['daemon_probe_unknown', 'shared_core_manager_timeout', 'core_identity_conflict',
    'maintenance_recovery_required', 'upgrade_recovery_required']) {
    const h = setup('检查并恢复启动记录');
    h.report(new Error(code));
    await flush();
    assert.equal(h.warnings[0].length, 1);
    assert.deepEqual(h.commands, []);
  }
});
