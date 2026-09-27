import http from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startFixture, until, delay } from './fixtures/process-harness.mjs';
import { processSupported as supported } from '../dist/process/backend.js';
const ports = row => row.output.stdout.split(/\r?\n/).filter(line => line.startsWith('{')).map(line => { try { return JSON.parse(line).port; } catch { return null; } }).filter(Boolean);

test('real MCP start/list/status/stop, idempotency, bridge ACK and three parallel native processes', { skip: !supported, timeout: 60000 }, async t => {
  const f = await startFixture(t), s = await f.session(), client = await f.connect(s);
  const catalog = await client.listTools(); const tool = catalog.tools.find(tool => tool.name === 'process'); assert.ok(tool);
  assert.deepEqual(tool.inputSchema.properties.command.enum, ['start', 'list', 'status', 'stop']);
  assert.match(tool.inputSchema.properties.requestId.description, /Stable ID.*reuse on a lost response/);
  const starts = await Promise.all(['a', 'b', 'c'].map(name => f.call(client, s, 'start', { requestId: name, name, script: f.fixtureScript('server') })));
  for (const start of starts) assert.equal(start.status, 'ok', JSON.stringify(start));
  assert.equal(new Set(starts.map(r => r.processId)).size, 3);
  const status = id => f.call(client, s, 'status', { processId: id });
  // stdout and stderr are independent pipes: a port announcement can arrive
  // before the warning. Wait for both facts that the assertions below require.
  const ready = await Promise.all(starts.map(start => until(() => status(start.processId), row => (ports(row).length > 0 && /warning/.test(row.output.stderr)) || row.state === 'failed')));
  for (const row of ready) { assert.equal(row.state, 'running', JSON.stringify(row)); assert.match(row.output.stderr, /warning/); }
  const agent2 = await f.connect(s);
  const retry = await f.call(agent2, s, 'start', { requestId: 'a', name: 'a', script: f.fixtureScript('server') });
  assert.equal(retry.processId, starts[0].processId); assert.equal((await f.call(client, s, 'list')).items.length, 3);
  const invalid = await f.call(client, s, 'start', { requestId: 'a', name: 'a', script: 'different' }); assert.equal(invalid.code, 'idempotency_conflict');
  const other = await f.session(); assert.equal((await f.call(client, other, 'status', { processId: retry.processId })).code, 'process_not_found');
  assert.equal((await f.call(client, other, 'stop', { processId: retry.processId })).code, 'process_not_found');
  const health = await f.api('/health'); assert.equal(health.daemon_id, retry.daemonId);
  const view = { clientId: randomUUID(), daemonId: retry.daemonId, workspaces: [f.project], cursors: {}, acknowledgements: [] };
  const projection = await f.api('/processes/sync', view); assert.equal(projection.items.length, 3); assert.ok(projection.items.every(r => r.owned));
  assert.ok(projection.items.every(r => r.terminal.state === 'pending'));
  await f.api('/processes/sync', { ...view, acknowledgements: starts.map(r => ({ processId: r.processId, state: 'open' })) });
  assert.equal((await status(retry.processId)).terminal.state, 'open');
  assert.ok((await f.api('/processes/sync', { ...view, clientId: randomUUID() })).items.every(r => !r.owned));
  await f.api('/processes/stop', { clientId: view.clientId, daemonId: view.daemonId, workspaces: view.workspaces, processId: starts[0].processId });
  assert.equal((await status(starts[0].processId)).state, 'exited');
  await assert.rejects(fetch('http://127.0.0.1:' + ports(ready[0])[0]));
  for (const row of ready.slice(1)) assert.equal((await fetch('http://127.0.0.1:' + ports(row)[0])).status, 200);
  for (const start of starts.slice(1)) assert.equal((await f.call(client, s, 'stop', { processId: start.processId })).state, 'exited');
  assert.equal((await f.call(client, s, 'stop', { processId: retry.processId })).state, 'exited');
  const rotation = await f.api(`/sessions/${s.id}/rotate`, {});
  const rotated = { ...s, session_id: rotation.session_id };
  assert.equal((await f.call(client, rotated, 'list')).items.length, 3);
  assert.equal((await f.call(client, s, 'list')).code, 'session_invalid');
});

