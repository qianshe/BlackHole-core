// 渠道总开关（用户 2026-10-03）：开 = 启动上次使用的渠道，关 = 停止所有渠道；上次使用的渠道停止后仍保留。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createIsolatedEnv } from './fixtures/isolated-env.mjs';
import { LastChannel, cloudflaredOnDisk, nextChannel, switchOff, switchOn, switchView } from '../dist/tunnel/switch.js';

const memState = () => { const m = new Map(); return { get: (k) => m.get(k), set: (k, v) => { m.set(k, v); }, m }; };
const CF_LIVE = ['starting', 'online', 'unverified'];

/** 可控的渠道替身：start 按 startResult 改状态，记录调用。 */
function fakes({ mode = 'cloudflare', namedUrl, cloudflared = true, openaiSetup = true, startResult = 'starting', openaiThrows } = {}) {
  const calls = [];
  const intent = { kind: null, set(k) { calls.push(['intent', k]); this.kind = k; }, clear() { calls.push(['intent-clear']); this.kind = null; } };
  const tunnel = { status: 'off', mode: undefined, reason: undefined,
    start(kind) { calls.push(['cf-start', kind]); this.status = startResult; this.mode = kind; if (startResult === 'unavailable') this.reason = '找不到可用的 cloudflared'; },
    async stop() { calls.push(['cf-stop']); this.status = 'off'; } };
  const openai = { status: 'off', get live() { return ['starting', 'ready', 'recovering'].includes(this.status); }, credentialRevision: 4,
    view() { return { run_id: this.live ? 'run-1' : null, credential_configured: openaiSetup, reason: null }; },
    async start(req) { calls.push(['oa-start', req]); if (openaiThrows) { const e = new Error('x'); e.code = openaiThrows; throw e; } this.status = 'starting'; },
    async stop(id) { calls.push(['oa-stop', id]); this.status = 'off'; } };
  const settings = { get: () => ({ revision: 9, values: { channelMode: mode, openaiTunnelId: openaiSetup ? 'tunnel_' + '0'.repeat(32) : '', openaiTunnelClientPath: openaiSetup ? 'C:/t/tunnel-client.exe' : '' } }) };
  const state = memState();
  const d = { tunnel, openai, settings, namedUrl: () => namedUrl, cloudflaredReady: () => cloudflared, last: new LastChannel(state), intent, heartbeat: () => calls.push(['heartbeat']) };
  return { d, calls, tunnel, openai, intent, state };
}

test('LastChannel 只记 quick / named / openai，其他值当作没有', () => {
  const s = memState(); const last = new LastChannel(s);
  assert.equal(last.get(), null);
  last.set('named'); assert.equal(last.get(), 'named');
  s.set('channel.last.v1', 'bogus'); assert.equal(last.get(), null);
});

test('将要启动的渠道：上次使用优先；否则 OpenAI 标签用 OpenAI，有持久地址用持久，其余临时', () => {
  assert.equal(nextChannel(fakes().d), 'quick');
  assert.equal(nextChannel(fakes({ namedUrl: 'https://bh.example.com' }).d), 'named');
  assert.equal(nextChannel(fakes({ mode: 'openai', namedUrl: 'https://bh.example.com' }).d), 'openai');
  const f = fakes({ mode: 'openai' }); f.d.last.set('quick');
  assert.equal(nextChannel(f.d), 'quick');
});

test('视图：关 / 启动中 / 开 / 未验证 / 失败，并报出缺少的前提', () => {
  const f = fakes({ cloudflared: false });
  assert.deepEqual(switchView(f.d), { on: false, state: 'off', running: [], next: 'quick', last: null, missing: 'cloudflared', reason: null });
  assert.equal(switchView(fakes({ namedUrl: undefined }).d).missing, null);
  const n = fakes(); n.d.last.set('named');
  assert.equal(switchView(n.d).missing, 'named_url', '持久渠道没有固定地址');
  assert.equal(switchView(fakes({ mode: 'openai', openaiSetup: false }).d).missing, 'openai_setup');
  const t = fakes();
  t.tunnel.status = 'starting'; t.tunnel.mode = 'quick';
  assert.deepEqual([switchView(t.d).state, switchView(t.d).on, switchView(t.d).running], ['starting', true, ['quick']]);
  t.tunnel.status = 'online'; assert.equal(switchView(t.d).state, 'on');
  t.tunnel.status = 'unverified'; t.tunnel.reason = '未验证'; assert.deepEqual([switchView(t.d).state, switchView(t.d).reason], ['warn', '未验证']);
  t.tunnel.status = 'error'; t.tunnel.reason = '连不上'; assert.deepEqual([switchView(t.d).state, switchView(t.d).on, switchView(t.d).reason], ['error', false, '连不上']);
  t.tunnel.status = 'online'; t.openai.status = 'ready';
  assert.deepEqual(switchView(t.d).running, ['quick', 'openai']);
});

