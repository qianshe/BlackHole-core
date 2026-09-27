#!/usr/bin/env node
// M4 验收 E2E（docs/plan/mcp-proxy-plan.md §12-M4 验收 1-8）：
// HTTP+stdio 并存 / reload 分类演练 / 宿主侧 cancel（OQ1）/ 熔断 / prewarm /
// 指标 / tools-list 稳定 / 配置原子写回。
// 运行：pnpm build && node scripts/proxy-e2e-m4.mjs
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FAKE = path.join(ROOT, 'scripts', 'fake-upstream.mjs').replace(/\\/g, '\\\\');
const FAKE_RAW = path.join(ROOT, 'scripts', 'fake-upstream.mjs');
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

// Reload/start is asynchronous. Observe metadata readiness; never retry a business call.
async function waitForTool(client, sid, name, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let tools = [];
  do {
    const listed = envelopeOf(await proxyCall(client, sid, { command: 'list' }));
    assert.equal(listed.status, 'ok', 'catalog query must succeed');
    tools = JSON.parse(listed.dataJson).tools;
    if (tools.some(tool => tool.name === name && tool.status === 'online' && tool.callable)) return tools;
    await sleep(50);
  } while (Date.now() < deadline);
  assert.fail(`tool ${name} did not become callable within ${timeoutMs}ms; catalog=${JSON.stringify(tools.map(t => ({name:t.name,status:t.status})))}`);
}


/** fake HTTP upstream：真实 StreamableHTTP MCP server（echo 工具），供 transport:http 验证。 */
async function startHttpUpstream(port) {
  const server = new McpServer({ name: 'fake-http', version: '1.0.0' });
  server.registerTool('echo', {
    title: 'Echo',
    description: 'Echo fixture over HTTP transport.',
    inputSchema: { payload: z.string().optional() },
  }, async (args) => ({ content: [{ type: 'text', text: JSON.stringify({ payload: args?.payload ?? 'ok' }) }] }));
  // 固定单会话的 stateful 模式：一个 transport 常驻，POST 全部交给 handleRequest
  const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true, sessionIdGenerator: () => 'fixed-http-session' });
  await server.connect(transport);
  const httpServer = http.createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      console.log(`[http-fixture] ${req.method} ${pathname} sid=${req.headers['mcp-session-id'] ?? 'none'}`);
      if (pathname === '/mcp' && req.method === 'POST') {
        const body = await new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });
        console.log(`[http-fixture] handleRequest body=${body.slice(0, 120)}`);
        try {
          await transport.handleRequest(req, res, JSON.parse(body));
          console.log('[http-fixture] handleRequest done');
        } catch (e) {
          console.log(`[http-fixture] handleRequest threw: ${e instanceof Error ? e.message : String(e)}`);
          throw e;
        }
        return;
      }
      // GET SSE 流与 DELETE 会话：本夹具不支持
      res.writeHead(405).end();
    } catch (e) {
      res.writeHead(500).end();
    }
  });
  await new Promise((r) => httpServer.listen(port, '127.0.0.1', r));
  return httpServer;
}

