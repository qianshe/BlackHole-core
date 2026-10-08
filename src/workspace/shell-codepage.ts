import { createRequire } from 'node:module';

/**
 * Text transport for the persistent Windows PowerShell.
 *
 * `pwsh -Command -` reads stdin and writes stdout in the console code page it
 * inherits (GBK/936 on a Chinese system, 437/1252 on others, 65001 only when
 * something set it). That code page depends on how the daemon was launched
 * and on the PowerShell version, and the ACL sandbox runs in
 * ConstrainedLanguage, where `[Console]::OutputEncoding = ...` is rejected.
 * So the shell is never switched: the daemon detects the code page the shell
 * actually uses and speaks it. Nothing global is changed (no chcp), so child
 * programs keep their normal console behaviour.
 */

/** Characters whose bytes differ across the common code pages (UTF-8, GBK, Big5, Shift-JIS, 125x, 437/850/866). */
export const PROBE_TEXT = '\u00e9\u4e2d\u00d8\u0436\u3042';
export const UTF8 = 65001;

type Kernel = {
  getACP(): number;
  getOEMCP(): number;
  getConsoleOutputCP(): number;
  mbToWide(cp: number, flags: number, src: Buffer, srcLen: number, dst: Buffer | null, dstLen: number): number;
  wideToMb(cp: number, flags: number, src: Buffer, srcLen: number, dst: Buffer | null, dstLen: number, def: null, usedDef: null): number;
  isLead(cp: number, byte: number): number;
};
let kernel: Kernel | null | undefined;
function k(): Kernel | null {
  if (kernel !== undefined) return kernel;
  if (process.platform !== 'win32') return (kernel = null);
  try {
    // Do not load a Windows native dependency when the same bundle runs on POSIX.
    const require = createRequire(typeof __filename === 'string' ? __filename : import.meta.url);
    const koffi = require('koffi') as typeof import('koffi');
    const lib = koffi.load('kernel32.dll');
    kernel = {
      getACP: lib.func('__stdcall', 'GetACP', 'uint32', []),
      getOEMCP: lib.func('__stdcall', 'GetOEMCP', 'uint32', []),
      getConsoleOutputCP: lib.func('__stdcall', 'GetConsoleOutputCP', 'uint32', []),
      mbToWide: lib.func('__stdcall', 'MultiByteToWideChar', 'int', ['uint32', 'uint32', 'void *', 'int', 'void *', 'int']),
      wideToMb: lib.func('__stdcall', 'WideCharToMultiByte', 'int', ['uint32', 'uint32', 'void *', 'int', 'void *', 'int', 'void *', 'void *']),
      isLead: lib.func('__stdcall', 'IsDBCSLeadByteEx', 'int', ['uint32', 'uint8']),
    };
  } catch {
    kernel = null;
  }
  return kernel;
}

/** Encode text in a Windows code page; unmappable characters become '?', as PowerShell writes them. */
export function encodeCodePage(cp: number, text: string): Buffer {
  if (cp === UTF8 || !text) return Buffer.from(text, 'utf8');
  const api = k();
  if (!api) return Buffer.from(text, 'utf8');
  const src = Buffer.from(text, 'utf16le');
  const n = api.wideToMb(cp, 0, src, src.length / 2, null, 0, null, null);
  if (n <= 0) return Buffer.from(text, 'utf8');
  const dst = Buffer.alloc(n);
  api.wideToMb(cp, 0, src, src.length / 2, dst, n, null, null);
  return dst;
}

function decodeWhole(cp: number, bytes: Buffer): string {
  if (!bytes.length) return '';
  const api = k();
  if (cp === UTF8 || !api) return bytes.toString('utf8');
  const n = api.mbToWide(cp, 0, bytes, bytes.length, null, 0);
  if (n <= 0) return bytes.toString('latin1');
  const dst = Buffer.alloc(n * 2);
  api.mbToWide(cp, 0, bytes, bytes.length, dst, n);
  return dst.toString('utf16le');
}

/**
 * Encode an already-authorized PowerShell payload without changing any character.
 * Probe samples intentionally use encodeCodePage's native replacement behaviour;
 * executable input must not. On a lossy conversion, reconstruct the original
 * string from ASCII in the SAME shell/scope and language mode. No new process,
 * temporary script, execution-policy override or global code-page change.
 */
export function encodeShellInput(cp: number, text: string): Buffer {
  const encoded = encodeCodePage(cp, text);
  if (decodeWhole(cp, encoded) === text) return encoded;
  return Buffer.from(`Microsoft.PowerShell.Utility\\Invoke-Expression -Command ${psAsciiString(text)}\n`, 'ascii');
}

/** Streaming decoder: a multi-byte character split across pipe reads is never garbled. */
export function streamDecoder(cp: number): (chunk: Buffer) => string {
  if (cp === UTF8 || !k()) {
    const d = new TextDecoder('utf-8');
    return (chunk) => d.decode(chunk, { stream: true });
  }
  // GB18030 has 4-byte sequences that the lead-byte rule below does not cover.
  if (cp === 54936) {
    const d = new TextDecoder('gb18030');
    return (chunk) => d.decode(chunk, { stream: true });
  }
  const api = k()!;
  let carry: Buffer = Buffer.alloc(0);
  return (chunk) => {
    let bytes = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    carry = Buffer.alloc(0);
    // hold back a trailing lead byte until its trail byte arrives
    let i = 0, lastStart = bytes.length;
    while (i < bytes.length) {
      if (api.isLead(cp, bytes[i]!)) {
        if (i + 1 >= bytes.length) { lastStart = i; break; }
        i += 2;
      } else i += 1;
    }
    if (lastStart < bytes.length) {
      carry = Buffer.from(bytes.subarray(lastStart));
      bytes = bytes.subarray(0, lastStart);
    }
    return decodeWhole(cp, bytes);
  };
}

/** Code pages worth trying, most specific first. */
export function candidateCodePages(): number[] {
  const api = k();
  if (!api) return [UTF8];
  const list = [UTF8];
  for (const f of [() => api.getConsoleOutputCP(), () => api.getOEMCP(), () => api.getACP()]) {
    try { const cp = f(); if (cp && !list.includes(cp)) list.push(cp); } catch { /* keep the rest */ }
  }
  return list;
}

/** Which code page produced these probe bytes (the shell's rendering of PROBE_TEXT)? */
export function detectCodePage(received: Buffer, candidates = candidateCodePages()): number | null {
  const got = Buffer.from(received.toString('latin1').replace(/[\r\n]+$/, ''), 'latin1');
  for (const cp of candidates) if (encodeCodePage(cp, PROBE_TEXT).equals(got)) return cp;
  return null;
}

/**
 * A PowerShell double-quoted string literal made only of ASCII: non-ASCII
 * characters become `$([char]0x....)` (allowed in ConstrainedLanguage), so the
 * line survives any stdin code page.
 */
export function psAsciiString(value: string): string {
  let out = '"';
  for (const ch of value) {
    const c = ch.codePointAt(0)!;
    if (ch === '"' || ch === '`' || ch === '$') out += '`' + ch;
    else if (c < 0x20 || c > 0x7e) {
      if (c > 0xffff) {
        const hi = 0xd800 + ((c - 0x10000) >> 10), lo = 0xdc00 + ((c - 0x10000) & 0x3ff);
        out += `$([char]0x${hi.toString(16)})$([char]0x${lo.toString(16)})`;
      } else out += `$([char]0x${c.toString(16)})`;
    } else out += ch;
  }
  return out + '"';
}
