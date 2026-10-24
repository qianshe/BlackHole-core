import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const jsx = require('react/jsx-runtime');

function harness({ accountRequired = false, configuration = 'absent', setupError = false, localLoginFails = false, native = false, nativeDocument = native, corePhase = 'logged_out' } = {}) {
  const calls = { session: 0, login: 0, setup: 0, polls: 0, cancels: 0, status: 0, native: [] };
  const storage = new Map(), pending = new Map(), navigation = [];
  let phase = corePhase, job = { state: 'idle' };
  const intervals = [], cleanups = [];
  const history = { replaceState: (_a, _b, url) => navigation.push(url) };
  const localStorage = {
    getItem: k => storage.get(k) ?? null,
    setItem: (k, value) => storage.set(k, value),
  };
  const sessionStorage = {
    getItem: k => pending.get(k) ?? null,
    setItem: (k, value) => pending.set(k, value),
    removeItem: k => pending.delete(k),
  };
  const api = {
    session: async () => { calls.session++; return { account_required: accountRequired, version: '0.3.201' }; },
    localLogin: async () => { if (localLoginFails) throw Error('not signed in'); return { ok: true }; },
    authStatus: async () => { calls.status++; return { state: phase }; },
    setupSummary: async () => {
      calls.setup++;
      if (setupError) throw Error('unavailable');
      return { configuration };
    },
  };
  let slots = [], effects = [], cursor = 0;
  const react = {
    useCallback: fn => fn,
    useEffect: fn => { effects.push(fn); },
    useRef(value) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: value };
      return slots[index];
    },
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], next => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }];
    },
  };
  const styles = new Proxy({}, { get: (_target, key) => String(key) });
  const source = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
    + '\nexport { BrowserWaiting, DesktopLogin, ConnectionSetup, LocalApp, authenticate, nativeWelcome };';
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const module = { exports: {} };
  const nativeWindow = { location: { pathname: nativeDocument ? '/desktop/' : '/ui/', search: '', hash: '', hostname: '127.0.0.1' }, setTimeout, clearTimeout,
    ...(native ? { blackholeDesktopWelcomeAction: async action => {
      calls.native.push(action);
      if (action === 'sign-in') job = { state: 'running' };
      if (action === 'cancel') job = { state: 'failed', error: 'cancelled' };
      return JSON.stringify({ state: phase, signIn: job });
    } } : {}) };
  vm.runInNewContext(js, {
    module, exports: module.exports, URL, URLSearchParams, console, history, localStorage, sessionStorage,
    setTimeout, clearTimeout, setInterval: fn => { intervals.push(fn); return fn; }, clearInterval: () => {},
    window: nativeWindow,
    require: name => ({
      react, 'react/jsx-runtime': jsx,
      './api': { api, ApiError: class ApiError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } } },
      './format': { takeTicket: () => null },
      './console/Console': { Console: () => jsx.jsx('div', { children: 'workspace' }) },
      './remote/RemoteApp': { RemoteApp: () => null },
      './ui': { Icon: () => null, Logo: () => null, Skeleton: () => null },
      './App.module.css': { default: styles },
    }[name] ?? require(name)),
  }, { timeout: 2500 });

  function render(component, props, preset) {
    cursor = 0; effects = [];
    if (preset !== undefined) slots = [...preset];
    return component(props);
  }
  async function effectsOnce() {
    const queued = effects.splice(0);
    for (const effect of queued) {
      const cleanup = effect();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
    }
    // setupSummary is asynchronous and invokes a second microtask.
    await Promise.resolve(); await Promise.resolve();
    await settle(); // native async status and follow-up Core requests
  }
  return { ...module.exports, api, calls, history, navigation, storage, pending,
    sessionStorage, localStorage, render, effectsOnce, nativeWindow,
    unmount() { for (const cleanup of cleanups.splice(0)) cleanup(); },
    setCore(next, nextJob) { phase = next; if (nextJob) job = nextJob; },
    async tick() { for (const fn of intervals) await fn(); await settle(); } };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