test('打开：启动并记下渠道；已在运行不动；缺前提或启动被拒绝时不记', async () => {
  const f = fakes();
  const r = await switchOn(f.d);
  assert.equal(r.ok, true); assert.equal(r.view.state, 'starting');
  assert.deepEqual(f.calls, [['cf-start', 'quick'], ['intent', 'quick'], ['heartbeat']]);
  assert.equal(f.d.last.get(), 'quick');
  f.calls.length = 0;
  assert.equal((await switchOn(f.d)).ok, true); assert.deepEqual(f.calls, [], '已在运行：不重复启动');

  const m = fakes({ cloudflared: false });
  const miss = await switchOn(m.d);
  assert.deepEqual([miss.ok, miss.code], [false, 'cloudflared']); assert.deepEqual(m.calls, []);

  const u = fakes({ startResult: 'unavailable' });
  const bad = await switchOn(u.d);
  assert.deepEqual([bad.ok, bad.code, bad.view.state], [false, 'start_failed', 'error']);
  assert.equal(u.d.last.get(), null, '没启动起来就不记入上次使用');
  assert.equal(u.intent.kind, null);
});

test('打开 OpenAI：带上当前的设置和凭据版本；管理器拒绝时返回它的错误码', async () => {
  const f = fakes({ mode: 'openai' });
  const r = await switchOn(f.d);
  assert.equal(r.ok, true);
  assert.deepEqual(f.calls[0], ['oa-start', { settingsRevision: 9, credentialRevision: 4 }]);
  assert.equal(f.d.last.get(), 'openai'); assert.equal(f.intent.kind, null, 'OpenAI 不走 Cloudflare 的自动恢复');
  const e = fakes({ mode: 'openai', openaiThrows: 'credential_missing' });
  const bad = await switchOn(e.d);
  assert.deepEqual([bad.ok, bad.code], [false, 'credential_missing']);
  assert.equal(e.d.last.get(), null);
});

test('关闭：停止所有渠道并清掉自动恢复，上次使用保留', async () => {
  const f = fakes();
  f.tunnel.status = 'online'; f.tunnel.mode = 'named'; f.openai.status = 'ready'; f.d.last.set('named'); f.intent.kind = 'named';
  const v = await switchOff(f.d);
  assert.deepEqual(f.calls, [['intent-clear'], ['cf-stop'], ['oa-stop', 'run-1']]);
  assert.deepEqual([v.on, v.state, v.next], [false, 'off', 'named']);
  assert.equal(f.d.last.get(), 'named');
});

test('cloudflaredOnDisk：绝对路径看文件，裸名字按 PATH（Windows 补 PATHEXT）查找', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-cf-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const exe = path.join(dir, 'cloudflared.exe');
  fs.writeFileSync(exe, 'x');
  assert.equal(cloudflaredOnDisk(exe, {}, 'win32', 1), true);
  assert.equal(cloudflaredOnDisk(path.join(dir, 'nope.exe'), {}, 'win32', 1), false);
  assert.equal(cloudflaredOnDisk('cloudflared', { PATH: dir, PATHEXT: '.COM;.EXE' }, 'win32', 1), true);
  assert.equal(cloudflaredOnDisk('cloudflared', { PATH: os.tmpdir() + path.sep + 'missing-dir' }, 'win32', 1), false);
  assert.equal(cloudflaredOnDisk('', {}, 'win32', 1), false);
});

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer(); s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});
function request(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: p, agent: false,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, (res) => {
      let text = ''; res.setEncoding('utf8'); res.on('data', (c) => { text += c; }); res.on('end', () => resolve({ status: res.statusCode, json: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

if (process.argv.includes('--fixture-daemon')) {
  const { startDaemon } = await import('../dist/daemon.js');
  const daemon = await startDaemon({ port: Number(process.env.BLACKHOLE_PORT), dbPath: process.env.BLACKHOLE_DB, tunnel: 'off', cloudflaredBin: path.join(os.tmpdir(), 'bh-no-such-cloudflared.exe') }, () => {});
  process.on('message', (m) => { if (m === 'stop') void daemon.stop().then(() => process.exit(0), () => process.exit(1)); });
  process.send({ ready: true });
} else {
  test('daemon 接口：GET /api/channel 给出状态，POST 校验参数、缺前提时 409、关闭总是成功', { timeout: 60_000 }, async (t) => {
    const iso = await createIsolatedEnv({ name: 'channel-switch' });
    const child = fork(fileURLToPath(import.meta.url), ['--fixture-daemon'], { env: iso.env, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const exited = new Promise((r) => child.once('exit', r));
    t.after(async () => {
      if (child.connected) child.send('stop');
      let timer; await Promise.race([exited, new Promise((r) => { timer = setTimeout(() => { child.kill(); r(); }, 4000); })]); clearTimeout(timer);
      iso.cleanup();
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('daemon startup timeout')), 15_000);
      child.once('exit', (c) => { clearTimeout(timer); reject(Error('daemon exited ' + c)); });
      child.once('message', (m) => { clearTimeout(timer); m.ready ? resolve() : reject(Error('unexpected')); });
    });
    const port = Number(iso.env.BLACKHOLE_PORT);
    const view = await request(port, 'GET', '/api/channel');
    assert.equal(view.status, 200);
    assert.deepEqual([view.json.on, view.json.state, view.json.next, view.json.missing], [false, 'off', 'quick', 'cloudflared']);
    assert.equal((await request(port, 'POST', '/api/channel', { on: 'yes' })).status, 400);
    const on = await request(port, 'POST', '/api/channel', { on: true });
    assert.deepEqual([on.status, on.json.ok, on.json.error], [409, false, 'cloudflared']);
    const off = await request(port, 'POST', '/api/channel', { on: false });
    assert.deepEqual([off.status, off.json.ok, off.json.view.on], [200, true, false]);
  });
}
void freePort; void CF_LIVE;
