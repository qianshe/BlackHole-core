// Source-level native acceptance. Uses the real daemon/backend/registration, not VS Code or a VSIX.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startFixture, until } from './fixtures/process-harness.mjs';

const posix = ['darwin', 'linux'].includes(process.platform);
const baseline = posix ? { BLACKHOLE_BASH: '', BLACKHOLE_PROCESS_SHELL: '', SHELL: '' } : {};
const cases = [
  ['native', {}],
  ...(posix ? [
    ['gui-path', { PATH: '/__blackhole_missing_gui_path__', SHELL: '/bin/sh' }],
    ['removed-profile', { BLACKHOLE_PROCESS_SHELL: '/__blackhole_removed_profile__/zsh', SHELL: '/bin/sh' }],
    ...['sh', 'bash', 'zsh'].filter(shell => fs.existsSync('/bin/' + shell))
      .map(shell => ['shell-' + shell, { BLACKHOLE_PROCESS_SHELL: '/bin/' + shell }]),
  ] : []),
];
const decode = reply => {
  assert.ok(!reply.isError, JSON.stringify(reply));
  return reply.structuredContent ?? JSON.parse(reply.content[0].text);
};

for (const [scenario, extra] of cases) test('core execution: ' + scenario, { timeout: 90000 }, async t => {
  const report = { scenario, platform: process.platform, arch: process.arch, node: process.version,
    commit: process.env.GITHUB_SHA ?? null, scope: 'source daemon; isolated full-access fixture; no production CLI entitlement or VS Code', stages: [] };
  async function stage(name, run) {
    const started = Date.now();
    try {
      const value = await run();
      report.stages.push({ name, status: 'pass', durationMs: Date.now() - started });
      t.diagnostic('PASS ' + name);
      return value;
    } catch (error) {
      report.stages.push({ name, status: 'fail', durationMs: Date.now() - started, error: error.stack ?? String(error) });
      throw error;
    }
  }
  // Registered first, but executed after the explicit finally cleanup below.
  t.after(() => {
    fs.mkdirSync('.cache/core-execution', { recursive: true });
    fs.writeFileSync(`.cache/core-execution/${process.platform}-${process.arch}-${scenario}.json`, JSON.stringify(report, null, 2) + '\n');
  });
  let f;
  try {
    f = await stage('daemon-start-and-backend-load', () => startFixture(t, { env: { ...baseline, ...extra } }));
    await stage('health-and-shell-detection', async () => {
      const health = await f.api('/health');
      report.daemonVersion = health.version;
      report.runtime = health.execution_runtime;
      assert.equal(health.ok, true);
      const runtime = report.runtime;
      assert.equal(runtime.platform, process.platform);
      assert.equal(runtime.arch, process.arch);
      assert.deepEqual(runtime.execution_tools, ['exec', 'process']);
      assert.equal(runtime.process_available, true, JSON.stringify(runtime));
      assert.ok(path.isAbsolute(runtime.exec_shell));
      assert.ok(path.isAbsolute(runtime.process_shell));
      if (scenario.startsWith('shell-')) {
        assert.equal(path.basename(runtime.exec_shell), scenario.slice(6));
        assert.equal(path.basename(runtime.process_shell), scenario.slice(6));
      }
      // Sandbox enforcement is tested separately; unavailability must not hide tools.
      assert.equal(runtime.sandbox.fail_closed, true);
    });
    const session = await stage('isolated-session', () => f.session());
    const client = await stage('mcp-initialize', () => f.connect(session));
    await stage('tools-list', async () => {
      const names = [], seen = new Set();
      let cursor;
      do {
        const page = await client.listTools(cursor ? { cursor } : {});
        names.push(...page.tools.map(tool => tool.name));
        cursor = page.nextCursor;
        assert.ok(!cursor || !seen.has(cursor), 'pagination cursor must advance');
        if (cursor) seen.add(cursor);
      } while (cursor);
      report.tools = names;
      for (const name of ['exec', 'process']) assert.ok(names.includes(name), `${name} missing: ${JSON.stringify(names)}`);
    });
    await stage('exec-call', async () => {
      const command = process.platform === 'win32' ? "Write-Output 'CORE_EXEC_OK'" : "printf 'CORE_EXEC_OK\\n'";
      const result = decode(await client.callTool({ name: 'exec', arguments: { sessionId: session.session_id, command, timeout_ms: 15000 } }));
      assert.equal(result.exit_code, 0, JSON.stringify(result));
      assert.equal(result.stdout.trim(), 'CORE_EXEC_OK');
      assert.equal(fs.realpathSync(result.cwd), fs.realpathSync(f.project));
    });
    let processId, port;
    await stage('process-start-and-ready', async () => {
      const result = await f.call(client, session, 'start', { requestId: 'core-' + scenario, name: 'core acceptance', script: f.fixtureScript('server') });
      assert.equal(result.status, 'ok', JSON.stringify(result));
      processId = result.processId;
      const row = await until(() => f.call(client, session, 'status', { processId }), row =>
        (row.state === 'running' && row.output.stdout.includes('Ready 中文')) || ['failed', 'exited', 'unknown'].includes(row.state), 20000);
      assert.equal(row.state, 'running', JSON.stringify(row));
      const announcement = row.output.stdout.split(/\r?\n/).find(line => line.startsWith('{'));
      port = JSON.parse(announcement).port;
      assert.ok(Number.isInteger(port) && port > 0);
      const response = await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(3000) });
      assert.equal(response.status, 200);
      assert.match(await response.text(), /process fixture/);
    });
    await stage('process-list', async () => {
      const result = await f.call(client, session, 'list');
      assert.ok(result.items.some(item => item.processId === processId));
    });
    await stage('process-stop', async () => {
      const result = await f.call(client, session, 'stop', { processId });
      assert.equal(result.state, 'exited', JSON.stringify(result));
      await assert.rejects(fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(3000) }));
    });
  } finally {
    if (f) await stage('cleanup', () => f.close());
  }
});