function nodes(value) {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== 'object') return [];
  if (typeof value.type === 'function') return nodes(value.type(value.props));
  return [value, ...nodes(value.props?.children)];
}
function texts(value) {
  if (Array.isArray(value)) return value.map(texts).join('');
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (typeof value.type === 'function') return texts(value.type(value.props));
  return texts(value.props?.children);
}
function button(tree, label) {
  const found = nodes(tree).find(n => n.type === 'button' && texts(n).includes(label));
  assert.ok(found, `button missing: ${label}`);
  return found;
}

test('standalone browser shows passive waiting only; verified Core lets it enter without a Web login call', async () => {
  const h = harness();
  let done = null;
  const props = { onDone: value => { done = value; } };
  const initial = h.render(h.BrowserWaiting, props);
  assert.match(texts(initial), /等待 BlackHole 认证/);
  assert.doesNotMatch(texts(initial), /在浏览器中登录|Cloudflare|OpenAI Tunnel|直连/);
  await h.effectsOnce();
  assert.equal(h.calls.status, 1);
  assert.equal(h.calls.login, 0);
  h.setCore('verified');
  await h.tick();
  assert.equal(done?.state, 'ok');
  assert.equal(h.calls.login, 0);
  assert.equal(h.calls.setup, 0);
});

test('browser and Desktop welcome have separate entry paths while reusing the same Console', () => {
  const browser = harness();
  assert.equal(browser.render(browser.LocalApp, {}, [{ state: 'login', reason: 'account_required' }, false]).type, browser.BrowserWaiting);
  assert.equal(browser.render(browser.LocalApp, {}, [{ state: 'ok', version: '0.3.201' }, false]).type.name, 'Console');
  const desktop = harness({ native: true });
  assert.equal(desktop.render(desktop.LocalApp, {}, [{ state: 'login', reason: 'account_required' }, false]).type, desktop.DesktopLogin);
  assert.equal(desktop.render(desktop.LocalApp, {}, [{ state: 'ok', version: '0.3.201' }, false]).type, desktop.ConnectionSetup);
  assert.equal(desktop.render(desktop.LocalApp, {}, [{ state: 'ok', version: '0.3.201' }, true]).type.name, 'Console');
});

test('native document selects Desktop login independently of account permission', () => {
  const desktop = harness({ nativeDocument: true });
  const tree = desktop.render(desktop.LocalApp, {}, [{ state: 'login', reason: 'account_required' }, false]);
  assert.equal(tree.type, desktop.DesktopLogin, 'native welcome must not render the passive browser waiting page');
  const browser = harness();
  const browserTree = browser.render(browser.LocalApp, {}, [{ state: 'login', reason: 'account_required' }, false]);
  assert.equal(browserTree.type, browser.BrowserWaiting, 'ordinary browser still has no login UI');
});
test('Desktop explicit local welcome URL renders login and does not grant browser OAuth privileges', async () => {
  const desktop = harness({ nativeDocument: true, corePhase: 'logged_out' });
  assert.equal(desktop.nativeWindow.location.pathname, '/desktop/');
  assert.equal(desktop.nativeWindow.blackholeDesktopWelcomeAction, undefined);
  assert.equal(desktop.render(desktop.LocalApp, {}, [{ state:'login', reason:'account_required' }, false]).type, desktop.DesktopLogin);
  await desktop.authenticate();
  assert.deepEqual(desktop.navigation, [], 'host UI marker must survive bootstrap/refresh');
  await assert.rejects(desktop.nativeWelcome('sign-in'), /native_welcome_unavailable/);
  assert.equal(desktop.calls.login, 0, 'a view-only route hint grants no authentication ability');
  const ordinary = harness();
  assert.equal(ordinary.render(ordinary.LocalApp, {}, [{ state:'login', reason:'account_required' }, false]).type, ordinary.BrowserWaiting);
});
test('native capability globals never turn the browser entry into a login page', () => {
  const h = harness();
  h.nativeWindow.blackholeDesktopHost = true;
  h.nativeWindow.chrome = {webview:{postMessage(){assert.fail('browser must not send native actions')}}};
  assert.equal(h.render(h.LocalApp, {}, [{ state: 'login', reason: 'account_required' }, false]).type, h.BrowserWaiting);
  assert.equal(h.render(h.LocalApp, {}, [{ state: 'ok', version: '0.3.201' }, false]).type.name, 'Console');
});

