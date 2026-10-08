import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import * as settingsNavigation from '../../contracts/src/settings-navigation.ts';
import { previewBootstrap } from '../../../scripts/fixtures/settings-preview.mjs';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function harness(endpoint = { environment: 'production', origin: 'https://blackhole.stellarbridge.dpdns.org' }, uiState, requestedPage) {
  const panels = [], polls = new Set(), errors = [], notices = [], warnings = [], clipboard = [], infoReplies = [], warningReplies = [];
  const installCalls = [], settingsWrites = [], tunnelCalls = [], infoDialogs = [], openaiCalls = [];
  const settings = {};
  let restarts = 0, installer = async () => { throw Error('installation must be explicitly requested'); };
  let openaiInstaller = async () => { throw Error('OpenAI installation must be explicitly requested'); };
  const makePanel = () => {
    let closed = false, onDispose, onMessage;
    const messages = [];
    const w = { html: '', postMessage: async msg => { if (closed) throw Error('Webview is disposed'); messages.push(msg); return true; }, onDidReceiveMessage(fn) { onMessage = fn; return { dispose() {} }; } };
    const panel = {
      visible: true, messages, reveal() {},
      get webview() { if (closed) throw Error('Webview is disposed'); return w; },
      onDidDispose(fn) { onDispose = fn; return { dispose() {} }; },
      onDidChangeViewState() { return { dispose() {} }; },
      close() { closed = true; onDispose?.(); },
      receive(msg) { onMessage?.(msg); },
    };
    panels.push(panel); return panel;
  };
  const vscode = {
    commands: { executeCommand: async () => ({ state: 'logged_out' }) },
    ViewColumn: { One: 1 }, ConfigurationTarget: { Global: 1 },
    workspace: { getConfiguration: () => ({ get: key => settings[key], update: async (...args) => { settingsWrites.push(args); settings[args[0]] = args[1]; } }) },
    window: { createWebviewPanel: makePanel, showErrorMessage: msg => errors.push(msg), showInformationMessage: async (msg, ...options) => { notices.push(msg); infoDialogs.push(options); return infoReplies.shift(); }, showWarningMessage: async msg => { warnings.push(msg); return warningReplies.length ? warningReplies.shift() : '重置'; } },
    env: { clipboard: { writeText: async value => clipboard.push(value) } },
  };
  const source = fs.readFileSync(new URL('../src/configPanel.ts', import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  const load = name => {
    if (name === 'vscode') return vscode;
    // An existing regular file makes a deterministic non-directory home; never scan real personal skills.
    if (name === 'node:os') return { homedir: () => require('node:url').fileURLToPath(import.meta.url) };
    if (name === './webAgents') return { AGENTS: [], customAgents: () => [] };
    if (name === './cloudflaredInstall') return { initializeCloudflared: async value => { installCalls.push(value); return installer(value); } };
    if (name === './openaiTunnelInstall') return { initializeOpenAITunnelClient: async value => { openaiCalls.push(value); return openaiInstaller(value); } };
    if (name === './proxySync') return { EMPTY_ANCHORS: { daemonId: null }, readAnchors: x => ({ daemonId: x.daemon_id }), mergeAnchors: (_, x) => x, decideSyncAction: () => 'none' };
    if (name === './cloudEnvironment') return { PRODUCTION_CLOUD_ORIGIN: 'https://blackhole.stellarbridge.dpdns.org', resolveCloudEndpoint: () => endpoint };
    if (name === '../../contracts/src/settings-navigation') return settingsNavigation;
    if (name === './config') return { getConfig: () => ({ ...settings }) };
    if (name === './sessionActions' || name === './templates') {
      const source = fs.readFileSync(new URL('../src/' + name.slice(2) + '.ts', import.meta.url), 'utf8');
      const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
      const child = { exports: {} };
      vm.runInNewContext(compiled, { module: child, exports: child.exports, require: load, console, URL });
      return child.exports;
    }
    return require(name);
  };
  vm.runInNewContext(js, { module, exports: module.exports, require: load, console, setTimeout, clearTimeout, AbortController, URL });
  let daemonStateListener;
  const daemon = { currentState: 'running', onDidChangeState(fn) { daemonStateListener = fn; return { dispose() { daemonStateListener = undefined; } }; } };
  const poller = { onTick(fn) { polls.add(fn); return { dispose: () => polls.delete(fn) }; } };
  const health = { ok: true, daemon_id: 'fixture', stats: { total: 0 }, activity_days: [] };
  const info = { configured: true, disabled: ['off'], config: [{ name: 'on', enabled: true }, { name: 'off', enabled: false }], status: [{ name: 'on', status: 'online', tools: [], catalogCount: 0 }, { name: 'off', status: 'disabled', tools: [] }] };
  const toolCalls = [];
  let rotateCalls = 0;
  const api = { health: async () => health, semanticInfo: async () => ({}), approvalGrants: async () => ({ always: [], sessions: [] }), proxies: async () => info, rotateMcpToken: async () => { rotateCalls++; return { mcp_url: 'https://example.test/mcp/token' }; }, installRuntime: async (runtime, value) => { if (runtime === 'cloudflared') { installCalls.push(value); return installer(value); } openaiCalls.push(value); return openaiInstaller(value); }, proxiesTools: async (...args) => { toolCalls.push(args); return { configured: true, name: args[0], daemonId: 'fixture', tools: [], cachedOnly: true }; } };
  const instance = new module.exports.ConfigPanel(api, daemon, poller, undefined, uiState, requestedPage);
  daemon.restart = async () => { restarts++; return true; };
  api.tunnelStart = async (...args) => { tunnelCalls.push(args); return {}; };
  return { instance, api, panels, polls, errors, notices, warnings, clipboard, get rotateCalls(){return rotateCalls;}, toolCalls, health, info,
    installCalls, settingsWrites, tunnelCalls, infoReplies, warningReplies, infoDialogs, settings, daemon, vscode, get restarts(){return restarts;}, setInstaller(fn){installer=fn;},
    openaiCalls, setOpenaiInstaller(fn){openaiInstaller=fn;} };
}
test('settings account summary distinguishes unknown, signed-out and known offline identity', async t => {
  const h = harness(); t.after(() => h.panels[0].close());
  await h.instance.dispatch({ type: 'ready' });
  const cases = [
    [{ state: 'unavailable' }, '账号状态待确认', false, null],
    [{ state: 'saved' }, '账号状态待确认', false, null],
    [{ state: 'logged_out', userId: 'old', remainingSeconds: 900, account: { name: 'Old' } }, '未登录', false, null],
    [{ state: 'unavailable', userId: 'fixture-user' }, 'fixture-user', true, null],
    [{ state: 'verified', userId: 'fixture-user', remainingSeconds: 300, account: { name: 'Fixture', status: 'active' } }, 'Fixture', true, 300],
  ];
  for (const [view, name, canSignOut, remaining] of cases) {
    h.vscode.commands.executeCommand = async () => view;
    await h.instance.accountStatus();
    const message = h.panels[0].messages.findLast(m => m.type === 'cloudAccount');
    assert.equal(message.summary.displayName, name);
    assert.equal(message.summary.canSignOut, canSignOut);
    assert.equal(message.summary.remainingSeconds, remaining);
  }
  assert.equal(h.restarts, 0);
  assert.equal(h.settingsWrites.length, 0);
});


test('manual page save only applies submitted fields and preserves other pages', async t => {
  const h = harness(); t.after(() => h.panels[0].close());
  Object.assign(h.settings, { channelMode: 'openai', cloudflaredPath: '/fixture/cloudflared', publicBaseUrl: 'https://fixture.example', skillsDir: '/fixture/old', port: 7306, connectorName: 'Fixture' });
  await h.instance.dispatch({ type: 'ready' });
  await h.instance.dispatch({ type: 'save', values: { skillsDir: '/fixture/new' } });
  assert.deepEqual(h.settingsWrites, [['skillsDir', '/fixture/new', 1]]);
  assert.equal(h.settings.channelMode, 'openai');
  assert.equal(h.settings.port, 7306);
  assert.equal(h.settings.cloudflaredPath, '/fixture/cloudflared');
});

test('saving another page does not validate or replace an untouched custom channel', async t => {
  const h = harness(); t.after(() => h.panels[0].close());
  Object.assign(h.settings, { channelMode: 'custom', publicBaseUrl: 'https://fixture.example', port: 7306 });
  await h.instance.dispatch({ type: 'ready' });
  await h.instance.dispatch({ type: 'save', values: { tunnelProbeProxy: 'http://127.0.0.1:7890' } });
  assert.deepEqual(h.settingsWrites, [['tunnelProbeProxy', 'http://127.0.0.1:7890', 1]]);
  assert.equal(h.errors.length, 0);
  assert.equal(h.settings.channelMode, 'custom');
  assert.equal(h.settings.publicBaseUrl, 'https://fixture.example');
});

test('settings layout has unique connection controls and page-scoped actions', async t => {
  const h = harness(); t.after(() => h.panels[0].close());
  Object.assign(h.settings, { channelMode: 'cloudflare', port: 7306, connectorName: 'BlackHole' });
  await h.instance.dispatch({ type: 'ready' });
  const html = h.panels[0].webview.html;
  const markup = html.split('<script nonce=')[0];
  assert.equal((markup.match(/id="mcpCopy"/g) || []).length, 1);
  assert.match(markup, /id="settingsActions" hidden/);
  assert.doesNotMatch(markup, /<details[^>]*data-page="connections"/);
  const positions = ['currentConnectionSec', 'channelSec', 'aiRouteSec', 'mcpSec'].map(id => markup.indexOf(`id="${id}"`));
  assert.ok(positions.every(p => p >= 0));
  assert.deepEqual([...positions].sort((a,b) => a-b), positions);
  assert.equal((markup.match(/data-settings-target=/g) || []).length, 7);
  assert.match(markup, /<dialog class="pair-modal" id="rmModal"/);
  assert.match(markup, /id="directAccessToggle"[^>]*role="switch"/);
  assert.doesNotMatch(markup, /publicDirectToggle|lanToggle|lanUrl/);
  assert.ok(markup.includes('id="channelSecTitle">公网渠道</span>'));
  assert.match(markup, /id="settingsMobileMenu"[^>]*aria-controls="settingsNav"/);
  assert.match(markup, /id="settingsNavScrim"/);
  assert.ok(html.includes('body.settings-nav-mobile-open .settings-nav { transform:translateX(0); visibility:visible;'), 'narrow settings navigation opens as a side drawer');
  assert.ok(!html.includes('.settings-nav-list { display:flex;'), 'narrow settings navigation is not converted to a top strip');
  assert.match(markup, /<section data-page="advanced">[\s\S]*id="restart"/);
  // Optional browser fixture: synthetic state, no daemon requests or settings writes.
  if (process.env.BH_UI_FIXTURE === '1') {
    const nonce = /<script nonce="([^"]+)"/.exec(html)[1];
    const frames = [...h.panels[0].messages, { type:'settingsNavigate',page:'connections' }];
    const qr = require('qrcode-generator')(0,'M'); qr.addData('FIXTURE_NOT_A_REAL_PAIRING'); qr.make();
    const n = qr.getModuleCount(); let qrPath = '';
    for(let y=0;y<n;y++)for(let x=0;x<n;x++)if(qr.isDark(y,x))qrPath+=`M${x} ${y}h1v1h-1z`;
    const boot = `<script nonce="${nonce}">${previewBootstrap(frames,{n,path:qrPath})}</script>`;
    const theme = `<style>:root{--vscode-font-family:system-ui;--vscode-editor-font-family:monospace;--vscode-foreground:#ddd;--vscode-descriptionForeground:#aaa;--vscode-editor-background:#1e1e1e;--vscode-sideBar-background:#252526;--vscode-panel-border:#444;--vscode-input-background:#333;--vscode-input-foreground:#eee;--vscode-input-border:#555;--vscode-button-background:#0869b0;--vscode-button-foreground:#fff;--vscode-button-secondaryBackground:#3c3c3c;--vscode-button-secondaryForeground:#eee;--vscode-focusBorder:#4aa3df;--vscode-textLink-foreground:#66b7ef;--vscode-list-hoverBackground:#333;--vscode-list-activeSelectionBackground:#174969;--vscode-list-activeSelectionForeground:#fff;--vscode-charts-green:#8cc489;--vscode-charts-yellow:#dec377;--vscode-charts-red:#ef8c89;--vscode-errorForeground:#ef8c89}</style>`;
    const dir = new URL('../../../.tmp/ui-refinement/', import.meta.url);
    fs.mkdirSync(dir, { recursive: true });
    const fixtureHtml = html.replace('</head>', theme + '</head>').replace(`<script nonce="${nonce}">`, boot + `<script nonce="${nonce}">`)
      .replace('<body>', '<body><aside role="note" style="margin:0 0 12px;font-size:12px">生产界面验证夹具 · 合成数据，不连接 daemon</aside>');
    fs.writeFileSync(new URL('settings.html', dir), fixtureHtml);
    const previewDir = new URL('../../../.tmp/settings-vscode-demo/', import.meta.url);
    fs.mkdirSync(previewDir,{recursive:true}); fs.writeFileSync(new URL('production-vscode.html',previewDir),fixtureHtml);
  }
});

