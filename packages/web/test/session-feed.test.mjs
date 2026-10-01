import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SessionFeed, halve, grow, compareKeys, encodeKey, timeOf,
  SHORT_POLL_MS, BACKOFF_MS, MAX_WAIT, HEAD_MAX, TOTAL_MAX, RESTORE_MS,
} from '../../vscode/src/sessionFeed.ts';

// 确定性环境：可控时钟、可控服务端，驱动 SessionFeed 的状态机。

const settle = async () => { for (let i = 0; i < 25; i++) await new Promise((r) => setImmediate(r)); };

function fakeEnv() {
  let now = 1_000_000;
  let visible = true;
  const timers = [];
  const subs = new Set();
  return {
    now: () => now,
    visible: () => visible,
    subscribe: (cb) => { subs.add(cb); return () => subs.delete(cb); },
    sleep: (ms, signal) => new Promise((resolve) => {
      if (signal.aborted) { resolve(); return; }
      const t = { at: now + ms, resolve };
      timers.push(t);
      signal.addEventListener('abort', () => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); resolve(); }, { once: true });
    }),
    /** 把时钟推进 ms，按到期顺序触发定时器，每次触发后让异步链跑完（后续请求里新建的定时器也会在范围内触发）。 */
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        await settle();
        const due = timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        now = Math.max(now, due.at);
        timers.splice(timers.indexOf(due), 1);
        due.resolve();
      }
      now = target;
      await settle();
    },
    setVisible(v) { visible = v; for (const cb of [...subs]) cb(v ? 'show' : 'hide'); },
    emit(e) { for (const cb of [...subs]) cb(e); },
  };
}

const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });

/**
 * 脚本化的服务端，语义像真实的长轮询：feed 与 history 各有自己的队列。请求到达时队列里有步骤就立即使用，
 * 没有就挂起；之后 push 进来的步骤会先答复最早挂起的同类请求（相当于「服务端有变化了」）。
 */
function fakeServer(env) {
  const queues = { feed: [], history: [] };
  const waiting = { feed: [], history: [] };
  const paths = [];
  const times = [];
  const kindOf = (p) => (p.includes('/history?') ? 'history' : 'feed');
  const run = async (step, signal) => {
    if (step.hang) return new Promise((_, reject) => signal.addEventListener('abort', () => reject(abortError()), { once: true }));
    if (step.afterMs !== undefined) {
      await Promise.race([env.sleep(step.afterMs, signal), new Promise((_, reject) => signal.addEventListener('abort', () => reject(abortError()), { once: true }))]);
      if (signal.aborted) throw abortError();
    }
    if (step.error) throw step.error;
    return typeof step.body === 'function' ? step.body() : step.body;
  };
  return {
    paths, times,
    push(...steps) {
      for (const step of steps) {
        const kind = step.history ? 'history' : 'feed';
        const w = waiting[kind].shift();
        if (w) run(step, w.signal).then(w.resolve, w.reject);
        else queues[kind].push(step);
      }
    },
    fetchJson(path, signal) {
      paths.push(path);
      times.push(env.now());
      const kind = kindOf(path);
      const step = queues[kind].shift();
      if (step) return run(step, signal);
      return new Promise((resolve, reject) => {
        const w = { resolve, reject, signal };
        waiting[kind].push(w);
        signal.addEventListener('abort', () => { const i = waiting[kind].indexOf(w); if (i >= 0) waiting[kind].splice(i, 1); reject(abortError()); }, { once: true });
      });
    },
  };
}

const call = (id, t, status = 'started') => ({ id, created_at: t, status });
const msg = (id, at, text = id, extra = {}) => ({ id, at, text, status: 'reply', kind: 'agent', ...extra });
const resp = (o = {}) => ({ boot: 'B1', offset: 1000, full: false, more: false, retry_ms: 0, wait: 25, calls: [], messages: [], ...o });
const ok = (body) => ({ body });
const page = (calls, messages, older) => ({ history: true, body: { items: { calls, messages }, older } });
const httpError = (status) => Object.assign(new Error(`http_${status}`), { status });
const netError = () => Object.assign(new Error('net'), {});
const key = (t, id, kind = 'c') => encodeKey({ t, kind, id });

