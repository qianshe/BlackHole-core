import test from 'node:test';
import assert from 'node:assert/strict';
import { FeedRegistry } from '../src/feed/registry.ts';

// useSessionFeed 的引用计数登记表（R8：同一会话只有一条长轮询）。「延后一拍」由测试手动触发，结果确定。

function setup() {
  const log = [];
  const deferred = [];
  const reg = new FeedRegistry({
    start: (item) => log.push(`start:${item.name}`),
    stop: (item) => log.push(`stop:${item.name}`),
    defer: (fn) => { const d = { fn, cancelled: false }; deferred.push(d); return () => { d.cancelled = true; }; },
  });
  const flush = () => { for (const d of deferred.splice(0)) if (!d.cancelled) d.fn(); };
  let created = 0;
  const get = (key) => reg.slot(key, () => { created += 1; return { name: key }; });
  return { reg, log, flush, get, created: () => created };
}

test('同一个键的多个使用者共用一个条目，只创建一次、只启动一次；不同键互不影响', () => {
  const h = setup();
  const a1 = h.get('a'), a2 = h.get('a'), b = h.get('b');
  assert.equal(a1, a2);
  assert.notEqual(a1, b);
  assert.equal(h.created(), 2);
  h.reg.acquire('a', a1);
  h.reg.acquire('a', a2);
  assert.deepEqual(h.log, ['start:a'], '第二个使用者不再启动');
  assert.equal(a1.refs, 2);
  h.reg.acquire('b', b);
  assert.deepEqual(h.log, ['start:a', 'start:b']);
});

test('还有别的使用者时释放不停；最后一个释放后延后一拍才停并从表里删掉', () => {
  const h = setup();
  const s = h.get('a');
  const r1 = h.reg.acquire('a', s), r2 = h.reg.acquire('a', s);
  r1(); h.flush();
  assert.deepEqual(h.log, ['start:a'], '还有一个使用者');
  r2();
  assert.deepEqual(h.log, ['start:a'], '最后一个释放后还没到那一拍，不停');
  assert.equal(h.reg.size(), 1);
  h.flush();
  assert.deepEqual(h.log, ['start:a', 'stop:a']);
  assert.equal(h.reg.size(), 0);
});

test('React 严格模式 / 同会话组件换挂：释放后在那一拍之前又登记，不停、不重新创建、不重新启动', () => {
  const h = setup();
  const s = h.get('a');
  const release = h.reg.acquire('a', s);
  release();
  const again = h.reg.acquire('a', h.get('a'));
  h.flush();
  assert.deepEqual(h.log, ['start:a']);
  assert.equal(h.created(), 1);
  assert.equal(h.reg.size(), 1);
  again(); h.flush();
  assert.deepEqual(h.log, ['start:a', 'stop:a']);
});

test('停掉之后再来的使用者拿到全新的条目并重新启动（重新打开会话是全新的 full）', () => {
  const h = setup();
  h.reg.acquire('a', h.get('a'))();
  h.flush();
  assert.equal(h.reg.size(), 0);
  const s2 = h.get('a');
  assert.equal(h.created(), 2);
  h.reg.acquire('a', s2);
  assert.deepEqual(h.log, ['start:a', 'stop:a', 'start:a']);
});

test('释放函数只生效一次：重复调用不会把别人的引用也减掉', () => {
  const h = setup();
  const s = h.get('a');
  const r1 = h.reg.acquire('a', s);
  h.reg.acquire('a', s);
  r1(); r1(); r1();
  assert.equal(s.refs, 1);
  h.flush();
  assert.deepEqual(h.log, ['start:a']);
});

test('渲染期取了条目但还没登记（effect 没跑）：不启动，不占引用；登记后才启动', () => {
  const h = setup();
  const s = h.get('a');
  assert.deepEqual(h.log, []);
  assert.equal(s.refs, 0);
  h.reg.acquire('a', s);
  assert.deepEqual(h.log, ['start:a']);
});

test('晚到的 effect：条目已被延后停止并删除，再登记时放回表里并重新启动，之后正常释放和停止', () => {
  const h = setup();
  const s = h.get('a');
  h.reg.acquire('a', s)();
  h.flush();
  assert.equal(h.reg.size(), 0);
  const late = h.reg.acquire('a', s);
  assert.equal(h.reg.size(), 1);
  assert.deepEqual(h.log, ['start:a', 'stop:a', 'start:a']);
  late(); h.flush();
  assert.deepEqual(h.log, ['start:a', 'stop:a', 'start:a', 'stop:a']);
  assert.equal(h.reg.size(), 0);
});

test('晚到的 effect 而表里已换成另一个条目：旧条目仍会被停掉（不泄漏），且不会把新条目从表里删掉', () => {
  const h = setup();
  const stale = h.get('a');
  h.reg.acquire('a', stale)();
  h.flush();
  const fresh = h.get('a'); // 另一个组件建的新条目
  assert.notEqual(fresh, stale);
  const late = h.reg.acquire('a', stale);
  late(); h.flush();
  assert.equal(h.log.filter((e) => e === 'stop:a').length, 2, '旧条目第二次启动后也被停了');
  assert.equal(h.reg.size(), 1, '新条目还在表里');
  assert.equal(h.get('a'), fresh);
});
