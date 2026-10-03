// Courier daemon side: ping, WebSocket handshake/Origin checks, relay and send API.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { test, after } from 'node:test';
import express from 'express';
import { CourierHub } from '../dist/courier/hub.js';
import { CourierMessages } from '../dist/courier/messages.js';
import { COURIER_EXTENSION_ORIGIN, mountCourier } from '../dist/courier/mount.js';
import { acceptKey } from '../dist/courier/ws.js';
import { CourierPairs } from '../dist/courier/pairs.js';
import { ensureCourierMessagesTable } from '../dist/storage/db.js';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 回复线程在 SQLite 里（原来的 `new CourierMessages(null)` 内存模式由 `:memory:` 库取代，建表 DDL 与 daemon 迁移共用一份）。
function memoryDb() {
  const db = new DatabaseSync(':memory:');
  ensureCourierMessagesTable(db);
  return db;
}
const memoryMessages = () => new CourierMessages(memoryDb());

test('pairing: new → paired → unpaired survives a restart; stored sessions without a pair are direct', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bh-pairs-')), 'courier-pairs.json');
  const pairs = new CourierPairs(file);
  assert.equal(pairs.link('a', true), 'new');
  assert.equal(pairs.link('b', false), 'direct');
  const list = [{ id: 'a', name: 'A', status: 'draft' }];
  const stored = [];
  const h = new CourierHub({ sessions: () => list, pairs, onStarted: (id) => stored.push(id) });
  assert.equal(h.link('a'), 'new');
  pairs.set('a', 'paired', 'chatgpt', 'c-1');
  list[0].status = 'active';
  assert.equal(h.link('a'), 'paired');
  assert.deepEqual(h.unpair('a'), { ok: true, message: '已解除配对' });
  assert.equal(h.link('a'), 'unpaired');
  assert.equal(new CourierPairs(file).get('a').conversationKey, 'c-1');
  assert.equal(new CourierPairs(file).link('a', false), 'unpaired');
  assert.equal(h.unpair('bad id!').ok, false);
});

test('a deleted session: forget drops its pairing and thread for good', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-forget-'));
  const pairs = new CourierPairs(path.join(dir, 'courier-pairs.json'));
  const db = memoryDb();
  const messages = new CourierMessages(db);
  const list = [{ id: 'a', name: 'A', status: 'active' }, { id: 'b', name: 'B', status: 'active' }];
  let changes = 0;
  const h = new CourierHub({ sessions: () => list, pairs, messages, onChange: () => { changes++; } });
  pairs.set('a', 'paired', 'chatgpt', 'c-1');
  pairs.set('b', 'paired', 'chatgpt', 'c-2');
  messages.add({ sessionId: 'a', kind: 'user', text: 'hi', status: 'sent' });
  messages.add({ sessionId: 'b', kind: 'user', text: 'keep', status: 'sent' });
  list[0].status = 'revoked';
  h.forget('a');
  assert.equal(changes, 1);
  assert.equal(pairs.get('a'), undefined);
  assert.deepEqual(h.messages('a'), []);
  assert.equal(new CourierPairs(path.join(dir, 'courier-pairs.json')).get('a'), undefined);
  assert.equal(new CourierMessages(db).list('a').length, 0, 'a store opened on the same database (a restart) sees the thread gone');
  assert.equal(pairs.get('b').state, 'paired');
  assert.equal(messages.list('b').length, 1);
  h.forget('a');
  h.forget('bad id!');
  assert.equal(changes, 1);
  // an ended session: no pairing is written back by a late unpair from a UI or from Courier
  assert.equal(h.unpair('a').ok, false);
  assert.equal(pairs.get('a'), undefined);
});

test('a closed hub refuses a reconnecting Courier (a retiring daemon must not keep it)', () => {
  const h = new CourierHub({ sessions: () => [] });
  h.close();
  let closedWith = null;
  let listened = false;
  h.attach({ on: () => { listened = true; }, send: () => true, close: (code) => { closedWith = code; } });
  assert.equal(closedWith, 1001);
  assert.equal(listened, false, 'no handlers: the socket is not adopted');
  assert.equal(h.connected, false);
});

test('a bound chat that stops being busy ends the session activity at once (onIdle)', () => {
  const idle = [];
  const list = [{ id: 's-x', name: 'X', status: 'active' }];
  const h = new CourierHub({ sessions: () => list, pairs: new CourierPairs(null), messages: memoryMessages(), onIdle: (id) => idle.push(id) });
  h.attach({ on: (ev, fn) => { if (ev === 'message') h.__deliver = fn; }, send: () => true, close: () => {} });
  h.__deliver(JSON.stringify({ type: 'hello', client: 'blackhole-courier', protocol: 1, version: 't' }));
  const t = (busy) => h.__deliver(JSON.stringify({ type: 'targets', targets: [{ targetId: 't-x', site: 'arena', label: 'X', conversationKey: 'c-x', sessionId: 's-x', open: true, busy }] }));
  t(false);
  assert.deepEqual(idle, [], 'not busy from the start is no transition');
  t(true);
  t(true);
  assert.deepEqual(idle, []);
  t(false);
  assert.deepEqual(idle, ['s-x']);
  t(false);
  assert.deepEqual(idle, ['s-x'], 'fires once per turn');
});

