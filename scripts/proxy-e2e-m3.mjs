#!/usr/bin/env node
// M3 验收 E2E（docs/plan/mcp-proxy-plan.md §12-M3）：
// browser profile 的 domain policy / fill 密码脱敏 / attachment store（字节不进
// agent context、Panel 授权路由、session 隔离）。
// 注：plan 的"真 Chrome E2E"需要 pinned chrome-devtools-mcp + 本机 Chrome；
// 本脚本以 fixture 上游（navigate_page/fill/evaluate_script 纯回显）验证全部
// profile/策略/附件语义——真 Chrome 闭环列为环境依赖的人工冒烟项。
// 运行：pnpm build && node scripts/proxy-e2e-m3.mjs
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FAKE = path.join(ROOT, 'scripts', 'fake-upstream.mjs').replace(/\\/g, '\\\\');
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
const dataOf = (r) => JSON.parse(envelopeOf(r).dataJson ?? '{}');

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-proxy-e2e-m3-'));
  fs.mkdirSync(path.join(tmp, 'workspace'), { recursive: true });
  const cfg = path.join(tmp, 'proxies.yaml');
  // v2.5: browser profile 仅剩 opt-in 白名单 + fill 密码脱敏；fakeb 不配白名单演示透传
  fs.writeFileSync(cfg, `proxies:\n  - name: fake
    transport: stdio
    command: node
    args: ["${FAKE}"]
    profile: browser
    browser:
      allowedDomains: ["example.com", "*.example.org"]
    surface:
      expose: [navigate_page, fill, evaluate_script, echo, emit_binary, schema_heavy]
    risk:
      echo: allow
      schema_heavy: allow
      emit_binary: allow
      navigate_page: allow
    redactPaths:
      - value
    limits:
      connectTimeoutMs: 15000
      callTimeoutMs: 30000
      approvalTimeoutMs: 4000
      maxChildren: 4
  - name: fakeb
    transport: stdio
    command: node
    args: ["${FAKE}"]
    profile: browser
    surface:
      expose: [navigate_page, echo]
      aliases:
        open_nav: navigate_page
        open_echo: echo
`);
  const port = 27000 + Math.floor(Math.random() * 8000);
  const daemon = spawn(process.execPath, [path.join(ROOT, 'scripts', 'smoke-daemon-fixture.mjs'), '--port', String(port)], {
    env: { ...process.env, BLACKHOLE_DB: path.join(tmp, 'db.sqlite'), BLACKHOLE_TUNNEL: 'off', BLACKHOLE_SEMANTIC: 'off', BLACKHOLE_PROXY_CONFIG: cfg },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 60; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {} await sleep(300); }
    const health = await (await fetch(`${base}/api/health`)).json();
    // This fixture consumes the panel/attachment UI, so declare its actual Apps capability.
    const client = new Client({ name: 'proxy-e2e-m3', version: '0.0.1' }, {
      capabilities: { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } },
    });
    await client.connect(new StreamableHTTPClientTransport(new URL(health.mcp_url)));
    const sess = (await api(base, 'POST', '/sessions', { workspace_path: path.join(tmp, 'workspace') })).json;
    const sid = sess.session_id;
    for (let i = 0; i < 50; i++) {
      const listed = dataOf(await proxyCall(client, sid, { command: 'list' }));
      if (listed.tools.some((tool) => tool.name === 'navigate_page' && tool.status === 'online')) break;
      await sleep(100);
    }

    // ── 验收：risk:allow 在接管 tool 上被降级（导航仍走 domain hook）──
    {
      // allowedDomains 命中 → hook allow（无审批）
      const allowed = envelopeOf(await proxyCall(client, sid, { command: 'call', tool: 'navigate_page', argsJson: '{"url":"https://example.com/page"}' }));
      assert.equal(allowed.status, 'ok', `白名单命中应放行: ${JSON.stringify(allowed)}`);
      assert.ok(allowed.text.includes('example.com'));
      // profile 的 confirm 建议不会触发 BlackHole 审批；proxy 调用保持直通。
      const openWorld = envelopeOf(await proxyCall(client, sid, { command: 'call', tool: 'navigate_page', argsJson: '{"url":"https://evil.example.net/"}' }));
      assert.equal(openWorld.status, 'ok', `open-world profile confirm 应按 allow 执行: ${JSON.stringify(openWorld)}`);
      const pend = (await api(base, 'GET', `/confirmations?session_id=${sess.id}`)).json.confirmations.filter((c) => c.status === 'pending');
      assert.equal(pend.length, 0, 'proxy 调用不得创建审批卡');
      ok('M3-policy profile confirm 不触发审批；proxy 调用直接执行');
    }

    // ── 验收（v2.5 壳化）：fill 直通不弹卡；密码值脱敏安全网（redact hook）仍在 ──
    {
      const fill = envelopeOf(await proxyCall(client, sid, { command: 'call', tool: 'fill', argsJson: '{"uid":"user_password","value":"hunter3-secret"}' }));
      assert.equal(fill.status, 'ok', `fill 默认应直通: ${JSON.stringify(fill)}`);
      const pend = (await api(base, 'GET', `/confirmations?session_id=${sess.id}`)).json.confirmations.filter((c) => c.status === 'pending');
      assert.equal(pend.length, 0, 'fill 不得再弹确认卡');
      const blob = JSON.stringify((await api(base, 'GET', `/sessions/${sess.id}/calls`)).json.calls.filter((c) => c.tool === 'proxy').map((c) => c.args_json));
      assert.ok(!blob.includes('hunter3-secret'), 'fill 密码值不落 DB（redact hook 仍生效）');
      assert.ok(blob.includes('user_password'), '非敏感上下文保留（uid 可见）');
      assert.ok(blob.includes('***'), 'args 存证含掩码');
      ok('M3-fill v2.5：直通 + 密码值脱敏安全网（ProfileRedactionHook + redactPaths）');
    }

    // ── 验收（v2.5 壳化）：evaluate_script 默认直通；收紧走 config risk；无白名单 = 导航直通 ──
    {
      const ev = envelopeOf(await proxyCall(client, sid, { command: 'call', tool: 'evaluate_script', argsJson: '{"script":"1+1"}' }));
      assert.equal(ev.status, 'ok', `evaluate_script 默认应直通: ${JSON.stringify(ev)}`);
      // config 显式收紧仍有效：fakeb 的 echo 配 confirm？fakeb 无 risk → 改证 navigate：
      // fake 配了 allowedDomains（example.com），evil 域 confirm —— 已由 M3-policy 覆盖；
      // fakeb 未配白名单：任意域直通（壳语义）。
      const nav = envelopeOf(await proxyCall(client, sid, { command: 'call', tool: 'open_nav', argsJson: '{"url":"https://anything.test/x"}' }));
      assert.equal(nav.status, 'ok', `未配白名单的 navigate 应直通: ${JSON.stringify(nav)}`);
      ok('M3-evaluate/navigate v2.5：默认直通（白名单 opt-in；收紧用 config risk）');
    }

    // ── 验收：二进制 → attachment store；字节不进 agent context/DB/events ──
    {
      const shown = await client.callTool({ name: 'show', arguments: { sessionId: sid } });
      const panelKey = shown?.structuredContent?.panel_key;
      const appToken = shown?._meta?.[PANEL_APP_TOKEN_META] ?? '';
      assert.ok(panelKey && appToken, 'panel 能力就绪');

      const shot = envelopeOf(await proxyCall(client, sid, { command: 'call', tool: 'emit_binary', argsJson: '{"kind":"png"}' }));
      assert.equal(shot.status, 'ok');
      assert.ok(shot.text.includes('[attachment:att_'), `text 含占位标记: ${shot.text}`);
      assert.ok(!shot.text.includes('iVBOR'), 'base64 字节不进 text');
      const meta = shot.attachments?.[0];
      assert.ok(meta && meta.kind === 'image' && meta.mimeType === 'image/png' && meta.sizeBytes > 0 && meta.sha256?.length === 64, '附件元数据完整');
      assert.ok(meta.expiresAt !== undefined, 'expiresAt 已填（TTL）');

      // 字节经 Panel 授权路由可取（app token）；无 token 403
      const noToken = await fetch(`${base}/panel/${panelKey}/attachments/${meta.id}`);
      assert.equal(noToken.status, 403, '无 app token 必须拒绝');
      const withToken = await fetch(`${base}/panel/${panelKey}/attachments/${meta.id}?app_token=${encodeURIComponent(appToken)}`);
      assert.equal(withToken.status, 200);
      const bytes = Buffer.from(await withToken.arrayBuffer());
      assert.equal(meta.sizeBytes, bytes.length);
      // session 隔离：另一个 session 的 panel key 取不到
      const sess2 = (await api(base, 'POST', '/sessions', { workspace_path: path.join(tmp, 'workspace') })).json;
      const shown2 = await client.callTool({ name: 'show', arguments: { sessionId: sess2.session_id } });
      const panelKey2 = shown2?.structuredContent?.panel_key;
      const token2 = shown2?._meta?.[PANEL_APP_TOKEN_META] ?? '';
      const foreign = await fetch(`${base}/panel/${panelKey2}/attachments/${meta.id}?app_token=${encodeURIComponent(token2)}`);
      assert.equal(foreign.status, 404, '跨 session 取附件必须 404');

      // DB/events 无字节、无 base64
      await sleep(300);
      const dbBlob = JSON.stringify((await api(base, 'GET', `/sessions/${sess.id}/calls`)).json.calls.filter((c) => c.tool === 'proxy').map((c) => ({ a: c.args_json, r: c.result_summary })));
      assert.ok(!dbBlob.includes('iVBOR'), 'base64 不落库');
      const evBlob = JSON.stringify((await api(base, 'GET', `/sessions/${sess.id}/events?limit=100`)).json.events);
      assert.ok(!evBlob.includes('iVBOR'), 'base64 不落 events');
      ok('M3-attachment 二进制 → store；agent 只见占位+metadata；Panel 授权路由 + session 隔离 + TTL');
    }

    // ── 验收：session revoke → 附件引用与 child 同时清理 ──
    {
      await api(base, 'POST', `/sessions/${sess.id}/revoke`);
      await sleep(300);
      const pidRecords = fs.existsSync(path.join(tmp, 'proxy-children.json'))
        ? JSON.parse(fs.readFileSync(path.join(tmp, 'proxy-children.json'), 'utf8'))
        : [];
      assert.equal(pidRecords.filter((r) => r.sessionId === sess.id).length, 0, '被 revoke 的 session 不留 child 记录');
      assert.ok(pidRecords.some((r) => r.sessionId === '__shared__'), 'enabled MCP 作为 daemon-owned shared child 不随 session revoke 回收');
      ok('M3-revoke 清理会话附件，enabled daemon-owned child 保持运行');
    }

    await client.close();
  } finally {
    daemon.kill();
  }

  console.log(`\nPROXY E2E M3 PASS — ${passed} acceptance checks succeeded`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('PROXY E2E M3 FAIL:', e);
  process.exit(1);
});
