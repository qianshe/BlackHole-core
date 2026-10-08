import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url), ts = require('typescript');
const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
function load(file, mocks = {}) {
  const module = { exports: {} };
  const js = ts.transpileModule(read(file), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  vm.runInNewContext(js, { module, exports: module.exports, require: name => Object.hasOwn(mocks, name) ? mocks[name] : require(name), URL, console, __filename: fileURLToPath(new URL(file, import.meta.url)) });
  return module.exports;
}
const wire = load('../../contracts/src/settings-host.ts');
const { SettingsHostService } = load('../src/settingsHostService.ts', { '../../contracts/src/settings-host': wire });
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const settle = () => new Promise(r => setImmediate(r));
function services() {
  const calls = [];
  const values = { channelMode: 'cloudflare', cloudflaredPath: '', openaiTunnelClientPath: '' };
  const host = {
    api: {
      settings: async () => ({ revision: 1, values }),
      settingsUiRequest: async (...args) => { calls.push(['native', ...args]); return { ok: true }; },
      installRuntime: async (...args) => { calls.push(['install', ...args]); return { path: '/fixture/runtime', installed: true }; },
      account: async () => ({ state: 'verified', userId: 'daemon-user' }),
      accountCall: async (...args) => { calls.push(['billing', ...args]); return { result: { order: { id: 'fixture-order' }, checkoutUrl: 'https://checkout.example.test/fixture' } }; },
    },
    info: () => ({ kind: 'vscode', environment: 'test', version: '0.3.196', port: 7306, pollIntervalMs: 1000, cloudOrigin: 'https://test.example.test' }),
    saveLocal: async (...args) => { calls.push(['local', ...args]); }, sync: async () => { calls.push(['sync']); },
    restart: async () => { calls.push(['restart']); return true; }, stop: async () => { calls.push(['stop']); },
    copy: async text => { calls.push(['copy', text]); }, open: async url => { calls.push(['open', url]); return true; },
    signIn: async () => { calls.push(['sign-in']); }, signOut: async () => { calls.push(['sign-out']); }, close: () => { calls.push(['close']); },
  };
  const service = new SettingsHostService(host);
  let id = 0;
  const request = (method, path, body) => service.request({ id: 'r' + ++id, method, path, ...(body === undefined ? {} : { body }) });
  return { host, service, calls, values, request };
}

test('settings wire allows only explicit settings routes and constrained queries', () => {
  for (const [method, path] of [['GET', '/panel/health'], ['PATCH', '/settings'], ['GET', '/settings/skills?dir=C%3A%2Ffixture'], ['POST', '/remote/requests/fixture'], ['PUT', '/openai-tunnel/credential'], ['GET', '/account/refundable?cursor=fixture']]) {
    assert.equal(wire.validSettingsRequest({ id: 'fixture', method, path, ...(method === 'GET' ? {} : { body: {} }) }), true, path);
  }
  for (const path of ['/api/health', 'https://evil.test/settings', '//evil.test/settings', '/panel/../shutdown', '/panel/%2e%2e/shutdown', '/panel/%252e/settings', '/panel/settings%2f..', '/exec', '/process', '/courier/send', '/panel/sessions/x/rotate', '/host/info?secret=x', '/settings/skills?dir=a&dir=b', '/settings/skills?url=x', '/settings/skills?dir=%ZZ']) {
    assert.equal(wire.validSettingsRequest({ id: 'fixture', method: 'GET', path }), false, path);
  }
  assert.equal(wire.validSettingsRequest({ id: 'fixture', method: 'GET', path: '/settings', body: {} }), false);
  assert.equal(wire.validSettingsRequest({ id: 'fixture', method: 'PATCH', path: '/settings', body: { x: 'x'.repeat(66000) } }), false);
  assert.equal(wire.validSettingsRequest({ id: 'fixture', method: 'GET', path: '/settings', arbitrary: true }), false);
});

test('opening/reading does not install, save, restart, copy, or sign in', async () => {
  const h = services();
  await h.request('GET', '/host/info');
  assert.deepEqual(plain(await h.request('GET', '/cloudflared/install')), { state: 'idle' });
  await h.request('GET', '/panel/health');
  assert.deepEqual(h.calls, [['native', 'GET', '/panel/health', undefined]]);
});

test('canonical settings write keeps revision and only supplied fields then synchronizes', async () => {
  const h = services();
  const body = { revision: 7, values: { directAccessEnabled: true, directAccessUrl: '' } };
  await h.request('PATCH', '/settings', body);
  assert.deepEqual(h.calls, [['native', 'PATCH', '/settings', body], ['sync']]);
});

test('mutating request IDs are deduplicated; a different payload cannot reuse the ID', async () => {
  const h = services(), wait = deferred();
  h.host.copy = async text => { h.calls.push(['copy', text]); await wait.promise; };
  const body = { id: 'same', method: 'POST', path: '/host/clipboard', body: { text: 'fixture' } };
  const a = h.service.request(body), b = h.service.request(body);
  await assert.rejects(h.service.request({ ...body, body: { text: 'different' } }), /id_reused/);
  wait.resolve(); await Promise.all([a, b]); await h.service.request(body);
  assert.deepEqual(h.calls, [['copy', 'fixture']]);
});

test('restart and stop require explicit confirmation; other paths cannot invoke commands', async () => {
  const h = services();
  await assert.rejects(h.request('POST', '/daemon/restart', {}), /confirmation_required/);
  await assert.rejects(h.request('POST', '/daemon/stop', {}), /confirmation_required/);
  await assert.rejects(h.request('POST', '/commands', { command: 'anything' }), /route_denied/);
  assert.deepEqual(h.calls, []);
  await h.request('POST', '/daemon/restart', { confirm: true });
  assert.deepEqual(h.calls, [['restart']]);
});

test('external links accept HTTP(S) only and never native file/command URLs', async () => {
  const h = services();
  for (const url of ['command:workbench.action.closeWindow', 'file:///secret', 'https://user:secret@example.test', 'javascript:alert(1)']) {
    await assert.rejects(h.request('POST', '/host/external', { url }));
  }
  assert.deepEqual(h.calls, []);
  await h.request('POST', '/host/external', { url: 'https://example.test/help' });
  assert.deepEqual(h.calls, [['open', 'https://example.test/help']]);
});

test('install reserves a job before awaits and never saves settings or starts a channel', async () => {
  const h = services(), wait = deferred();
  h.host.api.installRuntime = async (...args) => { h.calls.push(['install', ...args]); return wait.promise; };
  await Promise.all([h.request('POST', '/cloudflared/install', {}), h.request('POST', '/cloudflared/install', {})]);
  await settle(); assert.equal(h.calls.length, 1);
  assert.equal((await h.request('GET', '/cloudflared/install')).state, 'running');
  wait.resolve({ path: '/fixture/cloudflared', installed: true }); await settle();
  assert.equal((await h.request('GET', '/cloudflared/install')).state, 'done');
  assert.deepEqual(h.calls, [['install', 'cloudflared', '']]);
});

test('custom channel refuses Cloudflare installation without touching runtime', async () => {
  const h = services(); h.values.channelMode = 'custom';
  await h.request('POST', '/cloudflared/install', {}); await settle();
  const job = await h.request('GET', '/cloudflared/install');
  assert.equal(job.state, 'error'); assert.equal(job.error, 'custom_channel'); assert.deepEqual(h.calls, []);
});

test('disposed host cannot start follow-up writes from delayed reads', async () => {
  const h = services(), wait = deferred();
  h.host.api.settings = () => wait.promise;
  await h.request('POST', '/cloudflared/install', {}); h.service.dispose();
  wait.resolve({ revision: 1, values: h.values }); await settle();
  assert.deepEqual(h.calls, []);
  assert.throws(() => h.request('GET', '/host/info'), /settings_closed/);
});

test('a late settings response cannot mirror after disposal', async () => {
  const h = services(), wait = deferred(); h.host.api.settingsUiRequest = () => wait.promise;
  const pending = h.request('PATCH', '/settings', { revision: 1, values: { connectorName: 'fixture' } });
  h.service.dispose(); wait.resolve({}); await assert.rejects(pending, /settings_closed/); assert.deepEqual(h.calls, []);
});

test('billing binds identity to the daemon and rejects non-HTTPS checkout', async () => {
  const h = services();
  await h.request('POST', '/account/orders', { sku: 'pro_day', userId: 'forged' });
  const call = h.calls.find(x => x[0] === 'billing'); assert.equal(call[1], 'createBillingOrder'); assert.equal(call[2][0], 'daemon-user');
  assert.equal(h.calls.filter(x => x[0] === 'open').length, 1);
  h.host.api.accountCall = async () => ({ result: { order: {}, checkoutUrl: 'file:///secret' } });
  await assert.rejects(h.request('POST', '/account/orders', { sku: 'pro_day' }), /checkout_url_rejected/);
  assert.equal(h.calls.filter(x => x[0] === 'open').length, 1);
});

test('host setting updates require both values and an expected baseline', async () => {
  const h = services();
  await assert.rejects(h.request('PATCH', '/host/settings', { port: 7309 }), /invalid_host_setting/);
  await h.request('PATCH', '/host/settings', { values: { port: 7309 }, expected: { port: 7306 } });
  assert.deepEqual(h.calls, [['local', { port: 7309 }, { port: 7306 }]]);
});

test('production entries import one React page tree; legacy HTML is not the command target', () => {
  assert.match(read('../src/extension.ts'), /SharedConfigPanel as ConfigPanel/);
  assert.doesNotMatch(read('../src/sharedConfigPanel.ts'), /currentConnectionSec|renderProxies|<div class="card"/);
  assert.match(read('../../web/src/settings/vscode.tsx'), /import \{ SettingsModal \} from '\.\.\/console\/SettingsModal'/);
  assert.match(read('../../web/src/console/SettingsModal.tsx'), /<SettingsPanel page=\{active\}/);
  assert.match(read('../esbuild.mjs'), /web\/src\/settings\/vscode\.tsx/);
  assert.match(read('../src/sharedConfigPanel.ts'), /connect-src 'none'/);
  const bundlePath = new URL('../dist/extension.js', import.meta.url);
  if (fs.existsSync(bundlePath)) {
    const bundle = fs.readFileSync(bundlePath, 'utf8');
    assert.match(bundle, /shared-react/); assert.doesNotMatch(bundle, /currentConnectionSec|function renderProxies/);
  }
});

function paneHarness(environment = 'test') {
  const h = services(), messages = [], updates = [], memory = new Map();
  const config = { port: 7306, pollIntervalMs: 1000, daemonEntry: '' };
  let closed, receive;
  const uri = value => ({ fsPath: value, toString: () => value });
  const vscode = {
    commands: { executeCommand: async name => { h.calls.push(['command', name]); } },
    ConfigurationTarget: { Global: 1 }, ViewColumn: { One: 1 },
    Uri: { file: uri, joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)), parse: uri },
    env: { clipboard: { writeText: async text => { h.calls.push(['copy', text]); } }, openExternal: async target => { h.calls.push(['open', target.toString()]); return true; } },
    workspace: { getConfiguration: () => ({ get: key => config[key], update: async (key, value) => { updates.push([key, value]); config[key] = value; } }) },
    window: { createWebviewPanel: (...args) => {
      h.paneOptions = args[3];
      return h.pane = { reveal() {}, dispose() { closed?.(); }, onDidDispose(fn) { closed = fn; },
        webview: { cspSource: 'vscode-resource:', html: '', asWebviewUri: value => value, onDidReceiveMessage(fn) { receive = fn; }, postMessage: async value => { messages.push(plain(value)); } } };
    } },
  };
  const { SharedConfigPanel } = load('../src/sharedConfigPanel.ts', {
    vscode, '../package.json': { version: '0.3.196' }, '../../contracts/src/settings-host': wire,
    '../../contracts/src/settings-navigation': { settingsRouteFromLegacy: value => ({ page: ['home','connections','network','agents','security','account','advanced'].includes(value) ? value : 'home' }), normalizeSettingsRoute: value => ({ page: value?.page || 'home' }) },
    './config': { getConfig: () => config }, './cloudEnvironment': { resolveCloudEndpoint: () => ({ environment, origin: 'https://fixture.invalid' }) }, './settingsHostService': { SettingsHostService },
  });
  const pane = new SharedConfigPanel(h.host.api, { restart: async () => true }, { sync: async () => {}, flush: async () => {} }, { get: (key, fallback) => memory.get(key) ?? fallback, update: async (key, value) => { memory.set(key, value); } }, 'network', uri('/fixture/extension'));
  return { ...h, pane, messages, updates, config, memory, receive };
}

