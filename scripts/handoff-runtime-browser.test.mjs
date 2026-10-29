// Browser-level Web Handoff lifecycle check, using a synthetic Vite fixture and no real daemon.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const webRoot = path.join(root, 'packages/web');
const webRequire = createRequire(path.join(webRoot, 'package.json'));
const chrome = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  chromium.executablePath(),
].find(p => fs.existsSync(p));

test('Web Handoff details retain two copy actions and discard an old preview on session or Handoff switch', { timeout: 180_000 }, async t => {
  if (!chrome) return t.skip('Chrome/Chromium not installed');
  const { build } = await import(pathToFileURL(webRequire.resolve('vite')).href);
  const { default: react } = await import(pathToFileURL(webRequire.resolve('@vitejs/plugin-react')).href);
  const dir = path.join(root, '.tmp');
  fs.mkdirSync(dir, { recursive: true });
  const out = fs.mkdtempSync(path.join(dir, 'handoff-browser-'));
  let browser;
  try {
    await build({
      configFile: false, root: webRoot, base: './', plugins: [react()], logLevel: 'error',
      build: { outDir: out, emptyOutDir: false, sourcemap: false,
        rollupOptions: { input: path.join(webRoot, 'test/fixtures/handoff-runtime.html') } },
    });
    // Vite can retain the source directory structure for a non-root HTML entry.
    const entry = fs.readdirSync(out, { recursive: true }).map(String)
      .find(name => name.endsWith('handoff-runtime.html'));
    assert.ok(entry, 'the fixture HTML must be emitted by Vite');
    browser = await chromium.launch({ executablePath: chrome, headless: true });
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', async route => {
      const u = new URL(route.request().url());
      if (u.hostname !== 'handoff.fixture.test') return route.abort();
      const name = decodeURIComponent(u.pathname.slice(1) || 'handoff-runtime.html');
      const file = path.resolve(out, name);
      if (!file.startsWith(out + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: 'Not Found' });
      return route.fulfill({ body: fs.readFileSync(file),
        contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html' });
    });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true, value: { writeText: async text => { window.copied = text; } },
      });
    });
    await page.goto('https://handoff.fixture.test/' + entry.replaceAll('\\', '/'));
    try { await page.locator('[data-current]').waitFor({ timeout: 8000 }); }
    catch (e) { throw Error('Browser fixture did not mount: ' + JSON.stringify({ errors, html: (await page.content()).slice(0, 450) }), { cause: e }); }
    const region = page.getByRole('region', { name: 'Handoff' });
    const labels = ['查看', '复制 · 连接器', '复制 · 沙箱直连'];
    for (const label of labels) assert.equal(await region.getByRole('button', { name: label }).count(), 1, label);

    await region.getByRole('button', { name: '查看' }).click();
    const dialog = page.locator('dialog[open][aria-label="Handoff"]');
    await dialog.getByText('合成内容 session-a handoff-a').waitFor();
    for (const label of labels.slice(1)) assert.equal(await dialog.getByRole('button', { name: label }).count(), 1);

    await page.evaluate(() => window.setCase(1));
    await page.getByText('session-b:handoff-b', { exact: true }).waitFor();
    assert.equal(await dialog.count(), 0, 'old session preview must close on navigation');
    await region.getByRole('button', { name: '查看' }).click();
    await dialog.getByText('合成内容 session-b handoff-b').waitFor();

    await page.evaluate(() => window.setCase(2));
    await page.getByText('session-b:handoff-b2', { exact: true }).waitFor();
    assert.equal(await dialog.count(), 0, 'replaced Handoff must close the old preview');
    await region.getByRole('button', { name: '查看' }).click();
    await dialog.getByText('合成内容 session-b handoff-b2').waitFor();
    await dialog.getByRole('button', { name: '关闭' }).click();

    await region.getByRole('button', { name: '复制 · 连接器' }).click();
    await page.waitForFunction(() => window.copied?.includes('Handoff context:\n合成内容 session-b handoff-b2'));
    assert.match(await page.evaluate(() => window.copied), /^@BlackHole/m, 'connector must use existing Handoff prompt');
    await region.getByRole('button', { name: '复制 · 沙箱直连' }).click();
    await page.waitForFunction(() => window.copied?.includes('BlackHole MCP Manual:'));
    assert.ok((await page.evaluate(() => window.copied)).includes('Handoff context:'), 'sandbox must include context');

    await page.evaluate(() => window.setCase(3));
    // React commits the paused-state update asynchronously; visibility alone is not readiness.
    await page.waitForFunction(() => {
      const region = document.querySelector('[role="region"][aria-label="Handoff"]');
      const buttons = region && [...region.querySelectorAll('button')].filter(b => !b.closest('dialog'));
      return buttons?.length === 3 && buttons[1].disabled && buttons[2].disabled;
    });
    assert.ok(await region.getByRole('button', { name: '复制 · 连接器' }).isDisabled());
    assert.ok(await region.getByRole('button', { name: '复制 · 沙箱直连' }).isDisabled());
    await region.getByRole('button', { name: '查看' }).click();
    await dialog.getByText('合成内容 session-b handoff-b2').waitFor();

    for (const width of [390, 320, 280]) {
      await page.setViewportSize({ width, height: 640 });
      const geometry = await page.evaluate(() => {
        const coords = el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right }; };
        const bar = document.querySelector('[role="region"][aria-label="Handoff"]');
        const modal = document.querySelector('dialog[open][aria-label="Handoff"]');
        return { bar: coords(bar),
          barButtons: [...bar.querySelectorAll('button')].filter(b => !b.closest('dialog')).map(coords),
          modalContent: coords(modal.firstElementChild),
          modalButtons: [...modal.querySelectorAll('button')].map(coords),
          scrollWidth: document.documentElement.scrollWidth, viewport: innerWidth };
      });
      assert.ok(geometry.barButtons.every(b => b.left >= geometry.bar.left && b.right <= geometry.bar.right),
        'detail buttons must stay inside the bar: ' + width + ' ' + JSON.stringify(geometry));
      assert.ok(geometry.modalButtons.every(b => b.left >= 0 && b.right <= width)
        && geometry.modalContent.left >= 0 && geometry.modalContent.right <= width,
        'modal buttons must fit the viewport: ' + width + ' ' + JSON.stringify(geometry));
      assert.ok(geometry.scrollWidth <= width, 'no horizontal document overflow at ' + width);
    }

    assert.deepEqual(errors, [], 'React/console must have no uncaught browser errors');
    await page.close();
  } finally {
    if (browser) await browser.close();
    fs.rmSync(out, { recursive: true, force: true });
  }
});
