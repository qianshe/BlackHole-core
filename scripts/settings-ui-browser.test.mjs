// Real Web/VS Code renderer E2E in a headless browser using synthetic local services.
// Build first: pnpm build && pnpm --dir packages/web build && pnpm --dir packages/vscode build:test
//                && node scripts/build-shared-settings-preview.mjs
// Browser prerequisite: Playwright Chromium, or a locally installed Chrome/Edge for development.
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
const browserPath = [
  chromium.executablePath(),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(file => fs.existsSync(file));
test('production settings UI works in both hosts without live network or user data', { timeout: 180_000 }, async (t) => {
  for (const host of ['native', 'web']) {
    assert.ok(fs.existsSync(path.join(fixtureDir, host + '.html')), 'Build settings preview before browser tests: ' + host);
  }
  const browser = await chromium.launch({ headless: true, ...(browserPath ? { executablePath: browserPath } : {}) });
  const nativeGeometry = new Map();
  try {
    for (const host of ['native', 'web']) {
      for (const width of [1280, 390, 320]) {
        await t.test(host + ' / ' + width + 'px', { timeout: 25_000 }, async () => {
          const context = await browser.newContext({
            viewport: { width, height: width === 320 ? 700 : width === 390 ? 844 : 820 },
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

            // Hosts share the content component, not its outer frame: Web is inset,
            // while VS Code uses the entire editor Webview. Compare header geometry
            // relative to the settings content so the differing frames do not mask drift.
            const frame = await page.evaluate(() => {
              const shell = document.querySelector('.settings-shell');
              const content = shell?.querySelector('div[tabindex]');
              const head = content?.firstElementChild;
              const title = head?.querySelector('h2');
              const close = head?.querySelector('[aria-label="关闭设置"]');
              const s = shell?.getBoundingClientRect();
              const p = content?.getBoundingClientRect();
              const h = head?.getBoundingClientRect();
              const t = title?.getBoundingClientRect();
              const x = close?.getBoundingClientRect();
              return { viewport: [innerWidth, innerHeight],
                shell: s && { x: s.x, y: s.y, right: s.right, bottom: s.bottom, width: s.width, height: s.height },
                headerY: h && p && h.y - p.y,
                titleX: t && p && t.x - p.x,
                titleCenterY: t && p && t.y + t.height / 2 - p.y,
                closeRightInset: x && p && p.right - x.right,
                closeCenterY: x && p && x.y + x.height / 2 - p.y,
                closeHit: !!x && document.elementFromPoint(x.x + x.width / 2, x.y + x.height / 2)?.closest('button') === close };
            });
            assert.ok(frame.shell && (host === 'native'
              ? Math.abs(frame.shell.x) < 1 && Math.abs(frame.shell.y) < 1
                && Math.abs(frame.shell.width - width) < 1 && Math.abs(frame.shell.height - frame.viewport[1]) < 1
              : frame.shell.x >= 8 && frame.shell.y >= 8
                && frame.shell.right <= width - 8 && frame.shell.bottom <= frame.viewport[1] - 8),
              `${host} must retain its own settings frame: ${JSON.stringify(frame)}`);
            assert.ok(Math.abs(frame.headerY) < 1 && frame.closeHit, `${host} title/close must stay usable: ${JSON.stringify(frame)}`);
            // The header title/close offsets must still match between hosts.
            const fields = ['headerY', 'titleX', 'titleCenterY', 'closeRightInset', 'closeCenterY'];
            if (host === 'native') nativeGeometry.set(width, frame);
            else for (const field of fields) {
              const expected = nativeGeometry.get(width)?.[field];
              assert.ok(Number.isFinite(expected) && Number.isFinite(frame[field])
                && Math.abs(frame[field] - expected) < 1.5,
                `Web/VS Code relative ${field} differs at ${width}px: Web=${frame[field]} VS Code=${expected}`);
            }

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


test('Web modal and VS Code full page stay usable across narrow widths', { timeout: 180_000 }, async t => {
  const browser = await chromium.launch({ headless: true, ...(browserPath ? { executablePath: browserPath } : {}) });
  try {
    for (const width of [1280, 800, 760, 720, 540, 460, 390, 320, 280, 240, 220]) {
      for (const host of ['web', 'native']) {
        await t.test(host + ' / ' + width + 'px', { timeout: 12_000 }, async () => {
          const page = await browser.newPage({ viewport: { width, height: 780 }, colorScheme: 'dark' });
          try {
            await page.goto(pathToFileURL(path.join(fixtureDir, host + '.html')).href);
            await page.locator('#phonePair').waitFor({ state: 'visible' });
            const g = await page.evaluate(() => {
              const rect = el => {
                const r = el.getBoundingClientRect();
                return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width };
              };
              const shell = document.querySelector('.settings-shell');
              const dialog = document.querySelector('dialog[aria-label="设置"]');
              const content = shell.querySelector('div[tabindex]');
              const cockpit = shell.querySelector('.cockpit');
              const card = shell.querySelector('.pair-card');
              return { shell: rect(shell), card: rect(card), button: rect(document.querySelector('#phonePair')),
                title: rect(card.querySelector('.pair-card-title')),
                cells: [...cockpit.querySelectorAll('.cell')].map(rect),
                contentScrollWidth: content.scrollWidth, contentClientWidth: content.clientWidth,
                scrollWidth: document.documentElement.scrollWidth, viewport: innerWidth, modal: dialog.open };
            });
            assert.equal(g.modal, true);
            if (host === 'web') {
              assert.ok(g.shell.left >= 8 && g.shell.right <= width - 8 &&
                g.shell.top >= 8 && g.shell.bottom <= 772, 'Web must be an inset modal: ' + JSON.stringify({ width, g }));
            } else {
              assert.ok(Math.abs(g.shell.left) <= 1 && Math.abs(g.shell.top) <= 1 &&
                Math.abs(g.shell.right - width) <= 1 && Math.abs(g.shell.bottom - 780) <= 1,
                'native must fill the page: ' + JSON.stringify({ width, g }));
            }
            if (width <= 460) {
              assert.ok(g.cells[0].width >= Math.min(125, g.shell.width - 85) &&
                g.cells[1].width >= Math.min(125, g.shell.width - 85),
                'narrow cockpit must not collapse into vertical labels: ' + JSON.stringify({ width, g }));
            }
            assert.ok(g.button.left >= g.card.left - 1 && g.button.right <= g.card.right + 1,
              'QR button must stay inside its card: ' + JSON.stringify({ width, g }));
            assert.ok(g.title.width >= Math.min(90, g.card.width - 35),
              'QR title must remain readable: ' + JSON.stringify({ width, g }));
            assert.ok(g.scrollWidth <= width + 1 && g.contentScrollWidth <= g.contentClientWidth + 1,
              'no document or settings-content horizontal scrollbar: ' + JSON.stringify({ width, g }));
          } finally { await page.close(); }
        });
      }
    }
  } finally { await browser.close(); }
});


test('settings navigation and card layout survive crossing the responsive breakpoint', { timeout: 100_000 }, async t => {
  const browser = await chromium.launch({ headless: true, ...(browserPath ? { executablePath: browserPath } : {}) });
  try {
    for (const host of ['web', 'native']) {
      await t.test(host + ' resize transitions', { timeout: 45_000 }, async () => {
        const page = await browser.newPage({ viewport: { width: 1000, height: 780 }, colorScheme: 'dark' });
        try {
          await page.goto(pathToFileURL(path.join(fixtureDir, host + '.html')).href);
          await page.locator('#phonePair').waitFor({ state: 'visible' });
          for (const width of [760, 761, 460, 461, 240, 220, 390, 1000]) {
            await page.setViewportSize({ width, height: 780 });
            const isNarrow = width <= 760;
            await page.waitForFunction(expectNarrow =>
              !!document.querySelector('.settings-shell > div[tabindex] > div:first-child > button[aria-controls="settingsNav"]') === expectNarrow,
            isNarrow);
            const g = await page.evaluate(() => {
              const cockpit = document.querySelector('.cockpit');
              const cells = cockpit.querySelectorAll('.cell');
              const rect = el => el.getBoundingClientRect();
              const card = document.querySelector('.pair-card');
              const button = document.getElementById('phonePair');
              const shell = document.querySelector('.settings-shell');
              return { first: rect(cells[0]).left, second: rect(cells[1]).left,
                cardRight: rect(card).right, buttonRight: rect(button).right, buttonLeft: rect(button).left,
                cardLeft: rect(card).left,
                shellLeft: rect(shell).left, shellRight: rect(shell).right,
                scrollWidth: document.documentElement.scrollWidth, viewport: innerWidth };
            });
            assert.ok(g.scrollWidth <= width + 1 && g.buttonRight <= g.cardRight + 1 &&
              g.buttonLeft >= g.cardLeft - 1, 'resize must not overflow: ' + host + ' ' + width + ' ' + JSON.stringify(g));
            if (width <= 460) assert.ok(Math.abs(g.first - g.second) < 1, 'narrow cards must stack in a single column');
            if (host === 'web') assert.ok(g.shellLeft >= 8 && g.shellRight <= width - 8, 'Web remains a modal while resizing');
            if (isNarrow) {
              const menu = page.getByRole('button', { name: '打开设置菜单' });
              await menu.click();
              assert.equal(await page.locator('#settingsNav').getAttribute('aria-hidden'), 'false');
              await page.getByRole('button', { name: '关闭设置菜单' }).click();
              assert.equal(await page.locator('#settingsNav').getAttribute('aria-hidden'), 'true');
            }
          }
        } finally { await page.close(); }
      });
    }
  } finally { await browser.close(); }
});
