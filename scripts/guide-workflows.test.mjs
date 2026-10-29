import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerTools } from '../dist/mcp/tools.js';

const WORKFLOW_NAMES = ['plan', 'execute-plan', 'handoff', 'review'];
const SYNTHETIC_SESSION_ID = '000000000000000000000000000000000000001';
// Check the required semantics, not an arbitrary line count or a copied prompt snapshot.
const ROUTING_REQUIREMENTS = [
  /current user's explicit.*plan.*计划.*execute-plan.*handoff.*review/i,
  /matching `guide\(workflow=\.\.\.\)` before work/i,
  /whole English tokens.*case-insensitive.*optional `\/`/i,
  /Without these keywords, do not load or search workflows/i,
  /regardless of complexity or similar meaning/i,
  /execute\/resume requests containing `plan`\/`计划`/i,
  /including `执行计划`\/`执行 plan`/i,
  /select `execute-plan`, not `plan`/i,
  /never switch from planning to execution automatically/i,
  /Discussion, quotations, code, paths, negation, and template-editing requests are not invocations/i,
  /Bare keywords use the current task/i,
  /clarify only an unresolved target or scope conflict/i,
  /Follow workflow scope and stop conditions/i,
  /permissions and safety boundaries remain unchanged/i,
  /Reuse the template for that task/i,
  /after context loss, reload only to resume a user-invoked workflow/i,
  /not merely from document mentions/i,
  /Routing examples:.*计划：设计缓存.*execute-plan.*review 当前 diff/i,
  /解释 plan.*修改 handoff 提示词.*no workflow lookup/i,
  /If lookup fails, report it and retain user limits/i,
];