test('missing native binding fails explicitly without a browser OAuth fallback', async () => {
  const h = harness({ nativeDocument: true });
  const props = { onDone() { assert.fail('an unverified account must not enter Console'); } };
  h.render(h.DesktopLogin, props);
  await h.effectsOnce();
  const missing = h.render(h.DesktopLogin, props);
  assert.match(texts(missing), /Desktop 登录通道尚未就绪/);
  assert.doesNotMatch(texts(missing), /等待 BlackHole 认证/);
  const actions = [];
  h.nativeWindow.blackholeDesktopWelcomeAction = async action => {
    actions.push(action);
    return JSON.stringify({ state: 'logged_out', signIn: { state: action === 'sign-in' ? 'running' : 'idle' } });
  };
  await h.tick();
  const ready = h.render(h.DesktopLogin, props);
  assert.doesNotMatch(texts(ready), /Desktop 登录通道尚未就绪/);
  button(ready, '在系统浏览器中登录').props.onClick();
  await settle();
  assert.ok(actions.includes('sign-in'));
  assert.equal(h.calls.login, 0, 'no browser Web OAuth endpoint was used');
});
test('Desktop shows the login action from verified Core read-only status despite a missing native RPC stub', async () => {
  const h = harness({ nativeDocument: true, corePhase: 'logged_out' });
  const props = { onDone() { assert.fail('Core is not signed in'); } };
  h.render(h.DesktopLogin, props);
  await h.effectsOnce();
  const tree = h.render(h.DesktopLogin, props);
  assert.ok(h.calls.status >= 1, 'Desktop should obtain account readiness from Core HTTP, not depend on WebView2');
  assert.match(texts(tree), /在系统浏览器中登录/);
  assert.doesNotMatch(texts(tree), /正在检查本机账号|等待 BlackHole 认证/);
  assert.equal(h.calls.native.length, 0, 'read-only account status may not start native login');
});


test('the single native adapter delegates status, sign-in and cancellation to Core', async () => {
  const h = harness({ native: true });
  assert.equal(typeof h.nativeWindow.blackholeDesktopWelcomeAction, 'function');
  const initial = await h.nativeWelcome('status');
  assert.equal(initial.state, 'logged_out');
  assert.equal(initial.signIn.state, 'idle');
  const started = await h.nativeWelcome('sign-in');
  assert.equal(started.signIn.state, 'running');
  const stopped = await h.nativeWelcome('cancel');
  assert.equal(stopped.signIn.error, 'cancelled');
  assert.deepEqual(h.calls.native, ['status', 'sign-in', 'cancel']);
  assert.equal(h.calls.login, 0, 'native actions never use Web OAuth endpoints');

  h.setCore('logged_out', { state: 'idle' });
  const props = { onDone() { assert.fail('not authenticated'); } };
  h.render(h.DesktopLogin, props);
  await h.effectsOnce();
  const view = h.render(h.DesktopLogin, props);
  assert.match(texts(view), /在系统浏览器中登录/);
  assert.doesNotMatch(texts(view), /登录通道尚未就绪|等待 BlackHole 认证/);
});

test('ordinary browser cannot invoke native welcome without an actual host transport', async () => {
  const browser = harness();
  await assert.rejects(browser.nativeWelcome('sign-in'), /native_welcome_unavailable/);
  assert.equal(browser.calls.native.length, 0);
  assert.equal(browser.calls.login, 0);
});

