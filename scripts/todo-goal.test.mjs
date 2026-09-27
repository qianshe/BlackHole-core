import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import vm from 'node:vm';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { TodosRepo } from '../dist/storage/todos.js';
import { registerTools } from '../dist/mcp/tools.js';
import { SessionRuntime } from '../dist/runtime.js';
import { mountControl } from '../dist/control/api.js';
import { mountPanel } from '../dist/panel/index.js';
import { panelHtml } from '../dist/panel/appHtml.js';
import { PanelRegistry } from '../dist/panel/keys.js';
import { buildGenericManual } from '../dist/workspace/rules.js';
import { buildExecutionGuidance } from '../dist/prompt.js';

const SID = '1'.repeat(39);
const item = { content: 'verify outcome', status: 'pending' };
const contract = {
  goal: 'Finish the requested result',
  nonGoals: ['Do not change unrelated behavior'],
  successCriteria: ['The requested result is observable'],
  verification: ['Run the focused behavioral check'],
};
const json = reply => reply.structuredContent ?? JSON.parse(reply.content[0].text);

function storage(t) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE session_todos(session_id TEXT PRIMARY KEY,items_json TEXT NOT NULL,updated_at INTEGER NOT NULL)');
  let changes = 0;
  const repo = new TodosRepo(db, () => changes++);
  t.after(() => db.close());
  return { db, repo, changes: () => changes };
}

async function fixture(t) {
  const f = storage(t);
  const runtime = new SessionRuntime({ id: 'session', workspace_path: process.cwd(), permission_mode: 'read-only' }, {});
  const rows = new Map();
  const server = new McpServer({ name: 'contract-fixture', version: '1' });
  registerTools(server, id => id === SID ? runtime : { error: 'invalid fixture session' }, {
    cfg: {}, todos: f.repo, events: { append() {} }, sessions: { byCredential: () => undefined },
    toolCalls: {
      start: () => { const row = { id: String(rows.size), status: 'started' }; rows.set(row.id, row); return row; },
      get: id => rows.get(id), finish: (id, status, summary) => Object.assign(rows.get(id), { status, summary }),
    },
  }, { execDescription: 'No real command execution.' });
  const client = new Client({ name: 'contract-client', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); });
  return { ...f, client, call: args => client.callTool({ name: 'todo', arguments: { sessionId: SID, ...args } }) };
}

test('optional Task Contract persists through patch, is replaced atomically and clears only on write omission', async t => {
  const f = await fixture(t);
  await f.call({ command: 'write', todos: [item] });
  assert.equal(json(await f.call({ command: 'read' })).contract, undefined);
  const padded = {
    goal: '  Finish the requested result  ',
    nonGoals: ['  Do not change unrelated behavior  '],
    successCriteria: ['  The requested result is observable  '],
    verification: ['  Run the focused behavioral check  '],
  };
  await f.call({ command: 'write', todos: [item], contract: padded });
  assert.deepEqual(json(await f.call({ command: 'read' })).contract, contract);
  await f.call({ command: 'patch', updates: [{ content: item.content, status: 'completed' }] });
  const done = json(await f.call({ command: 'read' }));
  assert.deepEqual(done.contract, contract); assert.equal(done.completed_count, 1);
  await f.call({ command: 'write', todos: done.items });
  const cleared = json(await f.call({ command: 'read' }));
  assert.equal(cleared.contract, undefined); assert.deepEqual(cleared.items, done.items);
  await f.call({ command: 'write', todos: [], contract });
  const contractOnly = json(await f.call({ command: 'read' }));
  assert.deepEqual(contractOnly.contract, contract); assert.deepEqual(contractOnly.items, []);
  await f.call({ command: 'write', todos: [] });
  assert.equal(json(await f.call({ command: 'read' })).contract, undefined);
});

