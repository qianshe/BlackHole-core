import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { startDaemon } from '../dist/daemon.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function fixture(t, initial = []) {
  fs.mkdirSync('.cache/tests', { recursive: true });
  const dir = fs.mkdtempSync(path.resolve('.cache/tests/proxy-enabled-'));
  const proxyConfigPath = path.join(dir, 'proxies.yaml');
  if (initial.length) fs.writeFileSync(proxyConfigPath, JSON.stringify({ proxies: initial }));
  const port = await freePort();
  const daemon = await startDaemon({
    port,
    dbPath: path.join(dir, 'test.db'),
    proxyConfigPath,
    tunnel: 'off',
    semantic: 'off',
    skillsDir: '',
    publicBaseUrl: `http://127.0.0.1:${port}`,
  }, () => {});
  t.after(async () => { await daemon.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  const request = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${port}/api${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = await response.json();
    assert.ok(response.ok, JSON.stringify(json));
    return json;
  };
  const status = async name => (await request('/proxies')).status.find(row => row.name === name);
  const waitStatus = async (name, wanted, timeout = 8000) => {
    const values = new Set(Array.isArray(wanted) ? wanted : [wanted]);
    const deadline = Date.now() + timeout;
    let row;
    do {
      row = await status(name);
      if (row && values.has(row.status)) return row;
      await sleep(30);
    } while (Date.now() < deadline);
    assert.fail(`timed out waiting for ${name}=${[...values].join('|')}; last=${JSON.stringify(row)}`);
  };
  const server = {
    name: 'fixture',
    transport: 'stdio',
    command: process.execPath,
    args: [path.resolve('scripts/fake-upstream.mjs')],
    enabled: true,
    prewarm: 'never',
  };
  return { daemon, request, status, waitStatus, server, dir, proxyConfigPath };
}

async function connectClient(t, request, name) {
  const health = await request('/health');
  const client = new Client({ name, version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(health.mcp_url)));
  t.after(() => client.close());
  return { client, health };
}

test('enabled add starts immediately, publishes real tools, and calls reuse the running process', async t => {
  const { daemon, request, waitStatus, server, dir } = await fixture(t);
  const { client, health } = await connectClient(t, request, 'enabled-add');
  assert.ok((await client.listTools()).tools.some(tool => tool.name === 'proxy'));

  const added = await request('/proxies/add', server);
  assert.equal(added.starting, true);
  const first = (await request('/proxies')).status.find(row => row.name === server.name);
  assert.ok(['starting', 'online'].includes(first.status), JSON.stringify(first));
  const online = await waitStatus(server.name, 'online');
  assert.ok(online.catalogCount > 0);
  assert.equal(online.catalogCount, online.tools.length, 'count is the currently exposed/callable tool count');
  assert.equal(daemon.deps.proxy.manager.childCount(), 1);
  assert.equal(daemon.deps.proxy.manager.metricsSnapshot(server.name).restarts, 1);

  const listing = await client.callTool({ name: 'proxy', arguments: { sessionId: (await request('/sessions', { workspace_path: dir, permission_mode: 'read-only' })).session_id, command: 'list' } });
  assert.ok(JSON.stringify(listing).includes('echo'));
  const session = await request('/sessions', { workspace_path: dir, permission_mode: 'read-only' });
  const called = await client.callTool({ name: 'proxy', arguments: { sessionId: session.session_id, command: 'call', tool: 'echo', argsJson: '{"payload":"ready"}' } });
  assert.ok(JSON.stringify(called).includes('ready'));
  assert.equal(daemon.deps.proxy.manager.metricsSnapshot(server.name).restarts, 1, 'agent call must not launch another process');
  assert.equal((await request('/health')).daemon_id, health.daemon_id);
});

test('disabled MCP stays inert and hides its tool count; enabling starts and disabling stops it', async t => {
  const { daemon, request, waitStatus, server, dir } = await fixture(t);
  const { client } = await connectClient(t, request, 'disabled-lifecycle');
  const session = await request('/sessions', { workspace_path: dir, permission_mode: 'read-only' });
  const list = async () => client.callTool({ name: 'proxy', arguments: { sessionId: session.session_id, command: 'list' } });
  const added = await request('/proxies/add', { ...server, enabled: false });
  assert.equal(added.starting, false);
  const disabled = await waitStatus(server.name, 'disabled');
  assert.ok(!Object.hasOwn(disabled, 'catalogCount'));
  assert.equal(daemon.deps.proxy.manager.childCount(), 0);
  const blocked = await request('/proxies/tools', { server: server.name, refresh: true });
  assert.equal(blocked.disabled, true);
  assert.deepEqual(blocked.tools, []);

  assert.ok(!JSON.stringify(await list()).includes('echo'), 'disabled MCP tools must not appear in proxy list');
  await request('/proxies/config/fields', { server: server.name, fields: { enabled: true } });
  const online = await waitStatus(server.name, 'online');
  assert.ok(online.catalogCount > 0);
  assert.equal(daemon.deps.proxy.manager.childCount(), 1);
  assert.ok(JSON.stringify(await list()).includes('echo'), 'online MCP tools must appear after the agent asks for a fresh list');

  await request('/proxies/config/fields', { server: server.name, fields: { enabled: false } });
  await waitStatus(server.name, 'disabled');
  await sleep(100);
  assert.equal(daemon.deps.proxy.manager.childCount(), 0);
  assert.equal(daemon.deps.proxy.registry.cachedTools(server.name), undefined);
  assert.ok(!JSON.stringify(await list()).includes('echo'), 'disabled MCP tools must disappear when the agent asks again');
});

test('disabling while starting cancels the old startup and re-enable starts a fresh process', async t => {
  const { daemon, request, waitStatus, server, dir } = await fixture(t);
  const marker = path.join(dir, 'started.pid');
  await request('/proxies/add', { ...server, args: [path.resolve('scripts/lazy-upstream-fixture.mjs'), marker] });
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(marker) && Date.now() < deadline) await sleep(20);
  assert.ok(fs.existsSync(marker), 'fixture connect never started');
  await request('/proxies/config/fields', { server: server.name, fields: { enabled: false } });
  await waitStatus(server.name, 'disabled');
  await sleep(800);
  assert.equal(daemon.deps.proxy.manager.childCount(), 0);
  assert.equal(daemon.deps.proxy.registry.cachedTools(server.name), undefined);

  await request('/proxies/config/fields', { server: server.name, fields: { enabled: true, args: server.args } });
  const online = await waitStatus(server.name, 'online');
  assert.ok(online.catalogCount > 0);
  assert.equal(daemon.deps.proxy.manager.childCount(), 1);
});

