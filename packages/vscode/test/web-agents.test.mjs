import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript');

// Native UI contracts only; this does NOT simulate or certify window dragging.
function loadWebAgents({ enabled, custom = [], select = items => items[0], input } = {}) {
  const opened = [], picks = [], inputs = [], updates = [];
  const vscode = {
    ConfigurationTarget: { Global: 1 },
    workspace: { getConfiguration: () => ({
      get: key => key === 'webAgents' ? enabled : key === 'customWebAgents' ? custom : undefined,
      update: async (...args) => updates.push(args),
    }) },
    window: {
      createQuickPick() { throw Error('Do not restore a hand-managed picker lifecycle'); },
      async showQuickPick(items, options) { picks.push({items, options}); return select(items); },
      async showInputBox(options) { inputs.push(options); return input; },
    },
    commands: { executeCommand: async (...args) => opened.push(args) },
  };
  const source = fs.readFileSync(new URL('../src/webAgents.ts', import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(js, { module, exports: module.exports, URL, require: name => name === 'vscode' ? vscode : require(name) });
  return { ...module.exports, opened, picks, inputs, updates };
}
const manual = items => items.at(-1);
test('native titled picker opens a preset exactly once', async () => {
  const f = loadWebAgents(); await f.openWebAgent();
  assert.deepEqual(f.opened, [['simpleBrowser.api.open', 'https://chatgpt.com']]);
  assert.equal(f.picks[0].options.ignoreFocusOut, false);
  assert.ok(f.picks[0].options.title);
  assert.equal(f.picks[0].options.matchOnDescription, true);
  assert.equal(f.picks[0].options.matchOnDetail, true);
  assert.equal(f.inputs.length, 0);
});
test('native picker cancellation does not open browser or another dialog', async () => {
  const f = loadWebAgents({select: () => undefined}); await f.openWebAgent();
  assert.deepEqual(f.opened, []); assert.equal(f.inputs.length, 0);
});
test('URL entry follows session task input presentation and normalizes a bare domain', async () => {
  const f = loadWebAgents({select: manual, input: ' example.com/path '}); await f.openWebAgent();
  const o = f.inputs[0]; assert.ok(o.title); assert.ok(o.prompt); assert.ok(o.placeHolder);
  assert.equal(o.ignoreFocusOut, false);
  assert.deepEqual(f.opened, [['simpleBrowser.api.open', 'https://example.com/path']]);
  assert.equal(f.updates.length, 0, 'opening a one-off URL does not persist a site');
});
test('URL cancellation never opens a browser', async () => {
  const f = loadWebAgents({select: manual}); await f.openWebAgent(); assert.deepEqual(f.opened, []);
});
test('URL native validation rejects empty and non-HTTP URLs without opening another dialog', async () => {
  const f = loadWebAgents({select: manual, input: ''}); await f.openWebAgent();
  const validate = f.inputs[0].validateInput;
  for (const v of ['', ' ', 'ftp://example.com', 'https://', 'not a domain']) assert.ok(validate(v), v);
  for (const v of ['example.com', 'https://example.com/path', 'http://localhost:3000']) assert.equal(validate(v), undefined, v);
  assert.deepEqual(f.opened, []); assert.equal(f.inputs.length, 1);
});
test('disabled presets retain custom sites and URL entry', async () => {
  const f = loadWebAgents({enabled: [], custom:[{name:' Local ',url:'http://localhost:3000'}]});
  await f.openWebAgent();
  assert.equal(f.picks[0].items.length, 2); assert.equal(f.picks[0].items[0].label, 'Local');
  assert.deepEqual(f.opened, [['simpleBrowser.api.open', 'http://localhost:3000']]);
});
test('all sites disabled still permits a one-off URL', async () => {
  const f = loadWebAgents({enabled: [], select: manual, input:'https://example.org'});
  await f.openWebAgent(); assert.equal(f.picks[0].items.length, 1);
  assert.deepEqual(f.opened, [['simpleBrowser.api.open', 'https://example.org/']]);
});
test('configured preset filtering is unchanged', async () => {
  const f = loadWebAgents({enabled:['Arena']}); await f.openWebAgent();
  assert.equal(f.picks[0].items.length, 2);
  assert.deepEqual(f.opened, [['simpleBrowser.api.open', 'https://arena.ai']]);
});
