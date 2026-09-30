import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../../vscode/src/markdown.ts';

test('escapes HTML and only links http(s)/mailto', () => {
  assert.equal(renderMarkdown('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  assert.equal(renderMarkdown('[x](javascript:evil)'), '<p>x</p>');
  assert.match(renderMarkdown('[doc](https://a.b/c?d=1&e=2)'), /<a href="https:\/\/a\.b\/c\?d=1&amp;e=2" target="_blank" rel="noopener noreferrer">doc<\/a>/);
  assert.match(renderMarkdown('see https://x.io/a.'), /<a href="https:\/\/x\.io\/a"[^>]*>https:\/\/x\.io\/a<\/a>\./);
  assert.doesNotMatch(renderMarkdown('[a"onmouseover="x](https://a.b/"x)'), /onmouseover="/);
});

test('blocks: headings, lists, code, tables, quotes', () => {
  assert.equal(renderMarkdown('# 标题\n正文 **粗** 和 `a*b*`'), '<h1>标题</h1><p>正文 <strong>粗</strong> 和 <code>a*b*</code></p>');
  assert.equal(renderMarkdown('- a\n- b\n  - c\n1. x'), '<ul><li>a</li><li>b<ul><li>c</li></ul></li></ul><ol><li>x</li></ol>');
  assert.equal(renderMarkdown('```ts\nconst a = 1 < 2;\n```'), '<div class="md-code"><button type="button" class="md-copy" title="复制代码" aria-label="复制代码"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/></svg></button><pre data-lang="ts"><code>const a = 1 &lt; 2;</code></pre></div>');
  assert.equal(renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |'), '<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>');
  assert.equal(renderMarkdown('> 引用 <b>'), '<blockquote><p>引用 &lt;b&gt;</p></blockquote>');
});

test('an unclosed fence (still streaming) runs to the end', () => {
  assert.equal(renderMarkdown('看:\n```\nline1\nline2'), '<p>看:</p><div class="md-code"><button type="button" class="md-copy" title="复制代码" aria-label="复制代码"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/></svg></button><pre><code>line1\nline2</code></pre></div>');
});
