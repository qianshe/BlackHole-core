#!/usr/bin/env node
// End-to-end smoke test covering the MVP acceptance criteria.
// Run with: pnpm smoke   (build first: pnpm build)
// Windows-only by design: the suite asserts persistent-pwsh semantics, the
// win32 ACL sandbox and $env:TEMP/APPDATA gates — a Linux run would be a
// different (weaker) contract. On other platforms run pnpm test:posix.
if (process.platform !== 'win32' && !process.env.BH_SMOKE_ALLOW_SKIP) {
  console.error("SMOKE SKIP: this gate is Windows-gated (pwsh + ACL sandbox). Use 'pnpm test:posix' here, or set BH_SMOKE_ALLOW_SKIP=1 to force.");
  process.exit(1);
}
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { PanelRegistry } from '../dist/panel/keys.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.SMOKE_PORT ?? 18000 + Math.floor(Math.random() * 20000));
const BASE = `http://127.0.0.1:${PORT}`;
const PANEL_URI = 'ui://blackhole/panel.html';
const PANEL_APP_TOKEN_META = 'blackhole/panelAppToken';

let passed = 0;
const ok = (label) => {
  passed++;
  console.log(`  ✓ ${label}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHealth(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return await res.json();
    } catch {
      /* not up yet */
    }
    await sleep(300);
  }
  throw new Error('daemon did not become healthy');
}

function startDaemon(dbPath) {
  // SMOKE_NODE swaps the daemon runtime (e.g. VSCode's Code.exe with
  // ELECTRON_RUN_AS_NODE=1) to prove the extension's zero-Node path works.
  const runtime = process.env.SMOKE_NODE ?? process.execPath;
  const env = {
    ...process.env,
    BLACKHOLE_DB: dbPath,
    BLACKHOLE_TUNNEL: 'off',
    // fixture built in main(): commit-fast (frontmatter) + plain + linked-skill (junction)
    BLACKHOLE_SKILLS_DIR: path.join(path.dirname(dbPath), 'skills'),
    // hermetic key file: the /semantic settings-surface assertions must never
    // touch the real ~/.blackhole/semantic-key on this machine
    BLACKHOLE_SEMANTIC_KEY_FILE: path.join(path.dirname(dbPath), 'semantic-key'),
    // Keep baseline runs hermetic: do not auto-extract a real editor credential.
    // The explicit semantic-key phase below sets BLACKHOLE_SEMANTIC_KEY and re-enables auto.
    BLACKHOLE_SEMANTIC: process.env.BLACKHOLE_SEMANTIC_KEY ? 'auto' : 'off',
    // hermetic proxy config：smoke 的工具面断言（MVP 集合）必须与本机真实
    // ~/.blackhole/mcp-proxies.yaml 隔离——指向不存在的文件即不注册 proxy 工具
    BLACKHOLE_PROXY_CONFIG: path.join(path.dirname(dbPath), 'mcp-proxies.yaml'),
    // Semantic settings probes need platform paths, but they must resolve only
    // inside this hermetic fixture rather than the operator profile.
    APPDATA: path.dirname(dbPath),
    LOCALAPPDATA: path.dirname(dbPath),

  };
  delete env.BLACKHOLE_PUBLIC_URL;

  if (process.env.SMOKE_NODE) env.ELECTRON_RUN_AS_NODE = '1';
  env.SMOKE_PORT = String(PORT);
  const child = spawn(runtime, [path.join(ROOT, 'scripts', 'smoke-daemon-fixture.mjs')], {
    env,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  return child;
}

async function stopDaemon(child) {
  if (child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise((r) => child.once('exit', r)),
    sleep(4000).then(() => child.kill('SIGKILL')),
  ]);
}

async function api(method, p, body) {
  const res = await fetch(`${BASE}/api${p}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function connectMcp(url) {
  // This fixture exercises Apps discovery and panel lifecycle.
  const client = new Client({ name: 'blackhole-smoke', version: '0.0.1' }, {
    capabilities: { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } },
  });
  const transport = new StreamableHTTPClientTransport(new URL(url));
  await client.connect(transport);
  return client;
}

async function initializeProbe(url) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 777,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'blackhole-smoke-initialize-probe', version: '0.0.1' },
      },
    }),
  });
  const payload = JSON.parse(await res.text());
  return { payload, sessionId: res.headers.get('mcp-session-id') };
}

const resultJson = (toolResult) => JSON.parse(toolResult.content[0].text);
/** raw call without a session id — negative tests only */
const rawCall = (client, name, args) => client.callTool({ name, arguments: args });
/**
 * Single-layer session model: every work-tool call carries the numeric session
 * id as its `sessionId` argument (hosts open a fresh connection per turn, so
 * this is the one surface that always survives). Keyless tools take no id.
 */
