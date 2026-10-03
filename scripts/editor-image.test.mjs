// editor view 读图（用户 2026-10-03）：图片原样交给 Agent，其他二进制只报类型；可达范围仍按权限模式；图片字节不进调用记录。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { WorkspaceEditor, imageTypeOf, MAX_VIEW_IMAGE_BYTES } from '../dist/workspace/editor.js';
import { registerTools } from '../dist/mcp/tools.js';
import { SessionRuntime } from '../dist/runtime.js';
import { openDb } from '../dist/storage/db.js';
import { ToolCallsRepo } from '../dist/storage/toolCalls.js';
import { TodosRepo } from '../dist/storage/todos.js';

// 1x1 的合法 PNG。
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const SID = '1'.repeat(39);

function dirs(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bh-editor-image-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const ws = path.join(base, 'ws'), other = path.join(base, 'other');
  fs.mkdirSync(ws); fs.mkdirSync(other);
  return { ws, other };
}

test('view 把图片原样返回：按文件头识别、带宽高、不接受 view_range', (t) => {
  const { ws } = dirs(t);
  fs.writeFileSync(path.join(ws, 'a.png'), PNG);
  fs.writeFileSync(path.join(ws, 'disguised.txt'), PNG);
  fs.writeFileSync(path.join(ws, 'fake.png'), 'not really an image\n');
  const ed = new WorkspaceEditor(ws);
  const r = ed.view('a.png');
  assert.equal(r.isError, false);
  assert.deepEqual(r.image, { data: PNG.toString('base64'), mimeType: 'image/png' });
  assert.match(r.message, /Image: image\/png, \d+ bytes, 1x1$/);
  assert.equal(ed.view('disguised.txt').image?.mimeType, 'image/png', '不信扩展名');
  const fake = ed.view('fake.png');
  assert.equal(fake.image, undefined); assert.match(fake.message, /not really an image/);
  assert.equal(ed.view('a.png', [1, 2]).code, 'INVALID_ARGUMENT');
});

test('宽高：JPEG / GIF / WebP 的文件头都能读出，类型只放行四种', (t) => {
  const { ws } = dirs(t);
  // JPEG：APP0 段之后是 SOF0（高 48、宽 64）。
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.from('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sof0 = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x30, 0x00, 0x40, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  fs.writeFileSync(path.join(ws, 'a.jpg'), Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof0, Buffer.from([0xff, 0xd9])]));
  const gif = Buffer.alloc(20); gif.write('GIF89a', 0, 'latin1'); gif.writeUInt16LE(7, 6); gif.writeUInt16LE(5, 8);
  fs.writeFileSync(path.join(ws, 'a.gif'), gif);
  const webp = Buffer.alloc(30); webp.write('RIFF', 0, 'latin1'); webp.write('WEBPVP8X', 8, 'latin1'); webp.writeUIntLE(99, 24, 3); webp.writeUIntLE(49, 27, 3);
  fs.writeFileSync(path.join(ws, 'a.webp'), webp);
  const ed = new WorkspaceEditor(ws);
  assert.match(ed.view('a.jpg').message, /image\/jpeg, \d+ bytes, 64x48$/);
  assert.match(ed.view('a.gif').message, /image\/gif, \d+ bytes, 7x5$/);
  assert.match(ed.view('a.webp').message, /image\/webp, \d+ bytes, 100x50$/);
  assert.equal(imageTypeOf(Buffer.from('BM\0\0\0\0')), null, 'BMP 等其他格式不放行');
});

test('其他二进制只报类型和大小；超过上限的图片报错且不读入全文', (t) => {
  const { ws } = dirs(t);
  fs.writeFileSync(path.join(ws, 'a.bin'), Buffer.from([1, 2, 0, 3, 4]));
  const big = Buffer.alloc(MAX_VIEW_IMAGE_BYTES + 1); PNG.copy(big);
  fs.writeFileSync(path.join(ws, 'big.png'), big);
  const ed = new WorkspaceEditor(ws);
  const bin = ed.view('a.bin');
  assert.equal(bin.code, 'BINARY_FILE'); assert.match(bin.message, /binary file \(5 bytes\)/);
  const tooBig = ed.view('big.png');
  assert.equal(tooBig.code, 'IMAGE_TOO_LARGE'); assert.equal(tooBig.image, undefined);
  assert.equal(ed.view('.').isError, false, '目录照旧');
});

test('可达范围跟文本一样按权限模式：完全访问可读工作区外的图片，其他模式拒绝', (t) => {
  const { ws, other } = dirs(t);
  const outside = path.join(other, 'b.png');
  fs.writeFileSync(outside, PNG);
  assert.equal(new WorkspaceEditor(ws, () => ({ mode: 'workspace-write' })).view(outside).code, 'INVALID_PATH');
  assert.equal(new WorkspaceEditor(ws, () => ({ mode: 'read-only' })).view(outside).code, 'INVALID_PATH');
  const full = new WorkspaceEditor(ws, () => ({ mode: 'danger-full-access' })).view(outside);
  assert.equal(full.isError, false); assert.equal(full.image?.mimeType, 'image/png');
});

test('MCP：图片块排在 JSON 文本之后，结构化结果和调用记录里都没有图片字节', async (t) => {
  // 自己管临时目录：先关数据库再删（Windows 上打开的 sqlite 文件删不掉）。
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bh-editor-image-mcp-')));
  const ws = path.join(base, 'ws'); fs.mkdirSync(ws);
  fs.writeFileSync(path.join(ws, 'a.png'), PNG);
  const storage = openDb(path.join(base, 'audit.sqlite'));
  const calls = new ToolCallsRepo(storage.db);
  const runtime = new SessionRuntime({ id: 'session', status: 'active', workspace_path: ws, permission_mode: 'workspace-write' }, {});
  const server = new McpServer({ name: 'editor-image', version: '1' });
  registerTools(server, id => id === SID ? runtime : { error: 'invalid session' }, {
    cfg: {}, toolCalls: calls, todos: new TodosRepo(storage.db), events: { append() {} },
    sessions: { byCredential: () => undefined }, semantic: { available: true },
  }, {});
  const client = new Client({ name: 'editor-image', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  t.after(async () => { await client.close(); await server.close(); storage.close(); fs.rmSync(base, { recursive: true, force: true }); });
  const r = await client.callTool({ name: 'editor', arguments: { sessionId: SID, path: 'a.png', operation: { command: 'view' } } });
  assert.equal(r.isError, false);
  assert.equal(r.content.length, 2);
  assert.equal(r.content[0].type, 'text');
  assert.match(JSON.parse(r.content[0].text).result.message, /Image: image\/png/);
  assert.deepEqual(r.content[1], { type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' });
  const b64 = PNG.toString('base64');
  assert.equal(JSON.stringify(r.structuredContent).includes(b64), false);
  const row = calls.listForSession('session')[0];
  assert.equal(row.status, 'completed');
  assert.equal(String(row.result_summary).includes(b64), false, '调用记录不存图片字节');
  const { tools } = await client.listTools();
  const tool = tools.find(x => x.name === 'editor');
  assert.match(tool.description, /PNG\/JPEG\/GIF\/WebP/);
  // 描述要和实际可达范围一致：不再声称“只能在工作区内”。
  assert.match(tool.description, /permission mode/);
  assert.doesNotMatch(JSON.stringify(tool), /all paths stay inside|must stay inside/);
});