test('a session deleted while Courier was away is cleared with its reason on reconnect', () => {
  const list = [{ id: 's-del', name: 'D', status: 'revoked' }, { id: 's-arc', name: 'A', status: 'archived' }];
  const h = new CourierHub({ sessions: () => list, pairs: new CourierPairs(null), messages: memoryMessages() });
  const sent = [];
  h.attach({ on: (ev, fn) => { if (ev === 'message') h.__deliver = fn; }, send: (t) => { sent.push(JSON.parse(t)); return true; }, close: () => {} });
  h.__deliver(JSON.stringify({ type: 'hello', client: 'blackhole-courier', protocol: 1, version: 't' }));
  h.__deliver(JSON.stringify({ type: 'targets', targets: [
    { targetId: 't-1', site: 'chatgpt', label: 'X', conversationKey: 'c-1', sessionId: 's-del', open: false },
    { targetId: 't-2', site: 'chatgpt', label: 'Y', conversationKey: 'c-2', sessionId: 's-arc', open: false },
  ] }));
  const clears = sent.filter((m) => m.type === 'bind.clear');
  assert.deepEqual(clears.find((m) => m.sessionId === 's-del')?.reason, 'revoked', 'a deleted session: its web chat may follow');
  assert.deepEqual(clears.find((m) => m.sessionId === 's-arc')?.reason, 'archived', 'archived only unbinds');
});

test('a reply racing a deletion does not bring the thread back', () => {
  const messages = memoryMessages();
  const pairs = new CourierPairs(null);
  const list = [{ id: 's-x', name: 'X', status: 'active' }];
  const h = new CourierHub({ sessions: () => list, pairs, messages });
  const sent = [];
  h.attach({ on: (ev, fn) => { if (ev === 'message') h.__deliver = fn; }, send: (t) => { sent.push(JSON.parse(t)); return true; }, close: () => {} });
  h.__deliver(JSON.stringify({ type: 'hello', client: 'blackhole-courier', protocol: 1, version: 't' }));
  h.__deliver(JSON.stringify({ type: 'targets', targets: [{ targetId: 't-x', site: 'arena', label: 'X', conversationKey: 'c-x', sessionId: 's-x', open: true }] }));
  h.__deliver(JSON.stringify({ type: 'reply', conversationKey: 'c-x', text: 'before' }));
  assert.equal(messages.list('s-x').length, 1);
  list[0].status = 'revoked';
  h.forget('s-x', { reason: 'revoked' });
  // The reason rides along: Courier deletes the web chat only for 'revoked', and only if its own
  // switch is on. The daemon never decides that, so it must not delete a chat itself.
  assert.ok(sent.some((m) => m.type === 'bind.clear' && m.sessionId === 's-x' && m.reason === 'revoked'));
  h.__deliver(JSON.stringify({ type: 'reply', conversationKey: 'c-x', text: 'late' }));
  assert.equal(messages.list('s-x').length, 0, 'the late reply is dropped');
});

test('the end reason reaches Courier: revoked vs archived vs a cut pairing', () => {
  const pairs = new CourierPairs(null);
  const list = [{ id: 's-r', name: 'R', status: 'active' }, { id: 's-a', name: 'A', status: 'active' }, { id: 's-u', name: 'U', status: 'active' }];
  const h = new CourierHub({ sessions: () => list, pairs });
  const sent = [];
  h.attach({ on: (ev, fn) => { if (ev === 'message') h.__deliver = fn; }, send: (t) => { sent.push(JSON.parse(t)); return true; }, close: () => {} });
  h.__deliver(JSON.stringify({ type: 'hello', client: 'blackhole-courier', protocol: 1, version: 't' }));
  h.__deliver(JSON.stringify({ type: 'targets', targets: [
    { targetId: 't-r', site: 'chatgpt', label: 'R', conversationKey: 'c-r', sessionId: 's-r', open: true },
    { targetId: 't-a', site: 'chatgpt', label: 'A', conversationKey: 'c-a', sessionId: 's-a', open: true },
    { targetId: 't-u', site: 'chatgpt', label: 'U', conversationKey: 'c-u', sessionId: 's-u', open: true },
  ] }));
  list[0].status = 'revoked';
  h.forget('s-r', { reason: 'revoked' });
  list[1].status = 'archived';
  h.forget('s-a', { reason: 'archived' });
  h.unpair('s-u');
  const reasons = Object.fromEntries(sent.filter((m) => m.type === 'bind.clear').map((m) => [m.sessionId, m.reason]));
  assert.equal(reasons['s-r'], 'revoked');
  assert.equal(reasons['s-a'], 'archived', 'archiving a session must never read as a delete');
  assert.equal(reasons['s-u'], 'unpaired', 'cutting a pairing must never read as a delete');
});

