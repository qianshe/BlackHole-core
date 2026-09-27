import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { openDb } from '../dist/storage/db.js';
import { SessionsRepo } from '../dist/storage/sessions.js';
import { HandoffsRepo } from '../dist/storage/handoffs.js';
import { TodosRepo } from '../dist/storage/todos.js';
import { SessionRuntime } from '../dist/runtime.js';
import { registerTools } from '../dist/mcp/tools.js';
import { activityToolRegistrar } from '../dist/mcp/activity-tools.js';

const payload = result => result.structuredContent ?? JSON.parse(result.content[0].text);
const reply = (data, isError = false) => ({ isError, structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function storage(t) {
  const { db, close } = openDb(':memory:');
  const sessions = new SessionsRepo(db), handoffs = new HandoffsRepo(db);
  const row = sessions.create({ workspace_path: process.cwd(), permission_mode: 'read-only' });
  t.after(close);
  return { db, sessions, handoffs, row };
}

async function fixture(t, options = {}) {
  const f = storage(t), audit = [], rows = new Map();
  const runtime = new SessionRuntime(f.row, {});
  const server = new McpServer({ name: 'handoff-test', version: '1' });
  registerTools(server, sid => {
    const row = f.sessions.byCredential(sid);
    if (!row || row.status !== 'active' || (row.expires_at !== null && row.expires_at < Date.now())) return { error: 'session unavailable' };
    runtime.session = row;
    return runtime;
  }, {
    cfg: {}, sessions: f.sessions, handoffs: f.handoffs, todos: new TodosRepo(f.db),
    events: { append: (...args) => audit.push(args) },
    toolCalls: {
      start(sessionId, tool, args_json) { const row = { id: String(rows.size), sessionId, tool, args_json, status: 'started' }; rows.set(row.id, row); return row; },
      get: id => rows.get(id),
      finish(id, status, summary) { if (options.finishFails) throw Error('injected audit failure'); Object.assign(rows.get(id), { status, summary }); },
    },
  }, { execDescription: 'Fixture: commands are not executed.' });
  const client = new Client({ name: 'handoff-test-client', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); });
  const call = (name, args = {}) => client.callTool({ name, arguments: { sessionId: f.row.credential_id, ...args } });
  return { ...f, client, call, audit, rows };
}

test('handoff SDK tool saves one context, never echoes or audits the body, and real editor work consumes it', async t => {
  const f = await fixture(t);
  const tool = (await f.client.listTools()).tools.find(x => x.name === 'guide');
  assert.ok(tool.inputSchema.properties.content);
  assert.equal(tool.annotations.readOnlyHint, false);
  assert.equal(tool.inputSchema.additionalProperties, false);
  const content = 'Unique continuation body: verify the pending feature.\ntask：';
  const saved = payload(await f.call('guide', { workflow: 'handoff', content }));
  assert.equal(saved.status, 'saved'); assert.equal(f.handoffs.get(f.row.id).content, content);
  assert.ok(!JSON.stringify(saved).includes(content));
  assert.ok(!JSON.stringify([...f.rows.values(), f.audit]).includes(content));
  assert.ok(!JSON.stringify([...f.rows.values(), f.audit]).includes(f.row.credential_id));
  await f.call('guide'); await f.call('todo', { command: 'read' });
  assert.equal(f.handoffs.pendingId(f.row.id), saved.id);
  const failed = await f.call('editor', { path: 'missing-handoff-fixture.txt', operation: { command: 'view' } });
  assert.equal(failed.isError, true); assert.equal(f.handoffs.pendingId(f.row.id), saved.id);
  const successful = await f.call('editor', { path: 'package.json', operation: { command: 'view', view_range: [1,4] } });
  assert.equal(successful.isError, false); assert.equal(f.handoffs.get(f.row.id), null);
});

test('invalid submissions preserve pending content and do not disclose body in rejection history', async t => {
  const f = await fixture(t);
  const saved = payload(await f.call('guide', { workflow: 'handoff', content: 'keep this pending context' }));
  for (const args of [
    { content: '   ' }, { content: '中'.repeat(22000) },
    { content: `sensitive-context-${f.row.credential_id}` },
    { content: 'invalid-session-body', sessionId: '000000000000000000000000000000000000001' },
    { content: 'not accepted', unexpected: true },
  ]) {
    const result = await f.call('guide', { workflow: 'handoff', ...args });
    assert.equal(result.isError, true); assert.equal(f.handoffs.pendingId(f.row.id), saved.id);
    assert.ok(!JSON.stringify([...f.rows.values(), f.audit]).includes(args.content));
  }
  f.sessions.setStatus(f.row.id, 'paused');
  assert.equal((await f.call('guide', { workflow: 'handoff', content: 'paused-session-body' })).isError, true);
  assert.equal(f.handoffs.pendingId(f.row.id), saved.id);
});

test('replacement is acknowledged with a new ID and guide workflow discovery never publishes context', async t => {
  const f = await fixture(t);
  const first = payload(await f.call('guide', { workflow: 'handoff', content: 'first' }));
  const second = payload(await f.call('guide', { workflow: 'handoff', content: 'second' }));
  assert.notEqual(first.id, second.id); assert.equal(f.handoffs.get(f.row.id).content, 'second');
  const guide = await f.call('guide', { workflow: 'handoff' });
  assert.match(payload(guide).manual, /submit the context with `guide/);
  assert.equal(f.handoffs.pendingId(f.row.id), second.id);
});

function trackedFixture(t, repoOverride) {
  const f = storage(t), handlers = new Map(), logs = [];
  const register = activityToolRegistrar({ registerTool(name, _config, handler) { handlers.set(name, handler); } }, {
    sessions: f.sessions, handoffs: repoOverride?.(f.handoffs) ?? f.handoffs, log: line => logs.push(line),
  });
  return {
    ...f, logs,
    run(name, input, callback, signal = new AbortController().signal) {
      register(name, { inputSchema: {} }, callback);
      return handlers.get(name)({ sessionId: f.row.credential_id, ...input }, { signal });
    },
  };
}

const cases = [
  ['guide', {}, {}, false], ['show', {}, {}, false], ['skill', {}, { status: 'ok' }, false],
  ['guide', { workflow: 'handoff', content: 'pending' }, { status: 'saved' }, false], ['todo', { command: 'read' }, { status: 'ok' }, false],
  ['process', { command: 'status' }, { status: 'ok', state: 'running' }, false],
  ['process', { command: 'list' }, { status: 'ok' }, false],
  ['proxy', { command: 'list' }, { status: 'ok' }, false], ['proxy', { command: 'explain' }, { status: 'ok' }, false],
  ['proxy', { command: 'cancel' }, { status: 'ok' }, false],
  ['exec', {}, { exit_code: 1 }, false], ['exec', {}, { exit_code: 0, timed_out: true }, false],
  ['exec', {}, { exit_code: 0, command_started: false }, false], ['exec', {}, { exit_code: null }, false],
  ['editor', {}, { result: { isError: true } }, false], ['context_search', {}, { result: { isError: true } }, false],
  ['process', { command: 'stop' }, { status: 'ok', state: 'unknown' }, false],
  ['process', { command: 'start' }, { status: 'error', state: 'failed' }, false],
  ['process', { command: 'start' }, { status: 'ok', state: 'exited', exitCode: 1 }, false],
  ['proxy', { command: 'call' }, { status: 'denied' }, false],
  ['todo', { command: 'patch' }, { status: 'rejected' }, false],
  ['exec', {}, { exit_code: 0 }, true], ['editor', {}, { result: { isError: false } }, true],
  ['context_search', {}, { result: { isError: false, files: [] } }, true],
  ['todo', { command: 'write' }, { status: 'ok' }, true], ['todo', { command: 'patch' }, { status: 'ok' }, true],
  ['process', { command: 'start' }, { status: 'ok', state: 'running' }, true],
  ['process', { command: 'stop' }, { status: 'ok', state: 'exited' }, true],
  ['proxy', { command: 'call' }, { status: 'ok' }, true],
];
test('only successful business work consumes; queries, command failures and uncertain process states do not', async t => {
  const f = trackedFixture(t);
  for (const [name, input, data, consumes] of cases) {
    const pending = f.handoffs.set(f.row.id, 'preserve until success');
    const result = reply(data);
    assert.equal(await f.run(name, input, async () => result), result, 'original result remains unchanged');
    assert.equal(f.handoffs.pendingId(f.row.id), consumes ? undefined : pending.id, `${name} ${JSON.stringify(input)} ${JSON.stringify(data)}`);
  }
  const pending = f.handoffs.set(f.row.id, 'still pending');
  await f.run('exec', {}, async () => reply({ exit_code: 0 }, true));
  assert.equal(f.handoffs.pendingId(f.row.id), pending.id);
  await f.run('exec', {}, async () => ({ content: [] }));
  assert.equal(f.handoffs.pendingId(f.row.id), pending.id);
});

test('in-flight old work cannot delete a newer submission or one created after that work began', async t => {
  const f = trackedFixture(t), gate = deferred();
  const beforeSubmission = f.run('editor', {}, async () => { await gate.promise; return reply({ result: { isError: false } }); });
  const first = f.handoffs.set(f.row.id, 'first');
  gate.resolve(); await beforeSubmission;
  assert.equal(f.handoffs.pendingId(f.row.id), first.id);
  const secondGate = deferred();
  const beforeReplacement = f.run('exec', {}, async () => { await secondGate.promise; return reply({ exit_code: 0 }); });
  const second = f.handoffs.set(f.row.id, 'second');
  secondGate.resolve(); await beforeReplacement;
  assert.equal(f.handoffs.pendingId(f.row.id), second.id);
});

test('other sessions, cancellation, throws and credential rotation never consume the captured context', async t => {
  const f = trackedFixture(t), other = f.sessions.create({ workspace_path: process.cwd(), permission_mode: 'read-only' });
  const saved = f.handoffs.set(f.row.id, 'pending');
  await f.run('exec', { sessionId: other.credential_id }, async () => reply({ exit_code: 0 }));
  assert.equal(f.handoffs.pendingId(f.row.id), saved.id);
  const abort = new AbortController(); abort.abort();
  await f.run('exec', {}, async () => reply({ exit_code: 0 }), abort.signal);
  assert.equal(f.handoffs.pendingId(f.row.id), saved.id);
  await assert.rejects(f.run('exec', {}, async () => { throw Error('failed handler'); }), /failed handler/);
  assert.equal(f.handoffs.pendingId(f.row.id), saved.id);
  await f.run('exec', {}, async () => { f.sessions.rotateCredential(f.row.id); return reply({ exit_code: 0 }); });
  assert.equal(f.handoffs.pendingId(f.row.id), saved.id);
});

test('cleanup failure leaves successful work successful and the pending document intact', async t => {
  const f = trackedFixture(t, repo => ({ pendingId: id => repo.pendingId(id), consume() { throw Error('write unavailable'); } }));
  const saved = f.handoffs.set(f.row.id, 'pending'), result = reply({ exit_code: 0 });
  assert.equal(await f.run('exec', {}, async () => result), result);
  assert.equal(f.handoffs.pendingId(f.row.id), saved.id); assert.equal(f.logs.length, 1);
});

// Public SDK regression for the new, single guide submission boundary.
test('guide submission is explicit, strictly validated and never leaks rejected context', async t => {
  const f = await fixture(t);
  const tools = (await f.client.listTools()).tools;
  const guide = tools.find(x => x.name === 'guide');
  assert.ok(guide.inputSchema.properties.content);
  assert.equal(guide.inputSchema.additionalProperties, false);
  assert.ok(!tools.some(x => x.name === 'handoff'));
  const content = 'GUIDE-PRIVATE-MARKER-734 task context';
  const saved = payload(await f.call('guide', { workflow: 'handoff', content }));
  assert.equal(saved.status, 'saved');
  assert.equal(saved.manual, '');
  assert.ok(saved.id); assert.equal(typeof saved.created_at, 'number');
  assert.equal(saved.bytes, Buffer.byteLength(content));
  for (const args of [
    { content }, { workflow: 'review', content },
    { workflow: 'handoff', tool: 'exec', content },
    { workflow: 'handoff', content: '' }, { workflow: 'handoff', content: '   ' },
    { workflow: 'handoff', content: null }, { workflow: 'handoff', content: { secret: content } },
    { workflow: 'handoff', contnet: content }, { workflow: 'handoff', [content]: true },
    { workflow: content }, { tool: content },
    { workflow: 'handoff', content, sessionId: '' },
    { workflow: 'handoff', content: '中'.repeat(21846) },
  ]) {
    const result = await f.call('guide', args);
    assert.equal(result.isError, true);
    assert.equal(f.handoffs.pendingId(f.row.id), saved.id);
    assert.ok(!JSON.stringify(result).includes(content), 'error must not echo raw values or unknown keys');
  }
  assert.ok(!JSON.stringify([...f.rows.values(), f.audit]).includes(content));
  assert.ok(!JSON.stringify([...f.rows.values(), f.audit]).includes(f.row.credential_id));
  for (const args of [{}, { workflow: 'handoff' }, { tool: 'exec' }]) {
    assert.equal(payload(await f.call('guide', args)).status, undefined);
    assert.equal(f.handoffs.pendingId(f.row.id), saved.id);
  }
});

test('guide SDK rejection does not echo untrusted selector values', async t => {
  const f = await fixture(t);
  const marker = 'PRIVATE-CONTEXT-IN-MISSPELLED-SELECTOR';
  const result = await f.call('guide', { workflow: marker });
  assert.equal(result.isError, true);
  assert.ok(!JSON.stringify(result).includes(marker), 'SDK rejection echoed the private marker before handler admission');
});

test('guide reports save_unconfirmed when audit fails after durable replacement', async t => {
  const f = await fixture(t, { finishFails: true });
  const result = await f.call('guide', { workflow: 'handoff', content: 'durable despite audit failure' });
  assert.equal(result.isError, true); assert.equal(payload(result).code, 'save_unconfirmed');
  assert.equal(f.handoffs.get(f.row.id).content, 'durable despite audit failure');
  assert.ok(!JSON.stringify(result).includes('durable despite audit failure'));
});

test('guide enforces UTF-8 boundary and does not overwrite after oversize rejection',async t=>{
 const f=await fixture(t),content='中'.repeat(21845)+'x';
 assert.equal(Buffer.byteLength(content),65536);
 const saved=payload(await f.call('guide',{workflow:'handoff',content}));assert.equal(saved.status,'saved');assert.equal(saved.bytes,65536);
 const failed=await f.call('guide',{workflow:'handoff',content:content+'x'});assert.equal(failed.isError,true);assert.equal(f.handoffs.pendingId(f.row.id),saved.id);
 f.sessions.setStatus(f.row.id,'revoked');assert.equal((await f.call('guide',{workflow:'handoff',content:'not admitted'})).isError,true);assert.equal(f.handoffs.get(f.row.id),null);
});
