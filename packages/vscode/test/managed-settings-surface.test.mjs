import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript');
function load(file, mocks = {}) {
  const source = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(js, { module, exports: module.exports, URL, require: name => name in mocks ? mocks[name] : require(name) });
  return module.exports;
}
const wire = load('../../contracts/src/settings-host.ts');
const { SettingsHostService } = load('../src/settingsHostService.ts', { '../../contracts/src/settings-host': wire });
const plain = value => JSON.parse(JSON.stringify(value));
function fixture() {
  const calls = [];
  const host = {
    info: () => ({ kind: 'vscode', managedCore: true }),
    coreAction: async (...args) => { calls.push(['native', ...args]); return true; },
    restart: async () => { calls.push(['legacy-restart']); return true; },
    api: { account: async () => { throw Error('must_not_use_billing'); }, settingsUiRequest: async () => { throw Error('must_not_use_control_http'); } },
  };
  const service = new SettingsHostService(host);
  let id = 0;
  const request = (action, body = {}) => service.request({ id: `request-${++id}`, method: 'POST', path: `/host/core/${action}`, body });
  return { calls, host, service, request };
}

test('managed settings actions route only to the native confirmation handler', async () => {
  const h = fixture();
  assert.deepEqual(plain(await h.request('apply-settings', { revision: 7 })), { completed: true });
  await h.request('configure-port'); await h.request('inspect-maintenance');
  assert.deepEqual(h.calls, [['native', 'apply-settings', 7], ['native', 'configure-port', undefined], ['native', 'inspect-maintenance', undefined]]);
});

test('a page cannot provide confirmation, tokens, arbitrary commands or malformed revisions', async () => {
  const h = fixture();
  for (const body of [{}, { revision: -1 }, { revision: 1.5 }, { revision: '7' }, { revision: Number.MAX_SAFE_INTEGER + 1 }, { revision: 7, confirmed: true }, { revision: 7, token: 'secret' }, { revision: 7, force: true }]) {
    await assert.rejects(h.request('apply-settings', body));
  }
  await assert.rejects(h.request('configure-port', { port: 1234 }));
  await assert.rejects(h.request('inspect-maintenance', { requestId: 'arbitrary' }));
  await assert.rejects(h.request('execute', { command: 'shutdown' }));
  assert.equal(wire.validSettingsRequest({ id: 'read', method: 'GET', path: '/host/core/apply-settings' }), false);
  assert.deepEqual(h.calls, []);
});

test('legacy or unsupported hosts never attempt a managed action or fallback', async () => {
  const h = fixture(); h.host.info = () => ({ kind: 'vscode', managedCore: false });
  await assert.rejects(h.request('apply-settings', { revision: 7 }), /managed_core_required/);
  h.host.info = () => ({ kind: 'vscode', managedCore: true }); h.host.coreAction = undefined;
  await assert.rejects(h.request('apply-settings', { revision: 7 }), /managed_core_required/);
  assert.deepEqual(h.calls, []);
});

test('a cancelled or failed native operation cannot be reported as successful application', async () => {
  const h = fixture(); h.host.coreAction = async () => false;
  assert.deepEqual(plain(await h.request('apply-settings', { revision: 7 })), { completed: false });
});

test('concurrent native maintenance dialogs are rejected; repeated IDs are deduplicated', async () => {
  const h = fixture(); let finish;
  h.host.coreAction = async (...args) => { h.calls.push(args); return new Promise(resolve => { finish = resolve; }); };
  const input = { id: 'once', method: 'POST', path: '/host/core/apply-settings', body: { revision: 7 } };
  const first = h.service.request(input), duplicate = h.service.request(input);
  await assert.rejects(h.request('configure-port'), /settings_core_action_busy/);
  finish(true); await Promise.all([first, duplicate]);
  await h.service.request(input);
  assert.deepEqual(h.calls, [['apply-settings', 7]]);
});

test('reading host information is side-effect free and closing the pane denies new actions', async () => {
  const h = fixture();
  await h.service.request({ id: 'info', method: 'GET', path: '/host/info' });
  assert.deepEqual(h.calls, []); h.service.dispose();
  assert.throws(() => h.request('apply-settings', { revision: 7 }), /settings_closed/);
});
