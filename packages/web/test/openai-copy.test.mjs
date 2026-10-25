import test from 'node:test';
import assert from 'node:assert/strict';
import { OPENAI_ERRORS, OPENAI_LINK_URLS, OPENAI_STATUS_LABELS, OPENAI_TUNNEL_ID } from '../src/panel/openaiCopy.ts';

// The VS Code settings page no longer keeps a twin table (its legacy panel was removed);
// the web copy is the single source and these are its invariants.
test('OpenAI error table stays complete and keeps the browser-local refusal', () => {
  assert.ok(Object.keys(OPENAI_ERRORS).length >= 15, 'table intact');
  // Web-only: the daemon refuses OpenAI actions from a browser on another machine.
  assert.ok(OPENAI_ERRORS.local_only);
  for (const text of Object.values(OPENAI_ERRORS)) assert.ok(text && text.length <= 120);
});

test('OpenAI tunnel id rule anchors to the id alone', () => {
  assert.ok(OPENAI_TUNNEL_ID.test('tunnel_' + 'a1'.repeat(16)));
  assert.ok(!OPENAI_TUNNEL_ID.test('https://platform.openai.com/tunnel_' + 'a1'.repeat(16)));
  assert.ok(Object.keys(OPENAI_STATUS_LABELS).length > 0 && Object.keys(OPENAI_LINK_URLS).length > 0);
});
