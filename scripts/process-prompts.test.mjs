import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildGenericManual } from '../dist/workspace/rules.js';
import { execDescription, registerTools } from '../dist/mcp/tools.js';
import { PROCESS_DESCRIPTION } from '../dist/process/guidance.js';
import { PROCESS_INPUT, processSandboxDiagnostic } from '../dist/mcp/process-tools.js';
import { toolRouting } from '../dist/tool-routing.js';

test('process discovery stays minimal and leaves command details to the tool schema', () => {
  assert.ok(PROCESS_DESCRIPTION.length <= 260, `Process description grew to ${PROCESS_DESCRIPTION.length} characters`);
  assert.match(PROCESS_DESCRIPTION, /dev servers\/watch/); assert.match(PROCESS_DESCRIPTION, /start, list, status, stop/);
  assert.match(PROCESS_DESCRIPTION, /processId/); assert.match(PROCESS_DESCRIPTION, /requestId/);
  assert.doesNotMatch(PROCESS_DESCRIPTION, /terminal\.state|foreground|PowerShell syntax|forcibly/);
});
test('guide and short-command metadata advertise process only when actually available', () => {
  for (const semantic of [false, true]) for (const skills of [false, true]) for (const proxy of [false, true]) {
    const without = buildGenericManual('pwsh', semantic, skills, proxy, false);
    assert.doesNotMatch(without, /`process`|process start/);
    const withProcess = buildGenericManual('pwsh', semantic, skills, proxy, true);
    assert.doesNotMatch(withProcess, /## BACKGROUND PROCESSES/);
    assert.match(withProcess, /background dev servers\/watch tasks → process start/);
    assert.match(withProcess, /`process` — background dev servers\/watch tasks\. Read its tool schema when needed/);
    assert.match(withProcess, /never self-approve or bypass a denial/); assert.match(withProcess, /Task Contract/);
    assert.match(withProcess, /Approved calls resume automatically; do not resubmit/); assert.doesNotMatch(PROCESS_DESCRIPTION, /Windows x64/);
  }
  assert.doesNotMatch(execDescription(true, 'pwsh'), /process start/);
  assert.match(execDescription(true, 'pwsh', true), /process start/);
  assert.match(toolRouting('pwsh', false, true), /background dev servers\/watch tasks → process start/);
});
test('start/status/list/stop are the only commands and command-specific arguments fail closed', () => {
  const sessionId = '123', requestId = 'launch-1', processId = 'proc_11111111-1111-1111-1111-111111111111';
  assert.ok(PROCESS_INPUT.safeParse({ sessionId, command: 'start', requestId, script: 'node server.js' }).success);
  assert.ok(PROCESS_INPUT.safeParse({ sessionId, command: 'status', processId }).success);
  assert.ok(PROCESS_INPUT.safeParse({ sessionId, command: 'stop', processId }).success);
  assert.ok(PROCESS_INPUT.safeParse({ sessionId, command: 'list' }).success);
  assert.ok(PROCESS_INPUT.safeParse({ sessionId, command: 'stop', processId, closeTerminal: true }).success);
  for (const value of [
    { command: 'restart', processId }, { command: 'wait', processId }, { command: 'logs', processId },
    { command: 'status', pid: 1234 }, { command: 'status', processId, closeTerminal: true }, { command: 'stop', processId, script: 'extra' },
    { command: 'start', script: 'server' }, { command: 'start', requestId, script: 'server', env: { PATH: 'evil' } },
  ]) assert.equal(PROCESS_INPUT.safeParse({ sessionId, ...value }).success, false);
});
test('process diagnostics distinguish launch, sandbox-runner and command failures',()=>{
  const runner=processSandboxDiagnostic('sandbox_runner_nested','seatbelt');
  assert.equal(runner.failure_stage,'sandbox_runner');assert.equal(runner.command_started,false);assert.match(runner.hint,/没有执行/);
  const denied=processSandboxDiagnostic('execution_policy_denied','seatbelt');
  assert.equal(denied.failure_stage,'command');assert.equal(denied.command_started,true);assert.match(denied.hint,/命令已经启动/);
  const missing=processSandboxDiagnostic('runtime_asset_missing','seatbelt');
  assert.equal(missing.failure_stage,'launch');assert.equal(missing.command_started,false);assert.match(missing.hint,/重新安装完整/);
  assert.deepEqual(processSandboxDiagnostic('command_exited','seatbelt'),{});
});
test('both connection templates delegate to guide rather than duplicating the process contract', () => {
  for (const file of ['src/courier/prompt.ts', 'packages/vscode/src/templates.ts']) {
    const source = fs.readFileSync(file, 'utf8'); assert.match(source, /Call \`guide\` with this sessionId/);
    assert.doesNotMatch(source, /process\.start|processId|BACKGROUND PROCESSES/);
  }
  assert.match(fs.readFileSync('src/prompt.ts', 'utf8'), /renderBootstrap/);
});
for (const supported of [false, true]) test('registered MCP guide and tool discovery agree on process availability: ' + supported, async () => {
  const server = new McpServer({ name: 'process-prompt-fixture', version: '1' });
  registerTools(server, () => ({ error: 'unused' }), { cfg: {}, events: { append() {} }, processes: { supported } }, { execTool: 'pwsh', execDescription: 'fixture' });
  const client = new Client({ name: 'fixture', version: '1' }); const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a); await client.connect(b);
    const catalog = await client.listTools(); assert.equal(catalog.tools.some(t => t.name === 'process'), supported);
    const reply = await client.callTool({ name: 'guide', arguments: {} }); const text = reply.structuredContent.manual;
    assert.equal(text.includes('`process` — background dev servers/watch tasks.'), supported);
    assert.equal(text.includes('## BACKGROUND PROCESSES'), false);
  } finally { await client.close(); await server.close(); }
});