test('startup failure is visible and never exposes a fake tool count', async t => {
  const { daemon, request, waitStatus, server } = await fixture(t);
  await request('/proxies/add', { ...server, args: [path.resolve('scripts/failing-upstream-fixture.mjs')] });
  const failed = await waitStatus(server.name, 'crashed');
  assert.match(String(failed.reason), /failed to start|startup failure|closed/i);
  assert.ok(!Object.hasOwn(failed, 'catalogCount') || failed.catalogCount === null);
  assert.equal(daemon.deps.proxy.manager.childCount(), 0);
  const tools = await request('/proxies/tools', { server: server.name, refresh: true });
  assert.equal(tools.tools.length, 0);
  assert.match(String(tools.error), /not running|failed to start|startup failure|closed/i);
});

test('enabled MCP recovers after an unexpected exit without waiting for an agent call', async t => {
  const { daemon, request, waitStatus, server } = await fixture(t);
  await request('/proxies/add', server);
  await waitStatus(server.name, 'online');
  const before = daemon.deps.proxy.manager.metricsSnapshot(server.name).restarts;
  const pidFile = path.join(path.dirname(daemon.deps.cfg.dbPath), 'proxy-children.json');
  const pid = JSON.parse(fs.readFileSync(pidFile, 'utf8')).find(row => row.server === server.name)?.pid;
  assert.ok(pid && pid > 0, 'fixture MCP pid missing');
  process.kill(pid);
  await waitStatus(server.name, ['crashed', 'starting']);
  const online = await waitStatus(server.name, 'online', 10_000);
  assert.ok(online.catalogCount > 0);
  assert.equal(daemon.deps.proxy.manager.metricsSnapshot(server.name).restarts, before + 1);
});

