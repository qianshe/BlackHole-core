// Courier daemon side: ping, WebSocket handshake/Origin checks, relay and send API.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { test, after } from 'node:test';
import express from 'express';
import { CourierHub } from '../dist/courier/hub.js';
import { COURIER_EXTENSION_ORIGIN, mountCourier } from '../dist/courier/mount.js';
import { acceptKey } from '../dist/courier/ws.js';

const audits = [];
const hub = new CourierHub({ sendTimeoutMs: 400 });
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

async function connectCourier(targets = [{ targetId: 't-1', site: 'arena', label: 'Chat A', conversationKey: 'abc', pending: false, expectModel: null, open: true, ready: true, busy: false, draft: false }]) {
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
  const pending = post({ targetId: 't-1', text: '你好' });
  const cmd = await c.next();
  assert.equal(cmd.type, 'compose.send');
  assert.deepEqual(cmd.target, { targetId: 't-1' });
  assert.equal(cmd.text, '你好');
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
  assert.equal(s.version, '0.1.4');
  assert.equal(s.targets[0].targetId, 't-9');
  c.end();
});

test('not_confirmed counts as sent; a timeout says it may have been sent', async () => {
  const c = await connectCourier();
  const p1 = post({ targetId: 't-1', text: 'a' });
  const cmd = await c.next();
  c.send({ type: 'compose.result', id: cmd.id, ok: false, code: 'not_confirmed', message: '未确认' });
  assert.equal((await (await p1).json()).sent, true);
  const p2 = post({ targetId: 't-1', text: 'b' });
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
  const pending = post({ targetId: 't-1', text: 'x' });
  const cmd = await b.next();
  b.send({ type: 'compose.result', id: cmd.id, ok: true, message: 'ok' });
  assert.equal((await (await pending).json()).ok, true);
  b.end();
});

test('send API: native loopback only, validated input, offline state', async () => {
  assert.equal((await post({ targetId: 't-1', text: 'x' }, { origin: 'http://127.0.0.1' })).status, 403);
  assert.equal((await post({ targetId: 't-1', text: 'x', extra: 1 })).status, 400);
  assert.equal((await post({ targetId: 'bad id', text: 'x' })).status, 400);
  await new Promise((r) => setTimeout(r, 50));
  const off = await (await post({ targetId: 't-1', text: 'x' })).json();
  assert.deepEqual([off.ok, off.code, off.sent], [false, 'courier_offline', false]);
});