function uiMemory() {
  const values = new Map([['blackhole.settingsLastPage.v1', 'account'], ['blackhole.settingsNavCollapsed.v1', true]]);
  return { get: (key, fallback) => values.has(key) ? values.get(key) : fallback, update: async (key, value) => { values.set(key, value); } };
}

test('deep links into an open panel survive disposal and preserve collapsed preference', async () => {
  const state = uiMemory();
  const h = harness(undefined, state);
  try {
    await h.instance.dispatch({ type: 'ready' });
    await h.instance.navigate('connections');
    assert.equal(state.get('blackhole.settingsLastPage.v1'), 'connections');
    assert.equal(state.get('blackhole.settingsNavCollapsed.v1'), true);
    assert.equal(h.panels[0].messages.findLast(m => m.type === 'settingsNavigate').page, 'connections');
    assert.equal(h.restarts, 0); assert.equal(h.settingsWrites.length, 0);
  } finally { h.panels[0].close(); }
  const reopened = harness(undefined, state);
  try {
    await reopened.instance.dispatch({ type: 'ready' });
    const restored = reopened.panels[0].messages.findLast(m => m.type === 'settingsUiRestore');
    assert.equal(restored.page, 'connections');
    assert.equal(restored.collapsed, true);
  } finally { reopened.panels[0].close(); }
});

test('deep link on initial creation wins over stored page and becomes last page', async t => {
  const state = uiMemory();
  const h = harness(undefined, state, 'network'); t.after(() => h.panels[0].close());
  await h.instance.dispatch({ type: 'ready' });
  const restored = h.panels[0].messages.findLast(m => m.type === 'settingsUiRestore');
  assert.equal(restored.page, 'network');
  assert.equal(state.get('blackhole.settingsLastPage.v1'), 'network');
  assert.equal(restored.collapsed, true);
  assert.equal(h.restarts, 0); assert.equal(h.settingsWrites.length, 0);
});

test('cloudflared initialization is explicit and only returns a draft path', async t => {
  const h=harness();t.after(()=>h.panels[0].close());
  await h.instance.dispatch({type:'ready'});await h.instance.poll();
  assert.equal(h.installCalls.length,0);
  h.setInstaller(async()=>({path:'/fixture/cloudflared',installed:true}));
  await h.instance.dispatch({type:'installCloudflared',path:'',channelMode:'cloudflare'});
  assert.deepEqual(h.installCalls,['']);
  const result=h.panels[0].messages.findLast(m=>m.type==='cloudflaredInstallResult');
  assert.equal(result.path,'/fixture/cloudflared');assert.equal(result.previousPath,'');
  assert.equal(result.installed,true);
  assert.equal(h.settingsWrites.length,0);assert.equal(h.restarts,0);assert.equal(h.tunnelCalls.length,0);
});

test('verified cloudflared can be saved and daemon restarted from the confirmation', async t => {
  const h=harness();t.after(()=>h.panels[0].close());await h.instance.dispatch({type:'ready'});
  h.setInstaller(async()=>({path:'/fixture/cloudflared',installed:false}));
  h.infoReplies.push('保存并重启');
  await h.instance.dispatch({type:'installCloudflared',path:'/fixture/cloudflared',channelMode:'cloudflare'});
  assert.deepEqual(h.settingsWrites,[['cloudflaredPath','/fixture/cloudflared',1]]);
  assert.equal(h.restarts,1);assert.equal(h.tunnelCalls.length,0);
  const result=h.panels[0].messages.findLast(m=>m.type==='cloudflaredInstallResult');
  assert.equal(result.saved,true);assert.equal(result.restarted,true);
  assert.ok(h.notices.some(message=>message.includes('路径已保存，daemon 已重启')));
});

test('custom channels never initialize cloudflared, save settings or restart the daemon', async t => {
  const h=harness();t.after(()=>h.panels[0].close());await h.instance.dispatch({type:'ready'});
  await h.instance.dispatch({type:'installCloudflared',path:'',channelMode:'custom'});
  assert.equal(h.installCalls.length,0);assert.equal(h.settingsWrites.length,0);
  assert.equal(h.restarts,0);assert.equal(h.tunnelCalls.length,0);
});

