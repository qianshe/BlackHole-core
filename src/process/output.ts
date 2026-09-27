import { StringDecoder } from 'node:string_decoder';
import type { OutputEvent } from './types.js';

/** No terminal escape sequence (including OSC clipboard/shell integration) crosses this boundary. */
class SafeStream {
  private decoder = new StringDecoder('utf8');
  private state: 'text' | 'escape' | 'csi' | 'string' | 'stringEscape' = 'text';
  private pending = '';
  constructor(private readonly secrets: readonly string[]) {}
  write(bytes: Buffer, end = false): string {
    const text = end ? this.decoder.end() : this.decoder.write(bytes);
    let safe = '';
    for (const char of text) {
      const n = char.codePointAt(0)!;
      if (this.state === 'string') { if (n === 7 || n === 0x9c) this.state = 'text'; else if (n === 27) this.state = 'stringEscape'; continue; }
      if (this.state === 'stringEscape') { this.state = char === '\\' ? 'text' : 'string'; continue; }
      if (this.state === 'csi') { if (n >= 0x40 && n <= 0x7e) this.state = 'text'; continue; }
      if (this.state === 'escape') {
        this.state = char === '[' ? 'csi' : [']', 'P', '^', '_', 'X'].includes(char) ? 'string' : 'text'; continue;
      }
      if (n === 27) { this.state = 'escape'; continue; }
      if (n === 0x9b) { this.state = 'csi'; continue; }
      if ([0x90, 0x9d, 0x9e, 0x9f].includes(n)) { this.state = 'string'; continue; }
      if ((n < 32 && char !== '\n' && char !== '\t' && char !== '\r') || (n >= 0x7f && n <= 0x9f) || (n >= 0x202a && n <= 0x202e) || (n >= 0x2066 && n <= 0x2069)) continue;
      safe += char;
    }
    // Hold enough tail to recognize known secrets split across OS pipe chunks.
    let value = this.pending + safe;
    for (const secret of this.secrets) value = value.split(secret).join('[redacted]');
    let hold = 0;
    if (!end) for (const secret of this.secrets) {
      for (let n = Math.min(value.length, secret.length - 1); n > hold; n--) {
        if (value.endsWith(secret.slice(0, n))) { hold = n; break; }
      }
    }
    let at = Math.max(0, value.length - hold);
    if (at > 0 && /[\uD800-\uDBFF]/.test(value[at - 1]!)) at--;
    this.pending = value.slice(at);
    return value.slice(0, at);
  }
}

/** Truncate on a UTF-8 codepoint boundary, not in the middle of a Chinese character. */
export function tailBytes(text: string, cap: number): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= cap) return text;
  let start = Math.max(0, bytes.length - cap);
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString('utf8');
}
export function safeLabel(text: string): string {
  const stream = new SafeStream([]);
  return (stream.write(Buffer.from(text)) + stream.write(Buffer.alloc(0), true)).replace(/[\r\n\t]/g, ' ');
}

/** Bounded recent output; stdout floods cannot evict the entire stderr budget. */
export class ProcessOutput {
  private readonly streams: Record<'stdout' | 'stderr', SafeStream>;
  private readonly entries: Record<'stdout' | 'stderr', OutputEvent[]> = { stdout: [], stderr: [] };
  private readonly sizes = { stdout: 0, stderr: 0 };
  private seq = 0;
  private droppedThrough = 0;
  private ended = false;
  constructor(secrets: readonly string[] = [], private readonly perStreamBytes = 64 * 1024) {
    const filtered = [...new Set(secrets.filter(s => s.length >= 4))].sort((a, b) => b.length - a.length);
    this.streams = { stdout: new SafeStream(filtered), stderr: new SafeStream(filtered) };
  }
  push(stream: 'stdout' | 'stderr', bytes: Buffer): void {
    if (this.ended) return;
    // Bound processing chunks even when a native pipe delivers a very large buffer.
    for (let offset = 0; offset < bytes.length; offset += 8192) this.append(stream, this.streams[stream].write(bytes.subarray(offset, offset + 8192)));
  }
  private append(stream: 'stdout' | 'stderr', raw: string): void {
    if (!raw) return;
    const text = tailBytes(raw, this.perStreamBytes);
    const seq = ++this.seq;
    if (text.length !== raw.length) this.droppedThrough = Math.max(this.droppedThrough, seq);
    const row = { seq, stream, text };
    this.entries[stream].push(row); this.sizes[stream] += Buffer.byteLength(text);
    while (this.sizes[stream] > this.perStreamBytes || this.entries[stream].length > 1024) {
      const gone = this.entries[stream].shift()!;
      this.sizes[stream] -= Buffer.byteLength(gone.text);
      this.droppedThrough = Math.max(this.droppedThrough, gone.seq);
    }
  }
  end(): void {
    if (this.ended) return;
    for (const stream of ['stdout', 'stderr'] as const) this.append(stream, this.streams[stream].write(Buffer.alloc(0), true));
    this.ended = true;
  }
  snapshot(cap = 32 * 1024) {
    const stdout = this.entries.stdout.map(e => e.text).join('');
    const stderr = this.entries.stderr.map(e => e.text).join('');
    return { stdout: tailBytes(stdout, Math.floor(cap / 2)), stderr: tailBytes(stderr, Math.floor(cap / 2)),
      truncated: this.droppedThrough > 0 || Buffer.byteLength(stdout) > cap / 2 || Buffer.byteLength(stderr) > cap / 2, version: this.seq };
  }
  read(after: number, cap = 16 * 1024): { events: OutputEvent[]; next: number; gap: boolean } {
    const pending = [...this.entries.stdout, ...this.entries.stderr].filter(e => e.seq > after).sort((a, b) => a.seq - b.seq);
    let size = 0, gap = after < this.droppedThrough;
    const events: OutputEvent[] = [];
    for (const item of pending) {
      const length = Buffer.byteLength(item.text);
      if (events.length && size + length > cap) break;
      const text = length > cap ? tailBytes(item.text, cap) : item.text;
      if (text !== item.text) gap = true;
      events.push({ ...item, text }); size += Buffer.byteLength(text);
    }
    return { events, next: events.at(-1)?.seq ?? after, gap };
  }
}
