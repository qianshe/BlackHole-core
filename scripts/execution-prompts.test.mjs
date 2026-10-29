import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerTools } from '../dist/mcp/tools.js';
import { finiteDescription } from '../dist/execution.js';

for (const platform of ['win32', 'darwin', 'linux']) test('minimal discovery and explicitly requested tool help: ' + platform, async () => {
  const windows = platform === 'win32';
  const execution = { platform, arch: 'x64', exec: { legacyName: windows ? 'pwsh' : 'bash', state: windows ? 'session' : 'cwd-only',
    shell: { syntax: windows ? 'powershell' : 'bash', executable: windows ? 'pwsh' : '/bin/bash', version: windows ? '7.4.0' : '5.2.0' }, helpers: { rg: true, grep: true } },
    process: { available: true, state: 'independent', shell: { syntax: windows ? 'powershell' : 'bash', executable: windows ? 'powershell.exe' : '/bin/bash', version: windows ? '5.1.0' : '5.2.0' } },
    sandbox: windows
      ? { backend: 'windows-acl', status: 'deferred', reason: 'checked_per_launch', detail: null }
      : { backend: platform === 'darwin' ? 'seatbelt' : 'bubblewrap', status: 'available', reason: null, detail: null } };
  const server = new McpServer({ name: 'help-fixture', version: '1' }), client = new Client({ name: 'help-test', version: '1' });
  registerTools(server, () => ({ error: 'unused' }), { cfg: {}, events: { append() {} }, execution, processes: { supported: true } },
    { execTool: execution.exec.legacyName, execDescription: finiteDescription(execution) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a); await client.connect(b);
    const tools = (await client.listTools()).tools, tool = tools.find(t => t.name === 'process');
    const names = tools.map(t => t.name);
    assert.ok(names.includes('exec'), `${platform} must expose exec directly in MCP tools/list`);
    assert.ok(names.includes('process'), `${platform} must expose process directly in MCP tools/list`);
    const { runtime } = (await client.callTool({ name: 'guide', arguments: {} })).structuredContent;
    assert.equal(runtime.platform, platform);
    assert.equal(runtime.arch, execution.arch);
    assert.deepEqual(runtime.execution_tools, ['exec', 'process'].filter(name => names.includes(name)));
    assert.ok(!Object.prototype.hasOwnProperty.call(runtime, 'exec_shell'));
    assert.ok(!Object.prototype.hasOwnProperty.call(runtime, 'process_shell'));
    assert.equal(runtime.process_unavailable_reason, null);
    assert.match(runtime.discovery_hint, /native.*not proxy/);
    assert.deepEqual(runtime.sandbox,{...execution.sandbox,fail_closed:true});
    assert.equal(runtime.process_management.owner,windows?'job-object':'process-group-supervisor');
    assert.equal(runtime.process_management.cleanup_guarantee,windows?'kernel-owned':'confirmed-or-unknown');
    assert.ok(tool); assert.ok(tool.description.length <= 350);
    assert.match(tool.description, windows ? /PowerShell 5\.1\.0/ : /bash 5\.2\.0/);
    assert.doesNotMatch(tool.description, windows ? /bash/ : /PowerShell|Windows/);
    assert.match(tool.inputSchema.properties.script.description, windows ? /PowerShell/ : /bash/);
    const guide = async args => (await client.callTool({ name: 'guide', arguments: args })).structuredContent.manual;
    const normal = await guide({});
    assert.match(normal, /commands\/tests\/build\/Git → exec/);

    assert.doesNotMatch(normal, /BACKGROUND PROCESSES|requestId|PowerShell 5|bash 5|Job Object/);
    const help = await guide({ tool: 'process' });
    assert.doesNotMatch(help, /# BlackHole operating rules/);
    assert.match(help, /requestId/); assert.match(help, /processId/);
    assert.match(help, /running.*ready/); assert.ok(help.length <= 1000);
    const finite = await guide({ tool: 'exec' });
    assert.match(finite, windows ? /PowerShell 7\.4\.0/ : /bash 5\.2\.0/);
    assert.match(finite, windows ? /variables and functions persist/ : /variables and functions do not/);
    const expectedHelpers = [execution.exec.helpers.rg ? 'rg' : '', execution.exec.helpers.grep ? 'grep' : ''].filter(Boolean);
    if (expectedHelpers.length) assert.match(finite, new RegExp(`Search: ${expectedHelpers.join(', ')}\\.`));
    else assert.doesNotMatch(finite, /Search:/);
    assert.doesNotMatch(finite, /requestId/);
  } finally { await client.close(); await server.close(); }
});

test('an unavailable macOS sandbox is reported but does not hide native execution tools',async()=>{
  const execution={platform:'darwin',arch:'arm64',
    exec:{state:'cwd-only',shell:{syntax:'zsh',executable:'/bin/zsh',version:'5.9'},adapter:{name:'zsh'},pwshBin:null,helpers:{rg:true,grep:true}},
    process:{available:true,state:'independent',shell:{syntax:'zsh',executable:'/bin/zsh',version:'5.9'}},
    sandbox:{backend:'seatbelt',status:'unavailable',reason:'sandbox_runner_nested',detail:'sandbox_apply: Operation not permitted'}};
  const server=new McpServer({name:'sandbox-fact-fixture',version:'1'}),client=new Client({name:'fixture',version:'1'});
  registerTools(server,()=>({error:'unused'}),{cfg:{},events:{append(){}},execution,processes:{supported:true}},
    {execTool:'exec',execDescription:finiteDescription(execution)});
  const [a,b]=InMemoryTransport.createLinkedPair();
  try{
    await server.connect(a);await client.connect(b);
    const names=(await client.listTools()).tools.map(tool=>tool.name);
    assert.ok(names.includes('exec'));assert.ok(names.includes('process'));
    const runtime=(await client.callTool({name:'guide',arguments:{}})).structuredContent.runtime;
    assert.equal(runtime.sandbox.status,'unavailable');assert.equal(runtime.sandbox.reason,'sandbox_runner_nested');
    assert.match(runtime.discovery_hint,/does not remove exec/);
  }finally{await client.close();await server.close();}
});

test('finite tool metadata does not advertise unavailable background execution', () => {
  const description = finiteDescription({ exec: { state: 'cwd-only', shell: { syntax: 'bash', version: '5.2', executable: '/bin/bash' }, helpers: { rg: false, grep: false } }, process: { available: false } });
  assert.doesNotMatch(description, /Use process/);
});

test('finite metadata advertises only helpers verified at startup', () => {
  const base = { state: 'cwd-only', shell: { syntax: 'bash', version: '5.2', executable: '/bin/bash' }, adapter: null, pwshBin: null };
  const unavailable = { available: false, shell: base.shell, state: 'independent' };
  assert.match(finiteDescription({ exec: { ...base, helpers: { rg: true, grep: false } }, process: unavailable }), /Search: rg\./);
  assert.doesNotMatch(finiteDescription({ exec: { ...base, helpers: { rg: true, grep: false } }, process: unavailable }), /grep/);
  assert.match(finiteDescription({ exec: { ...base, helpers: { rg: false, grep: true } }, process: unavailable }), /Search: grep\./);
  assert.match(finiteDescription({ exec: { ...base, helpers: { rg: true, grep: true } }, process: unavailable }), /Search: rg, grep\./);
  assert.doesNotMatch(finiteDescription({ exec: { ...base, helpers: { rg: false, grep: false } }, process: unavailable }), /Search:/);
});

test('requesting help for an unavailable process does not pretend it can run', async () => {
  const server = new McpServer({ name: 'help-unavailable', version: '1' }), client = new Client({ name: 'test', version: '1' });
  registerTools(server, () => ({ error: 'unused' }), { cfg: {}, events: { append() {} }, processes: { supported: false } }, { execTool: 'bash', execDescription: 'Shell: bash; cwd-only.' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a); await client.connect(b);
    const reply = await client.callTool({ name: 'guide', arguments: { tool: 'process' } });
    const rejected = reply.structuredContent ?? JSON.parse(reply.content[0].text);
    assert.equal(reply.isError, true); assert.match(rejected.instruction, /unavailable/);
    assert.equal(rejected.manual, '');
  } finally { await client.close(); await server.close(); }
});
