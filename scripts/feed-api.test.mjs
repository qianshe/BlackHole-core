// session-feed 检查点 B：/sessions/:id/feed 与 /sessions/:id/history 的服务端测试（真实 Express 路由 + SQLite + FeedLog）。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { openDb } from '../dist/storage/db.js';
import { FeedLog, MAX_WAITERS_PER_SESSION } from '../dist/storage/feedLog.js';
import { SessionsRepo } from '../dist/storage/sessions.js';
import { ToolCallsRepo } from '../dist/storage/toolCalls.js';
import { CourierMessages } from '../dist/courier/messages.js';
import { mountFeedRoutes, RETRY_DEGRADED_MS, RETRY_REMOTE_MS } from '../dist/feed/routes.js';
import { readFeed, pageTimeline, INCREMENT_MAX } from '../dist/feed/query.js';
import { compareKeys, encodeKey, parseKey } from '../dist/feed/timeline.js';

// FeedLog.wait 的定时器是 unref 的；测试里用保活定时器撑住事件循环。
const keepAlive = setInterval(() => {}, 1000);
after(() => clearInterval(keepAlive));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const msg = (over = {}) => ({ kind: 'agent', status: 'reply', site: 'chatgpt', targetId: 't', conversationKey: 'k', ...over });
const defaultMap = (c) => ({ id: c.id, seq: c.seq, tool: c.tool, status: c.status, created_at: c.created_at, rev: c.rev });