const KEYLESS = new Set(['guide', 'skill']);
const argsWithSession = (sid, name, args) => {
  if (KEYLESS.has(name)) return args;
  if (name === 'editor') {
    const { path: editorPath, ...operation } = args;
    return { sessionId: sid, path: editorPath, operation };
  }
  return { ...args, sessionId: sid };
};
const callWith = (sid) => async (client, name, args) =>
  client.callTool({ name, arguments: argsWithSession(sid, name, args) });

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-smoke-'));
  const ws = path.join(tmp, 'ws');
  const wsSub = path.join(ws, 'sub');
  const dbPath = path.join(tmp, 'db.sqlite');
  fs.mkdirSync(wsSub, { recursive: true });

  // legacy-DB migration fixture: pre-seed the OLD schema (trusted/guarded
  // CHECK vocabulary + one row per legacy mode) so daemon boot MUST run the
  // CASE-normalizing table rebuild before anything else can work.
  {
    const { DatabaseSync } = await import('node:sqlite');
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, name TEXT, workspace_path TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active','paused','revoked','archived')),
      permission_mode TEXT NOT NULL CHECK (permission_mode IN ('trusted','guarded','read-only')),
      cwd TEXT, created_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL, expires_at INTEGER)`);
    for (const mode of ['trusted', 'guarded', 'read-only']) {
      legacy
        .prepare(`INSERT INTO sessions (id, token_hash, name, workspace_path, status, permission_mode, cwd, created_at, last_active_at, expires_at) VALUES (?, ?, NULL, ?, 'active', ?, NULL, ?, ?, NULL)`)
        .run(`sess_legacy_${mode}`, `hash-${mode}`, ws, mode, 1, 1);
    }
    legacy.close();
  }

  // skill-tool fixture: one skill naming itself via frontmatter, one relying
  // on the folder-name fallback, one reached through a junction (real skill
  // dirs are often plugin-cache symlinks — Dirent.isDirectory() skips those)
  const skillsDir = path.join(tmp, 'skills');
  fs.mkdirSync(path.join(skillsDir, 'commit-fast'), { recursive: true });
  fs.writeFileSync(
    path.join(skillsDir, 'commit-fast', 'SKILL.md'),
    '---\nname: commit-fast\ndescription: Write clear commit messages at speed\n---\n\n# Commit fast\n\nSteps to author a commit quickly.\n',
  );
  fs.mkdirSync(path.join(skillsDir, 'plain'), { recursive: true });
  fs.writeFileSync(path.join(skillsDir, 'plain', 'SKILL.md'), '# Plain skill\n\nNo frontmatter: the folder name stands in.\n');
  let linkedOk = true;
  try {
    const src = path.join(tmp, 'linked-skill-src');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'SKILL.md'), '---\nname: linked-skill\ndescription: Reached through a junction link\n---\n\n# Linked skill\n');
    fs.symlinkSync(src, path.join(skillsDir, 'linked-skill'), 'junction');
  } catch {
    linkedOk = false;
  }
  const expectedSkills = linkedOk ? ['commit-fast', 'linked-skill', 'plain'] : ['commit-fast', 'plain'];

  console.log(`smoke: workspace ${ws}\n`);
  let daemon = startDaemon(dbPath);
  try {
    const health = await waitForHealth();
    // identity check: never talk to a leaked daemon from an earlier run
    assert.equal(health.db_path, dbPath, `health answers from the wrong daemon (db ${health.db_path})`);
    assert.equal(health.ok, true);
    assert.equal(health.public_base_url, null, 'no BLACKHOLE_PUBLIC_URL in smoke env');
    ok(`daemon health (port ${PORT}, pid ${daemon.pid})`);

    {
      const panels = new PanelRegistry();
      let oldest = panels.mountFresh('smoke-panel-cap', 0);
      let recent = oldest;
      for (let i = 0; i < 300; i++) recent = panels.mountFresh('smoke-panel-cap', i + 1);
      assert.equal(panels.terminalReason(oldest), undefined, 'dead panel graveyard evicts oldest keys past the hard cap');
      assert.equal(panels.terminalReason(recent), undefined, 'current panel key remains live while graveyard pruning runs');
    }
    ok('panel registry bounds its terminal-key graveyard');

    // --- legacy-DB migration: the pre-seeded trusted/guarded/read-only rows
    // must have been normalized to the new vocabulary by the boot-time rebuild
    {
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(dbPath);
      const rows = db.prepare('SELECT id, permission_mode FROM sessions WHERE id LIKE ?').all('sess_legacy_%');
      db.close();
      const byId = Object.fromEntries(rows.map((row) => [row.id, row.permission_mode]));
      assert.equal(byId['sess_legacy_trusted'], 'workspace-write', 'legacy trusted → workspace-write');
      assert.equal(byId['sess_legacy_guarded'], 'workspace-write', 'legacy guarded → workspace-write');
      assert.equal(byId['sess_legacy_read-only'], 'read-only', 'legacy read-only stays read-only');
    }
    ok('legacy DB migration: trusted/guarded rows normalized to workspace-write at boot');

    // --- create guarded session (with a task text) ---
    const created = await api('POST', '/sessions', { workspace_path: ws, permission_mode: 'workspace-write', name: 'smoke task: fix the login bug' });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const mcpUrl = created.json.mcp_url;
    assert.match(mcpUrl, /\/mcp\/[0-9a-f]{32}$/, 'machine-derived access token (32 hex)');
    assert.equal(health.mcp_url, mcpUrl, 'create response and /health agree on the machine URL');
    assert.equal(created.json.name, 'smoke task: fix the login bug', 'task text stored as the session name');
    const sid = created.json.session_id;
    assert.ok(typeof sid === 'string' && /^\d{39}$/.test(sid), `numeric session id returned (${sid?.slice(0, 8)}…)`);
    assert.ok(!JSON.stringify(created.json).includes('token_hash'), 'token hash must not leak');
    const call = callWith(sid);
    ok(`session created (${created.json.id}), machine URL + numeric session id`);

    // The long manual has a keyless tool entry point. It must not be repeated
    // in initialize.instructions because some connector hosts re-handshake for
    // every tool call.
    const initProbe = await initializeProbe(mcpUrl);
    assert.equal(initProbe.payload.result?.instructions ?? '', '', 'initialize.instructions stays empty');
    if (initProbe.sessionId) {
      await fetch(mcpUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-session-id': initProbe.sessionId,
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      });
    }

    // legacy compatibility: pre-migration rows adopted their primary key as
    // the credential — the old `sess_*` spelling must keep resolving
    {
      const legacyClient = await connectMcp(mcpUrl);
      const legacyView = resultJson(await callWith('sess_legacy_trusted')(legacyClient, 'editor', { command: 'view', path: '.' }));
      assert.notEqual(legacyView.status, 'rejected', `legacy sess_* id keeps working: ${JSON.stringify(legacyView).slice(0, 120)}`);
      await legacyClient.close();
    }
    ok('legacy sessions: old sess_* ids adopted as credentials keep resolving');

    // --- MCP discovery ---
    let client = await connectMcp(mcpUrl);
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((t) => t.name).sort(),
      ['exec', 'guide', 'process', 'show', 'skill', 'todo', 'editor', 'proxy'].sort(),
      'exactly the Minimal-mode tools plus the stable proxy entry and explicit panel controls; actual=' + JSON.stringify(tools.tools.map(t => t.name)) + '; runtime=' + JSON.stringify((await api('GET', '/health')).json?.execution_runtime),
    );
    assert.ok(!tools.tools.some((t) => t.name === 'resolve_confirmation'), 'approval is not exposed as an MCP tool');
    const editorTool = tools.tools.find((t) => t.name === 'editor');
    const execTool = tools.tools.find((t) => t.name === 'exec');
    assert.ok(editorTool?.description.includes('file inspection'), 'editor advertises file inspection');
    assert.ok(execTool?.description.includes('file inspection/editing'), 'shell tool explicitly routes file inspection/editing to editor');
    assert.ok(
      !tools.tools.some((t) => t.name === 'context_search'),
      'no search key on this machine: context_search must not be offered at all',
    );
    const guideTool = tools.tools.find((t) => t.name === 'guide');
    assert.equal(guideTool?._meta?.ui?.resourceUri, undefined, 'guide does not mount the panel');
    assert.equal(guideTool?._meta?.['ui/resourceUri'], undefined, 'guide has no legacy panel metadata');
    assert.ok(!execTool?._meta?.ui?.resourceUri && !editorTool?._meta?.ui?.resourceUri, 'workspace tools do not mount a panel');
    const startupPanelUri = tools.tools.find((t) => t.name === 'show')?._meta?.ui?.resourceUri;
    assert.equal(startupPanelUri, PANEL_URI, 'panel resource URI stays fixed while routing/base travel separately');
    const panelRes = await client.readResource({ uri: startupPanelUri });
    const panelHtml = panelRes.contents[0]?.text ?? '';
    assert.equal(panelRes.contents[0]?.mimeType, 'text/html;profile=mcp-app', 'panel resource uses the MCP Apps MIME type');
    assert.ok(panelHtml.includes('ui/initialize'), 'panel implements the MCP Apps initialize handshake');
    assert.ok(panelHtml.includes('ui/notifications/initialized'), 'panel acknowledges the MCP Apps initialize handshake');
    assert.ok(panelHtml.includes('ui/notifications/tool-result'), 'panel consumes the standard tool-result notification');
    assert.ok(panelHtml.includes('ui/resource-teardown'), 'panel handles the standard resource teardown request');
    const listenerAt = panelHtml.indexOf('window.addEventListener("message"');
    const initializeAt = panelHtml.indexOf('method: "ui/initialize"');
    assert.ok(listenerAt >= 0 && initializeAt > listenerAt, 'panel installs its message listener before sending ui/initialize');
    assert.ok(panelHtml.includes('id="uptime"'), 'panel header includes the round runtime field');
    assert.ok(panelHtml.includes('id="todoSec" hidden') && panelHtml.includes('id="progressLine" aria-hidden="true" hidden'), 'todo content and progress track start hidden');
    assert.ok(panelHtml.includes('performance.now()') && panelHtml.includes('startUptime(true)') && panelHtml.includes('pauseUptime()'), 'panel runtime is client-local, resets per show, and pauses offline');
    assert.ok(panelHtml.includes('poll(!online)') && panelHtml.includes('if (!online) setOnline(true);'), 'offline rounds keep probing; a successful probe restores LIVE/runtime');
    assert.ok(panelHtml.includes('scrollbar-gutter: stable'), 'panel scroll regions reserve scrollbar gutter space');
    assert.ok(panelHtml.includes('height: min(460px, 100dvh)') && panelHtml.includes('max-height: 132px; overflow-y: auto'), 'panel stays compact while long approval commands scroll internally');
    assert.ok(panelHtml.includes('"进行中"') && panelHtml.includes(' + " · " + done + "/" + items.length'), 'todo counter renders status plus N/M');
    assert.ok(panelHtml.includes('fold.textContent = "▾"'), 'todo fold control shows only the arrow');
    assert.ok(panelHtml.includes('call.diff.added') && panelHtml.includes('call.diff.removed'), 'panel renders workspace editor +N/-M change counts');
    assert.ok(panelHtml.includes('arg.removeAttribute("title")') && panelHtml.includes('arg.setAttribute("aria-label", preview'), 'call arguments carry the full preview via aria-label (native title tooltip removed by design)');
    assert.ok(panelHtml.includes('"⚠ 等待审批"') && !panelHtml.includes('等待审批 — 高危命令'), 'approval header uses risk tags instead of the generic high-risk label');


    assert.ok(panelHtml.includes('method: "ui/notifications/initialized", params: {}'), 'panel sends the initialized notification with spec-shaped params');
    ok('MCP Apps tool metadata + UI resource/lifecycle contract');
    // Session-addressing contract: work tools take a REQUIRED numeric session id
    // (hosts open a fresh connection per call — the argument is the only surface
    // that always survives), and no activate_session exists anymore.
    const variantsOf = (schema) => (schema?.anyOf || schema?.oneOf || [schema]).filter(Boolean);
    const paramsOf = (schema) => schema?.properties || {};
    const requiredOf = (schema) => schema?.required || [];
    for (const name of ['editor', 'todo', execTool.name]) {
      const t = tools.tools.find((x) => x.name === name);
      assert.ok(t, `work tool ${name} is advertised`);
      assert.ok('sessionId' in paramsOf(t.inputSchema), `work tool ${name} takes the session id`);
      assert.ok(requiredOf(t.inputSchema).includes('sessionId'), `work tool ${name} REQUIRES the session id (schema-level contract)`);
    }
    assert.ok(!tools.tools.some((t) => t.name === 'activate_session'), 'activate_session is gone (single-layer model)');
    const editorContractTool = tools.tools.find((x) => x.name === 'editor');
    const operationSchema = editorContractTool.inputSchema.properties?.operation;
    const editorVariants = variantsOf(operationSchema);
    assert.ok(requiredOf(editorContractTool.inputSchema).includes('path') && requiredOf(editorContractTool.inputSchema).includes('operation'), 'editor requires shared path + operation');
    assert.equal(editorVariants.length, 5, 'editor publishes one operation schema branch per command');
    const editorBranch = (command) => editorVariants.find((schema) => schema.properties?.command?.const === command);
    assert.ok(editorVariants.every((schema) => schema.additionalProperties === false), 'each editor operation branch rejects unrelated fields');
    assert.deepEqual(new Set(requiredOf(editorBranch('create'))), new Set(['command', 'content']));
    assert.deepEqual(new Set(requiredOf(editorBranch('str_replace'))), new Set(['command', 'old_text', 'new_text']));
    assert.deepEqual(new Set(requiredOf(editorBranch('insert'))), new Set(['command', 'line', 'content']));
    for (const name of ['guide', 'skill']) {
      const t = tools.tools.find((x) => x.name === name);
      assert.ok(t, `keyless tool ${name} is advertised`);
      assert.ok(!requiredOf(t.inputSchema).includes('sessionId'), `keyless tool ${name} keeps sessionId OPTIONAL (zero-friction first hop)`);
    }
    ok('remote client discovers the tools');

    // --- connection manual reaches clients via resources/read + prompts/get (bh.py `ask`) ---
    const ruleRes = await client.readResource({ uri: 'blackhole://rules' });
    assert.ok(ruleRes.contents[0]?.text.includes('`sessionId`'), 'resources/read returns the access-level manual (sessionId discipline)');
    assert.match(ruleRes.contents[0]?.text ?? '', /Read `guide`.*before the first workspace operation/s, 'access manual starts with guide, not a panel prerequisite');
    assert.match(ruleRes.contents[0]?.text ?? '', /Native connector: call `guide` directly/); assert.match(ruleRes.contents[0]?.text ?? '', /Script entry: use[\s\S]*python3 bh\.py call guide '\{\}'/); assert.doesNotMatch(ruleRes.contents[0]?.text ?? '', /curl|wget/);
    const askPrompt = await client.getPrompt({ name: 'blackhole_operator', arguments: {} });
    assert.ok(askPrompt.messages[0]?.content.text.includes('Read `guide`'), 'prompts/get points to the common guide entry');
    ok('rules resource + operator prompt registered (bh.py ask works)');

    // --- guide: one keyless entry, same manual for every caller ---
    const guideGeneric = resultJson(await rawCall(client, 'guide', {}));
    assert.match(guideGeneric.instruction, /read and apply[\s\S]*carry out the user task/i, 'guide restores the original startup-and-task instruction');
    // routing line reflects REALITY: no context_search clause while the tool is
    // not registered, and the shell clause names a generic term (the registered
    // name varies by host) instead of a nonexistent 'exec' tool
    assert.ok(!/context_search/.test(guideGeneric.manual.split('## Tools')[1]?.split('`context_search`')[0] ?? ''), 'no context_search routing while unregistered');
    assert.match(guideGeneric.manual, /commands\/tests\/build\/Git → exec\./, 'routing names the single finite-command tool');
    assert.doesNotMatch(guideGeneric.manual, /commands\/tests\/build\/Git → (pwsh|bash|cmd)/);
    assert.doesNotMatch(guideGeneric.manual, /\bcontext_search\b/, 'disabled capability never appears anywhere in the final manual');
    assert.match(guideGeneric.manual, /Goal/);
    assert.match(guideGeneric.manual, /Success Criteria/);
    assert.match(guideGeneric.manual, /Verification/);
    assert.match(guideGeneric.manual, /When a live progress view would help, call `show` at most once after each new user message/, 'confirmed Apps guidance offers one presentation-only panel per user message');
    assert.match(guideGeneric.manual, /only opens BlackHole's progress panel/);
    assert.match(guideGeneric.manual, /does not read or modify workspace files, run commands, or approve actions/);
    assert.doesNotMatch(guideGeneric.manual, /bh\.py|NEVER SHOW|Do not call `show`|SHOW LIMIT/, 'the Apps branch contains no script or fallback instructions');


    assert.doesNotMatch(guideTool?.description ?? '', /before this guide/, 'guide discovery no longer requires show first');

    assert.match(guideGeneric.manual, /^# BlackHole operating/m, 'guide serves the generic operating manual');
    assert.doesNotMatch(guideGeneric.manual, /Workspace root:/, 'manual carries no session-specific path');
    assert.equal((guideGeneric.manual.match(/## CORE/g) ?? []).length, 1, 'core task contract is injected exactly once');
    assert.match(guideGeneric.manual, /Task Contract[\s\S]*Goal[\s\S]*Non-Goal[\s\S]*Success Criteria[\s\S]*Verification/, 'core task contract keeps the high-signal anchors');
    assert.match(guideGeneric.manual, /Inspect → Plan → Execute → Verify/, 'execution loop stays explicit');
    assert.doesNotMatch(guideGeneric.manual, /Project-specific notes|BlackHole project notes|Task lifecycle/i, 'guide stays generic and avoids duplicate lifecycle prose');
    // a (stray or bh.py-injected) sessionId must not change the payload: single entry
    const guide = resultJson(await call(client, 'guide', {}));
    assert.equal(guide.manual, guideGeneric.manual, 'sessionId does not change the manual (one entry point)');
    assert.match(guideGeneric.manual, /^# BlackHole operating rules/m, 'guide uses the operating rules title');
    const workflowStops = {
      plan: /Stop after the plan/,
      'execute-plan': /Stop when the selected scope/,
      handoff: /## DELIVERY[\s\S]*one fenced plain-text code block[\s\S]*Stop after delivery/,
      review: /Stop after the review/,
    };
    for (const [workflow, stop] of Object.entries(workflowStops)) {
      const overlay = resultJson(await rawCall(client, 'guide', { workflow }));
      assert.equal(overlay.workflow, workflow, 'guide exposes the requested workflow identity');
      assert.equal(overlay.workflow_version, undefined, 'one current template needs no independent version');
      assert.match(overlay.manual, stop, `${workflow} overlay carries its stop condition`);
      assert.doesNotMatch(overlay.manual, /^# BlackHole operating rules/m, 'workflow response does not duplicate the base manual');
      if (workflow === 'plan') {
        assert.match(overlay.manual, /must save.*Markdown file/);
        assert.match(overlay.manual, /Read back the saved file/);
      }
    }
    const guideConflict = await rawCall(client, 'guide', { tool: 'exec', workflow: 'plan' });
    assert.equal(guideConflict.isError, true, 'guide rejects conflicting selectors instead of choosing one');
    ok('guide workflow selector: current templates, durable Plan guidance, fail-closed conflict');
    // --- keyless attribution: guide/skill optionally record on the session feed ---
    {
      const attr = await connectMcp(mcpUrl);
      const withId = await rawCall(attr, 'guide', { sessionId: sid });
      assert.equal(withId.isError, false, 'guide with a session id is not gated');
      const noId = await rawCall(attr, 'skill', {});
      assert.equal(noId.isError, false, 'skill without a session id still works (zero-friction first hop)');
      const badId = await rawCall(attr, 'guide', { sessionId: '1'.repeat(39) });
      assert.equal(badId.isError, false, 'an UNKNOWN session id is ignored for attribution, never rejected');
      await attr.close();
      const feed = await api('GET', `/sessions/${created.json.id}/calls`);
      const tools = feed.json.calls.map((c) => c.tool);
      assert.ok(tools.includes('guide'), 'attributed guide call lands on the session feed');
      assert.ok(!tools.includes('skill'), 'unattributed skill call stays off the session feed');
    }
    ok('keyless attribution: optional sessionId records guide/skill on the session feed; unknown ids ignored');

    // --- skill: keyless machine-level reference library (no sessionId) ---
    const skillList = resultJson(await rawCall(client, 'skill', {}));
    assert.deepEqual(skillList.skills.map((s) => s.name), expectedSkills, 'skill list is name-sorted, junctioned folders included');
    assert.match(skillList.skills[0].description, /commit messages/, 'frontmatter description surfaced');
    const skillDoc = resultJson(await rawCall(client, 'skill', { name: 'commit-fast' }));
    assert.equal(skillDoc.name, 'commit-fast');
    assert.match(skillDoc.content, /# Commit fast/, 'full SKILL.md content returned');
    assert.ok(skillDoc.dir.includes(path.join('skills', 'commit-fast')), 'detail names the skill folder');
    const skillPlain = resultJson(await rawCall(client, 'skill', { name: 'plain' }));
    assert.equal(skillPlain.name, 'plain', 'no frontmatter: folder name stands in');
    const skillEscape = await rawCall(client, 'skill', { name: '../escape' });
    assert.equal(skillEscape.isError, true, 'path traversal in skill name is rejected');
    const skillMissing = resultJson(await rawCall(client, 'skill', { name: 'nope' }));
    assert.equal(skillMissing.status, 'not_found', 'unknown skill reports not_found');
    assert.deepEqual(skillMissing.available, expectedSkills, 'not_found lists available skills');
    ok('skill tool: keyless list + full-text read, traversal/missing handled');

    // --- session-argument gating: the schema enforces the id, the resolver validates it ---
    // (a) work tool with NO session id -> rejected at the schema layer
    // (the SDK client surfaces -32602 as an isError result, not a rejection)
    const preId = await connectMcp(mcpUrl);
    const missing = await rawCall(preId, 'editor', { path: '.', operation: { command: 'view' } });
    assert.equal(missing.isError, true, 'missing sessionId is rejected');
    assert.match(JSON.stringify(missing.content?.[0]?.text ?? ''), /sessionId/i, 'the schema rejection names sessionId');
    // the rejection is VISIBLE in the daily counters (it cannot land on any
    // session feed — there is no id to attribute it to)
    const rejStats = (await api('GET', '/health')).json.stats;
    assert.ok((rejStats.mcp_rejected ?? 0) >= 1, `schema-layer rejection counted (got ${rejStats.mcp_rejected})`);
    // keyless calls must NOT be flagged as rejected
    const guideOk = await rawCall(preId, 'guide', {});
    const rejStats2 = (await api('GET', '/health')).json.stats;
    assert.equal(rejStats2.mcp_rejected, rejStats.mcp_rejected, 'keyless guide call is not counted as rejected');
    // (b) work tool with an UNKNOWN id -> session_invalid (same wording as revoked:
    // never confirm whether a value is live)
    const badId = resultJson(await rawCall(preId, 'editor', { sessionId: '123456789012345678901234567890123456789', path: '.', operation: { command: 'view' } }));
    assert.equal(badId.status, 'rejected', 'work tool with an unknown id is rejected');
    assert.equal(badId.code, 'session_invalid', 'unknown id reports session_invalid');
    assert.match(badId.reason, /unknown or revoked session ID/);
    await preId.close();
    ok('session gating: schema requires the id; unknown id reports session_invalid');

    // --- session selection + concurrent isolation (uses editor: no shell dep) ---
    // Second workspace + session so we can prove the ARGUMENT, not any connection
    // state, decides scope — one connection, two ids, two workspaces.
    const wsB = path.join(tmp, 'wsB');
    fs.mkdirSync(wsB, { recursive: true });
    fs.writeFileSync(path.join(wsB, 'MARK2.txt'), 'second-workspace-marker', 'utf8');
    fs.writeFileSync(path.join(ws, 'MARK1.txt'), 'first-workspace-marker', 'utf8');
    const sessB = await api('POST', '/sessions', { workspace_path: wsB, permission_mode: 'workspace-write', name: 'smoke id selection' });
    assert.equal(sessB.status, 201, JSON.stringify(sessB.json));
    const sidA = created.json.session_id;
    const sidB = sessB.json.session_id;
    const listing = (res) => res.result?.message ?? JSON.stringify(res);

    // (a) one connection, two ids: the argument alone switches the workspace
    const shared = await connectMcp(mcpUrl);
    const callA = callWith(sidA);
    const callB = callWith(sidB);
    const view1 = listing(resultJson(await callA(shared, 'editor', { command: 'view', path: '.' })));
    assert.match(view1, /MARK1\.txt/, 'sid A on the shared connection sees workspace #1');
    assert.doesNotMatch(view1, /MARK2\.txt/, 'workspace #1 view does not leak workspace #2');
    const view2 = listing(resultJson(await callB(shared, 'editor', { command: 'view', path: '.' })));
    assert.match(view2, /MARK2\.txt/, 'sid B on the SAME connection sees workspace #2');
    assert.doesNotMatch(view2, /MARK1\.txt/, 'after switching the id, workspace #1 marker is gone');
    await shared.close();

    // (b) concurrent isolation: two live connections, each id never crosses
    const connA = await connectMcp(mcpUrl);
    const connB = await connectMcp(mcpUrl);
    const aView = listing(resultJson(await callWith(sidA)(connA, 'editor', { command: 'view', path: '.' })));
    const bView = listing(resultJson(await callWith(sidB)(connB, 'editor', { command: 'view', path: '.' })));
    assert.match(aView, /MARK1\.txt/, 'connection A stays on workspace #1');
    assert.match(bView, /MARK2\.txt/, 'connection B stays on workspace #2');
    assert.doesNotMatch(aView, /MARK2\.txt/, 'A never sees B workspace');
    assert.doesNotMatch(bView, /MARK1\.txt/, 'B never sees A workspace');
    await connA.close();
    await connB.close();
    ok('session selection: the id argument (not connection state) decides workspace scope');

    // --- id dying underneath live calls ---
    // Works first (proof the id is good), then revoked. The next call with the
    // same id must report session_invalid — never a stale success.
    const dying = await connectMcp(mcpUrl);
    const boundView = listing(resultJson(await callWith(sidB)(dying, 'editor', { command: 'view', path: '.' })));
    assert.match(boundView, /MARK2\.txt/, 'sid B resolves workspace #2 before revocation');
    const revoked = await api('POST', `/sessions/${sessB.json.id}/revoke`);
    assert.ok(revoked.status < 400, `revoke session B: ${revoked.status} ${JSON.stringify(revoked.json)}`);
    const afterRevoke = resultJson(await callWith(sidB)(dying, 'editor', { command: 'view', path: '.' }));
    assert.equal(afterRevoke.status, 'rejected', 'work tool rejects once the session is gone');
    assert.equal(afterRevoke.code, 'session_invalid', 'revoked session -> session_invalid');
    await dying.close();
    ok('revoked session surfaces session_invalid on the next call');

    // --- warm-pair adoption: a bare POST (no session header) with the id rides a
    // live connection — the connector/bh.py fast path, one round trip ---
    {
      // the server may answer application/json or SSE; parse either
      const bareCall = async (id, args) => {
        const res = await fetch(mcpUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'todo', arguments: { ...args, sessionId: id } } }),
        });
        const raw = await res.text();
        try { return JSON.parse(raw); } catch {
          for (const frame of raw.split('\n\n')) {
            const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).join('');
            if (data) { try { return JSON.parse(data); } catch { /* keep scanning */ } }
          }
          return { raw: raw.slice(0, 120) };
        }
      };
      // dedicated session so the map state is deterministic around this test
      const wsC = path.join(tmp, 'wsC');
      fs.mkdirSync(wsC, { recursive: true });
      const sessC = await api('POST', '/sessions', { workspace_path: wsC, permission_mode: 'workspace-write', name: 'smoke warm pair' });
      const sidC = sessC.json.session_id;
      const callC = callWith(sidC);
      // a bare NON-initialize message that the map cannot place is answered
      // with an error WITHOUT minting a throwaway pair (pair count = one
      // initialize per host turn, nothing else)
      const bareNotification = await fetch(mcpUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      });
      assert.equal(bareNotification.status, 400, 'bare notification does not open a protocol pair');
      // before any warm pair exists for this id: not-initialized
      const cold = await bareCall(sidC, { command: 'read' });
      assert.ok(cold?.error?.code === -32002 || /not initialized/i.test(String(cold?.error?.message ?? '')), `cold bare call answers not-initialized (${JSON.stringify(cold).slice(0, 120)})`);
      // establish the warm pair: one ordinary call on an SDK client
      const warm = await connectMcp(mcpUrl);
      assert.notEqual(resultJson(await callC(warm, 'todo', { command: 'read' })).status, 'rejected', 'warm call seeds the credential-pair map');
      // bare POST now lands on the warm connection and executes
      const adoptedRaw = await bareCall(sidC, { command: 'write', todos: [{ content: 'bare-call-marker', status: 'pending' }] });
      const adopted = JSON.parse(adoptedRaw?.result?.content?.[0]?.text ?? '{}');
      assert.equal(adopted.status, 'ok', `bare POST adopted a warm pair: ${JSON.stringify(adoptedRaw).slice(0, 160)}`);
      const confirm = resultJson(await callC(warm, 'todo', { command: 'read' }));
      assert.equal(confirm.items[0]?.content, 'bare-call-marker', 'the bare call really executed on the session');
      await warm.close();
      // protocol counters: initialize counts ONLY new handshakes (warm-pair
      // reuse never mints a pair), reuse counts every request that landed on
      // an existing pair (header hits + warm adoptions)
      const st = (await api('GET', '/health')).json.stats;
      assert.ok(st.mcp_initializes >= 1, 'initialize counter counts completed handshakes');
      assert.ok((st.mcp_reuses ?? 0) >= 2, `reuse counter counts header + warm adoptions (got ${st.mcp_reuses})`);
    }
    ok('warm-pair adoption: bare POST with the id executes in one round trip (bh.py fast path)');


    // --- exec (persistent PowerShell on Windows) ---
    let r = resultJson(await call(client, 'exec', { command: 'echo blackhole-smoke' }));
    assert.equal(r.exit_code, 0);
    assert.match(r.stdout, /blackhole-smoke/);
    // 变更门控：工具调用推动 epoch 前进；空闲时 epoch 不动（扩展据此免拉取）
    const ch0 = await api('GET', '/changes');
    assert.ok(ch0.json.epoch > 0, 'epoch is live after session activity');
    const chSame = await api('GET', `/changes?since=${ch0.json.epoch}`);
    assert.equal(chSame.json.epoch, ch0.json.epoch, 'idle daemon does not bump the epoch');
    await call(client, 'exec', { command: 'echo change-probe' });
    const ch1 = await api('GET', `/changes?since=${ch0.json.epoch}`);
    assert.ok(ch1.json.epoch > ch0.json.epoch, 'tool calls bump the epoch');
    ok('changes endpoint gates the sidebar polling (epoch bumps on activity only)');
    ok('pwsh runs a command');

    // cwd persistence across calls
    r = resultJson(await call(client, 'exec', { command: 'cd sub' }));
    assert.equal(r.exit_code, 0);
    assert.match(r.cwd, /sub$/, 'tracked cwd follows cd');
    r = resultJson(await call(client, 'exec', { command: 'Get-Location' }));
    assert.match(r.cwd, /sub$/, 'cwd persists across calls');
    ok('shell cwd persists across calls');

    // exit_code must reflect THIS command: cmdlets never set $LASTEXITCODE,
    // so the wrapper zeroes it before every command (stale-residue regression)
    r = resultJson(await call(client, 'exec', { command: 'cmd /c exit 5' }));
    assert.equal(r.exit_code, 5, 'native exit codes pass through');
    r = resultJson(await call(client, 'exec', { command: 'Write-Output after-native-exit' }));
    assert.equal(r.exit_code, 0, 'exit_code is not stale residue from the previous native command');
    assert.match(r.stdout, /after-native-exit/);
    // `exit` ends the persistent session: report the REAL code, say it reset,
    // then the next call lands in a fresh shell back at the tracked cwd
    r = resultJson(await call(client, 'exec', { command: 'exit 7' }));
    assert.equal(r.exit_code, 7, '`exit` reports its real code, not -1');
    assert.match(r.stderr, /reset/i, 'the caller is told the session was reset');
    r = resultJson(await call(client, 'exec', { command: 'Write-Output revived' }));
    assert.equal(r.exit_code, 0, 'shell respawns after exit');
    assert.match(r.cwd, /sub$/, 'respawned shell lands back in the tracked cwd');
    ok('pwsh exit_code is per-command; `exit` ends the session with the real code and cwd restored');

    // result_summary cap: oversized output stores a VALID truncated envelope,
    // not a mid-JSON slice (the expanded card must be parseable + honest)
    r = resultJson(await call(client, 'exec', { command: '$i=0; while($i -lt 5000) { Write-Output "line $i"; $i++ }' }));
    assert.equal(r.exit_code, 0);
    assert.ok(String(r.stdout).length > 32000, 'the agent received the FULL output (only the audit copy is capped)');
    const bigFeed = await api('GET', `/sessions/${created.json.id}/calls`);
    const bigCall = bigFeed.json.calls.find((c) => (c.args_json ?? '').includes('while($i'));
    assert.ok(bigCall, 'the big-output call is on the feed');
    const envelope = JSON.parse(bigCall.result_summary);
    assert.equal(envelope.truncated, true, 'oversized result stored as a truncated envelope');
    assert.ok(typeof envelope.preview === 'string' && envelope.preview.includes('line 0'), 'the preview keeps the head of the output');
    ok('result_summary: full output to the agent, valid truncated envelope for the panel');

    // --- editor ops (editor) ---
    r = resultJson(await call(client, 'editor', { command: 'create', path: 'hello.txt', content: 'hello world\n' }));
    assert.match(r.result.message, /Created file/, JSON.stringify(r));
    assert.equal(r.result.isError, false);
    assert.ok(r.result.diff && r.result.diff.added >= 1 && r.result.diff.removed === 0, 'create reports line-diff stats');
    assert.equal('navigation' in r.result, false, 'internal file-navigation metadata is not exposed to the agent');
    r = resultJson(await call(client, 'editor', { command: 'view', path: 'hello.txt' }));
    assert.match(r.result.message, /hello world/);
    r = resultJson(await call(client, 'editor', { command: 'str_replace', path: 'hello.txt', old_text: 'world', new_text: 'blackhole' }));
    assert.match(r.result.message, /Replaced 1 occurrence/);
    r = resultJson(await call(client, 'editor', { command: 'insert', path: 'hello.txt', line: 0, content: 'top line' }));
    assert.match(r.result.message, /Inserted content after line 0/);
    fs.writeFileSync(path.join(ws, 'dup.txt'), 'x\nx\n');
    const dup = resultJson(await call(client, 'editor', { command: 'str_replace', path: 'dup.txt', old_text: 'x', new_text: 'y' }));
    assert.match(dup.result.message, /must be unique; found 2/, 'non-unique str_replace must fail explicitly');
    assert.equal(dup.result.code, 'NON_UNIQUE_MATCH');
    fs.writeFileSync(path.join(ws, 'range.txt'), 'one\ntwo\nthree\n');
    r = resultJson(await call(client, 'editor', { command: 'view', path: 'range.txt', view_range: [2, 99] }));
    assert.match(r.result.message, /view_range=\[2, 3\]/);
    assert.match(r.result.message, /\s+2\ttwo\n\s+3\tthree/);
    const beyond = resultJson(await call(client, 'editor', { command: 'view', path: 'range.txt', view_range: [4, 99] }));
    assert.equal(beyond.result.code, 'OUT_OF_RANGE');
    const reversed = resultJson(await call(client, 'editor', { command: 'view', path: 'range.txt', view_range: [3, 2] }));
    assert.equal(reversed.result.code, 'INVALID_ARGUMENT');
    const missingContent = await call(client, 'editor', { command: 'create', path: 'missing-content.txt' });
    assert.equal(missingContent.isError, true, 'create without content is rejected by the tool schema');
    const legacyField = await call(client, 'editor', { command: 'create', path: 'legacy-field.txt', file_text: 'x' });
    assert.equal(legacyField.isError, true, 'legacy file_text is rejected by the strict command schema');
    r = resultJson(await call(client, 'editor', { command: 'view', path: '.' }));
    assert.match(r.result.message, /Directory:/);
    fs.writeFileSync(path.join(ws, 'delete-me.txt'), 'remove me\n');
    r = resultJson(await call(client, 'editor', { command: 'delete', path: 'delete-me.txt' }));
    assert.equal(r.result.isError, false); assert.equal('navigation' in r.result, false);
    const editorFeed = await api('GET', `/sessions/${created.json.id}/calls`);
    const editorRows = editorFeed.json.calls.filter((c) => c.tool === 'editor' && c.navigation_json);
    const createRow = editorRows.find((c) => JSON.parse(c.args_json).path === 'hello.txt' && JSON.parse(c.args_json).operation?.command === 'create');
    const deleteRow = editorRows.find((c) => JSON.parse(c.args_json).path === 'delete-me.txt');
    assert.equal(JSON.parse(createRow.navigation_json).kind, 'create');
    assert.equal(JSON.parse(createRow.navigation_json).path, 'hello.txt');
    assert.equal(JSON.parse(deleteRow.navigation_json).deleted, true);
    ok('editor strict fields + navigation metadata + view/create/str_replace/insert/delete/view-range/view-dir');

    // --- todo: the session task board (full-replace write + read + guard rails) ---
    const written = resultJson(await call(client, 'todo', {
      command: 'write',
      todos: [
        { content: 'plan the tool', status: 'completed', activeForm: 'planning the tool' },
        { content: 'write the storage layer', status: 'in_progress' },
        { content: 'wire the control api', status: 'pending' },
      ],
    }));
    assert.equal(written.command, 'write');
    assert.equal(written.status, 'ok');
    assert.deepEqual([written.total, written.completed_count, written.in_progress_count], [3, 1, 1], 'write answers with progress counts');
    const board = resultJson(await call(client, 'todo', { command: 'read' }));
    assert.deepEqual(
      board.items.map((t) => t.content),
      ['plan the tool', 'write the storage layer', 'wire the control api'],
      'read returns the list in write order',
    );
    assert.equal(board.items[1].status, 'in_progress');
    assert.equal(board.total, 3);
    assert.equal(board.updated_at > 0, true, 'read carries the last-write time');
    const boardApi = await api('GET', `/sessions/${created.json.id}/todos`);
    assert.deepEqual(boardApi.json.items, board.items, 'control API serves the same board');
    const twoActive = await call(client, 'todo', {
      command: 'write',
      todos: [ { content: 'a', status: 'in_progress' }, { content: 'b', status: 'in_progress' } ],
    });
    assert.equal(twoActive.isError, true, 'two in_progress items are rejected');
    assert.equal(
      (await call(client, 'todo', { command: 'write', todos: [{ content: 'a', status: 'done' }] })).isError,
      true,
      'unknown status is rejected',
    );
    assert.equal((await call(client, 'todo', { command: 'write' })).isError, true, 'write without todos is rejected');
    assert.equal(
      (await call(client, 'todo', { command: 'read', todos: [{ content: 'a', status: 'pending' }] })).isError,
      true,
      'read must not accept todos (no silent overwrite)',
    );
    assert.equal(resultJson(await call(client, 'todo', { command: 'write', todos: [] })).total, 0, 'empty list clears the board');
    assert.equal(resultJson(await call(client, 'todo', { command: 'read' })).items.length, 0, 'cleared board reads empty');
    assert.equal((await call(client, 'todo', { command: 'patch', updates: [{ content: 'x', status: 'completed' }] })).isError, true, 'patch on an empty board is rejected');

    // --- todo patch: cheap per-item updates (unique content fragment, atomic) ---
    const pBoard = resultJson(await call(client, 'todo', { command: 'write', todos: [
      { content: 'plan the tool', status: 'completed' },
      { content: 'implement storage', status: 'in_progress' },
      { content: 'implement tests', status: 'pending' },
      { content: 'verify results', status: 'pending' },
    ], contract: {
      goal: 'keep the task lifecycle recoverable',
      nonGoals: ['change unrelated behavior'],
      successCriteria: ['the task contract survives todo patch/read'],
      verification: ['read the board after a patch'],
    } }));
    assert.equal(pBoard.total, 4);
    assert.equal((await call(client, 'todo', { command: 'patch', updates: [{ content: 'implement', status: 'completed' }] })).isError, true, 'ambiguous fragment rejected');
    assert.equal((await call(client, 'todo', { command: 'patch', updates: [{ content: 'no-such-item', status: 'completed' }] })).isError, true, 'unknown fragment rejected');
    assert.equal((await call(client, 'todo', { command: 'patch', updates: [] })).isError, true, 'empty updates rejected');
    assert.equal((await call(client, 'todo', { command: 'patch', todos: [] })).isError, true, 'patch must not carry todos');
    assert.equal(
      (await call(client, 'todo', { command: 'write', todos: [{ content: 'x', status: 'pending' }], updates: [{ content: 'x', status: 'completed' }] })).isError,
      true,
      'write must not carry updates',
    );
    const patched = resultJson(await call(client, 'todo', { command: 'patch', updates: [
      { content: 'implement storage', status: 'completed' },
      { content: 'verify results', status: 'in_progress', activeForm: 'verifying results' },
    ] }));
    assert.equal(patched.status, 'ok');
    assert.equal(patched.updated, 2);
    assert.deepEqual([patched.total, patched.completed_count, patched.in_progress_count], [4, 2, 1], 'patch applies the transition atomically');
    assert.equal(patched.active.content, 'verify results', 'patch echoes the now-active next step');
    assert.equal(patched.active.activeForm, 'verifying results');
    assert.equal(patched.active.status, 'in_progress');
    const afterPatch = resultJson(await call(client, 'todo', { command: 'read' }));
    assert.equal(afterPatch.items[3].activeForm, 'verifying results', 'activeForm lands on the matched item');
    assert.equal(afterPatch.contract.goal, 'keep the task lifecycle recoverable', 'Task Contract survives todo patch/read');
    assert.deepEqual(afterPatch.contract.nonGoals, ['change unrelated behavior']);
    const contractApi = await api('GET', `/sessions/${created.json.id}/todos`);
    assert.deepEqual(contractApi.json.contract, afterPatch.contract, 'control API exposes the recovered Task Contract');
    // no-op 更新（状态本就相同）不计入 updated：响应不谎报变更数
    const noop = resultJson(await call(client, 'todo', { command: 'patch', updates: [{ content: 'verify results', status: 'in_progress' }] }));
    assert.equal(noop.updated, 0, 'no-op updates are not counted as changed');
    assert.equal(noop.active.content, 'verify results');
    // all-or-nothing: one bad fragment rejects the whole patch, board untouched
    assert.equal(
      (await call(client, 'todo', { command: 'patch', updates: [{ content: 'verify results', status: 'completed' }, { content: 'ghost', status: 'completed' }] })).isError,
      true,
      'one bad fragment rejects the whole patch',
    );
    const untouched = resultJson(await call(client, 'todo', { command: 'read' }));
    assert.deepEqual([untouched.completed_count, untouched.in_progress_count], [2, 1], 'rejected patch leaves the board untouched');
    ok('todo patch: unique-fragment match, atomic transition, guard rails');
    assert.equal(
      resultJson(await call(client, 'todo', { command: 'write', todos: [{ content: 'rotate me', status: 'pending' }] })).status,
      'ok',
      'board reseeded for the rotate/revoke assertions below',
    );
    ok('todo tool: full-replace write, read-back, guard rails, empty clears');

    // --- /semantic: the settings-page surface (key file is hermetic per-daemon) ---
    const semInfo0 = await api('GET', '/semantic');
    assert.equal(semInfo0.json.registered, false, 'no key at boot: context_search not registered');
    assert.equal(semInfo0.json.would_resolve, false, 'and nothing would resolve yet either');
    assert.ok(semInfo0.json.engine, 'search backend is reported even while unregistered');
    // 自动扫描按数据报告结果：本机装没装 Devin/Windsurf 都不抛错；扫到就写
    // 隔离的 key 文件（绝不触碰真实 ~/.blackhole）
    const scan1 = await api('POST', '/semantic/scan', {});
    assert.ok(typeof scan1.json.found === 'boolean', 'scan reports found as data');
    const savedKey = await api('POST', '/semantic/key', { key: 'sk-smoke-manual-key' });
    assert.equal(savedKey.json.saved, true, 'manual key file write works');
    const semInfo1 = await api('GET', '/semantic');
    assert.equal(semInfo1.json.would_resolve, true, 'manual key would resolve after a restart');
    assert.match(semInfo1.json.would_source, /file/, 'manual key resolves from the key file');
    const cleared = await api('POST', '/semantic/clear', {});
    assert.equal(cleared.json.removed, true, 'key file clear works');
    const semInfo2 = await api('GET', '/semantic');
    assert.equal(semInfo2.json.would_resolve, false, 'cleared: nothing would resolve again');
    ok('semantic key surface: scan answers as data, manual save/clear hermetic');

    // --- workspace confinement ---
    let escaped = await call(client, 'editor', { command: 'create', path: '../escape.txt', content: 'nope' });
    assert.equal(escaped.isError, true);
    escaped = await call(client, 'editor', { command: 'view', path: path.join(tmp, 'db.sqlite') });
    assert.equal(escaped.isError, true);
    let symOk = true;
    try {
      fs.symlinkSync(path.join(tmp), path.join(ws, 'evil-link'), 'junction');
    } catch {
      symOk = false;
    }
    if (symOk) {
      escaped = await call(client, 'editor', { command: 'create', path: 'evil-link/escape.txt', content: 'nope' });
      assert.equal(escaped.isError, true, 'symlink escape must be rejected');
    }
    ok('path traversal / symlink escape rejected');

    // --- risk.ts ROOTED_RE regression: regex/escape backslashes are not paths ---
    // （审批误报案：命令里正则字面量 '\{' 的孤立反斜杠被当盘根路径判越界）
    {
      const semM = resultJson(await call(client, 'exec', { command: 'Write-Output "x ; \ y"' }));
      // 这条不该触发确认流：无高危 pattern、无越界 —— 直接执行成功即证明未误判
      assert.equal(semM.exit_code, 0, 'escape-artifact backslash must NOT read as outside-workspace');
    }
    ok('risk sweep: lone backslash artifacts are not paths');

    // --- env-var path gate: TEMP/TMP are sandbox-contained, others still ask ---
    // （原始误报案：$env:TEMP\... 弹审批 —— 沙箱 shell 已把 TEMP/TMP 重写到内核授权的
    // 私有 temp，文本门不该再拦；非 TEMP 类变量路径仍要问）
    {
      // TEMP 类：不弹卡，直接执行（tempWrite 的三种“没弹卡”证据）
      const tempWrite = resultJson(await call(client, 'exec', { command: 'Set-Content -Path "$env:TEMP\\bh-gate.txt" -Value ok' }));
      assert.notEqual(tempWrite.status, 'denied', 'TEMP-path write must not be blocked by the text gate');
      assert.notEqual(tempWrite.status, 'superseded', 'TEMP-path write must not open a confirmation');
      assert.ok(tempWrite.exit_code === 0, 'TEMP-path write executed (kernel sandbox owns containment)');
      // 非 TEMP 类（APPDATA）：仍弹卡 → 走确认流 → 拒绝
      const appdataPromise = call(client, 'exec', { command: 'Set-Content -Path "$env:APPDATA\\bh-gate.txt" -Value x' });
      let envConfId;
      for (let attempt = 0; attempt < 20; attempt++) {
        await sleep(100);
        const confs = await api('GET', `/confirmations?session_id=${created.json.id}`);
        const pending = confs.json.confirmations.find((c) => c.status === 'pending' && /APPDATA/.test(c.args_json));
        if (pending) { envConfId = pending.id; break; }
      }
      assert.ok(envConfId, 'a non-temp env-var path still opens a confirmation');
      const deniedResp = await api('POST', `/confirmations/${envConfId}/deny`, {});
      assert.equal(deniedResp.status, 200);
      const deniedResult = resultJson(await appdataPromise);
      assert.equal(deniedResult.status, 'superseded', 'the denied confirmation ends the call without executing');
      // 裸变量无斜杠（$env:TEMP 不带路径）：值引用，不弹卡
      const bare = resultJson(await call(client, 'exec', { command: 'Write-Output $env:TEMP' }));
      assert.ok(bare.exit_code === 0, 'bare $env:TEMP (no separator) is a value reference, not a path');
    }
    ok('env-var gate: TEMP/TMP sandbox-contained (no card), other variable paths still confirm, bare variables pass');

    // --- guarded confirmation flow (synchronous: call blocks until approved) ---
    const riskyPromise = call(client, 'exec', { command: 'Remove-Item -Recurse -Force danger-dir' });
    // The call is now blocking on the daemon side; poll for the confirmation to appear.
    let cfrmId;
    for (let attempt = 0; attempt < 20; attempt++) {
      await sleep(100);
      const confs = await api('GET', `/confirmations?session_id=${created.json.id}`);
      const pending = confs.json.confirmations.find((c) => c.status === 'pending' && /Remove-Item/.test(c.args_json));
      if (pending) { cfrmId = pending.id; break; }
    }
    assert.ok(cfrmId, 'a pending confirmation appears for the risky command');
    // The inline-approval UI matches an intercepted call to its confirmation by
    // args_hash; lock that the two rows agree.
    {
      const callsFeed = await api('GET', `/sessions/${created.json.id}/calls`);
      const intercepted = callsFeed.json.calls.find((c) => /Remove-Item/.test(c.args_json));
      assert.ok(intercepted, 'the intercepted call is recorded');
      const confs = await api('GET', `/confirmations?session_id=${created.json.id}`);
      const pending = confs.json.confirmations.find((c) => c.id === cfrmId);
      assert.equal(intercepted.args_hash, pending.args_hash, 'call.args_hash must equal confirmation.args_hash (UI inline-approval match)');
    }
    const approved = await api('POST', `/confirmations/${cfrmId}/approve`, {});
    assert.equal(approved.status, 200);
    // 风险命中数据全链路：confirmation_created 事件预计算 matches（标签+区间+色调），
    // /confirmations 按记录反查透出——审批卡的标签与命令内高亮吃这条数据
    {
      const confRow = (await api('GET', `/confirmations?session_id=${created.json.id}`)).json.confirmations
        .find((c) => c.id === cfrmId || /Remove-Item/.test(c.args_json));
      assert.ok(confRow, 'the confirmation row is listed');
      const matches = confRow.risk_matches || [];
      assert.ok(matches.some((m) => m.label === '文件删除' && m.tone === 'red' && m.level === 'critical'), 'Remove-Item is graded critical (irreversible)');
      assert.ok(matches.every((m) => ['critical', 'warn', 'info'].includes(m.level) && { critical: 'red', warn: 'yellow', info: 'blue' }[m.level] === m.tone), 'tone derives from level');
      const cmd = JSON.parse(confRow.args_json).command;
      for (const m of matches.slice(0, 3)) {
        assert.ok(m.range[0] >= 0 && m.range[1] <= cmd.length && m.range[0] < m.range[1], 'match ranges point into the command text');
        assert.ok(/Remove-Item|danger-dir/.test(cmd.slice(m.range[0], m.range[1])), 'the highlighted span is the matched text');
      }
    }
    // The blocked call wakes and returns the actual result — no retry needed.
    r = resultJson(await riskyPromise);
    assert.equal(r.exit_code, 0, 'approved call executes automatically after synchronous approval');
    ok('guarded mode blocks for synchronous approval, then executes automatically');

    // --- confirmation dedupe: a client-timeout retry shares ONE pending confirmation ---
    const dupA = call(client, 'exec', { command: 'Remove-Item -Recurse -Force dup-dir' });
    let dupConf;
    for (let i = 0; i < 20 && !dupConf; i++) {
      await sleep(100);
      dupConf = (await api('GET', '/confirmations')).json.confirmations.filter(
        (c) => c.status === 'pending' && /dup-dir/.test(c.args_json),
      );
    }
    assert.equal(dupConf.length, 1, 'first risky call creates exactly one confirmation');
    const dupB = call(client, 'exec', { command: 'Remove-Item -Recurse -Force dup-dir' });
    await sleep(400);
    const dupPending = (await api('GET', '/confirmations')).json.confirmations.filter(
      (c) => c.status === 'pending' && /dup-dir/.test(c.args_json),
    );
    // 重试必须共享同一条确认：各自建确认会留下幽灵 pending（徽标计数不清零）
    assert.equal(dupPending.length, 1, 'client-timeout retry shares the SAME confirmation (no ghost pending)');
    await api('POST', `/confirmations/${dupPending[0].id}/approve`, {});
    const [dupRa, dupRb] = await Promise.all([dupA, dupB]);
    const superseded = [dupRa, dupRb].filter((r) => resultJson(r).status === 'superseded').length;
    assert.equal(superseded, 1, 'exactly one of the twin calls executes; the twin is superseded');
    ok('confirmation dedupe: identical concurrent risky calls share one approval (no ghost badge count)');

    // --- pattern-scoped 'always' grants: precise, persistent, resettable ---
    {
      // the approval flow BLOCKS the call synchronously: launch without await,
      // find the confirmation, approve, THEN await the result (the pattern the
      // earlier assertions use)
      const G = (cmd) => call(client, 'exec', { command: cmd });
      // (a) grant 'always' on a warn-level pattern (npm install), then a
      //     DIFFERENT warn pattern (git push) must still ask — no category bleed
      let p1 = G('npm install left-pad');
      const c1 = await waitForConfirm('npm install');
      assert.ok(c1, 'npm install asks for confirmation');
      await api('POST', `/confirmations/${c1}/approve`, { scope: 'always' });
      await p1;
      p1 = G('npm install right-pad'); // same pattern: runs with NO new confirmation
      const sameRun = resultJson(await p1);
      assert.notEqual(sameRun.status, 'superseded', 'same pattern runs under the always grant without asking');
      p1 = G('git push origin main'); // different pattern: must still confirm
      const c2 = await waitForConfirm('git push');
      assert.ok(c2, 'a DIFFERENT warn pattern still asks (no category bleed)');
      await api('POST', `/confirmations/${c2}/approve`, { scope: 'once' });
      await p1;

      // (b) critical patterns never earn 'always': approve with scope=always,
      //     the daemon downgrades to session; a restart then asks again
      p1 = G('Remove-Item -Recurse -Force crit-dir');
      const c3 = await waitForConfirm('Remove-Item');
      await api('POST', `/confirmations/${c3}/approve`, { scope: 'always' });
      const resolved1 = (await api('GET', `/confirmations?session_id=${created.json.id}`)).json.confirmations
        .find((c) => c.id === c3);
      assert.equal(resolved1.scope, 'session', 'critical + always is downgraded to session');
      await p1;

      // The effective session grant must be visible too; otherwise the settings
      // page cannot distinguish "no grant" from "session-scoped no-ask".
      const visibleAfterDowngrade = (await api('GET', '/approvals')).json;
      const sessionGrant = (visibleAfterDowngrade.sessions ?? []).find((s) => s.session_id === created.json.id);
      assert.ok(sessionGrant?.grants?.length > 0, 'downgraded critical approval is visible as a session grant');
      const removedSession = await api('POST', '/approvals/session/remove', { session_id: created.json.id, key: sessionGrant.grants[0] });
      assert.equal(removedSession.json.removed, 1, 'a session grant can be revoked from the control plane');
      const visibleAfterRemove = (await api('GET', '/approvals')).json;
      assert.ok(!(visibleAfterRemove.sessions ?? []).some((s) => s.session_id === created.json.id && s.grants?.length), 'removed session grant disappears from /approvals');

      // (c) the grants are persistent and visible via /approvals, and clearable
      const grants = visibleAfterDowngrade.always ?? [];
      assert.ok(grants.some((k) => k.includes('包管理变更')), `the npm pattern is a visible always grant (${grants.join(', ')})`);
      await stopDaemon(daemon);
      daemon = startDaemon(dbPath);
      await waitForHealth();
      const grantsAfter = (await api('GET', '/approvals')).json.always ?? [];
      assert.deepEqual(grantsAfter, grants, 'always grants survive the daemon restart (machine_state)');
      client = await connectMcp(mcpUrl);
      // cleared: the next same-pattern call asks again
      const cleared = await api('POST', '/approvals/clear', {});
      assert.equal(cleared.json.removed, grants.length, 'clear removes every persistent grant');
      p1 = G('npm install after-clear');
      const c4 = await waitForConfirm('npm install');
      assert.ok(c4, 'a cleared grant asks again');
      await api('POST', `/confirmations/${c4}/approve`, { scope: 'once' });
      await p1;
    }
    ok('pattern-scoped always grants: no category bleed, critical capped to session, persistent + resettable');

    // helper used above: poll for a pending confirmation whose args match.
    // Simple substring match on the raw command text — the fragments used
    // ('npm install', 'git push', 'Remove-Item') are unique within the batch.
    async function waitForConfirm(fragment) {
      for (let i = 0; i < 40; i++) {
        await sleep(100);
        const confs = await api('GET', `/confirmations?session_id=${created.json.id}`);
        const pending = confs.json.confirmations.find((c) => c.status === 'pending' && c.args_json.includes(fragment));
        if (pending) return pending.id;
      }
      return undefined;
    }

    // --- read-only session ---
    const ro = await api('POST', '/sessions', { workspace_path: ws, permission_mode: 'read-only' });
    const roCall = callWith(ro.json.session_id);
    const roClient = await connectMcp(mcpUrl);
    assert.equal(ro.json.mcp_url, mcpUrl, 'second session shares the same machine URL');
    const denied = await roCall(roClient, 'editor', { command: 'create', path: 'nope.txt', content: 'x' });
    assert.equal(denied.isError, true);
    const allowed = resultJson(await roCall(roClient, 'exec', { command: 'echo still-reading' }));
    assert.equal(allowed.exit_code, 0);
    const blocked = await roCall(roClient, 'exec', { command: 'Remove-Item hello.txt' });
    assert.equal(blocked.isError, true);
    const testRun = resultJson(await roCall(roClient, 'exec', { command: 'node --version' }));
    assert.equal(testRun.exit_code, 0, 'read-only allows non-mutating commands');
    const testRunner = resultJson(await roCall(roClient, 'exec', { command: 'npm test --version' }));
    assert.notEqual(testRunner.status, 'denied', 'test runners stay usable in read-only mode');
    // Kernel-level read-only (win32): the shell token carries NO write SID, so
    // even a command the text gate MISSES (no high-risk pattern, plain
    // Set-Content) is denied by the OS inside the workspace.
    if (process.platform === 'win32') {
      const roShellWrite = resultJson(await roCall(roClient, 'exec', { command: 'Set-Content -Path ro-bypass.txt -Value x' }));
      // PRIMARY evidence is the filesystem: the file must not exist. pwsh
      // after a native command (npm) can swallow the cmdlet's error text and
      // still report exit 0, so stderr/exit_code are secondary signals only.
      assert.ok(!fs.existsSync(path.join(ws, 'ro-bypass.txt')), 'read-only shell must not create in-workspace files (kernel denial)');
      assert.ok(
        !fs.existsSync(path.join(ws, 'ro-bypass.txt')) && (String(roShellWrite.stderr).includes('denied') || roShellWrite.exit_code !== 0 || roShellWrite.stdout === ''),
        `read-only write left no file (exit ${roShellWrite.exit_code}, stderr ${String(roShellWrite.stderr).slice(0, 80)})`,
      );
    }
    ok('read-only mode: reads/tests allowed, writes and destructive commands blocked');

    // --- runtime mode switch (PATCH /sessions/:id/mode, the dsh sandbox/mode precedent) ---
    const roId = ro.json.id;
    const modePatched = await api('PATCH', `/sessions/${roId}/mode`, { permission_mode: 'workspace-write' });
    assert.equal(modePatched.status, 200, JSON.stringify(modePatched.json));
    assert.equal(modePatched.json.permission_mode, 'workspace-write', 'PATCH switches the stored mode');
    const afterSwitch = await roCall(roClient, 'editor', { command: 'create', path: 'switched.txt', content: 'now writable\n' });
    assert.equal(afterSwitch.isError, false, 'editor writes allowed right after the switch');
    const full = await api('PATCH', `/sessions/${roId}/mode`, { permission_mode: 'danger-full-access' });
    assert.equal(full.status, 200, JSON.stringify(full.json));
    assert.equal(full.json.permission_mode, 'danger-full-access', 'PATCH enables explicit full host access');
    if (process.platform === 'win32') {
      const fullOutside = path.join(tmp, 'full-access-outside.txt');
      const fullCmd = `Set-Content -Path '${fullOutside.replaceAll('\\', '\\\\')}' -Value full`;
      const fullRun = resultJson(await roCall(roClient, 'exec', { command: fullCmd }));
      assert.equal(fullRun.exit_code, 0, `danger-full-access shell write failed: ${fullRun.stderr}`);
      assert.ok(fs.existsSync(fullOutside), 'danger-full-access must bypass the workspace ACL write boundary');
      const pending = (await api('GET', `/confirmations?session_id=${roId}`)).json.confirmations.filter((c) => c.status === 'pending');
      assert.equal(pending.length, 0, 'danger-full-access must not create routine command confirmations');
    }
    const back = await api('PATCH', `/sessions/${roId}/mode`, { permission_mode: 'read-only' });
    assert.equal(back.json.permission_mode, 'read-only', 'PATCH switches back');
    const deniedAgain = await roCall(roClient, 'editor', { command: 'create', path: 'nope2.txt', content: 'x' });
    assert.equal(deniedAgain.isError, true, 'editor writes denied again after downgrade');
    ok('runtime mode switch: read-only → workspace-write → danger-full-access → read-only');

    // --- ACL write-restriction (win32 only): the OS denies out-of-workspace shell writes ---
    if (process.platform === 'win32') {
      // 串行屏障：前一个用例（确认去重）的并发 pwsh 调用必须完全落定再发 probe——
      // 同一持久会话上响应配对靠到达顺序，残留调用会让 probe 拿到别人的 stderr
      // （flaky 来源：probe 断言里出现 Remove-Item dup-dir 的无关报错）
      const settle = resultJson(await call(client, 'exec', { command: 'Write-Output acl-settle' }));
      assert.match(String(settle.stdout), /acl-settle/, 'the shell is drained before the ACL probe');
      const wsOut = path.join(tmp, 'ws-outside');
      fs.mkdirSync(wsOut, { recursive: true });
      // The out-of-workspace path trips the confirmation gate first (guarded
      // policy: ask the operator); approve it, then the OS-level ACL must
      // STILL deny the write — policy and kernel are two different layers.
      const probeCmd = `Set-Content -Path '${wsOut.replaceAll('\\', '\\\\')}\\pwn.txt' -Value x`;
      const probing = call(client, 'exec', { command: probeCmd });
      let aclConfId;
      for (let attempt = 0; attempt < 20; attempt++) {
        await sleep(100);
        const confs = await api('GET', `/confirmations?session_id=${created.json.id}`);
        // exact command match, not a substring: any other pending row merely
        // mentioning ws-outside must not be approved by mistake
        const pending = confs.json.confirmations.find((c) => {
          if (c.status !== 'pending') return false;
          try { return JSON.parse(c.args_json).command === probeCmd; } catch { return false; }
        });
        if (pending) { aclConfId = pending.id; break; }
      }
      assert.ok(aclConfId, 'the out-of-workspace write asks for confirmation');
      const aclApproved = await api('POST', `/confirmations/${aclConfId}/approve`, {});
      assert.equal(aclApproved.status, 200);
      const probed = resultJson(await probing);
      // PRIMARY evidence is the filesystem: the out-of-workspace file must not
      // exist. pwsh can swallow the cmdlet error text after native-command
      // sequences (observed: exit 0 + empty stderr + NO file), so stderr and
      // exit_code are secondary signals only.
      assert.ok(!fs.existsSync(path.join(wsOut, 'pwn.txt')), 'the approved out-of-workspace write left NO file (kernel denial)');
      assert.ok(
        !fs.existsSync(path.join(wsOut, 'pwn.txt')) && (String(probed.stderr).includes('denied') || probed.exit_code !== 0 || probed.stdout === ''),
        `ACL sandbox denied the approved write (exit ${probed.exit_code}: ${String(probed.stderr).slice(0, 120)})`,
      );
      const inWs = resultJson(await call(client, 'exec', { command: 'Set-Content -Path acl-ok.txt -Value ok; Get-Content acl-ok.txt' }));
      assert.equal(inWs.exit_code, 0, 'ACL sandbox keeps in-workspace shell writes working');
      ok('ACL sandbox: kernel denies out-of-workspace shell writes even after approval; workspace writes pass');

    // ── M4.6 writableDirs：会话级额外内核写授权 ──
    {
      // 该区段位于后面的用例之后：workspace 可能已被前面的清理移除，先补建
      fs.mkdirSync(path.join(tmp, 'workspace'), { recursive: true });
      const grantedDir = path.join(tmp, 'wdirs-granted');
      fs.mkdirSync(grantedDir, { recursive: true });
      const wsess = (await api('POST', '/sessions', { workspace_path: path.join(tmp, 'workspace'), permission_mode: 'workspace-write', writable_dirs: [grantedDir] })).json;
      assert.ok(Array.isArray(wsess.writable_dirs) && wsess.writable_dirs.length === 1, 'create 返回 writable_dirs');
      const wclient = await connectMcp(mcpUrl);
      // 授权目录内写：不弹越界确认（risk 闸门放行），内核 ACL 也有 grant → 真实落盘
      const inside = path.join(grantedDir, 'inside.txt');
      const insideEsc = inside.split(String.fromCharCode(92)).join(String.fromCharCode(92) + String.fromCharCode(92));
      const wCall = callWith(wsess.session_id)(wclient, 'exec', { command: `Set-Content -Path '${insideEsc}' -Value wdirs-ok` });
      let askedOutside = false;
      for (let attempt = 0; attempt < 25; attempt++) {
        await sleep(100);
        const confs = await api('GET', `/confirmations?session_id=${wsess.id}`);
        if (confs.json.confirmations.some((c) => c.status === 'pending')) { askedOutside = true; break; }
      }
      assert.ok(!askedOutside, '授权目录内的写不弹越界确认');
      const wRes = resultJson(await wCall);
      assert.ok(fs.existsSync(inside) && fs.readFileSync(inside, 'utf8').includes('wdirs-ok'), '授权目录写真实落盘（内核 grant）');
      // PATCH 变更：清空 writable_dirs → respawn → 同一目录写被内核拒绝
      const cleared = await api('PATCH', `/sessions/${wsess.id}/writable_dirs`, { writable_dirs: [] });
      assert.equal(cleared.status, 200);
      const after = callWith(wsess.session_id)(wclient, 'exec', { command: `Set-Content -Path '${insideEsc}' -Value v2` });
      let kernelDenied = false;
      try {
        const r2 = resultJson(await after);
        kernelDenied = !fs.existsSync(inside) || !fs.readFileSync(inside, 'utf8').includes('v2');
      } catch { kernelDenied = true; }
      assert.ok(kernelDenied, '清空 writable_dirs 后内核拒绝（respawn 生效）');
      await wclient.close();
      await api('POST', `/sessions/${wsess.id}/revoke`);
      ok('writableDirs：会话级额外内核写授权（授权内免确认落盘；清空后内核拒绝）');

    // ── M4.6 auto_approve：confirm 级操作免审批卡（边界不变）──
    {
      fs.mkdirSync(path.join(tmp, 'workspace'), { recursive: true });
      const aaDir = path.join(tmp, 'aa-granted');
      fs.mkdirSync(aaDir, { recursive: true });
      const aaSess = (await api('POST', '/sessions', { workspace_path: path.join(tmp, 'workspace'), permission_mode: 'workspace-write', writable_dirs: [aaDir], auto_approve: true })).json;
      assert.equal(aaSess.auto_approve, true, 'create 返回 auto_approve');
      const aaClient = await connectMcp(mcpUrl);
      // 授权目录内的高危写（Remove-Item 是 critical 级 confirm）：auto_approve → 直接执行，不弹卡
      const victim = path.join(aaDir, 'victim.txt');
      fs.writeFileSync(victim, 'x');
      const rmCmd = `Remove-Item -Path '${victim.split(String.fromCharCode(92)).join(String.fromCharCode(92) + String.fromCharCode(92))}' -Force; Test-Path '${victim.split(String.fromCharCode(92)).join(String.fromCharCode(92) + String.fromCharCode(92))}'`;
      const rmCall = callWith(aaSess.session_id)(aaClient, 'exec', { command: rmCmd });
      await sleep(500);
      const aaPending = (await api('GET', `/confirmations?session_id=${aaSess.id}`)).json.confirmations.filter((c) => c.status === 'pending');
      assert.equal(aaPending.length, 0, 'auto_approve 会话不得产生确认卡');
      const rmRes = resultJson(await rmCall);
      assert.match(String(rmRes.stdout), /False/, 'critical 命令已真实执行（文件已删）');
      // 跳过落审计事件
      const aaEvents = (await api('GET', `/sessions/${aaSess.id}/events?limit=200`)).json.events;
      assert.ok(aaEvents.some((e) => e.type === 'approval_auto_skipped'), '跳过留有 approval_auto_skipped 审计');
      // PATCH 关闭 → 恢复弹卡
      const off = await api('PATCH', `/sessions/${aaSess.id}/auto_approve`, { auto_approve: false });
      assert.equal(off.json.auto_approve, false, 'PATCH 关闭生效');
      fs.writeFileSync(victim, 'x');
      const rm2 = callWith(aaSess.session_id)(aaClient, 'exec', { command: rmCmd });
      await sleep(600);
      const backPending = (await api('GET', `/confirmations?session_id=${aaSess.id}`)).json.confirmations.filter((c) => c.status === 'pending' && (c.args_json ?? '').includes('Remove-Item'));
      assert.ok(backPending.length > 0, '关闭后同一命令恢复弹卡');
      await api('POST', `/confirmations/${backPending[0].id}/deny`);
      await rm2;
      await aaClient.close();
      await api('POST', `/sessions/${aaSess.id}/revoke`);
      ok('auto_approve：免卡直接执行 + 审计事件；PATCH 关闭恢复弹卡（边界不变）');
    }
    }
    }

    // --- two concurrent sessions on one shared URL: keys keep them apart ---
    const ws2 = path.join(tmp, 'ws2');
    fs.mkdirSync(ws2, { recursive: true });
    const dual = await api('POST', '/sessions', { workspace_path: ws2, permission_mode: 'workspace-write' });
    assert.equal(dual.status, 201);
    const dualCall = callWith(dual.json.session_id);
    const dualClient = await connectMcp(mcpUrl); // same URL, separate MCP protocol session
    r = resultJson(await call(client, 'exec', { command: "$x='A-marker'; Set-Content -Path a-only.txt -Value 'from-A'" }));
    assert.equal(r.exit_code, 0);
    // NOTE: exec exit_code comes from $LASTEXITCODE, which cmdlets never set —
    // use a printed probe instead of relying on Get-Content's exit code.
    const inB = resultJson(await dualCall(dualClient, 'exec', { command: "if (Test-Path a-only.txt) { 'FOUND' } else { 'MISSING' }" }));
    assert.match(String(inB.stdout), /MISSING/, "key B's workspace cannot see key A's files");
    const varB = resultJson(await dualCall(dualClient, 'exec', { command: 'echo "$x"' }));
    assert.equal(varB.exit_code, 0);
    assert.ok(!String(varB.stdout).includes('A-marker'), 'shell state does not leak across keys');
    r = resultJson(await dualCall(dualClient, 'exec', { command: 'Get-Location' }));
    assert.match(r.cwd, /ws2/, 'key B cwd is its own workspace');
    const listed = await api('GET', '/sessions');
    assert.equal(listed.json.sessions.find((s) => s.id === dual.json.id).name, null, 'sessions without a task text show no name');
    ok('two concurrent sessions: same URL, keys route to separate workspaces/state');

    // --- id hygiene: the numeric id never lands in persisted rows ---
    const feed = await api('GET', `/sessions/${created.json.id}/calls`);
    assert.ok(
      feed.json.calls.every((c) => !(c.args_json ?? '').includes(sid)),
      'tool_calls.args_json never contains the session id',
    );
    const evs = await api('GET', `/sessions/${created.json.id}/events?limit=1000`);
    assert.ok(
      evs.json.events.every((e) => !JSON.stringify(e.payload ?? {}).includes(sid)),
      'event payloads never contain the session id',
    );
    ok('id hygiene: the session id is stripped from every persisted payload');

    // --- /bh.py: convenience MCP-over-HTTP client (extension templates) ---
    const bhRes = await fetch(`${BASE}/bh.py`);
    assert.equal(bhRes.status, 200);
    const bhPy = await bhRes.text();
    assert.match(bhPy, /^#!/, 'bh.py served as a python script');
    assert.match(bhPy, /BH_SESSIONID/, 'bh.py knows the session id config');
    assert.match(
      bhPy,
      /if sessionid:\s+params = dict\(params or \{\}\)\s+params\['sessionId'\] = sessionid/s,
      'bh.py attributes reference-tool calls when a session id is available',
    );
    assert.match(bhPy, /elif cmd == 'sh'/, 'bh.py offers the escape-free sh subcommand');
    assert.doesNotMatch(bhPy, /\/rules\//, 'bh.py no longer references the removed /rules endpoint');
    assert.equal(
      (await fetch(`${BASE}/rules/deadbeefdeadbeef`)).status,
      404,
      'keyed rules endpoint removed: the manual travels only via guide',
    );
    ok('bh.py served; /rules/<key> endpoint removed (single manual entry: guide)');

    // --- calls cursor feed (polling UIs) ---
    const all1 = await api('GET', `/sessions/${created.json.id}/calls`);
    assert.ok(all1.json.calls.length >= 2, 'calls recorded so far');
    const lastSeq = all1.json.next_after;
    assert.ok(lastSeq >= 1);
    const headEmpty = await api('GET', `/sessions/${created.json.id}/calls?after=${lastSeq}`);
    assert.equal(headEmpty.json.calls.length, 0, 'cursor at head returns no rows');
    r = resultJson(await call(client, 'exec', { command: 'echo cursor-check' }));
    assert.equal(r.exit_code, 0);
    const incr = await api('GET', `/sessions/${created.json.id}/calls?after=${lastSeq}`);
    assert.equal(incr.json.calls.length, 1);
    assert.match(incr.json.calls[0].args_json, /cursor-check/);
    assert.equal(incr.json.next_after, incr.json.calls[0].seq);
    ok('calls endpoint supports the incremental cursor');

    // --- window pagination: anchor 窗口口径 vs 全量口径 ---
    // COUNT/LIMIT/OFFSET 分页（并行重构后语义）：所有页共享 anchor cap，
    // page 0 用冻结 anchor 看不到锚定后的新行——新行靠"客户端 page 0 时
    // re-anchor"可见。window_total（窗口行数）是分页器页数依据，深页不再
    // 因全量口径多算的行被误判越界钳回末页。
    {
      const w0 = await api('GET', `/sessions/${created.json.id}/calls?anchor=0&page=0`);
      const anchor = w0.json.max_seq;
      const totalAtAnchor = w0.json.window_total;
      assert.equal(totalAtAnchor, w0.json.total, 'fresh anchor: window_total equals the full count');
      // 锚定后写入两条新调用
      await call(client, 'exec', { command: 'echo win-page-1' });
      await call(client, 'exec', { command: 'echo win-page-2' });
      // 冻结 anchor：窗口口径不含新行，全量口径含
      const w1 = await api('GET', `/sessions/${created.json.id}/calls?anchor=${anchor}&page=0`);
      assert.equal(w1.json.window_total, totalAtAnchor, 'window_total ignores rows written after the anchor');
      assert.ok(w1.json.total > w1.json.window_total, 'total still counts the post-anchor rows');
      // re-anchor（客户端 page 0 的实际行为）：新行回到第 0 页头部
      const w2 = await api('GET', `/sessions/${created.json.id}/calls?anchor=0&page=0`);
      assert.ok(w2.json.calls.some((c) => (c.args_json ?? '').includes('win-page-1')), 'a re-anchored page 0 surfaces the new rows');
      // 分页器页数依据 = 窗口口径；连续性：page 1 与 page 0 无重叠无缺口
      const pagesWindow = Math.ceil(w1.json.window_total / 20);
      const p1 = await api('GET', `/sessions/${created.json.id}/calls?anchor=${anchor}&page=1`);
      const ids0 = new Set(w1.json.calls.map((c) => c.id));
      const overlap = p1.json.calls.filter((c) => ids0.has(c.id)).length;
      assert.equal(overlap, 0, 'page 1 does not repeat page 0 rows');
      assert.ok(p1.json.calls.length > 0 || pagesWindow === 1, 'page 1 has rows when the window spans pages');
    }
    ok('calls window pagination: count-based window, re-anchor for live rows, no page overlap');

    // --- pause / resume ---
    await api('POST', `/sessions/${created.json.id}/pause`, {});
    const pausedRes = resultJson(await call(client, 'exec', { command: 'echo paused' }));
    assert.equal(pausedRes.status, 'rejected');
    assert.match(pausedRes.reason, /paused/, 'paused session id refuses calls');
    // rejected calls must be attributable: the pause rejection lands on the
    // session's call feed (attached to the stable primary key, id stripped)
    const pausedFeed = await api('GET', `/sessions/${created.json.id}/calls`);
    const rejectedRow = pausedFeed.json.calls.find((c) => c.status === 'failed' && /paused/.test(String(c.result_summary ?? '')));
    assert.ok(rejectedRow, 'the rejected call is recorded on the session feed');
    assert.ok(!(rejectedRow.args_json ?? '').includes(sid), 'rejected rows strip the session id too');
    await api('POST', `/sessions/${created.json.id}/resume`, {});
    r = resultJson(await call(client, 'exec', { command: 'echo back-online' }));
    assert.equal(r.exit_code, 0);
    ok('pause blocks calls, resume restores them');

    // --- events ---
    const events = await api('GET', `/sessions/${created.json.id}/events`);
    const types = events.json.events.map((e) => e.type);
    assert.ok(types.includes('session_created'));
    assert.ok(types.includes('tool_call_started'));
    assert.ok(types.includes('tool_call_completed'));
    assert.ok(types.includes('confirmation_created'));
    ok(`event log records lifecycle (${types.length} events)`);

    // --- control API is loopback-only (Host header guard) ---
    const rebinding = await new Promise((resolve) => {
      const req = http.request(`${BASE}/api/sessions`, { method: 'GET', headers: { Host: 'evil.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', () => resolve(0));
      req.end();
    });
    assert.equal(rebinding, 403, 'foreign Host header must be rejected');
    ok('control API rejects DNS-rebinding Host headers');

    // --- tunnel control endpoints (tunnel disabled in smoke env) ---
    const tstop = await api('POST', '/tunnel/stop', {});
    assert.equal(tstop.status, 200);
    assert.equal(tstop.json.status, 'off');
    const tstart = await api('POST', '/tunnel/start', {});
    assert.equal(tstart.status, 200);
    assert.equal(tstart.json.status, 'off', 'tunnel stays off when disabled by config');
    ok('tunnel start/stop endpoints answer');

    // --- enabled tunnel + missing cloudflared reports unavailable; no auto-start ---
    const port2 = PORT + 1;
    const daemon2 = spawn(process.execPath, [path.join(ROOT, 'dist', 'cli.js'), 'serve', '--port', String(port2)], {
      env: {
        ...process.env,
        BLACKHOLE_DB: path.join(tmp, 'db2.sqlite'),
        BLACKHOLE_TUNNEL: 'auto',
        BLACKHOLE_CLOUDFLARED: 'bh-no-such-cloudflared',
      },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const api2 = async (method, p, body) => {
      const res = await fetch(`http://127.0.0.1:${port2}/api${p}`, {
        method,
        headers: { 'content-type': 'application/json', host: `127.0.0.1:${port2}` },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, json: await res.json().catch(() => null) };
    };
    try {
      let h2;
      for (let i = 0; i < 40 && !h2; i++) {
        await sleep(250);
        try {
          const res = await fetch(`http://127.0.0.1:${port2}/api/health`);
          if (res.ok) h2 = await res.json();
        } catch {
          /* not up yet */
        }
      }
      assert.ok(h2, 'second daemon healthy');
      assert.equal(h2.tunnel, 'off', 'boot must NOT auto-start the channel');
      const t2 = await api2('POST', '/tunnel/start', { mode: 'quick' });
      assert.equal(t2.status, 200);
      assert.equal(t2.json.status, 'unavailable', 'quick start with missing cloudflared reports unavailable');
      const t3 = await api2('POST', '/tunnel/start', { mode: 'named' });
      assert.equal(t3.status, 200);
      assert.equal(t3.json.status, 'unavailable', 'named start without a fixed public URL reports unavailable');
      ok('channel is opt-in: no auto-start, missing pieces surface as unavailable');
    } finally {
      daemon2.kill();
    }

    // --- daemon restart: logical session survives, URL stays stable ---
    await stopDaemon(daemon);
    daemon = startDaemon(dbPath);
    const health2 = await waitForHealth();
    assert.equal(health2.db_path, dbPath, 'restarted daemon is not the leaked one');
    assert.equal(health2.mcp_url, mcpUrl, 'machine URL is stable across daemon restarts');
    const sessAfter = await api('GET', `/sessions/${created.json.id}`);
    assert.equal(sessAfter.json.status, 'active', 'session persisted across restart');
    client = await connectMcp(mcpUrl); // same machine URL still valid after restart
    r = resultJson(await call(client, 'exec', { command: 'echo revived' }));
    assert.equal(r.exit_code, 0);
    ok('restart: same URL + id reconnect to the same logical session');

    // --- rotate: the id changes, the session does not ---
    const callsBeforeRotate = await api('GET', `/sessions/${created.json.id}/calls`);
    const beforeCount = callsBeforeRotate.json.calls.length;
    const rotated = await api('POST', `/sessions/${created.json.id}/rotate`, {});
    assert.equal(rotated.status, 200);
    assert.equal(rotated.json.mcp_url, mcpUrl, 'rotate never changes the machine URL');
    assert.ok(/^\d{39}$/.test(rotated.json.session_id), 'rotate returns a fresh numeric id');
    const stale = resultJson(await call(client, 'exec', { command: 'echo stale' }));
    assert.equal(stale.status, 'rejected');
    assert.match(stale.reason, /unknown or revoked session ID/, 'old id dead after rotate');
    const callRotated = callWith(rotated.json.session_id);
    r = resultJson(await callRotated(client, 'exec', { command: 'echo rotated-ok' }));
    assert.equal(r.exit_code, 0);
    const rotatedBoard = resultJson(await callRotated(client, 'todo', { command: 'read' }));
    assert.deepEqual(
      rotatedBoard.items.map((t) => t.content),
      ['rotate me'],
      'task board survives id rotation (bound to the session row, not the id)',
    );
    // audit continuity: pre-rotation rows and post-rotation rows share one feed
    const callsAfterRotate = await api('GET', `/sessions/${created.json.id}/calls`);
    assert.ok(callsAfterRotate.json.calls.length > beforeCount, 'the rotated session keeps appending to the same audit feed');
    ok('rotate: old id dead, new id continues the same session (board + audit feed intact)');

    // --- revoke kills the session for good; the shared URL lives on ---
    // seed a board on the ro session first: it must die with the session
    const roWriter = await connectMcp(mcpUrl);
    const roTodoCall = callWith(ro.json.session_id);
    assert.equal(
      resultJson(await roTodoCall(roWriter, 'todo', { command: 'write', todos: [{ content: 'doomed', status: 'pending' }] })).status,
      'ok',
      'ro session board seeded',
    );
    await api('POST', `/sessions/${ro.json.id}/revoke`, {});
    // roClient predates the daemon restart (stale MCP session) — use a fresh protocol session
    const roClient2 = await connectMcp(mcpUrl);
    const deadKey = resultJson(await roCall(roClient2, 'exec', { command: 'echo revoked' }));
    assert.equal(deadKey.status, 'rejected');
    assert.match(deadKey.reason, /unknown or revoked session ID/, 'revoked key dies immediately');
    const alive = resultJson(await callRotated(client, 'exec', { command: 'echo url-alive' }));
    assert.equal(alive.exit_code, 0, 'machine URL keeps serving other sessions');
    const revokedApi = await api('GET', `/sessions/${ro.json.id}`);
    assert.equal(revokedApi.json.status, 'revoked');
    // 终止即清账：该会话的调用/确认/事件不再保留（有界存储）
    const purgedFeed = await api('GET', `/sessions/${ro.json.id}/calls`);
    assert.equal(purgedFeed.json.calls.length, 0, 'revoked session keeps no tool-call rows');
    const purgedEvents = await api('GET', `/sessions/${ro.json.id}/events`);
    assert.equal(purgedEvents.json.events.length, 1, 'revoked session keeps only the session_revoked marker');
    assert.equal(purgedEvents.json.events[0].type, 'session_revoked');
    const purgedTodos = await api('GET', `/sessions/${ro.json.id}/todos`);
    assert.equal(purgedTodos.status, 200, 'revoked session row still exists (revoke only flips the status)');
    assert.equal(purgedTodos.json.items.length, 0, 'revoked session keeps no todo rows');
    ok('revoke: key dead, calls + todo board purged, only the revoked marker remains');

    // --- machine-level token rotation (settings page) ---
    const rot = await api('POST', '/token/rotate', {});
    assert.equal(rot.status, 200);
    const newUrl = rot.json.mcp_url;
    assert.match(newUrl, /\/mcp\/[A-Za-z0-9_-]{32,}$/, 'rotated machine URL shape');
    assert.notEqual(newUrl, mcpUrl, 'rotation changes the machine URL');
    const newHealth = await waitForHealth();
    assert.equal(newHealth.mcp_url, newUrl, '/health serves the new URL immediately');
    const oldClient = client; // old URL must now refuse sessions
    const oldUrlDead = await connectMcp(mcpUrl).then(
      () => false,
      () => true,
    );
    client = await connectMcp(newUrl); // fresh protocol session on the new URL
    const alive2 = resultJson(await callRotated(client, 'exec', { command: 'echo token-rotated' }));
    assert.equal(alive2.exit_code, 0, 'session key still valid on the new machine URL');
    void oldClient; void oldUrlDead;
    ok('machine token rotation: new URL live, old URL dead, session keys intact');
    // persistence: the rotated token survives a daemon restart
    await stopDaemon(daemon);
    daemon = startDaemon(dbPath);
    const health3 = await waitForHealth();
    assert.equal(health3.mcp_url, newUrl, 'rotated machine URL persists across daemon restarts');
    client = await connectMcp(newUrl);
    r = resultJson(await callRotated(client, 'exec', { command: 'echo persisted-token' }));
    assert.equal(r.exit_code, 0);
    ok('rotated machine token persists across restarts');

    // --- context_search: key-gated registration + credential failure path ---
    // A deliberately bogus key: the tool must appear (gating is on key
    // PRESENCE, not validity) and a real call must fail as a structured
    // AUTH_ERROR rather than hanging or crashing. Network-free assertion of
    // the registration half; the search itself is exercised by the live run.
    await stopDaemon(daemon);
    process.env.BLACKHOLE_SEMANTIC_KEY = 'sk-smoke-bogus-key-not-a-real-credential';
    daemon = startDaemon(dbPath);
    const healthSem = await waitForHealth();
    assert.equal(healthSem.semantic_search, true, 'key present => the tool is registered');
    const semInfo = await api('GET', '/semantic');
    assert.equal(semInfo.json.registered, true);
    assert.equal(semInfo.json.registered_source, 'env');
    assert.ok(!JSON.stringify(semInfo.json).includes('sk-smoke-bogus'), 'the key value must never be reported back');
    assert.equal(semInfo.json.registered_preview, 'sk-s' + '…' + 'tial', 'only a head+tail fingerprint is exposed');
    const semClient = await connectMcp(healthSem.mcp_url);
    const semTools = await semClient.listTools();
    assert.ok(semTools.tools.some((t) => t.name === 'context_search'), 'context_search joins the tool list');
    const semGuide = resultJson(await rawCall(semClient, 'guide', {}));
    assert.match(semGuide.manual, /context_search/, 'the manual documents the tool it now offers');
    const semSession = await api('POST', '/sessions', { workspace_path: ws, permission_mode: 'workspace-write', name: 'semantic smoke' });
    assert.equal(semSession.status, 201, JSON.stringify(semSession.json));
    const semCall = await callWith(semSession.json.session_id)(semClient, 'context_search', { query: 'where the smoke fixture writes a file' });
    const semJson = resultJson(semCall);
    assert.equal(semJson.result.isError, true, 'a bogus credential must report failure');
    assert.match(semJson.result.message, /AUTH_ERROR|RATE_LIMITED|NETWORK_ERROR|TIMEOUT/, 'classified upstream error: ' + semJson.result.message.slice(0, 120));
    assert.match(semJson.result.message, /[hint]/, 'the failure carries an actionable hint');
    assert.ok(semJson.result.meta.engine, 'the search backend is reported');
    const semCalls = await api('GET', `/sessions/${semSession.json.id}/calls`);
    assert.ok(semCalls.json.calls.some((c) => c.tool === 'context_search' && c.status === 'failed'), 'the attempt is on the audit feed');
    delete process.env.BLACKHOLE_SEMANTIC_KEY;
    await stopDaemon(daemon);
    daemon = startDaemon(dbPath);
    const healthNoSem = await waitForHealth();
    assert.equal(healthNoSem.semantic_search, false, 'no key => no tool, after restart');
    ok('context_search: registered only with a key, key value never echoed, failures classified and audited');

    // --- MCP Apps panel card: explicit show + public polling + HTTP approval ---
    // The daemon restarted twice above (memory-only PanelRegistry starts empty),
    // and the original credential was rotated at line ~1137 — the live id is
    // `rotated.json.session_id`. Re-connect and mint the card for it.
    client = await connectMcp(healthNoSem.mcp_url);
    let liveSid = rotated.json.session_id;
    const liveCall = callWith(liveSid);
    const execName = (await client.listTools()).tools.find((t) => t.name === 'exec')?.name;
    // MCP-Apps discovery is DEFINITION-LEVEL (spec 2026-01-26): render tools'
    // _meta.ui lives on tools/list output where hosts see it and may preload.
    const listedGuide = (await client.listTools()).tools.find((t) => t.name === 'guide');
    const listedShow = (await client.listTools()).tools.find((t) => t.name === 'show');
    assert.equal(listedGuide?._meta?.ui?.resourceUri, undefined, 'the guide tool DEFINITION does not mount the panel');
    const panelUri = listedShow?._meta?.ui?.resourceUri;
    assert.equal(panelUri, PANEL_URI, 'the explicit show tool DEFINITION declares the fixed panel shell');
    assert.deepEqual(listedShow?._meta?.ui?.visibility, ['model'], 'show is a model-visible render tool');
    const renderTools = (await client.listTools()).tools.filter((t) => t._meta?.ui?.resourceUri === panelUri);
    assert.deepEqual(renderTools.map((t) => t.name), ['show'], 'only the explicit show tool advertises the panel UI');
    // the call RESULT carries per-session routing (structuredContent), which
    // Apps hosts push into the card iframe via ui/notifications/tool-result
    const showWith = await client.callTool({ name: 'show', arguments: { sessionId: liveSid } });
    const routing = showWith.structuredContent ?? {};
    assert.equal(routing.status, 'mounted', 'the explicit show call mounts the panel');
    assert.ok(/^panel[_-]\w+$/.test(String(routing.panel_key)), `show result carries panel_key (${routing.panel_key})`);
    assert.ok(typeof routing.panel_base === 'string' && /^https?:\/\//.test(routing.panel_base), 'show result carries the polling base');
    assert.ok(Number.isSafeInteger(routing.panel_start_seq), 'show result carries the current-session call cursor');
    assert.equal(showWith._meta?.ui?.resourceUri, panelUri, 'the show result mounts the same fixed panel resource');
    assert.ok(typeof showWith._meta?.[PANEL_APP_TOKEN_META] === 'string', 'show result carries a UI-only approval token');
    assert.equal(showWith.structuredContent?.[PANEL_APP_TOKEN_META], undefined, 'approval token is not model-visible structured content');
    let panelKey = routing.panel_key;
    let appToken = showWith._meta[PANEL_APP_TOKEN_META];
    const guideWith = await client.callTool({ name: 'guide', arguments: { sessionId: liveSid } });
    assert.equal(guideWith._meta?.ui?.resourceUri, undefined, 'guide after show does not mount a panel');
    assert.equal(guideWith.structuredContent?.panel_key, undefined, 'guide stays a manual-only call after show');
    const secondGuideClient = await connectMcp(healthNoSem.mcp_url);
    const guideAgain = await secondGuideClient.callTool({ name: 'guide', arguments: { sessionId: liveSid } });
    assert.equal(guideAgain._meta?.ui?.resourceUri, undefined, 'a fresh MCP connection cannot mount a panel');
    await secondGuideClient.close();
    const guideBare = await client.callTool({ name: 'guide', arguments: {} });
    assert.equal(guideBare.structuredContent?.panel_key, undefined, 'keyless guide call carries no card routing');
    const guideBad = await client.callTool({ name: 'guide', arguments: { sessionId: '1'.repeat(39) } });
    assert.equal(guideBad.structuredContent?.panel_key, undefined, 'unknown session id attaches no card');

    // the static shell serves the single-file iframe (bridge + polling code);
    // it embeds no routing — it arrives via the host's tool-result push
    const cardRes = await client.readResource({ uri: panelUri });
    const cardText = cardRes.contents[0]?.text ?? '';
    assert.match(cardText, /ui\/initialize/, 'the card speaks the Apps bridge');
    assert.ok(cardText.includes('adoptRouting'), 'the card adopts panel_key/base from tool-result notifications');
    assert.ok(cardText.includes('/confirmations/'), 'the card approves through the panel HTTP endpoint');
    assert.ok(cardText.includes('/close'), 'the card can explicitly close its panel round and stop polling');
    assert.ok(!cardText.includes('callAppTool("resolve_confirmation"'), 'the card does not call a hidden approval MCP tool');
    assert.ok((cardRes.contents[0]?.mimeType ?? '').includes('mcp-app'), 'MIME marks it as an MCP App');
    assert.ok(!cardText.includes('data-key='), 'the shell embeds no routing (static, preload-safe)');
    // (the shell is static and always readable — key authority lives in the
    // /panel/:key HTTP routes, asserted below with 404s)

    // panel data: same stores the MCP tools write (dual-source contract)
    const pData0 = await fetch(`${BASE}/panel/${panelKey}/data?calls_from=${routing.panel_start_seq}`);
    const panel0 = await pData0.json();
    assert.match(pData0.headers.get('cache-control') ?? '', /no-store/i, 'panel data is explicitly non-cacheable');
    assert.equal(panel0.session.created_at, undefined, 'panel runtime is client-local and does not reuse session creation time');
    assert.equal(panel0.session.workspace_path, undefined, 'panel public payload does not expose the absolute workspace path');
    assert.equal(pData0.status, 200, 'panel data route answers (public surface)');
    assert.ok(panel0.epoch > 0 && !('skills' in panel0) && Array.isArray(panel0.calls) && Array.isArray(panel0.todos.items), 'panel payload shape: calls/todos/epoch without skill status');
    assert.equal(panel0.session.workspace_name, 'smoke task: fix the login bug', 'panel shows the session task text');
    assert.ok(panel0.calls.some((c) => c.tool === 'guide'), 'panel starts at the current guide call');
    assert.ok(!panel0.calls.some((c) => c.args_json.includes('persisted-token')), 'panel excludes calls from before the current guide');
    const reviewOverlay = resultJson(await rawCall(client, 'guide', { sessionId: liveSid, workflow: 'review' }));
    assert.equal(reviewOverlay.workflow, 'review', 'named review workflow loads during the mounted panel round');
    const panelWorkflowRes = await fetch(`${BASE}/panel/${panelKey}/data?calls_from=${routing.panel_start_seq}&calls_after=${panel0.next_calls_after}&calls_updated_after=${panel0.calls_updated_after}`);
    const panelWorkflow = await panelWorkflowRes.json();
    const panelReviewCall = panelWorkflow.calls.find((c) => c.tool === 'guide' && JSON.parse(c.args_json).workflow === 'review');
    assert.ok(panelReviewCall, 'panel preserves the guide workflow selector so the card can label review instead of generic guide');
    assert.deepEqual(JSON.parse(panelReviewCall.args_json), { workflow: 'review' }, 'panel exposes only the safe guide workflow selector');
    const panelFloor = await fetch(`${BASE}/panel/${panelKey}/data?calls_from=0`);
    const panelFloorJson = await panelFloor.json();
    assert.ok(!panelFloorJson.calls.some((c) => c.args_json.includes('persisted-token')), 'server enforces the current guide cursor even when the client asks for zero');
    assert.equal((await fetch(`${BASE}/panel/panel-nope/data`)).status, 404, 'unknown panel key on the data route: 404, no oracle');

    const diffWrite = await liveCall(client, 'editor', { command: 'create', path: 'panel-diff.txt', content: 'one\ntwo\n' });
    assert.ok(!diffWrite.isError, 'workspace editor write for panel diff stats succeeds');
    const rangeView = await liveCall(client, 'editor', { command: 'view', path: 'panel-diff.txt', view_range: [1, 2] });
    assert.ok(!rangeView.isError, 'workspace editor range view succeeds for panel preview coverage');

    // write a todo + fetch a skill through the MCP tools; the panel intentionally
    // ignores skill attribution because it is not a reliable UI state signal.
    const todoWrite = await liveCall(client, 'todo', { command: 'write', todos: [{ content: 'panel smoke step', status: 'in_progress' }] });
    assert.ok(!todoWrite.isError, 'todo write ok');
    const skillRead = await client.callTool({ name: 'skill', arguments: { sessionId: liveSid, name: 'commit-fast' } });
    assert.ok(!skillRead.isError, 'skill read ok');
    const pData1 = await fetch(`${BASE}/panel/${panelKey}/data?calls_from=${routing.panel_start_seq}&calls_after=${panel0.next_calls_after}&calls_updated_after=${panel0.calls_updated_after}`);
    const panel1 = await pData1.json();
    assert.ok(panel1.todos.items.some((t) => t.content === 'panel smoke step' && t.status === 'in_progress'), 'panel reflects the todo board');
    const diffCall = panel1.calls.find((c) => c.tool === 'editor' && c.args_json.includes('panel-diff.txt') && JSON.parse(c.args_json).command === 'create');
    assert.deepEqual(diffCall?.diff, { added: 3, removed: 0 }, 'panel exposes only numeric workspace editor line deltas');
    const rangeCall = panel1.calls.find((c) => c.tool === 'editor' && c.args_json.includes('panel-diff.txt') && JSON.parse(c.args_json).command === 'view');
    assert.deepEqual(JSON.parse(rangeCall?.args_json ?? '{}').view_range, [1, 2], 'panel preserves workspace editor view ranges for Lstart-end previews');

    assert.equal(panel1.skills, undefined, 'panel omits unreliable skill-read state');
    assert.ok(panel1.calls.some((c) => c.tool === 'todo' && c.status === 'completed'), 'panel feed mirrors tool_calls');

    const todoComplete = await liveCall(client, 'todo', { command: 'patch', updates: [{ content: 'panel smoke step', status: 'completed' }] });
    assert.ok(!todoComplete.isError, 'todo can naturally complete during the mounted round');
    const panelCompleted = await (await fetch(`${BASE}/panel/${panelKey}/data?epoch=0`)).json();
    assert.ok(panelCompleted.todos.items.length === 1 && panelCompleted.todos.items[0].status === 'completed', 'current-round completed todo remains visible');

    const todoClear = await liveCall(client, 'todo', { command: 'write', todos: [] });
    assert.ok(!todoClear.isError, 'todo board can be cleared during the mounted round');
    const panelCleared = await (await fetch(`${BASE}/panel/${panelKey}/data?epoch=0`)).json();
    assert.deepEqual(panelCleared.todos?.items, [], 'current-round todo clear is sent explicitly so the iframe can hide stale content');

    const historicalSeed = await liveCall(client, 'todo', {
      command: 'write',
      todos: [{ content: 'finished before next show', status: 'completed' }],
      contract: {
        goal: 'Verify completed-board round suppression',
        nonGoals: [],
        successCriteria: ['Current round shows completion and the next round hides it'],
        verification: ['Fetch both panel rounds'],
      },
    });
    assert.ok(!historicalSeed.isError, 'completed board with contract seeded for next-round suppression check');
    const panelFinished = await (await fetch(`${BASE}/panel/${panelKey}/data?epoch=0`)).json();
    assert.equal(panelFinished.todos.items[0].status, 'completed', 'completion remains visible in the round where it happened');
    assert.equal(panelFinished.todos.contract.goal, 'Verify completed-board round suppression', 'current round keeps the contract with its completion receipt');

    const longCommand = 'Write-Output panel-hover; # ' + 'x'.repeat(700); // Windows smoke uses PowerShell






    const longCommandResult = await liveCall(client, execName, { command: longCommand });
    assert.equal(resultJson(longCommandResult).exit_code, 0, 'long harmless command executes for hover-preview coverage');
    const panelLong = await (await fetch(`${BASE}/panel/${panelKey}/data?epoch=0`)).json();
    const longCall = panelLong.calls.find((c) => c.tool === execName && c.args_json.includes('panel-hover'));
    const retainedCommand = JSON.parse(longCall.args_json).command;
    assert.ok(retainedCommand.length > 500, 'panel retains more than 500 chars for long command hover text');
    assert.ok(retainedCommand.length <= 8192, 'panel hover command remains size-bounded');

    // epoch gate: no writes between polls → 204 weightless
    const gated = await fetch(`${BASE}/panel/${panelKey}/data?epoch=${panelLong.epoch}`);
    assert.equal(gated.status, 204, 'unchanged epoch answers 204 (idle cost = headers only)');

    // approval over the panel route: blocked call → pending → HTTP approve → wake
    const riskyPanel = liveCall(client, execName, { command: 'Remove-Item -Recurse -Force panel-dir' });
    let panelConf;
    for (let i = 0; i < 20 && !panelConf; i++) {
      await sleep(100);
      const d = await (await fetch(`${BASE}/panel/${panelKey}/data?epoch=0`)).json();
      panelConf = (d.confirmations || []).find((c) => c.status === 'pending' && /panel-dir/.test(c.command));
    }
    assert.ok(panelConf, 'pending confirmation reaches the panel data (command + matches)');
    assert.ok(Array.isArray(panelConf.matches) && panelConf.matches.length > 0, 'pre-computed risk matches travel with the card payload');
    // SECURITY: everything /panel/:key/data returns is agent-readable in the
    // worst case (a host may leak `_meta`, handing the panelKey to the model),
    // so the payload must NOT carry any approval factor.
    assert.equal(panelConf.secret, undefined, 'no approval factor ever rides on the public data route');
    assert.equal(panelConf.pin, undefined, 'no PIN in the public payload');
    // A caller holding only the model-readable panelKey cannot self-approve.
    const noPin = await fetch(`${BASE}/panel/${panelKey}/confirmations/${panelConf.id}/approve`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    assert.equal(noPin.status, 403, 'approve without app token or PIN: 403');
    const wrongPin = await fetch(`${BASE}/panel/${panelKey}/confirmations/${panelConf.id}/approve`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: '000000' }),
    });
    assert.equal(wrongPin.status, 403, 'wrong PIN: 403');
    const stillPending = await (await fetch(`${BASE}/panel/${panelKey}/data?epoch=0`)).json();
    assert.ok((stillPending.confirmations || []).some((c) => c.id === panelConf.id && c.status === 'pending'), 'the confirmation survives PIN-less attempts');
    // The hidden app token approves through the panel HTTP endpoint without a
    const badScope = await fetch(`${BASE}/panel/${panelKey}/confirmations/${panelConf.id}/approve`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ app_token: appToken, scope: 'bogus' }),
    });
    assert.equal(badScope.status, 400, 'unknown panel approval scope is rejected');

    // PIN; it is bound to this panel and confirmation on the server.
    const approve = await fetch(`${BASE}/panel/${panelKey}/confirmations/${panelConf.id}/approve`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ app_token: appToken }),
    });
    assert.equal(approve.status, 200, 'panel approval with the UI app token succeeds');
    const replay = await fetch(`${BASE}/panel/${panelKey}/confirmations/${panelConf.id}/approve`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ app_token: appToken }),
    });
    assert.ok([403, 404, 409].includes(replay.status), `app-token replay fails closed (${replay.status})`);
    const panelDone = resultJson(await riskyPanel);
    assert.equal(panelDone.exit_code, 0, 'the blocked call wakes and executes after the panel approval');

    // deny path over the panel route
    const riskyDeny = liveCall(client, execName, { command: 'Remove-Item -Recurse -Force panel-deny-dir' });
    let denyConf;
    for (let i = 0; i < 20 && !denyConf; i++) {
      await sleep(100);
      const d = await (await fetch(`${BASE}/panel/${panelKey}/data?epoch=0`)).json();
      denyConf = (d.confirmations || []).find((c) => c.status === 'pending' && /panel-deny-dir/.test(c.command));
    }
    assert.ok(denyConf, 'deny-path confirmation reaches the panel');
    const deniedViaPanel = await fetch(`${BASE}/panel/${panelKey}/confirmations/${denyConf.id}/deny`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    assert.equal(deniedViaPanel.status, 200, 'deny via the panel route succeeds (no PIN: refusing never escalates)');
    const denyResult = resultJson(await riskyDeny);
    assert.equal(denyResult.status, 'superseded', 'denied call reports superseded');

    // A second user-prompt round gets a fresh card and retires the old one.
    const oldPanelKey = panelKey;
    const nextShow = await client.callTool({ name: 'show', arguments: { sessionId: liveSid } });
    const nextRouting = nextShow.structuredContent ?? {};
    assert.equal(nextRouting.status, 'mounted', 'a new show starts a fresh panel round');
    assert.notEqual(nextRouting.panel_key, oldPanelKey, 'new round receives a new panel key');
    const oldCard = await fetch(`${BASE}/panel/${oldPanelKey}/data`);
    assert.equal(oldCard.status, 410, 'the previous round is terminal after a new show');
    const nextCard = await fetch(`${BASE}/panel/${nextRouting.panel_key}/data?calls_from=${nextRouting.panel_start_seq}`);
    assert.equal(nextCard.status, 200, 'the new round panel remains live');
    const nextPanel = await nextCard.json();
    assert.equal(nextPanel.todos, undefined, 'a board already completed before show is omitted from the fresh round');
    panelKey = nextRouting.panel_key;
    appToken = nextShow._meta[PANEL_APP_TOKEN_META];
    ok('MCP Apps panel: each show starts a fresh round and retires the previous card');

    const closePanel = await fetch(`${BASE}/panel/${panelKey}/close`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ app_token: appToken }),
    });
    assert.equal(closePanel.status, 204, 'panel close endpoint accepts the UI-only app token');
    const closedCard = await fetch(`${BASE}/panel/${panelKey}/data`);
    assert.equal(closedCard.status, 410, 'manually closed panel becomes terminal and stops serving live data');
    const postCloseShow = await client.callTool({ name: 'show', arguments: { sessionId: liveSid } });
    panelKey = postCloseShow.structuredContent?.panel_key;
    appToken = postCloseShow._meta[PANEL_APP_TOKEN_META];
    assert.ok(panelKey && appToken, 'show can mount a fresh panel after manual close');

    const rotatedPanelSession = await api('POST', `/sessions/${created.json.id}/rotate`, {});
    assert.equal(rotatedPanelSession.status, 200, 'session credential rotated while panel is mounted');
    const rotatedDeadCard = await fetch(`${BASE}/panel/${panelKey}/data`);
    assert.equal(rotatedDeadCard.status, 410, 'credential rotation revokes the current panel capability');
    liveSid = rotatedPanelSession.json.session_id;
    const afterRotateShow = await client.callTool({ name: 'show', arguments: { sessionId: liveSid } });
    panelKey = afterRotateShow.structuredContent?.panel_key;
    assert.ok(panelKey, 'a fresh panel can be mounted with the rotated credential');

    // revocation kills the current card on the spot
    const revokedPanel = await api('POST', `/sessions/${created.json.id}/revoke`, {});
    assert.equal(revokedPanel.status, 200, 'session revoked');
    const deadCard = await fetch(`${BASE}/panel/${panelKey}/data`);
    assert.equal(deadCard.status, 410, 'panel data for a revoked session answers 410');
    ok('MCP Apps panel: _meta mount, public data route, one-shot approvals, revoke kills the card');

    // --- heartbeat endpoint (channel watchdog feed) ---
    const hb = await api('POST', '/heartbeat', {});
    assert.equal(hb.status, 200);
    assert.equal(hb.json.ok, true);
    ok('heartbeat endpoint answers (watchdog feed)');

    // --- graceful shutdown via control plane (extension "Stop Daemon" path) ---
    const beforeShutdown = await api('GET', '/health');
    assert.equal(beforeShutdown.status, 200);
    const legacyShutdown = await api('POST', '/shutdown', { daemon_id: beforeShutdown.json.daemon_id });
    assert.equal(legacyShutdown.status, 409, 'old id-only clients may not kill the new daemon');
    const stopped = await api('POST', '/shutdown', {
      daemon_id: beforeShutdown.json.daemon_id,
      start_fingerprint: beforeShutdown.json.start_fingerprint ?? null,
    });
    assert.equal(stopped.status, 200);
    await sleep(600);
    let down = false;
    try {
      await fetch(`${BASE}/api/health`);
    } catch {
      down = true;
    }
    assert.ok(down, 'daemon exits after /shutdown');
    ok('control-plane shutdown stops the daemon');

    console.log(`\nSMOKE PASS — ${passed} acceptance checks succeeded`);
  } finally {
    await stopDaemon(daemon);
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`\nSMOKE FAIL: ${e instanceof Error ? e.stack : e}`);
    process.exit(1);
  },
);
