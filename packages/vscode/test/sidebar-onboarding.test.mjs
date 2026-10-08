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

function setup({ channel = OFF, hooks = {}, settingsValues = {} } = {}) {
  const commandsRun = [], opened = [];
  const vscode = { commands: { executeCommand: async (...a) => { commandsRun.push(a); } }, env: { clipboard: { writeText: async () => {} }, openExternal: async (u) => { opened.push(String(u)); } }, Uri: { parse: (u) => u }, workspace: { workspaceFolders: [] }, window: { showErrorMessage() {}, showInformationMessage() {} } };
  const source = fs.readFileSync(new URL('../src/sidebar.ts', import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(js, { module, exports: module.exports, console, AbortController, setTimeout, clearTimeout, require: (n) => n in handoffModules ? handoffModules[n] : n === './config' ? { getConfig: () => ({}) } : n === './toolNames' ? toolNames : n === 'vscode' ? vscode : n === './icons' ? { sidebarIcons: () => '{}' } : n === './callFormat' ? {} : n === './editorNavigation' ? { editorNavigationPreview: () => undefined, resolveEditorNavigation: () => ({ state: 'file_only' }) } : require(n) });
  const calls = [];
  let current = channel;
  let health = {
    tunnel: 'off', tunnel_url: null, tunnel_mode: null, tunnel_reason: null, daemon_id: 'daemon-1', openai_tunnel_api_version: 1,
    openai_tunnel: { status: 'off', run_id: null, active_tunnel_id: null, credential_configured: false, credential_revision: 1, pending_restart: false, reason_code: null, reason: null, client_version: null, started_at: null, ready_at: null },
  };
  let settings = { revision: 1, values: { channelMode: 'cloudflare', openaiTunnelId: '', openaiTunnelClientPath: '', ...settingsValues } };
  const api = {
    changes: async () => ({ epoch: 1 }), listSessions: async () => ({ sessions: [] }), health: async () => health, confirmations: async () => ({ confirmations: [] }),
    settings: async () => settings,
    patchSettings: async (values, revision) => {
      calls.push(['patchSettings', values, revision]);
      settings = { revision: settings.revision + 1, values: { ...settings.values, ...values } };
      return settings;
    },
    channel: async () => { if (current instanceof Error) throw current; return current; },
    channelSwitch: async (on) => { calls.push(['switch', on]); return api.switchResult ?? { ok: true, view: current }; },
    tunnelStart: async (mode) => { calls.push(['tunnelStart', mode]); return api.startResult ?? { status: 'starting', url: null, mode, reason: null }; },
    openaiTunnelSetKey: async (daemonId, revision, key) => {
      calls.push(['saveKey', daemonId, revision, key]);
      health = { ...health, openai_tunnel: { ...health.openai_tunnel, credential_configured: true, credential_revision: revision + 1 } };
      return { credential_configured: true, credential_revision: revision + 1, pending_restart: false };
    },
    openaiTunnelStart: async (daemonId, revision, credentialRevision) => {
      calls.push(['openaiStart', daemonId, revision, credentialRevision]);
      health = { ...health, openai_tunnel: { ...health.openai_tunnel, status: 'ready', active_tunnel_id: settings.values.openaiTunnelId, credential_configured: true, credential_revision: credentialRevision } };
      current = { on: true, state: 'on', running: ['openai'], next: 'openai', last: 'openai', missing: null, reason: null };
      return health.openai_tunnel;
    },
  };
  const daemon = { currentState: 'running', onDidChangeState: () => ({ dispose() {} }), restart: async () => { calls.push(['restart']); return api.restartOk ?? true; } };
  let dismissed = false;
  const allHooks = {
    setupDismissed: () => dismissed,
    dismissSetup: (v) => { calls.push(['dismiss', v]); dismissed = v; },
    installCloudflared: async () => { calls.push(['install']); if (api.installError) throw new Error(api.installError); },
    installOpenaiTunnel: async () => { calls.push(['installOpenai']); if (api.openaiInstallError) throw new Error(api.openaiInstallError); return { path: '/fixture/tunnel-client-runtime', installed: true, version: 'v0.0.15' }; },
    ...hooks,
  };
  const provider = new module.exports.SidebarProvider(api, daemon, { onTick: () => ({ dispose() {} }) }, allHooks);
  const messages = [];
  const webview = { html: '', options: {}, postMessage: async (m) => { messages.push(plain(m)); return true; }, onDidReceiveMessage: () => ({ dispose() {} }) };
  const view = { webview, onDidDispose: () => ({ dispose() {} }) };
  return { provider, api, calls, commandsRun, opened, messages, view, hasConnectionConfiguration: module.exports.hasConnectionConfiguration, setChannel: (c) => { current = c; }, last: () => messages.filter((m) => m.type === 'update').at(-1) };
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


test('saved connection intent is independent from runtime online state', async () => {
  const none = setup();
  const configured = setup({ settingsValues: { cloudflaredPath: 'C:/tools/cloudflared.exe' } });
  try {
    assert.equal(none.hasConnectionConfiguration({ channelMode: 'cloudflare' }), false);
    assert.equal(configured.hasConnectionConfiguration({ cloudflaredPath: 'C:/tools/cloudflared.exe' }), true);
    assert.equal(configured.hasConnectionConfiguration({ publicBaseUrl: 'https://mcp.example.test' }), true);
    assert.equal(configured.hasConnectionConfiguration({ directAccessEnabled: true }), true);
    assert.equal(configured.hasConnectionConfiguration({ directAccessUrl: 'https://fixture.example' }), true);
    assert.equal(configured.hasConnectionConfiguration({ openaiTunnelId: 'tunnel_' + 'a'.repeat(32) }), true);
    await mount(configured);
    configured.provider.updateAccount({ state: 'logged_out' });
    await pause();
    assert.equal(configured.last().setupConfigured, true, 'a stopped but configured channel suppresses first-install choices');
  } finally {
    none.provider.dispose();
    configured.provider.dispose();
  }
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
  assert.deepEqual(h.commandsRun.at(-1), ['blackhole.openSettings', 'connections']);
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
test('login welcome spans the session grid and contains optional channel setup without a second welcome page', async () => {
  const h = setup();
  try {
    await mount(h);
    const html = h.view.webview.html;
    assert.match(html, /#list\[data-mode="sessions"\] > \.bh-onboard\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/s);
    assert.ok(html.includes('登录 BlackHole'));
    assert.ok(html.includes('配置直连'));
    assert.ok(html.includes('临时公网渠道'));
    assert.ok(html.includes('OpenAI Tunnel'));
    assert.ok(html.includes('跳过渠道安装'));
    assert.ok(html.includes('查看错误详情'), 'setup failures still expose diagnostics');
    assert.doesNotMatch(html, /function loginCard\(\)|function setupCard\(d\)/);
  } finally { h.provider.dispose(); }
});

test('welcome ownership depends on login, not sessions or channel runtime state', async () => {
  const h = setup();
  try {
    await mount(h);
    const html = h.view.webview.html;
    const source = html.slice(html.indexOf('function onboardingState(d)'), html.indexOf('function onboardProgress('));
    const classify = vm.runInNewContext('(' + source + ')');
    const d = { daemon: 'running', account: 'verified', sessions: [], channel: OFF };
    assert.equal(classify(d), null, 'a verified account enters the workspace even with no channel');
    const out = { ...d, account: 'logged_out' };
    assert.equal(classify(out), 'login');
    assert.equal(classify({ ...out, sessions: [{ draft: false }], channel: { ...OFF, on: true, state: 'on', last: 'quick', missing: null } }), 'login', 'sessions and a running channel do not bypass login');
    assert.equal(classify({ ...out, setup: { step: 'restart' } }), 'restart', 'explicit setup may keep progress on the login page');
    assert.equal(classify({ ...out, setup: { step: 'failed', failedAt: 'install', error: 'network' } }), 'failed');
    assert.equal(classify({ ...out, openaiOnboarding: { step: 'configure', runtimeReady: true } }), 'openai');
    assert.equal(classify({ ...out, setupDismissed: true }), 'login', 'skip changes the install section, not login ownership');
    assert.equal(classify({ ...d, account: 'saved' }), null, 'saved credentials do not reopen first-run setup');
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

test('OpenAI onboarding is a parallel first-run path: install runtime, then one submit saves ID/key and starts OpenAI without cloudflared', async () => {
  const h = setup();
  try {
    await mount(h);
    h.provider.updateAccount({ state: 'verified' });
    await h.provider.onMessage({ type: 'openaiSetupStart' });
    assert.ok(h.calls.some((c) => c[0] === 'installOpenai'));
    assert.ok(!h.calls.some((c) => c[0] === 'install' || c[0] === 'tunnelStart'), 'OpenAI onboarding never requires the quick tunnel');
    assert.deepEqual(h.last().openaiOnboarding, { step: 'configure', runtimeReady: true, version: 'v0.0.15', failedAt: null, error: null });

    const tunnelId = 'tunnel_' + 'a'.repeat(32);
    const key = 'sk-runtime-test-12345678';
    await h.provider.onMessage({ type: 'openaiConnect', tunnelId, apiKey: key });

    const patch = h.calls.find((c) => c[0] === 'patchSettings');
    assert.equal(patch[1].openaiTunnelId, tunnelId);
    assert.equal(patch[1].channelMode, 'openai');
    assert.equal(patch[1].openaiTunnelClientPath, '/fixture/tunnel-client-runtime');
    assert.ok(h.calls.some((c) => c[0] === 'saveKey' && c[3] === key));
    assert.ok(h.calls.some((c) => c[0] === 'openaiStart'));
    assert.deepEqual(h.last().channel.running, ['openai']);
    assert.doesNotMatch(JSON.stringify(h.messages), /sk-runtime-test-12345678/, 'Runtime API Key is never echoed back into sidebar state');
  } finally { h.provider.dispose(); }
});

test('OpenAI onboarding reuses an already-saved Runtime API Key, exposes no separate save buttons, and opens only the fixed Platform target', async () => {
  const h = setup();
  try {
    await mount(h);
    h.api.health = async () => ({
      tunnel: 'off', tunnel_url: null, tunnel_mode: null, tunnel_reason: null, daemon_id: 'daemon-1', openai_tunnel_api_version: 1,
      openai_tunnel: { status: 'off', run_id: null, active_tunnel_id: null, credential_configured: true, credential_revision: 7, pending_restart: false, reason_code: null, reason: null, client_version: null, started_at: null, ready_at: null },
    });
    const tunnelId = 'tunnel_' + 'b'.repeat(32);
    h.api.settings = async () => ({ revision: 5, values: { channelMode: 'openai', openaiTunnelId: tunnelId, openaiTunnelClientPath: '/existing/runtime' } });
    await h.provider.refresh(true);
    await h.provider.onMessage({ type: 'openaiSetupStart' });
    await h.provider.onMessage({ type: 'openaiConnect', tunnelId, apiKey: '' });
    assert.ok(!h.calls.some((c) => c[0] === 'saveKey'), 'blank key keeps the already-saved secret');
    assert.ok(h.calls.some((c) => c[0] === 'openaiStart'));

    const html = h.view.webview.html;
    assert.ok(html.includes('id="guideQuick"'));
    assert.ok(html.includes('id="guideOpenai"'));
    assert.ok(html.includes('guideOpenaiConnect'));
    assert.ok(html.includes('id="guideOpenaiTunnelId"'));
    assert.ok(html.includes('id="guideOpenaiKey"'));
    assert.ok(!html.includes('guideOpenaiSaveKey'));
    assert.ok(!html.includes('guideOpenaiSaveTunnel'));
    assert.ok(!html.includes("type: 'openaiSaveKey'"));

    await h.provider.onMessage({ type: 'openOpenaiLink', target: 'platform' });
    assert.equal(h.opened.at(-1), 'https://platform.openai.com/settings/organization/tunnels');
  } finally { h.provider.dispose(); }
});

test('OpenAI onboarding failure is recoverable: later/resume preserves route, back returns to choice, and arbitrary link targets are ignored', async () => {
  const h = setup();
  try {
    await mount(h);
    h.api.openaiInstallError = 'network unavailable';
    await h.provider.onMessage({ type: 'openaiSetupStart' });
    assert.deepEqual(h.last().openaiOnboarding, { step: 'failed', runtimeReady: false, version: null, failedAt: 'install', error: 'network unavailable' });

    await h.provider.onMessage({ type: 'setupDismiss' });
    assert.equal(h.last().setupDismissed, true);
    assert.equal(h.last().openaiOnboarding.failedAt, 'install', 'collapse does not discard recoverable OpenAI state');
    await h.provider.onMessage({ type: 'setupResume' });
    assert.equal(h.last().setupDismissed, false);

    const opened = h.opened.length;
    await h.provider.onMessage({ type: 'openOpenaiLink', target: 'https://evil.example' });
    assert.equal(h.opened.length, opened, 'webview cannot choose an arbitrary onboarding URL');

    await h.provider.onMessage({ type: 'openaiSetupBack' });
    assert.equal(h.last().openaiOnboarding, null);
  } finally { h.provider.dispose(); }
});

test('OpenAI onboarding rejects an invalid Runtime API Key before persisting settings or starting the tunnel', async () => {
  const h = setup();
  try {
    await mount(h);
    await h.provider.onMessage({ type: 'openaiSetupStart' });
    const before = h.calls.length;
    await h.provider.onMessage({ type: 'openaiConnect', tunnelId: 'tunnel_' + 'c'.repeat(32), apiKey: 'bad key' });
    const after = h.calls.slice(before);
    assert.ok(!after.some((c) => c[0] === 'patchSettings' || c[0] === 'saveKey' || c[0] === 'openaiStart'));
    assert.equal(h.last().openaiOnboarding.failedAt, 'connect');
    assert.match(h.last().openaiOnboarding.error, /Runtime API Key/);
  } finally { h.provider.dispose(); }
});

test('OpenAI onboarding clears the plaintext Key draft immediately after secret-store success even when tunnel start fails', async () => {
  const h = setup();
  try {
    await mount(h);
    await h.provider.onMessage({ type: 'openaiSetupStart' });
    h.api.openaiTunnelStart = async () => { throw new Error('start_failed'); };

    const key = 'sk-runtime-stored-12345678';
    await h.provider.onMessage({ type: 'openaiConnect', tunnelId: 'tunnel_' + '9'.repeat(32), apiKey: key });

    assert.ok(h.calls.some((c) => c[0] === 'saveKey' && c[3] === key), 'secret store accepted the new key');
    assert.ok(h.messages.some((m) => m.type === 'openaiCredentialStored'), 'host tells the webview to discard the plaintext draft after storage succeeds');
    assert.doesNotMatch(JSON.stringify(h.messages), /sk-runtime-stored-12345678/, 'the clear signal never echoes the secret');
    assert.equal(h.last().openaiConfig.credentialConfigured, true, 'retry can reuse the stored credential');
    assert.equal(h.last().openaiOnboarding.failedAt, 'connect');

    const html = h.view.webview.html;
    assert.ok(html.includes("d.type === 'openaiCredentialStored'"));
    assert.ok(html.includes("openaiKeyDraft = ''"));
  } finally { h.provider.dispose(); }
});


test('OpenAI onboarding absorbs the expected SettingsSync revision race after runtime install', async () => {
  const h = setup();
  try {
    await mount(h);
    await h.provider.onMessage({ type: 'openaiSetupStart' });

    const tunnelId = 'tunnel_' + 'd'.repeat(32);
    let settingsReads = 0, patchCalls = 0;
    let latest = { revision: 2, values: { channelMode: 'cloudflare', openaiTunnelId: '', openaiTunnelClientPath: '/fixture/tunnel-client-runtime' } };
    h.api.settings = async () => {
      settingsReads++;
      if (settingsReads === 1) return { revision: 1, values: { channelMode: 'cloudflare', openaiTunnelId: '', openaiTunnelClientPath: '' } };
      return latest;
    };
    h.api.patchSettings = async (values, revision) => {
      patchCalls++;
      h.calls.push(['patchSettingsRace', values, revision]);
      if (patchCalls === 1) {
        const e = new Error('revision_conflict');
        e.status = 409;
        throw e;
      }
      latest = { revision: 3, values: { ...latest.values, ...values } };
      return latest;
    };

    await h.provider.onMessage({ type: 'openaiConnect', tunnelId, apiKey: 'sk-runtime-race-12345678' });
    assert.equal(patchCalls, 2, 'expected SettingsSync race is retried once against the fresh revision');
    assert.deepEqual(h.calls.filter((c) => c[0] === 'patchSettingsRace').map((c) => c[2]), [1, 2]);
    assert.ok(h.calls.some((c) => c[0] === 'openaiStart'));
    assert.equal(h.last().channel.running[0], 'openai');
  } finally { h.provider.dispose(); }
});

test('OpenAI onboarding never overwrites a genuinely conflicting settings edit from another window', async () => {
  const h = setup();
  try {
    await mount(h);
    await h.provider.onMessage({ type: 'openaiSetupStart' });

    const wanted = 'tunnel_' + 'e'.repeat(32);
    const other = 'tunnel_' + 'f'.repeat(32);
    let settingsReads = 0, patchCalls = 0;
    h.api.settings = async () => {
      settingsReads++;
      return settingsReads === 1
        ? { revision: 1, values: { channelMode: 'cloudflare', openaiTunnelId: '', openaiTunnelClientPath: '' } }
        : { revision: 2, values: { channelMode: 'openai', openaiTunnelId: other, openaiTunnelClientPath: '/fixture/tunnel-client-runtime' } };
    };
    h.api.patchSettings = async (values, revision) => {
      patchCalls++;
      h.calls.push(['patchSettingsConflict', values, revision]);
      const e = new Error('revision_conflict');
      e.status = 409;
      throw e;
    };

    await h.provider.onMessage({ type: 'openaiConnect', tunnelId: wanted, apiKey: 'sk-runtime-conflict-12345678' });
    assert.equal(patchCalls, 1, 'conflicting user edit is never overwritten by a retry');
    assert.ok(!h.calls.some((c) => c[0] === 'saveKey' || c[0] === 'openaiStart'));
    assert.equal(h.last().openaiOnboarding.failedAt, 'connect');
    assert.match(h.last().openaiOnboarding.error, /设置刚刚发生变化/);
  } finally { h.provider.dispose(); }
});

test('OpenAI onboarding turns a later asynchronous runtime failure into a recoverable connect error', async () => {
  const h = setup();
  try {
    await mount(h);
    await h.provider.onMessage({ type: 'openaiSetupStart' });

    const tunnelId = 'tunnel_' + '1'.repeat(32);
    let runtime = {
      status: 'starting', run_id: 'run-1', active_tunnel_id: tunnelId, credential_configured: true,
      credential_revision: 2, pending_restart: false, reason_code: null, reason: null,
      client_version: 'v0.0.15', started_at: null, ready_at: null,
    };
    h.api.openaiTunnelStart = async () => runtime;
    h.api.health = async () => ({
      tunnel: 'off', tunnel_url: null, tunnel_mode: null, tunnel_reason: null, daemon_id: 'daemon-1',
      openai_tunnel_api_version: 1, openai_tunnel: runtime,
    });

    await h.provider.onMessage({ type: 'openaiConnect', tunnelId, apiKey: 'sk-runtime-async-12345678' });
    assert.equal(h.last().openaiOnboarding.step, 'connecting');

    runtime = { ...runtime, status: 'error', reason_code: 'auth_failed', reason: 'OpenAI 鉴权失败' };
    await h.provider.refresh(true);
    assert.equal(h.last().openaiOnboarding.step, 'failed');
    assert.equal(h.last().openaiOnboarding.failedAt, 'connect');
    assert.match(h.last().openaiOnboarding.error, /鉴权失败/);
  } finally { h.provider.dispose(); }
});
