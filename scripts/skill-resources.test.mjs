import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as skills from '../dist/workspace/skills.js';
import { registerTools } from '../dist/mcp/tools.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

function fixture(t) {
  fs.mkdirSync('.cache/tests', { recursive: true });
  const temp = fs.mkdtempSync(path.resolve('.cache/tests/skill-resources-'));
  const root = path.join(temp, 'skills');
  const skill = path.join(root, 'code-work');
  fs.mkdirSync(path.join(skill, 'references'), { recursive: true });
  fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: Human readable title\ndescription: Fixture workflow\n---\n# Main\nSee [decisions](references/decisions.md).\n');
  fs.writeFileSync(path.join(skill, 'references/decisions.md'), '# Decisions\n中文 and exact final marker END\n');
  fs.writeFileSync(path.join(temp, 'outside.txt'), 'OUTSIDE MUST NOT BE RETURNED');
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  return { temp, root, skill };
}
function read(f, relativePath, offset = 0) {
  assert.equal(typeof skills.readSkillResource, 'function', 'resource reader must exist');
  return skills.readSkillResource(f.root, 'code-work', relativePath, offset);
}
function rejects(fn, code) { assert.throws(fn, error => error.code === code); }

test('list names are callable folder identifiers, independent of frontmatter', t => {
  const f = fixture(t);
  const [item] = skills.listSkills(f.root);
  assert.equal(item.name, 'code-work');
  assert.equal(item.title, 'Human readable title');
  const doc = skills.readSkill(f.root, item.name);
  assert.match(doc.content, /# Main/);
  assert.equal(doc.name, item.name);
});
test('main document and UTF-8 attachment are complete and distinguishable', t => {
  const f = fixture(t);
  const main = read(f);
  assert.equal(main.kind, 'document');
  assert.equal(main.path, 'SKILL.md');
  const result = read(f, 'references/decisions.md');
  assert.equal(result.kind, 'file');
  assert.equal(result.content, fs.readFileSync(path.join(f.skill, result.path), 'utf8'));
  assert.equal(result.bytes, Buffer.byteLength(result.content));
  assert.equal(result.complete, true);
  assert.match(result.content, /END\n$/);
  assert.equal(read(f, 'references\\decisions.md').content, result.content);
});
test('root and child directory discovery use skill-root-relative paths', t => {
  const f = fixture(t);
  const root = read(f, '.');
  assert.equal(root.kind, 'directory');
  assert.ok(root.entries.some(e => e.path === 'references' && e.kind === 'directory'));
  assert.deepEqual(read(f, 'references').entries, [{ name: 'decisions.md', path: 'references/decisions.md', kind: 'file' }]);
});
test('directory pages are bounded and recoverable without silent omissions', t => {
  const f = fixture(t);
  for (let i = 0; i < 205; i++) fs.writeFileSync(path.join(f.skill, 'references', `page-${String(i).padStart(3, '0')}.md`), 'x');
  const first = read(f, 'references');
  assert.equal(first.entries.length, 200);
  assert.equal(first.complete, false);
  assert.equal(first.next_offset, 200);
  const second = read(f, 'references', first.next_offset);
  assert.equal(second.complete, true);
  assert.equal(second.next_offset, undefined);
  assert.equal(new Set([...first.entries, ...second.entries].map(e => e.path)).size, 206);
});
test('absolute, traversal, drive, UNC and alternate-stream paths are rejected', t => {
  const f = fixture(t);
  for (const p of ['../outside.txt', 'references/../../outside.txt', '..\\outside.txt', '/etc/passwd', 'C:\\secret.txt', 'C:secret.txt', '\\\\host\\share\\secret', 'SKILL.md:stream', 'references/.. /secret', 'bad\0path']) {
    rejects(() => read(f, p), 'invalid_path');
  }
  rejects(() => skills.readSkillResource(f.root, '../code-work'), 'invalid_path');
  rejects(() => read(f, 'SKILL.md', 1), 'invalid_request');
});
test('missing, oversized and binary resources report explicit failures', t => {
  const f = fixture(t);
  rejects(() => read(f, 'missing.md'), 'not_found');
  fs.writeFileSync(path.join(f.skill, 'large.md'), Buffer.alloc(256 * 1024 + 1, 65));
  rejects(() => read(f, 'large.md'), 'too_large');
  fs.writeFileSync(path.join(f.skill, 'binary.dat'), Buffer.from([0, 1, 2]));
  rejects(() => read(f, 'binary.dat'), 'not_text');
  fs.writeFileSync(path.join(f.skill, 'invalid.txt'), Buffer.from([0xff]));
  rejects(() => read(f, 'invalid.txt'), 'not_text');
  fs.writeFileSync(path.join(f.skill, 'empty.txt'), '');
  assert.equal(read(f, 'empty.txt').complete, true);
});
test('a plain directory without SKILL.md is not an exposed skill', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, 'not-a-skill'));
  fs.writeFileSync(path.join(f.root, 'not-a-skill', 'secret.txt'), 'not a library document');
  rejects(() => skills.readSkillResource(f.root, 'not-a-skill', 'secret.txt'), 'not_found');
});
test('root junctions work but nested junctions cannot escape the real skill root', t => {
  const f = fixture(t);
  // Directory junctions are supported on Windows without symlink elevation.
  fs.symlinkSync(f.skill, path.join(f.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(skills.readSkillResource(f.root, 'linked', 'references/decisions.md').kind, 'file');
  fs.mkdirSync(path.join(f.temp, 'external'));
  fs.writeFileSync(path.join(f.temp, 'external', 'secret.txt'), 'OUTSIDE MUST NOT BE RETURNED');
  fs.symlinkSync(path.join(f.temp, 'external'), path.join(f.skill, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  rejects(() => read(f, 'escape/secret.txt'), 'invalid_path');
  rejects(() => read(f, 'escape'), 'invalid_path');
  assert.ok(!read(f, '.').entries.some(e => e.name === 'escape'));
  fs.symlinkSync(path.join(f.skill, 'references'), path.join(f.skill, 'inside'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.match(read(f, 'inside/decisions.md').content, /END/);
});
test('file symlinks cannot expose a sibling skill or outside file', t => {
  const f = fixture(t);
  try { fs.symlinkSync(path.join(f.temp, 'outside.txt'), path.join(f.skill, 'escape.md'), 'file'); }
  catch (e) {
    if (e.code === 'EPERM' && process.env.BH_REQUIRE_SKILL_SYMLINKS !== '1') {
      t.skip('file symlink privilege unavailable; junction boundary tested separately'); return;
    }
    throw e; // The native CI matrix requires this boundary test, not a silent skip.
  }
  rejects(() => read(f, 'escape.md'), 'invalid_path');
  fs.unlinkSync(path.join(f.skill, 'SKILL.md'));
  fs.symlinkSync(path.join(f.temp, 'outside.txt'), path.join(f.skill, 'SKILL.md'), 'file');
  assert.equal(skills.readSkill(f.root, 'code-work'), null);
  assert.deepEqual(skills.listSkills(f.root), []);
});
test('scripts are only returned as source text, never executed', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.skill, 'scripts'));
  fs.writeFileSync(path.join(f.skill, 'scripts', 'example.js'), 'throw new Error("must not execute")');
  assert.equal(read(f, 'scripts/example.js').content, 'throw new Error("must not execute")');
});
test('real MCP SDK exposes compatible schema, complete resources and actionable errors', async t => {
  const f = fixture(t);
  const events = [];
  const server = new McpServer({ name: 'skill-fixture', version: '1.0.0' });
  registerTools(server, () => ({ error: 'no active fixture session' }), {
    cfg: { skillsDir: f.root }, events: { append: (...args) => events.push(args) },
  }, { execDescription: 'Fixture only; never invoked.' });
  const client = new Client({ name: 'skill-resource-test', version: '1.0.0' }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(st); await client.connect(ct);
    const advertised = (await client.listTools()).tools.find(t => t.name === 'skill');
    assert.ok(advertised.inputSchema.properties.path);
    assert.ok(!(advertised.inputSchema.required ?? []).includes('sessionId'));
    const call = args => client.callTool({ name: 'skill', arguments: args });
    const open = fs.openSync;
    let fileOpens = 0;
    t.mock.method(fs, 'openSync', function(file, ...args) {
      if (typeof file === 'string' && file.startsWith(f.root)) fileOpens++;
      return open.call(this, file, ...args);
    });
    const list = await call({});
    assert.equal(list.isError, false);
    assert.equal(fileOpens, 1, 'library response opens each main document once');
    assert.deepEqual(list.structuredContent.skills.map(skill => skill.name), ['code-work']);
    const main = await call({ name: 'code-work' });
    assert.equal(main.structuredContent.kind, 'document');
    assert.equal(fileOpens, 2, 'main response and audit share one read');
    const directory = await call({ name: 'code-work', path: '.' });
    assert.equal(directory.isError, false);
    assert.equal(directory.structuredContent.kind, 'directory');
    assert.ok(directory.structuredContent.entries.some(e => e.path === 'references'));
    assert.deepEqual(JSON.parse(directory.content[0].text), directory.structuredContent);
    assert.match(main.structuredContent.instruction, /path/);
    const resource = await call({ name: 'code-work', path: 'references/decisions.md', sessionId: '1'.repeat(39) });
    assert.equal(resource.isError, false);
    assert.equal(fileOpens, 3, 'attachment response and audit share one read');
    assert.equal(resource.structuredContent.complete, true);
    assert.deepEqual(JSON.parse(resource.content[0].text), resource.structuredContent);
    assert.match(resource.structuredContent.content, /END\n$/);
    assert.equal(events.filter(e => e[1] === 'skill_fetched').length, 2, 'one audit event per successful read');
    assert.equal(events.at(-1)[2].path, 'references/decisions.md');
    for (const [args, status] of [[{ path: 'references' }, 'invalid_request'], [{ name: 'code-work', path: '../outside.txt' }, 'invalid_path'], [{ name: 'missing' }, 'not_found']]) {
      const result = await call(args);
      assert.equal(result.isError, true);
      assert.equal(JSON.parse(result.content[0].text).status, status);
    }
    const again = await call({ name: 'code-work', path: 'references/decisions.md' });
    assert.equal(again.structuredContent.content, resource.structuredContent.content, 'no premature dedupe introduced');
  } finally { await client.close(); await server.close(); }
});

test('one file open per document/attachment and one scan per library response', t => {
  const f = fixture(t);
  const original = fs.openSync;
  let opens = 0;
  t.mock.method(fs, 'openSync', function(file, ...args) {
    if (typeof file === 'string' && file.startsWith(f.root)) opens++;
    return original.call(this, file, ...args);
  });
  read(f); assert.equal(opens, 1);
  read(f, 'references/decisions.md'); assert.equal(opens, 2);
  skills.listSkills(f.root); assert.equal(opens, 3);
});
test('exact byte limit, valid replacement characters and UTF-8 BOM are not truncated', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.skill, 'limit.txt'), 'a'.repeat(256 * 1024));
  const max = read(f, 'limit.txt');
  assert.equal(max.bytes, 256 * 1024); assert.equal(max.content.length, max.bytes);
  const text = '\uFEFF# UTF-8\nLiteral replacement character: \uFFFD\nEND';
  fs.writeFileSync(path.join(f.skill, 'unicode.md'), text);
  const unicode = read(f, 'unicode.md');
  assert.equal(unicode.content, text); assert.equal(unicode.bytes, Buffer.byteLength(text));
});
test('valid session attribution preserves JSON results and records no successful fetch for failures', async t => {
  const f = fixture(t);
  const events = [], rows = new Map();
  const server = new McpServer({ name: 'attributed-skill-fixture', version: '1.0.0' });
  fs.mkdirSync(path.join(f.temp, 'workspace'));
  registerTools(server, () => ({ session: { id: 'fixture-row', workspace_path: path.join(f.temp, 'workspace') } }), {
    cfg: { skillsDir: f.root }, events: { append: (...args) => events.push(args) },
    toolCalls: {
      start: () => { const row = { id: String(rows.size), status: 'started' }; rows.set(row.id, row); return row; },
      get: id => rows.get(id),
      finish: (id, status, summary) => Object.assign(rows.get(id), { status, summary }),
    },
  }, { execDescription: 'Fixture; never invoked.' });
  const client = new Client({ name: 'attributed-resource-test', version: '1.0.0' }, { capabilities: {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(st); await client.connect(ct);
    const args = { name: 'code-work', path: 'references/decisions.md', sessionId: '1'.repeat(39) };
    const good = await client.callTool({ name: 'skill', arguments: args });
    assert.equal(good.isError, false);
    assert.equal(rows.get('0').status, 'completed');
    assert.deepEqual(JSON.parse(rows.get('0').summary), good.structuredContent);
    assert.equal(events.find(e => e[1] === 'skill_fetched')[0], 'fixture-row');
    const bad = await client.callTool({ name: 'skill', arguments: { ...args, path: 'missing.md' } });
    assert.equal(bad.isError, true); assert.equal(rows.get('1').status, 'failed');
    assert.equal(events.filter(e => e[1] === 'skill_fetched').length, 1);
  } finally { await client.close(); await server.close(); }
});
test('Streamable HTTP round trip preserves the complete attachment in both MCP result fields', async t => {
  const f = fixture(t);
  const { default: express } = await import('express');
  const { createServer } = await import('node:http');
  const { randomUUID } = await import('node:crypto');
  const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const expected = '# Attachment\n' + 'reference text\n'.repeat(600) + 'END OF ATTACHMENT\n';
  fs.writeFileSync(path.join(f.skill, 'references', 'wire.md'), expected);
  const server = new McpServer({ name: 'skill-wire-fixture', version: '1.0.0' });
  registerTools(server, () => ({ error: 'keyless fixture' }), { cfg: { skillsDir: f.root }, events: { append() {} } },
    { execDescription: 'Fixture; never invoked.' });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true });
  const app = express(); app.use(express.json());
  app.all('/mcp', (req, res) => { transport.handleRequest(req, res, req.body).catch(() => { if (!res.headersSent) res.sendStatus(500); }); });
  const http = createServer(app);
  const client = new Client({ name: 'skill-wire-client', version: '1.0.0' }, { capabilities: {} });
  try {
    await server.connect(transport);
    await new Promise((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve); });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${http.address().port}/mcp`)));
    const result = await client.callTool({ name: 'skill', arguments: { name: 'code-work', path: 'references/wire.md' } });
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent.content, expected);
    assert.equal(result.structuredContent.bytes, Buffer.byteLength(expected));
    assert.equal(result.structuredContent.complete, true);
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  } finally {
    await client.close(); await server.close();
    http.closeAllConnections();
    if (http.listening) await new Promise(resolve => http.close(resolve));
  }
});