const WORKFLOW_CASES = [
  {
    id: 'plan', title: '# Plan workflow',
    required: [
      /must save.*Markdown file/i,
      /\.blackhole\/plan\/<task-slug>\.md/,
      /existing plan.*original path/i,
      /user-specified path/i,
      /hidden.*not.*security boundary/i,
      /save a draft early/i,
      /never overwrite an unrelated/i,
      /requirements.*acceptance criteria/i,
      /Depends on/,
      /multi-step or dependency-bearing work.*simple single-step.*omit unnecessary IDs and dependency fields/i,
      /Compare materially different options only when.*material choice remains unresolved.*concrete material risk/i,
      /exact paths.*interfaces/i,
      /commands.*expected results/i,
      /Progress.*Decisions.*Verification.*Next step/s,
      /Read back.*verify/i,
      /saving is blocked.*not saved/i,
      /temporary, non-durable plan-text fallback.*file delivery remains incomplete.*stop/i,
      /read this plan.*resume/i,
      /Stop after the plan/i,
    ],
  },
  {
    id: 'execute-plan', title: '# Execute plan workflow',
    required: [
      /existing.*plan/i,
      /explicit.*authorization/i,
      /missing or ambiguous/i,
      /do not.*newest/i,
      /original path/i,
      /ordinary Markdown plans.*another agent/i,
      /not.*specific.*schema/i,
      /baseline.*diff/i,
      /dependencies/i,
      /first unfinished/i,
      /verified.*milestone/i,
      /same plan file/i,
      /Progress.*Decisions.*Verification.*Next step/s,
      /re-read.*concurrent/i,
      /write.*fails.*stop further/i,
      /historical.*not.*authorization/i,
      /Do not.*commit.*deploy/i,
      /do not.*load.*review.*handoff/i,
      /Stop when.*scope/i,
      /blocked.*not run/i,
    ],
  },
  {
    id: 'handoff', title: '# Handoff workflow',
    required: [
      /zero-context agent/i,
      /facts and decisions.*assumptions.*checks not run/i,
      /workspace\/baseline/i,
      /completed and remaining work/i,
      /verification results/i,
      /first safe next step.*verification/i,
      /If no work remains, say so/i,
      /Prefer exact pointers.*plan.*diff.*source/i,
      /read-only.*do not continue implementation/i,
      /transfer prior authorization/i,
      /Omit credentials, connection URLs, bootstrap instructions, hidden reasoning/i,
      /credential belongs only in the tool argument, never in the context/i,
      /Write a handoff file only when separately requested.*user-specified path/i,
      /no path is specified.*ask for a path before writing/i,
      /read it back before referencing/i,
      /Prepare self-contained plain-text continuation context/i,
      /plugin owns the Connector and Sandbox connection templates/i,
      /submit the context with `guide/i,
      /confirmed `saved` response.*BlackHole plugin/i,
      /Do not make further workspace calls/i,
      /tool is unavailable before submission or submission fails with an explicit pre-save rejection.*one fenced plain-text code block/i,
      /explicit pre-save rejection.*"not saved"/i,
      /generic error after submission means "save unconfirmed"/i,
      /Stop after delivery/i,
    ],
  },
  {
    id: 'review', title: '# Review workflow',
    required: [
      /target.*baseline/i,
      /design.*functionality.*complexity.*tests/i,
      /security.*concurrency/i,
      /pre-existing.*regressions/i,
      /likely worth fixing.*commit targets.*introduced by the target.*pre-existing issues under Limitations/i,
      /reproduce.*trace/i,
      /severity separate from confidence/i,
      /P0-P3.*P0 = universal.*no input assumptions.*P1.*P2.*P3/i,
      /trivial style nits.*explicit project standard.*obstruct understanding/i,
      /staged, unstaged, and relevant new files/i,
      /all qualifying issues.*deduplicate/i,
      /earlier test counts.*historical evidence.*not results/i,
      /not verified/i,
      /exact English section headings.*Findings.*Scope and baseline.*Verification.*Overall assessment/i,
      /one bullet per field.*exact labels and order.*Location.*Confidence.*Trigger.*Evidence and impact.*Recommended direction/i,
      /Target.*Baseline.*Limitations/i,
      /Checks run.*Checks not run.*PASS.*FAIL.*PARTIAL/i,
      /Confidence.*0\.00.*1\.00/i,
      /state under Findings.*No actionable findings in the reviewed scope/i,
      /Result.*Confidence.*Rationale/i,
      /Inconclusive.*target.*baseline.*evidence/i,
      /Do not.*post.*comments/i,
      /Stop after the review/i,
    ],
  },
];

async function connectGuide({ validSession = false, apps = false } = {}) {
  const audit = [], calls = new Map();
  const runtime = { session: { id: 'workflow-fixture', permission_mode: 'read-only' } };
  let taskReads = 0, taskWrites = 0;
  const server = new McpServer({ name: 'guide-workflow-fixture', version: '1' });
  registerTools(
    server,
    ref => validSession && ref === SYNTHETIC_SESSION_ID ? runtime : { error: 'fixture session unavailable' },
    {
      // Disk discovery has its own fixture suite; never inspect the real user home here.
      cfg: { skillsDir: fileURLToPath(import.meta.url) },
      events: { append: (...args) => audit.push(args) },
      todos: {
        get() { taskReads++; throw new Error('guide must not read task data'); },
        set() { taskWrites++; throw new Error('guide must not write task data'); },
      },
      toolCalls: {
        start(sessionId, tool, argsJson) {
          const call = { id: String(calls.size + 1), sessionId, tool, argsJson, status: 'started' };
          calls.set(call.id, call); return call;
        },
        get: id => calls.get(id),
        finish(id, status, summary) { Object.assign(calls.get(id), { status, summary }); },
      },
    },
    { execDescription: 'Fixture exec help.' },
  );
  const client = new Client({ name: 'guide-workflow-test', version: '1' }, {
    capabilities: apps ? { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } } : {},
  });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const close = async () => { try { await client.close(); } finally { await server.close(); } };
  try { await server.connect(serverTransport); await client.connect(clientTransport); }
  catch (error) { await close(); throw error; }
  return { server, client, audit, calls, close, taskAccess: () => ({ reads: taskReads, writes: taskWrites }) };
}

function workflowSection(manual) {
  const section = manual.match(/## WORKFLOW\n([\s\S]*?)(?=\n## |$)/)?.[1];
  assert.ok(section, 'base guide must contain a WORKFLOW section');
  return section.trim();
}

test('base guide requires explicit keywords and retains routing boundaries', async () => {
  const fixture = await connectGuide();
  try {
    const tools = (await fixture.client.listTools()).tools;
    const guide = tools.find(tool => tool.name === 'guide');
    assert.ok(guide);
    assert.deepEqual(Object.keys(guide.inputSchema.properties).sort(), ['content', 'entry', 'sessionId', 'tool', 'workflow']);
    assert.deepEqual(guide.inputSchema.properties.workflow.enum, WORKFLOW_NAMES);

    const response = await fixture.client.callTool({ name: 'guide', arguments: {} });
    assert.equal(response.isError, false);
    const routing = workflowSection(response.structuredContent.manual);
    for (const requirement of ROUTING_REQUIREMENTS) assert.match(routing, requirement);
    assert.equal(guide.outputSchema.properties.workflow_version, undefined);
    const selectorDescription = guide.inputSchema.properties.workflow.description;
    assert.match(selectorDescription, /explicit.*keyword/i);
    assert.match(selectorDescription, /plan\/计划 = write a plan/);
    assert.match(selectorDescription, /execute or resume an existing plan/);
    assert.match(selectorDescription, /handoff = prepare transfer context/);
    assert.match(selectorDescription, /review = assess without fixes/);
    assert.match(selectorDescription, /Omit for.*quoted or negated.*template-editing/i);
    assert.equal((response.structuredContent.manual.match(/## WORKFLOW/g) ?? []).length, 1);
    assert.doesNotMatch(response.structuredContent.manual, /# (Plan|Handoff|Review) workflow|Stop after the plan|copyable form and stop|Stop after the review/);
    assert.deepEqual(Object.keys(response.structuredContent).sort(), ['instruction', 'manual', 'runtime', 'session']);
    assert.equal(response.structuredContent.skills, undefined);
    assert.equal(guide.outputSchema.properties.skills, undefined);
    assert.equal(guide.outputSchema.properties.project_instructions, undefined);
    assert.doesNotMatch(guide.description, /AGENTS\.md|project instructions|skill catalog/i);
    assert.equal(response.structuredContent.project_instructions, undefined, 'keyless guide never reads project instructions');
  } finally {
    await fixture.close();
  }
});

for (const spec of WORKFLOW_CASES) {
  test(`guide(workflow=${spec.id}) returns the current template and required behavior`, async () => {
    const fixture = await connectGuide();
    try {
      const response = await fixture.client.callTool({
        name: 'guide',
        arguments: { workflow: spec.id, sessionId: SYNTHETIC_SESSION_ID },
      });
      assert.equal(response.isError, false);
      const result = response.structuredContent;
      assert.equal(result.workflow, spec.id);
      assert.equal(result.workflow_version, undefined);
      assert.match(result.instruction, /operating guide.*still applies/i);
      assert.match(result.instruction, /user's requirements.*project documents/i);
      assert.match(result.instruction, /stop condition/i);
      assert.doesNotMatch(result.manual, /github\.com|deepseek|superpowers:/i);
      assert.ok(result.manual.startsWith(spec.title + '\n'));
      assert.match(result.manual, /## METHOD[\s\S]*## BOUNDARY[\s\S]*## DELIVERY/);
      for (const pattern of spec.required) assert.match(result.manual, pattern);
      assert.doesNotMatch(JSON.stringify(result), new RegExp(SYNTHETIC_SESSION_ID));
      assert.doesNotMatch(result.manual, /forced read-only|Workspace root:/i);
      assert.deepEqual(Object.keys(result).sort(), ['instruction', 'manual', 'runtime', 'session', 'workflow']);
      assert.deepEqual(fixture.audit.at(-1), [null, 'guide_fetched', { workflow: spec.id }]);
    } finally {
      await fixture.close();
    }
  });
}

test('guide selectors fail closed and old calls keep their response shape', async () => {
  const fixture = await connectGuide();
  try {
    const tool = await fixture.client.callTool({ name: 'guide', arguments: { tool: 'exec' } });
    assert.equal(tool.isError, false);
    assert.equal(tool.structuredContent.manual, 'Fixture exec help.');
    assert.deepEqual(Object.keys(tool.structuredContent).sort(), ['instruction', 'manual', 'runtime', 'session']);

    const conflict = await fixture.client.callTool({ name: 'guide', arguments: { tool: 'exec', workflow: 'plan' } });
    assert.equal(conflict.isError, true);
    const conflictBody = JSON.parse(conflict.content[0].text);
    assert.match(conflictBody.instruction, /choose either tool or workflow/i);
    assert.equal(conflictBody.manual, '');

    const unknown = await fixture.server._registeredTools.guide.handler({ workflow: 'unknown' }, {});
    assert.equal(unknown.isError, true);
    const unknownBody = JSON.parse(unknown.content[0].text);
    assert.match(unknownBody.instruction, /unsupported workflow/i);
    for (const name of WORKFLOW_NAMES) assert.match(unknownBody.instruction, new RegExp(name));
    assert.equal(unknownBody.manual, '');
  } finally {
    await fixture.close();
  }
});

// These are MCP delivery tests, not a simulation of a model obeying the keywords or saving a plan.
test('invalid selectors are rejected through the public MCP boundary', async () => {
  const f = await connectGuide();
  try {
    for (const workflow of ['unknown', 'PLAN', '计划', '', 'constructor', '__proto__', null, 1, {}, []]) {
      const reply = await f.client.callTool({ name: 'guide', arguments: { workflow } });
      assert.equal(reply.isError, true, `must reject ${JSON.stringify(workflow)}`);
    }
    for (const entry of ['connector', 'apps', '', null, 1, {}, []]) {
      const reply = await f.client.callTool({ name: 'guide', arguments: { entry } });
      assert.equal(reply.isError, true, `must reject entry ${JSON.stringify(entry)}`);
    }
    for (const workflow of WORKFLOW_NAMES) for (const tool of ['exec', 'process']) {
      const reply = await f.client.callTool({ name: 'guide', arguments: { workflow, tool } });
      assert.equal(reply.isError, true);
      assert.equal(JSON.parse(reply.content[0].text).manual, '');
    }
    assert.equal(f.audit.filter(event => event[1] === 'guide_fetched').length, 0);
  } finally { await f.close(); }
});

test('workflow lookup is explicit, stateless, and independent of client capabilities', async () => {
  const plain = await connectGuide(), apps = await connectGuide({ apps: true });
  try {
    for (const f of [plain, apps]) {
      const namesBefore = (await f.client.listTools()).tools.map(tool => tool.name);
      const baseBefore = (await f.client.callTool({ name: 'guide', arguments: {} })).structuredContent;
      for (const workflow of WORKFLOW_NAMES) {
        const current = (await f.client.callTool({ name: 'guide', arguments: { workflow } })).structuredContent;
        const reference = (await plain.client.callTool({ name: 'guide', arguments: { workflow } })).structuredContent;
        assert.equal(current.manual, reference.manual);
        assert.equal(current.instruction, reference.instruction);
        const help = (await f.client.callTool({ name: 'guide', arguments: { tool: 'exec' } })).structuredContent;
        assert.equal(help.workflow, undefined);
      }
      assert.deepEqual((await f.client.callTool({ name: 'guide', arguments: {} })).structuredContent, baseBefore);
      assert.deepEqual((await f.client.listTools()).tools.map(tool => tool.name), namesBefore);
      assert.deepEqual(f.taskAccess(), { reads: 0, writes: 0 });
    }
  } finally { await plain.close(); await apps.close(); }
});

test('a valid session attributes lookup without reading or changing private task state', async () => {
  const f = await connectGuide({ validSession: true });
  try {
    for (const workflow of WORKFLOW_NAMES) {
      const reply = await f.client.callTool({ name: 'guide', arguments: { sessionId: SYNTHETIC_SESSION_ID, workflow } });
      assert.equal(reply.isError, false);
      assert.deepEqual(f.audit.filter(event => event[1] === 'guide_fetched').at(-1), ['workflow-fixture', 'guide_fetched', { workflow }]);
    }
    assert.deepEqual(f.taskAccess(), { reads: 0, writes: 0 });
    assert.equal(f.calls.size, WORKFLOW_NAMES.length);
    assert.ok([...f.calls.values()].every(call => call.status === 'completed'));
    assert.ok(!JSON.stringify(f.audit).includes(SYNTHETIC_SESSION_ID));
    assert.ok(!JSON.stringify([...f.calls.values()]).includes(SYNTHETIC_SESSION_ID));
  } finally { await f.close(); }
});

test('host acceptance fixture is well formed (not a model replay)', () => {
  const data = JSON.parse(readFileSync(new URL('./fixtures/workflow-behavior-cases.json', import.meta.url), 'utf8'));
  assert.match(data.purpose, /not model behavior/i);
  assert.ok(Array.isArray(data.cases));
  const ids = new Set(), selectors = new Set(), kinds = new Set();
  for (const entry of data.cases) {
    assert.match(entry.id, /^[RS]\d+$/);
    assert.equal(ids.has(entry.id), false, `duplicate case ${entry.id}`);
    ids.add(entry.id);
    assert.ok(['routing', 'delivery', 'failure', 'recovery'].includes(entry.kind));
    kinds.add(entry.kind);
    assert.ok(typeof entry.context === 'string' && entry.context.trim());
    assert.ok(typeof entry.request === 'string' && entry.request.trim());
    assert.ok(entry.expected_workflow === null || WORKFLOW_NAMES.includes(entry.expected_workflow));
    selectors.add(entry.expected_workflow);
    assert.ok(Array.isArray(entry.assertions) && entry.assertions.length > 0);
    assert.ok(entry.assertions.every(check => typeof check === 'string' && check.trim()));
  }
  for (const workflow of [null, ...WORKFLOW_NAMES]) assert.ok(selectors.has(workflow));
  for (const kind of ['routing', 'delivery', 'failure', 'recovery']) assert.ok(kinds.has(kind));
});

// Guidance-contract checks only: these do not measure an LLM's routing or task success rate.
test('each overlay narrows the execution loop without turning reference content into authority', async () => {
  const f = await connectGuide();
  try {
    for (const workflow of WORKFLOW_NAMES) {
      const result = (await f.client.callTool({ name: 'guide', arguments: { workflow } })).structuredContent;
      assert.match(result.instruction, /narrows the generic execution loop/i);
      assert.match(result.instruction, /scope, deliverable, and stop condition/i);
      assert.match(result.instruction, /historical approvals.*not new authorization/i);
      assert.match(result.instruction, /Reading tool help does not end/i);
      assert.match(result.instruction, /after context loss.*explicitly invoked workflow/i);
    }
    assert.deepEqual(f.taskAccess(), { reads: 0, writes: 0 });
  } finally { await f.close(); }
});

test('handoff preserves evidence provenance, bounded navigation and the explicit save exception', async () => {
  const f = await connectGuide();
  try {
    const result = (await f.client.callTool({ name: 'guide', arguments: { workflow: 'handoff' } })).structuredContent;
    for (const [requirement, pattern] of [
      ['check provenance', /command, result, (?:and )?scope\/version/i],
      ['historical evidence remains historical', /historical.*not.*fresh/i],
      ['unobserved success is not invented', /timeout.*not.*success/i],
      ['artifact and runtime states stay distinct', /edited, tested, built, installed, deployed, and observed running/i],
      ['narrow reading targets', /path.*heading.*symbol/i],
      ['only verified paths are navigation targets', /verify.*paths.*exist/i],
      ['no previous chat dependency', /prior chat|earlier chat/i],
      ['save is an exception to default read-only', /read-only except.*user-requested handoff file/i],
      ['failed file save keeps the context self-contained', /file saving.*fails.*file not saved.*self-contained/i],
      ['failed submission has a copyable fallback', /submission fails.*one fenced plain-text code block/i],
      ['recipient reconciles actual state', /recipient.*reconcile.*current/i],
      ['credentials are not persisted as continuation context', /credential belongs only in the tool argument, never in the context/i],
      ['missing save path is not guessed', /no path is specified.*ask for a path before writing/i],
    ]) assert.match(result.manual, pattern, requirement);
    assert.deepEqual(f.taskAccess(), { reads: 0, writes: 0 });
  } finally { await f.close(); }
});


// Checks the delivered guidance, not an LLM rewriting or executing a user's task.
test('handoff context derives task text without embedding connection credentials or bootstrap', async () => {
  const f = await connectGuide();
  try {
    const { manual } = (await f.client.callTool({ name: 'guide', arguments: { workflow: 'handoff' } })).structuredContent;
    assert.ok(!manual.includes('task：<context>'), 'task must not retain the old <context> placeholder');
    for (const [requirement, pattern] of [
      ['plugin owns connection assembly', /plugin owns the Connector and Sandbox connection templates/i],
      ['current session ID stays exact in the tool call', /current connection.s supplied `sessionId` verbatim.*leading zeros/i],
      ['no credential in the context', /credential belongs only in the tool argument, never in the context/i],
      ['one replaceable pending document', /One pending context.*new submission replaces it/i],
      ['no inherited action approval', /Do not transfer prior authorization/i],
      ['save is followed by no more work', /Do not make further workspace calls.*successful work consumes/i],
      ['missing current session is reported', /no current ID.*report the blocker.*rather than invent/i],
      ['task comes from this explicit invocation', /Fill `task：` from the content after the explicit `handoff` command in the current user message/i],
      ['rewrite preserves the user intent and literals', /Clarify and condense.*preserving intent, scope, constraints, and exact paths\/commands/i],
      ['rewrite does not expand authority or scope', /do not add requirements or authorization/i],
      ['absent or whitespace-only suffix leaves an empty field', /empty or whitespace-only.*leave `task：` empty/i],
      ['no placeholder or historical task fallback', /no placeholder and no task inferred from history/i],
      ['task remains last without being executed', /Keep this field and its content last.*do not execute it during handoff/i],
    ]) assert.ok(pattern.test(manual), requirement);
    assert.doesNotMatch(manual, /@BlackHole|<CURRENT_SESSION_ID>|Bootstrap once:|curl -fsSL/);
    assert.match(manual, /explicit pre-save rejection.*"not saved"/i);
    assert.match(manual, /generic error after submission means "save unconfirmed"/i);
    assert.match(manual, /Never claim the plugin is ready without confirmation/i);
    assert.doesNotMatch(manual, /task：<context>/);
    assert.deepEqual(f.taskAccess(), { reads: 0, writes: 0 });
  } finally { await f.close(); }
});

test('handoff delivery separates resume context, recipient task and uncertain save outcomes', async () => {
  const f = await connectGuide();
  try {
    const { manual } = (await f.client.callTool({ name: 'guide', arguments: { workflow: 'handoff' } })).structuredContent;
    for (const rule of [
      /## CONTEXT CONTRACT/,
      /Current state.*Goal and constraints.*Evidence.*Remaining work.*Resume step/,
      /recipient.*background.*not a command to run handoff again/i,
      /If the final `task：` is empty.*do not infer.*ask.*before implementation/i,
      /status.*saved.*id.*created_at.*bytes/,
      /generic error.*save unconfirmed/i,
      /explicit pre-save rejection.*not saved/i,
    ]) assert.match(manual, rule);
    assert.doesNotMatch(manual, /If the tool is unavailable or submission fails, return/);
    assert.deepEqual(f.taskAccess(), { reads: 0, writes: 0 });
  } finally { await f.close(); }
});