function harness(extra = {}) {
  const env = fakeEnv();
  const server = fakeServer(env);
  const fatal = [];
  const stored = new Map();
  const storage = { get: (k) => stored.get(k) ?? null, set: (k, v) => stored.set(k, v) };
  const feed = new SessionFeed({ sessionId: 'S', fetchJson: server.fetchJson, limit: 20, env, storage, storageKey: 'wait:test', onFatal: (e) => fatal.push(e), ...extra });
  const ids = () => feed.snapshot().entries.map((e) => `${e.kind}:${e.id}`);
  const feedPaths = () => server.paths.filter((p) => p.includes('/feed?'));
  return { env, server, feed, fatal, stored, ids, feedPaths, snap: () => feed.snapshot() };
}

// ---------- 合并 ----------

test('首次请求是 full（不带 offset/boot），之后带着响应里的 offset 与 boot；条目按时间线键升序，同一毫秒调用在回复前', async () => {
  const h = harness();
  h.server.push(ok(resp({ full: true, offset: 500, boot: 'BX', calls: [call('c2', 200), call('c1', 100)], messages: [msg('m1', 200), msg('m0', 50)], state: { name: 'n', status: 'active' } })));
  h.feed.start();
  await settle();
  assert.equal(h.server.paths[0], '/sessions/S/feed?wait=25&limit=20');
  assert.deepEqual(h.ids(), ['m:m0', 'c:c1', 'c:c2', 'm:m1']);
  assert.equal(h.snap().loaded, true);
  assert.deepEqual(h.snap().state, { name: 'n', status: 'active' });
  assert.deepEqual(h.snap().calls.map((c) => c.id), ['c1', 'c2']);
  assert.equal(h.server.paths[1], '/sessions/S/feed?offset=500&boot=BX&wait=25&limit=20', '第二个请求带着 offset 与 boot');
  h.feed.stop();
});

test('增量按 id upsert（同一条记录用最新版本），新条目加到末尾；早于已加载范围的新条目被丢弃（R6）', async () => {
  const h = harness();
  h.server.push(
    ok(resp({ full: true, offset: 10, calls: [call('c1', 100), call('c2', 110)], messages: [msg('m1', 105, 'par', { status: 'streaming' })] })),
    ok(resp({ offset: 20, calls: [call('c1', 100, 'completed'), call('c3', 120), call('old', 5)], messages: [msg('m1', 105, 'partial done'), msg('m2', 130)] })),
  );
  h.feed.start();
  await settle();
  assert.deepEqual(h.ids(), ['c:c1', 'm:m1', 'c:c2', 'c:c3', 'm:m2']);
  assert.equal(h.snap().calls.find((c) => c.id === 'c1').status, 'completed');
  assert.equal(h.snap().messages.find((m) => m.id === 'm1').text, 'partial done');
  assert.ok(!h.ids().includes('c:old'), '早于已加载最早条目的新 id 不插到头部');
  h.feed.stop();
});

test('full 只替换 head：没有断档时已翻出的历史保留（R37），出现断档才丢弃并以新 head 的 older 续翻', async () => {
  const h = harness();
  const run = (from, count) => Array.from({ length: count }, (_, i) => call(`c${from + i}`, from + i));
  h.server.push(ok(resp({ full: true, boot: 'B1', offset: 10, older: key(100, 'c100'), calls: run(100, 10) })));
  h.feed.start();
  await settle();

  // 往上翻一页
  h.server.push(page(run(90, 10), [], key(90, 'c90')));
  assert.equal(await h.feed.loadOlder(), true);
  assert.equal(h.ids().length, 20);
  assert.match(h.server.paths.at(-1), /^\/sessions\/S\/history\?before=100\.c\.c100&limit=20$/);

  // daemon 重启：boot 变了，full 的头部仍覆盖到原 head 最早的条目 → 没有断档，历史保留
  h.server.push(ok(resp({ full: true, boot: 'B2', offset: 99, older: key(100, 'c100'), calls: run(100, 11) })));
  await settle();
  assert.equal(h.ids().length, 21, '历史 10 条 + 新 head 11 条，重叠的不重复');
  assert.equal(h.snap().entries[0].id, 'c90');
  assert.equal(h.snap().hasOlder, true, '翻页状态也保留');

  // 再次重启，这次大量新条目：新 head 从 t=500 才开始，和已加载的内容之间有断档 → 丢弃 history
  h.server.push(ok(resp({ full: true, boot: 'B3', offset: 300, older: key(500, 'c500'), calls: run(500, 10) })));
  await settle();
  assert.deepEqual(h.ids(), run(500, 10).map((c) => `c:${c.id}`));
  assert.equal(h.snap().hasOlder, true, '以新 head 的 older 续翻');
  h.server.push(page([call('c499', 499)], [], null));
  assert.equal(await h.feed.loadOlder(), true);
  assert.match(h.server.paths.at(-1), /before=500\.c\.c500/);
  assert.equal(h.snap().hasOlder, false);
  h.feed.stop();
});