test('authenticated setup: options appear only after summary says absent; selecting a channel defers the install to Console', async () => {
  for (const [label, choice] of [['Cloudflare', 'cloudflare'], ['OpenAI Tunnel', 'openai'], ['直连或自建', 'direct']]) {
    const h = harness();
    let done = 0;
    const props = { onDone: () => { done++; }, onAuthChanged: () => assert.fail('auth still valid') };
    const initial = h.render(h.ConnectionSetup, props);
    assert.doesNotMatch(texts(initial), /临时公网连接|OpenAI Tunnel|直连或自建/);
    await h.effectsOnce();
    assert.equal(h.calls.setup, 1);
    const rendered = h.render(h.ConnectionSetup, props);
    assert.match(texts(rendered), /登录已完成/);
    assert.equal(nodes(rendered).filter(n => n.type === 'button' && /channelOption/.test(n.props.className)).length, 3);
    button(rendered, label).props.onClick();
    await settle();
    assert.equal(h.calls.session, 1);
    assert.equal(done, 1);
    assert.deepEqual(h.navigation, ['/ui/?set=connections']);
    assert.equal(h.pending.get('blackhole.pendingSetup.v1') ?? null, choice === 'direct' ? null : choice);
  }
});

test('skip records preference and opens workspace without choosing or installing a channel', async () => {
  const h = harness(), props = { onDone: () => {}, onAuthChanged: () => {} };
  let done = 0;
  props.onDone = () => { done++; };
  h.render(h.ConnectionSetup, props);
  await h.effectsOnce();
  const tree = h.render(h.ConnectionSetup, props);
  button(tree, '稍后设置').props.onClick();
  await settle();
  assert.equal(h.storage.get('blackhole.setupSkipped.v1'), '1');
  assert.equal(h.pending.size, 0);
  assert.equal(h.navigation.length, 0);
  assert.equal(done, 1);
});

test('previously configured and locally skipped users avoid repeated channel onboarding', async () => {
  const configured = harness({ configuration: 'present' });
  let finished = 0;
  configured.render(configured.ConnectionSetup, { onDone: () => { finished++; }, onAuthChanged() {} });
  await configured.effectsOnce();
  assert.equal(finished, 1);
  assert.equal(configured.calls.setup, 1);

  const skipped = harness();
  skipped.storage.set('blackhole.setupSkipped.v1', '1');
  skipped.render(skipped.ConnectionSetup, { onDone: () => { finished++; }, onAuthChanged() {} });
  await skipped.effectsOnce();
  assert.equal(finished, 2);
  assert.equal(skipped.calls.setup, 0);
});

test('unknown connection configuration does not offer automatic installation, but can be skipped', async () => {
  const h = harness({ setupError: true });
  let done = 0;
  const props = { onDone: () => { done++; }, onAuthChanged() {} };
  h.render(h.ConnectionSetup, props);
  await h.effectsOnce();
  const tree = h.render(h.ConnectionSetup, props);
  assert.match(texts(tree), /无法确认|重新检测/);
  assert.doesNotMatch(texts(tree), /临时公网连接|OpenAI Tunnel|直连或自建/);
  button(tree, '稍后设置').props.onClick();
  await settle();
  assert.equal(done, 1);
});

test('expired login on channel selection cannot stage install or open Console', async () => {
  const h = harness({ accountRequired: true });
  let done = 0, login = null;
  const props = { onDone: () => { done++; }, onAuthChanged: a => { login = a; } };
  h.render(h.ConnectionSetup, props);
  await h.effectsOnce();
  const tree = h.render(h.ConnectionSetup, props);
  button(tree, 'Cloudflare').props.onClick();
  await settle();
  assert.equal(done, 0);
  assert.equal(login?.state, 'login');
  assert.equal(h.pending.size, 0);
  assert.equal(h.navigation.length, 0);
});

