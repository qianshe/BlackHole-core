import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const source = fs.readFileSync(new URL('../src/console/Sidebar.tsx', import.meta.url), 'utf8')
  + '\nexport { SessionItem as TestSessionItem, rowState as TestRowState };\n';
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const module = { exports: {} };
const styles = new Proxy({}, { get: (_target, key) => String(key) });
const mocks = {
  '../../../contracts/src/account-summary': {},
  './ChannelSwitch': {},
  '../format': { sessionTitle: x => x.name, SESSION_STATUS_LABEL: { paused: '已暂停' } },
  '../ui': { Icon: () => null },
  './common': { useMenu: () => ({ open: false, close() {}, toggle() {}, onKeyDown() {}, wrapRef: null }) },
  './courierFeed': {},
  './sessionActions': {},
  './console.module.css': { default: styles },
};
vm.runInNewContext(js, { module, exports: module.exports,
  require: name => Object.hasOwn(mocks, name) ? mocks[name] : require(name), console, window: { innerHeight: 900 } });
const { TestSessionItem, TestRowState } = module.exports;

const session = { id: 'session-a', name: '细节调整', status: 'active', activity: 'idle',
  todos_total: 0, todos_done: 0, pending_handoff: { id: 'handoff-a', created_at: null } };
const web = { busy: new Set(), asking: new Set() };
const render = (x, flags = web, pending = 0) => renderToStaticMarkup(createElement(TestSessionItem, {
  x, current: false, pending, web: flags, onSelect() {}, actions: {},
}));

test('Web Handoff stays right-aligned after live status instead of competing with it', () => {
  assert.equal(TestRowState(session, 0, web), null, 'idle Handoff should not replace the status');
  for (const [x, flags, pending, state] of [
    [session, web, 0, null],
    [session, { ...web, busy: new Set([session.id]) }, 0, '生成中'],
    [session, web, 2, '2 待审批'],
    [{ ...session, status: 'paused' }, web, 0, '已暂停'],
  ]) {
    const html = render(x, flags, pending);
    assert.match(html, /class="rowHandoff"[^>]*>Handoff<\/span><\/button>/, 'Handoff must be the final trailing marker');
    assert.equal((html.match(/>Handoff<\/span>/g) || []).length, 1);
    if (state) {
      assert.ok(html.includes(state), 'status must remain visible beside Handoff: ' + state);
      assert.ok(html.indexOf(state) < html.indexOf('>Handoff</span>'), 'live status must precede trailing Handoff');
    }
    else assert.doesNotMatch(html, /class="rowMeta(?:Warn|Run)?"/);
    assert.ok(html.indexOf('细节调整') < html.indexOf('Handoff'), 'title comes before Handoff');
    assert.equal((html.match(/<button/g) || []).length, 2, 'no nested Handoff button');
  }
});

test('Web row reserves the right edge for Handoff while the title truncates', () => {
  const css = fs.readFileSync(new URL('../src/console/console.module.css', import.meta.url), 'utf8');
  assert.match(css, /\.rowTitle\s*\{[^}]*flex:\s*1/);
  assert.match(css, /\.rowTitle\s*\{[^}]*min-width:\s*0/);
  assert.match(css, /\.rowHandoff\s*\{[^}]*flex:\s*none/);
  assert.match(css, /\.rowHandoff\s*\{[^}]*margin-left:\s*auto/);
});


test('Web detail isolates Handoff preview by session and pending revision', () => {
  const pane = fs.readFileSync(new URL('../src/console/SessionPane.tsx', import.meta.url), 'utf8');
  assert.ok(pane.includes("<HandoffBar key={`${session.id}:${session.pending_handoff?.id ?? ''}`}"),
    'a session switch or replaced Handoff must remount its preview state');
});