test('Todo exposes one canonical contract schema; goal-only and command-mismatched inputs fail without mutation', async t => {
  const f = await fixture(t);
  const schema = (await f.client.listTools()).tools.find(x => x.name === 'todo').inputSchema;
  assert.ok(schema.properties.contract); assert.equal(schema.properties.goal, undefined);
  await f.call({ command: 'write', todos: [item], contract });
  const before = f.repo.get('session');
  const invalid = [
    { command: 'write', todos: [item], goal: 'legacy goal-only input' },
    { command: 'read', contract },
    { command: 'patch', contract, updates: [{ content: item.content, status: 'completed' }] },
    { command: 'write', todos: [item], contract: { goal: '', nonGoals: [], successCriteria: [], verification: [] } },
    { command: 'write', todos: [item], contract: { goal: 'x', nonGoals: [], successCriteria: [], verification: [], extra: true } },
    { command: 'write', todos: [item], contract: { goal: 'x' } },
  ];
  for (const args of invalid) {
    const result = await f.call(args).catch(() => ({ isError: true }));
    assert.equal(result.isError, true); assert.deepEqual(f.repo.get('session'), before);
  }
  const partial = await f.call({ command: 'patch', updates: [{ content: item.content, status: 'completed' }, { content: 'missing', status: 'completed' }] });
  assert.equal(partial.isError, true); assert.deepEqual(f.repo.get('session'), before);
});

test('storage accepts only the canonical object shape and always writes it', t => {
  const f = storage(t);
  const insert = value => f.db.prepare('INSERT OR REPLACE INTO session_todos VALUES (?,?,1)').run('session', JSON.stringify(value));
  insert([item]); assert.deepEqual(f.repo.get('session').items, []);
  insert({ items: [item], goal: 'legacy goal-only input' }); assert.deepEqual(f.repo.get('session').items, []);
  insert({ items: [item], contract }); assert.deepEqual(f.repo.get('session'), { items: [item], contract, updated_at: 1 });
  insert({ items: [item], contract: { ...contract, extra: true } }); assert.deepEqual(f.repo.get('session').items, []);
  f.repo.set('session', [item]);
  assert.deepEqual(JSON.parse(f.db.prepare('SELECT items_json FROM session_todos WHERE session_id=?').get('session').items_json), { items: [item] });
  f.repo.set('session', [item], contract);
  assert.deepEqual(JSON.parse(f.db.prepare('SELECT items_json FROM session_todos WHERE session_id=?').get('session').items_json), { items: [item], contract });
});

test('storage validates every Todo item and Task Contract boundary before exposing or writing a board', t => {
  const f = storage(t);
  const insert = value => f.db.prepare('INSERT OR REPLACE INTO session_todos VALUES (?,?,1)').run('session', JSON.stringify(value));
  const invalid = [
    { items: [null] },
    { items: [{ content: '', status: 'pending' }] },
    { items: [{ content: 'x'.repeat(501), status: 'pending' }] },
    { items: [{ content: 'x', status: ['pending'] }] },
    { items: [{ content: 'x', status: 'unknown' }] },
    { items: [{ content: 'x', status: 'pending', activeForm: '' }] },
    { items: [{ content: 'x', status: 'pending', activeForm: 'x'.repeat(201) }] },
    { items: [{ content: 'x', status: 'pending', extra: true }] },
    { items: Array.from({ length: 51 }, () => item) },
    { items: [{ content: 'a', status: 'in_progress' }, { content: 'b', status: 'in_progress' }] },
    { items: [item], contract: { ...contract, goal: 'g'.repeat(2001) } },
    { items: [item], contract: { ...contract, nonGoals: Array.from({ length: 21 }, () => 'x') } },
    { items: [item], contract: { ...contract, successCriteria: ['x'.repeat(1001)] } },
    { items: [item], contract: { ...contract, verification: ['x'.repeat(1001)] } },
  ];
  for (const value of invalid) { insert(value); assert.deepEqual(f.repo.get('session'), { items: [], updated_at: 0 }); }
  assert.throws(() => f.repo.set('session', [{ content: 'x'.repeat(501), status: 'pending' }]));
  assert.throws(() => f.repo.set('session', [{ content: 'a', status: 'in_progress' }, { content: 'b', status: 'in_progress' }]));

  const boundaryItems = Array.from({ length: 50 }, (_, index) => ({
    content: String(index).padStart(3, '0') + 'x'.repeat(497), status: 'pending', activeForm: 'a'.repeat(200),
  }));
  const boundaryContract = {
    goal: 'g'.repeat(2000), nonGoals: Array.from({ length: 20 }, () => 'n'.repeat(500)),
    successCriteria: Array.from({ length: 20 }, () => 's'.repeat(1000)), verification: Array.from({ length: 20 }, () => 'v'.repeat(1000)),
  };
  f.repo.set('session', boundaryItems, boundaryContract);
  assert.deepEqual(f.repo.get('session'), { items: boundaryItems, contract: boundaryContract, updated_at: f.repo.get('session').updated_at });
});