test('old pre-login install and Web-login attempts are discarded during startup', async () => {
  const h = harness();
  h.pending.set('blackhole.pendingSetup.v1', 'cloudflare');
  h.pending.set('blackhole.loginAttempt.v1', 'A'.repeat(43));
  await h.authenticate();
  assert.equal(h.pending.size, 0);
  assert.equal(h.calls.login, 0);
});

test('initial authenticated bootstrap drops old pre-login connection intent', async () => {
  const h = harness();
  h.pending.set('blackhole.pendingSetup.v1', 'openai');
  const auth = await h.authenticate();
  assert.equal(auth.state, 'ok');
  assert.equal(h.pending.size, 0);
  assert.equal(h.calls.setup, 0);
});

test('Desktop may request Core login only through the native action bridge', async () => {
  const h = harness({ native: true, corePhase: 'logged_out' });
  let done = null;
  const props = { onDone: value => { done = value; } };
  h.render(h.DesktopLogin, props);
  await h.effectsOnce();
  const idle = h.render(h.DesktopLogin, props);
  assert.match(texts(idle), /系统浏览器中登录/);
  button(idle, '在系统浏览器中登录').props.onClick();
  await settle();
  assert.ok(h.calls.native.includes('sign-in'));
  assert.equal(h.calls.login, 0, 'no Web login request may be sent');
  const waiting = h.render(h.DesktopLogin, props);
  assert.match(texts(waiting), /系统浏览器中完成登录/);
  assert.equal(done, null, 'native sign-in start alone does not grant access');
  h.setCore('verified', { state: 'done' });
  await h.tick();
  assert.equal(done?.state, 'ok');
});

test('Desktop can cancel an in-progress native login without invoking Web login', async () => {
  const h = harness({ native: true });
  const props = { onDone() {} };
  h.render(h.DesktopLogin, props);
  await h.effectsOnce();
  button(h.render(h.DesktopLogin, props), '在系统浏览器中登录').props.onClick();
  await settle();
  button(h.render(h.DesktopLogin, props), '取消登录').props.onClick();
  await settle();
  assert.ok(h.calls.native.includes('cancel'));
  assert.equal(h.calls.login, 0);
});

test('saved or unavailable Core identity cannot silently enter Desktop Console', async () => {
  const h = harness({ native: true, corePhase: 'saved' });
  let done = 0;
  const props = { onDone() { done++; } };
  h.render(h.DesktopLogin, props);
  await h.effectsOnce();
  const saved = h.render(h.DesktopLogin, props);
  assert.match(texts(saved), /账号尚未验证完成/);
  button(saved, '重新验证').props.onClick();
  await settle();
  assert.ok(h.calls.native.includes('verify'));
  assert.equal(done, 0);
  h.setCore('unavailable');
  await h.tick();
  assert.equal(done, 0);
});

test('Desktop verification page returns to workspace when Core recovers without another click', async () => {
  const h = harness({ native: true, corePhase: 'unavailable' });
  let done = 0;
  const props = { onDone(auth) { assert.equal(auth.state, 'ok'); done++; } };
  h.render(h.DesktopLogin, props);
  await h.effectsOnce();
  assert.match(texts(h.render(h.DesktopLogin, props)), /账号尚未验证完成/);
  h.setCore('verified');
  await h.tick();
  assert.equal(done, 1);
  assert.equal(h.calls.native.filter(action => action === 'sign-in').length, 0);
  h.unmount();
});

test('a pending native status callback times out and does not permanently block Core recovery polling', async () => {
  const h = harness({ native: true, corePhase: 'saved' });
  const timers = new Map();
  h.nativeWindow.setTimeout = (fn, ms) => { timers.set(fn, ms); return fn; };
  h.nativeWindow.clearTimeout = fn => timers.delete(fn);
  h.nativeWindow.blackholeDesktopWelcomeAction = () => new Promise(() => {});
  let done = 0;
  const props = { onDone() { done++; } };
  h.render(h.DesktopLogin, props);
  await h.effectsOnce();
  assert.equal([...timers.values()][0], 5000);
  for (const fn of [...timers.keys()]) fn();
  await settle();
  h.setCore('verified');
  await h.tick();
  assert.equal(done, 1, 'same page must retry after the native status timeout');
  h.unmount();
});

