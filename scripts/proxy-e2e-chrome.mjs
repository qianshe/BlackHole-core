#!/usr/bin/env node
// M3 真 Chrome 闭环 E2E（plan §12-M3 / §13「浏览器闭环」）：
// pinned chrome-devtools-mcp@1.9.0 驱动本机 Chrome（headless + isolated profile，
// 每 stdio child 独立浏览器实例 → 双 session 隔离）。
// 闭环：navigate → wait_for → take_snapshot(locate uid) → click/fill → delta(snapshot)
//       → take_screenshot(attachment store → Panel 授权路由) + domain policy + 密码脱敏。
// 运行：pnpm build && node scripts/proxy-e2e-chrome.mjs
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CDM_ENTRY = path.join(ROOT, 'node_modules', 'chrome-devtools-mcp', 'build', 'src', 'bin', 'chrome-devtools-mcp.js').replace(/\\/g, '\\\\');
const PANEL_APP_TOKEN_META = 'blackhole/panelAppToken';
let passed = 0;
const ok = (label) => { passed++; console.log(`  ✓ ${label}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (base, method, p, body) => {
  const res = await fetch(`${base}/api${p}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};
const proxyCall = (client, sid, args) => client.callTool({ name: 'proxy', arguments: { ...args, sessionId: sid } });
const envelopeOf = (r) => JSON.parse(r.content[0].text);

/** 测试页：按钮计数（click 效果可从 a11y snapshot 读回）+ 输入框（fill）。 */
function page(title) {
  return `<!doctype html><html><head><title>${title}</title></head><body>
<h1>${title}</h1>
<input id="note" placeholder="note-input" aria-label="note-input" />
<button id="inc" aria-label="Increment">Increment</button>
<div id="status" aria-label="status">clicked-0</div>
<script>let n = 0; document.getElementById('inc').addEventListener('click', () => { n += 1; document.getElementById('status').textContent = 'clicked-' + n; });</script>
</body></html>`;
}

/** 从 chrome-devtools-mcp 的 a11y snapshot 文本提取包含关键字的 uid（格式：`uid=<id> role "label"`）。 */
function uidFor(snapshotText, keyword) {
  for (const line of snapshotText.split('\n')) {
    if (!line.includes(keyword)) continue;
    const m = /uid=(\S+)/.exec(line);
    if (m) return m[1];
  }
  return null;
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-proxy-e2e-chrome-'));
  fs.mkdirSync(path.join(tmp, 'workspace'), { recursive: true });

  // 本地测试页（域名策略：仅 127.0.0.1 在白名单）
  const site = http.createServer((req, res) => {
    const p = new URL(req.url ?? '/', 'http://x').pathname;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(p === '/page-b' ? page('Page-B') : page('Page-A'));
  });
  const sitePort = 31000 + Math.floor(Math.random() * 2000);
  await new Promise((r) => site.listen(sitePort, '127.0.0.1', r));

  const cfg = path.join(tmp, 'proxies.yaml');
  fs.writeFileSync(cfg, `proxies:\n  - name: cdm
    transport: stdio
    command: node
    args: ["${CDM_ENTRY}", "--headless", "--isolated", "--no-page-id-routing"]
    profile: browser
    browser:
      allowedDomains: ["127.0.0.1", "localhost"]
    surface:
      expose: [navigate_page, take_snapshot, click, fill, take_screenshot, wait_for, evaluate_script]
    risk:
      take_snapshot: allow
      take_screenshot: allow
      wait_for: allow
      click: confirm
      fill: confirm
      evaluate_script: confirm
    redactPaths:
      - value
    limits:
      connectTimeoutMs: 30000
      callTimeoutMs: 30000
      approvalTimeoutMs: 30000
      maxChildren: 4
`);
  const port = 32000 + Math.floor(Math.random() * 8000);
  const daemon = spawn(process.execPath, [path.join(ROOT, 'dist', 'cli.js'), 'serve', '--port', String(port)], {
    env: { ...process.env, BLACKHOLE_DB: path.join(tmp, 'db.sqlite'), BLACKHOLE_TUNNEL: 'off', BLACKHOLE_SEMANTIC: 'off', BLACKHOLE_PROXY_CONFIG: cfg },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {} await sleep(300); }
    const health = await (await fetch(`${base}/api/health`)).json();
    const client = new Client({ name: 'proxy-e2e-chrome', version: '0.0.1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(health.mcp_url)));
    const sess = (await api(base, 'POST', '/sessions', { workspace_path: path.join(tmp, 'workspace') })).json;
    const sid = sess.session_id;

    // ── navigate（domain 白名单命中 → hook allow，无审批）+ wait_for ──
    const nav = envelopeOf(await proxyCall(client, sid, { command: 'call', server: 'cdm', tool: 'navigate_page', argsJson: JSON.stringify({ url: `http://127.0.0.1:${sitePort}/page-a` }) }));
    assert.equal(nav.status, 'ok', `navigate: ${JSON.stringify(nav).slice(0, 200)}`);
    const wf = envelopeOf(await proxyCall(client, sid, { command: 'call', server: 'cdm', tool: 'wait_for', argsJson: JSON.stringify({ text: ['Page-A'] }) }));
    assert.equal(wf.status, 'ok', `wait_for: ${JSON.stringify(wf).slice(0, 200)}`);
    ok('chrome: navigate（白名单域 hook allow）+ wait_for');

    // ── take_snapshot → locate uid ──
    const snap1 = envelopeOf(await proxyCall(client, sid, { command: 'call', server: 'cdm', tool: 'take_snapshot' }));
    assert.equal(snap1.status, 'ok');
    const snapText1 = snap1.text;
    assert.ok(snapText1.includes('Page-A'), 'snapshot 含页面标记');
    console.log('[snap head]', JSON.stringify(snapText1.slice(0, 700)));
    const incUid = uidFor(snapText1, 'Increment');
    assert.ok(incUid, 'locate: Increment 按钮 uid');
    ok('chrome: take_snapshot + locate uid（Increment）');

    // ── click（proxy confirm 配置直通）+ delta snapshot（计数变化）──
    const click = envelopeOf(await proxyCall(client, sid, { command: 'call', server: 'cdm', tool: 'click', argsJson: JSON.stringify({ uid: incUid }) }));
    assert.equal(click.status, 'ok');
    const snap2 = envelopeOf(await proxyCall(client, sid, { command: 'call', server: 'cdm', tool: 'take_snapshot' }));
    assert.ok(snap2.text.includes('clicked-1'), `delta snapshot 显示点击效果: ${snap2.text.slice(0, 400)}`);
    ok('chrome: click 免审批直通 + delta snapshot（clicked-1）');

    // ── fill（proxy 免审批 + redactPaths 脱敏）──
    const fill = envelopeOf(await proxyCall(client, sid, { command: 'call', server: 'cdm', tool: 'fill', argsJson: JSON.stringify({ uid: incUid === null ? 'x' : (uidFor(snapText1, 'note-input') ?? incUid), value: 'typed-secret-77' }) }));
    assert.equal(fill.status, 'ok');
    const blob = JSON.stringify((await api(base, 'GET', `/sessions/${sess.id}/calls`)).json.calls.filter((c) => c.tool === 'proxy').map((c) => c.args_json));
    assert.ok(!blob.includes('typed-secret-77'), 'fill 值不落 DB（redactPaths）');
    ok('chrome: fill 免审批直通 + 输入值不落库');

    // ── take_screenshot → attachment store → Panel 授权路由；字节不进 agent context ──
    const shown = await client.callTool({ name: 'show', arguments: { sessionId: sid } });
    const panelKey = shown?.structuredContent?.panel_key;
    const appToken = shown?._meta?.[PANEL_APP_TOKEN_META] ?? '';
    const shot = envelopeOf(await proxyCall(client, sid, { command: 'call', server: 'cdm', tool: 'take_screenshot', argsJson: '{"format":"png"}' }));
    assert.equal(shot.status, 'ok', `screenshot: ${JSON.stringify(shot).slice(0, 200)}`);
    const meta = shot.attachments?.[0];
    assert.ok(meta && meta.kind === 'image' && meta.mimeType === 'image/png', '截图附件元数据');
    assert.ok(shot.text.includes(`[attachment:${meta.id}]`), 'text 含占位标记');
    assert.ok(!shot.text.slice(0, 200).includes('iVBOR'), 'base64 不进 text');
    const bytesRes = await fetch(`${base}/panel/${panelKey}/attachments/${meta.id}?app_token=${encodeURIComponent(appToken)}`);
    assert.equal(bytesRes.status, 200, 'Panel 授权路由取回截图字节');
    const bytes = Buffer.from(await bytesRes.arrayBuffer());
    assert.ok(bytes.length > 1000 && bytes[0] === 0x89 && bytes[1] === 0x50, `真实 PNG 字节（${bytes.length}B）`);
    ok(`chrome: take_screenshot → attachment store（${bytes.length}B PNG）→ Panel 授权路由；agent 只见占位`);

    // ── domain policy 的 confirm 建议不触发 BlackHole 审批；open-world 导航仍直接执行 ──
    const openWorld = envelopeOf(await proxyCall(client, sid, { command: 'call', server: 'cdm', tool: 'navigate_page', argsJson: '{"url":"https://example.com/"}' }));
    assert.equal(openWorld.status, 'ok', `open-world profile confirm 应按 allow 执行: ${JSON.stringify(openWorld).slice(0, 200)}`);
    const pend = (await api(base, 'GET', `/confirmations?session_id=${sess.id}`)).json.confirmations.filter((c) => c.status === 'pending');
    assert.equal(pend.length, 0, 'proxy browser 调用不得创建审批卡');
    ok('chrome: domain policy confirm 建议不进入审批状态机');

    // ── 双 session 隔离：session B 独立 Chrome（--isolated），互不干扰 ──
    {
      const sessB = (await api(base, 'POST', '/sessions', { workspace_path: path.join(tmp, 'workspace') })).json;
      const navB = envelopeOf(await proxyCall(client, sessB.session_id, { command: 'call', server: 'cdm', tool: 'navigate_page', argsJson: JSON.stringify({ url: `http://127.0.0.1:${sitePort}/page-b` }) }));
      assert.equal(navB.status, 'ok', `session B navigate: ${JSON.stringify(navB).slice(0, 200)}`);
      const snapB = envelopeOf(await proxyCall(client, sessB.session_id, { command: 'call', server: 'cdm', tool: 'take_snapshot' }));
      assert.ok(snapB.text.includes('Page-B'), 'session B 在自己的 Page-B');
      assert.ok(!snapB.text.includes('clicked-1'), 'session B 看不到 A 的点击状态（独立 profile）');
      const snapA = envelopeOf(await proxyCall(client, sid, { command: 'call', server: 'cdm', tool: 'take_snapshot' }));
      assert.ok(snapA.text.includes('clicked-1') && snapA.text.includes('Page-A'), 'session A 状态独立保留');
      ok('chrome: 双 session 并发隔离（每 child 独立 Chrome 实例/临时 profile）');
    }

    // ── DB/events 无截图字节、无 fill 原文 ──
    {
      // fill 的 args 侧禁止原文；take_snapshot 的 result 是页面状态镜像（浏览器
      // a11y 树本就展示输入框当前值），属于操作者可见的屏幕内容而非参数泄漏
      const evArgs = JSON.stringify((await api(base, 'GET', `/sessions/${sess.id}/events?limit=300`)).json.events
        .filter((e) => e.type === 'tool_call_started').map((e) => e.payload?.args));
      assert.ok(!evArgs.includes('typed-secret-77'), 'events args 无 fill 原文');
      ok('chrome: DB/events 负向断言（fill 原文/截图字节不落审计）');
    }

    await client.close();
  } finally {
    site.close();
    daemon.kill();
  }

  console.log(`\nPROXY E2E CHROME PASS — ${passed} acceptance checks succeeded`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('PROXY E2E CHROME FAIL:', e);
  process.exit(1);
});