test('active native shell ships only local shared resources and handshakes before processing messages', async () => {
  const h = paneHarness();
  assert.deepEqual(h.calls, []); assert.deepEqual(h.messages, []);
  const html = h.pane.pane.webview.html;
  assert.match(html, /data-settings-renderer="shared-react"/);
  assert.match(html, /settings\.css/); assert.match(html, /settings\.js/); assert.match(html, /connect-src 'none'/);
  assert.doesNotMatch(html, /currentConnectionSec|directAccessUrl|sessionId|mcp\/|127\.0\.0\.1/);
  assert.equal(h.paneOptions.localResourceRoots.length, 1);
  await h.pane.receive({ type: 'settings:request', request: { id: 'before', method: 'GET', path: '/panel/health' } });
  assert.deepEqual(h.calls, []);
  await h.pane.receive({ type: 'settings:ready' }); await h.pane.receive({ type: 'settings:ready' });
  assert.deepEqual(h.messages, [{ type: 'settings:init', page: 'network', collapsed: false }]);
  await h.pane.receive({ type: 'settings:state', page: 'account', collapsed: true });
  assert.equal(h.memory.get('blackhole.settingsLastPage.v1'), 'account'); assert.deepEqual(h.calls, []);
});


test('a reloaded renderer gets a fresh handshake and cannot replay the previous document', async () => {
  const h = paneHarness();
  await h.pane.receive({ type: 'settings:ready', clientId: 'documentA' });
  await h.pane.receive({ type: 'settings:state', clientId: 'documentA', page: 'account', collapsed: true });
  await h.pane.receive({ type: 'settings:ready', clientId: 'documentB' });
  const init = h.messages.filter(m => m.type === 'settings:init');
  assert.equal(init.length, 2, 'reloading the browser document must mount the shared renderer again');
  assert.equal(init[1].page, 'account'); assert.equal(init[1].collapsed, true);
  await h.pane.receive({ type: 'settings:request', clientId: 'documentA', request: { id: 'old', method: 'POST', path: '/host/clipboard', body: { text: 'stale' } } });
  assert.deepEqual(h.calls, [], 'messages from the old document cannot perform new actions');
  await h.pane.receive({ type: 'settings:request', clientId: 'documentB', request: { id: 'new', method: 'POST', path: '/host/clipboard', body: { text: 'current' } } });
  assert.deepEqual(h.calls, [['copy', 'current']]);
});