test('late verify completion after automatic entry cannot sign in or complete a second time', async () => {
  const h = harness({ native: true, corePhase: 'saved' });
  let done = 0, release;
  const props = { onDone() { done++; } };
  h.render(h.DesktopLogin, props);
  await h.effectsOnce();
  const saved = h.render(h.DesktopLogin, props);
  h.nativeWindow.blackholeDesktopWelcomeAction = action => action === 'verify'
    ? new Promise(resolve => { release = resolve; })
    : Promise.resolve(JSON.stringify({ state: 'saved', signIn: { state: 'idle' } }));
  button(saved, '重新验证').props.onClick();
  await settle();
  h.setCore('verified');
  await h.tick();
  assert.equal(done, 1);
  h.unmount();
  const sessions = h.calls.session;
  release(JSON.stringify({ state: 'verified', signIn: { state: 'done' } }));
  await settle();
  assert.equal(done, 1);
  assert.equal(h.calls.session, sessions, 'unmounted action must not establish another Web session');
});

test('automatic recovery and manual verification share a pending Web session handoff', async () => {
  const h = harness({ native: true, corePhase: 'saved' });
  let done = 0, logins = 0, sessions = 0;
  const replies = [];
  const props = { onDone() { done++; } };
  h.render(h.DesktopLogin, props);
  await h.effectsOnce();
  h.api.localLogin = async () => { logins++; return { ok: true }; };
  h.api.session = () => { sessions++; return new Promise(resolve => replies.push(resolve)); };
  h.nativeWindow.blackholeDesktopWelcomeAction = async () => JSON.stringify({ state: 'verified', signIn: { state: 'done' } });
  button(h.render(h.DesktopLogin, props), '重新验证').props.onClick();
  await settle();
  assert.equal(sessions, 1, 'manual verification has already issued a session read');
  h.setCore('verified');
  await h.tick();
  assert.equal(logins, 1, 'polling cannot replace the cookie during an existing handoff');
  assert.equal(sessions, 1, 'only one response may update the cookie-bound CSRF token');
  replies[0]({ account_required: false, version: '0.4.10' });
  await settle();
  assert.equal(done, 1);
  h.unmount();
});

test('browser waits while saved or offline, and never sends a sign-in request', async () => {
  const h = harness({ corePhase: 'saved', localLoginFails: true });
  let done = 0;
  const props = { onDone() { done++; } };
  h.render(h.BrowserWaiting, props);
  await h.effectsOnce();
  assert.match(texts(h.render(h.BrowserWaiting, props)), /等待客户端验证/);
  h.setCore('unavailable');
  await h.tick();
  assert.match(texts(h.render(h.BrowserWaiting, props)), /暂不可用/);
  assert.equal(done, 0);
  assert.equal(h.calls.login, 0);
});

test('Web source has no cloud login route, authorization link or channel installer action in browser mode', () => {
  const source = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const apiSource = fs.readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(apiSource, /\/auth\/login(?:\/|')/);
  assert.doesNotMatch(apiSource, /accountSignIn|accountCancelSignIn/);
  const cardSource = fs.readFileSync(new URL('../src/AccountCard.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(cardSource, /api\.accountSignIn\(|api\.accountCancelSignIn\(/);
  assert.match(cardSource, /Desktop 或 VS Code 欢迎页/);
  assert.doesNotMatch(source, /authorizationLink|window\.open\('about:blank'/);
  const h = harness();
  assert.equal(h.render(h.LocalApp, {}, [{ state: 'login', reason: 'unauthenticated' }, false]).type, h.BrowserWaiting);
});
