import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerTools } from '../dist/mcp/tools.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const SID = '1'.repeat(39), OTHER = '2'.repeat(39), INVALID = '9'.repeat(39);
const payload = result => result.structuredContent ?? JSON.parse(result.content[0].text);
async function fixture(t, configured) {
  fs.mkdirSync('.cache/tests', { recursive: true });
  const temp = fs.mkdtempSync(path.resolve('.cache/tests/skill-context-'));
  const home = path.join(temp, 'home'), project = path.join(temp, 'project'), other = path.join(temp, 'other');
  for (const dir of [home, project, other]) fs.mkdirSync(dir);
  t.mock.method(os, 'homedir', () => home);
  const user = path.join(home, '.agents', 'skills'), local = path.join(project, '.agents', 'skills');
  const manual = path.join(temp, 'manual');
  const cfg = configured === undefined ? {} : { skillsDir: configured === 'manual' ? manual : configured };
  const runtimes = new Map([
    [SID, { session: { id: 'project-row', workspace_path: project, permission_mode: 'read-only' } }],
    [OTHER, { session: { id: 'other-row', workspace_path: other, permission_mode: 'read-only' } }],
  ]);
  const rows = new Map();
  const deps = { cfg, events: { append() {} }, sessions: { byCredential() {} },
    toolCalls: {
      start: () => { const row = { id: String(rows.size), status: 'started' }; rows.set(row.id, row); return row; },
      get: id => rows.get(id), finish: (id, status, summary) => Object.assign(rows.get(id), { status, summary }),
    },
    handoffs: { set: (_id, content) => ({ id: 'saved-id', content, created_at: 1 }) },
  };
  const server = new McpServer({ name: 'skill-context-fixture', version: '1' });
  registerTools(server, id => runtimes.get(id) ?? { error: 'invalid or paused fixture session' }, deps,
    { execDescription: 'Fixture command help; never executed.' });
  const client = new Client({ name: 'skill-context-test', version: '1' }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); fs.rmSync(temp, { recursive: true, force: true }); });
  function add(root, name, content = name) {
    const dir = path.join(root, name); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${content}\n---\n${content}\n`);
    return dir;
  }
  const call = (name, args = {}, sessionId = SID) => client.callTool({ name, arguments: { ...(sessionId ? { sessionId } : {}), ...args } });
  return { temp, home, project, other, user, local, manual, cfg, runtimes, add, call };
}

test('default skill discovery uses the user home .agents/skills without configuration', async t => {
  const f = await fixture(t); f.add(f.user, 'personal', 'USER CONTENT');
  const result = await f.call('skill');
  assert.equal(result.isError, false);
  assert.deepEqual(payload(result).skills.map(s => [s.name, s.source]), [['personal', 'user']]);
  assert.match(payload(await f.call('skill', { name: 'personal' })).content, /USER CONTENT/);
});

test('project names override user names, retaining distinct user skills without mixing resources', async t => {
  const f = await fixture(t);
  const personal = f.add(f.user, 'shared', 'USER VERSION');
  f.add(f.user, 'user-only'); f.add(f.local, 'shared', 'PROJECT VERSION'); f.add(f.local, 'project-only');
  fs.writeFileSync(path.join(personal, 'private-ref.md'), 'DO NOT FALL THROUGH');
  const listed = payload(await f.call('skill'));
  assert.deepEqual(listed.skills.map(s => s.name), ['project-only', 'shared', 'user-only']);
  assert.equal(listed.skills.find(s => s.name === 'shared').source, 'project');
  assert.match(payload(await f.call('skill', { name: 'shared' })).content, /PROJECT VERSION/);
  const missing = await f.call('skill', { name: 'shared', path: 'private-ref.md' });
  assert.equal(missing.isError, true); assert.equal(payload(missing).status, 'not_found');
  assert.doesNotMatch(JSON.stringify(missing), /DO NOT FALL THROUGH/);
});

test('custom replaces the default user library, while project and custom skills merge by name', async t => {
  const f = await fixture(t, 'manual');
  f.add(f.user, 'user-only'); f.add(f.user, 'shared', 'USER VERSION');
  f.add(f.manual, 'custom-only'); f.add(f.manual, 'shared', 'CUSTOM VERSION');
  f.add(f.local, 'project-only'); f.add(f.local, 'shared', 'PROJECT VERSION');
  const result = payload(await f.call('skill'));
  assert.deepEqual(result.skills.map(s => s.name), ['custom-only', 'project-only', 'shared']);
  assert.equal(result.skills.find(s => s.name === 'shared').source, 'project');
  assert.equal(result.skills.find(s => s.name === 'custom-only').source, 'custom');
  assert.match(payload(await f.call('skill', { name: 'shared' })).content, /PROJECT VERSION/);
  const absent = await f.call('skill', { name: 'user-only' });
  assert.equal(absent.isError, true); assert.equal(payload(absent).status, 'not_found');
});

test('default discovery is empty only when both project and default user libraries are empty', async t => {
  const f = await fixture(t); f.add(f.user, 'user-only'); f.add(f.local, 'project-only');
  assert.deepEqual(payload(await f.call('skill')).skills.map(s => s.name), ['project-only', 'user-only']);
  fs.rmSync(f.local, { recursive: true });
  assert.deepEqual(payload(await f.call('skill')).skills.map(s => s.name), ['user-only']);
  fs.rmSync(f.user, { recursive: true });
  const empty = await f.call('skill'); assert.equal(empty.isError, false); assert.equal(payload(empty).count, 0);
  assert.deepEqual(payload(empty).issues ?? [], []);
});

test('custom home notation accepts both slash conventions without adding the default library', async t => {
  const f = await fixture(t, '~/custom'); f.add(path.join(f.home, 'custom'), 'selected'); f.add(f.user, 'global-hidden');
  for (const value of ['~/custom', '~\\custom']) {
    f.cfg.skillsDir = value;
    assert.deepEqual(payload(await f.call('skill')).skills.map(s => s.name), ['selected']);
  }
});

test('a malformed project override cannot silently reveal the same global skill', async t => {
  const f = await fixture(t); f.add(f.user, 'shared', 'WRONG GLOBAL FALLBACK');
  fs.mkdirSync(path.join(f.local, 'shared'), { recursive: true });
  assert.equal(payload(await f.call('skill')).count, 0);
  const result = await f.call('skill', { name: 'shared' });
  assert.equal(result.isError, true); assert.doesNotMatch(JSON.stringify(result), /WRONG GLOBAL FALLBACK/);
});

test('project skill root junctions cannot escape the session workspace; explicit library junctions still work', async t => {
  const f = await fixture(t, 'manual');
  const outside = f.add(path.join(f.temp, 'outside'), 'shared', 'OUTSIDE PRIVATE CONTENT');
  fs.mkdirSync(f.local, { recursive: true }); fs.mkdirSync(f.manual, { recursive: true });
  fs.symlinkSync(outside, path.join(f.local, 'shared'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.symlinkSync(outside, path.join(f.manual, 'shared'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(payload(await f.call('skill')).count, 0);
  const denied = await f.call('skill', { name: 'shared' });
  assert.equal(denied.isError, true); assert.equal(payload(denied).status, 'invalid_path');
  assert.doesNotMatch(JSON.stringify(denied), /OUTSIDE PRIVATE CONTENT/);
  const allowed = await f.call('skill', { name: 'shared' }, null);
  assert.equal(allowed.isError, false); assert.match(payload(allowed).content, /OUTSIDE PRIVATE CONTENT/);
});

test('project library junctions are checked before enumerating names outside the workspace', async t => {
  const f = await fixture(t); const outside = path.join(f.temp, 'outside'); f.add(outside, 'private-name');
  fs.mkdirSync(path.join(f.project, '.agents'));
  fs.symlinkSync(outside, f.local, process.platform === 'win32' ? 'junction' : 'dir');
  const original = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', (file, ...args) => {
    if (path.resolve(String(file)) === f.local || path.resolve(String(file)) === outside) assert.fail('escaped project library must not be enumerated');
    return original(file, ...args);
  });
  const result = await f.call('skill');
  assert.equal(result.isError, true); assert.equal(payload(result).status, 'invalid_path');
  assert.doesNotMatch(JSON.stringify(result), /private-name/);
});

test('session scope selects independent project skills and appends only that project instructions to guide manual', async t => {
  const f = await fixture(t, 'manual');
  f.add(f.local, 'shared', 'FIRST PROJECT'); f.add(path.join(f.other, '.agents', 'skills'), 'shared', 'SECOND PROJECT');
  fs.writeFileSync(path.join(f.project, 'AGENTS.md'), 'FIRST RULES'); fs.writeFileSync(path.join(f.other, 'AGENTS.md'), 'SECOND RULES');
  for (const [sid, label, other] of [[SID, 'FIRST', 'SECOND'], [OTHER, 'SECOND', 'FIRST']]) {
    assert.match(payload(await f.call('skill', { name: 'shared' }, sid)).content, new RegExp(label+' PROJECT'));
    const guide = payload(await f.call('guide', {}, sid));
    assert.match(guide.manual, new RegExp(`## PROJECT INSTRUCTIONS\\n${label} RULES$`));
    assert.doesNotMatch(guide.manual, new RegExp(other+' RULES'));
    assert.equal(guide.project_instructions, undefined); assert.equal(guide.skills, undefined);
  }
});

