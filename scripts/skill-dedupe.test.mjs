import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerTools } from '../dist/mcp/tools.js';
import { SessionRuntime } from '../dist/runtime.js';
import { readSkillResource } from '../dist/workspace/skills.js';

const SID = '1'.repeat(39), OTHER = '2'.repeat(39);
const json = result => result.structuredContent ?? JSON.parse(result.content[0].text);
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function fixture(t, extra = {}) {
  fs.mkdirSync('.cache/tests', { recursive: true });
  const dir = fs.mkdtempSync(path.resolve('.cache/tests/skill-dedupe-'));
  const root = path.join(dir, 'skills'), workspace = path.join(dir, 'workspace');
  fs.mkdirSync(workspace);
  for (const name of ['a', 'b']) {
    fs.mkdirSync(path.join(root, name, 'references'), { recursive: true });
    fs.writeFileSync(path.join(root, name, 'SKILL.md'), `# ${name}\nComplete main document\n`);
    fs.writeFileSync(path.join(root, name, 'references', 'details.md'), '# Attachment\nEND\n');
  }
  const runtime = () => new SessionRuntime({ id: String(Math.random()), workspace_path: workspace, permission_mode: 'read-only' }, {});
  const runtimes = new Map([[SID, runtime()], [OTHER, runtime()]]);
  const rows = new Map(), events = [];
  const deps = {
    cfg: { skillsDir: root },
    events: { append: (...args) => events.push(args) },
    toolCalls: {
      start: () => { const row = { id: String(rows.size), status: 'started' }; rows.set(row.id, row); return row; },
      get: id => rows.get(id),
      finish: (id, status, summary) => Object.assign(rows.get(id), { status, summary }),
    },
    sessions: { byCredential: () => undefined },
    todos: { get: () => ({ items: [] }) },
    ...extra,
  };
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  async function connect(capabilities = {}) {
    const server = new McpServer({ name: 'dedupe-fixture', version: '1' });
    registerTools(server, id => runtimes.get(id) ?? { error: 'invalid fixture session' }, deps,
      { execDescription: 'Fixture only; no real command execution.' });
    const client = new Client({ name: 'dedupe-client', version: '1' }, { capabilities });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st); await client.connect(ct);
    t.after(async () => { await client.close(); await server.close(); });
    return {
      client, server,
      call: (name, args = {}) => client.callTool({ name, arguments: { sessionId: SID, ...args } }),
      read: (args = {}) => client.callTool({ name: 'skill', arguments: { sessionId: SID, name: 'a', ...args } }),
    };
  }
  return { root, workspace, runtimes, rows, events, deps, connect };
}
function full(result) { assert.equal(result.isError, false); assert.equal(json(result).complete, true); assert.equal(typeof json(result).content, 'string'); }
function duplicate(result) {
  assert.equal(result.isError, true);
  assert.equal(json(result).code, 'SKILL_ALREADY_PROVIDED');
  assert.equal(json(result).content, undefined);
}

