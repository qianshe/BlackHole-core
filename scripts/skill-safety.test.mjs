import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerTools } from '../dist/mcp/tools.js';
import { parse as parseYaml } from 'yaml';
import * as skills from '../dist/workspace/skills.js';

const SID = '3'.repeat(39), INVALID = '9'.repeat(39);
const body = r => r.structuredContent ?? JSON.parse(r.content[0].text);
const linkType = process.platform === 'win32' ? 'junction' : 'dir';
async function fixture(t) {
  fs.mkdirSync('.cache/tests', { recursive: true });
  const temp = fs.mkdtempSync(path.resolve('.cache/tests/skill-safety-'));
  const home = path.join(temp, '用户 home'), project = path.join(temp, '项目 workspace');
  for (const dir of [home, project]) fs.mkdirSync(dir);
  t.mock.method(os, 'homedir', () => home);
  const user = path.join(home, '.agents', 'skills'), local = path.join(project, '.agents', 'skills');
  const manual = path.join(temp, 'manual library'), cfg = { skillsDir: manual };
  const runtime = { session: { id: 'fixture-row', workspace_path: project, permission_mode: 'read-only' } };
  const calls = new Map();
  const server = new McpServer({ name: 'skill-safety', version: '1' });
  registerTools(server, id => id === SID ? runtime : { error: 'inactive fixture' }, {
    cfg, events: { append() {} },
    toolCalls: {
      start: () => { const row = { id: String(calls.size), status: 'started' }; calls.set(row.id, row); return row; },
      get: id => calls.get(id), finish: (id, status) => { calls.get(id).status = status; },
    },
  }, { execDescription: 'Fixture only.' });
  const client = new Client({ name: 'safety-test', version: '1' }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); fs.rmSync(temp, { recursive: true, force: true }); });
  const add = (root, name, text = name) => {
    const dir = path.join(root, name); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\ndescription: ${text}\n---\n${text}\n`);
    fs.writeFileSync(path.join(dir, 'ref.md'), `REFERENCE ${text}`);
    return dir;
  };
  const call = (args = {}, sid = SID, name = 'skill') => client.callTool({ name, arguments: { ...(sid ? { sessionId: sid } : {}), ...args } });
  return { temp, home, project, user, local, manual, cfg, add, call, client };
}

// Record forbidden filesystem access, not merely absence of a name in the output.
// Do not throw inside the spy: production error handlers must not hide the assertion.
function watchRoots(t, roots) {
  const accesses = [];
  for (const method of ['lstatSync', 'statSync', 'realpathSync', 'readdirSync', 'openSync']) {
    const original = fs[method];
    const spy = t.mock.method(fs, method, function (file, ...args) {
      if (typeof file === 'string') {
        const absolute = path.resolve(file);
        if (roots.some(root => absolute === root || absolute.startsWith(root + path.sep))) accesses.push([method, absolute]);
      }
      return original.call(this, file, ...args);
    });
    if (original.native) spy.native = original.native;
  }
  return accesses;
}

test('keyless and invalid-session custom reads never touch automatic libraries, including error hints', async t => {
  const f = await fixture(t);
  f.add(f.user, 'private-user'); f.add(f.local, 'private-project'); f.add(f.manual, 'public-manual');
  const accesses = watchRoots(t, [f.user, f.local]);
  for (const sid of [null, INVALID, 'invalid-fixture']) {
    const listed = await f.call({}, sid);
    assert.deepEqual(body(listed).skills.map(s => s.name), ['public-manual']);
    for (const args of [{ name: 'private-user' }, { name: 'private-user', path: 'ref.md' }, { name: 'private-user', path: '.' }, { name: 'private-project' }]) {
      const result = await f.call(args, sid);
      assert.equal(result.isError, true);
      assert.doesNotMatch(JSON.stringify(body(result).available ?? []), /private-user|private-project/);
    }
    assert.equal((await f.call({ name: 'public-manual' }, sid)).isError, false);
    assert.equal((await f.call({ name: 'public-manual', path: '.' }, sid)).isError, false);
  }
  assert.deepEqual(accesses, [], 'automatic libraries must not be inspected before filtering results');
});

test('an admitted custom library replaces the default; project and custom names both remain visible', async t => {
  const f = await fixture(t);
  f.add(f.user, 'private-user'); f.add(f.local, 'project-only'); f.add(f.manual, 'custom-only');
  f.add(f.local, 'shared', 'PROJECT'); f.add(f.manual, 'shared', 'CUSTOM');
  const accesses = watchRoots(t, [f.user]);
  const result = body(await f.call());
  assert.deepEqual(result.skills.map(s => [s.name, s.source]), [['custom-only', 'custom'], ['project-only', 'project'], ['shared', 'project']]);
  assert.match(body(await f.call({ name: 'shared' })).content, /PROJECT/);
  assert.deepEqual(accesses, []);
});

test('explicitly selecting the default path is an intentional keyless grant, not a forbidden pathname', async t => {
  const f = await fixture(t); f.add(f.user, 'explicit'); f.cfg.skillsDir = f.user;
  assert.deepEqual(body(await f.call({}, null)).skills.map(s => s.name), ['explicit']);
});

test('missing custom library preserves project discovery and never falls back to the default', async t => {
  const f = await fixture(t); f.add(f.user, 'not-selected'); f.add(f.local, 'project-only');
  assert.deepEqual(body(await f.call()).skills.map(s => s.name), ['project-only']);
  fs.rmSync(f.local, { recursive: true });
  const result = await f.call();
  assert.equal(result.isError, false); assert.deepEqual(body(result).skills, []);
  assert.deepEqual(body(result).issues ?? [], []);
});

test('non-directory library paths and unreadable libraries fail rather than returning a healthy empty list', async t => {
  const f = await fixture(t); fs.writeFileSync(f.manual, 'not a library');
  for (const directory of [f.manual, path.join(f.manual, 'child')]) {
    f.cfg.skillsDir = directory;
    const result = await f.call();
    assert.equal(result.isError, true); assert.equal(body(result).status, 'invalid_path');
  }
  fs.unlinkSync(f.manual); fs.mkdirSync(f.manual); f.cfg.skillsDir = f.manual;
  const read = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', (file, ...args) => {
    if (String(file) === f.manual) throw Object.assign(new Error('fixture access denied'), { code: 'EACCES' });
    return read(file, ...args);
  });
  const result = await f.call(); assert.equal(result.isError, true); assert.equal(body(result).status, 'unreadable');
});

test('plain files do not claim skill names, while broken directories shadow with diagnostics', async t => {
  const f = await fixture(t); f.add(f.manual, 'shared', 'CUSTOM'); fs.mkdirSync(f.local, { recursive: true });
  fs.writeFileSync(path.join(f.local, 'shared'), 'unrelated file');
  assert.deepEqual(body(await f.call()).skills.map(s => s.name), ['shared']);
  assert.equal(body(await f.call({ name: 'shared' })).source, 'custom');
  fs.unlinkSync(path.join(f.local, 'shared')); fs.mkdirSync(path.join(f.local, 'shared'));
  f.add(f.manual, 'unaffected');
  const listed = body(await f.call());
  assert.deepEqual(listed.skills.map(s => s.name), ['unaffected']);
  assert.deepEqual(listed.issues.map(i => [i.name, i.source, i.code]), [['shared', 'project', 'not_found']]);
  const denied = await f.call({ name: 'shared', path: 'ref.md' });
  assert.equal(denied.isError, true); assert.doesNotMatch(JSON.stringify(denied), /REFERENCE CUSTOM/);
});

test('invalid documents are diagnosed individually without hiding healthy skills or exposing their content', async t => {
  const f = await fixture(t);
  for (const [name, data] of [['empty', ''], ['binary', Buffer.from([0xff])], ['large', Buffer.alloc(256 * 1024 + 1, 65)]]) {
    const dir = f.add(f.local, name); fs.writeFileSync(path.join(dir, 'SKILL.md'), data);
    f.add(f.manual, name, 'MUST NOT FALL BACK');
  }
  f.add(f.manual, 'healthy');
  const listed = body(await f.call());
  assert.deepEqual(listed.skills.map(s => s.name), ['healthy']);
  assert.deepEqual(listed.issues.map(i => [i.name, i.code]), [['binary', 'not_text'], ['empty', 'not_found'], ['large', 'too_large']]);
  assert.doesNotMatch(JSON.stringify(listed), /MUST NOT FALL BACK/);
});

test('broken root links are errors and escaping skill links are diagnosed before reading content', async t => {
  const f = await fixture(t); const outside = f.add(path.join(f.temp, 'outside'), 'shared', 'OUTSIDE CONTENT');
  fs.mkdirSync(f.local, { recursive: true }); fs.symlinkSync(outside, path.join(f.local, 'shared'), linkType);
  const accesses = watchRoots(t, [outside]);
  const listed = body(await f.call());
  assert.equal(listed.count, 0); assert.equal(listed.issues[0].code, 'invalid_path');
  assert.equal(accesses.some(([method]) => method === 'openSync' || method === 'readdirSync'), false);
  fs.mkdirSync(f.manual); const rootLink = path.join(f.temp, 'root-link'); fs.symlinkSync(f.manual, rootLink, linkType);
  fs.rmdirSync(f.manual); f.cfg.skillsDir = rootLink;
  assert.equal((await f.call()).isError, true);
});

test('guide neither advertises a skill catalog nor touches libraries, even when they are broken', async t => {
  const f = await fixture(t); fs.writeFileSync(f.manual, 'invalid library');
  fs.writeFileSync(path.join(f.project, 'AGENTS.md'), 'PROJECT RULES');
  const accesses = watchRoots(t, [f.local, f.manual, f.user]);
  const guide = (await f.client.listTools()).tools.find(tool => tool.name === 'guide');
  assert.equal(guide.outputSchema.properties.skills, undefined);
  assert.doesNotMatch(guide.inputSchema.properties.sessionId.description, /skill catalog/i);
  assert.equal(guide.outputSchema.properties.project_instructions, undefined);
  for (const args of [{}, { tool: 'exec' }, { workflow: 'review' }]) {
    const result = await f.call(args, SID, 'guide'), data = body(result);
    assert.equal(result.isError, false); assert.equal(data.skills, undefined); assert.equal(data.project_instructions, undefined);
    assert.match(data.manual, /## PROJECT INSTRUCTIONS\nPROJECT RULES$/);
  }
  assert.deepEqual(accesses, []);
});

test('relative custom paths keep their launch-directory meaning, independent of the session workspace', async t => {
  const f = await fixture(t); f.add(f.manual, 'relative');
  f.cfg.skillsDir = path.relative(process.cwd(), f.manual);
  assert.deepEqual(body(await f.call()).skills.map(s => s.name), ['relative']);
});

test('real filesystem case aliases preserve identity and distinct case-sensitive siblings stay outside', async t => {
  const f = await fixture(t), root = path.join(f.temp, 'CaseRoot'), alias = path.join(f.temp, 'caseroot');
  fs.mkdirSync(root); fs.writeFileSync(path.join(root, 'ref.md'), 'inside');
  assert.equal(typeof skills.withinSkillBoundary, 'function');
  assert.equal(skills.withinSkillBoundary(root, path.join(root, 'ref.md')), true);
  if (fs.existsSync(alias)) {
    assert.equal(skills.withinSkillBoundary(root, path.join(alias, 'ref.md')), true);
  } else {
    fs.mkdirSync(alias); fs.writeFileSync(path.join(alias, 'ref.md'), 'outside');
    assert.equal(skills.withinSkillBoundary(root, path.join(alias, 'ref.md')), false);
  }
  const linked = path.join(f.temp, 'root-alias'); fs.symlinkSync(root, linked, linkType);
  assert.equal(skills.withinSkillBoundary(root, fs.realpathSync(path.join(linked, 'ref.md'))), true);
});

test('boundary checks use directory identity, not Windows-style case folding', t => {
  assert.equal(typeof skills.withinSkillBoundary, 'function');
  const root = path.resolve('.cache/tests/CaseRoot'), sibling = path.resolve('.cache/tests/caseroot');
  const parent = path.dirname(root), file = path.join(sibling, 'ref.md');
  // Simulate a case-sensitive volume without changing host directory attributes.
  t.mock.method(fs, 'statSync', filename => ({
    dev: 1n, ino: filename === root ? 11n : filename === sibling ? 12n : filename === file ? 13n : 14n,
    isDirectory: () => filename !== file,
  }));
  assert.equal(skills.withinSkillBoundary(root, file), false);
  assert.equal(skills.withinSkillBoundary(parent, file), true);
});

test('absent or invalid credentials without a custom grant perform no automatic filesystem discovery', async t => {
  const f = await fixture(t); f.cfg.skillsDir = '   ';
  f.add(f.user, 'private-user'); f.add(f.local, 'private-project');
  const accesses = watchRoots(t, [f.user, f.local]);
  for (const sid of [null, INVALID]) for (const args of [{}, { name: 'private-user' }, { name: 'private-project', path: '.' }]) {
    const result = await f.call(args, sid);
    assert.equal(result.isError, true); assert.equal(body(result).status, 'session_required');
  }
  assert.deepEqual(accesses, []);
});

test('relative custom paths do not move when the process cwd changes after tool registration', async t => {
  const f = await fixture(t); f.add(f.manual, 'stable');
  f.cfg.skillsDir = path.relative(process.cwd(), f.manual);
  t.mock.method(process, 'cwd', () => f.project);
  const result = await f.call();
  assert.equal(result.isError, false); assert.deepEqual(body(result).skills.map(s => s.name), ['stable']);
});

test('missing inode identities fall back to exact canonical paths without folding sibling names', async t => {
  const f = await fixture(t); const root = f.add(f.manual, 'root'), sibling = f.add(f.manual, 'sibling');
  const stat = fs.statSync;
  t.mock.method(fs, 'statSync', (file, options) => {
    const result = stat(file, options);
    return options?.bigint ? { ...result, ino: 0n, isDirectory: () => result.isDirectory() } : result;
  });
  assert.equal(skills.withinSkillBoundary(root, path.join(root, 'ref.md')), true);
  assert.equal(skills.withinSkillBoundary(root, path.join(sibling, 'ref.md')), false);
});

test('skill contracts run in every native Runtime CI target, with strict symlinks', () => {
  const ci = parseYaml(fs.readFileSync(new URL('../.github/workflows/vscode-extension.yml', import.meta.url), 'utf8'));
  assert.equal(ci.jobs['gate-skills'], undefined, 'skills run inside the Runtime job, not a duplicate matrix');
  const job = ci.jobs.runtime;
  assert.deepEqual([...new Set(job.strategy.matrix.include.map(row => `${row.platform}-${row.arch}`))].sort(),
    ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64']);
  assert.equal(job.strategy['fail-fast'], false);
  assert.equal(job.env.BH_REQUIRE_SKILL_SYMLINKS, '1');
  const commands = job.steps.map(step => step.run).filter(Boolean);
  for (const command of ['pnpm test:pack', 'pnpm test:posix', 'pnpm test:handoff']) assert.ok(commands.includes(command), command);
  assert.ok(commands.some(command => command.includes('process.arch') && command.includes('process.platform')));
  assert.deepEqual(ci.jobs['ci-result'].needs, ['changes', 'runtime', 'openai-runtime-native', 'vsix-artifact', 'settings-browser']);
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(pkg.scripts['test:skills'], /skill-safety\.test\.mjs/);
  for (const name of ['test:pack', 'test:posix']) {
    assert.match(pkg.scripts[name], /pnpm test:skills/);
    assert.match(pkg.scripts[name], /verify-prompts\.mjs/);
  }
  assert.match(pkg.scripts['test:handoff'], /guide-workflows\.test\.mjs/);
  assert.match(pkg.scripts['test:handoff'], /packages\/vscode typecheck/);
});
