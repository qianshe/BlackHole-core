/**
 * 侧栏详情页的时间线、回复、聊天状态都来自会话 feed（session-feed 计划 §8）：真实的 SidebarProvider + 真实的 SessionFeed，
 * 只把 control API 的 feedJson 换成脚本化的假服务端（按长轮询语义：队列里有步骤就立即答，没有就挂起）。
 */
import { handoffModules } from './handoff-modules.mjs';
import { toolNames } from '../../../scripts/fixtures/tool-names.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript');
const settle = async () => { for (let i = 0; i < 25; i++) await new Promise((r) => setImmediate(r)); };

const transpile = (url) => ts.transpileModule(fs.readFileSync(new URL(url, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

function fakeFeedServer() {
  const requests = [];
  const queues = { feed: [], history: [] };
  const waiting = { feed: [], history: [] };
  const kindOf = (path) => (path.includes('/history?') ? 'history' : 'feed');
  return {
    requests,
    /** 请求里的路径按类型筛选 */
    feedRequests: () => requests.filter((r) => r.kind === 'feed'),
    push(kind, ...steps) {
      for (const step of steps) {
        const w = waiting[kind].shift();
        if (w) w.resolve(step); else queues[kind].push(step);
      }
    },
    fetch(path, signal, timeoutMs) {
      const kind = kindOf(path);
      const record = { path, kind, timeoutMs, aborted: () => signal.aborted };
      requests.push(record);
      const step = queues[kind].shift();
      if (step) return Promise.resolve(step);
      return new Promise((resolve, reject) => {
        const w = { resolve };
        waiting[kind].push(w);
        signal.addEventListener('abort', () => {
          const i = waiting[kind].indexOf(w);
          if (i >= 0) waiting[kind].splice(i, 1);
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }, { once: true });
      });
    },
  };
}

function setup(hooks = {}) {
  const events = new Set(), ticks = new Set();
  const subscribe = (fn) => { events.add(fn); return { dispose: () => events.delete(fn) }; };
  const subscribeTick = (fn) => { const sub = subscribe(fn); ticks.add(fn); return { dispose() { ticks.delete(fn); sub.dispose(); } }; };
  const vscode = { commands: {}, env: { clipboard: { writeText: async () => {} } }, workspace: { workspaceFolders: [] }, window: { showErrorMessage() {} } };
  const module = { exports: {} };
  vm.runInNewContext(transpile('../src/sidebar.ts'), {
    module, exports: module.exports, console, AbortController, setTimeout, clearTimeout,
    require: (n) => n in handoffModules ? handoffModules[n]
      : n === './config' ? { getConfig: () => ({}) }
      : n === './toolNames' ? toolNames
      : n === 'vscode' ? vscode
      : n === './icons' ? { sidebarIcons: () => '{}' }
      : n === './callFormat' ? { commandSummary: () => 's', argumentDetails: () => 'd', resultBody: () => 'b', resultDiff: () => null, pendingConfirmationFor: () => undefined }
      : n === './editorNavigation' ? { editorNavigationPreview: () => undefined, resolveEditorNavigation: () => ({ state: 'file_only' }) }
      : require(n),
  });
  const server = fakeFeedServer();
  const api = {
    changes: async () => ({ epoch: 1 }),
    listSessions: async () => ({ sessions: [{ id: 's1', status: 'active', workspace_path: 'D:/x', activity: 'idle' }] }),
    health: async () => ({ tunnel: 'offline' }),
    confirmations: async () => ({ confirmations: [] }),
    todos: async () => ({ items: [], updated_at: 0 }),
    courierStatus: async () => ({ connected: true, targets: [], sites: [{ id: 'arena', name: 'Arena', custom: false }] }),
    feedJson: (path, signal, timeoutMs) => server.fetch(path, signal, timeoutMs),
  };
  const hook = Object.assign({
    create() {}, act() {}, copyTemplate() {},
    chatSend: async () => ({ ok: true, message: '', sent: true }),
    chatStop: async () => ({ ok: true, message: '' }),
    unpair: async () => {}, rename: async () => {}, chatReload: async () => {}, chatCard: async () => ({ ok: true, message: '' }),
  }, hooks);
  const provider = new module.exports.SidebarProvider(api, { currentState: 'running', onDidChangeState: subscribe }, { onTick: subscribeTick }, hook);
  const panel = () => {
    let closed = false, disposer = null, receive = null; const messages = [];
    const webview = { html: '', options: {}, postMessage: async (m) => { if (closed) throw Error('Webview is disposed'); messages.push(m); return true; }, onDidReceiveMessage: (fn) => { receive = fn; return { dispose() {} }; } };
    return {
      messages,
      get webview() { if (closed) throw Error('Webview is disposed'); return webview; },
      send: (m) => receive(m),
      onDidDispose(fn) { disposer = fn; return { dispose() {} }; },
      close() { closed = true; disposer?.(); },
    };
  };
  return { provider, server, panel, api };
}

const call = (id, t, extra = {}) => ({ id, session_id: 's1', tool: 'editor', args_hash: 'h', args_json: '{}', status: 'completed', result_summary: null, created_at: t, updated_at: t + 1, ...extra });
const msg = (id, at, text, extra = {}) => ({ id, kind: 'agent', text, at, status: 'reply', site: 'arena', targetId: 't1', ...extra });
const STATE = { name: null, status: 'active', link: 'paired', connected: true, target: { targetId: 't1', site: 'arena', label: 'L', open: true, ready: true, busy: false, draft: false } };
const feedStep = (o = {}) => ({ boot: 'B', offset: 10, full: false, more: false, retry_ms: 0, wait: 25, calls: [], messages: [], ...o });
const updates = (p) => p.messages.filter((m) => m.type === 'update');
const chatMsgs = (p) => p.messages.filter((m) => m.type === 'chatMsg');
const SESSION = { id: 's1', status: 'active', workspace_path: 'D:/x', activity: 'idle' };

async function openDetail(h, p, first) {
  h.provider.resolveWebviewView(p); await settle();
  h.server.push('feed', feedStep({ full: true, offset: 10, calls: [call('c1', 1000), call('c2', 2000)], messages: [msg('m1', 1500, 'hello')], state: STATE, older: null, ...first }));
  h.provider.showCalls(SESSION); await settle();
}

test('进入详情页：开 feed（wait=25&limit=50，超时 35 秒），调用、回复、聊天状态都来自 feed 的首响应', async () => {
  const h = setup(), p = h.panel();
  await openDetail(h, p);
  const first = h.server.requests[0];
  assert.equal(first.path, '/sessions/s1/feed?wait=25&limit=50');
  assert.equal(first.timeoutMs, 35_000, '请求超时 = (wait+10) 秒，不能用默认的 8 秒把长轮询掰断');
  const u = updates(p).at(-1);
  assert.equal(u.mode, 'calls');
  assert.deepEqual(Array.from(u.calls, (c) => c.id), ['c1', 'c2']);
  assert.deepEqual(Array.from(u.courier.messages, (m) => m.id), ['m1']);
  assert.equal(u.courier.connected, true);
  assert.equal(u.courier.link, 'paired');
  assert.equal(u.courier.targets.length, 1);
  assert.equal(u.courier.targets[0].targetId, 't1');
  assert.equal(u.courier.targets[0].busy, false);
  assert.equal(u.courier.sites[0].id, 'arena', '新建会话可选的站点仍由 /courier 状态提供');
  assert.equal(u.hasOlder, false);
  assert.equal(u.callTotal, 2, '没有更早的记录时，已加载的调用数就是总数');
  assert.equal(h.server.feedRequests().length, 2, '响应后立即挂起下一个长轮询');
  assert.match(h.server.feedRequests()[1].path, /offset=10&boot=B/);
  h.provider.dispose();
});

test('流式回复：只有回复文本变化时发轻量的 chatMsg，不重绘整页调用；调用有变化时才整页更新', async () => {
  const h = setup(), p = h.panel();
  await openDetail(h, p, { messages: [msg('m1', 1500, 'a', { status: 'streaming' })] });
  const fullBefore = updates(p).length;
  h.server.push('feed', feedStep({ offset: 11, messages: [msg('m1', 1500, 'ab', { status: 'streaming' })] }));
  await settle();
  assert.equal(updates(p).length, fullBefore, '文本变化不重绘整页');
  assert.equal(chatMsgs(p).length, 1);
  assert.equal(chatMsgs(p)[0].sessionId, 's1');
  assert.equal(chatMsgs(p)[0].message.id, 'm1');
  assert.equal(chatMsgs(p)[0].message.text, 'ab');
  assert.equal(chatMsgs(p)[0].message.status, 'streaming');

  h.server.push('feed', feedStep({ offset: 12, calls: [call('c3', 3000)] }));
  await settle();
  assert.equal(updates(p).length, fullBefore + 1, '新调用整页更新');
  assert.deepEqual(Array.from(updates(p).at(-1).calls, (c) => c.id), ['c1', 'c2', 'c3']);

  // busy 翻转（state 变化）也整页更新，输入框的正在生成由它驱动
  h.server.push('feed', feedStep({ offset: 13, state: { ...STATE, target: { ...STATE.target, busy: true } } }));
  await settle();
  assert.equal(updates(p).at(-1).courier.targets[0].busy, true);
  h.provider.dispose();
});

test('往上翻：callOlder 走 /history（游标是最早条目的键，limit=50），翻到头后 hasOlder 清除、显示总调用数', async () => {
  const h = setup(), p = h.panel();
  await openDetail(h, p, { older: 'cursor' });
  assert.equal(updates(p).at(-1).hasOlder, true);
  assert.equal(updates(p).at(-1).callTotal, 0, '还有更早的记录时不显示总数');
  h.server.push('history', { items: { calls: [call('c0', 500)], messages: [msg('m0', 600, 'old')] }, older: null });
  p.send({ type: 'callOlder' }); await settle();
  const history = h.server.requests.find((r) => r.kind === 'history');
  assert.ok(history, '发出了 history 请求');
  assert.match(history.path, /^\/sessions\/s1\/history\?before=1000\.c\.c1&limit=50$/, '游标是当前最早条目 c1');
  assert.equal(history.timeoutMs, 10_000);
  const u = updates(p).at(-1);
  assert.deepEqual(Array.from(u.calls, (c) => c.id), ['c0', 'c1', 'c2']);
  assert.deepEqual(Array.from(u.courier.messages, (m) => m.id), ['m0', 'm1']);
  assert.equal(u.hasOlder, false);
  assert.equal(u.olderBusy, false);
  assert.equal(u.callTotal, 3);
  h.provider.dispose();
});

test('发送消息后 kick：打断挂起的长轮询并立即再读一次（不等长轮询超时）', async () => {
  const h = setup(), p = h.panel();
  await openDetail(h, p);
  const before = h.server.feedRequests();
  assert.equal(before.length, 2);
  const hung = before[1];
  p.send({ type: 'chatSend', id: 's1', text: 'hi', targetId: 't1' }); await settle();
  assert.equal(hung.aborted(), true, '挂起的请求被中止');
  assert.equal(h.server.feedRequests().length, 3, '立即发出新的请求');
  assert.match(h.server.feedRequests()[2].path, /offset=10&boot=B/, '用原 offset');
  assert.ok(p.messages.some((m) => m.type === 'chatResult' && m.ok === true));
  h.provider.dispose();
});

test('返回列表和销毁时关掉 feed：挂起的请求被中止，不再产生请求；再次进入重新来一遍 full', async () => {
  const h = setup(), p = h.panel();
  await openDetail(h, p);
  const hung = h.server.feedRequests()[1];
  p.send({ type: 'back' }); await settle();
  assert.equal(hung.aborted(), true);
  const n = h.server.requests.length;
  await settle();
  assert.equal(h.server.requests.length, n, '离开详情页后不再请求');
  assert.equal(updates(p).at(-1).mode, 'sessions');
  assert.deepEqual(Array.from(updates(p).at(-1).calls), []);

  h.provider.showCalls(SESSION); await settle();
  const again = h.server.feedRequests().at(-1);
  assert.equal(again.path.includes('offset='), false, '重新进入是全新的 feed，首个请求不带 offset');
  assert.equal(again.aborted(), false);
  h.provider.dispose();
  assert.equal(again.aborted(), true, '销毁时中止挂起的请求');
});

test('服务端不可达（feedJson 抛错）：已显示的内容保留，不崩，销毁后清理干净', async () => {
  const h = setup(), p = h.panel();
  await openDetail(h, p);
  const before = updates(p).at(-1);
  h.api.feedJson = () => { throw Object.assign(new Error('offline'), {}); };
  h.provider.kickFeed(); await settle();
  assert.deepEqual(Array.from(updates(p).at(-1).calls, (c) => c.id), Array.from(before.calls, (c) => c.id), '已显示的调用不清空');
  assert.doesNotThrow(() => h.provider.dispose());
});