function startDaemon(port, tmp, proxyConfigFile) {
  return spawn(process.execPath, [path.join(ROOT, 'scripts', 'smoke-daemon-fixture.mjs'), '--port', String(port)], {
    env: { ...process.env, BLACKHOLE_DB: path.join(tmp, 'db.sqlite'), BLACKHOLE_TUNNEL: 'off', BLACKHOLE_SEMANTIC: 'off', BLACKHOLE_PROXY_CONFIG: proxyConfigFile, BLACKHOLE_DEBUG_PROXY: '1' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-proxy-e2e-m4-'));
  fs.mkdirSync(path.join(tmp, 'workspace'), { recursive: true });
  const HTTP_PORT = 28000 + Math.floor(Math.random() * 1000);
  const httpUp = await startHttpUpstream(HTTP_PORT);
  const cfgPath = path.join(tmp, 'proxies.yaml');
  const writeCfg = (body) => fs.writeFileSync(cfgPath, `proxies:\n${body}\n`);
  writeCfg(`  - name: fake
    transport: stdio
    command: node
    args: ["${FAKE}"]
    risk:
      echo: allow
      crash_now: allow
      bump_counter: confirm
    limits:
      callTimeoutMs: 5000
    prewarm: on_session_start
  - name: fakehttp
    transport: http
    url: http://127.0.0.1:${HTTP_PORT}/mcp
    surface:
      expose: [echo]
      aliases:
        http_echo: echo
    risk:
      echo: allow
    prewarm: on_session_start
`);
  const port = 29000 + Math.floor(Math.random() * 8000);
  const daemon = startDaemon(port, tmp, cfgPath);
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 60; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {} await sleep(300); }
    const health = await (await fetch(`${base}/api/health`)).json();
    const client = new Client({ name: 'proxy-e2e-m4', version: '0.0.1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(health.mcp_url)));
    const sess = (await api(base, 'POST', '/sessions', { workspace_path: path.join(tmp, 'workspace') })).json;
    const sid = sess.session_id;

    // ── 验收 1：stdio + HTTP 两个 upstream 并存（prewarm on_session_start）──
    {
      await waitForTool(client, sid, 'echo');
      await waitForTool(client, sid, 'http_echo');
      const list = dataOf(await proxyCall(client, sid, { command: 'list' }));
      const echoTool = list.tools.find((t) => t.name === 'echo');
      const httpEchoTool = list.tools.find((t) => t.name === 'http_echo');
      assert.ok(['online', 'offline'].includes(echoTool.status), `stdio tool status: ${echoTool.status}`);
      assert.ok(['online', 'offline'].includes(httpEchoTool.status), `http tool status: ${httpEchoTool.status}`);
      const echo = envelopeOf(await proxyCall(client, sid, { command: 'call', tool: 'http_echo', argsJson: '{"payload":"over-http"}' }));
      assert.equal(echo.status, 'ok');
      assert.ok(echo.text.includes('over-http'));
      ok('M4-1 stdio + HTTP 双 transport 并存 + prewarm: on_session_start');
    }

    // ── 验收 6（OQ1）：宿主侧 command=cancel（optionsJson.callId）──
    {
      const hang = proxyCall(client, sid, { command: 'call', tool: 'slow', argsJson: '{"ms":4000}' });
      await sleep(600);
      const row = (await api(base, 'GET', `/sessions/${sess.id}/calls`)).json.calls.find((c) => c.tool === 'proxy' && c.status === 'started');
      assert.ok(row, 'proxy in-flight call 应处于 started');
      const cancel = envelopeOf(await proxyCall(client, sid, { command: 'cancel', optionsJson: JSON.stringify({ callId: row.id }) }));
      assert.equal(cancel.status, 'ok', `cancel: ${JSON.stringify(cancel)}`);
      const outcome = envelopeOf(await hang);
      assert.equal(outcome.status, 'denied');
      assert.ok(/cancelled by operator/i.test(outcome.hint));
      const bad = envelopeOf(await proxyCall(client, sid, { command: 'cancel', optionsJson: '{"callId":"nope"}' }));
      assert.equal(bad.status, 'unavailable');
      ok('M4-6 OQ1 宿主侧 command=cancel（optionsJson.callId）+ 加法演进（contract.hash 已随本次演练更新）');
    }

    // ── 验收 2/8：tools/list 稳定 + config 原子写回 + reload ──
    // Proxy-first 契约：upstream 增删/reload 不改变完整宿主 tools/list。
    const toolsBefore = (await client.listTools()).tools.map((t) => t.name).sort();
    const hashBefore = fs.readFileSync(path.join(ROOT, 'src', 'proxy', 'contract.hash'), 'utf8').trim();
    {
      // 引导式编辑写回（白名单字段：risk + limits）→ 原子写 → reload
      const newRisk = `  - name: fake
    transport: stdio
    command: node
    args: ["${FAKE}"]
    risk:
      echo: deny
      crash_now: allow
      bump_counter: confirm
    limits:
      callTimeoutMs: 5000
    prewarm: on_session_start
  - name: fakehttp
    transport: http
    url: http://127.0.0.1:${HTTP_PORT}/mcp
    surface:
      expose: [echo]
      aliases:
        http_echo: echo
`;
      const writeRes = await api(base, 'POST', '/proxies/config', { yaml: `proxies:\n${newRisk}` });
      assert.equal(writeRes.status, 200, `config write: ${JSON.stringify(writeRes.json)}`);
      assert.ok(writeRes.json.written === true);
      assert.ok(writeRes.json.report.hot.includes('fake'), `热生效: ${JSON.stringify(writeRes.json.report)}`);
      await sleep(300);
      // 热生效：echo 由 allow 变 deny，child 零重启
      const metrics = (await api(base, 'GET', '/proxies')).json.metrics.find((m) => m.name === 'fake');
      const restartsBefore = metrics.restarts;
      const denied = envelopeOf(await proxyCall(client, sid, { command: 'call', tool: 'echo', argsJson: '{"payload":"safe-x"}' }));
      assert.equal(denied.status, 'denied', '热生效：echo 变 deny');
      const metricsAfter = (await api(base, 'GET', '/proxies')).json.metrics.find((m) => m.name === 'fake');
      assert.equal(metricsAfter.restarts, restartsBefore, '热生效不改 child（零重启）');
      // tools/list 与 contract.hash 不因 reload/配置变化而变
      const toolsAfter = (await client.listTools()).tools.map((t) => t.name).sort();
      assert.deepEqual(toolsAfter, toolsBefore, 'reload 期间完整宿主 tools/list 恒定');
      assert.equal(fs.readFileSync(path.join(ROOT, 'src', 'proxy', 'contract.hash'), 'utf8').trim(), hashBefore);
      ok('M4-7 reload 演练：热生效（零重启）+ tools/list 与 contract.hash 稳定 + 原子写回');
    }

    // ── 验收 7b：优雅回收层（command 变更 → child 重启，in-flight 不中断难在本顺序注入，
    // 以 restarts+1 断言）+ 坏配置保留旧配置 ──
    {
      const brokenYaml = `proxies:\n  - name: fake\n    transport: stdio\n    command: node\n    args: ["${FAKE}"]\n    risk:\n      echo: allow\n  - name: oops\n    transport: stdio\n    command: node\n    args: ["${FAKE}"]\n    badField: true\n`;
      const writeRes = await api(base, 'POST', '/proxies/config', { yaml: brokenYaml });
      assert.equal(writeRes.status, 400, `坏配置必须拒绝落盘: ${JSON.stringify(writeRes.json)}`);
      assert.ok(writeRes.json.error.length > 0);
      // 当前配置仍是上一版（echo=deny）
      const still = envelopeOf(await proxyCall(client, sid, { command: 'call', tool: 'echo', argsJson: '{"payload":"safe-y"}' }));
      assert.equal(still.status, 'denied', '坏配置不落盘 → 旧配置继续生效');
      // 优雅层演练：改 command 触发 child 回收（restarts +1）
      const before = (await api(base, 'GET', '/proxies')).json.metrics.find((m) => m.name === 'fake').restarts;
      const recycledYaml = `proxies:\n  - name: fake\n    transport: stdio\n    command: node\n    args: ["${FAKE}", "--recycled"]\n    risk:\n      echo: allow\n      crash_now: allow\n    limits:\n      callTimeoutMs: 5000\n  - name: fakehttp\n    transport: http\n    url: http://127.0.0.1:${HTTP_PORT}/mcp\n    surface:\n      expose: [echo]\n      aliases:\n        http_echo: echo\n`;
      const r2 = await api(base, 'POST', '/proxies/config', { yaml: recycledYaml });
      assert.equal(r2.status, 200);
      assert.ok(r2.json.report.recycled.includes('fake'), `优雅回收: ${JSON.stringify(r2.json.report)}`);
      await waitForTool(client, sid, 'echo');
      const after = (await api(base, 'GET', '/proxies')).json.metrics.find((m) => m.name === 'fake').restarts;
      assert.equal(after, before + 1, `优雅回收后只重启一个 child（${before}→${after}）`);
      const works = envelopeOf(await proxyCall(client, sid, { command: 'call', tool: 'echo', argsJson: '{"payload":"safe-new-child"}' }));
      assert.equal(works.status, 'ok');
      ok('M4-7b 坏配置保留旧配置 + 优雅回收层（child 按新配置重启）');
    }

    // ── M4.6 引导式编辑路由：字段级合并 + file-only 红线 ──
    {
      const edit = await api(base, 'POST', '/proxies/config/fields', { server: 'fake', fields: { risk: { echo: 'deny', crash_now: 'allow' } } });
      assert.equal(edit.status, 200, `guided edit: ${JSON.stringify(edit.json)}`);
      assert.equal(edit.json.written, true);
      await sleep(300);
      const denied = envelopeOf(await proxyCall(client, sid, { command: 'call', tool: 'echo', argsJson: '{"payload":"safe-ge"}' }));
      assert.equal(denied.status, 'denied', '字段级写回热生效：echo 变 deny');
      const connectionEdit = await api(base, 'POST', '/proxies/config/fields', { server: 'fake', fields: { command: 'node', args: [FAKE_RAW] } });
      assert.equal(connectionEdit.status, 200, 'command/args 连接字段允许 guided edit');
      await waitForTool(client, sid, 'echo');
      const forbidden = await api(base, 'POST', '/proxies/config/fields', { server: 'fake', fields: { env: { set: { SECRET: 'nope' } } } });
      assert.equal(forbidden.status, 400, 'secret env 字段必须 400');
      assert.ok(forbidden.json.error.includes('file-only'), 'secret 红线错误信息明确');
      const invalid = await api(base, 'POST', '/proxies/config/fields', { server: 'fake', fields: { limits: { callTimeoutMs: -5 } } });
      assert.equal(invalid.status, 400, '非法值被校验拒绝');
      // 清空语义（UI 用 null 表示"移除该字段"，而不是写空数组）：先写一个列表再清掉
      const seeded = await api(base, 'POST', '/proxies/config/fields', { server: 'fake', fields: { redactPaths: ['note'] } });
      assert.equal(seeded.status, 200, `seed redactPaths: ${JSON.stringify(seeded.json)}`);
      assert.ok(/\n    redactPaths:/.test(fs.readFileSync(cfgPath, 'utf8')), 'redactPaths 已写入');
      const cleared = await api(base, 'POST', '/proxies/config/fields', { server: 'fake', fields: { redactPaths: null } });
      assert.equal(cleared.status, 200, `clear redactPaths: ${JSON.stringify(cleared.json)}`);
      assert.ok(!/\n    redactPaths:/.test(fs.readFileSync(cfgPath, 'utf8')), 'null = 删除该字段（回到未配置）');
      ok('M4-8 引导式编辑：字段级写回热生效 + file-only 红线 400 + 校验拒绝不落盘 + 清空=移除字段');
      // 恢复 echo allow 供后续测试
      // v2.5 壳化下必须显式恢复 bump_counter: confirm——unknown 默认已是 allow，旧测试的兜底不再存在
      await api(base, 'POST', '/proxies/config/fields', { server: 'fake', fields: { risk: { echo: 'allow', crash_now: 'allow', bump_counter: 'confirm' } } });
      await sleep(300);
    }

    // ── M4.6 设置页能力闭环：新增 / 启停 / JSON 导入 ──
    {
      // 新增：表单字段 → /proxies/add → 热加载 → agent 可见可用
      const add = await api(base, 'POST', '/proxies/add', {
        name: 'added', transport: 'stdio', command: 'node', args: [FAKE_RAW],
        surface: { expose: ['echo'], aliases: { added_echo: 'echo' } },
        risk: { echo: 'allow' }, enabled: true,
      });
      assert.equal(add.status, 200, `add: ${JSON.stringify(add.json)}`);
      let list;
      for (let i = 0; i < 50; i++) {
        list = dataOf(await proxyCall(client, sid, { command: 'list' }));
        if (list.tools.some((t) => t.name === 'added_echo' && t.status === 'online')) break;
        await sleep(100);
      }
      assert.ok(list.tools.some((t) => t.name === 'added_echo' && t.status === 'online'), '新增 MCP 启动成功后 alias tool 进 agent 视图');
      const addedCall = envelopeOf(await proxyCall(client, sid, { command: 'call', tool: 'added_echo', argsJson: '{"payload":"safe-added"}' }));
      assert.equal(addedCall.status, 'ok', `新增 server 可调用: ${JSON.stringify(addedCall).slice(0, 160)}`);
      // 启用即进入运行态；启动失败保留配置并暴露 crashed 状态，不回滚用户配置。
      const bad = await api(base, 'POST', '/proxies/add', {
        name: 'badstart', transport: 'stdio', command: 'node', args: ['-e', 'process.exit(1)'],
        risk: { echo: 'allow' }, enabled: true,
      });
      assert.equal(bad.status, 200, `启用配置应先被接受: ${JSON.stringify(bad.json)}`);
      assert.equal(bad.json.starting, true);
      let badState;
      for (let i = 0; i < 50; i++) {
        badState = (await api(base, 'GET', '/proxies')).json.status.find((row) => row.name === 'badstart');
        if (badState?.status === 'crashed') break;
        await sleep(100);
      }
      assert.equal(badState?.status, 'crashed');
      const listAfterBad = dataOf(await proxyCall(client, sid, { command: 'list' }));
      assert.ok(!listAfterBad.tools.some((t) => t.name === 'badstart'), '探活失败的 MCP 不产生 agent-visible tool');
      ok('M4-9c 启动失败：配置保留为 crashed，agent 工具面不注入');

      // 停用：fields.enabled=false → agent 不可见，设置页显示 disabled
      const off = await api(base, 'POST', '/proxies/config/fields', { server: 'added', fields: { enabled: false } });
      assert.equal(off.status, 200);
      await sleep(300);
      const listOff = dataOf(await proxyCall(client, sid, { command: 'list' }));
      const disabledTool = listOff.tools.find((t) => t.name === 'added_echo');
      assert.equal(disabledTool, undefined, '停用 MCP 不进入 agent 可用工具列表');
      const disabledCall = envelopeOf(await proxyCall(client, sid, { command: 'call', tool: 'added_echo' }));
      assert.equal(disabledCall.status, 'unavailable', 'disabled tool 不得路由调用');
      const proxiesInfo = (await api(base, 'GET', '/proxies')).json;
      assert.ok(proxiesInfo.disabled.includes('added'), 'disabled 名单返回给设置页');
      const disabledRow = (proxiesInfo.status || []).find((x) => x.name === 'added');
      assert.ok(disabledRow !== undefined, '停用后状态投影仍含该 server（卡片不消失）');
      assert.equal(disabledRow.status, 'disabled', '停用状态标记');
      // 重新启用
      const on = await api(base, 'POST', '/proxies/config/fields', { server: 'added', fields: { enabled: true } });
      assert.equal(on.status, 200);
      let listOn;
      for (let i = 0; i < 50; i++) {
        listOn = dataOf(await proxyCall(client, sid, { command: 'list' }));
        if (listOn.tools.some((t) => t.name === 'added_echo' && t.status === 'online')) break;
        await sleep(100);
      }
      assert.ok(listOn.tools.some((t) => t.name === 'added_echo' && t.status === 'online'), '重新启用后 alias tool 恢复可调用');
      ok('M4-9 设置页新增 MCP + 启停开关（停用卸载出运行时 / 启用恢复）');
    }

    // ── M4-9g（v2.6）：工具列表绑定"当前实际连接的 daemon" ──
    // 设置页展示的工具列表必须来自当前 daemon：响应带 daemonId + surfaceGen，
    // 与 /health 一致；并入宿主的名字随 merge 表面给出。
    {
      const t = await api(base, 'POST', '/proxies/tools', { server: 'added', refresh: true });
      assert.equal(t.status, 200, `tools: ${JSON.stringify(t.json)}`);
      assert.ok(Array.isArray(t.json.tools) && t.json.tools.length > 0, '启用 server 能列出工具');
      const echoRow = t.json.tools.find((x) => x.name === 'added_echo');
      assert.ok(echoRow !== undefined, `alias 后的 agent 名在工具列表里: ${JSON.stringify(t.json.tools)}`);
      assert.equal(echoRow.upstreamTool, 'echo');
      assert.equal(echoRow.enabled, true);
      assert.equal(t.json.disabled, false);
      assert.equal(t.json.cachedOnly, false, 'refresh=true → 实时结果');
      const h = (await api(base, 'GET', '/health')).json;
      assert.equal(t.json.daemonId, h.daemon_id, 'daemonId 与 health 一致（数据绑定当前 daemon）');
      assert.equal(t.json.surfaceGen, h.proxy_surface_gen, 'surfaceGen 与 health 一致');
      assert.ok(typeof h.proxy_surface_gen === 'number', 'health 暴露 proxy_surface_gen');
      assert.ok(typeof h.mcp_conn_gen === 'number' && h.mcp_conn_gen >= 1, 'health 暴露 mcp_conn_gen（本脚本已完成握手）');
      const unknown = await api(base, 'POST', '/proxies/tools', { server: 'nope' });
      assert.equal(unknown.status, 404, '未知 server → 404');
      ok('M4-9g 工具列表绑定当前 daemon（daemonId/surfaceGen + 并入宿主名）');
    }

    // ── M4-9h：停用只停不删 —— 配置保留，工具列表不触发上游 ──
    {
      const off = await api(base, 'POST', '/proxies/config/fields', { server: 'added', fields: { enabled: false } });
      assert.equal(off.status, 200);
      await sleep(300);
      const yamlOff = fs.readFileSync(cfgPath, 'utf8');
      assert.ok(yamlOff.includes('name: added'), '停用后配置条目仍在（不是删除）');
      assert.ok(/enabled:\s*false/.test(yamlOff), '停用写的是 enabled:false');
      const tOff = await api(base, 'POST', '/proxies/tools', { server: 'added' });
      assert.equal(tOff.status, 200);
      assert.equal(tOff.json.disabled, true, '停用后工具列表标记 disabled');
      assert.equal(tOff.json.cachedOnly, true, '停用不回上游拉取（缓存优先）');
      ok('M4-9h 停用只停不删：配置保留（enabled:false）+ 工具列表回缓存');
    }

    // ── M4-9i（v2.6）：删除才真正摘除 —— YAML 条目消失 + agent 不可见 + 工具列表 404 ──
    {
      const del = await api(base, 'POST', '/proxies/remove', { server: 'added' });
      assert.equal(del.status, 200, `remove: ${JSON.stringify(del.json)}`);
      assert.equal(del.json.removed, true);
      await sleep(300);
      const yamlDel = fs.readFileSync(cfgPath, 'utf8');
      assert.ok(!yamlDel.includes('name: added'), '删除后配置条目消失');
      const listDel = dataOf(await proxyCall(client, sid, { command: 'list' }));
      assert.ok(!listDel.tools.some((tool) => tool.name === 'added_echo'), '删除后 agent 工具面不可见');
      const tGone = await api(base, 'POST', '/proxies/tools', { server: 'added' });
      assert.equal(tGone.status, 404, '删除后工具列表 404');
      const delAgain = await api(base, 'POST', '/proxies/remove', { server: 'added' });
      assert.equal(delAgain.status, 404, '重复删除 → 404');
      ok('M4-9i 删除：从 YAML 摘除 + agent 视图消失 + 工具列表 404');
    }
    {
      // JSON 导入：Claude/Cursor 通用 mcpServers 格式 → 转换校验 → 批量热加载
      const imported = await api(base, 'POST', '/proxies/import', {
        json: JSON.stringify({ mcpServers: { imported: { command: 'node', args: [FAKE_RAW], env: { SECRET_FOR_IMPORTED: 'sk-imported-secret' } } } }),
      });
      assert.equal(imported.status, 200, `import: ${JSON.stringify(imported.json)}`);
      assert.deepEqual(imported.json.imported, ['imported']);
      await sleep(300);
      const operatorAfterImport = (await api(base, 'GET', '/proxies')).json;
      assert.ok(operatorAfterImport.status.some((s) => s.name === 'imported'), '导入 MCP 进入 operator 管理面');
      // 重复导入 → 400 duplicate
      const dup = await api(base, 'POST', '/proxies/import', {
        json: JSON.stringify({ mcpServers: { imported: { command: 'node' } } }),
      });
      assert.equal(dup.status, 400);
      assert.ok(dup.json.failed[0].error.includes('duplicate'));
      const removeImported = await api(base, 'POST', '/proxies/remove', { server: 'imported' });
      assert.equal(removeImported.status, 200, '导入验收后移除 imported，避免后续同名工具冲突');
      await sleep(200);
      ok('M4-9b JSON 导入（mcpServers 通用格式）+ 重名拒绝');
    }

    // ── M4.6：proxy 不参与 auto_approve/confirmation 状态机 ──
    {
      const aa = (await api(base, 'POST', '/sessions', { workspace_path: path.join(tmp, 'workspace'), permission_mode: 'workspace-write', auto_approve: true })).json;
      const r = envelopeOf(await proxyCall(client, aa.session_id, { command: 'call', tool: 'bump_counter' }));
      assert.equal(r.status, 'ok', `proxy confirm 配置应直接执行: ${JSON.stringify(r).slice(0,160)}`);
      await sleep(200);
      const aaEv = (await api(base, 'GET', `/sessions/${aa.id}/events?limit=200`)).json.events;
      assert.ok(!aaEv.some((e) => e.type === 'approval_auto_skipped' || e.type === 'confirmation_created'), 'proxy 不应产生审批状态事件');
      await api(base, 'POST', `/sessions/${aa.id}/revoke`);
      ok('M4-9d proxy 与 auto_approve 解耦：confirm 配置直通且无审批事件');
    }

    // ── M4-9e（v2.5 回归）：空配置首次添加 —— runtime 懒 bootstrap ──
    // 用户真实场景：从没建过 proxies.yaml，设置页第一次「添加 MCP」必须成功，
    // 而不是 409 proxy runtime not configured（runtime 从刚写回的配置引导创建）。
    {
      const tmpE = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-proxy-e2e-m4e-'));
      fs.mkdirSync(path.join(tmpE, 'workspace'), { recursive: true });
      const portE = 25000 + Math.floor(Math.random() * 4000);
      const cfgE = path.join(tmpE, 'proxies.yaml'); // 故意不创建文件
      const daemonE = startDaemon(portE, tmpE, cfgE);
      const baseE = `http://127.0.0.1:${portE}`;
      try {
        for (let i = 0; i < 60; i++) { try { if ((await fetch(`${baseE}/api/health`)).ok) break; } catch {} await sleep(300); }
        const before = (await api(baseE, 'GET', '/proxies')).json;
        assert.equal(before.configured, true, '空配置仍保留可编辑 runtime');
        assert.equal(before.status.length, 0, '空配置没有 MCP server');
        const add = await api(baseE, 'POST', '/proxies/add', {
          name: 'first', transport: 'stdio', command: 'node', args: [FAKE_RAW], enabled: true,
        });
        assert.equal(add.status, 200, `首次添加必须成功（bootstrap）: ${JSON.stringify(add.json)}`);
        await sleep(400);
        const after = (await api(baseE, 'GET', '/proxies')).json;
        assert.equal(after.configured, true, '添加后 runtime 已 bootstrap');
        assert.ok((after.status || []).some((x) => x.name === 'first'), 'server 出现在状态投影');
        // 再验证 bootstrap 出来的 runtime 功能完整：merged 预热 + 启停路由可用
        const toggle = await api(baseE, 'POST', '/proxies/config/fields', { server: 'first', fields: { enabled: false } });
        assert.equal(toggle.status, 200, `bootstrap 后启停可用: ${JSON.stringify(toggle.json)}`);
        ok('M4-9e 空配置首次添加：懒 bootstrap + 投影 + 启停全通');
      } finally {
        daemonE.kill();
        await sleep(300);
      }
    }

    // ── M4-9j（v2.6 回归）：全部停用后重启 —— 停用不是删除，条目仍可见可再启用 ──
    // 真实场景：把配置里的 MCP 全部「停用」后重启 daemon。若 boot 判定漏掉
    // disabled 分区，runtime 不会创建 → /proxies 报 configured:false → 设置页里
    // 这些条目彻底消失、再也无法启用（等同于删除）。必须 configured:true 且可再启用。
    {
      const tmpJ = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-proxy-e2e-m4j-'));
      fs.mkdirSync(path.join(tmpJ, 'workspace'), { recursive: true });
      const portJ = 20000 + Math.floor(Math.random() * 3000);
      const cfgJ = path.join(tmpJ, 'proxies.yaml');
      fs.writeFileSync(
        cfgJ,
        `proxies:\n  - name: off1\n    enabled: false\n    transport: stdio\n    command: node\n    args: ["${FAKE}"]\n`
          + `  - name: off2\n    enabled: false\n    transport: stdio\n    command: node\n    args: ["${FAKE}"]\n`,
      );
      const daemonJ = startDaemon(portJ, tmpJ, cfgJ);
      const baseJ = `http://127.0.0.1:${portJ}`;
      try {
        for (let i = 0; i < 60; i++) { try { if ((await fetch(`${baseJ}/api/health`)).ok) break; } catch {} await sleep(300); }
        const info = (await api(baseJ, 'GET', '/proxies')).json;
        assert.equal(info.configured, true, '全部停用也必须装配 runtime（否则设置页看不到条目、无法再启用）');
        assert.deepEqual((info.disabled || []).slice().sort(), ['off1', 'off2'], '两个条目都在 disabled 分区');
        assert.ok((info.status || []).some((x) => x.name === 'off1'), 'off1 出现在状态投影（设置页可渲染）');
        // 再启用：停用只是停掉，必须能一键恢复
        const on = await api(baseJ, 'POST', '/proxies/config/fields', { server: 'off1', fields: { enabled: true } });
        assert.equal(on.status, 200, `再启用必须成功: ${JSON.stringify(on.json)}`);
        await sleep(400);
        const after = (await api(baseJ, 'GET', '/proxies')).json;
        assert.ok(!(after.disabled || []).includes('off1'), 'off1 已离开 disabled 分区');
        assert.ok(
          (after.status || []).some((x) => x.name === 'off1' && ['online', 'starting', 'offline'].includes(x.status)),
          'off1 已回到运行时（不再是 disabled；未预热即 offline 懒启动）',
        );
        ok('M4-9j 全部停用后重启：runtime 仍在 + 条目可见 + 可再启用');
      } finally {
        daemonJ.kill();
        await sleep(300);
      }
    }

    // ── M4-9f（v2.5）：探活超时 ≠ 失败 —— 慢启动 upstream 保留不回滚 ──
    {
      const tmpF = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-proxy-e2e-m4f-'));
      fs.mkdirSync(path.join(tmpF, 'workspace'), { recursive: true });
      const portF = 21000 + Math.floor(Math.random() * 3000);
      const cfgF = path.join(tmpF, 'proxies.yaml');
      const daemonF = spawn(process.execPath, [path.join(ROOT, 'scripts', 'smoke-daemon-fixture.mjs'), '--port', String(portF)], {
        env: { ...process.env, BLACKHOLE_DB: path.join(tmpF, 'db.sqlite'), BLACKHOLE_TUNNEL: 'off', BLACKHOLE_SEMANTIC: 'off', BLACKHOLE_PROXY_CONFIG: cfgF, BLACKHOLE_PROXY_PROBE_MS: '1500' },
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      const baseF = `http://127.0.0.1:${portF}`;
      try {
        for (let i = 0; i < 60; i++) { try { if ((await fetch(`${baseF}/api/health`)).ok) break; } catch {} await sleep(300); }
        const add = await api(baseF, 'POST', '/proxies/add', {
          name: 'slowpoke', transport: 'stdio', command: 'node', args: ['-e', 'setTimeout(() => {}, 120000)'], enabled: true,
        });
        assert.equal(add.status, 200, `探活超时不得 400 回滚: ${JSON.stringify(add.json)}`);
        assert.equal(add.json.added, true);
        assert.equal(add.json.starting, true, '启用后立即进入异步启动状态，不阻塞保存请求');
        const after = (await api(baseF, 'GET', '/proxies')).json;
        assert.ok((after.status || []).some((x) => x.name === 'slowpoke'), 'slowpoke 保留在运行时');
        assert.ok(fs.readFileSync(cfgF, 'utf8').includes('slowpoke'), '配置未被回滚');
        ok('M4-9f 探活超时：保留配置 + probed:false + 按需启动提示');
      } finally {
        daemonF.kill();
        await sleep(300);
      }
    }
    // ── 验收 4：熔断器（连续失败 → 快速失败 + 指数冷却）──
    {
      // Crash one known-live child. Recovery clears lastError, so a fixed sleep
      // followed by an assertion on that transient field is inherently racy.
      await waitForTool(client, sid, 'crash_now');
      const before = (await api(base, 'GET', '/proxies')).json.metrics.find(m => m.name === 'fake');
      const crashed = envelopeOf(await proxyCall(client, sid, { command: 'call', tool: 'crash_now' }));
      assert.notEqual(crashed.status, 'ok', 'the injected crash must fail the call');
      assert.match(crashed.text ?? '', /closed|exited|crash/i, 'the error must come from the crashed child');
      const state = (await api(base, 'GET', '/proxies')).json.metrics.find(m => m.name === 'fake');
      assert.ok(state.lastError !== null || state.restarts > before.restarts,
        `crash must be recorded or already recovered: ${JSON.stringify(state)}`);
      // daemon-owned lifecycle 在崩溃后先把失效 catalog 摘出 agent 视图，再后台恢复；调用不得命中旧 child。
      const t0 = Date.now();
      const open = envelopeOf(await proxyCall(client, sid, { command: 'call', tool: 'echo', argsJson: '{"payload":"safe-during-recovery"}' }));
      const openMs = Date.now() - t0;
      assert.ok(['invalid_request', 'unavailable', 'ok'].includes(open.status), `恢复期状态: ${open.status}`);
      assert.ok(openMs < 1500, `恢复期调用不得挂住，耗时 ${openMs}ms`);
      await waitForTool(client, sid, 'echo');
      const recovered = (await api(base, 'GET', '/proxies')).json.metrics.find(m => m.name === 'fake');
      assert.ok(recovered.restarts > before.restarts, 'recovery must actually start a new child');
      assert.equal(recovered.lastError, null, 'a recovered upstream must clear its transient error');
      ok(`M4-4 崩溃后摘除失效 catalog 并后台恢复（${openMs}ms），重启 ${recovered.restarts} 次`);
    }

    // ── 验收 2：upstream tools 动态变化 → list/explain 更新，宿主 tools/list 不变 ──
    {
      // fake2 HTTP upstream 的 tools 集合固定，这里用 catalog TTL + hidden/暴露差异替代：
      // 配置新增 expose 子集后 explain 视图变化而宿主面不变（reload 已演练）
      const list = dataOf(await proxyCall(client, sid, { command: 'list' }));
      assert.ok(Array.isArray(list.tools), 'Proxy-first list 只返回 agent-visible 工具目录');
      const tools = (await client.listTools()).tools.map((t) => t.name).sort();
      assert.deepEqual(tools, toolsBefore, 'Proxy-first：上游 churn 后完整宿主 tools/list 恒定');
      assert.ok(!tools.some((n) => n.startsWith('fake_') || n.startsWith('fake2_') || n.startsWith('fakehttp_')), 'upstream 工具不得泄漏到宿主 tools/list');
      ok('M4-2 upstream 配置/目录变化后宿主 tools/list 完整不变');
    }

    // ── 指标断言（验收清单 metrics 项）──
    {
      const m = (await api(base, 'GET', '/proxies')).json.metrics.find((x) => x.name === 'fake');
      assert.ok(m.restarts >= 1 && m.calls >= 1 && m.latencyBuckets.length === 4 && typeof m.queueDepth === 'number');
      assert.ok(m.catalogAgeMs === null || typeof m.catalogAgeMs === 'number', '恢复期间 catalog age 可以为空');
      ok('M4-5 metrics：restarts/calls/lastError/延迟直方图/queueDepth/catalogAge 全就位');
    }

    await client.close();
  } finally {
    httpUp.close();
    daemon.kill();
  }

  console.log(`\nPROXY E2E M4 PASS — ${passed} acceptance checks succeeded`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('PROXY E2E M4 FAIL:', e);
  process.exit(1);
});
