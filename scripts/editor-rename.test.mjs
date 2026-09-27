import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerTools } from '../dist/mcp/tools.js';
import { SessionRuntime } from '../dist/runtime.js';
import { openDb } from '../dist/storage/db.js';
import { ToolCallsRepo } from '../dist/storage/toolCalls.js';
import { TodosRepo } from '../dist/storage/todos.js';
import { editorDelta } from '../dist/storage/activity.js';
import * as daemonNames from '../dist/tool-routing.js';
import { toolNames as vscodeNames } from './fixtures/tool-names.mjs';
import { mountPanel } from '../dist/panel/index.js';
import { panelHtml } from '../dist/panel/appHtml.js';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Only a historical identifier / negative-call input, never a registered alias.
const LEGACY = 'workspace_editor';
const SID = '1'.repeat(39);
const payload = reply => reply.structuredContent ?? JSON.parse(reply.content[0].text);

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-editor-rename-'));
  const storage = openDb(path.join(root, 'audit.sqlite'));
  const calls = new ToolCallsRepo(storage.db);
  const runtime = new SessionRuntime({ id: 'session', status: 'active', workspace_path: root, permission_mode: 'workspace-write' }, {});
  const server = new McpServer({ name: 'editor-rename', version: '1' });
  registerTools(server, id => id === SID ? runtime : { error: 'invalid session' }, {
    cfg: {}, toolCalls: calls, todos: new TodosRepo(storage.db), events: { append() {} },
    sessions: { byCredential: () => undefined }, semantic: { available: true },
  }, {});
  const client = new Client({ name: 'rename-contract', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); storage.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const call = (command, args = {}) => client.callTool({ name: 'editor', arguments: { sessionId: SID, path: 'sample.txt', operation: { command, ...args } } });
  return { root, runtime, calls, client, call, db: storage.db };
}

test('MCP publishes only editor, preserves context_search, and rejects the legacy name without executing', async t => {
  const f = await fixture(t);
  const { tools } = await f.client.listTools();
  const names = tools.map(tool => tool.name);
  assert.equal(names.filter(name => name === 'editor').length, 1);
  assert.equal(names.includes(LEGACY), false);
  assert.ok(names.includes('context_search'));
  assert.equal(JSON.stringify(tools).includes(LEGACY), false, 'no old tool routing in schema or descriptions');
  const rejected = await f.client.callTool({ name: LEGACY, arguments: { sessionId: SID, path: 'bad.txt', operation: { command: 'create', content: 'must not run' } } }).catch(error => ({ isError: true, error }));
  assert.equal(rejected.isError, true);
  assert.equal(fs.existsSync(path.join(f.root, 'bad.txt')), false);
  assert.equal(f.calls.countForSession('session'), 0);
});

test('editor keeps the five-operation contract, canonical audit name, and read-only / path guards', async t => {
  const f = await fixture(t);
  assert.equal(payload(await f.call('create', { content: 'one\ntwo\n' })).result.isError, false);
  assert.match(payload(await f.call('view')).result.message, /two/);
  assert.equal(payload(await f.call('str_replace', { old_text: 'two', new_text: 'three' })).result.isError, false);
  assert.equal(payload(await f.call('insert', { line: 0, content: 'zero' })).result.isError, false);
  assert.equal(fs.readFileSync(path.join(f.root, 'sample.txt'), 'utf8'), 'zero\none\nthree\n');
  assert.equal(payload(await f.call('delete')).result.isError, false);
  assert.equal(fs.existsSync(path.join(f.root, 'sample.txt')), false);
  const rows = f.calls.listForSession('session');
  assert.equal(rows.length, 5); assert.ok(rows.every(row => row.tool === 'editor' && row.status === 'completed'));
  assert.equal(rows.filter(row => row.navigation_json).length, 4, 'view has no navigation metadata');
  f.runtime.session.permission_mode = 'read-only';
  assert.equal((await f.call('create', { content: 'denied' })).isError, true);
  f.runtime.session.permission_mode = 'workspace-write';
  const escape = await f.client.callTool({ name: 'editor', arguments: { sessionId: SID, path: '../escape.txt', operation: { command: 'create', content: 'denied' } } });
  assert.equal(escape.isError, true);
});

test('daemon and independent VS Code build share one naming contract, without matching proxy tools', () => {
  assert.equal(daemonNames.WORKSPACE_FILE_TOOL, 'editor');
  for (const tool of ['editor', LEGACY, 'context_search', 'proxy/editor', 'proxy', 'text_editor']) {
    assert.equal(vscodeNames.isWorkspaceFileTool(tool), daemonNames.isWorkspaceFileTool(tool));
    assert.equal(vscodeNames.displayToolName(tool), daemonNames.displayToolName(tool));
    assert.equal(daemonNames.isWorkspaceFileTool(tool), tool === 'editor' || tool === LEGACY);
    assert.equal(daemonNames.displayToolName(tool), tool === LEGACY ? 'editor' : tool);
  }
});

