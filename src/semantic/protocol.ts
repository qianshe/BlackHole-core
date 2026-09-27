/**
 * Hand-written Protobuf encoder/decoder + Connect-RPC frame handling for the
 * Windsurf/Devin search endpoint.
 *
 * Ported from dsh-assistant-optimization `lib/fast-context/protocol.js`, which
 * is itself ported from fast-context-mcp `src/protobuf.mjs`
 * (MIT, Copyright (c) 2025 SammySnake-d).
 * Change: TypeScript only (blackhole builds with tsc and does not ship .js
 * sources); no logic changes.
 */
import { gzipSync, gunzipSync } from 'node:zlib';

/** Streaming wire type for length-delimited fields. */
const WIRE_LEN = 2;

export class ProtobufEncoder {
  private readonly chunks: Buffer[] = [];

  private varint(value: number): Buffer {
    const bytes: number[] = [];
    let v = value;
    while (v > 0x7f) {
      bytes.push((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    bytes.push(v & 0x7f);
    return Buffer.from(bytes);
  }

  private tag(field: number, wire: number): Buffer {
    return this.varint((field << 3) | wire);
  }

  writeVarint(field: number, value: number): this {
    this.chunks.push(this.tag(field, 0), this.varint(value));
    return this;
  }

  writeString(field: number, value: string): this {
    const data = Buffer.from(value, 'utf-8');
    this.chunks.push(this.tag(field, WIRE_LEN), this.varint(data.length), data);
    return this;
  }

  writeBytes(field: number, value: Buffer | Uint8Array): this {
    const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
    this.chunks.push(this.tag(field, WIRE_LEN), this.varint(buf.length), buf);
    return this;
  }

  writeMessage(field: number, sub: ProtobufEncoder): this {
    const data = sub.toBuffer();
    this.chunks.push(this.tag(field, WIRE_LEN), this.varint(data.length), data);
    return this;
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

/** Decode a varint at `offset`; returns [value, newOffset]. */
export function decodeVarint(buf: Buffer, offset: number): [number, number] {
  let value = 0;
  let shift = 0;
  let i = offset;
  while (i < buf.length) {
    const b = buf[i] as number;
    i += 1;
    value |= (b & 0x7f) << shift;
    shift += 7;
    if (!(b & 0x80)) break;
  }
  return [value, i];
}

/**
 * Extract every UTF-8 string (length > 5) out of raw protobuf bytes by walking
 * wire types. The response schema is not published, so the answer is recovered
 * structurally rather than by field number — same approach as the reference.
 */
export function extractStrings(data: Buffer): string[] {
  const strings: string[] = [];
  let i = 0;
  while (i < data.length) {
    let tag = 0;
    let shift = 0;
    while (i < data.length) {
      const b = data[i] as number;
      i += 1;
      tag |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    const wire = tag & 0x7;
    if (wire === 0) {
      while (i < data.length) {
        const b = data[i] as number;
        i += 1;
        if (!(b & 0x80)) break;
      }
    } else if (wire === 1) {
      i += 8;
    } else if (wire === WIRE_LEN) {
      let length = 0;
      shift = 0;
      while (i < data.length) {
        const b = data[i] as number;
        i += 1;
        length |= (b & 0x7f) << shift;
        shift += 7;
        if (!(b & 0x80)) break;
      }
      if (i + length <= data.length) {
        const text = data.subarray(i, i + length).toString('utf-8');
        if (text.length > 5) strings.push(text);
      }
      i += length;
    } else if (wire === 5) {
      i += 4;
    } else {
      // Unknown wire type: the rest of the buffer is unparseable.
      break;
    }
  }
  return strings;
}

/** Connect-RPC envelope: 1 flag byte + 4-byte BE length + payload. */
export function connectFrameEncode(protoBytes: Buffer, compress = true): Buffer {
  const payload = compress ? gzipSync(protoBytes) : protoBytes;
  const header = Buffer.alloc(5);
  header[0] = compress ? 1 : 0;
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

/** Split a streamed response back into decoded frames (flags 1/3 are gzip). */
export function connectFrameDecode(data: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  let i = 0;
  while (i + 5 <= data.length) {
    const flags = data[i] as number;
    const length = data.readUInt32BE(i + 1);
    i += 5;
    let payload = data.subarray(i, Math.min(i + length, data.length));
    i += length;
    if (flags === 1 || flags === 3) {
      try {
        payload = gunzipSync(payload);
      } catch {
        /* undecodable frame — pass the raw payload through */
      }
    }
    frames.push(Buffer.from(payload));
  }
  return frames;
}