const audits = [];
const SESSIONS = [{ id: 's-1', name: 'Fix login', status: 'active' }, { id: 's-2', name: 'Other', status: 'active' }, { id: 's-old', name: 'Gone', status: 'revoked' }];
const log = memoryMessages();
const hub = new CourierHub({ sendTimeoutMs: 400, startTimeoutMs: 400, sessions: () => SESSIONS, messages: log, initialPrompt: (id, message, kind = 'connector') => ({ text: `[${kind}:${id}] ${message}` }) });
const app = express();
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
mountCourier(app, server, hub, (d) => audits.push(d));
const port = server.address().port;
after(() => { hub.close(); server.close(); });

function frame(op, payload, { fin = true, masked = true } = {}) {
  const n = payload.length;
  const head = Buffer.alloc(n < 126 ? 2 : 4);
  head[0] = (fin ? 0x80 : 0) | op;
  head[1] = (masked ? 0x80 : 0) | (n < 126 ? n : 126);
  if (n >= 126) head.writeUInt16BE(n, 2);
  if (!masked) return Buffer.concat([head, payload]);
  const mask = randomBytes(4);
  const body = Buffer.from(payload);
  for (let i = 0; i < n; i++) body[i] ^= mask[i & 3];
  return Buffer.concat([head, mask, body]);
}

/** Raw client: returns the handshake status line and, on 101, helpers to exchange text. */
function open({ origin = COURIER_EXTENSION_ORIGIN, path = '/api/courier', host = `127.0.0.1:${port}` } = {}) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    const key = randomBytes(16).toString('base64');
    let buf = Buffer.alloc(0);
    let upgraded = false;
    const inbox = [];
    const waiting = [];
    let closed = null;
    const push = (m) => { const w = waiting.shift(); if (w) w(m); else inbox.push(m); };
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!upgraded) {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = buf.subarray(0, end).toString();
        buf = buf.subarray(end + 4);
        const status = Number(head.split(' ')[1]);
        if (status !== 101) { resolve({ status }); sock.destroy(); return; }
        assert.match(head, new RegExp(`Sec-WebSocket-Accept: ${acceptKey(key).replace(/[+/]/g, '\\$&')}`));
        upgraded = true;
        resolve({ status, send: (o) => sock.write(frame(1, Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)))), raw: (b) => sock.write(b),
          next: () => new Promise((r) => { const m = inbox.shift(); if (m) r(m); else waiting.push(r); }),
          closed: () => new Promise((r) => { if (closed) r(closed); else sock.once('close', () => r(closed ?? 1006)); }),
          end: () => sock.destroy() });
      }
      while (buf.length >= 2) {
        const op = buf[0] & 0x0f;
        let len = buf[1] & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        if (buf.length < off + len) return;
        const p = buf.subarray(off, off + len);
        buf = buf.subarray(off + len);
        if (op === 1) push(JSON.parse(p.toString()));
        else if (op === 8) closed = p.readUInt16BE(0);
        else if (op === 10) push({ type: '__pong', data: p.toString() });
      }
    });
    sock.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n${origin ? `Origin: ${origin}\r\n` : ''}\r\n`);
  });
}

async function connectCourier(targets = [{ targetId: 't-1', site: 'arena', label: 'Chat A', conversationKey: 'abc', pending: false, expectModel: null, open: true, ready: true, busy: false, draft: false, sessionId: 's-1' }]) {
  const c = await open();
  c.send({ type: 'hello', client: 'blackhole-courier', version: '0.1.4', protocol: 1 });
  assert.equal((await c.next()).type, 'hello.ok');
  c.send({ type: 'targets', targets });
  await new Promise((r) => setTimeout(r, 30));
  return c;
}

const post = (body, headers = {}) => fetch(`http://127.0.0.1:${port}/api/courier/send`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('ping answers the protocol version on loopback only', async () => {
  const ok = await fetch(`http://127.0.0.1:${port}/api/courier/ping`);
  assert.deepEqual(await ok.json(), { service: 'blackhole', courier: 1 });
  const proxied = await fetch(`http://127.0.0.1:${port}/api/courier/ping`, { headers: { 'x-forwarded-for': '1.2.3.4' } });
  assert.equal(proxied.status, 403);
});

test('handshake requires the Courier extension origin and a loopback host', async () => {
  assert.equal((await open({ origin: 'https://evil.example' })).status, 403);
  assert.equal((await open({ origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })).status, 403);
  assert.equal((await open({ origin: '' })).status, 403);
  assert.equal((await open({ host: 'evil.example' })).status, 403);
  assert.equal((await open({ path: '/api/other' })).status, 404);
});

test('hello with the wrong protocol is rejected', async () => {
  const c = await open();
  c.send({ type: 'hello', client: 'blackhole-courier', version: '9', protocol: 2 });
  assert.equal((await c.next()).type, 'hello.rejected');
  assert.equal(await c.closed(), 1008);
});

test('unmasked client frames close the connection', async () => {
  const c = await open();
  c.raw(frame(1, Buffer.from('{}'), { masked: false }));
  assert.equal(await c.closed(), 1002);
});