test('failed native restart rejects instead of returning a success-shaped response', async () => {
  const h = services(); h.host.restart = async () => false;
  await assert.rejects(h.request('POST', '/daemon/restart', { confirm: true }), /daemon_restart_failed/);
});

test('local host setting writes are serialized and recheck their expected baseline', async () => {
  const h = services(), wait = deferred(); let current = 7306;
  h.host.saveLocal = async (values, expected) => {
    if (expected.port !== current) throw Error('host_settings_changed');
    h.calls.push(['local', values.port]); await wait.promise; current = values.port;
  };
  const a = h.request('PATCH', '/host/settings', { values: { port: 7309 }, expected: { port: 7306 } });
  const b = h.request('PATCH', '/host/settings', { values: { port: 7310 }, expected: { port: 7306 } });
  const rejected = assert.rejects(b, /host_settings_changed/);
  await settle(); const concurrentWrites = h.calls.length;
  wait.resolve(); await a; await rejected;
  assert.equal(concurrentWrites, 1); assert.equal(current, 7309);
});

test('native shell does not reply or synchronize a delayed read after disposal', async () => {
  const h = paneHarness(), wait = deferred(); h.host.api.settingsUiRequest = () => wait.promise;
  await h.pane.receive({ type: 'settings:ready' });
  const pending = h.pane.receive({ type: 'settings:request', request: { id: 'health', method: 'GET', path: '/panel/health' } });
  h.pane.pane.dispose(); wait.resolve({ ok: true }); await pending;
  assert.equal(h.messages.length, 1);
});

