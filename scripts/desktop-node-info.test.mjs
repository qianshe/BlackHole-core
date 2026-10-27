import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inspectDesktopNode } from './desktop-node-info.mjs';

const license = 'Node.js is licensed for use as follows:\nPermission is hereby granted, free of charge, to any person obtaining a copy.\n';
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh node info-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'distribution', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const exe = path.join(bin, 'node.exe');
  fs.writeFileSync(exe, 'fixture executable');
  return { dir, bin, exe };
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
test('Node metadata preserves paths with spaces and hashes the exact bundled files', t => {
  const { bin, exe } = fixture(t);
  const lic = path.join(bin, 'LICENSE');
  fs.writeFileSync(lic, license);
  const info = JSON.parse(JSON.stringify(inspectDesktopNode(exe)));
  assert.equal(info.exe, fs.realpathSync(exe));
  assert.equal(info.lic, fs.realpathSync(lic));
  assert.equal(info.exeSha, hash(fs.readFileSync(exe)));
  assert.equal(info.licSha, hash(fs.readFileSync(lic)));
});
test('Node distribution license may be in the distribution root', t => {
  const { bin, exe } = fixture(t);
  const lic = path.join(bin, '..', 'LICENSE');
  fs.writeFileSync(lic, license);
  assert.equal(inspectDesktopNode(exe).lic, fs.realpathSync(lic));
});
test('Node license absence fails without falling back to a project LICENSE', t => {
  const { dir, exe } = fixture(t);
  fs.writeFileSync(path.join(dir, 'LICENSE'), 'Apache License\nVersion 2.0');
  assert.throws(() => inspectDesktopNode(exe), /desktop_node_license_missing/);
});
test('unrelated, empty and oversized licenses are rejected', t => {
  const { bin, exe } = fixture(t);
  for (const text of ['Apache License\nVersion 2.0', '', 'x'.repeat(4 * 1024 * 1024 + 1)]) {
    fs.writeFileSync(path.join(bin, 'LICENSE'), text);
    assert.throws(() => inspectDesktopNode(exe), /desktop_node_license_invalid/);
  }
});