test('failed initialization only returns a hint, without a replacement path', async t => {
  const h=harness();t.after(()=>h.panels[0].close());await h.instance.dispatch({type:'ready'});
  h.setInstaller(async()=>{throw Error('configured PATH is invalid');});
  await h.instance.dispatch({type:'installCloudflared',path:'/broken/cloudflared',channelMode:'cloudflare'});
  const result=h.panels[0].messages.find(m=>m.type==='cloudflaredInstallResult');
  assert.match(result.error,/PATH is invalid/);assert.equal(result.path,undefined);
  assert.equal(result.previousPath,'/broken/cloudflared');
  assert.equal(h.settingsWrites.length,0);assert.equal(h.restarts,0);assert.equal(h.tunnelCalls.length,0);
});

test('duplicate install messages share one operation and disposed panels receive no late writes', async () => {
  const h=harness();await h.instance.dispatch({type:'ready'});
  const pending=deferred();h.setInstaller(()=>pending.promise);
  const message={type:'installCloudflared',path:'',channelMode:'cloudflare'};
  const first=h.instance.dispatch(message);await settle();
  await h.instance.dispatch(message);assert.equal(h.installCalls.length,1);
  h.panels[0].close();pending.resolve({path:'/fixture/cloudflared',installed:true});
  await assert.doesNotReject(first);assert.equal(h.settingsWrites.length,0);
  assert.equal(h.restarts,0);assert.equal(h.tunnelCalls.length,0);assert.equal(h.errors.length,0);
});

function installBrowser(h) {
  const html=h.panels[0].webview.html, messages=[];
  const modes=[{disabled:false},{disabled:false}];
  const nodes={
    cfInstall:{disabled:false,textContent:'一键初始化安装',style:{display:''},addEventListener(_,fn){this.click=fn;}},
    cfInstallMessage:{textContent:'',className:'hint',style:{display:''}},
    cloudflaredPath:{value:'',disabled:false,addEventListener(_,fn){this.input=fn;}},
    save:{disabled:false},
  };
  const context=vm.createContext({$:id=>nodes[id],channelMode:'cloudflare',cloudflaredInstalling:false,
    document:{querySelectorAll:()=>modes},vs:{postMessage:m=>messages.push(m)}});
  vm.runInContext(html.slice(html.indexOf('    function syncCloudflaredInstallVisibility()'),html.indexOf('    function resetCustomProbe()')),context);
  vm.runInContext(html.slice(html.indexOf("    $('cloudflaredPath').addEventListener("),html.indexOf('    const requireCloudflaredPath=')),context);
  return {html,nodes,messages,context,modes};
}

test('install stays inside the existing Cloudflare card with an editable path and no progress bar', t => {
  const h=harness();t.after(()=>h.panels[0].close());const b=installBrowser(h);
  const start=b.html.indexOf('id="channelCloudflare"'),install=b.html.indexOf('id="cfInstall"'),custom=b.html.indexOf('id="channelCustom"');
  assert.ok(start<install&&install<custom);
  const input=b.html.match(/<input[^>]*id="cloudflaredPath"[^>]*>/)?.[0];assert.ok(input);
  assert.doesNotMatch(input,/readonly|disabled/);assert.doesNotMatch(b.html,/<progress\b|role="progressbar"/);
  for(const match of b.html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g))assert.doesNotThrow(()=>new vm.Script(match[1]));
  for(const id of ['cnQuick','cnNamed','cnStop','cnCopy','customProbe','publicBaseUrl'])assert.ok(b.html.includes('id="'+id+'"'));
  assert.equal(b.messages.length,0);
  b.context.channelMode='custom';b.nodes.cfInstall.click();assert.equal(b.messages.length,0);
  b.context.channelMode='cloudflare';b.nodes.cfInstall.click();b.nodes.cfInstall.click();
  assert.equal(b.messages.length,1);assert.equal(b.messages[0].type,'installCloudflared');
  assert.equal(b.nodes.cfInstall.disabled,true);
  b.context.onCloudflaredInstallResult({previousPath:'',path:'/fixture/cloudflared',installed:true});
  assert.equal(b.nodes.cloudflaredPath.value,'/fixture/cloudflared');assert.equal(b.nodes.cfInstall.disabled,false);
  assert.equal(b.nodes.cfInstall.style.display,'none');assert.equal(b.nodes.cfInstallMessage.style.display,'none');
  assert.match(b.nodes.cfInstallMessage.textContent,/保存设置/);assert.match(b.nodes.cfInstallMessage.textContent,/尚未启动/);
  assert.equal(b.messages.length,1); // No automatic save or tunnel start.
});

test('one-click initialization is shown only while the cloudflared path is empty', t => {
  const h=harness();t.after(()=>h.panels[0].close());const b=installBrowser(h);
  b.context.syncCloudflaredInstallVisibility();
  assert.equal(b.nodes.cfInstall.style.display,'');
  assert.equal(b.nodes.cfInstallMessage.style.display,'');
  b.nodes.cloudflaredPath.value='C:\\Users\\fixture\\cloudflared.exe';
  b.nodes.cloudflaredPath.input();
  assert.equal(b.nodes.cfInstall.style.display,'none');
  assert.equal(b.nodes.cfInstallMessage.style.display,'none');
  b.nodes.cloudflaredPath.value='   ';
  b.nodes.cloudflaredPath.input();
  assert.equal(b.nodes.cfInstall.style.display,'');
  assert.equal(b.nodes.cfInstallMessage.style.display,'');
});

test('install replies preserve user edits, mode switches and failed paths', t => {
  const h=harness();t.after(()=>h.panels[0].close());const b=installBrowser(h);
  b.nodes.cloudflaredPath.value='/user/edited';
  b.context.onCloudflaredInstallResult({previousPath:'',path:'/download/cloudflared',installed:true});
  assert.equal(b.nodes.cloudflaredPath.value,'/user/edited');assert.match(b.nodes.cfInstallMessage.textContent,/未自动回填/);
  b.nodes.cloudflaredPath.value='';b.context.channelMode='custom';
  b.context.onCloudflaredInstallResult({previousPath:'',path:'/download/cloudflared',installed:true});
  assert.equal(b.nodes.cloudflaredPath.value,'');assert.equal(b.messages.length,0);
  b.context.channelMode='cloudflare';b.nodes.cloudflaredPath.value='/broken/cloudflared';
  b.context.onCloudflaredInstallResult({previousPath:'/broken/cloudflared',error:'invalid path'});
  assert.equal(b.nodes.cloudflaredPath.value,'/broken/cloudflared');assert.equal(b.nodes.cfInstallMessage.textContent,'invalid path');
  b.nodes.cloudflaredPath.value='';b.context.channelMode='cloudflare';
  b.context.onCloudflaredInstallResult({previousPath:'',path:'/saved/cloudflared',installed:true,saved:true,restarted:true});
  assert.equal(b.nodes.cloudflaredPath.value,'/saved/cloudflared');assert.match(b.nodes.cfInstallMessage.textContent,/已保存.*已重启/);
});

test('saved cloudflared paths hide initialization controls even when daemon restart fails', t => {
  const h=harness();t.after(()=>h.panels[0].close());const b=installBrowser(h);
  b.context.onCloudflaredInstallResult({previousPath:'',path:'/saved/cloudflared',installed:true,saved:true,error:'daemon restart failed'});
  assert.equal(b.nodes.cloudflaredPath.value,'/saved/cloudflared');
  assert.equal(b.nodes.cfInstall.style.display,'none');assert.equal(b.nodes.cfInstallMessage.style.display,'none');
  assert.match(b.nodes.cfInstallMessage.textContent,/路径已保存，但应用失败/);assert.match(b.nodes.cfInstallMessage.textContent,/restart failed/);
});

test('verification publishes the waiting state before its modal and only applies after consent', async t => {
  const h=harness();t.after(()=>h.panels[0].close());await h.instance.dispatch({type:'ready'});
  const consent=deferred();h.infoReplies.push(consent.promise);
  h.setInstaller(async()=>({path:'/fixture/cloudflared',installed:false}));
  const pending=h.instance.dispatch({type:'installCloudflared',path:'',channelMode:'cloudflare'});
  await settle();
  assert.equal(h.panels[0].messages.at(-1).phase,'confirming');
  assert.equal(h.infoDialogs.at(-1)[0].modal,true);
  assert.match(h.infoDialogs.at(-1)[0].detail,/fixture\/cloudflared/);
  assert.equal(h.settingsWrites.length,0);assert.equal(h.restarts,0);
  consent.resolve('保存并重启');await pending;
  assert.ok(h.panels[0].messages.some(m=>m.phase==='applying'));
  assert.equal(h.panels[0].messages.at(-1).restarted,true);
});

