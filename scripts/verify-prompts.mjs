#!/usr/bin/env node
// Prompt contract checks. No shell subprocess, live daemon or external network.
// The HTTP check uses an isolated loopback router and synthetic fixture credentials.
// Run after pnpm build; the canonical Courier prompt is transpiled in memory with the existing TS dependency.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { buildAccessRules, buildGenericManual } from '../dist/workspace/rules.js';
import * as prompt from '../dist/prompt.js';
import { bhClientSourceUrl } from '../dist/deps.js';
import { renderSandboxManual } from '../dist/courier/manual.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerTools } from '../dist/mcp/tools.js';

// Verify the daemon/Courier prompt directly; prompt-sync separately enforces VS Code parity.
const source = fs.readFileSync(new URL('../src/courier/prompt.ts', import.meta.url), 'utf8');
const configPanelSource = fs.readFileSync(new URL('../packages/vscode/src/configPanel.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const { renderPrompt } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));
const sid = '000000000000000000000000000000000000123';
const url = 'https://example.invalid/bridge/mcp/0123456789abcdef0123456789abcdef';
let passed = 0, failed = 0;
async function check(label, fn) {
  try { await fn(); passed++; console.log('  PASS ' + label); }
  catch (error) { failed++; console.error('  FAIL ' + label + '\n' + error.stack); }
}

await check('connector bootstrap is minimal and carries no synthetic task', () => {
  const text = renderPrompt('connector', url, sid);
  assert.equal(text, ['@BlackHole', 'sessionId: ' + sid, 'Call `guide` with this sessionId before workspace work and follow it.'].join('\n'));
  assert.doesNotMatch(text, /Task:|paste your task|bh\.py|https:|approval|editor/i);
});
await check('connector mode is selected by kind, not by the URL', () => {
  assert.equal(renderPrompt('connector', url, sid), renderPrompt('connector', '', sid));
});
await check('copied connector description stays concise and session-scoped', () => {
  assert.match(configPanelSource, /Use the supplied sessionId on every BlackHole call\. Call guide before workspace work and follow it\./);
  assert.doesNotMatch(configPanelSource, /must comply|Task:/i);
});
await check('custom connector name and explicit multiline user payload survive unchanged', () => {
  const task = 'Inspect this diff\n' + '保留我的变更。'.repeat(300);
  const text = renderPrompt('connector', url, sid, { kind: 'user', text: task }, 'Team BH');
  assert.ok(text.startsWith('@Team BH\n'));
  assert.ok(text.endsWith('\n\n' + task));
  assert.doesNotMatch(text, /Task:/);
});
await check('empty connector names fall back without inventing a task', () => {
  const text = renderPrompt('connector', url, sid, undefined, '  ');
  assert.ok(text.startsWith('@BlackHole\n'));
  assert.doesNotMatch(text, /Task:|paste your task/i);
});
await check('sandbox bootstrap points to a stable Manual and carries sessionId separately', () => {
  const text = renderPrompt('sandbox', url, sid);
  assert.equal(text, [
    'BlackHole MCP Manual: https://example.invalid/bridge/bh.md',
    'sessionId: ' + sid,
    '',
    'Read this Manual, familiarize yourself with the BlackHole MCP, and prepare to use it with this sessionId for the work that follows. Refer back to it whenever needed.',
  ].join('\n'));
  assert.doesNotMatch(text, /bh\.md\?sessionid|bh\.py|curl|wget|python3|python\s|chmod|bash|preflight|BLACKHOLE\.md/i);
});
await check('sandbox explicit user payload is appended raw after the Manual bootstrap', () => {
  const task = 'Review the diff\n保留换行';
  const text = renderPrompt('sandbox', url, sid, { kind: 'user', text: task });
  assert.ok(text.endsWith('\n\n' + task));
  assert.ok(text.includes('BlackHole MCP Manual: https://example.invalid/bridge/bh.md'));
  assert.ok(text.includes('sessionId: ' + sid));
  assert.doesNotMatch(text, /Task:|curl|python3/i);
});
await check('sandbox Manual URL preserves the public base path without shell syntax', () => {
  const text = renderPrompt('sandbox', "https://example.invalid/team's/mcp/token", sid);
  assert.ok(text.includes("BlackHole MCP Manual: https://example.invalid/team's/bh.md"));
  assert.ok(text.includes('sessionId: ' + sid));
  assert.doesNotMatch(text, /curl|python3|&&|bh\.md\?sessionid/);
});
await check('bad sandbox endpoints fail before producing a misleading bootstrap', () => {
  assert.throws(() => renderPrompt('sandbox', 'https://example.invalid/not-mcp', sid), /MCP URL/);
});

await check('BlackHole MCP Manual stays reusable across sessionId changes', () => {
  const manual = renderSandboxManual(url, 'https://example.invalid/bridge/bh.py');
  assert.match(manual, /^# BlackHole MCP Manual/m);
  assert.match(manual, /save it as `BLACKHOLE\.md`/);
  assert.match(manual, /sessionId.*supplied separately from this Manual/);
  assert.match(manual, /sessionId changes.*Re-download is not required/s);
  assert.match(manual, /does not define, replace, or change BlackHole operating rules/);
  assert.match(manual, /confirm the current project\/workspace context/);
  assert.match(manual, /Choose by the current operation, not by whichever tool was used most recently/);
  assert.match(manual, /Optional reference client: .*\/bh\.py`/);
  assert.match(manual, /tools\/list/);
  assert.match(manual, /Mcp-Session-Id.*different/s);
  assert.match(manual, /context is compacted.*re-read this Manual/s);
  assert.doesNotMatch(manual, new RegExp(sid));
  assert.doesNotMatch(manual, /Handoff context:|Task:/);
});
await check('CLI uses the public API session_id and ignores session names as tasks', () => {
  assert.equal(typeof prompt.buildConnectorPrompt, 'function');
  const text = prompt.buildConnectorPrompt({ session_id: sid, id: 'internal-row', credential_id: 'wrong', name: 'Review the diff' });
  assert.equal(text, renderPrompt('connector', url, sid));
  assert.doesNotMatch(text, /internal-row|wrong|Review the diff|Task:/);
  assert.throws(() => prompt.buildConnectorPrompt({ credential_id: sid }), /session_id/);
});
await check('access resource keeps the original connector/script entry guidance', () => {
  const text = buildAccessRules();
  assert.match(text, /Read `guide`.*before the first workspace operation/s);
  assert.match(text, /Native connector: call `guide` directly/);
  assert.match(text, /Script entry: use[\s\S]*python3 bh\.py call guide '\{\}'/);
  assert.doesNotMatch(text, /curl|wget|\bshow\b/i);
  assert.doesNotMatch(text, /guide.*when.*needed|operator rotated the session/);
});
await check('sandbox entry does not rewrite the original generic guide', () => {
  const plain = buildGenericManual('exec');
  const sandbox = buildGenericManual('exec', false, true, false, false, 'script', 'https://example.invalid/bridge/bh.py');
  assert.equal(sandbox, plain);
  assert.doesNotMatch(sandbox, /## SANDBOX ACCESS|Recommended client/);
});

await check('Sandbox client source URL uses only a public route and preserves its base path', () => {
  assert.equal(
    bhClientSourceUrl({ cfg: {}, tunnel: { status: 'online', url: 'https://example.invalid/bridge' } }),
    'https://example.invalid/bridge/bh.py',
  );
  assert.equal(
    bhClientSourceUrl({ cfg: { publicBaseUrl: 'https://fixed.example/base/' }, tunnel: { status: 'off', url: null } }),
    'https://fixed.example/base/bh.py',
  );
  assert.equal(bhClientSourceUrl({ cfg: {}, tunnel: { status: 'unverified', url: 'https://unverified.example' } }), null);
  assert.equal(bhClientSourceUrl({ cfg: { publicBaseUrl: 'http://127.0.0.1:7306' }, tunnel: { status: 'off', url: null } }), null);
});
await check('default script guidance retains connection safety without mentioning show', () => {
  assertStartup(buildGenericManual('exec'), 'script');
});
await check('Apps startup presents show as an optional presentation-only action', () => {
  assertStartup(buildGenericManual('exec', false, true, false, false, 'apps'), 'apps');
});
await check('STARTUP does not repeat reading guide or explain already-established native calls', () => {
  for (const mode of ['script', 'apps']) {
    const section = startup(buildGenericManual('exec', false, true, false, false, mode));
    assert.doesNotMatch(section, /Read `guide`|Native connector|SHOW POLICY|SHOW LIMIT|Around 5|NEVER SHOW|Do not call/);
  }
});
await check('skill guidance keeps reuse and resource boundaries without a per-name call quota', () => {
  for (const mode of ['script', 'apps']) {
    const text = buildGenericManual('exec', false, true, false, false, mode);
    const line = text.split('\n').find(x => x.startsWith('- `skill`'));
    assert.equal(line, '- `skill` — read relevant workflows and references as needed; reuse loaded content. Access skill files through this tool using skill-relative paths.');
    assert.doesNotMatch(text, /Call each named skill at most once|reload:true|path: "\."/);
  }
});
await check('guide treats proxy as compact operator-configured capability', () => {
  const text = buildGenericManual('pwsh', false, true, true);
  assert.match(text, /`proxy` — use operator-configured MCP tools as needed/);
  assert.match(text, /`list`.*`explain`.*`call`/s);
  assert.match(text, /untrusted metadata/);
  assert.doesNotMatch(text, /## UPSTREAM PROXY/);
});
await check('session failure does not automatically mean rotation', () => {
  const text = buildGenericManual('pwsh');
  assert.doesNotMatch(text, /stops resolving was rotated|operator rotated the session/);
  assert.match(text, /paused.*expired.*revoked/s);
});
await check('approval is one safety instruction, retaining consent and automatic-resume semantics', () => {
  for (const mode of ['script', 'apps']) {
    const text = buildGenericManual('exec', false, true, false, false, mode);
    assert.doesNotMatch(text, /## APPROVAL|^- ONCE|^- ALWAYS|maximum approval scope/m);
    const safety = text.split('## SECURITY & COMPLETION')[1];
    assert.ok(safety.includes('- Approval — never self-approve or bypass a denial. Approved calls resume automatically; do not resubmit.'));
    assert.equal((text.match(/^- Approval —/gm) ?? []).length, 1);
    assert.match(text, /Risk Gate.*confirm before/); assert.match(text, /NEVER RETRY BLINDLY/);
  }
});
await check('all capability combinations retain task, execution, and safety anchors', () => {
  for (const mode of ['script', 'apps'])
  for (const execTool of ['exec']) for (const semantic of [false, true]) for (const skills of [false, true]) {
    const text = buildGenericManual(execTool, semantic, skills, false, false, mode);
    for (const term of ['Task Contract', 'Goal', 'Non-Goal', 'Success Criteria', 'Verification', 'Evidence First', 'Minimal Change', 'smallest complete, reversible change', 'Risk Gate', 'Inspect → Plan → Execute → Verify', 'whole Goal', 'Continue through verification', 'do not stop at intermediate results', 'never self-approve', 'bypass a denial', 'Approved calls resume automatically', 'do not resubmit', 'NEVER RETRY BLINDLY', 'Workspace Boundary', 'Scope Boundary', 'Final Report — lead with Conclusion, then Key Results and Verification', 'failures, gaps, or residual risk only when material', 'editor', 'todo']) assert.ok(text.includes(term), term);
    assert.equal((text.match(/## CORE/g) ?? []).length, 1);
    assert.equal((text.match(/ordinary file inspection or editing/g) ?? []).length, 1, 'workspace-editor shell-routing guidance must not be duplicated');
    assert.equal(text.includes('context_search'), semantic);
    // The title reads "operating rules" by the operator's decision (2026-09-11,
    // documented in src/workspace/rules.ts): the connector safety-classifier
    // risk was consciously accepted for the title line only. The body must
    // stay classifier-safe ("operating manual", "conventions", ...).
    assert.match(text, /^# BlackHole operating rules\n/);
    assert.doesNotMatch(text.replace(/^# BlackHole operating rules\n/, ''), /\brules?\b/i);
    assert.doesNotMatch(text, /Project-specific notes|BlackHole project notes|Task lifecycle/i);
  }
});

// Extract the section as a consumer would; assertions below distinguish the
// modes without relying on the production classifier or a particular client name.
function startup(manual) {
  const section = manual.match(/## STARTUP\n([\s\S]*?)(?=\n## |$)/)?.[1];
  assert.ok(section, 'STARTUP must be present');
  return section;
}
function assertStartup(manual, mode) {
  const section = startup(manual);
  assert.doesNotMatch(section, /Read `guide`|Native connector|SHOW POLICY|SHOW LIMIT|Around 5|NEVER SHOW|Do not call/);
  if (mode === 'apps') {
    assert.equal(section.trim(), '- When a live progress view would help, call `show` at most once after each new user message. The `show` call only opens BlackHole\'s progress panel; it does not read or modify workspace files, run commands, or approve actions.');
    assert.doesNotMatch(section, /bh\.py|sandbox|URL|before other work tools/);
  } else {
    assert.doesNotMatch(section, /\bshow\b/i);
    assert.match(section, /Use the supplied connection; when using bh\.py, use the downloaded script\. Local sandbox ≠ operator workspace\./);
    assert.match(section, /Use this task's URL\/sessionId, not stale CLI or environment overrides\./);
    assert.equal((section.match(/^- /gm) ?? []).length, 2);
  }
}
await check('STARTUP emits only the selected connection branch, with a conservative default', () => {
  for (const mode of ['script', 'apps']) {
    assertStartup(buildGenericManual('exec', false, true, false, false, mode), mode);
  }
  assertStartup(buildGenericManual('exec'), 'script');
  assertStartup(prompt.buildStartupGuidance(), 'script');
  assertStartup(prompt.buildStartupGuidance('unexpected'), 'script');
});
await check('Verify checks actual outcomes against the Goal and criteria without duplicating reporting or prescribing tools', () => {
  const expected = '- Verify — check actual results against the Goal and Success Criteria using fresh evidence.';
  for (const todo of [false, true]) {
    const text = prompt.buildExecutionGuidance({ execTool: 'exec', semantic: false, skills: true, todo });
    assert.equal(text.split('\n').find(line => line.startsWith('- Verify')), expected);
  }
});

const appCapabilities = { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } };
// The real SDK must carry client extensions through initialize; registering
// tools (and a UI-capable server) before initialize must not freeze the mode.
async function connectGuide(name, capabilities, skills = false, sandboxClientUrl = null) {
  const server = new McpServer({ name: 'prompt-contract', version: '1.0.0' }, { capabilities: appCapabilities });
  const audit = []; let resolved = 0, initialized = 0;
  server.server.oninitialized = () => { initialized++; };
  registerTools(server, () => { resolved++; return { error: 'test session is not active' }; }, {
    cfg: skills ? { skillsDir: 'unused-fixture' } : {},
    events: { append: (...args) => audit.push(args) },
    panels: { mountFresh: () => { throw new Error('guide must not mount a panel'); } },
    sandboxClientUrl: () => sandboxClientUrl,
  }, { execDescription: 'Fixture command tool (never invoked).' });
  const client = new Client({ name, version: '1.0.0' }, { capabilities });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const close = async () => { try { await client.close(); } finally { await server.close(); } };
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return { client, server, audit, close, resolved: () => resolved, initialized: () => initialized };
  } catch (error) { await close(); throw error; }
}
const uiCaps = ui => ({ extensions: { 'io.modelcontextprotocol/ui': ui } });
const cases = [
  ['bh.py', 'bh-cli', {}, 'script'],
  ['bh.py overrides claimed Apps support', 'bh-cli', appCapabilities, 'script'],
  ['native Apps', 'prompt-client', appCapabilities, 'apps'],
  ['native without Apps', 'prompt-client', {}, 'script'],
  ['Apps declaration lacks MIME types', 'prompt-client', uiCaps({}), 'script'],
  ['Apps declaration has an empty MIME list', 'prompt-client', uiCaps({ mimeTypes: [] }), 'script'],
  ['Apps declaration supports the wrong MIME type', 'prompt-client', uiCaps({ mimeTypes: ['text/html'] }), 'script'],
  ['Apps declaration has malformed MIME types', 'prompt-client', uiCaps({ mimeTypes: 'text/html;profile=mcp-app' }), 'script'],
  ['Apps declaration lists multiple MIME types', 'prompt-client', uiCaps({ mimeTypes: ['future/type', 'text/html;profile=mcp-app'] }), 'apps'],
  ['experimental metadata alone is not Apps support', 'prompt-client', { experimental: appCapabilities.extensions }, 'script'],
  ['unknown client', '', {}, 'script'],
  ['unknown client stays conservative despite Apps claim', '', appCapabilities, 'script'],
  ['script identity is exact, not a substring heuristic', 'bh-cli-wrapper', {}, 'script'],
  ['client metadata is not echoed into instructions', 'client\nUNTRUSTED_STARTUP_TEXT', {}, 'script'],
];
for (const [label, name, capabilities, mode] of cases) {
  await check('MCP guide-first round trip without implicit UI: ' + label, async () => {
    const f = await connectGuide(name, capabilities);
    try {
      const tools = (await f.client.listTools()).tools;
      const guide = tools.find(t => t.name === 'guide');
      const show = tools.find(t => t.name === 'show');
      assert.match(guide.description, /Start here/);
      assert.doesNotMatch(guide.description, /before this guide/);
      assert.equal(guide._meta?.ui, undefined);
      assert.deepEqual(Object.keys(guide.inputSchema.properties).sort(), ['content', 'entry', 'sessionId', 'tool', 'workflow']);
      assert.equal(f.initialized(), 1, 'existing initialization callback is preserved');
      assert.equal(Boolean(show), mode === 'apps', 'only Apps clients discover show');
      if (show) {
        assert.match(show.description, /Open BlackHole's live progress panel for the current task/);
        assert.match(show.description, /presentation-only/i);
        assert.match(show.description, /does not read or modify workspace files, run commands, or approve actions/i);
        assert.match(show.description, /at most once after each new user message/i);
        assert.doesNotMatch(show.description, /before other work tools/i);
        assert.doesNotMatch(show.description, /Around 5|bh\.py|Skip for/i);
      } else {
        const denied = await f.client.callTool({ name: 'show', arguments: { sessionId: sid } });
        assert.equal(denied.isError, true, 'guessing an unavailable tool must fail');
        // Defence at the handler seam too, before session resolution or mounting.
        const direct = await f.server._registeredTools.show.handler({ sessionId: sid }, {});
        assert.equal(direct.isError, true);
        assert.equal(f.resolved(), 0, 'unsupported calls never enter workspace resolution');
      }
      const first = await f.client.callTool({ name: 'guide', arguments: {} });
      const again = await f.client.callTool({ name: 'guide', arguments: { sessionId: sid } });
      assert.equal(first.isError, false);
      assert.equal(again.isError, false);
      assert.deepEqual(again.structuredContent, first.structuredContent);
      assert.equal(again._meta?.ui, undefined);
      assert.equal(first._meta?.ui, undefined);
      assert.equal(first.structuredContent.panel_key, undefined);
      assert.match(first.structuredContent.instruction, /Follow Startup for this connection/);
      assert.match(first.structuredContent.instruction, /carry out the user task/);
      assertStartup(first.structuredContent.manual, mode);
      assert.doesNotMatch(first.structuredContent.manual, /UNTRUSTED_STARTUP_TEXT/);
      assert.equal(f.audit.length, 2);
      assert.ok(f.audit.every(event => event[0] === null && event[1] === 'guide_fetched'));
    } finally { await f.close(); }
  });
}

await check('sandbox entry stays presentation-only and does not alter the original guide', async () => {
  const f = await connectGuide('plain-client', {}, false, 'https://example.invalid/bridge/bh.py');
  try {
    const connector = await f.client.callTool({ name: 'guide', arguments: { sessionId: sid } });
    const sandbox = await f.client.callTool({ name: 'guide', arguments: { sessionId: sid, entry: 'sandbox' } });
    assert.equal(connector.isError, false);
    assert.equal(sandbox.isError, false);
    assert.equal(sandbox.structuredContent.manual, connector.structuredContent.manual);
    assert.doesNotMatch(sandbox.structuredContent.manual, /## SANDBOX ACCESS|https:\/\/example\.invalid\/bridge\/bh\.py/);
    assert.doesNotMatch(JSON.stringify(sandbox.structuredContent), new RegExp(sid));

    const bad = await f.client.callTool({ name: 'guide', arguments: { sessionId: sid, entry: 'connector' } });
    assert.equal(bad.isError, true);
  } finally { await f.close(); }
});
await check('interleaved connections sharing a session ID do not share startup state; reconnect reclassifies', async () => {
  const fixtures = [];
  try {
    const apps = await connectGuide('same-native-client', appCapabilities); fixtures.push(apps);
    const plain = await connectGuide('same-native-client', {}); fixtures.push(plain);
    const script = await connectGuide('bh-cli', appCapabilities); fixtures.push(script);
    const entries = [[apps, 'apps'], [plain, 'script'], [script, 'script']];
    for (let round = 0; round < 2; round++) {
      await Promise.all(entries.map(async ([f, mode]) => {
        const response = await f.client.callTool({ name: 'guide', arguments: { sessionId: sid } });
        assert.equal(response.isError, false);
        assertStartup(response.structuredContent.manual, mode);
        assert.equal((await f.client.listTools()).tools.some(t => t.name === 'show'), mode === 'apps');
      }));
      entries.reverse();
    }
    await apps.close();
    const reconnected = await connectGuide('same-native-client', {}); fixtures.push(reconnected);
    const response = await reconnected.client.callTool({ name: 'guide', arguments: { sessionId: sid } });
    assertStartup(response.structuredContent.manual, 'script');
  } finally { await Promise.all(fixtures.map(f => f.close())); }
});

await check('real HTTP router: guide cannot borrow another client connection; other warm calls still work', async () => {
  const { default: express } = await import('express');
  const { createServer } = await import('node:http');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const { mountMcp } = await import('../dist/mcp/router.js');
  const { setAccessTokenOverride } = await import('../dist/util/token.js');
  const app = express(); app.use(express.json());
  const audit = [], clients = [], http = createServer(app);
  // Process-local fixture token only. No daemon settings, files or workspace
  // sessions are read or changed, and no shell is spawned by this router.
  setAccessTokenOverride('startup-fixture');
  let cleaner;
  try {
    cleaner = mountMcp(app, {
      cfg: {}, log() {}, runtimes: new Map(),
      sessions: { byCredential: () => undefined },
      events: { append: (...args) => audit.push(args) },
      execution: { exec: { state: 'cwd-only', shell: { syntax: 'bash', executable: 'bash', version: 'fixture' }, helpers: { rg: false, grep: false } }, process: { available: false } },
      panels: { mountFresh: () => { throw new Error('guide must not mount a panel'); } },
    });
    await new Promise((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve); });
    const endpoint = new URL(`http://127.0.0.1:${http.address().port}/mcp/startup-fixture`);
    const connect = async (name, capabilities) => {
      const client = new Client({ name, version: '1' }, { capabilities }); clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(endpoint)); return client;
    };
    const read = async client => {
      const reply = await client.callTool({ name: 'guide', arguments: { sessionId: sid } });
      assert.equal(reply.isError, false); return reply.structuredContent.manual;
    };
    const bare = async name => {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { sessionId: sid } } }) });
      return { status: response.status, body: await response.json() };
    };
    const native = await connect('native-apps', appCapabilities);
    assertStartup(await read(native), 'apps'); // Seeds the same-credential warm map.
    const beforeRejected = audit.filter(event => event[1] === 'guide_fetched').length;
    for (const tool of ['guide', 'show']) {
      const rejected = await bare(tool);
      assert.equal(rejected.status, 400, 'a bare ' + tool + ' must not inherit the Apps handshake');
      assert.equal(rejected.body.error?.code, -32002, 'existing bh.py fallback must recognize the handshake request');
    }
    assert.equal(audit.filter(event => event[1] === 'guide_fetched').length, beforeRejected);
    // This is the fallback already used by bh.py: initialize as bh-cli, then
    // retry with its own protocol header. Native connections keep their mode.
    const script = await connect('bh-cli', {});
    assertStartup(await read(script), 'script');
    assert.equal((await script.listTools()).tools.some(t => t.name === 'show'), false);
    assert.equal((await script.callTool({ name: 'show', arguments: { sessionId: sid } })).isError, true);
    assertStartup(await read(native), 'apps');
    assert.equal((await native.listTools()).tools.some(t => t.name === 'show'), true);
    const plain = await connect('native-apps', {});
    assertStartup(await read(plain), 'script');
    assertStartup(await read(script), 'script');
    assert.equal((await script.listTools()).tools.some(t => t.name === 'show'), false);
    assert.equal((await script.callTool({ name: 'show', arguments: { sessionId: sid } })).isError, true);
    assertStartup(await read(native), 'apps');
    assert.equal((await native.listTools()).tools.some(t => t.name === 'show'), true);
    const reused = await bare('skill');
    assert.equal(reused.status, 200); assert.ok(reused.body.result); assert.equal(reused.body.error, undefined);
    assert.ok(audit.some(event => event[1] === 'mcp_session_reused' && event[2].via === 'interceptor'));
  } finally {
    for (const client of clients) await client.close().catch(() => {});
    await cleaner?.closeAll();
    http.closeAllConnections();
    if (http.listening) await new Promise(resolve => http.close(resolve));
    setAccessTokenOverride(undefined);
  }
});