test('old and new audit rows retain their original identity, deltas, and bounded summaries', async t => {
  const f = await fixture(t);
  const summary = JSON.stringify({ result: { message: 'done', isError: false, diff: { added: 3, removed: 1 } } });
  for (const tool of [LEGACY, 'editor']) {
    const row = f.calls.start('session', tool, '{}', 'hash');
    f.calls.finish(row.id, 'completed', summary);
    f.calls.finish(row.id, 'completed', summary);
    assert.equal(f.calls.get(row.id).tool, tool);
    assert.equal(f.calls.get(row.id).diff_added, 3);
    assert.equal(f.calls.get(row.id).diff_removed, 1);
    assert.deepEqual(editorDelta(tool, 'completed', summary), { added: 3, removed: 1 });
    assert.deepEqual(editorDelta(tool, 'failed', summary), { added: 0, removed: 0 });
    const large = f.calls.start('session', tool, '{}', 'large');
    f.calls.finish(large.id, 'completed', JSON.stringify({ result: { message: 'x'.repeat(40000), diff: { added: 2, removed: 0 } } }));
    assert.ok(Buffer.byteLength(f.calls.get(large.id).result_summary) <= 32768);
    assert.deepEqual(JSON.parse(f.calls.get(large.id).result_summary).result.diff, { added: 2, removed: 0 });
  }
  assert.deepEqual(editorDelta('proxy/editor', 'completed', summary), { added: 0, removed: 0 });
  assert.deepEqual({ ...f.db.prepare('SELECT SUM(total) AS total,SUM(diff_added) AS added,SUM(diff_removed) AS removed FROM daily_activity').get() }, { total: 4, added: 10, removed: 2 }, 'repeated finish never double-counts either historical identity');
});

test('Panel normalizes mixed historical rows without leaking source or navigation metadata', async t => {
  const f = await fixture(t);
  for (const [tool, file] of [[LEGACY, 'old.ts'], ['editor', 'new.ts']]) {
    const args = JSON.stringify({ path: file, operation: { command: 'create', content: 'private source' } });
    const row = f.calls.start('session', tool, args, 'hash');
    f.calls.finish(row.id, 'completed', JSON.stringify({ result: { message: 'private output', diff: { added: 1, removed: 0 } } }), JSON.stringify({ version: 1, kind: 'create', path: file }));
  }
  const handlers = new Map();
  const app = new Proxy({}, { get: (_, method) => (...args) => { if (method === 'get') handlers.set(args[0], args.at(-1)); return app; } });
  mountPanel(app, {
    cfg: {}, sessions: { get: () => ({ id: 'session', status: 'active' }) }, changes: { epoch: () => 1 },
    toolCalls: f.calls, todos: { get: () => ({ items: [], updated_at: 0 }) }, confirmations: { expireStale() {}, list: () => [] },
  }, { terminalReason: () => undefined, sessionOf: () => 'session', startSeqFor: () => 0, todosChangedSinceMount: () => false }, { pruneSession() {} }, () => {});
  const response = { status() { return this; }, json(body) { this.body = body; }, end() {} };
  handlers.get('/:key/data')({ params: { key: 'test' }, query: {} }, response);
  assert.deepEqual(response.body.calls.map(row => row.tool), ['editor', 'editor']);
  for (const row of response.body.calls) {
    assert.deepEqual(row.diff, { added: 1, removed: 0 });
    assert.equal(JSON.parse(row.args_json).command, 'create');
    assert.equal('navigation_json' in row, false); assert.equal('result_summary' in row, false); assert.equal(typeof row.duration_ms, 'number');
    assert.equal('created_at' in row, false); assert.equal('updated_at' in row, false);
    assert.equal(JSON.stringify(row).includes('private source'), false);
  }
  assert.equal(f.calls.listForSession('session').some(row => row.tool === LEGACY), true, 'display projection does not rewrite persisted history');
});

test('Panel filename summary accepts both names, excludes view, and keeps comma-only deduplication', () => {
  const html = panelHtml();
  const start = html.indexOf('  const modifiedFileByCall = new Map();');
  const end = html.indexOf('  function resetRound(start)', start);
  const nodes = new Map();
  const $ = key => { if (!nodes.has(key)) nodes.set(key, { textContent: '', title: '', removeAttribute() {} }); return nodes.get(key); };
  const context = { $ };
  vm.runInNewContext(html.slice(start, end) + '\nthis.fact=modifiedFileFact;this.files=modifiedFileByCall;this.render=renderModifiedFiles;', context);
  const row = (tool, file, command = 'create') => ({ tool, status: 'completed', diff: { added: 1, removed: 0 }, args_json: JSON.stringify({ command, path: file }) });
  for (const tool of [LEGACY, 'editor']) assert.equal(context.fact(row(tool, 'read.ts', 'view')), null);
  context.files.set('1', context.fact(row(LEGACY, 'same.ts')));
  context.files.set('2', context.fact(row('editor', 'same.ts')));
  context.files.set('3', context.fact(row('editor', 'new.ts')));
  context.render();
  assert.equal($('#modifiedFileNames').textContent, 'same.ts,new.ts');
  assert.equal($('#modifiedFileNames').title, 'same.ts,new.ts');
  assert.equal($('#modifiedFiles').hidden, false);
});

test('the old identifier is confined to explicit history / migration exceptions', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const allowed = new Set([
    'src/tool-routing.ts', 'packages/vscode/src/toolNames.ts',
    'scripts/editor-rename.test.mjs', 'scripts/rename-editor-references.mjs',
    'packages/vscode/CHANGELOG.md',
  ]);
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', windowsHide: true }).split('\0').filter(Boolean);
  const unexpected = [];
  for (const file of new Set(files)) {
    if (allowed.has(file) || !/\.(?:ts|js|mjs|cjs|json|py|md|ya?ml)$/.test(file) || !fs.existsSync(path.join(root, file))) continue;
    if (fs.readFileSync(path.join(root, file), 'utf8').includes(LEGACY)) unexpected.push(file);
  }
  assert.deepEqual(unexpected, []);
  for (const file of ['src/tool-routing.ts', 'packages/vscode/src/toolNames.ts']) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.equal(source.split(LEGACY).length - 1, 1, `${file}: only the historical constant may contain the old identifier`);
  }
});