test('head 超过 300 条时最早的部分移入 history（不丢）；总量超过 2000 才裁最早的 history 并恢复可翻页', async () => {
  assert.ok(HEAD_MAX < TOTAL_MAX);
  const h = harness();
  h.server.push(ok(resp({ full: true, offset: 1, calls: [call('c0', 0)] })));
  h.feed.start();
  await settle();
  h.server.push(ok(resp({ offset: 2, calls: Array.from({ length: 349 }, (_, i) => call(`d${i}`, 1 + i)) })));
  await settle();
  assert.equal(h.snap().entries.length, 350, '没有丢任何条目');
  assert.equal(h.snap().hasOlder, false, '只是移入 history，没有丢弃内容');

  h.server.push(ok(resp({ offset: 3, calls: Array.from({ length: TOTAL_MAX }, (_, i) => call(`e${i}`, 1000 + i)) })));
  await settle();
  assert.equal(h.snap().entries.length, TOTAL_MAX);
  assert.equal(h.snap().entries[0].id, 'e0', '裁最早的（c0 与 d* 被裁）');
  assert.equal(h.snap().hasOlder, true, '裁掉的部分可以再往上翻重新加载');
  h.feed.stop();
});

// ---------- 翻页 ----------

test('loadOlder：单飞、游标是最早已加载条目的键、失败不影响已显示的内容、下次可重试', async () => {
  const h = harness();
  h.server.push(ok(resp({ full: true, offset: 1, older: 'x', calls: [call('c1', 100)], messages: [msg('m1', 100)] })));
  h.feed.start();
  await settle();
  let release;
  h.server.push({ history: true, body: () => new Promise((r) => { release = r; }) });
  const first = h.feed.loadOlder();
  const second = h.feed.loadOlder();
  assert.equal(await second, false, '同一时刻只一个翻页请求');
  assert.equal(h.snap().loadingOlder, true);
  release({ items: { calls: [call('c0', 90)], messages: [] }, older: null });
  assert.equal(await first, true);
  assert.match(h.server.paths.filter((p) => p.includes('/history')).at(-1), /before=100\.c\.c1&limit=20/, '同一毫秒调用排在回复前，游标是调用 c1');
  assert.equal(h.snap().hasOlder, false);
  assert.deepEqual(h.ids(), ['c:c0', 'c:c1', 'm:m1']);
  assert.equal(await h.feed.loadOlder(), false, 'older=null 后不再请求');
  h.feed.stop();

  const g = harness();
  g.server.push(ok(resp({ full: true, offset: 1, older: 'x', calls: [call('c1', 100)] })));
  g.feed.start();
  await settle();
  g.server.push({ history: true, error: httpError(500) });
  assert.equal(await g.feed.loadOlder(), false);
  assert.equal(g.snap().olderError, true);
  assert.deepEqual(g.ids(), ['c:c1'], '失败不清空已显示的内容');
  g.server.push(page([call('c0', 90)], [], null));
  assert.equal(await g.feed.loadOlder(), true);
  assert.equal(g.snap().olderError, false);
  g.feed.stop();
});

// ---------- 节奏：retry_ms、短轮询、退避 ----------

test('下一次请求距上一次请求开始至少 retry_ms；more=true（retry_ms=0）的响应后立即续拉', async () => {
  const h = harness();
  h.server.push(
    ok(resp({ full: true, offset: 1, retry_ms: 750, calls: [call('c1', 1)] })),
    ok(resp({ offset: 2, more: true, retry_ms: 0, calls: [call('c2', 2)] })),
    ok(resp({ offset: 3, retry_ms: 750 })),
  );
  h.feed.start();
  await settle();
  assert.equal(h.server.paths.length, 1);
  await h.env.advance(749);
  assert.equal(h.server.paths.length, 1, '750ms 之前不发下一次');
  await h.env.advance(1);
  assert.equal(h.server.paths.length, 3, '第 2 个响应 more=true、retry_ms=0，立即续拉第 3 个');
  const [t0, t1, t2] = h.server.times;
  assert.equal(t1 - t0, 750);
  assert.equal(t2, t1);
  h.feed.stop();
});