async function apiFixture(t, opts = {}) {
  const cache = path.resolve('.cache');
  fs.mkdirSync(cache, { recursive: true });
  const root = fs.mkdtempSync(path.join(cache, 'feed-api-'));
  const storage = openDb(path.join(root, 'state.sqlite'));
  const log = FeedLog.open(storage.db);
  const sessions = new SessionsRepo(storage.db);
  const toolCalls = new ToolCallsRepo(storage.db, log);
  const messages = new CourierMessages(storage.db, log);
  log.setStateProvider((id) => {
    const s = sessions.get(id);
    return s ? { name: s.name ?? null, status: s.status, link: 'direct', target: null } : null;
  });
  sessions.onStateChange = (id) => { log.touchState(id); };
  const deps = { cfg: {}, sessions, toolCalls, feed: opts.noFeed ? undefined : log, courier: { messageStore: messages }, log: () => {} };
  const app = express();
  const router = express.Router();
  // 手机通道（/remote-api）：中间件设 res.locals.channel，并有 express.json（R32 要求分别测两个通道）
  if (opts.remote) router.use((_req, res, next) => { res.locals.channel = { origin: 'https://phone.example' }; next(); }, express.json());
  mountFeedRoutes(router, deps, { mapCall: opts.mapCall ?? defaultMap, coalesceMs: opts.coalesceMs ?? 30 });
  app.use('/api', router);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  t.after(() => {
    log.shutdown();
    server.closeAllConnections?.();
    server.close();
    try { storage.close(); } catch { /* 已关闭 */ }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const get = async (pathAndQuery, signal) => {
    const started = Date.now();
    const res = await fetch(base + pathAndQuery, { signal });
    const body = await res.json();
    return { status: res.status, body, headers: res.headers, ms: Date.now() - started };
  };
  const session = (name) => sessions.create({ workspace_path: root, permission_mode: 'read-only', name }).id;
  /** 一条调用，并把 created_at 改成指定值（造同一毫秒、乱序的时间线）。 */
  const call = (sessionId, createdAt) => {
    const row = toolCalls.start(sessionId, 'tool', '{}', 'h');
    if (createdAt !== undefined) storage.db.prepare('UPDATE tool_calls SET created_at = ? WHERE id = ?').run(createdAt, row.id);
    return toolCalls.get(row.id);
  };
  return { root, db: storage.db, log, sessions, toolCalls, messages, deps, base, get, session, call };
}

const feedUrl = (id, q = {}) => `/sessions/${id}/feed?${new URLSearchParams(q)}`;
const historyUrl = (id, q = {}) => `/sessions/${id}/history?${new URLSearchParams(q)}`;

// ---------- 基本形状 ----------

test('feed/history：会话不存在 404，没有 FeedLog 503，响应带 no-store', async (t) => {
  const f = await apiFixture(t);
  const id = f.session('named');
  assert.equal((await f.get(feedUrl('nope'))).status, 404);
  assert.equal((await f.get(historyUrl('nope'))).status, 404);
  const ok = await f.get(feedUrl(id));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('cache-control'), 'no-store');

  const bare = await apiFixture(t, { noFeed: true });
  assert.equal((await bare.get(feedUrl(bare.session()))).status, 503);
});

test('feed full：没有 offset/boot 就是 full，带 boot、offset、state、older；offset > current 或 boot 不符也是 full', async (t) => {
  const f = await apiFixture(t);
  const id = f.session('hello');
  f.call(id);
  f.messages.add(msg({ sessionId: id, text: 'one' }));

  const full = (await f.get(feedUrl(id))).body;
  assert.equal(full.full, true);
  assert.equal(full.more, false);
  assert.equal(full.boot, f.log.bootId);
  assert.equal(full.offset, f.log.current());
  assert.equal(full.calls.length, 1);
  assert.deepEqual(full.messages.map((m) => m.text), ['one']);
  assert.deepEqual(full.state, { name: 'hello', status: 'active', link: 'direct', target: null });
  assert.equal(full.older, null, '没有更早的内容');
  assert.equal(full.wait, 0);
  assert.equal(full.retry_ms, 0);

  const sync = (q) => f.get(feedUrl(id, q));
  assert.equal((await sync({ offset: String(full.offset), boot: full.boot })).body.full, false);
  assert.equal((await sync({ offset: String(full.offset) })).body.full, true, '缺 boot');
  assert.equal((await sync({ boot: full.boot })).body.full, true, '缺 offset');
  assert.equal((await sync({ offset: String(full.offset + 5), boot: full.boot })).body.full, true, 'offset 超前');
  assert.equal((await sync({ offset: String(full.offset), boot: 'other-boot' })).body.full, true, 'daemon 重启后 boot 不符');
  assert.equal((await sync({ offset: 'abc', boot: full.boot })).body.full, true, '非法 offset');
  assert.equal((await sync({ offset: '-1', boot: full.boot })).body.full, true);
});

test('feed 增量：只返回之后新增或变化的调用、回复和 state；没变的 state 不重发', async (t) => {
  const f = await apiFixture(t);
  const id = f.session('a');
  const other = f.session('b');
  const first = f.call(id);
  const { body: head } = await f.get(feedUrl(id));
  const next = (b) => ({ offset: String(b.offset), boot: b.boot });

  assert.deepEqual((await f.get(feedUrl(id, next(head)))).body.calls, [], '没有变化');
  f.toolCalls.finish(first.id, 'completed', 'ok');
  const newer = f.call(id);
  f.messages.add(msg({ sessionId: id, text: 'reply' }));
  f.call(other);
  f.sessions.setName(id, 'renamed');
  const inc = (await f.get(feedUrl(id, next(head)))).body;
  assert.equal(inc.full, false);
  assert.deepEqual(inc.calls.map((c) => [c.id, c.status]).sort(), [[first.id, 'completed'], [newer.id, 'started']].sort(), '同一条记录只给最新版本，其他会话的调用不给');
  assert.deepEqual(inc.messages.map((m) => m.text), ['reply']);
  assert.equal(inc.state.name, 'renamed');
  assert.equal(inc.offset, f.log.current());
  assert.equal(inc.older, undefined, '只有 full 带 older');

  const quiet = (await f.get(feedUrl(id, next(inc)))).body;
  assert.deepEqual([quiet.calls, quiet.messages, quiet.state], [[], [], undefined]);
  assert.equal(quiet.offset, inc.offset);
});

test('feed 截断（R5）：超过 200 条时 more=true，offset 取已返回的最大 rev，续拉后不重不漏，state 也不丢', async (t) => {
  const f = await apiFixture(t);
  const id = f.session('x');
  const head = (await f.get(feedUrl(id))).body;
  const expected = new Set();
  for (let i = 0; i < 150; i++) expected.add(f.call(id).id);
  f.sessions.setName(id, 'mid-batch'); // state 的 rev 落在中间
  for (let i = 0; i < 150; i++) expected.add(f.messages.add(msg({ sessionId: id, text: `m${i}`, at: i })).id);
  assert.ok(expected.size > INCREMENT_MAX);

  let cur = head;
  const seen = [];
  let states = 0;
  let rounds = 0;
  do {
    const res = (await f.get(feedUrl(id, { offset: String(cur.offset), boot: cur.boot }))).body;
    assert.ok(res.calls.length + res.messages.length + (res.state ? 1 : 0) <= INCREMENT_MAX);
    if (res.more) assert.ok(res.offset < f.log.current(), '截断时绝不能返回 current()');
    seen.push(...res.calls.map((c) => c.id), ...res.messages.map((m) => m.id));
    if (res.state) states += 1;
    cur = res;
    rounds += 1;
  } while (cur.more && rounds < 10);
  assert.ok(rounds >= 2, '应分至少两批');
  assert.equal(new Set(seen).size, seen.length, '没有重复');
  assert.deepEqual(new Set(seen), expected, '没有遗漏');
  assert.equal(states, 1, 'state 恰好发一次');
  assert.equal(cur.offset, f.log.current());
});

// ---------- 多读者随机对账（直接调 readFeed，用小的截断上限覆盖截断路径） ----------

test('多个读者各自 offset，随机写入序列下对账：无重复、无遗漏，最终与库里一致', async (t) => {
  const f = await apiFixture(t);
  let seed = 20261001;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const A = f.session('A');
  const B = f.session('B');
  const src = { toolCalls: f.toolCalls, messages: f.messages, feed: f.log };
  const MAX = 7; // 小的截断上限，让截断路径经常触发

  const makeReader = (sessionId) => ({ sessionId, offset: null, boot: null, calls: new Map(), messages: new Map(), state: null, lastOffset: 0 });
  const poll = (r) => {
    for (let guard = 0; guard < 100; guard++) {
      const res = readFeed(src, r.sessionId, { offset: r.offset, boot: r.boot, limit: 100 }, (c) => c, MAX);
      if (res.full) { r.calls.clear(); r.messages.clear(); }
      else assert.ok(res.offset >= r.lastOffset, 'offset 单调不减');
      for (const c of res.calls) r.calls.set(c.id, c.status);
      for (const m of res.messages) r.messages.set(m.id, `${m.status}:${m.text}`);
      if (res.state !== undefined) r.state = res.state;
      r.offset = res.offset;
      r.boot = f.log.bootId;
      r.lastOffset = res.offset;
      if (!res.more) return;
    }
    assert.fail('续拉没有收敛');
  };
  const readers = [makeReader(A), makeReader(A), makeReader(B)];
  const callIds = { [A]: [], [B]: [] };
  const streams = { [A]: 0, [B]: 0 };
  for (let step = 0; step < 600; step++) {
    const sid = rnd(2) ? A : B;
    switch (rnd(7)) {
      case 0: callIds[sid].push(f.call(sid).id); break;
      case 1: { const id = callIds[sid][rnd(callIds[sid].length || 1)]; if (id) f.toolCalls.finish(id, rnd(2) ? 'completed' : 'failed', `r${step}`); break; }
      case 2: { const id = callIds[sid][rnd(callIds[sid].length || 1)]; if (id) f.toolCalls.awaitApproval(id); break; }
      case 3: f.messages.add(msg({ sessionId: sid, text: `m${step}`, at: rnd(50) })); break;
      case 4: f.messages.upsertSegment(msg({ sessionId: sid, segment: `g${rnd(5)}`, text: `s${step}`, status: rnd(2) ? 'streaming' : 'reply' })); break;
      case 5: f.sessions.setName(sid, `n${step}`); break;
      default: if (rnd(2)) streams[sid] += 1; f.messages.finishStreaming(); break;
    }
    if (rnd(5) === 0) poll(readers[rnd(readers.length)]);
  }
  for (const r of readers) poll(r);

  for (const r of readers) {
    const truthCalls = new Map(f.db.prepare('SELECT id, status FROM tool_calls WHERE session_id = ?').all(r.sessionId).map((c) => [c.id, c.status]));
    const truthMessages = new Map(f.db.prepare('SELECT id, status, text FROM courier_messages WHERE session_id = ?').all(r.sessionId).map((m) => [m.id, `${m.status}:${m.text}`]));
    assert.deepEqual(r.calls, truthCalls, `调用应与库一致（${r.sessionId}）`);
    assert.deepEqual(r.messages, truthMessages, `回复应与库一致（${r.sessionId}）`);
    assert.equal(r.state.name, f.sessions.get(r.sessionId).name);
  }
  assert.ok(f.db.prepare('SELECT COUNT(*) AS n FROM tool_calls').get().n > 40, '随机序列要覆盖足够多的写入');
});

// ---------- 长轮询 ----------

for (const remote of [false, true]) {
  const channel = remote ? '/remote-api（有 express.json）' : '/web-api';

  test(`长轮询（${channel}）：无变化时请求在 wait 秒附近才返回，不被提前结束（R32），空结果 retry_ms=0`, async (t) => {
    const f = await apiFixture(t, { remote });
    const id = f.session();
    const head = (await f.get(feedUrl(id))).body;
    const res = await f.get(feedUrl(id, { offset: String(head.offset), boot: head.boot, wait: '1' }));
    assert.ok(res.ms >= 900 && res.ms < 1800, `应挂起约 1s，实际 ${res.ms}ms`);
    assert.deepEqual([res.body.calls, res.body.messages, res.body.full, res.body.more, res.body.wait, res.body.retry_ms], [[], [], false, false, 1, 0]);
    assert.equal(res.body.offset, head.offset);
    assert.equal(f.log.waiting(), 0);
  });

  test(`长轮询（${channel}）：有变化在合并窗口后返回，窗口内的多次写入合并成一次响应，retry_ms 按通道`, async (t) => {
    const f = await apiFixture(t, { remote, coalesceMs: 80 });
    const id = f.session();
    const head = (await f.get(feedUrl(id))).body;
    const pending = f.get(feedUrl(id, { offset: String(head.offset), boot: head.boot, wait: '10' }));
    await sleep(100);
    f.messages.add(msg({ sessionId: id, text: 'first' }));
    await sleep(30);
    f.messages.add(msg({ sessionId: id, text: 'second' }));
    const res = await pending;
    assert.ok(res.ms < 1500, `应在写入后很快返回，实际 ${res.ms}ms`);
    assert.deepEqual(res.body.messages.map((m) => m.text), ['first', 'second'], '合并窗口内的两次写入一起返回');
    assert.equal(res.body.retry_ms, remote ? RETRY_REMOTE_MS : 0, '手机通道有数据返回 750，本机 0');
    assert.equal(res.body.offset, f.log.current());

    // 手机通道的 full 也算有数据
    assert.equal((await f.get(feedUrl(id))).body.retry_ms, remote ? RETRY_REMOTE_MS : 0);
  });

  test(`长轮询（${channel}）：截断的响应 retry_ms=0（积压有限，立即续拉）`, async (t) => {
    const f = await apiFixture(t, { remote });
    const id = f.session();
    const head = (await f.get(feedUrl(id))).body;
    for (let i = 0; i < INCREMENT_MAX + 20; i++) f.messages.add(msg({ sessionId: id, text: `m${i}`, at: i }));
    const res = (await f.get(feedUrl(id, { offset: String(head.offset), boot: head.boot }))).body;
    assert.equal(res.more, true);
    assert.equal(res.retry_ms, 0);
  });
}

test('长轮询：客户端断开后等待者立即被移除，不泄漏', async (t) => {
  const f = await apiFixture(t);
  const id = f.session();
  const head = (await f.get(feedUrl(id))).body;
  const ac = new AbortController();
  const pending = f.get(feedUrl(id, { offset: String(head.offset), boot: head.boot, wait: '25' }), ac.signal).catch((e) => e.name);
  await sleep(80);
  assert.equal(f.log.waiting(id), 1);
  ac.abort();
  assert.equal(await pending, 'AbortError');
  for (let i = 0; i < 20 && f.log.waiting() > 0; i++) await sleep(25);
  assert.equal(f.log.waiting(), 0, '断开后等待者已移除');
});

test('长轮询：每会话 16 个等待者的上限，第 17 个立即降级返回 wait:0、retry_ms:2500（不报错）', async (t) => {
  const f = await apiFixture(t);
  const id = f.session();
  const head = (await f.get(feedUrl(id))).body;
  const q = { offset: String(head.offset), boot: head.boot, wait: '25' };
  const acs = Array.from({ length: MAX_WAITERS_PER_SESSION }, () => new AbortController());
  const parked = acs.map((ac) => f.get(feedUrl(id, q), ac.signal).catch(() => null));
  for (let i = 0; i < 40 && f.log.waiting(id) < MAX_WAITERS_PER_SESSION; i++) await sleep(25);
  assert.equal(f.log.waiting(id), MAX_WAITERS_PER_SESSION);

  const degraded = await f.get(feedUrl(id, q));
  assert.ok(degraded.ms < 1000, `降级立即返回，实际 ${degraded.ms}ms`);
  assert.equal(degraded.status, 200);
  assert.deepEqual([degraded.body.wait, degraded.body.retry_ms, degraded.body.calls, degraded.body.messages], [0, RETRY_DEGRADED_MS, [], []]);
  for (const ac of acs) ac.abort();
  await Promise.all(parked);
});

test('长轮询：会话行消失（FeedLog.close）立即 404；revoked/archived 下发新 state.status 而不是 404；shutdown 提前返回 retry_ms=2500', async (t) => {
  const f = await apiFixture(t);
  const q = (head) => ({ offset: String(head.offset), boot: head.boot, wait: '25' });

  const gone = f.session();
  const goneHead = (await f.get(feedUrl(gone))).body;
  const closing = f.get(feedUrl(gone, q(goneHead)));
  await sleep(80);
  f.log.close(gone);
  const closed = await closing;
  assert.equal(closed.status, 404);
  assert.ok(closed.ms < 1500);

  const ended = f.session('ending');
  const endedHead = (await f.get(feedUrl(ended))).body;
  const watching = f.get(feedUrl(ended, q(endedHead)));
  await sleep(80);
  f.sessions.setStatus(ended, 'archived');
  const archived = await watching;
  assert.equal(archived.status, 200, 'revoked/archived 的行还在，不返回 404');
  assert.equal(archived.body.state.status, 'archived');
  assert.ok(archived.ms < 1500);

  const live = f.session();
  const liveHead = (await f.get(feedUrl(live))).body;
  const parked = f.get(feedUrl(live, q(liveHead)));
  await sleep(80);
  f.log.shutdown();
  const shut = await parked;
  assert.equal(shut.status, 200);
  assert.equal(shut.body.retry_ms, RETRY_DEGRADED_MS);
  assert.ok(shut.ms < 1500);
});

// ---------- history ----------

test('history：限条数夹到 10–100、非法游标 400、空会话返回空且 older=null', async (t) => {
  const f = await apiFixture(t);
  const id = f.session();
  assert.deepEqual((await f.get(historyUrl(id))).body, { items: { calls: [], messages: [] }, older: null });
  for (let i = 0; i < 130; i++) f.call(id, 1000 + i);
  assert.equal((await f.get(historyUrl(id, { limit: '1' }))).body.items.calls.length, 10, '下限 10');
  assert.equal((await f.get(historyUrl(id, { limit: '1000' }))).body.items.calls.length, 100, '上限 100');
  assert.equal((await f.get(historyUrl(id, { limit: 'abc' }))).body.items.calls.length, 50, '默认 50');
  assert.equal((await f.get(historyUrl(id, { before: 'garbage' }))).status, 400);
  assert.equal((await f.get(historyUrl(id, { before: '12.x.abc' }))).status, 400);
  assert.deepEqual(parseKey(encodeKey({ t: 5, kind: 'm', id: 'a.b-c' })), { t: 5, kind: 'm', id: 'a.b-c' });
});

test('history：与 feed full 头部首尾衔接，逐页翻完后与库里的全部条目完全一致（随机数据、大量同一毫秒）', async (t) => {
  const f = await apiFixture(t);
  let seed = 77;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const id = f.session();
  for (let i = 0; i < 160; i++) {
    const tick = 1000 + rnd(30); // 只有 30 个不同的毫秒：大量同一毫秒的调用与回复
    if (rnd(2)) f.call(id, tick); else f.messages.add(msg({ sessionId: id, text: `m${i}`, at: tick }));
  }
  const oracle = [
    ...f.db.prepare('SELECT id, created_at AS t FROM tool_calls WHERE session_id = ?').all(id).map((r) => ({ t: r.t, kind: 'c', id: r.id })),
    ...f.db.prepare('SELECT id, at AS t FROM courier_messages WHERE session_id = ?').all(id).map((r) => ({ t: r.t, kind: 'm', id: r.id })),
  ].sort(compareKeys).map(encodeKey);
  assert.equal(oracle.length, 160);

  const limit = 23; // 不能整除 160，且比同一毫秒的条数大、比它小都会覆盖
  const key = (item, kind) => encodeKey({ t: kind === 'c' ? item.created_at : item.at, kind, id: item.id });
  const pageKeys = (body) => [
    ...body.calls.map((c) => key(c, 'c')),
    ...body.messages.map((m) => key(m, 'm')),
  ].sort((a, b) => compareKeys(parseKey(a), parseKey(b)));

  const full = (await f.get(feedUrl(id, { limit: String(limit) }))).body;
  const collected = [pageKeys(full)];
  assert.equal(collected[0].length, limit);
  let older = full.older;
  let pages = 0;
  while (older !== null && pages < 20) {
    const page = (await f.get(historyUrl(id, { before: older, limit: String(limit) }))).body;
    const keys = pageKeys(page.items);
    assert.ok(keys.length > 0 && keys.length <= limit);
    assert.ok(compareKeys(parseKey(keys.at(-1)), parseKey(older)) < 0, '严格早于 before');
    collected.unshift(keys);
    older = page.older;
    pages += 1;
  }
  assert.equal(older, null);
  assert.deepEqual(collected.flat(), oracle, '头部 + 历史逐页拼起来 = 整条时间线，无重复无遗漏');
  assert.equal(pages, Math.ceil(160 / limit) - 1);
});

test('回复没有条数上限：单会话写入 500 条回复后，经 feed full + history 逐页全部取回（无重复、无遗漏），增量仍只返回新的', async (t) => {
  const f = await apiFixture(t);
  const id = f.session();
  const written = [];
  for (let i = 0; i < 500; i++) written.push(f.messages.add(msg({ sessionId: id, text: `r${i}`, at: 10_000 + i, turn: i + 1 })).id);
  assert.equal(f.messages.list(id, 1000).length, 500, '存储层没有上限');

  const full = (await f.get(feedUrl(id, { limit: '100' }))).body;
  assert.equal(full.messages.length, 100);
  const ids = [full.messages.map((m) => m.id)];
  let older = full.older, pages = 0;
  while (older !== null && pages < 10) {
    const page = (await f.get(historyUrl(id, { before: older, limit: '100' }))).body;
    ids.unshift(page.items.messages.map((m) => m.id));
    older = page.older;
    pages += 1;
  }
  assert.equal(pages, 4);
  const all = ids.flat();
  assert.equal(new Set(all).size, 500, '没有重复');
  assert.deepEqual([...all].sort(), [...written].sort(), '一条不少');

  f.messages.add(msg({ sessionId: id, text: 'next', at: 20_000, turn: 501 }));
  const inc = (await f.get(feedUrl(id, { offset: String(full.offset), boot: full.boot }))).body;
  assert.equal(inc.full, false);
  assert.deepEqual(inc.messages.map((m) => m.text), ['next'], '增量只有新的一条');
});

test('history：历史查询走索引，不全表扫描（开销与会话长度无关）', async (t) => {
  const f = await apiFixture(t);
  const id = f.session();
  f.db.exec('BEGIN');
  const insertCall = f.db.prepare("INSERT INTO tool_calls (id, session_id, tool, args_json, args_hash, status, created_at, updated_at, rev) VALUES (?, ?, 't', '{}', 'h', 'completed', ?, ?, ?)");
  const insertMsg = f.db.prepare("INSERT INTO courier_messages (id, session_id, kind, text, at, status, rev) VALUES (?, ?, 'agent', 'x', ?, 'reply', ?)");
  for (let i = 0; i < 4000; i++) { insertCall.run(`c${i}`, id, i, i, i + 1); insertMsg.run(`m${i}`, id, i, i + 1); }
  f.db.exec('COMMIT');
  const plan = (sql, ...args) => f.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map((r) => r.detail).join(' | ');
  const plans = [
    plan('SELECT rowid AS seq, * FROM tool_calls WHERE session_id = ? AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?', id, 100, 100, 'c', 11),
    plan('SELECT rowid AS seq, * FROM tool_calls WHERE session_id = ? AND rev > ? ORDER BY rev ASC LIMIT ?', id, 5, 201),
    plan('SELECT * FROM courier_messages WHERE session_id = ? AND (at < ? OR (at = ? AND id < ?)) ORDER BY at DESC, id DESC LIMIT ?', id, 100, 100, 'm', 11),
    plan('SELECT * FROM courier_messages WHERE session_id = ? AND rev > ? ORDER BY rev ASC LIMIT ?', id, 5, 201),
  ];
  for (const p of plans) {
    assert.match(p, /SEARCH \w+ USING (COVERING )?INDEX/, p);
    assert.doesNotMatch(p, /SCAN (tool_calls|courier_messages)/, p);
  }
  const page = (await f.get(historyUrl(id, { before: encodeKey({ t: 2000, kind: 'c', id: 'c2000' }), limit: '10' }))).body;
  assert.equal(page.items.calls.length + page.items.messages.length, 10);
  assert.ok(pageTimeline({ toolCalls: f.toolCalls, messages: f.messages }, id, null, 10, (c) => c).older);
});

test('control API 的 mapCall（原样输出行）：feed 返回 args_json、navigation_json 与 rev', async (t) => {
  const f = await apiFixture(t, { mapCall: (c) => c });
  const id = f.session();
  const row = f.call(id);
  f.toolCalls.finish(row.id, 'completed', 'ok', '{"path":"a.txt"}');
  const res = (await f.get(feedUrl(id))).body;
  assert.equal(res.calls[0].args_json, '{}');
  assert.equal(res.calls[0].navigation_json, '{"path":"a.txt"}');
  assert.ok(res.calls[0].rev > 0);
  assert.equal(typeof res.calls[0].seq, 'number');
});
