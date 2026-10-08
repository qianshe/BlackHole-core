import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');

function load(file, mocks = {}) {
  const js = ts.transpileModule(fs.readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(js, { module, exports: module.exports, require: (name) => name in mocks ? mocks[name] : require(name), URL, console });
  return module.exports;
}
const templates = load('../../vscode/src/templates.ts');
const directPicker = load('../src/directAddressPicker.ts', { './console/console.module.css': {} });
const oldId = 'tunnel_' + 'a'.repeat(32), savedId = 'tunnel_' + 'b'.repeat(32);
function harness(health, client) {
  const clipboard = [], warnings = [];
  const panel = { health: async () => health };
  if (client === 'web') {
    const actions = load('../src/console/sessionActions.tsx', {
      react: { useMemo: (fn) => fn() }, '../api': { api: {}, panel },
      '../../../vscode/src/templates': templates, '../format': {},
      './common': { copyText: async (value) => { clipboard.push(value); return true; } },
      './ChatDock': {}, './console.module.css': {}, '../directAddressPicker': directPicker,
    }).useSessionActions({ toast: (message) => warnings.push(message), connectorName: 'Fixture', mcpUrl: 'http://stale/mcp/token' });
    return { copy: () => actions.copyConnection(), clipboard, warnings };
  }
  const actions = load('../../vscode/src/sessionActions.ts', {
    vscode: {
      env: { clipboard: { writeText: async (value) => clipboard.push(value) } },
      window: { showInformationMessage: async () => '复制 Tunnel ID', showWarningMessage: (s) => warnings.push(s), showErrorMessage: (s) => warnings.push(s), setStatusBarMessage() {} },
    },
    './templates': templates, './config': { getConfig: () => ({ openaiTunnelId: oldId }) },
  });
  return { copy: () => actions.copySessionUrl(panel, { id: 'fixture', name: 'Fixture' }), clipboard, warnings };
}
const health = (overrides = {}) => ({
  mcp_url: 'http://127.0.0.1:7306/mcp/token',
  openai_tunnel: { status: 'ready', active_tunnel_id: oldId },
  connection_routes: { selected_route: 'openai', saved_tunnel_id: savedId, preferred_mcp_url: null, preferred_mcp_kind: null, openai: 'off', reason: 'openai_selected', ...overrides },
});
for (const client of ['web', 'vscode']) {
  test(`${client}: offline copy uses saved daemon ID, not running ID or stale mirror`, async () => {
    const h = harness(health(), client); await h.copy();
    assert.deepEqual(h.clipboard, [savedId]);
  });
  test(`${client}: deleting the saved ID never resurrects a running/stale ID`, async () => {
    const h = harness(health({ saved_tunnel_id: null, openai: 'ready' }), client); await h.copy();
    assert.deepEqual(h.clipboard, []); assert.ok(h.warnings.length);
  });
  test(`${client}: unavailable explicit direct does not switch to an online OpenAI channel`, async () => {
    const h = harness(health({ selected_route: 'direct', reason: 'direct_unavailable', openai: 'ready' }), client); await h.copy();
    assert.deepEqual(h.clipboard, []); assert.ok(h.warnings.length);
  });
}

const directChoiceHealth = () => health({ selected_route: 'direct', needs_choice: true, mcp_candidates: [
  { id: 'lan', kind: 'direct', scope: 'private', url: 'http://192.168.1.2:7307/mcp/token', label: 'LAN' },
  { id: 'mesh', kind: 'direct', scope: 'private', url: 'http://100.80.0.2:7307/mcp/token', label: 'Mesh' },
  { id: 'cf', kind: 'cloudflare', scope: 'public', url: 'https://fixture.example/mcp/token', label: 'Cloudflare' },
] });

test('web direct picker offers only direct candidates and verifies the selected URL before copy', async () => {
  const h = directChoiceHealth(); let reads = 0;
  const picked = await directPicker.chooseCurrentDirectAddress(h, async () => { reads++; return h; }, async (items) => {
    assert.deepEqual(Array.from(items, (item) => item.id), ['lan', 'mesh']);
    return items[1].url;
  });
  assert.equal(picked, 'http://100.80.0.2:7307/mcp/token'); assert.equal(reads, 1);
});

test('web direct picker cancellation is inert and never substitutes a channel', async () => {
  let reads = 0;
  const result = await directPicker.chooseCurrentDirectAddress(directChoiceHealth(), async () => { reads++; return health(); }, async () => null);
  assert.equal(result, null); assert.equal(reads, 0);
});

test('web direct picker rejects a route or token changed while the choice was open', async () => {
  for (const current of [health(), health({ selected_route: 'direct', mcp_candidates: [] })]) {
    await assert.rejects(() => directPicker.chooseCurrentDirectAddress(directChoiceHealth(), async () => current,
      async (items) => items[0].url), /连接状态已变化/);
  }
});