test('native loopback bridge rejects browser/proxy/stale-daemon writes and has no launch endpoint', { skip: !supported, timeout: 30000 }, async t => {
  const f = await startFixture(t), body = { clientId: randomUUID(), workspaces: [f.project] };
  const hostStatus = await new Promise((resolve, reject) => {
    const req = http.request(f.base + '/api/processes/sync', { method: 'POST', headers: { Host: 'localhost.evil.invalid', 'Content-Type': 'application/json' } }, response => { response.resume(); resolve(response.statusCode); });
    req.on('error', reject); req.end(JSON.stringify(body));
  });
  assert.equal(hostStatus, 403, 'raw Host header must be checked; fetch may normalize Host');
  for (const headers of [{ Origin: 'http://evil.invalid' }, { 'Sec-Fetch-Site': 'same-site' }, { 'X-Forwarded-For': '127.0.0.1' }, { Cookie: 'a=b' }, { Forwarded: 'for=local' }]) {
    const response = await fetch(f.base + '/api/processes/sync', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }); assert.equal(response.status, 403, JSON.stringify(headers));
  }
  await assert.rejects(f.api('/processes/sync', { ...body, daemonId: 'old' }), error => error.status === 409);
  await assert.rejects(f.api('/processes/sync', { ...body, script: 'evil' }), error => error.status === 400);
  assert.equal((await fetch(f.base + '/api/processes/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 404);
});

test('MCP schema, immediate failures, pause and changed permissions preserve bounded query semantics', { skip: !supported, timeout: 60000 }, async t => {
  const f = await startFixture(t), s = await f.session(), client = await f.connect(s);
  const bad = await f.call(client, s, 'status'); assert.equal(bad.code, 'invalid_request');
  const row = await f.call(client, s, 'start', { requestId: 'fail', script: f.fixtureScript('exit') });
  const ended = await until(() => f.call(client, s, 'status', { processId: row.processId }), r => r.state === 'exited' || r.state === 'failed');
  assert.equal(ended.exitCode, 7); assert.match(ended.output.stderr, /最后错误/);
  const active = await f.call(client, s, 'start', { requestId: 'live', script: f.fixtureScript('server') });
  await until(() => f.call(client, s, 'status', { processId: active.processId }), r => ports(r).length > 0);
  await f.api(`/sessions/${s.id}/pause`, {}); assert.equal((await f.call(client, s, 'list')).code, 'session_invalid');
  await f.api(`/sessions/${s.id}/resume`, {}); assert.equal((await f.call(client, s, 'status', { processId: active.processId })).state, 'exited');
  const next = await f.call(client, s, 'start', { requestId: 'next', script: f.fixtureScript('server') });
  await f.api(`/sessions/${s.id}/mode`, { permission_mode: 'read-only' }, 'PATCH');
  assert.equal((await f.call(client, s, 'status', { processId: next.processId })).state, 'exited');
});

test('session expiry stops its server without needing another MCP call', { skip: !supported, timeout: 30000 }, async t => {
  const f = await startFixture(t), s = await f.session(), client = await f.connect(s);
  const row = await f.call(client, s, 'start', { requestId: 'expiry', script: f.fixtureScript('server') });
  const ready = await until(() => f.call(client, s, 'status', { processId: row.processId }), value => ports(value).length > 0);
  const port = ports(ready)[0];
  f.child.send({ action: 'expire', id: s.id });
  await until(async () => { try { await fetch('http://127.0.0.1:' + port); return true; } catch { return false; } }, alive => !alive, 6000);
  assert.equal((await f.call(client, s, 'status', { processId: row.processId })).code, 'session_invalid');
});

test('background approval shows the script/cwd, denial never spawns, revoke cancels a pending launch', { skip: !supported, timeout: 40000 }, async t => {
  const f = await startFixture(t), s = await f.session('workspace-write'), client = await f.connect(s);
  const script = process.platform === 'win32' ? "Remove-Item '.never-created-process-fixture'" : "rm -rf -- '.never-created-process-fixture'";
  const pending = f.call(client, s, 'start', { requestId: 'deny', script });
  const confirmation = await until(() => f.api('/confirmations'), response => response.confirmations.some(c => c.status === 'pending'));
  const row = confirmation.confirmations.find(c => c.status === 'pending'), shown = JSON.parse(row.args_json);
  assert.match(shown.command, /Background process/); assert.ok(shown.command.includes(script)); assert.equal(shown.cwd, f.project);
  assert.ok(!row.args_json.includes(s.session_id));
  await f.api(`/confirmations/${row.id}/deny`, {});
  const denied = await pending; assert.equal(denied.status, 'error'); assert.equal(denied.pid, null);
  const second = f.call(client, s, 'start', { requestId: 'revoke', script });
  await until(() => f.api('/confirmations'), response => response.confirmations.some(c => c.status === 'pending'));
  await f.api(`/sessions/${s.id}/revoke`, {});
  const cancelled = await second; assert.equal(cancelled.pid, null); assert.notEqual(cancelled.state, 'running');
});
