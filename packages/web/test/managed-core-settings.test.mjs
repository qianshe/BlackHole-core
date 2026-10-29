import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const { build } = createRequire(new URL('../../vscode/package.json', import.meta.url))('esbuild');
const React = require('react'), { renderToStaticMarkup } = require('react-dom/server');
const mocks = {
  '../api': 'export const request=(...args)=>globalThis.__surface.request(...args);',
  './host': 'export const settingsHost=()=>globalThis.__surface.host; export const hasNativeMaintenance=()=>globalThis.__surface.host.kind!=="web";',
  './api': 'export const api={stopDaemon:()=>globalThis.__surface.request("/daemon/stop")}; export class ApiError extends Error {}',
  './format': 'export const errorText=()=>"fixture-error";',
  './Forms.module.css': 'export default {};',
};
// Bundle into memory; no shared dist, live HTTP, account or installed extension.
const result = await build({ stdin: { contents: "export {ManagedCoreSection} from './ManagedCoreSection'; export {runManagedCoreAction} from './managedCoreActions'; export {ServiceCard} from '../AccountCard';", resolveDir: fileURLToPath(new URL('../src/settings', import.meta.url)), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', external: ['react', 'react/jsx-runtime'], write: false, logLevel: 'silent', plugins: [{ name: 'isolated-host', setup(build) {
    build.onResolve({ filter: /^(\.\.\/api|\.\/api|\.\/host|\.\/format|\.\/Forms\.module\.css)$/ }, args => ({ path: args.path, namespace: 'isolated-host' }));
    build.onLoad({ filter: /.*/, namespace: 'isolated-host' }, args => ({ contents: mocks[args.path], loader: 'js' }));
  } }] });
function fixture(kind = 'vscode') {
  const calls = [], state = { kind, host: { kind }, request: async (...args) => { calls.push(args); return { completed: true }; } };
  const module = { exports: {} };
  vm.runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, require, __surface: state, console });
  return { state, calls, ...module.exports };
}
const view = { revision: 12, pending_restart: ['skillsDir'], managed: true, application: { started_revision: 9, restart: 'manager-confirmation', port: 'manager-cold-change' } };

test('managed settings render saved and startup versions separately, without issuing actions', () => {
  const h = fixture(); let refreshes = 0;
  const html = renderToStaticMarkup(React.createElement(h.ManagedCoreSection, { settings: view, refresh: async () => { refreshes++; } }));
  assert.match(html, /已保存的配置版本/); assert.match(html, />12</); assert.match(html, /启动时的配置版本/); assert.match(html, />9</);
  assert.match(html, /应用保存配置并重启/); assert.match(html, /配置共享端口/); assert.match(html, /检查／恢复维护事务/);
  assert.match(html, /独立凭据或密钥文件不在此版本范围内/);
  assert.equal(refreshes, 0); assert.deepEqual(h.calls, []);
});

test('browser rendering explains native handoff and exposes no pretend maintenance button', async () => {
  const h = fixture('web');
  const html = renderToStaticMarkup(React.createElement(h.ManagedCoreSection, { settings: view, refresh: async () => {} }));
  assert.match(html, /此页面无原生维护通道/); assert.match(html, /Apply Shared Core Settings/);
  assert.doesNotMatch(html, /<button/);
  await assert.rejects(h.runManagedCoreAction('apply-settings', 12), /native_maintenance_required/);
  assert.deepEqual(h.calls, []);
});

test('legacy view is unchanged and managed no-pending view disables apply', () => {
  const h = fixture();
  assert.equal(renderToStaticMarkup(React.createElement(h.ManagedCoreSection, { settings: { ...view, managed: false }, refresh: async () => {} })), '');
  const html = renderToStaticMarkup(React.createElement(h.ManagedCoreSection, { settings: { ...view, pending_restart: [] }, refresh: async () => {} }));
  assert.match(html, /没有待重启设置/); assert.match(html, /<button[^>]*disabled[^>]*>应用保存配置并重启/);
  assert.deepEqual(h.calls, []);
});

test('native apply sends the exact displayed revision and cannot report false as success', async () => {
  const h = fixture(); h.state.request = async (...args) => { h.calls.push(args); return { completed: false }; };
  assert.equal((await h.runManagedCoreAction('apply-settings', 12)).completed, false);
  assert.equal(h.calls[0][0], '/host/core/apply-settings');
  assert.deepEqual(JSON.parse(h.calls[0][1].body), { revision: 12 });
  assert.equal(h.calls[0][1].method, 'POST');
});

test('desktop host renders native actions and delegates through its bridge only', async () => {
  const h = fixture('desktop'); const bridged = [];
  h.state.host.coreAction = async (action, revision) => { bridged.push([action, revision]); return { completed: true }; };
  const html = renderToStaticMarkup(React.createElement(h.ManagedCoreSection, { settings: view, refresh: async () => {} }));
  assert.match(html, /应用保存配置并重启/); assert.match(html, /检查／恢复维护事务/);
  assert.equal((await h.runManagedCoreAction('apply-settings', 12)).completed, true);
  assert.equal((await h.runManagedCoreAction('stop')).completed, true);
  assert.deepEqual(bridged, [['apply-settings', 12], ['stop', undefined]]);
  assert.deepEqual(h.calls, []);
});

test('desktop bridge absence and malformed bridge results never fall back to fetch', async () => {
  const h = fixture('desktop');
  await assert.rejects(h.runManagedCoreAction('apply-settings', 12), /native_maintenance_required/);
  h.state.host.coreAction = async () => ({ completed: true, token: 'not-allowed' });
  await assert.rejects(h.runManagedCoreAction('inspect-maintenance'), /maintenance_result_unknown/);
  assert.deepEqual(h.calls, []);
});

test('invalid actions/revisions never dispatch; malformed replies are not retried or accepted', async () => {
  const h = fixture();
  for (const value of [-1, 1.5, '12', null, Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(h.runManagedCoreAction('apply-settings', value), /revision/);
  await assert.rejects(h.runManagedCoreAction('arbitrary-command', 12));
  await assert.rejects(h.runManagedCoreAction('configure-port', 12));
  assert.deepEqual(h.calls, []);
  h.state.request = async (...args) => { h.calls.push(args); return { completed: true, token: 'not-allowed' }; };
  await assert.rejects(h.runManagedCoreAction('apply-settings', 12), /maintenance_result_unknown/);
  assert.equal(h.calls.length, 1);
});

test('managed service stop has no browser action; native host retains its confirmation entry', () => {
  const h = fixture();
  const browser = renderToStaticMarkup(React.createElement(h.ServiceCard, { managed: true, nativeMaintenance: false }));
  assert.match(browser, /请在 VS Code 或 BlackHole Desktop 中停止后台服务/);
  assert.match(browser, /<button[^>]*disabled[^>]*>请在应用中停止/);
  const native = renderToStaticMarkup(React.createElement(h.ServiceCard, { managed: true, nativeMaintenance: true }));
  assert.match(native, /<button[^>]*>停止 BlackHole<\/button>/);
  const legacy = renderToStaticMarkup(React.createElement(h.ServiceCard));
  assert.match(legacy, /停止 BlackHole/);
  assert.deepEqual(h.calls, []);
});
