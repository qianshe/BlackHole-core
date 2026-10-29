// Verify actual browser geometry of the Web console Handoff row, using synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const webRequire = createRequire(new URL('../packages/web/package.json', import.meta.url));
const ts = require('typescript');
const chrome = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  chromium.executablePath(),
].find(p => fs.existsSync(p));

function fixtureHtml() {
  const source = fs.readFileSync(new URL('../packages/web/src/console/Sidebar.tsx', import.meta.url), 'utf8')
    + '\nexport { SessionItem as TestSessionItem };';
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const module = { exports: {} };
  const styles = new Proxy({}, { get: (_target, key) => String(key) });
  const mocks = {
    '../../../contracts/src/account-summary': {}, './ChannelSwitch': {},
    '../format': { sessionTitle: x => x.name, SESSION_STATUS_LABEL: { paused: '已暂停' } },
    '../ui': { Icon: () => null },
    './common': { useMenu: () => ({ open: false, close() {}, toggle() {}, onKeyDown() {}, wrapRef: null }) },
    './courierFeed': {}, './sessionActions': {}, './console.module.css': { default: styles },
  };
  vm.runInNewContext(js, { module, exports: module.exports, console,
    require: name => Object.hasOwn(mocks, name) ? mocks[name] : name.startsWith('react') ? webRequire(name) : require(name),
    window: { innerHeight: 900 } });
  const React = webRequire('react'), { renderToStaticMarkup } = webRequire('react-dom/server');
  const session = { id: 'handoff', name: '细节调整（很长的会话名称）', status: 'active',
    activity: 'idle', todos_total: 0, todos_done: 0, pending_handoff: { id: 'h-1' } };
  const web = { busy: new Set([session.id]), asking: new Set() };
  const html = renderToStaticMarkup(React.createElement(module.exports.TestSessionItem, {
    x: session, current: true, pending: 0, web, onSelect() {}, actions: {},
  }));
  const css = fs.readFileSync(new URL('../packages/web/src/console/console.module.css', import.meta.url), 'utf8');
  return '<!doctype html><html><head><style>'
    + ':root{--border:#303030;--sidebar:#181818;--text-2:#bdbdbd;--text-3:#989898;'
    + '--sel:#292929;--text-bright:#f0f0f0;--run:#81b9ee;--surface-hover:#333;}'
    + 'html,body{margin:0;padding:0;font:13px system-ui;}*{box-sizing:border-box;}'
    + css + '</style></head><body><aside class="sidebar" style="width:284px;height:100vh">'
    + '<ul class="projectSessions" style="margin:0;padding:0;">' + html + '</ul></aside></body></html>';
}

test('Web Handoff anchors right of the running status at sidebar width', { timeout: 60_000 }, async t => {
  if (!chrome) return t.skip('No locally installed Chrome/Chromium; browser check unavailable');
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 700 } });
    await page.setContent(fixtureHtml());
    const g = await page.evaluate(() => {
      const rect = el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width }; };
      const title = document.querySelector('.rowLabel');
      const pill = document.querySelector('.rowHandoff');
      const status = document.querySelector('.rowMetaRun');
      const button = document.querySelector('.sessionRow');
      return { title: rect(title), pill: rect(pill), status: rect(status), button: rect(button),
        statusText: status.textContent, insideButton: pill.closest('button') === button,
        pillDisplay: getComputedStyle(pill).display };
    });
    assert.equal(g.statusText, '生成中');
    assert.ok(g.title.width > 0 && g.status.left >= g.title.right,
      'running status must follow the title: ' + JSON.stringify(g));
    assert.ok(g.pill.left >= g.status.right && Math.abs(g.pill.right - (g.button.right - 34)) < 2,
      'Handoff must be the rightmost marker, before the menu slot: ' + JSON.stringify(g));
    // Inline-flex is blockified to flex when used as a flex item.
    assert.ok(g.insideButton && ['inline-flex', 'flex'].includes(g.pillDisplay), JSON.stringify(g));
    await page.close();
  } finally { await browser.close(); }
});