test('relays a send to Courier and returns its result', async () => {
  const c = await connectCourier();
  const pending = post({ targetId: 't-1', text: '你好', sessionId: 's-1' });
  const cmd = await c.next();
  assert.equal(cmd.type, 'compose.send');
  assert.deepEqual(cmd.target, { targetId: 't-1' });
  assert.equal(cmd.text, '你好');
  assert.equal(cmd.sessionId, 's-1');
  assert.equal(cmd.sessionName, 'Fix login', 'Courier keeps the name on the binding current from the message itself');
  c.send({ type: 'compose.result', id: cmd.id, ok: true, message: '已发送', targetId: 't-1' });
  const res = await pending;
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, message: '已发送', sent: true, targetId: 't-1' });
  assert.deepEqual(audits.at(-1), { site: 'arena', ok: true, code: null, via: 'vscode' });
  assert.ok(!JSON.stringify(audits).includes('你好'), 'message text is never audited');
  c.end();
});

test('fragmented messages and pings are handled', async () => {
  const c = await connectCourier();
  const json = Buffer.from(JSON.stringify({ type: 'targets', targets: [] }));
  c.raw(frame(1, json.subarray(0, 5), { fin: false }));
  c.raw(frame(9, Buffer.from('hi')));
  c.raw(frame(0, json.subarray(5)));
  assert.deepEqual(await c.next(), { type: '__pong', data: 'hi' });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual((await hub.status(false)).targets, []);
  c.end();
});

test('status refreshes targets from Courier', async () => {
  const c = await connectCourier();
  const pending = fetch(`http://127.0.0.1:${port}/api/courier`);
  const ask = await c.next();
  assert.equal(ask.type, 'targets.list');
  c.send({ type: 'targets', id: ask.id, targets: [{ targetId: 't-9', site: 'chatgpt', label: 'X', open: false }] });
  const s = await (await pending).json();
  assert.equal(s.connected, true);
  assert.equal(s.targets[0].targetId, 't-9');
  c.end();
});

test('not_confirmed counts as sent; a timeout says it may have been sent', async () => {
  const c = await connectCourier();
  const p1 = post({ targetId: 't-1', text: 'a', sessionId: 's-1' });
  const cmd = await c.next();
  c.send({ type: 'compose.result', id: cmd.id, ok: false, code: 'not_confirmed', message: '未确认' });
  assert.equal((await (await p1).json()).sent, true);
  const p2 = post({ targetId: 't-1', text: 'b', sessionId: 's-1' });
  await c.next();
  const r2 = await (await p2).json();
  assert.equal(r2.code, 'timeout');
  assert.equal(r2.sent, true);
  c.end();
});

test('a new connection replaces the old one', async () => {
  const a = await connectCourier();
  const b = await connectCourier();
  assert.equal(await a.closed(), 1000);
  const pending = post({ targetId: 't-1', text: 'x', sessionId: 's-1' });
  const cmd = await b.next();
  b.send({ type: 'compose.result', id: cmd.id, ok: true, message: 'ok' });
  assert.equal((await (await pending).json()).ok, true);
  b.end();
});

test('a chat only takes messages for the BlackHole session it is bound to', async () => {
  const c = await connectCourier();
  const other = await (await post({ targetId: 't-1', text: 'x', sessionId: 's-2' })).json();
  assert.deepEqual([other.ok, other.code, other.sent], [false, 'session_mismatch', false]);
  const ended = await (await post({ targetId: 't-1', text: 'x', sessionId: 's-old' })).json();
  assert.equal(ended.code, 'session_inactive');
  const unknown = await (await post({ targetId: 't-404', text: 'x', sessionId: 's-1' })).json();
  assert.equal(unknown.code, 'unknown_target');
  c.end();
});

const thread = async (id) => (await (await fetch(`http://127.0.0.1:${port}/api/courier/messages?sessionId=${id}`)).json()).messages;

test('sends are kept in the session thread with their outcome', async () => {
  const c = await connectCourier();
  const before = (await thread('s-1')).length;
  const p = post({ targetId: 't-1', text: '第一条', sessionId: 's-1' });
  const cmd = await c.next();
  c.send({ type: 'compose.result', id: cmd.id, ok: false, code: 'busy', message: '正在生成' });
  await p;
  const list = await thread('s-1');
  assert.equal(list.length, before + 1);
  const m = list.at(-1);
  assert.deepEqual([m.kind, m.text, m.status, m.code, m.site, m.conversationKey], ['user', '第一条', 'failed', 'busy', 'arena', 'abc']);
  assert.deepEqual(await thread('s-2'), [], 'threads are per session');
  c.end();
});

