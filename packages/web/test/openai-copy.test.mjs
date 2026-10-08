import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { OPENAI_ERRORS, OPENAI_LINK_URLS, OPENAI_STATUS_LABELS, OPENAI_TUNNEL_ID } from '../src/panel/openaiCopy.ts';

// The VS Code settings page keeps its own copy (its tests load configPanel.ts standalone).
const panel = fs.readFileSync(new URL('../../vscode/src/configPanel.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const block = (start) => { const i = panel.indexOf(start); assert.ok(i >= 0, start); return panel.slice(i, panel.indexOf('\n};\n', i)); };

test('OpenAI error copy matches the VS Code settings page', () => {
  const pairs = [...block('const OPENAI_ERRORS').matchAll(/^\s+(\w+): '([^']*)',$/gm)].map((m) => [m[1], m[2]]);
  assert.ok(pairs.length >= 15, 'parsed the VS Code table');
  for (const [code, text] of pairs) assert.equal(OPENAI_ERRORS[code], text, code);
  // Web-only: the daemon refuses OpenAI actions from a browser on another machine.
  assert.ok(OPENAI_ERRORS.local_only);
});

test('OpenAI status labels, links and Tunnel ID rule match the VS Code settings page', () => {
  const labels = panel.match(/const oaLabels = (\{[^\n]*\});/);
  assert.ok(labels, 'oaLabels found');
  assert.deepEqual(OPENAI_STATUS_LABELS, Function(`return ${labels[1]}`)());
  for (const [name, url] of Object.entries(OPENAI_LINK_URLS)) assert.ok(panel.includes(`['${name}', '${url}']`), name);
  assert.ok(panel.includes(`const OPENAI_TUNNEL_ID = ${OPENAI_TUNNEL_ID.source.replace(/^/, '/')}/;`));
  assert.ok(OPENAI_TUNNEL_ID.test('tunnel_' + 'a1'.repeat(16)));
  assert.ok(!OPENAI_TUNNEL_ID.test('https://platform.openai.com/tunnel_' + 'a1'.repeat(16)));
});