await check('confirmed Apps still mount the isolated panel, while guide stays side-effect-free', async () => {
  const server = new McpServer({ name: 'show-fixture', version: '1' });
  const client = new Client({ name: 'apps-fixture', version: '1' }, { capabilities: appCapabilities });
  let mounts = 0, resolved = 0;
  const runtime = { session: { id: 'fixture-workspace' } };
  registerTools(server, ref => { resolved++; return ref === sid ? runtime : { error: 'invalid' }; }, {
    cfg: {}, events: { append() {} },
    toolCalls: { maxSeqForSession: () => 7 }, panelBase: () => 'http://example.invalid',
    panels: { mountFresh: () => { mounts++; return 'fixture-panel'; }, startSeqFor: () => 7, appTokenFor: () => 'fixture-token' },
  }, { execDescription: 'Never executed.' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    assert.equal(server._registeredTools.show.enabled, false, 'closed until initialized');
    await server.connect(a); await client.connect(b);
    const reply = await client.callTool({ name: 'guide', arguments: {} });
    assertStartup(reply.structuredContent.manual, 'apps'); assert.equal(mounts, 0);
    const show = await client.callTool({ name: 'show', arguments: { sessionId: sid } });
    assert.equal(show.isError, false); assert.equal(show.structuredContent.status, 'mounted');
    assert.equal(mounts, 1); assert.equal(resolved, 1);
    assert.equal(show.structuredContent.panel_key, 'fixture-panel');
    assert.equal(show.structuredContent.panel_start_seq, 7); assert.ok(show._meta?.ui?.resourceUri);
  } finally { await client.close(); await server.close(); }
});

await check('exec has one peer tool entry for all guide capability combinations', () => {
  for (const mode of ['script', 'apps']) for (const semantic of [false, true])
  for (const skills of [false, true]) for (const processes of [false, true]) {
    const text = buildGenericManual('exec', semantic, skills, false, processes, mode);
    assert.equal(text.split('\n').filter(x => x.startsWith('- `exec`')).join('\n'), '- `exec` — run finite commands and wait for the result.');
    assert.match(text, /commands\/tests\/build\/Git → exec/);
    assert.equal(text.includes('- `process`'), processes);
  }
});
await check('skill discovery stays concise while its schema retains resource and reload instructions', async () => {
  const f = await connectGuide('bh-cli', {}, true);
  try {
    const tools = (await f.client.listTools()).tools, skill = tools.find(t => t.name === 'skill');
    assert.ok(tools.some(t => t.name === 'exec'));
    assert.equal(skill.description, 'Read operator workflows and referenced files through this tool. Scripts are returned as text, not executed.');
    assert.doesNotMatch(skill.description, /project|custom|default|priority|same-name/i);
    assert.ok(skill.description.length < 160);
    const p = skill.inputSchema.properties;
    assert.match(p.name.description, /Omit to list skills/);
    assert.match(p.path.description, /skill root/); assert.match(p.path.description, /Omit for SKILL\.md/);
    assert.match(p.path.description, /No absolute or parent-traversal paths/);
    assert.match(p.offset.description, /next_offset/);
    assert.match(p.reload.description, /context loss, failed delivery or a user request/);
    assert.match(skill.outputSchema.properties.dir.description, /not permission/);
    assert.match(skill.outputSchema.properties.complete.description, /not a model-delivery receipt/);
  } finally { await f.close(); }
});

console.log('\nPROMPT CHECKS: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exitCode = 1;