function handoffDetailFixture(showDialog = false) {
  const React = webRequire('react');
  const { renderToStaticMarkup } = webRequire('react-dom/server');
  const file = new URL('../packages/web/src/console/HandoffBar.tsx', import.meta.url);
  const source = fs.readFileSync(file, 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const c = new Proxy({}, { get: (_target, key) => String(key) });
  const h = new Proxy({}, { get: (_target, key) => 'bh-' + String(key) });
  let stateIndex = 0;
  const fakeReact = { ...React, useState: initial => {
    stateIndex += 1;
    return [stateIndex === 2 && showDialog ? { text: '合成 Handoff 上下文', error: null } : initial, () => {}];
  } };
  const mocks = {
    react: fakeReact,
    '../api': { api: {} },
    '../../../vscode/src/handoffCopy': {},
    '../format': { relativeTime: () => '刚刚' },
    '../ui': { Icon: () => null },
    './common': {
      useToast: () => () => {},
      copyText: async () => true,
      failText: e => String(e),
      DialogHead: ({ title }) => React.createElement('h2', null, title),
      Modal: ({ children, className }) => React.createElement('dialog',
        { open: true, className: 'overlay' }, React.createElement('div', { className }, children)),
    },
    './console.module.css': { default: c },
    './Handoff.module.css': { default: h },
  };
  const module = { exports: {} };
  vm.runInNewContext(js, { module, exports: module.exports, console,
    require: name => Object.hasOwn(mocks, name) ? mocks[name] : name.startsWith('react') ? webRequire(name) : require(name) });
  const session = { id: 'synthetic-session', status: 'active',
    pending_handoff: { id: 'synthetic-handoff', created_at: null } };
  const inner = renderToStaticMarkup(React.createElement(module.exports.HandoffBar, {
    session, connectorName: 'BlackHole', now: 0,
  }));
  const globalCss = fs.readFileSync(new URL('../packages/web/src/global.css', import.meta.url), 'utf8');
  const cCss = fs.readFileSync(new URL('../packages/web/src/console/console.module.css', import.meta.url), 'utf8');
  const hCss = fs.readFileSync(new URL('../packages/web/src/console/Handoff.module.css', import.meta.url), 'utf8')
    .replace(/\.([A-Za-z][\w-]*)/g, '.bh-$1');
  return '<!doctype html><html lang="zh"><head><meta charset="utf-8"><style>'
    + globalCss + '\n' + cCss + '\n' + hCss
    + '</style></head><body style="margin:0">'
    + '<div style="width:100vw;display:grid;grid-template-columns:'
    + 'min(284px,22vw) minmax(0,1fr);height:100vh">'
    + '<aside></aside><main style="min-width:0;"><header class="sessionHead">'
    + inner + '</header></main></div></body></html>';
}

test('Web Handoff detail keeps both copy actions visible and inside the header on narrow screens', { timeout: 90_000 }, async t => {
  if (!chrome) return t.skip('No browser available');
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  try {
    const page = await browser.newPage();
    for (const width of [1280, 760, 390, 320, 280]) {
      await page.setViewportSize({ width, height: 700 });
      await page.setContent(handoffDetailFixture(), { waitUntil: 'load' });
      const g = await page.evaluate(() => {
        const rect = el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width }; };
        const bar = document.querySelector('.bh-bar');
        const actions = document.querySelector('.bh-actions');
        return { bar: rect(bar), actions: rect(actions),
          buttons: [...actions.querySelectorAll('button')].map(el => ({ text: el.textContent, ...rect(el) })),
          scrollWidth: document.documentElement.scrollWidth, innerWidth };
      });
      assert.deepEqual(g.buttons.map(b => b.text), ['查看', '复制 · 连接器', '复制 · 沙箱直连']);
      assert.ok(g.buttons.every(b => b.left >= g.bar.left && b.right <= g.bar.right),
        'detail actions must stay inside Handoff bar at ' + width + ': ' + JSON.stringify(g));
      assert.ok(g.scrollWidth <= g.innerWidth,
        'detail bar must not cause page overflow at ' + width + ': ' + JSON.stringify(g));
    }
    await page.setViewportSize({ width: 320, height: 700 });
    await page.setContent(handoffDetailFixture(true));
    const modal = await page.evaluate(() => ({
      labels: [...document.querySelectorAll('.bh-dialogActions button')].map(el => el.textContent),
      container: document.querySelector('.bh-dialog').getBoundingClientRect().width,
      actionsWidth: document.querySelector('.bh-dialogActions').getBoundingClientRect().width,
      buttons: [...document.querySelectorAll('.bh-dialogActions button')].map(el => {
        const r = el.getBoundingClientRect(); return { left: r.left, right: r.right };
      }),
    }));
    assert.deepEqual(modal.labels, ['复制 · 连接器', '复制 · 沙箱直连']);
    assert.ok(modal.buttons.every(b => b.right <= 320 && b.left >= 0),
      'detail modal copy actions must fit the phone viewport: ' + JSON.stringify(modal));
    await page.close();
  } finally { await browser.close(); }
});