test('same resource repeats fail, attachments and other skills remain independently readable', async t => {
  const f = fixture(t), c = await f.connect();
  full(await c.read());
  full(await c.read({ path: 'references/details.md' }));
  full(await c.read({ name: 'b' }));
  duplicate(await c.read());
  duplicate(await c.read({ path: 'references/details.md' }));
  duplicate(await c.read({ name: 'b' }));
});
test('library discovery, directory pages, tools/list and reconnect do not reset', async t => {
  const f = fixture(t), c = await f.connect();
  full(await c.read());
  await c.call('skill'); await c.read({ path: '.' }); await c.client.listTools();
  duplicate(await c.read());
  const anotherConnection = await f.connect();
  duplicate(await anotherConnection.read());
});
test('runtime identities isolate sessions, including independent daemons with equal row ids', async t => {
  const f = fixture(t), c = await f.connect();
  f.runtimes.get(OTHER).session.id = f.runtimes.get(SID).session.id;
  full(await c.read()); full(await c.read({ sessionId: OTHER }));
  duplicate(await c.read());
  await c.call('todo', { command: 'read', sessionId: OTHER });
  duplicate(await c.read());
});
test('keyless and unknown-session reads stay available and do not clear tracked state', async t => {
  const f = fixture(t), c = await f.connect();
  full(await c.read());
  for (const sessionId of [undefined, '3'.repeat(39)]) {
    full(await c.read({ sessionId })); full(await c.read({ sessionId }));
  }
  await c.call('guide', { sessionId: '3'.repeat(39) });
  duplicate(await c.read());
});
test('other tools reset on entry, including business failures; invalid schema/session does not', async t => {
  const f = fixture(t), c = await f.connect();
  full(await c.read());
  await c.call('todo', { command: 'read' }); full(await c.read());
  await c.call('todo', { command: 'read', updates: [{ content: 'invalid combination', status: 'completed' }] });
  full(await c.read());
  await c.call('editor', { path: '../not-in-workspace', operation: { command: 'view' } });
  full(await c.read());
  await c.call('todo', { command: 'not-a-command' }).catch(() => {});
  duplicate(await c.read());
  await c.call('todo', { command: 'read', sessionId: '3'.repeat(39) });
  duplicate(await c.read());
  await c.call('guide'); full(await c.read());
});
test('the untracked panel-handler failure path resets without mounting any UI', async t => {
  const f = fixture(t), c = await f.connect({ extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } });
  full(await c.read());
  // Apps client, but no panel backend. Isolated handler; never invokes the operator show tool.
  const handler = c.server._registeredTools.show.handler;
  assert.equal(json(await handler({ sessionId: SID }, {})).status, 'unavailable');
  full(await c.read());
});
test('proxy resets before asynchronous catalog resolution, not only in call tracking', async t => {
  const entered = deferred(), release = deferred();
  const proxy = { secretValues: [], servers: [], registry: { resolveGlobal: async () => { entered.resolve(); await release.promise; return undefined; } } };
  const f = fixture(t, { proxy }), c = await f.connect();
  full(await c.read());
  const pending = c.call('proxy', { command: 'explain', tool: 'fixture-missing' });
  try { await entered.promise; full(await c.read()); } finally { release.resolve(); await pending; }
});
test('reload re-provides only the requested file; unchanged retries still fail', async t => {
  const f = fixture(t), c = await f.connect();
  full(await c.read()); full(await c.read({ name: 'b' }));
  full(await c.read({ reload: true })); duplicate(await c.read()); duplicate(await c.read({ name: 'b' }));
  const bad = await c.read({ path: '.', reload: true });
  assert.equal(bad.isError, true); assert.equal(json(bad).status, 'invalid_request');
  duplicate(await c.read());
});
test('content changes, read failures and read recovery do not produce false duplicates', async t => {
  const f = fixture(t), c = await f.connect();
  full(await c.read());
  const file = path.join(f.root, 'a', 'SKILL.md');
  const original = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, original.replace('Complete', 'Modified')); // same length
  const changed = await c.read(); full(changed); assert.match(json(changed).content, /Modified/);
  duplicate(await c.read());
  const missing = await c.read({ path: 'new.md' }); assert.equal(missing.isError, true);
  fs.writeFileSync(path.join(f.root, 'a', 'new.md'), 'new text'); full(await c.read({ path: 'new.md' }));
  fs.writeFileSync(path.join(f.root, 'a', 'large.txt'), Buffer.alloc(256 * 1024 + 1));
  assert.equal(json(await c.read({ path: 'large.txt' })).status, 'too_large');
  fs.writeFileSync(path.join(f.root, 'a', 'large.txt'), 'small'); full(await c.read({ path: 'large.txt' }));
});
test('normalized paths, platform case aliases and root junction aliases share identity', async t => {
  const f = fixture(t), c = await f.connect();
  full(await c.read({ path: './SKILL.md' })); duplicate(await c.read());
  if (process.platform === 'win32') duplicate(await c.read({ name: 'A', path: 'skill.md' }));
  fs.symlinkSync(path.join(f.root, 'a'), path.join(f.root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  duplicate(await c.read({ name: 'alias' }));
  full(await c.read({ path: 'references/details.md' })); duplicate(await c.read({ path: 'references\\details.md' }));
});
test('concurrent real SDK reads return one body, and audit failure leaves the file retryable', async t => {
  const f = fixture(t), c = await f.connect(), d = await f.connect();
  const results = await Promise.all([c.read(), d.read(), c.read()]);
  assert.equal(results.filter(r => !r.isError).length, 1);
  assert.equal(results.filter(r => json(r).code === 'SKILL_ALREADY_PROVIDED').length, 2);
  await c.call('todo', { command: 'read' });
  const finish = f.deps.toolCalls.finish;
  let failOnce = true;
  f.deps.toolCalls.finish = (...args) => { if (failOnce && args[1] === 'completed') { failOnce = false; throw new Error('fixture persistence failure'); } return finish(...args); };
  assert.equal((await c.read()).isError, true);
  full(await c.read());
});
test('resource identity is opaque, version matches bytes, and changed-during-read is explicit', t => {
  const f = fixture(t);
  const first = readSkillResource(f.root, 'a');
  assert.match(first.resource_id, /^[a-f0-9]{64}$/);
  assert.match(first.version, /^[a-f0-9]{64}$/);
  assert.equal(first.version, createHash('sha256').update(fs.readFileSync(path.join(f.root, 'a', 'SKILL.md'))).digest('hex'));
  const original = fs.readSync;
  let changed = false;
  t.mock.method(fs, 'readSync', function(...args) {
    const n = original.apply(this, args);
    if (!changed && n) { changed = true; fs.appendFileSync(path.join(f.root, 'a', 'SKILL.md'), 'CHANGED'); }
    return n;
  });
  assert.throws(() => readSkillResource(f.root, 'a'), e => e.code === 'resource_changed');
});

test('state machine: failures/rejections/cancellation release the lock and never mark success', async () => {
  const { SkillReadState } = await import('../dist/workspace/skill-read-state.js');
  const s = new SkillReadState(), phase = s.capture();
  const ok = async () => ({ isError: false, kind: 'body' }), dup = async () => ({ isError: true, kind: 'duplicate' });
  await assert.rejects(s.provide(phase, 'file', 'v', false, async () => { throw new Error('failed'); }, dup));
  await s.provide(phase, 'file', 'v', false, async () => ({ isError: true }), dup);
  await s.provide(phase, 'file', 'v', false, ok, dup, () => true);
  assert.equal((await s.provide(phase, 'file', 'v', false, ok, dup)).kind, 'body');
  assert.equal((await s.provide(phase, 'file', 'v', false, ok, dup)).kind, 'duplicate');
});
test('state machine: reset detaches old pending work and prevents stale completion from polluting the new phase', async () => {
  const { SkillReadState } = await import('../dist/workspace/skill-read-state.js');
  const s = new SkillReadState(), old = s.capture(), entered = deferred(), release = deferred();
  const ok = async () => ({ isError: false, kind: 'body' }), dup = async () => ({ isError: true, kind: 'duplicate' });
  const pending = s.provide(old, 'file', 'old-version', false, async () => { entered.resolve(); await release.promise; return ok(); }, dup);
  await entered.promise; s.reset(); const current = s.capture();
  assert.equal((await s.provide(current, 'file', 'new-version', false, ok, dup)).kind, 'body');
  release.resolve(); await pending;
  assert.equal((await s.provide(current, 'file', 'new-version', false, ok, dup)).kind, 'duplicate');
  assert.equal((await s.provide(current, 'file', 'old-version', false, ok, dup)).kind, 'body');
});
test('state machine: independent resources can progress while one resource is pending', async () => {
  const { SkillReadState } = await import('../dist/workspace/skill-read-state.js');
  const s = new SkillReadState(), phase = s.capture(), entered = deferred(), release = deferred();
  const ok = async () => ({ isError: false }), dup = async () => ({ isError: true });
  const pending = s.provide(phase, 'a', 'v', false, async () => { entered.resolve(); await release.promise; return ok(); }, dup);
  await entered.promise;
  try { assert.equal((await s.provide(phase, 'b', 'v', false, ok, dup)).isError, false); } finally { release.resolve(); await pending; }
});

test('cancelled handlers neither read before admission nor poison subsequent retries', async t => {
  const f = fixture(t), c = await f.connect();
  const before = new AbortController(); before.abort();
  const handler = c.server._registeredTools.skill.handler;
  assert.equal(json(await handler({ sessionId: SID, name: 'a' }, { signal: before.signal })).status, 'cancelled');
  full(await c.read());
  await c.call('todo', { command: 'read' });
  const after = new AbortController(), append = f.deps.events.append;
  f.deps.events.append = (...args) => { if (args[1] === 'skill_fetched') after.abort(); return append(...args); };
  await handler({ sessionId: SID, name: 'a' }, { signal: after.signal });
  f.deps.events.append = append;
  full(await c.read()); duplicate(await c.read());
});
test('all required-session tools reset at admission even before their business work', async t => {
  const f = fixture(t, { semantic: { available: true } }), c = await f.connect();
  for (const [name, args] of [
    ['exec', { command: 'fixture command never executed' }],
    ['context_search', { query: 'fixture search never executed' }],
  ]) {
    full(await c.read({ reload: true })); duplicate(await c.read());
    // A deterministic failure at the audit boundary prevents any command,
    // semantic request, approval or external side effect from being executed.
    const start = f.deps.toolCalls.start;
    f.deps.toolCalls.start = () => { throw new Error('fixture stop before business work'); };
    try { await c.call(name, args).catch(() => {}); } finally { f.deps.toolCalls.start = start; }
    full(await c.read());
  }
});
test('eviction is bounded and fail-open; it never rejects a new resource', async () => {
  const { SkillReadState } = await import('../dist/workspace/skill-read-state.js');
  const s = new SkillReadState(), phase = s.capture();
  const ok = async () => ({ isError: false }), dup = async () => ({ isError: true });
  for (let i = 0; i < 513; i++) assert.equal((await s.provide(phase, String(i), 'v', false, ok, dup)).isError, false);
  assert.equal((await s.provide(phase, '512', 'v', false, ok, dup)).isError, true);
  assert.equal((await s.provide(phase, '0', 'v', false, ok, dup)).isError, false);
});
test('new HTTP protocol connections share logical state and explicit recovery preserves wire contracts', async t => {
  const f = fixture(t);
  const { default: express } = await import('express');
  const { createServer } = await import('node:http');
  const { createHash, randomUUID } = await import('node:crypto');
  const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const app = express(); app.use(express.json());
  const http = createServer(app), servers = [], clients = [];
  try {
    for (const endpoint of ['first', 'fresh']) {
      const server = new McpServer({ name: 'http-phase-fixture', version: '1' });
      registerTools(server, id => f.runtimes.get(id) ?? { error: 'invalid' }, f.deps,
        { execDescription: 'Never executed.' });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true });
      await server.connect(transport); servers.push(server);
      app.all(`/${endpoint}`, (req, res) => { transport.handleRequest(req, res, req.body).catch(() => { if (!res.headersSent) res.sendStatus(500); }); });
    }
    await new Promise((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve); });
    for (const endpoint of ['first', 'fresh']) {
      const client = new Client({ name: 'http-phase-client', version: '1' }, { capabilities: {} });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${http.address().port}/${endpoint}`)));
      clients.push(client);
    }
    const args = { sessionId: SID, name: 'a', path: 'references/details.md' };
    const first = await clients[0].callTool({ name: 'skill', arguments: args }); full(first);
    assert.equal(first.structuredContent.version, createHash('sha256').update(first.structuredContent.content).digest('hex'));
    duplicate(await clients[1].callTool({ name: 'skill', arguments: args }));
    const reload = await clients[1].callTool({ name: 'skill', arguments: { ...args, reload: true } }); full(reload);
    assert.deepEqual(JSON.parse(reload.content[0].text), reload.structuredContent);
    assert.equal(reload.structuredContent.content, first.structuredContent.content);
    await clients[0].callTool({ name: 'todo', arguments: { sessionId: SID, command: 'read' } });
    full(await clients[1].callTool({ name: 'skill', arguments: args }));
    duplicate(await clients[0].callTool({ name: 'skill', arguments: args }));
  } finally {
    for (const client of clients) await client.close();
    for (const server of servers) await server.close();
    http.closeAllConnections(); if (http.listening) await new Promise(resolve => http.close(resolve));
  }
});

test('cached success never bypasses a subsequently escaping resource link', async t => {
  const f = fixture(t), c = await f.connect();
  full(await c.read({ path: 'references/details.md' }));
  const reference = path.join(f.root, 'a', 'references');
  fs.renameSync(reference, reference + '-saved');
  const outside = path.join(f.workspace, 'outside-reference');
  fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'details.md'), 'OUTSIDE MUST NOT BE RETURNED');
  fs.symlinkSync(outside, reference, process.platform === 'win32' ? 'junction' : 'dir');
  const result = await c.read({ path: 'references/details.md' });
  assert.equal(result.isError, true); assert.equal(json(result).status, 'invalid_path');
  assert.doesNotMatch(result.content[0].text, /OUTSIDE MUST NOT BE RETURNED/);
});
test('a failed pending read releases the next reader without a false duplicate', async () => {
  const { SkillReadState } = await import('../dist/workspace/skill-read-state.js');
  const s = new SkillReadState(), phase = s.capture(), entered = deferred(), release = deferred();
  const ok = async () => ({ isError: false }), dup = async () => ({ isError: true });
  const first = s.provide(phase, 'file', 'v', false, async () => { entered.resolve(); await release.promise; throw new Error('fixture failure'); }, dup);
  const rejected = assert.rejects(first, /fixture failure/);
  await entered.promise;
  const next = s.provide(phase, 'file', 'v', false, ok, dup);
  release.resolve(); await rejected;
  assert.equal((await next).isError, false);
  assert.equal((await s.provide(phase, 'file', 'v', false, ok, dup)).isError, true);
});