test('wait=0 的短轮询模式：每次请求之间至少 2.5s', async () => {
  const h = harness({ wait: 0 });
  h.server.push(ok(resp({ full: true, offset: 1, wait: 0 })), ok(resp({ offset: 1, wait: 0 })), ok(resp({ offset: 1, wait: 0 })));
  h.feed.start();
  await settle();
  assert.match(h.server.paths[0], /wait=0/);
  await h.env.advance(SHORT_POLL_MS - 1);
  assert.equal(h.server.paths.length, 1);
  await h.env.advance(1);
  assert.equal(h.server.paths.length, 2);
  h.feed.stop();
});

test('失败：保留已显示的内容，按 1→2→4→8→15→15s 退避，用原 offset 重试，成功后退避重置', async () => {
  const h = harness();
  h.server.push(
    ok(resp({ full: true, offset: 77, boot: 'BB', calls: [call('c1', 1)] })),
    ...Array.from({ length: 6 }, () => ({ error: httpError(500) })),
    ok(resp({ offset: 88, boot: 'BB', calls: [call('c2', 2)] })),
    { error: httpError(500) },
  );
  h.feed.start();
  await settle();
  assert.deepEqual(h.ids(), ['c:c1'], '失败后内容还在');
  assert.ok(h.snap().error);
  await h.env.advance(60_000);
  const t = h.server.times;
  // 下标 0 = full，1–6 = 失败，7 = 成功，8 = 成功后的第一次失败，9 = 其后的重试
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map((i) => t[i] - t[i - 1]), [0, 1000, 2000, 4000, 8000, 15000, 15000]);
  assert.equal(t[9] - t[8], BACKOFF_MS[0], '成功一次后退避从 1s 重新开始');
  for (const p of h.server.paths.slice(1, 8)) assert.match(p, /offset=77&boot=BB/, '用原 offset 重试');
  assert.match(h.server.paths[8], /offset=88&boot=BB/, '成功后用新的 offset');
  assert.deepEqual(h.ids(), ['c:c1', 'c:c2'], '恢复后补齐');
  h.feed.stop();
});

test('401/403/404：交给 onFatal（只一次），循环结束，已显示的内容还在', async () => {
  for (const status of [401, 403, 404]) {
    const h = harness();
    h.server.push(ok(resp({ full: true, offset: 1, calls: [call('c1', 1)] })), { error: httpError(status) });
    h.feed.start();
    await settle();
    assert.equal(h.fatal.length, 1, String(status));
    assert.equal(h.fatal[0].status, status);
    assert.equal(h.snap().stopped, true);
    const n = h.server.paths.length;
    await h.env.advance(60_000);
    assert.equal(h.server.paths.length, n, '结束后不再请求');
    assert.deepEqual(h.ids(), ['c:c1']);
    h.feed.stop();
  }
});

test('响应里的条目缺字段导致合并抛错：当作一次失败退避重试，循环不会静默死掉', async () => {
  const h = harness();
  h.server.push(
    ok(resp({ full: true, offset: 1, calls: [call('c1', 1)] })),
    ok(resp({ offset: 2, calls: [null] })),
    ok(resp({ offset: 3, calls: [call('c2', 2)] })),
  );
  h.feed.start();
  await settle();
  assert.ok(h.snap().error, '坏响应被当作失败');
  await h.env.advance(BACKOFF_MS[0]);
  assert.deepEqual(h.ids(), ['c:c1', 'c:c2']);
  assert.equal(h.snap().error, null);
  h.feed.stop();
});

// ---------- 隐藏、kick、会话结束、一次性 ----------

