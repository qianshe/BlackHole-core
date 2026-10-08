import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

/**
 * Minimal RFC 6455 server side for one local client (the Courier extension).
 * Text messages only; masked client frames, fragmentation, ping/pong and close.
 */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const MAX_MESSAGE = 1024 * 1024;
const KEY = /^[A-Za-z0-9+/]{22}==$/;

export const acceptKey = (key: string): string => createHash('sha1').update(key + GUID).digest('base64');

export function rejectUpgrade(socket: Duplex, status: number, text: string): void {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/** Complete the handshake, or answer 400 and return null. */
export function acceptUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): WsConnection | null {
  const key = req.headers['sec-websocket-key'];
  if (
    req.method !== 'GET' ||
    String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket' ||
    typeof key !== 'string' || !KEY.test(key) ||
    req.headers['sec-websocket-version'] !== '13'
  ) {
    rejectUpgrade(socket, 400, 'Bad Request');
    return null;
  }
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);
  const conn = new WsConnection(socket);
  if (head.length) conn.feed(head);
  return conn;
}

export class WsConnection extends EventEmitter {
  private buf: Buffer = Buffer.alloc(0);
  private frags: Buffer[] = [];
  private fragOp = 0;
  private fragLen = 0;
  closed = false;

  constructor(private readonly socket: Duplex) {
    super();
    (socket as { setNoDelay?: (v: boolean) => void }).setNoDelay?.(true);
    socket.on('data', (d: Buffer) => this.feed(d));
    socket.on('close', () => this.finish(1006));
    // HTTP server sockets are half-open: a client hang-up arrives as 'end' only.
    socket.on('end', () => { this.finish(1006); socket.end(); });
    socket.on('error', () => socket.destroy());
  }

  feed(d: Buffer): void {
    if (this.closed) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    while (!this.closed && this.frame());
  }

  /** Parse one frame from the buffer; false when more bytes are needed or the connection closed. */
  private frame(): boolean {
    const b = this.buf;
    if (b.length < 2) return false;
    const b0 = b.readUInt8(0);
    const b1 = b.readUInt8(1);
    const fin = (b0 & 0x80) !== 0;
    const op = b0 & 0x0f;
    if (b0 & 0x70 || !(b1 & 0x80)) return this.fail(1002); // no extensions; clients must mask
    let len = b1 & 0x7f;
    let off = 2;
    if (len === 126) {
      if (b.length < 4) return false;
      len = b.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (b.length < 10) return false;
      if (b.readUInt32BE(2) !== 0) return this.fail(1009);
      len = b.readUInt32BE(6);
      off = 10;
    }
    if (len > MAX_MESSAGE) return this.fail(1009);
    if (b.length < off + 4 + len) return false;
    const mask = b.subarray(off, off + 4);
    const payload = Buffer.from(b.subarray(off + 4, off + 4 + len));
    for (let i = 0; i < len; i++) payload.writeUInt8(payload.readUInt8(i) ^ mask.readUInt8(i & 3), i);
    this.buf = b.subarray(off + 4 + len);

    if (op >= 8) {
      if (!fin || len > 125) return this.fail(1002);
      if (op === 8) { this.close(1000); return false; }
      if (op === 9) this.write(0x0a, payload);
      else if (op !== 10) return this.fail(1002);
      return true;
    }
    if (op === 0) {
      if (!this.fragOp) return this.fail(1002);
    } else if (op === 1 || op === 2) {
      if (this.fragOp) return this.fail(1002);
      this.fragOp = op;
    } else return this.fail(1002);
    this.fragLen += len;
    if (this.fragLen > MAX_MESSAGE) return this.fail(1009);
    this.frags.push(payload);
    if (!fin) return true;

    const data = Buffer.concat(this.frags);
    const kind = this.fragOp;
    this.frags = [];
    this.fragOp = 0;
    this.fragLen = 0;
    if (kind !== 1) return this.fail(1003);
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { return this.fail(1007); }
    this.emit('message', text);
    return true;
  }

  send(text: string): boolean {
    if (this.closed) return false;
    this.write(0x01, Buffer.from(text, 'utf8'));
    return true;
  }

  close(code = 1000): void {
    if (this.closed) return;
    this.closed = true;
    const p = Buffer.alloc(2);
    p.writeUInt16BE(code);
    try { this.write(0x08, p); } catch { /* socket already gone */ }
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 1000).unref();
    this.emit('close', code);
  }

  private fail(code: number): false {
    this.close(code);
    return false;
  }

  private finish(code: number): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', code);
  }

  private write(op: number, payload: Buffer): void {
    const n = payload.length;
    const head = n < 126 ? Buffer.alloc(2) : n < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
    head[0] = 0x80 | op;
    if (n < 126) head[1] = n;
    else if (n < 65536) { head[1] = 126; head.writeUInt16BE(n, 2); }
    else { head[1] = 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(n, 6); }
    this.socket.write(Buffer.concat([head, payload]));
  }
}
