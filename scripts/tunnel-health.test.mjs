// TunnelManager health decisions: reconnect only when cloudflared itself has lost the edge.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { TunnelManager } from '../dist/tunnel/manager.js';

const URL1 = 'https://alpha-beta-gamma-delta.trycloudflare.com';
const URL2 = 'https://epsilon-zeta-eta-theta.trycloudflare.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await sleep(5); } };

function fakeSpawner(urls) {
  const children = [];
  const spawnProcess = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.kill = () => { child.exitCode = 0; setImmediate(() => child.emit('exit', 0)); return true; };
    const url = urls[children.length] ?? urls.at(-1);
    children.push(child);
    setImmediate(() => {
      child.stderr.write('2026-10-02T01:00:00Z INF Starting metrics server on 127.0.0.1:20241/metrics\n');
      child.stderr.write('2026-10-02T01:00:00Z INF Registered tunnel connection connIndex=0 location=hkg01 protocol=quic\n');
      child.stderr.write(`2026-10-02T01:00:01Z INF |  ${url}  |\n`);
    });
    return child;
  };
  return { spawnProcess, children };
}

function make({ probe, ready, urls = [URL1, URL2] }) {
  const sp = fakeSpawner(urls);
  const events = [];
  const logs = [];
  const readyCalls = [];
  const m = new TunnelManager(7306, {
    enabled: true,
    spawnProcess: sp.spawnProcess,
    probe,
    readyCheck: async (u) => { readyCalls.push(u); return ready(); },
    healthCheckIntervalMs: 10,
    reconnectBackoffBaseMs: 10,
    reconnectBackoffMaxMs: 10,
    onEvent: (status, detail) => events.push({ status, ...detail }),
    log: (l) => logs.push(l),
  });
  return { m, sp, events, logs, readyCalls };
}

const CF530 = { ok: false, kind: 'http', status: 530, detail: 'Cloudflare 找不到隧道连接器（HTTP 530 / 1033）' };

test('530 while cloudflared still holds edge connections: no restart for a long streak, URL kept', async () => {
  let n = 0;
  const t = make({ probe: async () => (n++ === 0 ? { ok: true } : CF530), ready: () => true });
  t.m.start('quick');
  await until(() => n >= 9);
  assert.equal(t.sp.children.length, 1, 'cloudflared must not be restarted');
  assert.equal(t.m.url, URL1);
  assert.equal(t.m.status, 'unverified');
  assert.match(t.m.reason, /连接器在线.*暂不重连/);
  assert.equal(t.readyCalls[0], 'http://127.0.0.1:20241/ready', 'ready URL comes from the metrics log line');
  assert.ok(t.logs.some((l) => l.startsWith('cloudflared: INF Registered tunnel connection')), 'connector lifecycle is logged');
  await t.m.stop();
});

test('cloudflared heals itself within the grace window: same URL, back online', async () => {
  let n = 0;
  const t = make({ probe: async () => (++n >= 2 && n <= 4 ? CF530 : { ok: true }), ready: () => n < 5 ? false : true });
  t.m.start('quick');
  await until(() => n >= 6);
  assert.equal(t.sp.children.length, 1);
  assert.equal(t.m.url, URL1);
  assert.equal(t.m.status, 'online');
  assert.equal(t.m.reason, undefined);
  assert.ok(t.logs.some((l) => /connector has 0 edge connections/.test(l)));
  await t.m.stop();
});

test('quick connector really down: reconnect after 5 probes, then tell the user the URL changed', async () => {
  let n = 0;
  const t = make({ probe: async (u) => (u === URL1 ? (n++ === 0 ? { ok: true } : CF530) : { ok: true }), ready: () => false });
  t.m.start('quick');
  await until(() => t.m.url === URL2 && t.m.status === 'online');
  assert.equal(n, 6, 'one good probe, then exactly 5 failed ones');
  assert.equal(t.sp.children.length, 2);
  assert.match(t.m.reason, /临时公网地址已更换/);
  assert.ok(t.events.some((e) => e.reconnecting && /连接器与 Cloudflare 断开.*临时地址会更换/.test(e.reason)));
  assert.ok(t.logs.some((l) => /reconnecting quick channel after 5 failed probes .*connector down/.test(l)));
  await t.m.stop();
  assert.equal(t.m.reason, undefined, 'stop clears the notice');
});

test('单次抖动不变黄：连接器在线时，偶发一次失败保持在线；确认断开则立即提示', async () => {
  let n = 0;
  const t = make({ probe: async () => (++n === 2 ? CF530 : { ok: true }), ready: () => true });
  t.m.start('quick');
  await until(() => n >= 4);
  assert.equal(t.m.status, 'online');
  assert.equal(t.events.some((e) => e.status === 'unverified'), false, 'one blip never shows unverified');
  await t.m.stop();

  let k = 0;
  const d = make({ probe: async () => (++k === 2 ? CF530 : { ok: true }), ready: () => false });
  d.m.start('quick');
  await until(() => k >= 4);
  assert.ok(d.events.some((e) => e.status === 'unverified' && /连接器与 Cloudflare 断开/.test(e.reason)), 'a confirmed connector drop shows at once');
  assert.equal(d.m.status, 'online', 'and clears on the next good probe');
  await d.m.stop();
});

test('no metrics server known (old cloudflared): keeps the old 3-strike rule', async () => {
  let n = 0;
  const t = make({ probe: async (u) => (u === URL1 ? (n++ === 0 ? { ok: true } : CF530) : { ok: true }), ready: () => null });
  t.m.start('quick');
  await until(() => t.m.url === URL2);
  assert.equal(n, 4);
  await t.m.stop();
});
