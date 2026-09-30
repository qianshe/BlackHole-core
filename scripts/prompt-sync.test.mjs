import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// The daemon renders the Courier first message with src/courier/prompt.ts; VS Code and the Web
// console copy prompts with packages/vscode/src/templates.ts. Both must stay the same code.
const strip = (s) => s.replace(/\r\n/g, '\n').replace(/^(\/\/.*\n)+/, '');
test('connector/sandbox templates: daemon copy and extension copy are identical', () => {
  const core = strip(fs.readFileSync(new URL('../src/courier/prompt.ts', import.meta.url), 'utf8'));
  const ext = strip(fs.readFileSync(new URL('../packages/vscode/src/templates.ts', import.meta.url), 'utf8'));
  assert.equal(core, ext);
});
