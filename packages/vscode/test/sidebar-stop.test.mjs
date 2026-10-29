/**
 * Sidebar stop key: the composer swaps send → stop while the bound chat is generating, and the
 * webview's chatStop message travels to the hook and comes back as chatStopResult. Also covers the
 * chatStop helper: daemon answers (ok / not_running / failure) map to what the pill shows.
 */
import { handoffModules } from './handoff-modules.mjs';
import { toolNames } from '../../../scripts/fixtures/tool-names.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript');
const pause = () => new Promise(r => setImmediate(r));

const transpile = url => ts.transpileModule(fs.readFileSync(new URL(url, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

function setup(hooks) {
  const events = new Set(), ticks = new Set();
  const subscribe = fn => { events.add(fn); return { dispose: () => events.delete(fn) } };
  const subscribeTick = fn => { const sub = subscribe(fn); ticks.add(fn); return { dispose() { ticks.delete(fn); sub.dispose(); } } };
  const vscode = { commands: {}, env: { clipboard: { writeText: async () => {} } }, workspace: { workspaceFolders: [] }, window: { showErrorMessage() {} } };
  const module = { exports: {} };
  vm.runInNewContext(transpile('../src/sidebar.ts'), {
    module, exports: module.exports, console, AbortController, setTimeout, clearTimeout,
    require: n => n in handoffModules ? handoffModules[n]
      : n === './config' ? { getConfig: () => ({}) }
      : n === './toolNames' ? toolNames
      : n === 'vscode' ? vscode
      : n === './icons' ? { sidebarIcons: () => '{}' }
      : n === './callFormat' ? {}
      : n === './editorNavigation' ? { editorNavigationPreview: () => undefined, resolveEditorNavigation: () => ({ state: 'file_only' }) }
      : require(n),
  });
  const api = {
    changes: async () => ({ epoch: 1 }),
    listSessions: async () => ({ sessions: [{ id: 's1', status: 'active', workspace_path: 'D:/x', activity: 'idle' }] }),
    health: async () => ({ tunnel: 'offline' }),
    confirmations: async () => ({ confirmations: [] }),
    callsPage: async () => ({ calls: [], total: 0, window_total: 0, max_seq: 0 }),
    todos: async () => ({ items: [], updated_at: 0 }),
    courierStatus: async () => ({ connected: true, targets: [{ targetId: 't1', site: 'arena', sessionId: 's1', busy: true }], links: { s1: 'paired' } }),
  };
  const provider = new module.exports.SidebarProvider(api, { currentState: 'running', onDidChangeState: subscribe }, { onTick: subscribeTick }, hooks);
  const panel = () => {
    let closed = false, disposer = null, receive = null; const messages = [];
    const webview = { html: '', options: {}, postMessage: async m => { if (closed) throw Error('Webview is disposed'); messages.push(m); return true }, onDidReceiveMessage: fn => { receive = fn; return { dispose() {} } } };
    return {
      messages,
      get webview() { if (closed) throw Error('Webview is disposed'); return webview },
      send: m => receive(m),
      onDidDispose(fn) { disposer = fn; return { dispose() {} } },
      close() { closed = true; disposer?.(); },
    };
  };
  return { provider, api, panel, tick: async () => { for (const fn of ticks) fn(); await pause(); } };
}

const hooks = over => Object.assign({
  create() {}, act() {}, copyTemplate() {},
  chatSend: async () => ({ ok: true, message: '', sent: true }),
  chatStop: async () => ({ ok: true, message: '已停止' }),
  unpair: async () => {}, rename: async () => {},
}, over);

test('the composer carries a stop key in the send key slot and the webview script stays valid JS', async () => {
  const h = setup(hooks()), p = h.panel();
  h.provider.resolveWebviewView(p); await pause(); await h.tick();
  const html = p.webview.html;
  assert.match(html, /id="cmpSend"[^>]*>↑<\/button>/, 'send key still first in the field');
  assert.match(html, /id="cmpStop"[^>]*aria-label="停止生成"/, 'stop key sits next to it');
  assert.match(html, /\.cmp-field button\.stop \{/, 'stop key has its own colour rule');
  // Generation swaps the two keys in the same absolutely positioned slot, so the field never jumps.
  assert.match(html, /const canStop = gen && c\.connected;/, 'the swap follows the generating flag');
  assert.match(html, /cmpStop\.addEventListener\('click', chatStopNow\);/, 'stop key posts its own message');
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length);
  for (const [, script] of scripts) new vm.Script(script);
  h.provider.dispose();
});

test('a chatStop from the webview reaches the hook and returns as chatStopResult', async () => {
  const calls = [];
  const h = setup(hooks({ chatStop: async (s, targetId) => { calls.push([s.id, targetId]); return { ok: true, message: '已停止' }; } }));
  const p = h.panel();
  h.provider.resolveWebviewView(p); await pause(); await h.tick();
  p.send({ type: 'chatStop', id: 's1', targetId: 't1' });
  await pause(); await pause();
  assert.deepEqual(calls, [['s1', 't1']]);
  const result = p.messages.filter(m => m.type === 'chatStopResult').at(-1);
  assert.ok(result, 'the webview hears back');
  assert.equal(result.id, 's1');
  assert.equal(result.ok, true);
  assert.equal(result.message, '已停止');
  h.provider.dispose();
});

test('a stop without a bound chat is refused before it reaches the hook', async () => {
  const calls = [];
  const h = setup(hooks({ chatStop: async () => { calls.push(1); return { ok: true, message: '已停止' }; } }));
  const p = h.panel();
  h.provider.resolveWebviewView(p); await pause(); await h.tick();
  p.send({ type: 'chatStop', id: 'nope' });
  await pause(); await pause();
  assert.equal(calls.length, 0, 'unknown session never calls the hook');
  h.provider.dispose();
});

test('the page having no stop control (not_running) comes back as a warning, not a failure', async () => {
  const h = setup(hooks({ chatStop: async () => ({ ok: false, code: 'not_running', message: '页面当前没有在生成，无需停止' }) }));
  const p = h.panel();
  h.provider.resolveWebviewView(p); await pause(); await h.tick();
  p.send({ type: 'chatStop', id: 's1', targetId: 't1' });
  await pause(); await pause();
  const result = p.messages.filter(m => m.type === 'chatStopResult').at(-1);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'not_running');
  assert.match(result.message, /无需停止/);
  h.provider.dispose();
});

test('chatStop helper: daemon answers map to the pill text', async () => {
  const { chatStop } = (() => { const module = { exports: {} }; vm.runInNewContext(transpile('../src/courierChat.ts'), { module, exports: module.exports, console, Promise, Error, String }); return module.exports; })();
  const sent = [];
  const api = target => ({ courierStop: async body => { sent.push(body); return target; } });
  const s = { id: 's1' };

  // The helper runs inside a vm context: spread into this realm before comparing shapes.
  assert.deepEqual({ ...(await chatStop(api({ ok: true, message: '已停止' }), s, 't1')) }, { ok: true, message: '已停止' });
  assert.deepEqual({ ...sent.at(-1) }, { targetId: 't1', sessionId: 's1' }, 'stops the bound chat of this session');

  const idle = await chatStop(api({ ok: false, code: 'not_running', message: '页面没有停止按钮' }), s, 't1');
  assert.equal(idle.ok, false);
  assert.equal(idle.code, 'not_running');
  assert.match(idle.message, /无需停止/, 'the turn being over is not an error');

  const boom = await chatStop({ courierStop: async () => { throw Error('daemon 不在') } }, s, 't1');
  assert.deepEqual({ ...boom }, { ok: false, code: 'error', message: 'daemon 不在' });

  const unbound = await chatStop(api({ ok: true, message: 'x' }), s, null);
  assert.equal(unbound.code, 'no_target');
  assert.equal(sent.length, 2, 'nothing was sent for the unbound session');
});