test('页面隐藏：中止当前请求并暂停；显示时用原 offset 立即拉一次；自己中止的不计数、不退避', async () => {
  const h = harness();
  h.server.push(ok(resp({ full: true, offset: 5, boot: 'BH', calls: [call('c1', 1)] })));
  h.feed.start();
  await settle();
  const n = h.server.paths.length; // 第 2 个请求正在挂起
  h.env.setVisible(false);
  await settle();
  await h.env.advance(120_000);
  assert.equal(h.server.paths.length, n, '隐藏期间不再请求');
  h.server.push(ok(resp({ offset: 6, boot: 'BH', calls: [call('c2', 2)] })));
  h.env.setVisible(true);
  await settle();
  assert.equal(h.server.paths.length, n + 2, '显示后立即拉一次（并在响应后立即挂起下一个）');
  assert.match(h.server.paths[n], /offset=5&boot=BH/, '用原 offset');
  assert.deepEqual(h.ids(), ['c:c1', 'c:c2']);
  assert.equal(h.feed.currentWait(), MAX_WAIT, '隐藏不会把 wait 调低');
  h.feed.stop();
});

test('kick：跳过 retry_ms 的等待立即请求；打断挂起中的长轮询并立即再拉一次（发送消息后用），不计数、不退避', async () => {
  const h = harness();
  h.server.push(ok(resp({ full: true, offset: 5, retry_ms: 750, calls: [call('c1', 1)] })));
  h.feed.start();
  await settle();
  assert.equal(h.server.paths.length, 1, '正在等 750ms 的间隔');
  h.server.push(ok(resp({ offset: 6, calls: [call('c2', 2)] })));
  h.feed.kick();
  await settle();
  assert.equal(h.server.paths.length, 3, 'kick 跳过间隔立即请求，响应后立即挂起下一个');
  assert.deepEqual(h.ids(), ['c:c1', 'c:c2']);

  // 此时有一个挂起中的长轮询：kick 把它打断并立即重发
  const before = h.server.paths.length;
  h.feed.kick();
  await settle();
  assert.equal(h.server.paths.length, before + 1);
  assert.equal(h.snap().error, null, '自己中止的不算失败');
  h.server.push(ok(resp({ offset: 7, calls: [call('c3', 3)] })));
  await settle();
  assert.deepEqual(h.ids(), ['c:c1', 'c:c2', 'c:c3']);
  h.feed.stop();
});

test('会话结束：收到 revoked/archived 的 state 后停止循环；一次性读取只做一次 full；两者仍可往上翻页', async () => {
  const h = harness();
  h.server.push(ok(resp({ full: true, offset: 1, older: 'x', calls: [call('c1', 100)], state: { status: 'active' } })), ok(resp({ offset: 2, state: { status: 'archived' } })));
  h.feed.start();
  await settle();
  assert.equal(h.snap().state.status, 'archived');
  assert.equal(h.snap().stopped, true);
  const n = h.server.paths.length;
  await h.env.advance(120_000);
  assert.equal(h.server.paths.length, n, '结束后不再轮询');
  h.server.push(page([call('c0', 50)], [], null));
  assert.equal(await h.feed.loadOlder(), true, '结束的会话仍可翻页');
  h.feed.stop();

  const once = harness({ once: true });
  once.server.push(ok(resp({ full: true, offset: 1, older: 'x', calls: [call('c1', 100)] })));
  once.feed.start();
  await settle();
  await once.env.advance(120_000);
  assert.equal(once.server.paths.length, 1, 'once：只做一次 full');
  assert.equal(once.snap().stopped, true);
  assert.equal(once.snap().loaded, true);
  assert.equal(once.snap().hasOlder, true);
  once.feed.stop();
});

test('stop 后立刻 start：旧循环不会和新循环同时跑（同一时刻只有一个挂起的 feed 请求），用原 offset 继续', async () => {
  const h = harness();
  h.server.push(ok(resp({ full: true, offset: 5, boot: 'BR', calls: [call('c1', 1)] })));
  h.feed.start();
  await settle();
  assert.equal(h.server.paths.length, 2, '第 2 个请求正在挂起');
  h.feed.stop();
  h.feed.start();
  await settle();
  assert.equal(h.server.paths.length, 3, '重启后只多一个请求');
  assert.match(h.server.paths[2], /offset=5&boot=BR/, '用原 offset');
  h.server.push(ok(resp({ offset: 6, boot: 'BR', calls: [call('c2', 2)] })));
  await settle();
  assert.deepEqual(h.ids(), ['c:c1', 'c:c2']);
  assert.equal(h.server.paths.length, 4, '响应后只有一个新的挂起请求');
  h.feed.stop();
});

// ---------- 负载模拟（R18、R30） ----------

