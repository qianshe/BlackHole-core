// Real Web/VS Code renderer E2E in a headless browser using synthetic local services.
// Build first: pnpm build && pnpm --dir packages/web build && pnpm --dir packages/vscode build:test
//                && node scripts/build-shared-settings-preview.mjs
// Browser prerequisite: pnpm exec playwright install chromium
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixtureDir = path.join(root, '.tmp/shared-settings-preview');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const expectedNav = ['首页', '连接与渠道', '直连', 'Agent 与工具', '安全', '账号与订阅', '高级'];

test('production settings UI works in both hosts without live network or user data', { timeout: 180_000 }, async (t) => {
  for (const host of ['native', 'web']) {
    assert.ok(fs.existsSync(path.join(fixtureDir, host + '.html')), 'Build settings preview before browser tests: ' + host);
  }
  const browser = await chromium.launch({ headless: true });
  try {
    for (const host of ['native', 'web']) {
      for (const width of [1280, 390, 320]) {
        await t.test(host + ' / ' + width + 'px', { timeout: 25_000 }, async () => {
          const context = await browser.newContext({
            viewport: { width, height: width === 320 ? 700 : width === 390 ? 844 : 900 },
            colorScheme: 'dark', deviceScaleFactor: 1,
          });
          try {
            const page = await context.newPage();
            const browserErrors = [], networkRequests = [];
            page.on('pageerror', error => browserErrors.push(error.message));
            page.on('request', request => { if (!request.url().startsWith('file:')) networkRequests.push(request.url()); });
            await page.goto(pathToFileURL(path.join(fixtureDir, host + '.html')).href);
            await page.locator('#phonePair').waitFor({ state: 'visible' });
            assert.equal((await page.locator('.settings-home-version').textContent())?.trim(), 'v' + version);

            const result = await page.evaluate(async () => {
              const audit = await window.__auditControls({ interactions: false });
              return { pass: audit.pass, checks: audit.checks, errors: audit.errors, blocked: window.__model.blocked };
            });
            assert.equal(result.pass, true, JSON.stringify(result.errors));
            assert.ok(result.checks >= 80, 'shared geometry/layout checks unexpectedly missing');
            assert.deepEqual(result.blocked, [], 'fixture attempted to fetch outside synthetic service');

            // One primary pairing action; the user can still inspect (but does not
            // automatically run) diagnostics from the QR dialog.
            await page.locator('[data-settings-target="home"]').evaluate(el => el.click());
            await page.locator('#phonePair').focus();
            await page.locator('#phonePair').click();
            await page.locator('.pair-dialog').waitFor({ state: 'visible' });
            assert.equal(await page.locator('.pair-dialog .pair-dialog-actions').count(), 0);
            assert.equal(await page.locator('.pair-help[open]').count(), 0);
            const pairWrites = await page.evaluate(() => window.__model.calls.map(c => c.path));
            assert.deepEqual(pairWrites, ['/remote/pair'], 'QR must not run a network probe or save settings');
            await page.locator('.pair-help summary').click();
            assert.equal(await page.locator('.pair-help[open]').count(), 1);
            await page.locator('button[aria-label="关闭配对弹窗"]').click();
            await page.locator('.pair-dialog').waitFor({ state: 'detached' });
            assert.equal(await page.evaluate(() => document.activeElement?.id), 'phonePair');

            // Page selection and sticky header must work at both widths, while
            // the mobile drawer must not reserve its own displaced title row.
            if (width <= 720) await page.getByRole('button', { name: '打开设置菜单' }).click();
            await page.locator('[data-settings-target="agents"]').click();
            assert.equal((await page.locator('.settings-shell > div[tabindex] > div:first-child > h2').textContent())?.trim(), 'Agent 与工具');
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
            const nav = await page.locator('#settingsNav [data-settings-target]').allTextContents();
            assert.deepEqual(nav.map(s => s.trim()), expectedNav);

            const sticky = await page.evaluate(() => {
              const content = document.querySelector('.settings-shell > div[tabindex]');
              const head = content.firstElementChild, close = head.querySelector('button[aria-label="关闭设置"]');
              content.style.scrollBehavior = 'auto';
              const before = { head: head.getBoundingClientRect().top, close: close.getBoundingClientRect().top };
              content.scrollTop = content.scrollHeight;
              const after = { head: head.getBoundingClientRect().top, close: close.getBoundingClientRect().top };
              const r = close.getBoundingClientRect();
              return { scroll: content.scrollTop, pinned: Math.abs(after.head - before.head) < 1 && Math.abs(after.close - before.close) < 1,
                clickable: document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('button') === close };
            });
            assert.ok(sticky.scroll > 0 && sticky.pinned && sticky.clickable, 'sticky header must remain usable during page scroll');
            assert.deepEqual(browserErrors, [], 'browser reported an uncaught runtime error');
            assert.deepEqual(networkRequests, [], 'browser fixture attempted an external request');
          } finally {
            await context.close();
          }
        });
      }
    }
  } finally {
    await browser.close();
  }
});
