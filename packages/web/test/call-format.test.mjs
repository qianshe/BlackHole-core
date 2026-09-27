import test from 'node:test';
import assert from 'node:assert/strict';
import { callHeadline, resultBody, resultDiff } from '../src/format.ts';

test('resultDiff reads the editor diff payload and ignores everything else', () => {
  assert.deepEqual(resultDiff(JSON.stringify({ result: { message: 'ok', diff: { added: 12, removed: 3 } } })), { added: 12, removed: 3 });
  assert.equal(resultDiff(JSON.stringify({ result: { diff: { added: 0, removed: 0 } } })), null);
  assert.equal(resultDiff(JSON.stringify({ stdout: 'x' })), null);
  assert.equal(resultDiff('not json'), null);
  assert.equal(resultDiff(null), null);
});

test('resultBody shows the message, stdout/stderr, or a truncation note instead of raw JSON', () => {
  assert.equal(resultBody(JSON.stringify({ result: { message: 'Created file' } })), 'Created file');
  assert.equal(resultBody(JSON.stringify({ stdout: 'a\n', stderr: 'b' })), 'a\n\n[stderr]\nb');
  assert.equal(resultBody(JSON.stringify({ stdout: '', stderr: '' })), '(无输出)');
  assert.match(resultBody(JSON.stringify({ truncated: true, preview: 'head' })), /^head\n\n…… 结果已截断/);
  assert.equal(resultBody(JSON.stringify({ status: 'running', processId: 'p1' })), 'running · p1');
  assert.equal(resultBody('plain \u001b[31mred\u001b[0m'), 'plain red');
});

test('callHeadline groups the tool with its sub-command and keeps shell commands whole', () => {
  assert.deepEqual(callHeadline('editor', { path: 'a.ts', operation: { command: 'create' } }, 'create a.ts'), { label: 'editor create', target: 'a.ts' });
  assert.deepEqual(callHeadline('proxy', { command: 'call', tool: 'click' }, '调用 click · uid=1'), { label: 'proxy call', target: 'click · uid=1' });
  assert.deepEqual(callHeadline('process', { command: 'start', script: 'npm run dev' }, '启动 · npm run dev'), { label: 'process start', target: '启动 · npm run dev' });
  assert.deepEqual(callHeadline('exec', { command: 'git status' }, 'git status'), { label: 'exec', target: 'git status' });
  assert.deepEqual(callHeadline('show', {}, '打开实时进度面板'), { label: 'show', target: '打开实时进度面板' });
});