/** 像真实服务端：按当前 rev 合并增量；没有新东西就挂起，直到有更新。 */
function liveServer(retryMs) {
  let rev = 100;
  const rows = [];
  const waiters = [];
  const paths = [];
  const reply = (offset) => ({
    boot: 'L', offset: rev, full: offset === null, more: false, retry_ms: retryMs, wait: 25,
    calls: rows.filter((r) => offset === null || r.rev > offset).map((r) => r.call), messages: [],
  });
  return {
    paths,
    update(i) { rev += 1; rows.push({ rev, call: call(`c${i}`, 1000 + i) }); for (const wake of waiters.splice(0)) wake(); },
    fetchJson(path, signal) {
      paths.push(path);
      const m = /offset=(\d+)/.exec(path);
      const offset = m ? Number(m[1]) : null;
      if (offset === null || offset < rev) return Promise.resolve(reply(offset));
      return new Promise((resolve, reject) => {
        const wake = () => resolve(reply(offset));
        waiters.push(wake);
        signal.addEventListener('abort', () => { const i = waiters.indexOf(wake); if (i >= 0) waiters.splice(i, 1); reject(abortError()); }, { once: true });
      });
    },
  };
}

/** 每秒 10 次更新持续 30 秒（流式回复突发），返回请求开始时刻与最终收到的调用数。 */
async function streamLoad(retryMs) {
  const srv = liveServer(retryMs);
  const times = [];
  const h = harness({ fetchJson: (path, signal) => { times.push(h.env.now()); return srv.fetchJson(path, signal); } });
  h.feed.start();
  await settle();
  for (let i = 0; i < 300; i++) { srv.update(i); await h.env.advance(100); }
  await h.env.advance(1000); // 让最后一批也送达
  const got = h.snap().calls.length;
  h.feed.stop();
  return { times, got };
}

test('手机通道（retry_ms=750）每秒 10 次更新持续 30 秒：每客户端请求数 ≤ 45，相邻请求开始间隔不少于 750ms，一条不丢', async () => {
  const { times, got } = await streamLoad(750);
  assert.ok(times.length <= 45, `请求数 ${times.length}`);
  assert.ok(times.length >= 30, `请求数 ${times.length}（不能靠掉请求来达标）`);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 750, `第 ${i} 个请求距上一个 ${times[i] - times[i - 1]}ms`);
  assert.equal(got, 300, '合并后的响应起到所有更新，不丢');
});

test('本机通道（retry_ms=0）同样负载：客户端不自己加间隔，每次更新都立即再拉（流式实时）', async () => {
  const { times, got } = await streamLoad(0);
  assert.ok(times.length >= 290, `请求数 ${times.length}`);
  assert.equal(got, 300);
});

// ---------- 自适应等待（R7、R20） ----------

test('自适应等待的档位：25→12→6→0，恢复时 0→6→12→25', () => {
  assert.deepEqual([25, 12, 6, 0].map(halve), [12, 6, 0, 0]);
  assert.deepEqual([0, 6, 12, 25].map((w) => grow(w, 25)), [6, 12, 25, 25]);
  assert.equal(grow(0, 0), 0);
});

test('已挂起 ≥ 5s 后被断（网络错误/502/504/524）连续 2 次 → wait 减半并按渠道存储；中间有一次成功就清零', async () => {
  const h = harness();
  h.server.push(
    ok(resp({ full: true, offset: 1 })),
    { afterMs: 10_000, error: netError() },
    { afterMs: 10_000, error: httpError(524) },
  );
  h.feed.start();
  await settle();
  await h.env.advance(10_000); // 第 1 次被掰
  assert.equal(h.feed.currentWait(), 25, '第 1 次不改');
  await h.env.advance(1000 + 10_000); // 退避 1s + 第 2 次被掰
  assert.equal(h.feed.currentWait(), 12);
  assert.equal(JSON.parse(h.stored.get('wait:test')).wait, 12, '按渠道存储');
  assert.match(h.feedPaths().at(-1), /wait=25/, '这一次仍用旧的 wait');
  h.feed.stop();

  const g = harness();
  g.server.push(
    ok(resp({ full: true, offset: 1 })),
    { afterMs: 10_000, error: httpError(502) },
    ok(resp({ offset: 2 })),
    { afterMs: 10_000, error: httpError(504) },
  );
  g.feed.start();
  await settle();
  await g.env.advance(30_000);
  assert.equal(g.feed.currentWait(), 25, '不是连续的，不调低');
  g.feed.stop();
});

