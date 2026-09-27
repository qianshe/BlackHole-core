#!/usr/bin/env node
import assert from 'node:assert/strict';
import { panelHtml } from '../dist/panel/appHtml.js';
import vm from 'node:vm';

// Exercise emitted panel JS (including interpolated naming constants), not the TS template.
const panelSource = panelHtml();
const previewStart = panelSource.indexOf('  function argPreview(call) {');
const previewEnd = panelSource.indexOf('\n\n  const tip =', previewStart);
assert.ok(previewStart >= 0 && previewEnd > previewStart, 'panel preview function is available');
const helperStart = panelSource.indexOf('  function displayValue(value) {');
const helperSource = panelSource.slice(helperStart, previewEnd);
const preview = vm.runInNewContext('(function(){' + helperSource + '; return argPreview;})()');
const proxyPreview = args => preview({tool:'proxy',args_json:JSON.stringify(args)});
for (const server of [undefined, 'browser-server']) {
  assert.equal(proxyPreview({command:'explain',tool:'list_pages',server}), '查看 list_pages');
  assert.equal(proxyPreview({command:'call',tool:'list_pages',server}), '调用 list_pages');
  assert.equal(proxyPreview({command:'call',tool:'list_pages',server,argsJson:'{"limit":5}'}), '调用 list_pages · limit=5');
  assert.equal(proxyPreview({command:'list',server}), '列出可用工具');
  assert.equal(proxyPreview({command:'cancel',server}), '取消代理调用');
}
assert.equal(proxyPreview({command:'explain'}),'查看 ?');
for(const argsJson of ['broken','null','[]','42'])assert.equal(proxyPreview({command:'call',tool:'list_pages',argsJson}),'调用 list_pages');
assert.equal(proxyPreview({command:'call',tool:'browser/list_pages'}),'调用 browser/list_pages', 'do not strip parts of the actual tool alias');

import { ProxyRegistry } from '../dist/proxy/registry.js';

const catalogs = new Map([
  ['alpha', [{ name: 'echo' }, { name: 'slow' }]],
  ['beta', [{ name: 'echo' }, { name: 'slow' }]],
]);
let listCalls = 0;
const manager = {
  hasLiveChild() { return true; },
  async listTools(server) {
    listCalls += 1;
    return { tools: catalogs.get(server.name) ?? [] };
  },
};
const registry = new ProxyRegistry(manager, () => {});
const base = (name, surface) => ({
  name,
  enabled: true,
  merge: false,
  transport: 'stdio',
  command: 'node',
  args: [],
  env: { inherit: [], set: {} },
  surface,
  risk: {},
  redactPaths: [],
  sensitiveKeys: [],
  scope: 'shared',
  prewarm: 'never',
});
const alpha = base('alpha', { expose: ['echo', 'slow'], aliases: { alpha_echo: 'echo' } });
const beta = base('beta', { expose: ['echo', 'slow'], aliases: { beta_echo: 'echo' } });

const entries = await registry.globalEntries([beta, alpha], 's1', true);
assert.deepEqual(entries.map((x) => x.name), ['alpha_echo', 'beta_echo', 'slow'], 'global registry order must be deterministic');
assert.equal(entries.find((x) => x.name === 'alpha_echo')?.status, 'online');
assert.equal(entries.find((x) => x.name === 'beta_echo')?.status, 'online');
assert.equal(entries.some((x) => x.name === 'echo'), false, 'alias must replace canonical agent-visible name');
const slow = entries.find((x) => x.name === 'slow');
assert.equal(slow?.status, 'conflict', 'same exposed name across MCPs must conflict');
assert.deepEqual(slow.bindings.map((x) => x.server.name), ['alpha', 'beta'], 'conflict sources must be deterministically sorted');

const resolved = await registry.resolveGlobal([alpha, beta], 's1', 'alpha_echo');
assert.equal(resolved?.status, 'online');
assert.equal(resolved.binding.server.name, 'alpha');
assert.equal(resolved.binding.upstreamTool, 'echo');

catalogs.set('alpha', [{ name: 'echo' }, { name: 'fresh' }]);
alpha.surface = { expose: ['echo', 'fresh'], aliases: { alpha_echo: 'echo' } };
await registry.refresh(alpha, 's1');
const refreshed = await registry.globalEntries([alpha], 's1', false);
assert.deepEqual(refreshed.map((x) => x.name), ['alpha_echo', 'fresh'], 'refresh must replace stale catalog metadata without replaying calls');
assert.ok(listCalls >= 3, 'catalogs were loaded and refreshed');

const disabled = { ...base('disabled', { expose: ['known'], aliases: { disabled_known: 'known' } }), enabled: false };
const disabledBindings = registry.bindingsForServer(disabled, undefined);
assert.deepEqual(disabledBindings.map((x) => x.exposedName), ['disabled_known'], 'disabled MCP can project configured exposed aliases without spawning');

console.log('PROXY TOOL-FIRST UNIT PASS');