test('start opens a new chat through Courier and records the first message', async (t) => {
  SESSIONS.push({ id: 's-new', name: 'Fresh', status: 'draft' });
  t.after(() => { SESSIONS.pop(); });
  const c = await connectCourier([]);
  const p = fetch(`http://127.0.0.1:${port}/api/courier/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 's-new', text: '开始' }) });
  const cmd = await c.next();
  assert.equal(cmd.type, 'compose.start');
  assert.equal(cmd.site, 'arena');
  assert.deepEqual(cmd.session, { id: 's-new', name: 'Fresh' });
  c.send({ type: 'compose.result', id: cmd.id, ok: true, message: '已发送', targetId: 't-new', conversationKey: 'k-new' });
  const r = await (await p).json();
  assert.deepEqual([r.ok, r.targetId], [true, 't-new']);
  const m = (await thread('s-new')).at(-1);
  assert.deepEqual([m.kind, m.text, m.status, m.conversationKey], ['user', '开始', 'sent', 'k-new']);
  // Only a never-linked session may open a chat.
  const again = await fetch(`http://127.0.0.1:${port}/api/courier/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 's-2', text: 'x' }) });
  assert.equal((await again.json()).code, 'already_linked');
  const bad = await fetch(`http://127.0.0.1:${port}/api/courier/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 's-old', text: 'x' }) });
  assert.equal((await bad.json()).code, 'session_inactive');
  c.end();
});

test('the template follows the site: connector for ChatGPT/Claude/Manus, sandbox otherwise', async () => {
  const { templateForSite } = await import('../dist/courier/siteTemplate.js');
  assert.equal(templateForSite('chatgpt'), 'connector');
  assert.equal(templateForSite('arena'), 'sandbox');
  assert.equal(templateForSite('c-claude-ai', 'https://claude.ai'), 'connector');
  assert.equal(templateForSite('c-manus-im', 'https://www.manus.im'), 'connector');
  assert.equal(templateForSite('c-kimi-com', 'https://www.kimi.com'), 'sandbox');
  assert.equal(templateForSite('c-x', null), 'sandbox');
  assert.equal(templateForSite('c-x', 'https://claude.ai.evil.com'), 'sandbox');
});

test('start ignores a client template: Arena gets the sandbox prompt even if asked for connector', async (t) => {
  SESSIONS.push({ id: 's-tpl2', name: 'Tpl2', status: 'draft' });
  t.after(() => { SESSIONS.pop(); });
  const c = await connectCourier([]);
  const p = fetch(`http://127.0.0.1:${port}/api/courier/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 's-tpl2', text: 'x', site: 'arena', template: 'connector' }) });
  const cmd = await c.next();
  assert.deepEqual([cmd.site, cmd.text], ['arena', '[sandbox:s-tpl2] x']);
  c.send({ type: 'compose.result', id: cmd.id, ok: false, code: 'busy', message: '忙' });
  await p;
  c.end();
});

test('start wraps the first message in the picked template (Arena: sandbox, ChatGPT: connector)', async (t) => {
  SESSIONS.push({ id: 's-tpl', name: 'Tpl', status: 'draft' });
  t.after(() => { SESSIONS.pop(); });
  const c = await connectCourier([]);
  const p = fetch(`http://127.0.0.1:${port}/api/courier/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 's-tpl', text: '做事', site: 'arena', template: 'sandbox' }) });
  const cmd = await c.next();
  assert.deepEqual([cmd.site, cmd.text], ['arena', '[sandbox:s-tpl] 做事']);
  c.send({ type: 'compose.result', id: cmd.id, ok: false, code: 'busy', message: '忙' });
  await p;
  c.end();
});

test('an unnamed draft: compose.start already carries the name its first message gives it', async (t) => {
  // named: false = the name is only the fallback (workspace folder) until the first message is sent.
  SESSIONS.push({ id: 's-unnamed', name: 'blackhole', named: false, status: 'draft' });
  t.after(() => { SESSIONS.pop(); });
  const c = await connectCourier([]);
  const p = fetch(`http://127.0.0.1:${port}/api/courier/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 's-unnamed', text: '  \n修复会话名\n第二行', site: 'chatgpt', template: 'connector' }) });
  const cmd = await c.next();
  assert.equal(cmd.type, 'compose.start');
  assert.deepEqual(cmd.session, { id: 's-unnamed', name: '修复会话名' }, 'the first non-empty line, not the placeholder');
  c.send({ type: 'compose.result', id: cmd.id, ok: false, code: 'busy', message: '忙' });
  await p;
  // A draft that already has a name keeps it.
  SESSIONS.at(-1).named = true; SESSIONS.at(-1).name = '已命名';
  const p2 = fetch(`http://127.0.0.1:${port}/api/courier/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 's-unnamed', text: '别的', site: 'chatgpt', template: 'connector' }) });
  const cmd2 = await c.next();
  assert.deepEqual(cmd2.session, { id: 's-unnamed', name: '已命名' });
  c.send({ type: 'compose.result', id: cmd2.id, ok: false, code: 'busy', message: '忙' });
  await p2;
  c.end();
});

test('web agent replies land in the bound session only, once per turn', async () => {
  const c = await connectCourier();
  const before = (await thread('s-1')).length;
  c.send({ type: 'reply', conversationKey: 'abc', turn: 3, text: '好的，已完成', model: 'claude-x' });
  c.send({ type: 'reply', conversationKey: 'abc', turn: 3, text: '好的，已完成' });
  c.send({ type: 'reply', conversationKey: 'not-bound', turn: 1, text: 'x' });
  await new Promise((r) => setTimeout(r, 40));
  const list = await thread('s-1');
  assert.equal(list.length, before + 1);
  assert.deepEqual([list.at(-1).kind, list.at(-1).text, list.at(-1).model], ['agent', '好的，已完成', 'claude-x']);
  c.end();
});

test('streamed reply segments update one message in place and reach /stream listeners', async () => {
  const c = await connectCourier();
  const ctl = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/api/courier/stream?sessionId=s-1`, { signal: ctl.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const reader = res.body.getReader();
  const events = [];
  const reading = (async () => {
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const data = block.split('\n').find((l) => l.startsWith('data: '));
          if (data) events.push(JSON.parse(data.slice(6)));
        }
      }
    } catch { /* aborted */ }
  })();
  const before = (await thread('s-1')).length;
  c.send({ type: 'reply', conversationKey: 'abc', segment: 'seg-1', partial: true, text: '正在' });
  c.send({ type: 'reply', conversationKey: 'abc', segment: 'seg-1', partial: true, text: '正在检查' });
  c.send({ type: 'reply', conversationKey: 'abc', segment: 'seg-1', partial: false, text: '正在检查文件' });
  c.send({ type: 'reply', conversationKey: 'abc', segment: 'seg-1', partial: true, text: '正在' }); // late partial: ignored
  c.send({ type: 'reply', conversationKey: 'abc', segment: 'seg-2', partial: true, text: '改好了' });
  await new Promise((r) => setTimeout(r, 60));
  const list = await thread('s-1');
  assert.equal(list.length, before + 2);
  assert.deepEqual([list.at(-2).text, list.at(-2).status], ['正在检查文件', 'reply']);
  assert.deepEqual([list.at(-1).text, list.at(-1).status], ['改好了', 'streaming']);
  assert.deepEqual(events.map((e) => e.text), ['正在', '正在检查', '正在检查文件', '改好了']);
  assert.equal(new Set(events.slice(0, 3).map((e) => e.id)).size, 1, 'one message id per segment');
  c.end();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal((await thread('s-1')).at(-1).status, 'reply', 'Courier gone: streaming segments are closed');
  ctl.abort();
  await reading;
});

test('Courier can list live BlackHole sessions for its bind picker', async () => {
  const c = await connectCourier();
  c.send({ type: 'sessions.list', id: 'q1' });
  const r = await c.next();
  assert.equal(r.type, 'sessions');
  assert.equal(r.id, 'q1');
  assert.deepEqual(r.sessions.map((s) => s.id), ['s-1', 's-2'], 'revoked sessions are left out');
  assert.ok(!JSON.stringify(r).includes('credential'), 'only ids and names, never credentials');
  c.end();
});

test('send API: native loopback only, validated input, offline state', async () => {
  assert.equal((await post({ targetId: 't-1', text: 'x', sessionId: 's-1' }, { origin: 'http://127.0.0.1' })).status, 403);
  assert.equal((await post({ targetId: 't-1', text: 'x', sessionId: 's-1', extra: 1 })).status, 400);
  assert.equal((await post({ targetId: 'bad id', text: 'x', sessionId: 's-1' })).status, 400);
  assert.equal((await post({ targetId: 't-1', text: 'x' })).status, 400, 'a send always names its BlackHole session');
  await new Promise((r) => setTimeout(r, 50));
  const off = await (await post({ targetId: 't-1', text: 'x', sessionId: 's-1' })).json();
  assert.deepEqual([off.ok, off.code, off.sent], [false, 'courier_offline', false]);
});

test('a question answered on the web page updates its message (answered, answer)', () => {
  const store = memoryMessages();
  const base = { sessionId: 's-q', kind: 'agent', text: '❓ 选颜色\n1. 红\n2. 蓝', site: 'arena', targetId: 't-q', conversationKey: 'c-q', segment: 'question-1', status: 'reply' };
  const q = { title: '选颜色', options: ['红', '蓝'], skip: true, input: false };
  store.upsertSegment({ ...base, question: q });
  const seen = [];
  store.subscribe?.((m) => seen.push(m));
  const updated = store.upsertSegment({ ...base, question: { ...q, answered: true, answer: '蓝' } });
  assert.equal(updated?.question?.answered, true);
  assert.equal(updated?.question?.answer, '蓝');
  assert.equal(store.upsertSegment({ ...base, question: { ...q, answered: true, answer: '蓝' } }), null, 'same state: no update');
});


const stopPost = (body) => fetch(`http://127.0.0.1:${port}/api/courier/stop`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('relays a stop to Courier and returns what was pressed', async () => {
  const c = await connectCourier();
  const pending = stopPost({ sessionId: 's-1' });
  const cmd = await c.next();
  assert.equal(cmd.type, 'compose.stop');
  assert.deepEqual(cmd.target, { targetId: 't-1' });
  assert.equal(cmd.sessionId, 's-1');
  c.send({ type: 'compose.result', id: cmd.id, ok: true, message: '已点停止（Stop generating）', targetId: 't-1', clicked: 1, label: 'Stop generating' });
  const res = await pending;
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.message, '已点停止（Stop generating）');
  assert.equal(body.targetId, 't-1');
  assert.equal(body.sent, true);
  assert.deepEqual(audits.at(-1), { site: 'arena', ok: true, code: null, stop: true, via: 'vscode' });
  c.end();
});

test('a page with no stop button says so instead of failing blind', async () => {
  const c = await connectCourier();
  const pending = stopPost({ sessionId: 's-1' });
  const cmd = await c.next();
  c.send({ type: 'compose.result', id: cmd.id, ok: false, code: 'not_running', message: '页面上没有可见的停止按钮', targetId: 't-1' });
  const r = await (await pending).json();
  assert.equal(r.ok, false);
  assert.equal(r.code, 'not_running');
  assert.match(r.message, /停止按钮/);
  c.end();
});

const reloadPost = (body) => fetch(`http://127.0.0.1:${port}/api/courier/reload`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('relays a forced reload to Courier; refuses unpaired and foreign targets', async () => {
  const c = await connectCourier();
  const pending = reloadPost({ sessionId: 's-1' });
  const cmd = await c.next();
  assert.equal(cmd.type, 'tab.reload');
  assert.deepEqual(cmd.target, { targetId: 't-1' });
  assert.equal(cmd.sessionId, 's-1');
  c.send({ type: 'compose.result', id: cmd.id, ok: true, message: '已刷新', targetId: 't-1' });
  const body = await (await pending).json();
  assert.equal(body.ok, true);
  assert.equal(body.message, '已刷新');
  assert.equal(body.sent, false);
  assert.deepEqual(audits.at(-1), { site: 'arena', ok: true, code: null, reload: true, via: 'vscode' });
  assert.equal((await (await reloadPost({ sessionId: 's-2' })).json()).code, 'unknown_target');
  assert.equal((await (await reloadPost({ sessionId: 's-2', targetId: 't-1' })).json()).code, 'session_mismatch');
  assert.equal((await reloadPost({ sessionId: 's-1', force: true })).status, 400);
  c.end();
});

test('relays 处理评价卡 to Courier with the same session gate', async () => {
  const c = await connectCourier();
  const pending = fetch(`http://127.0.0.1:${port}/api/courier/card`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 's-1' }) });
  const cmd = await c.next();
  assert.equal(cmd.type, 'card.rate');
  assert.deepEqual(cmd.target, { targetId: 't-1' });
  c.send({ type: 'compose.result', id: cmd.id, ok: false, code: 'no_card', message: '页面上没有评价卡', targetId: 't-1' });
  const body = await (await pending).json();
  assert.equal(body.ok, false);
  assert.equal(body.code, 'no_card');
  assert.deepEqual(audits.at(-1), { site: 'arena', ok: false, code: 'no_card', card: true, via: 'vscode' });
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/courier/card`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 's-2', targetId: 't-1' }) })).json()).code, 'session_mismatch');
  c.end();
});

test('a stop is refused for a session with no pairing, and for a foreign target', async () => {
  const c = await connectCourier();
  const noPair = await (await stopPost({ sessionId: 's-2' })).json();
  assert.equal(noPair.code, 'unknown_target');
  const wrongTarget = await (await stopPost({ sessionId: 's-2', targetId: 't-1' })).json();
  assert.equal(wrongTarget.code, 'session_mismatch', 't-1 belongs to s-1');
  const badBody = await stopPost({ sessionId: 's-1', text: 'x' });
  assert.equal(badBody.status, 400);
  c.end();
});

test('courier sites: hello carries them, put/remove reach the store, changes are pushed, start accepts them', async () => {
  let list = [{ id: 'c-kimi-com', name: 'Kimi' }];
  const calls = [];
  const sites = { list: () => list, put: (s) => { calls.push(['put', s]); return { ok: true }; }, remove: (id) => { calls.push(['remove', id]); return { ok: true }; } };
  const h = new CourierHub({ sessions: () => [{ id: 's-9', name: 'S9', status: 'draft' }], sites, startTimeoutMs: 500 });
  const handlers = {};
  const out = [];
  h.attach({ on: (t, fn) => { handlers[t] = fn; }, send: (t) => out.push(JSON.parse(t)), close: () => {} });
  const say = (m) => handlers.message(JSON.stringify(m));
  say({ type: 'hello', client: 'blackhole-courier', version: '0.1.71', protocol: 1 });
  assert.equal(out[0].type, 'hello.ok');
  assert.deepEqual(out[0].sites, list, 'Courier reconciles its sites on every connect');
  say({ type: 'sites.put', site: { id: 'c-x' } });
  say({ type: 'sites.remove', id: 'c-kimi-com' });
  assert.deepEqual(calls, [['put', { id: 'c-x' }], ['remove', 'c-kimi-com']]);
  list = [];
  h.pushSites();
  assert.deepEqual(out.at(-1), { type: 'sites', sites: [] }, 'a deletion in any UI reaches Courier');
  assert.deepEqual((await h.status(false)).sites.map((s) => s.id), ['arena', 'chatgpt']);
  list = [{ id: 'c-kimi-com', name: 'Kimi' }];
  assert.deepEqual((await h.status(false)).sites.at(-1), { id: 'c-kimi-com', name: 'Kimi', custom: true, template: 'sandbox' });
  assert.equal((await h.start({ sessionId: 's-9', text: 'hi', site: 'c-nope' })).code, 'invalid_input', 'only known sites');
  const pending = h.start({ sessionId: 's-9', text: 'hi', site: 'c-kimi-com' });
  await new Promise((r) => setTimeout(r, 10));
  const cmd = out.at(-1);
  assert.equal(cmd.type, 'compose.start');
  assert.equal(cmd.site, 'c-kimi-com');
  say({ type: 'compose.result', id: cmd.id, ok: true, message: '已发送' });
  assert.equal((await pending).ok, true);
  h.close();
});

test('without a sites store hello.ok carries no list (older Courier behaviour unchanged)', () => {
  const h = new CourierHub({ sessions: () => [] });
  const handlers = {};
  const out = [];
  h.attach({ on: (t, fn) => { handlers[t] = fn; }, send: (t) => out.push(JSON.parse(t)), close: () => {} });
  handlers.message(JSON.stringify({ type: 'hello', client: 'blackhole-courier', version: '0.1.71', protocol: 1 }));
  assert.equal('sites' in out[0], false);
  h.close();
});
test('subscription gate: denied stops sending and new pairings, keeps existing ones; changes are pushed', async () => {
  const os = await import('node:os');
  const fs = await import('node:fs');
  const p = await import('node:path');
  const dir = fs.mkdtempSync(p.join(os.tmpdir(), 'bh-access-'));
  const pairs = new CourierPairs(p.join(dir, 'pairs.json'));
  pairs.set('s-old', 'paired', 'arena', 'k-old');
  let ok = false;
  const h = new CourierHub({ sessions: () => [{ id: 's-old', name: 'Old', status: 'active' }, { id: 's-new', name: 'New', status: 'draft' }], pairs,
    access: { valid: () => ok, check: async () => ok }, startTimeoutMs: 300, sendTimeoutMs: 300 });
  const handlers = {};
  const out = [];
  h.attach({ on: (t, fn) => { handlers[t] = fn; }, send: (t) => out.push(JSON.parse(t)), close: () => {} });
  const say = (m) => handlers.message(JSON.stringify(m));
  say({ type: 'hello', client: 'blackhole-courier', version: '0.1.80', protocol: 1 });
  assert.equal(out[0].access, 'denied', 'hello.ok tells Courier, without reasons or dates');
  assert.deepEqual(Object.keys(out[0]).sort(), ['access', 'protocol', 'type']);
  assert.equal((await h.start({ sessionId: 's-new', text: 'hi', site: 'arena' })).code, 'subscription_required');
  assert.equal((await h.send({ targetId: 't-1', sessionId: 's-old', text: 'hi' })).code, 'subscription_required');
  say({ type: 'pair', sessionId: 's-new', site: 'arena', conversationKey: 'k-new' });
  assert.equal(pairs.get('s-new'), undefined, 'no new pairing while denied');
  say({ type: 'targets', targets: [{ targetId: 't-2', site: 'arena', origin: 'https://arena.ai', conversationKey: 'k-x', sessionId: 's-new', label: 'x' }] });
  assert.equal(pairs.get('s-new'), undefined, 'a binding reported by Courier does not pair either');
  assert.equal(pairs.get('s-old').state, 'paired', 'existing pairing kept');
  ok = true;
  h.pushAccess();
  assert.deepEqual(out.at(-1), { type: 'access', access: 'ok' });
  const n = out.length;
  h.pushAccess();
  assert.equal(out.length, n, 'only flips are pushed');
  h.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a ChatGPT reply seen again after a page reload stays one record (page message id)', () => {
  const store = memoryMessages();
  const sid = '123456789012345678901234567890123456789';
  const base = { sessionId: sid, kind: 'agent', site: 'chatgpt', targetId: 't-1', conversationKey: 'c1', status: 'reply' };
  // stored before message ids were sent: matched once by text, then by id
  store.upsertSegment({ ...base, text: '你好', segment: 'gpt-c1-aaa-1' });
  store.upsertSegment({ ...base, text: '你好', segment: 'gpt-c1-bbb-1', messageId: 'm-1' });
  store.upsertSegment({ ...base, text: '你好', segment: 'gpt-c1-ccc-1', messageId: 'm-1' });
  // a new reply with the same words but its own id is a new record
  store.upsertSegment({ ...base, text: '你好', segment: 'gpt-c1-ccc-2', messageId: 'm-2' });
  const list = store.list(sid);
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((m) => m.messageId), ['m-1', 'm-2']);
});