test('挂起不足 5s 就失败的（daemon 重启时隧道立即返回的 502）不计数；请求期间出现 offline 的失败不计数（R7、R20）', async () => {
  const h = harness();
  h.server.push(ok(resp({ full: true, offset: 1 })), ...Array.from({ length: 4 }, () => ({ afterMs: 100, error: httpError(502) })));
  h.feed.start();
  await settle();
  await h.env.advance(60_000);
  assert.ok(h.server.paths.length >= 5, '退避重试了多次');
  assert.equal(h.feed.currentWait(), 25, '立即返回的 502 不降 wait');
  h.feed.stop();

  const g = harness();
  g.server.push(ok(resp({ full: true, offset: 1 })), ...Array.from({ length: 3 }, () => ({ afterMs: 10_000, error: netError() })));
  g.feed.start();
  await settle();
  await g.env.advance(1);
  g.env.emit('offline');
  await g.env.advance(10_000 + 1000);
  await g.env.advance(1);
  g.env.emit('offline');
  await g.env.advance(10_000 + 2000);
  assert.equal(g.feed.currentWait(), 25, '离线期间的断开不计数');
  g.feed.stop();
});

test('服务端降级（响应 wait:0）不改存储的 wait，只按 retry_ms=2500 退让为短轮询节奏', async () => {
  const h = harness();
  h.server.push(
    ok(resp({ full: true, offset: 1 })),
    ok(resp({ offset: 1, wait: 0, retry_ms: 2500 })),
    ok(resp({ offset: 1, wait: 0, retry_ms: 2500 })),
  );
  h.feed.start();
  await settle();
  assert.equal(h.server.paths.length, 2, 'full 后立即请求第 2 个（响应 wait:0）');
  await h.env.advance(2499);
  assert.equal(h.server.paths.length, 2);
  await h.env.advance(1);
  assert.equal(h.server.paths.length, 3);
  assert.equal(h.feed.currentWait(), 25, '不改 wait');
  assert.equal(h.stored.size, 0, '也不写存储');
  h.feed.stop();
});

test('从存储读到的旧档位在 10 分钟后尝试恢复更长的 wait（0→6）并再次存储', async () => {
  const env = fakeEnv();
  const server = fakeServer(env);
  const stored = new Map([['wait:test', JSON.stringify({ wait: 0, at: env.now() })]]);
  const storage = { get: (k) => stored.get(k) ?? null, set: (k, v) => stored.set(k, v) };
  const feed = new SessionFeed({ sessionId: 'S', fetchJson: server.fetchJson, limit: 20, env, storage, storageKey: 'wait:test' });
  assert.equal(feed.currentWait(), 0, '读到存储的档位');
  server.push(ok(resp({ full: true, offset: 1, wait: 0 })), ...Array.from({ length: 400 }, () => ok(resp({ offset: 1, wait: 0 }))));
  feed.start();
  await settle();
  assert.match(server.paths[0], /wait=0/);
  await env.advance(RESTORE_MS - 3000);
  assert.equal(feed.currentWait(), 0, '还没到 10 分钟');
  await env.advance(8000);
  assert.equal(feed.currentWait(), 6, '到期后往回走一档：0→6');
  assert.equal(JSON.parse(stored.get('wait:test')).wait, 6);
  feed.stop();
});

// ---------- 与守护进程的时间线键一致 ----------

test('时间线键：比较、编码与守护进程 src/feed/timeline.ts 一致；timeOf 同时认毫秒数与 ISO 字符串', async (t) => {
  assert.equal(timeOf(1700000000123), 1700000000123);
  assert.equal(timeOf('2026-10-01T00:00:00.123Z'), Date.parse('2026-10-01T00:00:00.123Z'));
  assert.equal(timeOf(null), 0);
  let server;
  try { server = await import('../../../dist/feed/timeline.js'); } catch { t.skip('dist 还没有构建'); return; }
  const keys = [];
  for (const tt of [1, 2, 2, 2, 3]) for (const kind of ['c', 'm']) for (const id of ['a', 'b', 'a.b']) keys.push({ t: tt, kind, id });
  for (const a of keys) {
    assert.equal(encodeKey(a), server.encodeKey(a));
    for (const b of keys) assert.equal(Math.sign(compareKeys(a, b)), Math.sign(server.compareKeys(a, b)), `${encodeKey(a)} vs ${encodeKey(b)}`);
  }
});
