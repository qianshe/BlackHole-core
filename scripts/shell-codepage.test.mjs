import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectCodePage, encodeCodePage, PROBE_TEXT, psAsciiString, streamDecoder, UTF8 } from '../dist/workspace/shell-codepage.js';

const win = process.platform === 'win32';

test('the probe identifies the code page a shell writes in', { skip: !win }, () => {
  const all = [UTF8, 936, 950, 932, 949, 1252, 437, 866];
  for (const cp of all) assert.equal(detectCodePage(encodeCodePage(cp, PROBE_TEXT), all), cp, `cp ${cp}`);
  assert.equal(detectCodePage(Buffer.from('garbage'), all), null);
});

test('a GBK character split across pipe reads is decoded whole', { skip: !win }, () => {
  const bytes = encodeCodePage(936, 'D:\\CSDN_\\Python\u5b66\u4e60\\min_swapi\r\n');
  for (let cut = 1; cut < bytes.length; cut++) {
    const d = streamDecoder(936);
    assert.equal(d(bytes.subarray(0, cut)) + d(bytes.subarray(cut)), 'D:\\CSDN_\\Python\u5b66\u4e60\\min_swapi\r\n', `cut ${cut}`);
  }
});

test('UTF-8 split across reads is decoded whole (also off Windows)', () => {
  const bytes = Buffer.from('\u5b66\u4e60\u{1F600}', 'utf8');
  const d = streamDecoder(UTF8);
  assert.equal([...bytes].map((b) => d(Buffer.from([b]))).join(''), '\u5b66\u4e60\u{1F600}');
});

test('psAsciiString yields an ASCII-only PowerShell literal', () => {
  const lit = psAsciiString('C:\\Users\\\u5f20\u4e09\\a"$b`\u{1F600}');
  assert.match(lit, /^[\x20-\x7e]+$/);
  assert.equal(lit, '"C:\\Users\\$([char]0x5f20)$([char]0x4e09)\\a`"`$b``$([char]0xd83d)$([char]0xde00)"');
});
