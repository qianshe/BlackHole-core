// 侧边栏首次引导与渠道总开关（用户 2026-10-03）：未登录显示登录卡片；没有 cloudflared 时一键安装→重启→启动临时渠道；
// 标题开关一键开/关上次使用的渠道。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { handoffModules } from './handoff-modules.mjs';
import { toolNames } from '../../../scripts/fixtures/tool-names.mjs';
const require = createRequire(import.meta.url), ts = require('typescript');
const pause = () => new Promise((r) => setImmediate(r));
const plain = (v) => JSON.parse(JSON.stringify(v));

const OFF = { on: false, state: 'off', running: [], next: 'quick', last: null, missing: 'cloudflared', reason: null };

function setup({ channel = OFF, hooks = {} } = {}) {
  const commandsRun = [];
  const vscode = { commands: { executeCommand: async (...a) => { commandsRun.push(a); } }, env: { clipboard: { writeText: async () => {} } }, workspace: { workspaceFolders: [] }, window: { showErrorMessage() {}, showInformationMessage() {} } };
  const source = fs.readFileSync(new URL('../src/sidebar.ts', import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(js, { module, exports: module.exports, console, AbortController, setTimeout, clearTimeout, require: (n) => n in handoffModules ? handoffModules[n] : n === './config' ? { getConfig: () => ({}) } : n === './toolNames' ? toolNames : n === 'vscode' ? vscode : n === './icons' ? { sidebarIcons: () => '{}' } : n === './callFormat' ? {} : n === './editorNavigation' ? { editorNavigationPreview: () => undefined, resolveEditorNavigation: () => ({ state: 'file_only' }) } : require(n) });
  const calls = [];
  let current = channel;
  const api = {
    changes: async () => ({ epoch: 1 }), listSessions: async () => ({ sessions: [] }), health: async () => ({ tunnel: 'off' }), confirmations: async () => ({ confirmations: [] }),
    channel: async () => { if (current instanceof Error) throw current; return current; },
    channelSwitch: async (on) => { calls.push(['switch', on]); return api.switchResult ?? { ok: true, view: current }; },
    tunnelStart: async (mode) => { calls.push(['tunnelStart', mode]); return api.startResult ?? { status: 'starting', url: null, mode, reason: null }; },
  };
  const daemon = { currentState: 'running', onDidChangeState: () => ({ dispose() {} }), restart: async () => { calls.push(['restart']); return api.restartOk ?? true; } };
  let dismissed = false;
  const allHooks = { setupDismissed: () => dismissed, dismissSetup: (v) => { calls.push(['dismiss', v]); dismissed = v; }, installCloudflared: async () => { calls.push(['install']); if (api.installError) throw new Error(api.installError); }, ...hooks };
  const provider = new module.exports.SidebarProvider(api, daemon, { onTick: () => ({ dispose() {} }) }, allHooks);
  const messages = [];
  const webview = { html: '', options: {}, postMessage: async (m) => { messages.push(plain(m)); return true; }, onDidReceiveMessage: () => ({ dispose() {} }) };
  const view = { webview, onDidDispose: () => ({ dispose() {} }) };
  return { provider, api, calls, commandsRun, messages, view, setChannel: (c) => { current = c; }, last: () => messages.filter((m) => m.type === 'update').at(-1) };
}
async function mount(h) { h.provider.resolveWebviewView(h.view); await pause(); await h.provider.refresh(true); }

test('开关状态和登录状态推给页面；旧版 daemon 没有 /channel 时不显示开关', async () => {
  const h = setup();
  await mount(h);
  assert.deepEqual(h.last().channel, OFF);
  assert.equal(h.last().account, null);
  h.provider.updateAccount({ state: 'logged_out' });
  assert.equal(h.last().account, 'logged_out');
  h.setChannel(new Error('not_found'));
  await h.provider.refresh(true);
  assert.equal(h.last().channel, null);
  h.provider.dispose();
});

test('一键安装并启动：安装 → 重启 daemon → 启动临时渠道，按顺序推送进度，完成后收起卡片', async () => {
  const h = setup();
  await mount(h);
  await h.provider.onMessage({ type: 'setupStart' });
  assert.deepEqual(h.calls, [['install'], ['restart'], ['tunnelStart', 'quick']]);
  const steps = h.messages.filter((m) => m.type === 'update' && m.setup).map((m) => m.setup.step);
  assert.deepEqual([...new Set(steps)], ['install', 'restart', 'start']);
  assert.equal(h.last().setup, null);
  h.provider.dispose();
});

test('一键安装失败：停在失败的那一步并给出原因，不重启也不启动；重试从头再来', async () => {
  const h = setup();
  await mount(h);
  h.api.installError = '下载失败：网络不可用';
  await h.provider.onMessage({ type: 'setupStart' });
  assert.deepEqual(h.calls, [['install']]);
  assert.deepEqual(h.last().setup, { step: 'failed', failedAt: 'install', error: '下载失败：网络不可用' });
  h.api.installError = undefined; h.api.startResult = { status: 'unavailable', url: null, mode: 'quick', reason: 'cloudflared 启动失败' };
  await h.provider.onMessage({ type: 'setupStart' });
  assert.deepEqual(h.last().setup, { step: 'failed', failedAt: 'start', error: 'cloudflared 启动失败' });
  await h.provider.onMessage({ type: 'setupDismiss' });
  assert.equal(h.last().setup, null, '点「稍后」收起失败的卡片');
  assert.equal(h.last().setupDismissed, true);
  h.provider.dispose();
});

test('标题开关：打开走 /channel；缺 cloudflared 时重新展开引导卡片；缺 OpenAI 配置时打开设置页', async () => {
  const h = setup();
  await mount(h);
  await h.provider.onMessage({ type: 'channelToggle', on: true });
  assert.deepEqual(h.calls[0], ['switch', true]);
  assert.equal(h.last().channelNote, null);
  h.api.switchResult = { ok: false, error: 'cloudflared' };
  await h.provider.onMessage({ type: 'channelToggle', on: true });
  assert.deepEqual(h.calls.at(-1), ['dismiss', false], '缺 cloudflared：取消「稍后」，重新显示引导卡片');
  assert.match(h.last().channelNote, /一键安装并启动/);
  h.api.switchResult = { ok: false, error: 'openai_setup' };
  await h.provider.onMessage({ type: 'channelToggle', on: true });
  assert.deepEqual(h.commandsRun.at(-1), ['blackhole.openSettings']);
  assert.match(h.last().channelNote, /OpenAI/);
  await h.provider.onMessage({ type: 'signIn' });
  assert.deepEqual(h.commandsRun.at(-1), ['blackhole.accountSignIn']);
  h.provider.dispose();
});

test('页面脚本：标题开关、登录卡片和引导卡片都在，脚本没有语法错误', async () => {
  const h = setup();
  await mount(h);
  const html = h.view.webview.html;
  assert.match(html, /class="chsw" id="chsw" role="switch" aria-checked="false"/);
  for (const fn of ['function renderOnboarding(d)', 'function onboardingState(d)', 'function renderSwitch(d)']) assert.ok(html.includes(fn), fn);
  assert.match(html, /type: 'channelToggle', on/);
  assert.match(html, /#list\[data-mode="sessions"\] > \.bh-onboard\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/s, '引导跨满 Handoff 的所有网格列');
  assert.match(html, /class="bh-onboard-actions"/, '登录和渠道引导复用统一操作区');
  assert.match(html, /const onboarding = onboardingState\(d\)/, '错误展示与引导复用同一状态判断');
  assert.match(html, /if \(guide && guide\.dataset\.state !== 'dismissed'\) \{ restoreScroll\(scrollY\); return; \}/, '聚焦引导期间隐藏旧会话历史');
  assert.match(html, /prefers-reduced-motion/);
  for (const [, script] of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new vm.Script(script));
  h.provider.dispose();
});

// Layout belongs to the real sidebar, including Handoff's four-column session grid.
test('B welcome spans the session grid and offers progressive disclosure, not an outer card', async () => {
  const h = setup();
  try {
    await mount(h);
    const html = h.view.webview.html;
    assert.match(html, /#list\[data-mode="sessions"\] > \.bh-onboard\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/s);
    assert.ok(html.includes('连接你的工作区'));
    assert.ok(html.includes('已有通道或其它连接方式'));
    assert.ok(html.includes('查看错误详情'));
    assert.ok(html.includes('setupResume'));
    assert.doesNotMatch(html, /function loginCard\(\)|function setupCard\(d\)/);
  } finally { h.provider.dispose(); }
});

test('B presentation distinguishes setup, pending, unverified, failure and actual readiness', async () => {
  const h = setup();
  try {
    await mount(h);
    const html = h.view.webview.html;
    const source = html.slice(html.indexOf('function onboardingState(d)'), html.indexOf('function onboardProgress('));
    const classify = vm.runInNewContext('(' + source + ')', { onboardEngaged: false });
    const d = { daemon: 'running', account: 'verified', sessions: [], channel: OFF };
    assert.equal(classify(d), 'setup', 'missing binary is not a failure');
    assert.equal(classify({ ...d, account: 'logged_out' }), 'login');
    assert.equal(classify({ ...d, daemon: 'starting', setup: { step: 'restart' } }), 'restart');
    assert.equal(classify({ ...d, channel: { ...OFF, on: true, state: 'starting', missing: null } }), 'start');
    assert.equal(classify({ ...d, channel: { ...OFF, on: true, state: 'warn', missing: null } }), 'unverified');
    assert.equal(classify({ ...d, channel: { ...OFF, on: true, state: 'on', missing: null } }), 'ready');
    assert.equal(classify({ ...d, account: 'saved', channel: { ...OFF, on: true, state: 'on' } }), null, 'cached credentials are not verified login');
    assert.equal(classify({ ...d, setup: { step: 'failed', failedAt: 'install', error: 'network' } }), 'failed');
    assert.equal(classify({ ...d, setupDismissed: true }), 'dismissed');
    assert.equal(classify({ ...d, setupDismissed: true, channel: { ...OFF, on: true, state: 'warn' } }), 'dismissed');
    assert.equal(classify({ ...d, channel: null }), null, 'older daemons keep existing compatibility');
    assert.equal(classify({ ...d, sessions: [{ draft: false }], channel: { ...OFF, on: true, state: 'on', last: 'quick', missing: null } }), null, 'existing sessions do not get a permanent welcome page');
  } finally { h.provider.dispose(); }
});

test('continue setup only restores presentation, without installing or starting anything', async () => {
  const h = setup();
  try {
    await mount(h);
    await h.provider.onMessage({ type: 'setupDismiss' });
    await h.provider.onMessage({ type: 'setupResume' });
    assert.equal(h.last().setupDismissed, false);
    assert.deepEqual(h.calls, [['dismiss', true], ['dismiss', false]]);
  } finally { h.provider.dispose(); }
});
