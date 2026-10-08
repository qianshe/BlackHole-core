import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');

function load(file, mocks = {}, expose = '') {
  const js = ts.transpileModule(fs.readFileSync(new URL(file, import.meta.url), 'utf8') + expose, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(js, { module, exports: module.exports,
    require: name => Object.hasOwn(mocks, name) ? mocks[name] : require(name),
    window: { location: { port: '7306' } }, URL, console });
  return module.exports;
}
const summary = load('../../contracts/src/account-summary.ts');
const buildVersion = load('../../../src/version.ts');
const { SettingsPanel } = load('../src/panel/SettingsPanel.tsx', {
  react: { useCallback: fn => fn, useEffect() {}, useRef: value => ({ current: value }),
    useState: value => [typeof value === 'function' ? value() : value, () => {}] },
  '../../../contracts/src/account-summary': summary,
  '../../../../src/version': buildVersion,
  '../settings/host': { settingsHost: () => ({ kind: 'web' }) },
  '../settings/HostRuntimeSection': { HostRuntimeSection: () => null },
  '../settings/HostNotice': { HostNotice: () => null },
  '../settings/WebAgentsSection': { WebAgentsSection: () => null },
  '../api': { api: {}, panel: {}, ApiError: class extends Error {} },
  '../AccountCard': {}, '../ui': { SettingsIcon: () => null }, './panel.css': {}, './openaiCopy': {}, './OpenAISection': { openaiStatus: () => ({}) },
  './RemoteSection': {}, './HomeChannelCard': {}, '../directAddressPicker': {},
  '../console/common': { copyText: async () => true, Modal: () => null },
});
function nodes(element) {
  if (Array.isArray(element)) return element.flatMap(nodes);
  if (!element || typeof element !== 'object') return [];
  return [element, ...nodes(element.props?.children)];
}
function texts(element) {
  if (typeof element === 'string') return element;
  if (Array.isArray(element)) return element.map(texts).join('');
  return element && typeof element === 'object' ? texts(element.props?.children) : '';
}

test('settings home renders unknown identity without enabling account sign-out', () => {
  for (const account of [null, { state: 'unavailable' }, { state: 'saved' }, { state: 'logged_out', userId: 'old' }]) {
    const tree = SettingsPanel({ page: 'home', account, onAccountChange() {}, refreshAccount: async () => account, onSignOut() {} });
    const button = nodes(tree).find(el => el.type === 'button' && el.props?.['aria-label'] === '退出登录');
    assert.equal(button, undefined);
    assert.match(texts(tree), account?.state === 'logged_out' ? /未登录/ : /账号状态待确认/);
    assert.doesNotMatch(texts(tree), /已登录账号/);
  }
});

test('settings home lets a known offline identity use the existing sign-out action', () => {
  let called = 0;
  const tree = SettingsPanel({ page: 'home', account: { state: 'unavailable', userId: 'fixture-user' },
    onAccountChange() {}, refreshAccount: async () => null, onSignOut() { called++; } });
  const button = nodes(tree).find(el => el.type === 'button' && el.props?.['aria-label'] === '退出登录');
  assert.ok(button);
  assert.equal(button.props.disabled, undefined);
  assert.equal(button.props.title, '退出登录');
  button.props.onClick();
  assert.equal(called, 1);
  assert.match(texts(tree), /fixture-user/);
  assert.match(texts(tree), /时长待确认/);
});


const { TestAccountButton } = load('../src/console/Sidebar.tsx', {
  react: {}, '../../../contracts/src/account-summary': summary,
  './ChannelSwitch': {}, '../format': {}, '../ui': { Icon: () => null },
  './common': { useMenu: () => ({ open: true, close() {}, toggle() {}, onKeyDown() {}, wrapRef: null }) },
  './courierFeed': {}, './sessionActions': {}, './console.module.css': { default: {} },
}, '\nexport { AccountButton as TestAccountButton };\n');

test('workspace account menu uses the same identity guard as settings home', () => {
  for (const [account, enabled] of [
    [null, false], [{ state: 'unavailable' }, false], [{ state: 'saved' }, false],
    [{ state: 'logged_out', userId: 'old', account: { email: 'stale@example.test' } }, false],
    [{ state: 'unavailable', userId: 'fixture-user' }, true],
  ]) {
    const tree = TestAccountButton({ account, onAction() {} });
    const button = nodes(tree).find(el => el.type === 'button' && texts(el).trim() === '退出登录');
    assert.ok(button);
    assert.equal(button.props.disabled, !enabled);
    assert.doesNotMatch(texts(tree), /stale@example.test|已登录账号/);
  }
});
