import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const ts = createRequire(import.meta.url)('typescript');
const settle = () => new Promise(r => setImmediate(r));
function harness() {
  const notices = [], resolutions = [], errors = [];
  let inline = false, tick, choice;
  const fixture = { id: 'c1', session_id: 's1', status: 'pending', args_json: JSON.stringify({ command: 'git push' }) };
  const api = { confirmations: async () => ({ confirmations: [fixture] }), resolveConfirmation: async (...args) => resolutions.push(args) };
  const window = { showInformationMessage: async (...args) => { notices.push(args); return choice; }, showErrorMessage: message => errors.push(message) };
  const module = { exports: {} };
  const source = fs.readFileSync(new URL('../src/approvals.ts', import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(js, { module, exports: module.exports, require: () => ({ window }) });
  const watcher = new module.exports.ApprovalsWatcher(api, { onTick: fn => { tick = fn; return { dispose() { tick = undefined; } }; } }, () => 'fixture', () => inline);
  return { watcher, api, fixture, window, notices, resolutions, errors, setInline: x => { inline = x; }, setChoice: x => { choice = x; }, poll: async () => { await watcher.tick(); await settle(); }, cadence: async () => { for (let i = 0; i < 5; i++) tick?.(); await settle(); } };
}
test('hidden or absent sidebar gets one native fallback; dismissal does not approve', async () => {
  const h = harness(); await h.cadence(); await h.poll();
  assert.equal(h.notices.length, 1); assert.equal(h.resolutions.length, 0); h.watcher.dispose();
});
test('visible inline approval remains eligible when sidebar becomes hidden', async () => {
  const h = harness(); h.setInline(true); await h.poll(); assert.equal(h.notices.length, 0);
  h.setInline(false); await h.poll(); await h.poll(); assert.equal(h.notices.length, 1); h.watcher.dispose();
});
test('resolved requests never notify', async () => {
  const h = harness(); h.fixture.status = 'approved'; await h.poll(); assert.equal(h.notices.length, 0); h.watcher.dispose();
});
test('polling failure and notification failure can retry', async () => {
  const h = harness(), original = h.api.confirmations, show = h.window.showInformationMessage;
  h.api.confirmations = async () => { throw Error('offline'); }; await h.poll();
  h.api.confirmations = original; h.window.showInformationMessage = async () => { throw Error('unavailable'); }; await h.poll();
  h.window.showInformationMessage = show; await h.poll(); assert.equal(h.notices.length, 1); h.watcher.dispose();
});
test('overlapping polls do not duplicate notifications', async () => {
  const h = harness(); let release; h.api.confirmations = () => new Promise(r => { release = r; });
  const a = h.watcher.tick(); await h.watcher.tick(); release({ confirmations: [h.fixture] }); await a; await settle();
  assert.equal(h.notices.length, 1); h.watcher.dispose();
});
test('dispose during pending read prevents late notifications', async () => {
  const h = harness(); let release; h.api.confirmations = () => new Promise(r => { release = r; });
  const task = h.watcher.tick(); h.watcher.dispose(); release({ confirmations: [h.fixture] }); await task;
  assert.equal(h.notices.length, 0);
});
for (const [choice, decision, scope] of [['批准一次', 'approve', 'once'], ['本会话批准', 'approve', 'session'], ['始终批准', 'approve', 'always'], ['拒绝', 'deny', undefined]]) {
  test(`explicit ${choice} preserves resolution semantics`, async () => {
    const h = harness(); h.setChoice(choice); await h.poll();
    assert.equal(JSON.stringify(h.resolutions), JSON.stringify([['c1', decision, scope]])); h.watcher.dispose();
  });
}
test('critical operations still have no always approval', async () => {
  const h = harness(); h.fixture.args_json = JSON.stringify({ command: 'Remove-Item fixture' }); await h.poll();
  assert.equal(h.notices[0].includes('始终批准'), false); h.watcher.dispose();
});
test('dispose while notification is open prevents late resolution', async () => {
  const h = harness(); let release; h.window.showInformationMessage = () => new Promise(r => { release = r; });
  await h.poll(); h.watcher.dispose(); release('批准一次'); await settle(); assert.equal(h.resolutions.length, 0);
});