test('native local settings validate all fields and preserve changes made elsewhere', async () => {
  const h = paneHarness(); await h.pane.receive({ type: 'settings:ready' });
  const send = (id, body) => h.pane.receive({ type: 'settings:request', request: { id, method: 'PATCH', path: '/host/settings', body } });
  await send('stale', { values: { port: 8100 }, expected: { port: 7299 } });
  assert.equal(h.messages.at(-1).reply.ok, false); assert.deepEqual(h.updates, []);
  await send('invalid', { values: { port: 8100, pollIntervalMs: 1 }, expected: { port: 7306, pollIntervalMs: 1000 } });
  assert.equal(h.messages.at(-1).reply.ok, false); assert.deepEqual(h.updates, []);
  await send('valid', { values: { pollIntervalMs: 1500 }, expected: { pollIntervalMs: 1000 } });
  assert.equal(h.messages.at(-1).reply.ok, true); assert.deepEqual(h.updates, [['pollIntervalMs', 1500]]);
});

test('production host cannot expose or write a development daemon entry', async () => {
  const h = paneHarness('production'); await h.pane.receive({ type: 'settings:ready' });
  await h.pane.receive({ type: 'settings:request', request: { id: 'info', method: 'GET', path: '/host/info' } });
  assert.equal('daemonEntry' in h.messages.at(-1).reply.value, false);
  await h.pane.receive({ type: 'settings:request', request: { id: 'set', method: 'PATCH', path: '/host/settings', body: { values: { daemonEntry: '/fixture/evil.js' }, expected: { daemonEntry: '' } } } });
  assert.equal(h.messages.at(-1).reply.ok, false); assert.deepEqual(h.updates, []);
});