test('guide appends complete project AGENTS.md to the existing base, tool and workflow manual', async t => {
  const f = await fixture(t, 'manual');
  const rules = '# Project rules\n中文 rules; preserve permissions.\nEND\n';
  fs.writeFileSync(path.join(f.project, 'AGENTS.md'), rules);
  for (const args of [{}, { tool: 'exec' }, { workflow: 'review' }]) {
    const result = await f.call('guide', args); assert.equal(result.isError, false);
    const data = payload(result);
    assert.match(data.manual, new RegExp(`## PROJECT INSTRUCTIONS\\n# Project rules`));
    assert.ok(data.manual.endsWith(rules));
    assert.equal(data.project_instructions, undefined);
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  }
});

test('guide supports lowercase agents.md only at the selected project root and refreshes appended content', async t => {
  const f = await fixture(t, 'manual');
  fs.writeFileSync(path.join(f.temp, 'AGENTS.md'), 'PARENT RULES MUST NOT LOAD');
  assert.doesNotMatch(payload(await f.call('guide')).manual, /PARENT RULES MUST NOT LOAD/);
  fs.writeFileSync(path.join(f.project, 'agents.md'), 'LOWERCASE FIRST');
  assert.match(payload(await f.call('guide')).manual, /## PROJECT INSTRUCTIONS\nLOWERCASE FIRST$/);
  fs.writeFileSync(path.join(f.project, 'agents.md'), 'LOWERCASE UPDATED');
  assert.match(payload(await f.call('guide', { tool: 'exec' })).manual, /## PROJECT INSTRUCTIONS\nLOWERCASE UPDATED$/);
});

test('automatic user/project files require a valid session; explicit keyless libraries remain compatible', async t => {
  const f = await fixture(t);
  f.add(f.user, 'private-user'); f.add(f.local, 'private-project');
  fs.writeFileSync(path.join(f.project, 'AGENTS.md'), 'PRIVATE PROJECT RULES');
  for (const sid of [null, INVALID]) {
    const result = await f.call('skill', {}, sid); assert.equal(result.isError, true);
    assert.equal(payload(result).status, 'session_required');
    const guide = payload(await f.call('guide', {}, sid));
    assert.equal(guide.project_instructions, undefined); assert.equal(guide.skills, undefined);
    assert.doesNotMatch(JSON.stringify(guide), /PRIVATE PROJECT RULES|private-user|private-project/);
  }
  f.cfg.skillsDir = f.manual; f.add(f.manual, 'public-manual');
  assert.deepEqual(payload(await f.call('skill', {}, null)).skills.map(s => s.name), ['public-manual']);
  assert.equal(payload(await f.call('guide', {}, INVALID)).project_instructions, undefined);
});

test('guide reports oversized, invalid UTF-8 and escaping project instructions without partial bodies', async t => {
  const f = await fixture(t, 'manual'), file = path.join(f.project, 'AGENTS.md');
  for (const [data, code] of [[Buffer.alloc(256 * 1024 + 1, 65), 'too_large'], [Buffer.from([0xff]), 'not_text']]) {
    fs.writeFileSync(file, data);
    const result = await f.call('guide'); assert.equal(result.isError, true);
    const responseData = payload(result); assert.equal(responseData.manual, ''); assert.match(responseData.instruction, new RegExp(code));
    assert.equal(responseData.project_instructions, undefined);
  }
  fs.unlinkSync(file);
  fs.symlinkSync(f.home, file, process.platform === 'win32' ? 'junction' : 'dir');
  const result = await f.call('guide'); assert.equal(result.isError, true);
  const data = payload(result); assert.equal(data.manual, ''); assert.match(data.instruction, /invalid_path/);
  assert.equal(data.project_instructions, undefined);
});

test('handoff submission preserves its receipt and never reads project instruction files', async t => {
  const f = await fixture(t, 'manual'); fs.writeFileSync(path.join(f.project, 'AGENTS.md'), 'PROJECT RULES');
  const original = fs.openSync;
  t.mock.method(fs, 'openSync', (file, ...args) => {
    if (String(file).endsWith('AGENTS.md')) assert.fail('submission must not read project instructions');
    return original(file, ...args);
  });
  const result = await f.call('guide', { workflow: 'handoff', content: 'Verified fixture task context only.' });
  assert.equal(result.isError, false); assert.equal(payload(result).status, 'saved');
  assert.equal(payload(result).manual, ''); assert.equal(payload(result).project_instructions, undefined);
});
