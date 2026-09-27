import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerProxyTool } from '../dist/proxy/tool.js';
import { ProxyUpstreamError } from '../dist/proxy/manager.js';
import { buildGenericManual } from '../dist/workspace/rules.js';

// Isolated SDK + real proxy handler. No daemon, upstream process, network or real credentials.
async function fixture(t, { failure, risk = 'allow' } = {}) {
  const calls = [];
  const state = { writes: 0 };
  const upstream = { name: 'private-fixture', risk: { mutate: risk }, surface: {}, redactPaths: [], sensitiveKeys: [] };
  const info = { name: 'mutate', description: 'Fixture operation.', inputSchema: { type: 'object', properties: { label: { type: 'string' } } } };
  const entry = { name: 'fixture_write', status: 'online', binding: { server: upstream, upstreamTool: 'mutate', exposedName: 'fixture_write', tool: info } };
  const runtime = {
    servers: [upstream], disabled: [], secretValues: [], gen: () => 0, cancels: new Map(),
    registry: { resolveGlobal: async () => entry, globalEntries: async () => [entry] },
    manager: {
      crashNote: () => undefined,
      async call(server, session, tool, args) {
        calls.push({ server: server.name, session, tool, args });
        state.writes++;
        if (failure) throw new ProxyUpstreamError(failure, 'Fixture connection ended after the write.');
        return { content: [{ type: 'text', text: 'written' }] };
      },
    },
    attachments: { makeId() { throw new Error('text-only fixture'); } },
  };
  const server = new McpServer({ name: 'proxy-wording-fixture', version: '1' });
  const client = new Client({ name: 'proxy-wording-test', version: '1' });
  registerProxyTool(server, runtime, {
    resolveRequired: () => ({ rt: { session: { id: 'fixture-session' } } }),
    recordRejected() { throw new Error('unexpected session rejection'); },
    withCallTracking: (_rt, _tool, _args, fn) => fn('fixture-call'),
    tracking: { onDenied() {} }, deps: { events: { append() {} } },
    text: (payload, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload, isError }),
  });
  t.after(async () => { await client.close(); await server.close(); });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  const call = args => client.callTool({ name: 'proxy', arguments: { sessionId: 'fixture-session', ...args } });
  return { client, call, calls, state, runtime };
}

test('proxy guide is capability-gated and reuses the explained schema', () => {
  for (const mode of ['script', 'apps']) {
    assert.doesNotMatch(buildGenericManual('exec', true, true, false, false, mode), /- `proxy`/);
    const guide = buildGenericManual('exec', true, true, true, false, mode);
    const lines = guide.split('\n').filter(line => line.startsWith('- `proxy`'));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /`list`.*`explain`.*first `call`; reuse its schema/);
    assert.match(lines[0], /untrusted metadata/);
  }
});

test('SDK discovery separates concise proxy purpose from parameter and result contracts', async t => {
  const { client } = await fixture(t);
  const tool = (await client.listTools()).tools.find(item => item.name === 'proxy');
  assert.ok(tool.description.length < 500);
  assert.match(tool.description, /list.*explain.*first call.*reuse.*call.*cancel/);
  assert.match(tool.description, /untrusted metadata/);
  assert.match(tool.description, /operation-specific read-only check/);
  assert.match(tool.description, /stop and report/);
  assert.doesNotMatch(tool.description, /Statuses:|argsJson|optionsJson|list\/explain or/);
  const p = tool.inputSchema.properties;
  assert.deepEqual(Object.keys(p).sort(), ['argsJson', 'command', 'optionsJson', 'sessionId', 'tool']);
  assert.deepEqual(p.command.enum, ['list', 'explain', 'call', 'cancel']);
  assert.deepEqual(tool.inputSchema.required, ['sessionId', 'command']);
  assert.equal(p.argsJson.type, 'string');
  assert.match(p.argsJson.description, /JSON OBJECT STRING.*Omit for no arguments.*Arrays\/scalars are rejected.*64KB/);
  assert.match(p.optionsJson.description, /command=cancel.*callId.*no keys are supported/);
  assert.deepEqual(tool.outputSchema.properties.status.enum, ['ok', 'error', 'denied', 'unavailable', 'timeout', 'invalid_request']);
  assert.deepEqual(Object.keys(tool.outputSchema.properties).sort(), ['attachments', 'dataJson', 'hint', 'status', 'text', 'tool', 'truncated']);
});

test('explain and call retain schema delivery, aliases, JSON arguments and empty defaults', async t => {
  const f = await fixture(t);
  const explained = await f.call({ command: 'explain', tool: 'fixture_write' });
  assert.equal(explained.structuredContent.status, 'ok');
  assert.match(JSON.parse(explained.structuredContent.dataJson).argsSchemaJson, /label/);
  assert.match(explained.structuredContent.hint, /argsJson.*JSON object string/);
  assert.equal(f.calls.length, 0);
  for (const argsJson of [undefined, '{"label":"example"}']) {
    const result = await f.call({ command: 'call', tool: 'fixture_write', ...(argsJson === undefined ? {} : { argsJson }) });
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent.status, 'ok');
  }
  assert.deepEqual(f.calls, [
    { server: 'private-fixture', session: 'fixture-session', tool: 'mutate', args: {} },
    { server: 'private-fixture', session: 'fixture-session', tool: 'mutate', args: { label: 'example' } },
  ]);
});

for (const failure of ['timeout', 'unavailable']) {
  test(`${failure} after a write requires outcome evidence, not catalog availability`, async t => {
    const f = await fixture(t, { failure });
    const result = await f.call({ command: 'call', tool: 'fixture_write' });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.status, failure);
    const hint = result.structuredContent.hint;
    assert.match(hint, /operation-specific read-only check/);
    assert.match(hint, /stop and report/);
    assert.doesNotMatch(hint, /Verify with read-only tools \(proxy list\/explain|verify with command=list before retrying/i);
    if (failure === 'timeout') assert.match(hint, /not list\/explain/);
    else assert.match(hint, /command=list.*availability, not.*outcome/);
    // The operation happened even though it returned an error; metadata does not prove otherwise.
    assert.equal(f.state.writes, 1);
    const listing = await f.call({ command: 'list' });
    assert.equal(JSON.parse(listing.structuredContent.dataJson).tools[0].callable, true);
    assert.equal((await f.call({ command: 'explain', tool: 'fixture_write' })).structuredContent.status, 'ok');
    assert.equal(f.calls.length, 1, 'the handler must not replay the write');
    assert.equal(f.runtime.cancels.size, 0, 'completed call tracking is released');
  });
}

test('explicit deny still blocks dispatch and discourages retries', async t => {
  const f = await fixture(t, { risk: 'deny' });
  const result = await f.call({ command: 'call', tool: 'fixture_write' });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.status, 'denied');
  assert.match(result.structuredContent.hint, /Do not retry/);
  assert.equal(f.calls.length, 0);
});

test('invalid argument and option errors retain local recovery guidance without dispatch', async t => {
  const f = await fixture(t);
  for (const extra of [{ argsJson: '[]' }, { argsJson: 'broken' }, { optionsJson: '{"unsupported":true}' }]) {
    const result = await f.call({ command: 'call', tool: 'fixture_write', ...extra });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.status, 'invalid_request');
    assert.ok(result.structuredContent.hint);
  }
  assert.equal(f.calls.length, 0);
});