function routes() {
  const handlers = new Map();
  const app = new Proxy({}, { get: (_, method) => (...args) => { if (method === 'get') handlers.set(args[0], args.at(-1)); return app; } });
  return { app, handlers };
}
function response() { return { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; }, end() { return this; } }; }

test('control API carries the full contract while panel hides only historical completed boards', t => {
  const f = storage(t), completed = [{ ...item, status: 'completed' }];
  f.repo.set('session', [item], contract);
  const deps = {
    cfg: {}, todos: f.repo,
    sessions: { get: id => id === 'session' ? { id, status: 'active', name: 'fixture', permission_mode: 'read-only' } : undefined },
    changes: { epoch: () => 1 }, toolCalls: { listForSessionSince: () => [], countForSessionAfter: () => 0 },
    confirmations: { expireStale() {}, list: () => [] },
  };
  const a = routes(); mountControl(a.app, deps);
  const res = response(); a.handlers.get('/sessions/:id/todos')({ params: { id: 'session' } }, res);
  assert.deepEqual(res.body.contract, contract); assert.equal(res.body.goal, undefined);
  let todosChanged = false;
  const b = routes();
  const panels = {
    terminalReason: () => undefined,
    sessionOf: () => 'session',
    startSeqFor: () => 0,
    todosChangedSinceMount: () => todosChanged,
  };
  mountPanel(b.app, deps, panels, { pruneSession() {} }, () => { throw Error('No approval expected'); });
  const read = () => { const r = response(); b.handlers.get('/:key/data')({ params: { key: 'synthetic' }, query: {} }, r); return r.body; };

  assert.deepEqual(read().todos.contract, contract, 'historical unfinished board stays visible');
  f.repo.set('session', completed, contract);
  assert.equal(read().todos, undefined, 'historical completed board is hidden even when it has a contract');
  f.repo.set('session', [], contract);
  assert.deepEqual(read().todos.contract, contract, 'goal-only contract is not mistaken for a completed checklist');

  f.repo.set('session', completed, contract);
  todosChanged = true;
  assert.equal(read().todos.items[0].status, 'completed', 'current-round completion remains visible without timestamp ordering');
  assert.deepEqual(read().todos.contract, contract);
});

test('PanelRegistry tracks todo writes causally and resets the flag on a fresh round', t => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE session_todos(session_id TEXT PRIMARY KEY,items_json TEXT NOT NULL,updated_at INTEGER NOT NULL)');
  t.after(() => db.close());
  const panels = new PanelRegistry();
  const repo = new TodosRepo(db, sessionId => panels.markTodosChanged(sessionId));

  panels.mountFresh('session', 0);
  assert.equal(panels.todosChangedSinceMount('session'), false);
  repo.set('session', [{ ...item, status: 'completed' }], contract);
  assert.equal(panels.todosChangedSinceMount('session'), true, 'a todo write after mount marks the current round regardless of clock timestamps');

  panels.mountFresh('session', 0);
  assert.equal(panels.todosChangedSinceMount('session'), false, 'new show starts a clean todo-change window');
});