test('path, mode and save controls are locked only until installation/confirmation settles', t => {
  const h=harness();t.after(()=>h.panels[0].close());const b=installBrowser(h);
  b.nodes.cfInstall.click();
  assert.equal(b.nodes.cloudflaredPath.disabled,true);assert.equal(b.nodes.save.disabled,true);
  assert.ok(b.modes.every(m=>m.disabled));
  b.context.onCloudflaredInstallResult({phase:'confirming'});
  assert.match(b.nodes.cfInstallMessage.textContent,/验证通过，等待确认/);
  assert.equal(b.nodes.cfInstall.disabled,true);
  b.context.onCloudflaredInstallResult({phase:'applying'});
  assert.match(b.nodes.cfInstallMessage.textContent,/正在保存路径并重启/);
  b.context.onCloudflaredInstallResult({previousPath:'',error:'failure'});
  assert.equal(b.nodes.cloudflaredPath.disabled,false);assert.equal(b.nodes.save.disabled,false);
  assert.ok(b.modes.every(m=>!m.disabled));assert.equal(b.nodes.cfInstall.disabled,false);
});

test('changed persisted mode or path cannot be overwritten by an old confirmation', async t => {
  for(const [key,value] of [['channelMode','custom'],['cloudflaredPath','/new/user/path']]) {
    const h=harness();t.after(()=>h.panels[0].close());await h.instance.dispatch({type:'ready'});
    const consent=deferred();h.infoReplies.push(consent.promise);
    h.setInstaller(async()=>({path:'/old/result',installed:true}));
    const pending=h.instance.dispatch({type:'installCloudflared',path:'',channelMode:'cloudflare'});
    await settle();h.settings[key]=value;consent.resolve('保存并重启');await pending;
    assert.equal(h.settingsWrites.length,0);assert.equal(h.restarts,0);
    assert.match(h.panels[0].messages.at(-1).error,/配置已变化/);
    assert.equal(h.settings[key],value);
  }
});

test('an active custom configuration permits draft-only installation without restart', async t => {
  const h=harness();t.after(()=>h.panels[0].close());await h.instance.dispatch({type:'ready'});
  h.settings.channelMode='custom';h.setInstaller(async()=>({path:'/fixture/cloudflared',installed:true}));
  await h.instance.dispatch({type:'installCloudflared',path:'',channelMode:'cloudflare'});
  assert.equal(h.infoDialogs.length,0);assert.equal(h.settingsWrites.length,0);assert.equal(h.restarts,0);
  assert.match(h.panels[0].messages.at(-1).note,/自定义渠道/);
});

test('closing the panel before or during confirmation prevents later settings writes', async () => {
  for(const stage of ['download','confirm']) {
    const h=harness();await h.instance.dispatch({type:'ready'});const wait=deferred();
    h.setInstaller(()=>stage==='download'?wait.promise:Promise.resolve({path:'/fixture/cloudflared',installed:true}));
    if(stage==='confirm')h.infoReplies.push(wait.promise);
    const pending=h.instance.dispatch({type:'installCloudflared',path:'',channelMode:'cloudflare'});
    await settle();h.panels[0].close();
    wait.resolve(stage==='download'?{path:'/fixture/cloudflared',installed:true}:'保存并重启');
    await pending;assert.equal(h.settingsWrites.length,0);assert.equal(h.restarts,0);
    if(stage==='download')assert.equal(h.infoDialogs.length,0);
  }
});

test('restart rejection preserves the saved path and reports a partial failure', async t => {
  const h=harness();t.after(()=>h.panels[0].close());await h.instance.dispatch({type:'ready'});
  h.setInstaller(async()=>({path:'/fixture/cloudflared',installed:false}));h.infoReplies.push('保存并重启');
  h.daemon.restart=async()=>{throw Error('restart refused');};
  await h.instance.dispatch({type:'installCloudflared',path:'',channelMode:'cloudflare'});
  const result=h.panels[0].messages.at(-1);
  assert.equal(result.saved,true);assert.equal(result.path,'/fixture/cloudflared');
  assert.match(result.error,/restart refused/);assert.equal(h.tunnelCalls.length,0);
  const b=installBrowser(h);b.context.onCloudflaredInstallResult(result);
  assert.match(b.nodes.cfInstallMessage.textContent,/路径已保存，但应用失败/);
  assert.equal(b.nodes.cloudflaredPath.value,'/fixture/cloudflared');
});

test('settings panel hides daemon entry only for production, preserving cloudflared',()=>{
 for(const environment of ['production','test']){
  const h=harness({environment,origin:'https://blackhole.stellarbridge.dpdns.org'}),html=h.panels[0].webview.html;
  assert.equal(html.includes('自定义本地服务入口（开发用）'),environment==='test');
  assert.ok(html.includes('cloudflared 路径'));h.panels[0].close();
 }
});
test('activity intensity uses fixed thousand-call bands and explicit theme palettes', () => {
  const source = fs.readFileSync(new URL('../src/configPanel.ts', import.meta.url), 'utf8');
  const fn = /function activityCallLevel\(total\) \{[\s\S]*?\n    \}/.exec(source)?.[0];
  assert.ok(fn);const level=vm.runInNewContext('('+fn+')');
  for(const [count,expected] of [[0,0],[1,1],[480,1],[999,1],[1000,2],[1999,2],[2000,3],[2999,3],[3000,4],[4000,4],[1000000,4]])assert.equal(level(count),expected);
  for(const color of ['#0e4429','#006d32','#26a641','#39d353','#9be9a8','#40c463','#30a14e','#216e39'])assert.ok(source.includes(color));
  assert.ok(!source.includes('颜色档位：'));assert.ok(source.includes('body.vscode-high-contrast-light'));
  assert.ok(source.includes("cell.dataset.level !== level"));
});
test('activity snapshots are sorted, deduplicated and bounded before rendering', () => {
  const source=fs.readFileSync(new URL('../src/configPanel.ts',import.meta.url),'utf8');
  const fn=/function normalizeActivityDays\(inputDays\) \{[\s\S]*?\n    \}/.exec(source)?.[0];assert.ok(fn);
  const normalize=vm.runInNewContext('('+fn+')',{usageNumber:x=>typeof x==='number'&&Number.isSafeInteger(x)&&x>=0?x:0});
  const rows=Array.from({length:9},(_,i)=>({start:i*86400000,total:i})).reverse();
  const got=JSON.parse(JSON.stringify(normalize([...rows,null,{start:NaN},{start:1e20},{start:8*86400000,total:999,diff_added:-1}])));
  assert.deepEqual(got.map(d=>d.start),[2,3,4,5,6,7,8].map(d=>d*86400000));
  assert.equal(got.at(-1).total,999);assert.equal(got.at(-1).added,0);
  assert.equal(normalize(null).length,0);assert.ok(source.includes('grid.insertBefore(cell, grid.children[index] || null)'));
});
test('activity omits the legend but preserves level colors, keyboard access and narrow layout', () => {
  const h=harness(),html=h.panels[0].webview.html;
  assert.match(html,/class="activity-track"/);
  assert.doesNotMatch(html,/activity-legend|activity-swatch|颜色档位|颜色由少到多/);
  assert.ok(html.includes('aria-label="最近 7 天活动"'));
  for(let i=1;i<=4;i++)assert.ok(html.includes('.activity-cell[data-level="'+i+'"] { background:var(--activity-'+i+'); }'));
  assert.ok(html.includes('#activity .activity-cell { width:12px; height:12px; }'));
  assert.ok(html.includes('flex-wrap:wrap'));assert.ok(html.includes('.activity-cell:focus-visible'));
  assert.ok(html.includes("activityCells.get(key)"));assert.ok(html.includes("if (signature === activitySignature) return;"));
  h.panels[0].close();
});
test('activity tooltip renders exact counts without bands and retains hover, focus, Escape and live updates',()=>{
 const h=harness(),html=h.panels[0].webview.html;
 class Node {
  constructor(){this.children=[];this.dataset={};this.attributes={};this.events={};this.style={};this.hidden=true;this.isConnected=true;this.textContent='';this.offsetWidth=200;this.offsetHeight=80;}
  setAttribute(k,v){this.attributes[k]=v;}getAttribute(k){return this.attributes[k];}
  addEventListener(k,fn){this.events[k]=fn;}appendChild(n){this.children.push(n);}
  insertBefore(n,before){this.children=this.children.filter(c=>c!==n);this.children.splice(before?this.children.indexOf(before):this.children.length,0,n);}
  getBoundingClientRect(){return {left:20,top:20,bottom:34};}
 }
 const nodes=new Map(['activity','activityToday','activityGrid','activityTooltip'].map(id=>[id,new Node()]));
 const document={createElement:()=>new Node(),activeElement:null},events={};
 const context=vm.createContext({$:id=>nodes.get(id),document,window:{innerWidth:800,innerHeight:600,addEventListener:(k,fn)=>{events[k]=fn;}}});
 const script=html.slice(html.indexOf('    const activityCells ='),html.indexOf('    let lastStatus ='));
 vm.runInContext(script,context);
 const start=new Date(2026,8,19).getTime(),stats={total:1234,diff_added:120,diff_removed:35};
 context.renderActivity(stats,[{start,...stats}]);
 const cell=nodes.get('activityGrid').children[0],tip=nodes.get('activityTooltip');
 const label='2026年9月19日\n1234 次工具调用\n+120 / −35 行';
 assert.equal(cell.getAttribute('aria-label'),label);assert.equal(cell.dataset.level,'2');
 cell.events.mouseenter();assert.equal(tip.hidden,false);assert.equal(tip.textContent,label);
 cell.events.mouseleave();assert.equal(tip.hidden,true);
 document.activeElement=cell;cell.events.focus();assert.equal(tip.textContent,label);assert.equal(tip.hidden,false);
 cell.events.keydown({key:'Escape'});assert.equal(tip.hidden,true);
 cell.events.click();assert.equal(tip.hidden,false);
 context.renderActivity({...stats,total:2000},[{start,...stats,total:2000}]);
 assert.equal(nodes.get('activityGrid').children[0],cell);assert.equal(cell.dataset.level,'3');assert.ok(tip.textContent.includes('2000 次工具调用'));assert.ok(!tip.textContent.includes('颜色'));
 context.renderActivity(null,[]);assert.equal(nodes.get('activityGrid').children[0],cell);
 document.activeElement=null;cell.events.blur();assert.equal(tip.hidden,true);events.scroll();assert.equal(tip.hidden,true);
 h.panels[0].close();
});
test('MCP link reset is host-confirmed, rotates once, copies the new URL and reports success', async () => {
  const h = harness(); await h.instance.dispatch({ type: 'rotateToken' }); await settle();
  assert.equal(h.rotateCalls, 1); assert.equal(h.warnings.length, 1);
  assert.deepEqual(h.clipboard, ['https://example.test/mcp/token']);
  assert.ok(h.notices.some(message => message.includes('MCP 链接已重置'))); assert.equal(h.errors.length, 0);
});
test('opening settings is observational: never probes enabled or disabled upstreams', async () => {
  const h = harness(); await h.instance.dispatch({ type: 'ready' }); await settle();
  assert.equal(h.toolCalls.length, 0); h.panels[0].close();
});
test('a late health response cannot access a disposed settings Webview', async () => {
  const h = harness(), waiting = deferred();
  h.api.health = () => waiting.promise;
  const pending = h.instance.dispatch({ type: 'ready' });
  await settle(); h.panels[0].close(); waiting.resolve(h.health);
  await assert.doesNotReject(pending); await settle();
  assert.equal(h.polls.size, 0); assert.equal(h.errors.length, 0);
});
test('a late tool reply or rejection cannot post to a destroyed panel', async () => {
  const h = harness(), waiting = deferred(); await h.instance.dispatch({ type: 'ready' });
  h.api.proxiesTools = () => waiting.promise;
  const pending = h.instance.dispatch({ type: 'proxiesTools', server: 'on', refresh: true });
  await settle(); h.panels[0].close(); waiting.resolve({ daemonId: 'fixture', name: 'on', tools: [] });
  await assert.doesNotReject(pending);
});
test('saving a proxy only reloads its projection, not settings or other upstreams', async () => {
  const h = harness(); await h.instance.dispatch({ type: 'ready' });
  let restart = 0; h.instance.refresh = async () => { restart++; };
  h.api.proxiesEditFields = async () => ({ written: true, report: {} });
  await h.instance.dispatch({ type: 'proxiesEdit', server: 'off', fields: { enabled: true } });
  assert.equal(restart, 0); assert.equal(h.toolCalls.length, 0); h.panels[0].close();
});

