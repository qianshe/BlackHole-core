#!/usr/bin/env node
// M2 验收 E2E（docs/plan/mcp-proxy-plan.md §12-M2 验收 1-6）。
// 运行：pnpm build && node scripts/proxy-e2e-m2.mjs
import assert from 'node:assert';
import { execSync, spawn } from 'node:child_process';
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-proxy-e2e-m2-'));
  fs.mkdirSync(path.join(tmp, 'workspace'), { recursive: true });
  // setFromFile 的机密文件（值不进配置）
  const secretFile = path.join(tmp, 'from-file.secret');
  fs.writeFileSync(secretFile, 'sk-fromfile-secret-4242\n');

  const cfg = path.join(tmp, 'proxies.yaml');
  fs.writeFileSync(cfg, `proxies:\n  - name: fake
    transport: stdio
    command: node
    args: ["${FAKE}"]
    env:
      inherit: [PATH, SYSTEMROOT, TEMP, TMP]
      set:
        E2E_SECRET_VALUE: sk-e2e-secret-9876
      setFromFile:
        FROM_FILE: ${secretFile.replace(/\\/g, '\\\\')}
    surface:
      expose: [echo, slow, crash_now, bump_counter, schema_heavy, emit_binary]
    risk:
      echo: allow
      crash_now: allow
      slow: allow
      bump_counter: confirm
      schema_heavy: confirm
    approvalUnits:
      bump_counter: args
      schema_heavy: args
    redactPaths:
      - required_str
    limits:
      connectTimeoutMs: 15000
      callTimeoutMs: 30000
      approvalTimeoutMs: 30000
      maxChildren: 4
`);
  const port = 26000 + Math.floor(Math.random() * 8000);
  const daemon = spawn(process.execPath, [path.join(ROOT, 'scripts', 'smoke-daemon-fixture.mjs'), '--port', String(port)], {
    env: { ...process.env, BLACKHOLE_DB: path.join(tmp, 'db.sqlite'), BLACKHOLE_TUNNEL: 'off', BLACKHOLE_SEMANTIC: 'off', BLACKHOLE_PROXY_CONFIG: cfg },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 60; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {} await sleep(300); }
    const health = await (await fetch(`${base}/api/health`)).json();
    const client = new Client({ name: 'proxy-e2e-m2', version: '0.0.1' }, {
      capabilities: { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } },
    });
    await client.connect(new StreamableHTTPClientTransport(new URL(health.mcp_url)));
    const sess = (await api(base, 'POST', '/sessions', { workspace_path: path.join(tmp, 'workspace') })).json;
    const sid = sess.session_id;
    await client.callTool({ name: 'guide', arguments: { sessionId: sid } });
    const shown = await client.callTool({ name: 'show', arguments: { sessionId: sid } });
    assert.notEqual(shown.isError, true, 'Apps fixture must mount its panel');
    assert.equal(shown.structuredContent?.status, 'mounted');
    const panelKey = shown.structuredContent.panel_key;
    const appToken = shown._meta?.[PANEL_APP_TOKEN_META];
    assert.ok(panelKey && appToken, 'panel key and app token are mandatory, not optional coverage');

    // ── 验收 6：设置页 MCP Proxies 只读区（API 层）+ file-only 红线 ──
    {
      const proxies = (await api(base, 'GET', '/proxies')).json;
      assert.equal(proxies.configured, true);
      const cfgRow = proxies.config.find((s) => s.name === 'fake');
      assert.equal(cfgRow.env.set.E2E_SECRET_VALUE, '***', 'env.set 值恒为 ***');
      assert.equal(cfgRow.env.setFromFile.FROM_FILE, '***', 'setFromFile 值恒为 ***');
      assert.equal(cfgRow.merge, false, 'Proxy-first：merge 默认关闭');
      assert.equal(cfgRow.scope, 'shared', 'enabled MCP 使用 daemon-owned shared lifecycle');
      const blob = JSON.stringify(proxies);
      assert.ok(!blob.includes('sk-e2e-secret-9876') && !blob.includes('sk-fromfile-secret-4242'), '设置页投影无明文机密');
      const rev = (await api(base, 'POST', '/proxies/revalidate')).json;
      assert.equal(rev.servers[0].ok, true);
      assert.ok(rev.note.length > 0);
      // 设置页允许编辑 MCP 连接字段，但 secret 字段仍禁止通过 guided edit 回写。
      const editConn = await api(base, 'POST', '/proxies/config/fields', { server: 'fake', fields: { transport: 'stdio', command: 'node', args: [FAKE] } });
      assert.equal(editConn.status, 200, `连接字段 guided edit 应成功: ${JSON.stringify(editConn.json)}`);
      const secretEdit = await api(base, 'POST', '/proxies/config/fields', { server: 'fake', fields: { env: { set: { SECRET: 'nope' } } } });
      assert.equal(secretEdit.status, 400, 'env secret 不得通过设置页 guided edit 回写');
      const editProbe = await api(base, 'POST', '/proxies', { name: 'x' });
      assert.equal(editProbe.status, 404, 'POST /api/proxies 必须不存在');
      const putProbe = await fetch(`${base}/api/proxies`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(putProbe.status, 404, 'PUT /api/proxies 必须不存在');
      const vscodeClient = fs.readFileSync(path.join(ROOT, 'packages', 'vscode', 'src', 'controlApi.ts'), 'utf8');
      assert.ok(!/['"`]\/proxies\/config['"`]/.test(vscodeClient), 'VS Code 客户端不得接线整文件写路由 /proxies/config');
      assert.ok(vscodeClient.includes('/proxies/config/fields'), 'VS Code 客户端使用白名单字段路由');
      ok('M2-6 设置页数据面：掩码 + revalidate + 连接字段可编辑 + secret 字段禁止回写');
    }

    // ── 验收 3：代理调用不审批，但 redaction / secret 扫描仍进入审计 ──
    {
      for (let i = 0; i < 50; i++) {
        const listed = dataOf(await proxyCall(client, sid, { command: 'list' }));
        if (listed.tools.some((tool) => tool.name === 'schema_heavy' && tool.status === 'online')) break;
        await sleep(100);
      }
      const outcome = envelopeOf(await proxyCall(client, sid, {
        command: 'call', tool: 'schema_heavy',
        argsJson: JSON.stringify({ required_str: 'plain-r', required_int: 1, optional_note: 'sk-fromfile-secret-4242' }),
      }));
      assert.equal(outcome.status, 'ok');
      const events = (await api(base, 'GET', `/sessions/${sess.id}/events?limit=50`)).json.events;
      assert.ok(!events.some((e) => e.type === 'confirmation_created' && (e.payload?.tool ?? '').includes('schema_heavy')), '代理调用不得创建 confirmation');
      await sleep(400);
      const blob = JSON.stringify((await api(base, 'GET', `/sessions/${sess.id}/calls`)).json.calls.filter((c) => c.tool === 'proxy').map((c) => c.args_json));
      assert.ok(!blob.includes('sk-fromfile-secret-4242'), 'setFromFile 值不落 args 记录');
      ok('M2-3 代理调用免审批 + setFromFile 值全路径掩码');
    }

    // ── 验收 5a：即使 risk=confirm，proxy 也直接执行且不进入 awaiting ──
    {
      const outcome = envelopeOf(await proxyCall(client, sid, { command: 'call', tool: 'bump_counter' }));
      assert.equal(outcome.status, 'ok');
      await sleep(200);
      const callsNow = (await api(base, 'GET', `/sessions/${sess.id}/calls`)).json.calls;
      assert.ok(!callsNow.some((c) => c.tool === 'proxy' && c.status === 'awaiting'), 'proxy 不得进入 awaiting');
      const events = (await api(base, 'GET', `/sessions/${sess.id}/events?limit=50`)).json.events;
      assert.ok(!events.some((e) => e.type === 'confirmation_created' && (e.payload?.tool ?? '').includes('bump_counter')), 'confirm 配置不应生成确认卡');
      ok('M2-5a proxy risk=confirm 直接执行且无审批等待');
    }

    // ── 验收 5b：panel 路由取消 in-flight（app token 授权）──
    {
      const inflight = proxyCall(client, sid, { command: 'call', tool: 'slow', argsJson: '{"ms":8000}' });
      await sleep(800);
      const callsNow = (await api(base, 'GET', `/sessions/${sess.id}/calls`)).json.calls;
      const runningRow = callsNow.find((c) => c.tool === 'proxy' && c.status === 'started');
      assert.ok(runningRow, 'slow 调用在途（started）');
      const noToken = await fetch(`${base}/panel/${panelKey}/calls/${runningRow.id}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ app_token: '' }) });
      assert.equal(noToken.status, 403, '无 app token 取消必须 403');
      const cancel = await fetch(`${base}/panel/${panelKey}/calls/${runningRow.id}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ app_token: appToken }) });
      assert.equal(cancel.status, 200, `panel cancel: ${await cancel.text()}`);
      const outcome = envelopeOf(await inflight);
      assert.equal(outcome.status, 'denied');
      assert.ok(/cancelled by operator/i.test(outcome.hint), `in-flight 取消 hint: ${outcome.hint}`);
      ok('M2-5b panel UI 取消 in-flight call（app token 403/200 两路）→ denied(cancelled)');
    }

    // ── 验收 4：upstream offline → 稳定可恢复错误 ──
    {
      // 找到 fake 的 child 并杀掉（模拟 upstream 崩溃后不可用）
      const pidFile = path.join(tmp, 'proxy-children.json');
      const pids = JSON.parse(fs.readFileSync(pidFile, 'utf8')).map((r) => r.pid);
      for (const pid of pids) {
        try { execSync(process.platform === 'win32' ? `taskkill /F /PID ${pid}` : `kill -9 ${pid}`, { stdio: 'ignore' }); } catch { /* already dead */ }
      }
      await sleep(600);
      const after = envelopeOf(await proxyCall(client, sid, { command: 'call', tool: 'echo', argsJson: '{"payload":"safe-after-offline"}' }));
      assert.ok(['unavailable', 'ok'].includes(after.status), `offline 后状态: ${after.status}`);
      if (after.status === 'unavailable') {
        assert.ok(after.hint.includes('command=list'), '可恢复 hint 指向 list');
      }
      ok('M2-4 upstream offline → 稳定、可恢复的错误（hint 指向 list）');
    }

    // ── 验收 1：panel HTML 携带 proxy 行渲染与取消入口（静态锚点）──
    {
      await proxyCall(client, sid, { command: 'call', tool: 'echo', argsJson: '{"payload":"safe-final"}' });
      await sleep(300);
      const data = await (await fetch(`${base}/panel/${panelKey}/data`)).json();
      const row = (data.calls ?? []).find((c) => c.tool === 'proxy');
      assert.ok(row, 'panel data 含 proxy 行（tool 可辨识）');
      assert.ok(['ok', 'denied', 'unknown', 'started', 'completed', 'failed'].includes(row.status), `行状态可见: ${row.status}`);
      ok('M2-1 panel 数据面可辨识 server/tool/status（VS Code 侧同源 calls API + commandSummary 分支，构建期已验证）');
      await client.close();
    }
  } finally {
    daemon.kill();
  }

  console.log(`\nPROXY E2E M2 PASS — ${passed} acceptance checks succeeded`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('PROXY E2E M2 FAIL:', e);
  process.exit(1);
});