class Element {
  constructor() {
    this.children = []; this.style = {}; this.hidden = false; this.attrs = {}; this.parts = new Map();
    this.classes = new Set(); this.listeners = new Map(); this.value = ''; this.title = ''; this.className = '';
    this.classList = {
      add: (...names) => names.forEach(name => this.classes.add(name)),
      remove: (...names) => names.forEach(name => this.classes.delete(name)),
      toggle: (name, force) => {
        const on = force === undefined ? !this.classes.has(name) : !!force;
        if (on) this.classes.add(name); else this.classes.delete(name);
        return on;
      },
      contains: name => this.classes.has(name),
    };
  }
  set textContent(v) { this.value = String(v); this.children = []; }
  get textContent() { return this.value; }
  set innerHTML(v) { this.html = v; }
  get innerHTML() { return this.html ?? ''; }
  appendChild(e) { this.children.push(e); }
  prepend(e) { this.children.unshift(e); }
  addEventListener(type, fn) { this.listeners.set(type, fn); }
  dispatch(type, event = {}) { this.listeners.get(type)?.({ stopPropagation() {}, preventDefault() {}, ...event }); }
  setAttribute(k, v) { this.attrs[k] = v; }
  removeAttribute(k) { delete this.attrs[k]; }
  getAttribute(k) { return this.attrs[k]; }
  querySelector(k) { if (!this.parts.has(k)) this.parts.set(k, new Element()); return this.parts.get(k); }
}
function renderFixture(kind) {
  const nodes = new Map(), $ = s => { const id = s.replace(/^#/, ''); if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  const sandbox = { $, document: { createElement: () => new Element() }, requestAnimationFrame: fn => fn(), el: (_tag, cls, text) => { const e = new Element(); e.className = cls; e.textContent = text ?? ''; return e; } };
  let code;
  if (kind === 'panel') {
    const html = panelHtml();
    code = html.slice(html.indexOf('  function renderTodos(board)'), html.indexOf('  $("#curRow").addEventListener')) + '\nthis.render=renderTodos;';
  } else {
    const source = fs.readFileSync(new URL('../packages/vscode/src/sidebar.ts', import.meta.url), 'utf8');
    code = "const tasksEl=$('tasks');let tasksBuilt=false,tasksOpen=false,tasksLastKey='',tasksLastPct=-1,tasksSeenIncomplete=false;\n" + source.slice(source.indexOf('    function closeTasks()'), source.indexOf('    let lastCalls = []')) + '\nthis.render=renderTasks;';
  }
  vm.runInNewContext(code, sandbox);
  return {
    $,
    render: board => sandbox.render(kind === 'panel'
      ? board
      : { mode: 'calls', todos: board.items, goal: board.contract?.goal, todosUnavailable: board.unavailable === true }),
  };
}

for (const kind of ['panel', 'sidebar']) test(`${kind} renders contract.goal as the first independent checklist item`, () => {
  if (kind === 'panel') {
    const scripts = [...panelHtml().matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
    assert.ok(scripts.length); for (const [, script] of scripts) new vm.Script(script);
  }
  const f = renderFixture(kind), listId = kind === 'panel' ? 'todos' : 'tasksItems';
  const dangerous = '<img src=x onerror=alert(1)>\n目标' + ' long Goal'.repeat(150);
  f.render({ items: [item], contract: { ...contract, goal: dangerous } });
  let list = f.$(listId), goalRow = list.children[0], goalText = kind === 'panel' ? goalRow : goalRow.children[1];
  assert.equal(goalText.textContent, '目标：' + dangerous); assert.equal(goalText.title, dangerous);
  assert.match(goalRow.className, /(?:^|\s)(?:g|goal)(?:\s|$)/); assert.equal(list.children.length, 2);
  f.render({ items: [], contract: { ...contract, goal: 'Goal only' } });
  list = f.$(listId); goalRow = list.children[0]; goalText = kind === 'panel' ? goalRow : goalRow.children[1];
  assert.equal(list.children.length, 1); assert.equal(goalText.textContent, '目标：Goal only');
  if (kind === 'panel') {
    assert.equal(f.$('curRow').hidden, true); assert.equal(f.$('progressLine').hidden, true); assert.equal(list.hidden, false);
  } else {
    assert.equal(f.$('tasksNum').hidden, true); assert.equal(f.$('tasksSub').hidden, true); assert.equal(f.$('tasksBar').hidden, true);
    assert.notEqual(f.$('tasksNum').textContent, '0/0');
  }
  f.render({ items: [item], contract });
  if (kind === 'sidebar') { assert.equal(f.$('tasksNum').hidden, false); assert.equal(f.$('tasksBar').hidden, false); }
  f.render({ items: [item] }); assert.equal(f.$(listId).children.some?.(x => /目标：/.test(x.textContent)) ?? false, false);
  f.render({ items: [] }); assert.equal(kind === 'panel' ? f.$('todoSec').hidden : f.$('tasks').style.display, kind === 'panel' ? true : 'none');
});

test('sidebar hides a checklist that is already complete, but keeps a just-completed receipt and restores on new work', () => {
  const f = renderFixture('sidebar'), completed = { ...item, status: 'completed' };

  f.render({ items: [completed], contract });
  assert.equal(f.$('tasks').style.display, 'none', 'historical completed checklist stays out of the detail view');

  f.render({ items: [item], contract });
  assert.equal(f.$('tasks').style.display, 'block', 'unfinished checklist is visible');
  f.$('tasksHd').dispatch('click');
  const box = f.$('tasks').querySelector('.t2f');
  assert.equal(box.classList.contains('open'), true, 'fixture opened the checklist before completion');

  f.render({ items: [completed], contract });
  assert.equal(f.$('tasks').style.display, 'block', 'completion observed in this view remains visible as a receipt');
  assert.equal(f.$('tasksSub').textContent, '清单已完成');
  assert.equal(box.classList.contains('closed'), true, 'just-completed checklist auto-collapses');

  f.render({ items: [item], contract });
  assert.equal(f.$('tasks').style.display, 'block', 'new unfinished work restores the checklist immediately');

  f.render({ items: [], contract });
  assert.equal(f.$('tasks').style.display, 'block', 'goal-only contract remains visible');
});


test('sidebar preserves current-view completion context across a temporary todo read failure', () => {
  const f = renderFixture('sidebar'), completed = { ...item, status: 'completed' };

  f.render({ items: [item], contract });
  assert.equal(f.$('tasks').style.display, 'block');
  f.render({ items: [], unavailable: true });
  assert.equal(f.$('tasks').style.display, 'none', 'temporary read failure hides stale todo content');

  f.render({ items: [completed], contract });
  assert.equal(f.$('tasks').style.display, 'block', 'recovery to completed still shows the current-view completion receipt');
  assert.equal(f.$('tasksSub').textContent, '清单已完成');
});

test('panel collapses only on the transition to all-done and allows reopening the completed checklist', () => {
  const f = renderFixture('panel'), completed = { ...item, status: 'completed' };

  f.render({ items: [item], contract });
  f.$('curRow').setAttribute('aria-expanded', 'true');
  f.$('todos').hidden = false;

  f.render({ items: [completed], contract });
  assert.equal(f.$('todoSec').hidden, false, 'current-round completion remains visible');
  assert.equal(f.$('cur').querySelector('.txt').textContent, '清单已完成');
  assert.equal(f.$('curRow').getAttribute('aria-expanded'), 'false');
  assert.equal(f.$('todos').hidden, true, 'transition to all-done auto-collapses the item list');

  f.$('curRow').setAttribute('aria-expanded', 'true');
  f.$('todos').hidden = false;
  f.render({ items: [completed], contract });
  assert.equal(f.$('curRow').getAttribute('aria-expanded'), 'true', 'later polls do not fight a user reopening the completed list');
  assert.equal(f.$('todos').hidden, false);
});


test('panel modified-file summary is round-scoped, write-only, deduplicated and filename-only', () => {
  const html = panelHtml();
  const start = html.indexOf('  const modifiedFileByCall = new Map();');
  const end = html.indexOf('  function resetRound(start)', start);
  assert.ok(start >= 0 && end > start);
  const nodes = new Map(), $ = s => { const id = s.replace(/^#/, ''); if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  const sandbox = { $, Map, Set, JSON };
  vm.runInNewContext(html.slice(start, end) + '\nthis.fact=modifiedFileFact;this.render=renderModifiedFiles;this.files=modifiedFileByCall;', sandbox);
  sandbox.render();
  assert.equal($('modifiedFiles').hidden, true, 'no modified files must consume no footer row');
  assert.doesNotMatch(html, />修改文件<|modified-files \.label/);
  assert.match(html, /\.modified-files\[hidden\] \{ display: none; \}/);
  const call = (command, filePath, status = 'completed') => ({ tool: 'editor', status, diff: status === 'completed' ? { added: 1, removed: 0 } : undefined, args_json: JSON.stringify({ command, path: filePath, path_key: filePath }) });
  assert.equal(sandbox.fact(call('view', 'src/read.ts')), null);
  assert.equal(sandbox.fact(call('insert', 'src/deep/a.ts', 'failed')).completed, false);
  assert.equal(sandbox.fact(call('str_replace', 'src/deep/a.ts')).name, 'a.ts');
  [['a.ts','a1'],['b.ts','b'],['a.ts','a2'],['c.ts','c'],['d.ts','d'],['e.ts','e'],['f.ts','f']].forEach(([name, key], i) => sandbox.files.set(String(i), { name, key, completed: true }));
  sandbox.render();
  assert.equal($('modifiedFileNames').textContent, 'a.ts,b.ts,c.ts,d.ts,e.ts,+1');
  assert.equal($('modifiedFileNames').title, 'a.ts,b.ts,c.ts,d.ts,e.ts,f.ts');
  assert.equal($('modifiedFiles').hidden, false);
  assert.match(html, /modifiedFileByCall\.clear\(\)/, 'a fresh show round clears the summary');
});

// These check the delivered guidance and API contracts, not model compliance with natural-language examples.
test('guide selects Todo by tracking value and avoids duplicate progress records', () => {
  for (const mode of ['apps', 'script']) for (const semantic of [false, true])
    for (const skills of [false, true]) for (const proxy of [false, true]) for (const processes of [false, true]) {
      const manual = buildGenericManual('exec', semantic, skills, proxy, processes, mode);
      const routing = manual.split('## TOOLS\n')[1].split('## EXECUTION')[0];
      for (const required of [
        /create a board only when.*user requests live task tracking/i,
        /separate outcomes.*dependencies.*recovery checkpoints/i,
        /reduces omissions or lost progress/i,
        /simple questions.*short read\/edit\/verify.*normally need no board/i,
        /tool count alone is not a trigger/i,
        /existing plan file.*durable progress/i,
        /add a board only for useful live milestones/i,
        /Task Contract or invoking a workflow does not itself require a board/i,
      ]) assert.match(routing, required);
      assert.doesNotMatch(routing, /persist the Task Contract \+ plan for substantial multi-step/);
      assert.ok(manual.includes('- Task Contract: establish Goal, Non-Goal, Success Criteria, and Verification before acting.'));
      assert.ok(manual.includes('- Verify — check actual results against the Goal and Success Criteria using fresh evidence.'));
      const final = manual.split('\n').find(x => x.startsWith('- Final Report'));
      assert.doesNotMatch(final, /todo read/); assert.match(final, /Conclusion/); assert.match(final, /Verification/);
      assert.match(manual, /never self-approve or bypass a denial/); assert.match(manual, /Scope Boundary/);
    }
});

test('recovery uses available task artifacts and only reads missing or stale state of an existing board', () => {
  for (const todo of [false, true]) {
    const text = buildExecutionGuidance({ execTool: 'exec', semantic: false, skills: false, todo });
    const recovery = text.split('\n').find(x => x.startsWith('- Recovery'));
    assert.match(recovery, /Task Contract and active step.*user task or existing plan file/i);
    assert.match(recovery, /re-check workspace state before continuing/i);
    if (todo) {
      assert.match(recovery, /todo read.*only.*missing or stale.*board already used for this task/i);
      assert.doesNotMatch(recovery, /after context loss, `todo read` once/);
    } else assert.doesNotMatch(text, /todo read/);
  }
});

test('Todo metadata makes tracking optional and describes milestone-sized updates without changing schema', async t => {
  const f = await fixture(t);
  const tool = (await f.client.listTools()).tools.find(x => x.name === 'todo');
  for (const required of [
    /optional live milestone tracking/i,
    /guide.*criteria for creating a board/i,
    /same task.*board across turns/i,
    /do not overwrite unrelated work/i,
    /outcomes, not individual files or tool calls/i,
    /patch.*unique content fragment/i,
    /verified completion.*next in_progress together/i,
    /real milestones, not per tool call or only at the end/i,
    /write.*replaces the complete list and optional Task Contract/i,
    /at most one in_progress/i,
    /include contract to retain it; omission clears it/i,
    /read.*missing or stale.*not routinely after successful updates or at completion/i,
  ]) assert.match(tool.description, required);
  assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['command', 'contract', 'sessionId', 'todos', 'updates']);
  assert.deepEqual(tool.inputSchema.properties.command.enum, ['read', 'write', 'patch']);
  assert.equal(tool.inputSchema.additionalProperties, false);
  const guide = await f.client.callTool({ name: 'guide', arguments: {} });
  assert.equal(guide.isError, false);
  assert.equal(f.changes(), 0, 'discovering tools and reading guidance must not create a task board');
});

test('one milestone patch returns completion and the next active step while preserving the contract', async t => {
  const f = await fixture(t);
  await f.call({ command: 'write', todos: [
    { content: 'implement the requested outcome', status: 'in_progress' },
    { content: 'verify the integrated outcome', status: 'pending' },
  ], contract });
  const before = f.changes();
  const response = await f.call({ command: 'patch', updates: [
    { content: 'implement the requested outcome', status: 'completed' },
    { content: 'verify the integrated outcome', status: 'in_progress' },
  ] });
  assert.equal(response.isError, false);
  const updated = json(response);
  assert.equal(updated.updated, 2); assert.equal(updated.completed_count, 1);
  assert.equal(updated.total, 2); assert.equal(updated.active.content, 'verify the integrated outcome');
  assert.equal(updated.active.status, 'in_progress');
  assert.equal(f.changes(), before + 1, 'related transitions persist together');
  assert.deepEqual(f.repo.get('session').contract, contract);
});