test('disabled tool requests are ignored and concurrent enabled requests share one fetch', async () => {
  const h = harness(); await h.instance.dispatch({type:'ready'});
  await h.instance.dispatch({type:'proxiesTools',server:'off',refresh:true});
  assert.equal(h.toolCalls.length,0);
  const waiting=deferred();let reads=0;h.api.proxiesTools=()=>{reads++;return waiting.promise};
  const a=h.instance.dispatch({type:'proxiesTools',server:'on',refresh:true});
  const b=h.instance.dispatch({type:'proxiesTools',server:'on',refresh:true});
  await settle();assert.equal(reads,1);waiting.resolve({name:'on',daemonId:'fixture',tools:[]});
  await Promise.all([a,b]);h.panels[0].close();
});
test('slow polls cannot overlap or revive a closed panel', async () => {
  const h=harness();await h.instance.dispatch({type:'ready'});
  const waiting=deferred();let reads=0;h.api.health=()=>{reads++;return waiting.promise};
  const tasks=Array.from({length:20},()=>h.instance.poll());await settle();assert.equal(reads,1);
  h.panels[0].close();waiting.resolve(h.health);await Promise.all(tasks);assert.equal(h.errors.length,0);
});
test('a rejected fetch after close and a new panel cannot resurrect the old view', async () => {
  const h=harness();await h.instance.dispatch({type:'ready'});let reject;
  h.api.proxiesTools=()=>new Promise((_,r)=>{reject=r});
  const task=h.instance.dispatch({type:'proxiesTools',server:'on',refresh:true});await settle();
  h.panels[0].close();const next=harness();await next.instance.dispatch({type:'ready'});
  const count=next.panels[0].messages.length;reject(Error('fixture transport closed'));
  await assert.doesNotReject(task);assert.equal(next.panels[0].messages.length,count);next.panels[0].close();
});

test('a metadata read started before a write cannot overwrite the acknowledged config', async () => {
  const h=harness();await h.instance.dispatch({type:'ready'});
  const stale=deferred();h.api.proxies=()=>stale.promise;
  const read=h.instance.pushProxies();await settle();
  const fresh={...h.info,surfaceGen:2,disabled:[]};
  h.api.proxiesEditFields=async()=>({written:true,report:{}});
  const write=h.instance.dispatch({type:'proxiesEdit',server:'off',fields:{enabled:true}});await settle();
  const afterAck=h.panels[0].messages.length;h.api.proxies=async()=>fresh;stale.resolve({...h.info,surfaceGen:1});
  await Promise.all([read,write]);
  const projections=h.panels[0].messages.slice(afterAck).filter(x=>x.type==='proxies');
  assert.ok(projections.length>0);assert.ok(projections.every(x=>x.info.surfaceGen===2));h.panels[0].close();
});
test('test builds show a read-only shared-service warning, production has no environment controls', () => {
  for (const [environment, origin, expected] of [
    ['production', 'https://blackhole.stellarbridge.dpdns.org', null],
    ['test', 'https://blackhole.stellarbridge.dpdns.org', '账户、订单及支付不隔离'],
    ['test', 'https://sandbox.blackhole.example.org', '连接构建时指定的测试服务'],
  ]) {
    const h = harness({ environment, origin });
    const html = h.panels[0].webview.html;
    assert.equal(html.includes('id="cloudEnvironment"'), false);
    assert.equal(html.includes('id="cloudTestOrigin"'), false);
    if (expected) assert.ok(html.includes(expected));
    else assert.equal(html.includes('<p class="build-notice">'), false);
    h.panels[0].close();
  }
});

// OpenAI Secure MCP Tunnel (plan §4/§5.1): one-click install, decoupled tabs.
test('OpenAI one-click install saves the verified path without restarting the daemon or starting a channel', async t => {
  const h=harness();t.after(()=>h.panels[0].close());await h.instance.dispatch({type:'ready'});
  assert.equal(h.openaiCalls.length,0,'opening settings never installs');
  const exe='C:\\Users\\u\\.blackhole\\bin\\tunnel-client-runtime\\v0.0.15\\win32-x64\\tunnel-client-runtime.exe';
  h.setOpenaiInstaller(async()=>({path:exe,installed:true,version:'v0.0.15'}));
  await h.instance.dispatch({type:'installOpenaiTunnel',path:'  '});
  assert.deepEqual(h.openaiCalls,['']);
  assert.deepEqual(h.settingsWrites,[['openaiTunnelClientPath',exe,1]]);
  assert.equal(h.restarts,0);assert.equal(h.tunnelCalls.length,0);assert.equal(h.installCalls.length,0,'cloudflared is untouched');
  const result=h.panels[0].messages.findLast(m=>m.type==='openaiInstallResult');
  assert.equal(result.saved,true);assert.equal(result.installed,true);assert.equal(result.version,'v0.0.15');assert.equal(result.path,exe);
  assert.match(h.notices.at(-1),/尚未启动 OpenAI 渠道/);
  // An already-saved identical path is not rewritten.
  h.setOpenaiInstaller(async()=>({path:exe,installed:false,version:'v0.0.15'}));
  await h.instance.dispatch({type:'installOpenaiTunnel',path:exe});
  assert.equal(h.settingsWrites.length,1);
});

