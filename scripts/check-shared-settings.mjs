import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export function checkSharedSettings(dir = path.join(root, 'packages/vscode/dist/settings')) {
  const source = fs.readFileSync(path.join(dir, 'settings.js'), 'utf8');
  const css = fs.readFileSync(path.join(dir, 'settings.css'), 'utf8');
  assert.ok(source.length > 1000 && css.length > 1000, 'shared renderer and styles must ship together');
  new vm.Script(source, { filename: 'shared-settings.js' });
  for (const marker of ['settings:ready', 'settings:request', 'settings:reply', 'settings:init', 'directAccessToggle', 'directAccessUrl', 'directPort', 'phonePair']) assert.ok(source.includes(marker), marker);
  for (const marker of ['settings-shell', 'pair-dialog', 'settings-page-save']) assert.ok(css.includes(marker), marker);
  assert.match(css, /button\[role=(?:['"])?switch/, 'the shared renderer must ship its one semantic switch skin');
  assert.doesNotMatch(css, /\.bhp \.direct-switch\s*\{/, 'the superseded 40x24 direct switch must not ship');
  assert.doesNotMatch(source, /BH-MOCK-|production-web\.html|production-vscode\.html/);
  const messages = [], listeners = new Map();
  const context = {
    console, URL, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval, DOMException, TextEncoder, TextDecoder, crypto: webcrypto,
    acquireVsCodeApi: () => ({ postMessage: value => messages.push(value), getState: () => ({}), setState() {} }),
    window: { addEventListener: (name, fn) => { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); } },
    document: { addEventListener() {} }, navigator: { userAgent: 'settings-build-check' },
  };
  vm.runInNewContext(source, context, { timeout: 5000 });
  assert.equal(messages.length, 1, 'loading shared UI must only handshake, not write or fetch');
  assert.equal(messages[0].type, 'settings:ready');
  assert.match(messages[0].clientId, /^[a-f0-9]{32}$/, 'each browser document needs a fresh request namespace');
  assert.ok(listeners.has('message') && listeners.has('pagehide'));
  console.log('PASS: shared settings assets, syntax and read-only ready handshake');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) checkSharedSettings(process.argv[2]);
