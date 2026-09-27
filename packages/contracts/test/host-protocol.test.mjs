import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HOST_PROTOCOL_VERSION,
  LAUNCH_RESULT_MAX_BYTES,
  LaunchResultSchema,
  ReadyReceiptSchema,
} from '../dist/index.js';

const receipt = {
  protocolVersion: HOST_PROTOCOL_VERSION,
  instanceKey: 'user+production+sha256:abc',
  daemonId: 'daemon-1',
  daemonVersion: '0.3.172',
  runtimeKind: 'standalone-node',
  uiVersion: '0.3.172',
  configRevision: 0,
  localUrl: 'http://127.0.0.1:7306/ui/',
  webApiBase: '../web-api/v1/',
  capabilities: ['web-ui', 'process'],
};

test('a well-formed ready receipt parses', () => {
  assert.deepEqual(ReadyReceiptSchema.parse(receipt), receipt);
});

test('extra fields are rejected so secrets cannot ride along', () => {
  assert.equal(ReadyReceiptSchema.safeParse({ ...receipt, controlSecret: 'x' }).success, false);
  assert.equal(ReadyReceiptSchema.safeParse({ ...receipt, mcpUrl: 'https://t/mcp/token' }).success, false);
});

test('localUrl must be loopback', () => {
  for (const localUrl of ['https://example.trycloudflare.com/ui/', 'http://192.168.1.2:7306/ui/', 'file:///C:/ui/index.html']) {
    assert.equal(ReadyReceiptSchema.safeParse({ ...receipt, localUrl }).success, false, localUrl);
  }
  for (const localUrl of ['http://localhost:7306/ui/', 'http://[::1]:7306/ui/']) {
    assert.equal(ReadyReceiptSchema.safeParse({ ...receipt, localUrl }).success, true, localUrl);
  }
});

test('webApiBase must stay relative to the UI base', () => {
  for (const webApiBase of ['http://127.0.0.1:7306/web-api/v1/', '//evil.example/web-api/', 'javascript:alert(1)']) {
    assert.equal(ReadyReceiptSchema.safeParse({ ...receipt, webApiBase }).success, false, webApiBase);
  }
});

test('unknown capabilities and runtime kinds are rejected', () => {
  assert.equal(ReadyReceiptSchema.safeParse({ ...receipt, capabilities: ['shell'] }).success, false);
  assert.equal(ReadyReceiptSchema.safeParse({ ...receipt, runtimeKind: 'bun' }).success, false);
});

test('launch results: success, failure with diagnostics, browser fallback keeps the receipt', () => {
  assert.equal(LaunchResultSchema.safeParse({ ok: true, receipt, browserOpened: true }).success, true);
  assert.equal(LaunchResultSchema.safeParse({ ok: false, code: 'ready_timeout', message: 'not ready in 30s', logPath: 'C:/logs/daemon.log' }).success, true);
  assert.equal(LaunchResultSchema.safeParse({ ok: false, code: 'browser_unavailable', message: 'no browser', receipt }).success, true);
  assert.equal(LaunchResultSchema.safeParse({ ok: false, code: 'crashed', message: 'x' }).success, false);
  assert.equal(LaunchResultSchema.safeParse({ ok: false, code: 'ready_timeout', message: '' }).success, false);
  assert.ok(LAUNCH_RESULT_MAX_BYTES >= JSON.stringify({ ok: true, receipt, browserOpened: true }).length);
});

test('contracts source imports nothing but zod and siblings', () => {
  const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
  for (const file of fs.readdirSync(srcDir).filter((name) => name.endsWith('.ts'))) {
    const text = fs.readFileSync(path.join(srcDir, file), 'utf8');
    for (const match of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const specifier = match[1];
      assert.ok(specifier === 'zod' || specifier.startsWith('./'), `${file} imports ${specifier}`);
    }
  }
});

test('loopback check cannot be fooled by userinfo or lookalike hosts', () => {
  for (const localUrl of ['http://127.0.0.1@evil.example/ui/', 'http://localhost.evil.example/ui/', 'http://127.0.0.1.evil.example/', 'http://[::1].evil/']) {
    assert.equal(ReadyReceiptSchema.safeParse({ ...receipt, localUrl }).success, false, localUrl);
  }
});