test('OpenAI install never overwrites a path changed elsewhere and failures only report an error', async t => {
  const h=harness();t.after(()=>h.panels[0].close());await h.instance.dispatch({type:'ready'});
  h.setOpenaiInstaller(async()=>{h.settings.openaiTunnelClientPath='/other/window/path';return {path:'/fixture/tunnel-client-runtime',installed:true,version:'v0.0.15'};});
  await h.instance.dispatch({type:'installOpenaiTunnel',path:''});
  let result=h.panels[0].messages.findLast(m=>m.type==='openaiInstallResult');
  assert.equal(result.saved,false);assert.match(result.note,/别处变化/);assert.equal(h.settingsWrites.length,0);
  h.settings.openaiTunnelClientPath='';
  h.setOpenaiInstaller(async()=>{throw Error('tunnel-client 校验失败：sha256 不匹配');});
  await h.instance.dispatch({type:'installOpenaiTunnel',path:''});
  result=h.panels[0].messages.findLast(m=>m.type==='openaiInstallResult');
  assert.match(result.error,/sha256/);assert.equal(result.path,undefined);assert.equal(h.settingsWrites.length,0);assert.equal(h.restarts,0);
  // Concurrent clicks share one operation.
  const gate=deferred();let calls=0;
  h.setOpenaiInstaller(async()=>{calls++;await gate.promise;return {path:'/fixture/tunnel-client-runtime',installed:false,version:'v0.0.15'};});
  const a=h.instance.dispatch({type:'installOpenaiTunnel',path:''}),b=h.instance.dispatch({type:'installOpenaiTunnel',path:''});
  gate.resolve();await Promise.all([a,b]);assert.equal(calls,1);
});

test('tabs are views: default channel saves without restart, Tunnel ID rejects URLs, OpenAI card holds install controls', async t => {
  const h=harness();t.after(()=>h.panels[0].close());await h.instance.dispatch({type:'ready'});
  await h.instance.dispatch({type:'save',values:{channelMode:'openai',openaiTunnelId:'tunnel_0123456789abcdef0123456789abcdef'}});
  assert.ok(h.settingsWrites.some(w=>w[0]==='channelMode'&&w[1]==='openai'));
  assert.ok(h.settingsWrites.some(w=>w[0]==='openaiTunnelId'&&w[1]==='tunnel_0123456789abcdef0123456789abcdef'));
  assert.equal(h.restarts,0,'switching tabs or saving OpenAI fields never restarts the daemon');
  const writes=h.settingsWrites.length;
  await h.instance.dispatch({type:'save',values:{channelMode:'openai',openaiTunnelId:'https://api.openai.com/v1/tunnels/x'}});
  assert.equal(h.settingsWrites.length,writes);assert.match(h.errors.at(-1),/Tunnel ID/);
  await h.instance.dispatch({type:'save',values:{channelMode:'openai',openaiTunnelClientPath:'relative/tunnel-client'}});
  assert.equal(h.settingsWrites.length,writes);assert.match(h.errors.at(-1),/绝对路径/);
  const html=h.panels[0].webview.html;
  assert.match(html,/data-channel-mode="openai"/);
  const card=html.slice(html.indexOf('id="channelOpenai"'),html.indexOf('id="channelCustom"'));
  for(const id of ['openaiTunnelClientPath','openaiTunnelId','oaInstall','oaInstallMessage']) assert.ok(card.includes('id="'+id+'"'),id);
  assert.doesNotMatch(card,/runtime-cloudflared/);
  for(const id of ['oaKey','oaKeySave','oaKeyClear','oaStart','oaStop','oaDiag','oaResult']) assert.ok(card.includes('id="'+id+'"'),id);
  assert.deepEqual(card.match(/<input[^>]*type="password"[^>]*>/g).map(x=>/id="(\w+)"/.exec(x)[1]),['oaKey'],'only the Runtime API Key is a password field');
  assert.match(card,/id="oaKey"[^>]*autocomplete="off"/);
  const common=html.slice(html.indexOf('id="channelCustom"'));
  assert.ok(!common.includes('id="openaiTunnelId"'),'OpenAI fields render only in their card');
});

test('OpenAI runtime controls: key goes to the daemon only, start is bound to saved settings and revisions', async t => {
  const h=harness();t.after(()=>h.panels[0].close());await h.instance.dispatch({type:'ready'});
  const ID='tunnel_0123456789abcdef0123456789abcdef',KEY='sk-test-0000000000000000000000000000',CLIENT='C:\\bin\\tunnel-client-runtime.exe';
  const calls=[];const view={status:'off',run_id:null,credential_configured:false,credential_revision:4,pending_restart:false,reason_code:null,reason:null};
  let daemonSettings={revision:7,values:{openaiTunnelId:'',openaiTunnelClientPath:''}};
  h.health.openai_tunnel_api_version=1;h.health.openai_tunnel=view;
  Object.assign(h.api,{
    openaiTunnel:async()=>view,
    settings:async()=>daemonSettings,
    patchSettings:async values=>{calls.push(['patch',values]);daemonSettings={revision:8,values:{...daemonSettings.values,...values}};return daemonSettings;},
    openaiTunnelSetKey:async(...a)=>{calls.push(['key',...a]);view.credential_revision++;view.credential_configured=true;return {credential_configured:true,credential_revision:view.credential_revision,pending_restart:false};},
    openaiTunnelClearKey:async(...a)=>{calls.push(['clear',...a]);return {credential_configured:false,credential_revision:9};},
    openaiTunnelStart:async(...a)=>{calls.push(['start',...a]);view.status='starting';view.run_id='run-1';return {...view};},
    openaiTunnelStop:async(...a)=>{calls.push(['stop',...a]);return {...view,status:'off'};},
  });
  const result=()=>h.panels[0].messages.findLast(m=>m.type==='openaiTunnelResult');
  await h.instance.dispatch({type:'openaiTunnel',action:'saveKey',key:' '+KEY+' '});
  assert.deepEqual(calls.at(-1),['key','fixture',4,KEY]);
  assert.equal(result().ok,true);
  assert.ok(!JSON.stringify(h.panels[0].messages).includes(KEY),'key never echoed to the webview');
  assert.ok(!JSON.stringify(h.settingsWrites).includes(KEY),'key never written to VS Code settings');
  await h.instance.dispatch({type:'openaiTunnel',action:'saveKey',key:'   '});
  assert.equal(result().ok,false);assert.equal(calls.filter(c=>c[0]==='key').length,1);
  h.settings.openaiTunnelId=ID;h.settings.openaiTunnelClientPath=CLIENT;
  await h.instance.dispatch({type:'openaiTunnel',action:'start',tunnelId:'tunnel_ffffffffffffffffffffffffffffffff',clientPath:CLIENT});
  assert.equal(result().ok,false);assert.match(result().message,/未保存/);
  assert.ok(!calls.some(c=>c[0]==='start'),'unsaved form never starts');
  await h.instance.dispatch({type:'openaiTunnel',action:'start',tunnelId:ID,clientPath:CLIENT});
  assert.deepEqual({...calls.find(c=>c[0]==='patch')[1]},{openaiTunnelId:ID,openaiTunnelClientPath:CLIENT},'daemon settings aligned first');
  assert.deepEqual(calls.at(-1),['start','fixture',8,5],'bound to the new settings revision and current credential revision');
  assert.equal(result().ok,true);
  await h.instance.dispatch({type:'openaiTunnel',action:'stop'});
  assert.deepEqual(calls.at(-1),['stop','fixture','run-1'],'stop names the run it saw');
  h.api.openaiTunnelStart=async()=>{const e=Error('already_running');e.status=409;throw e;};
  await h.instance.dispatch({type:'openaiTunnel',action:'start'});
  assert.match(result().message,/先停止/);
  view.reason_code='auth_failed';view.reason='OpenAI 拒绝了 Runtime API Key（401）';
  h.api.openaiTunnelStart=async()=>{throw Error('auth_failed');};
  await h.instance.dispatch({type:'openaiTunnel',action:'start'});
  assert.equal(result().message,view.reason,'unknown codes show the daemon reason');
  await h.instance.dispatch({type:'openaiTunnel',action:'clearKey'});
  assert.ok(h.warnings.some(w=>/清除 Runtime API Key/.test(w)),'clearing asks first');
  assert.ok(!calls.some(c=>c[0]==='clear'),'declined confirmation deletes nothing');
  delete h.health.openai_tunnel;
  await h.instance.dispatch({type:'openaiTunnel',action:'start'});
  assert.match(result().message,/重启 daemon/);
  assert.equal(h.restarts,0,'OpenAI controls never restart the daemon');
});