test('policy edits are hot; connection edits restart only that MCP and never the daemon', async t => {
  const base = {
    name: 'fixture', transport: 'stdio', command: process.execPath,
    args: [path.resolve('scripts/fake-upstream.mjs')], enabled: true,
  };
  const { daemon, request, waitStatus } = await fixture(t, [base]);
  const daemonId = (await request('/health')).daemon_id;
  await waitStatus(base.name, 'online');
  assert.equal(daemon.deps.proxy.manager.metricsSnapshot(base.name).restarts, 1);

  await request('/proxies/config/fields', { server: base.name, fields: { surface: { expose: ['echo'] } } });
  const filtered = await waitStatus(base.name, 'online');
  assert.equal(filtered.catalogCount, 1);
  assert.equal(daemon.deps.proxy.manager.metricsSnapshot(base.name).restarts, 1, 'surface edit must stay hot');

  await request('/proxies/config/fields', { server: base.name, fields: { args: [...base.args, '--restarted'] } });
  const deadline = Date.now() + 8000;
  while (daemon.deps.proxy.manager.metricsSnapshot(base.name).restarts < 2 && Date.now() < deadline) await sleep(30);
  const restarted = await waitStatus(base.name, 'online');
  assert.equal(restarted.catalogCount, 1);
  assert.equal(daemon.deps.proxy.manager.metricsSnapshot(base.name).restarts, 2);
  assert.equal((await request('/health')).daemon_id, daemonId);
});

test('full config reload waits for a delayed replacement catalog without replaying a call', async t => {
  const base = {
    name: 'fixture', transport: 'stdio', command: process.execPath,
    args: [path.resolve('scripts/fake-upstream.mjs')], enabled: true,
  };
  const { daemon, request, waitStatus, dir } = await fixture(t, [base]);
  const { client, health } = await connectClient(t, request, 'delayed-full-reload');
  const session = await request('/sessions', { workspace_path: dir, permission_mode: 'read-only' });
  await waitStatus(base.name, 'online');
  const before = daemon.deps.proxy.manager.metricsSnapshot(base.name);
  const marker = path.join(dir, 'replacement.pid');
  const started = Date.now();
  const reload = await request('/proxies/config', { yaml: JSON.stringify({ proxies: [{
    ...base, args: [path.resolve('scripts/lazy-upstream-fixture.mjs'), marker],
  }] }) });
  assert.deepEqual(reload.report.recycled, [base.name]);
  await waitStatus(base.name, 'starting');
  // The fixture delays its handshake by 600ms: no fixed 400ms sleep may stand in for readiness.
  const ready = await waitStatus(base.name, 'online');
  assert.ok(ready.catalogCount > 0);
  assert.ok(fs.existsSync(marker), 'replacement process really started');
  t.diagnostic(`replacement catalog ready after ${Date.now() - started}ms`);
  const invoke = args => client.callTool({ name: 'proxy', arguments: { sessionId: session.session_id, ...args } });
  const listing = await invoke({ command: 'list' });
  assert.equal(listing.structuredContent.status, 'ok');
  assert.ok(JSON.parse(listing.structuredContent.dataJson).tools.some(tool => tool.name === 'bump_counter' && tool.callable));
  assert.equal(daemon.deps.proxy.manager.metricsSnapshot(base.name).calls, before.calls, 'metadata readiness checks never dispatch business calls');
  const result = await invoke({ command: 'call', tool: 'bump_counter' });
  assert.equal(result.structuredContent.status, 'ok');
  assert.equal(JSON.parse(result.structuredContent.text).count, 1, 'the operation runs exactly once');
  const after = daemon.deps.proxy.manager.metricsSnapshot(base.name);
  assert.equal(after.restarts, before.restarts + 1);
  assert.equal(after.calls, before.calls + 1);
  assert.equal((await request('/health')).daemon_id, health.daemon_id);
});