test('OpenAI start: a Tunnel ID changed in Web settings is never overwritten by the stale VS Code copy', async t => {
  const h=harness();t.after(()=>h.panels[0].close());await h.instance.dispatch({type:'ready'});
  const OLD='tunnel_'+'a'.repeat(32),NEW='tunnel_'+'b'.repeat(32),CLIENT='C:\\bin\\tunnel-client-runtime.exe',EDIT='D:\\rt\\tunnel-client-runtime.exe';
  const calls=[];const view={status:'off',run_id:null,credential_configured:true,credential_revision:4,pending_restart:false,reason_code:null,reason:null};
  const daemonSettings={revision:9,values:{openaiTunnelId:NEW,openaiTunnelClientPath:CLIENT}};
  h.health.openai_tunnel_api_version=1;h.health.openai_tunnel=view;
  Object.assign(h.api,{
    openaiTunnel:async()=>view,
    settings:async()=>daemonSettings,
    patchSettings:async(values,rev)=>{calls.push(['patch',values,rev]);return daemonSettings;},
    openaiTunnelStart:async(...a)=>{calls.push(['start',...a]);return {...view};},
  });
  // What this window last pulled from the daemon, before Web settings saved NEW.
  const baseline={openaiTunnelId:OLD,openaiTunnelClientPath:CLIENT};
  h.instance.settingsSync={
    flush:async()=>{calls.push(['flush']);},
    baseline:()=>baseline,
    sync:async()=>{calls.push(['sync']);Object.assign(baseline,daemonSettings.values);Object.assign(h.settings,daemonSettings.values);},
  };
  h.settings.openaiTunnelId=OLD;h.settings.openaiTunnelClientPath=CLIENT;
  const result=()=>h.panels[0].messages.findLast(m=>m.type==='openaiTunnelResult');
  await h.instance.dispatch({type:'openaiTunnel',action:'start',tunnelId:OLD,clientPath:CLIENT});
  assert.equal(result().ok,false);assert.match(result().message,/别处/);
  assert.deepEqual(calls.map(c=>c[0]),['flush','sync'],'stale copy: no patch, no start');
  assert.equal(h.settings.openaiTunnelId,NEW,'the daemon value is taken into VS Code');
  await h.instance.dispatch({type:'openaiTunnel',action:'start',tunnelId:NEW,clientPath:CLIENT});
  assert.equal(result().ok,true);
  assert.deepEqual(calls.at(-1),['start','fixture',9,4],'confirmed value starts on the daemon revision');
  assert.ok(!calls.some(c=>c[0]==='patch'));
  // A real edit made in this window (differs from the baseline) is still written, bound to the revision checked.
  h.settings.openaiTunnelClientPath=EDIT;
  await h.instance.dispatch({type:'openaiTunnel',action:'start',tunnelId:NEW,clientPath:EDIT});
  const patch=calls.find(c=>c[0]==='patch');
  assert.deepEqual([patch[0],{...patch[1]},patch[2]],['patch',{openaiTunnelClientPath:EDIT},9]);
});

test('OpenAI connection card: saved Tunnel ID shown and copied offline, fixed onboarding links only', async t => {
  const h=harness();t.after(()=>h.panels[0]?.close());const opened=[],TID='tunnel_0123456789abcdef0123456789abcdef';
  h.vscode.env.openExternal=async u=>{opened.push(u);return true;};h.vscode.Uri={parse:s=>({href:s})};
  await h.instance.dispatch({type:'copyTunnelId'});
  assert.deepEqual(h.clipboard,[]);assert.match(h.warnings.at(-1),/尚未保存 Tunnel ID/);
  h.settings.openaiTunnelId='tunnel_'+'a'.repeat(32);h.api.health=async()=>{throw Error('offline');};
  await h.instance.dispatch({type:'copyTunnelId'});
  assert.deepEqual(h.clipboard,[],'unreachable daemon must not copy a stale VS Code mirror');
  assert.match(h.warnings.at(-1),/无法确认 daemon/);
  const routes={saved_tunnel_id:TID,selected_route:'openai',preferred_mcp_url:null,connector_kind:null,reason:'openai_selected',openai:'off'};
  h.api.health=async()=>({...h.health,connection_routes:routes,openai_tunnel:{status:'off',active_tunnel_id:null}});
  await h.instance.dispatch({type:'copyTunnelId'});
  assert.deepEqual(h.clipboard,[TID],'stopped runtime copies the current daemon-owned ID, not its mirror');
  await h.instance.dispatch({type:'ready'});await settle();await settle();
  const overview=h.panels[0].messages.map(m=>m.overview).filter(Boolean).at(-1);
  assert.equal(overview.openai_tunnel_id,TID);
  routes.saved_tunnel_id=null;
  await h.instance.dispatch({type:'copyTunnelId'});
  assert.deepEqual(h.clipboard,[TID],'clearing the daemon ID must not resurrect the mirror');
  for(const target of ['platform','chatgpt','constructor','__proto__','https://evil.example'])await h.instance.dispatch({type:'openLink',target});
  assert.deepEqual(opened.map(u=>u.href),['https://platform.openai.com/settings/organization/tunnels','https://chatgpt.com/plugins']);
  const html=h.panels[0].webview.html;
  for(const id of ['mcpSec','oaLinkPlatform','oaLinkChatgpt'])assert.ok(html.includes('id="'+id+'"'),id);
  const card=html.slice(html.indexOf('id="channelOpenai"'),html.indexOf('id="channelCustom"'));
  assert.match(card,/Tunnels Read\/Use/);assert.match(card,/不支持沙箱直连/);
});

// 用户 2026-10-03：不需要重启 daemon 的设置自动保存，会重启的仍由「保存」按钮提交。
test('autosave writes only no-restart settings, quietly, without re-sending the form', async t => {
  const h=harness();t.after(()=>h.panels[0].close());await h.instance.dispatch({type:'ready'});
  const before=h.panels[0].messages.length;
  await h.instance.dispatch({type:'autosave',values:{channelMode:'cloudflare',connectorName:' Mine ',pollIntervalMs:'1500',publicBaseUrl:'https://evil.example',cloudflaredPath:'/x',port:'9'}});
  assert.deepEqual(h.settingsWrites,[['channelMode','cloudflare',1],['connectorName','Mine',1],['pollIntervalMs',1500,1]]);
  assert.equal(h.restarts,0);assert.deepEqual(h.notices,[]);assert.deepEqual(h.errors,[]);
  const sent=h.panels[0].messages.slice(before);
  assert.equal(sent.some(m=>m.type==='init'),false,'other fields being edited are not overwritten');
  // 面板代码跑在 vm 沙箱里，数组原型不同：经 JSON 比较结构。
  assert.deepEqual(JSON.parse(JSON.stringify(sent.at(-1))),{type:'autosaved',ok:true,keys:['channelMode','connectorName','pollIntervalMs'],values:{channelMode:'cloudflare',connectorName:'Mine',pollIntervalMs:1500},message:'已自动保存'});
  h.settingsWrites.length=0;
  await h.instance.dispatch({type:'autosave',values:{channelMode:'cloudflare'}});
  assert.equal(h.settingsWrites.length,0,'unchanged values are not rewritten');
  assert.equal(h.panels[0].messages.at(-1).message,'');
});

test('autosave rejects invalid values with an inline message and writes nothing for them', async t => {
  const h=harness();t.after(()=>h.panels[0].close());await h.instance.dispatch({type:'ready'});
  await h.instance.dispatch({type:'autosave',values:{openaiTunnelId:'https://platform.openai.com/x',openaiTunnelClientPath:'relative/tunnel.exe',pollIntervalMs:'10'}});
  assert.equal(h.settingsWrites.length,0);
  const last=h.panels[0].messages.at(-1);
  assert.equal(last.type,'autosaved');assert.equal(last.ok,false);assert.match(last.message,/未保存/);
  await h.instance.dispatch({type:'autosave',values:{},webAgents:['ChatGPT']});
  assert.equal(h.panels[0].messages.at(-1).ok,true);
});

test('auto-saved settings never restart the daemon; restart settings are marked and stay on the Save button', t => {
  const source=fs.readFileSync(new URL('../src/configPanel.ts',import.meta.url),'utf8');
  const auto=JSON.parse(source.match(/const AUTO_SAVE_KEYS = new Set\((\[[^\]]*\])\)/)[1].replace(/'/g,'"'));
  const restart=JSON.parse(source.match(/const RESTART_KEYS = new Set\((\[[^\]]*\])\)/)[1].replace(/'/g,'"'));
  assert.deepEqual(auto.filter(k=>restart.includes(k)),[]);
  // daemon 启动指纹里的设置一变就会自动重启 daemon：自动保存的设置一个都不能在里面。
  const dm=fs.readFileSync(new URL('../src/daemonManager.ts',import.meta.url),'utf8');
  const fp=dm.slice(dm.indexOf('private fingerprint('),dm.indexOf('private async liveFingerprintMatches'));
  for(const k of auto)assert.doesNotMatch(fp,new RegExp('\\bc\\.'+k+'\\b'),k);
  const h=harness();t.after(()=>h.panels[0].close());
  const html=h.panels[0].webview.html;
  for(const k of ['cloudflaredPath','publicBaseUrl','skillsDir'])assert.match(html,new RegExp('<label for="'+k+'">[^<]+<span class="rs"[^>]*>需重启</span></label><input id="'+k+'"'),k);
  assert.doesNotMatch(html,/<label for="connectorName">连接器名称<span class="rs"/);
  assert.match(html,/id="autoNote"/);
  assert.match(html,/if \(channelMode !== before\) \{ channelDraftPending = true; autosave\(\{ channelMode \}\); \}/);
  assert.match(html,/el\.classList\.toggle\('on'\); autosave\(\{\}, collectWebAgents\(\)\)/);
  for(const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g))assert.doesNotThrow(()=>new vm.Script(match[1]));
});

function directHarness(t) {
  const h = harness(); t.after(() => h.panels[0].close());
  let revision = 4;
  let values = { directAccessEnabled:false, directPort:7307, directAccessUrl:'', channelProxyUrl:'', aiDefaultRoute:'auto' };
  const patches = [];
  h.api.settings = async () => ({ revision, values: { ...values } });
  h.api.patchSettings = async (patch, expected) => {
    assert.equal(expected, revision);
    patches.push([JSON.parse(JSON.stringify(patch)), expected]); values = { ...values, ...patch }; revision++;
    return { revision, values: { ...values } };
  };
  h.health.direct_access = { enabled:false, port:7307, listening:false, state:'off', mode:'off', origin:null, proxy_origin:null, bind_host:null, target:'http://127.0.0.1:7307', addresses:[], error:null };
  return { h, patches, get values(){ return values; }, edit(patch){ values = { ...values, ...patch }; revision++; } };
}

test('direct advertised URL is saved without enabling; status uses only canonical fields', async t => {
  const { h, patches } = directHarness(t);
  await h.instance.dispatch({type:'ready'});
  await h.instance.dispatch({type:'directAccessUrl',url:' https://mcp.example.test '});
  assert.deepEqual(patches, [[{directAccessUrl:'https://mcp.example.test'},4]]);
  const frame = h.panels[0].messages.findLast(m => m.type === 'directAccess');
  assert.equal(frame.on, false); assert.equal(frame.url, 'https://mcp.example.test'); assert.equal(frame.port, 7307);
  assert.doesNotMatch(h.panels[0].webview.html, /lanAccess|lanUrl|publicDirectEnabled|directGatewayUrl/);
  assert.equal(h.restarts, 0); assert.equal(h.tunnelCalls.length, 0);
});

test('one direct switch accepts empty/HTTP/HTTPS and disables without discarding the address', async t => {
  const d = directHarness(t), { h, patches } = d;
  await h.instance.dispatch({type:'directAccessToggle',on:true,url:'ftp://fixture.example'});
  assert.equal(patches.length, 0); assert.match(h.warnings.at(-1), /HTTP\(S\)/);
  for (const url of ['', 'http://public.example.test:7307', 'https://public.example.test']) {
    h.warningReplies.push('开启');
    await h.instance.dispatch({type:'directAccessToggle',on:true,url});
    assert.deepEqual(patches.at(-1)[0], {directAccessEnabled:true,directAccessUrl:url});
    await h.instance.dispatch({type:'directAccessToggle',on:false});
    assert.deepEqual(patches.at(-1)[0], {directAccessEnabled:false});
    assert.equal(d.values.directAccessUrl,url);
  }
  assert.match(h.warnings.find(x => x.includes('开启直连')), /手机扫码后仍须在电脑上允许/);
  assert.equal(h.restarts,0); assert.equal(h.settingsWrites.length,0);
});

test('direct confirmation cancellation, duplicate clicks and changed settings cannot write unexpectedly', async t => {
  const d = directHarness(t), { h, patches } = d;
  h.warningReplies.push(undefined);
  await h.instance.dispatch({type:'directAccessToggle',on:true,url:''}); assert.equal(patches.length,0);
  const wait = deferred(); h.warningReplies.push(wait.promise);
  const operation = h.instance.dispatch({type:'directAccessToggle',on:true,url:'https://draft.example'});
  await settle();
  await h.instance.dispatch({type:'directAccessToggle',on:true,url:'https://duplicate.example'});
  d.edit({directAccessUrl:'https://external.example'}); wait.resolve('开启'); await operation;
  assert.equal(patches.length,0); assert.equal(d.values.directAccessUrl,'https://external.example');
  assert.match(h.warnings.at(-1),/已在别处修改/);
});

test('direct confirmation cannot save after the settings panel is closed', async t => {
  const { h, patches } = directHarness(t); const wait = deferred(); h.warningReplies.push(wait.promise);
  const operation = h.instance.dispatch({type:'directAccessToggle',on:true,url:''});
  await settle(); h.panels[0].close(); wait.resolve('开启'); await operation;
  assert.equal(patches.length,0);
});

test('canonical setting writes serialize, apply only their fields and preserve conflicts', async t => {
  const { h, patches } = directHarness(t);
  await h.instance.dispatch({type:'ready'});
  await Promise.all([h.instance.dispatch({type:'directPort',port:8307}),h.instance.dispatch({type:'aiDefaultRoute',route:'cloudflare'})]);
  assert.deepEqual(patches.map(x => x[0]), [{directPort:8307},{aiDefaultRoute:'cloudflare'}]);
  assert.deepEqual(patches.map(x => x[1]),[4,5]);
  assert.equal(h.restarts,0);
  let calls = 0;
  h.api.patchSettings = async () => { calls++; throw Error('invalid_input'); };
  await h.instance.dispatch({type:'directPort',port:80});
  assert.equal(calls,1,'validation errors are not retried');
  assert.equal(h.panels[0].messages.findLast(m => m.type === 'directSaveState').state,'error');
});

test('confirmed direct enable never rebases over a revision changed after confirmation', async t => {
  const d = directHarness(t), { h, patches } = d;
  await h.instance.dispatch({type:'ready'});
  let attempts = 0;
  h.api.patchSettings = async () => { attempts++; d.edit({directAccessUrl:'https://concurrent.example'}); throw Error('revision_conflict'); };
  h.warningReplies.push('开启');
  await h.instance.dispatch({type:'directAccessToggle',on:true,url:'https://confirmed.example'});
  assert.equal(attempts,1); assert.equal(patches.length,0);
  assert.equal(d.values.directAccessEnabled,false);
  assert.equal(d.values.directAccessUrl,'https://concurrent.example');
  assert.equal(h.panels[0].messages.findLast(m=>m.type==='directSaveState').state,'error');
});

// 用户 2026-10-03：设置页顶部「渠道」格里的总开关，和侧边栏共用 daemon 的 /channel。
test('cockpit channel switch calls the daemon and reports a missing prerequisite with its code', async t => {
  const h=harness();t.after(()=>h.panels[0].close());
  const view={on:false,state:'off',running:[],next:'quick',last:'quick',missing:null,reason:null};
  const calls=[];h.api.channel=async()=>view;
  h.api.channelSwitch=async(on)=>{calls.push(on);return calls.length===1?{ok:true,view:{...view,on:true,state:'starting',running:['quick']}}:{ok:false,error:'cloudflared'};};
  await h.instance.dispatch({type:'ready'});
  const status=h.panels[0].messages.findLast(m=>m.type==='status'||m.type==='init');
  assert.equal(JSON.parse(JSON.stringify(status.overview.channel)).next,'quick');
  await h.instance.dispatch({type:'channelToggle',on:true});
  let r=JSON.parse(JSON.stringify(h.panels[0].messages.findLast(m=>m.type==='channelToggleResult')));
  assert.deepEqual(r,{type:'channelToggleResult',ok:true,code:'',message:''});
  await h.instance.dispatch({type:'channelToggle',on:true});
  r=JSON.parse(JSON.stringify(h.panels[0].messages.findLast(m=>m.type==='channelToggleResult')));
  assert.equal(r.ok,false);assert.equal(r.code,'cloudflared');assert.match(r.message,/一键初始化安装/);
  assert.deepEqual(calls,[true,true]);
  const html=h.panels[0].webview.html;
  assert.match(html,/<button class="chsw" id="ckSw" type="button" role="switch" aria-checked="false"/);
  assert.match(html,/renderCockpitSwitch\(o\.channel, o\.daemon\)/);
  for(const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g))assert.doesNotThrow(()=>new vm.Script(match[1]));
});
