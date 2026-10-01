import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, ensureCourierMessagesTable } from '../dist/storage/db.js';
import { FeedLog, MAX_WAITERS_PER_SESSION, MAX_WAITERS_TOTAL } from '../dist/storage/feedLog.js';
import { ToolCallsRepo } from '../dist/storage/toolCalls.js';
import { SessionsRepo } from '../dist/storage/sessions.js';
import { importCourierMessagesJson } from '../dist/courier/messagesImport.js';
import { CourierMessages, purgeCourierMessagesOlderThan } from '../dist/courier/messages.js';
import { CourierHub } from '../dist/courier/hub.js';
import { CourierPairs } from '../dist/courier/pairs.js';

// session-feed 计划检查点 A：FeedLog、迁移、tool_calls 写入点、JSON 导入、会话 state 钩子。
// 后续检查点的 feed / history 接口测试也追加到这个文件。

// FeedLog.wait 的定时器是 unref 的（生产里由 HTTP 连接保持进程存活）。测试里没有别的东西撑住事件循环，
// 否则 await 一个只剩定时器的 Promise 时 Node 会报 event loop has already resolved。
const keepAlive = setInterval(() => {}, 1000);
after(() => clearInterval(keepAlive));

function makeRoot() {
  const cache = path.resolve('.cache');
  fs.mkdirSync(cache, { recursive: true });
  return fs.mkdtempSync(path.join(cache, 'feed-test-'));
}

// 没有数据库的测试用：结束后删除临时目录
function tmpDir(t) {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

// t.after 按注册顺序执行，所以「先关库再删目录」必须在同一个钩子里，否则 Windows 上会 EBUSY
function fixture(t) {
  const root = makeRoot();
  const file = path.join(root, 'state.sqlite');
  let storage = openDb(file);
  t.after(() => {
    try { storage.close(); } catch { /* 已关闭 */ }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root, file,
    get db() { return storage.db; },
    reopen() { storage.close(); storage = openDb(file); return storage.db; },
  };
}

const hasIndex = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(name);
const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- FeedLog ----------

test('FeedLog: next() 严格递增，current() 跟随，不同会话共用一个计数器', () => {
  const log = new FeedLog(1000);
  assert.equal(log.current(), 1000);
  assert.deepEqual([log.next('A'), log.next('B'), log.next('A')], [1001, 1002, 1003]);
  assert.equal(log.current(), 1003);
  assert.match(log.bootId, /^[0-9a-f]{12}$/);
  assert.notEqual(new FeedLog(1).bootId, new FeedLog(1).bootId);
});

test('FeedLog.seedFromDb: 取 tool_calls、courier_messages 的最大 rev 与当前时钟三者之最大（时钟拨回不倒退）', (t) => {
  const f = fixture(t);
  assert.equal(FeedLog.seedFromDb(f.db, 5000), 5000);

  const s = new SessionsRepo(f.db).create({ workspace_path: f.root, permission_mode: 'read-only' });
  const call = new ToolCallsRepo(f.db).start(s.id, 'tool', '{}', 'h');
  f.db.prepare('UPDATE tool_calls SET rev = ? WHERE id = ?').run(9_000_000, call.id);
  assert.equal(FeedLog.seedFromDb(f.db, 5000), 9_000_000, '已存 rev 比墙钟大（墙钟被拨回），取已存值');

  f.db.prepare("INSERT INTO courier_messages (id, session_id, kind, text, at, status, rev) VALUES ('m1', ?, 'user', 'hi', 1, 'sent', ?)").run(s.id, 12_000_000);
  assert.equal(FeedLog.seedFromDb(f.db, 5000), 12_000_000);
  assert.equal(FeedLog.seedFromDb(f.db, 99_000_000), 99_000_000, '墙钟更大时取墙钟');
  assert.equal(FeedLog.open(f.db, 5000).current(), 12_000_000);
});

test('FeedLog.wait: 同会话的 next() 在微任务里唤醒，其他会话不受影响，超时返回 timeout', async () => {
  const log = new FeedLog(0);
  let woken = false;
  const a = log.wait('A', 5).then((r) => { woken = true; return r; });
  const b = log.wait('B', 0.05);
  log.next('A');
  assert.equal(woken, false, '唤醒不能早于写入所在的同步代码块结束');
  assert.equal(await a, 'changed');
  assert.equal(await b, 'timeout');
  assert.equal(log.waiting(), 0, '等待者都已移除，没有泄漏');
});

test('FeedLog.wait: AbortSignal 中止后立即移除等待者；已中止的信号直接返回 aborted', async () => {
  const log = new FeedLog(0);
  const ac = new AbortController();
  const p = log.wait('A', 25, ac.signal);
  assert.equal(log.waiting('A'), 1);
  ac.abort();
  assert.equal(await p, 'aborted');
  assert.equal(log.waiting(), 0);
  assert.equal(await log.wait('A', 25, ac.signal), 'aborted');
  assert.equal(log.waiting(), 0);
});

test('FeedLog.wait: 每会话 16、全局 128 的上限，超出立即 degraded；shutdown 放走所有等待者', async () => {
  const log = new FeedLog(0);
  const same = Array.from({ length: MAX_WAITERS_PER_SESSION }, () => log.wait('A', 25));
  assert.equal(await log.wait('A', 25), 'degraded');
  assert.equal(log.waiting('A'), MAX_WAITERS_PER_SESSION);
  log.shutdown();
  assert.deepEqual(new Set(await Promise.all(same)), new Set(['shutdown']));
  assert.equal(log.waiting(), 0);

  const many = [];
  for (let s = 0; s < MAX_WAITERS_TOTAL / MAX_WAITERS_PER_SESSION; s++) {
    for (let i = 0; i < MAX_WAITERS_PER_SESSION; i++) many.push(log.wait(`S${s}`, 25));
  }
  assert.equal(log.waiting(), MAX_WAITERS_TOTAL);
  assert.equal(await log.wait('another', 25), 'degraded', '全局上限');
  log.shutdown();
  await Promise.all(many);
  assert.equal(log.waiting(), 0);
});

test('FeedLog.close: 答复该会话的所有挂起请求为 closed，不影响其他会话，并丢弃缓存的 state', async () => {
  const log = new FeedLog(0);
  log.setStateProvider((id) => ({ id }));
  assert.ok(log.stateOf('A'));
  const a1 = log.wait('A', 25);
  const a2 = log.wait('A', 25);
  const b = log.wait('B', 0.05);
  log.close('A');
  assert.deepEqual(await Promise.all([a1, a2]), ['closed', 'closed']);
  assert.equal(await b, 'timeout');
  // 缓存已丢：stateOf 会重建，所以拿到的是新 rev
  const before = log.current();
  assert.ok(log.stateOf('A'));
  assert.equal(log.current(), before + 1);
});

test('FeedLog.touchState: 只有快照真的变了才取新 rev 并唤醒；没变/会话不存在/provider 抛错都返回 null', async () => {
  const log = new FeedLog(100);
  assert.equal(log.touchState('A'), null, '没有 provider');
  const states = { A: { name: 'one', status: 'active' } };
  log.setStateProvider((id) => states[id] ?? null);

  const wait = log.wait('A', 5);
  assert.equal(log.touchState('A'), 101);
  assert.equal(await wait, 'changed');
  assert.equal(log.touchState('A'), null, '快照没变');
  assert.equal(log.current(), 101, '没变不消耗 rev');

  states.A = { name: 'two', status: 'active' };
  assert.equal(log.touchState('A'), 102);
  assert.deepEqual(log.stateOf('A'), { rev: 102, state: { name: 'two', status: 'active' }, json: JSON.stringify({ name: 'two', status: 'active' }) });

  assert.equal(log.touchState('missing'), null);
  assert.equal(log.stateOf('missing'), null);
  log.setStateProvider(() => { throw new Error('boom'); });
  assert.equal(log.touchState('A'), null, 'provider 抛错不能拖垮写入路径');
});

test('FeedLog.stateOf: 首次使用时现建并缓存，再次读取不变化', () => {
  const log = new FeedLog(0);
  let built = 0;
  log.setStateProvider(() => { built += 1; return { n: 1 }; });
  const first = log.stateOf('A');
  assert.equal(first.rev, 1);
  assert.equal(log.stateOf('A').rev, 1);
  assert.equal(built, 1);
});

// ---------- 迁移 ----------

test('迁移：新库有 tool_calls.rev 列与索引、courier_messages 表与两个索引；重复打开幂等', (t) => {
  const f = fixture(t);
  const check = (db) => {
    assert.ok(columns(db, 'tool_calls').includes('rev'));
    assert.ok(hasIndex(db, 'idx_tool_calls_session_rev'));
    assert.deepEqual(columns(db, 'courier_messages'), [
      'id', 'session_id', 'kind', 'text', 'at', 'status', 'site', 'target_id', 'conversation_key', 'code', 'message',
      'model', 'images', 'turn', 'segment', 'message_id', 'question_json', 'rev',
    ]);
    assert.ok(hasIndex(db, 'idx_courier_messages_session_rev'));
    assert.ok(hasIndex(db, 'idx_courier_messages_session_at'));
  };
  check(f.db);
  check(f.reopen());
  check(f.reopen());
  const mem = new DatabaseSync(':memory:');
  ensureCourierMessagesTable(mem);
  ensureCourierMessagesTable(mem);
  assert.equal(columns(mem, 'courier_messages').length, 18);
});

test('迁移：带旧 CHECK（没有 awaiting）、没有 rev 的旧库走重建路径后仍有 rev，旧行 rev = rowid，幂等', (t) => {
  const root = tmpDir(t);
  const file = path.join(root, 'legacy.sqlite');
  const legacy = new DatabaseSync(file);
  legacy.exec(`CREATE TABLE tool_calls (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    tool TEXT NOT NULL,
    args_json TEXT NOT NULL,
    args_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('started','completed','failed','unknown')),
    result_summary TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  const insert = legacy.prepare("INSERT INTO tool_calls (id, session_id, tool, args_json, args_hash, status, created_at, updated_at) VALUES (?, 's', 'tool', '{}', 'h', 'completed', ?, ?)");
  for (const [id, at] of [['c1', 10], ['c2', 20], ['c3', 30]]) insert.run(id, at, at);
  legacy.close();

  let storage = openDb(file);
  try {
    const db = storage.db;
    assert.ok(columns(db, 'tool_calls').includes('rev'));
    assert.ok(hasIndex(db, 'idx_tool_calls_session_rev'));
    const revs = db.prepare('SELECT id, rev, rowid AS r FROM tool_calls ORDER BY rowid').all();
    assert.deepEqual(revs.map((x) => x.id), ['c1', 'c2', 'c3']);
    for (const x of revs) assert.equal(x.rev, x.r, `${x.id} 的 rev 应等于 rowid`);
    assert.ok(revs.every((x) => x.rev > 0));
    // 重建后的 CHECK 允许 awaiting
    db.prepare("INSERT INTO tool_calls (id, session_id, tool, args_json, args_hash, status, created_at, updated_at, rev) VALUES ('c4', 's', 't', '{}', 'h', 'awaiting', 40, 40, 4)").run();
    // 旧行的 rev 远小于任何毫秒时钟起始值
    assert.ok(FeedLog.seedFromDb(db, 1_700_000_000_000) === 1_700_000_000_000);
    storage.close();
    storage = openDb(file);
    const again = storage.db.prepare('SELECT id, rev FROM tool_calls ORDER BY rowid').all();
    assert.deepEqual(again.map((x) => x.rev), [...revs.map((x) => x.rev), 4], '重复迁移不改变已有 rev');
  } finally {
    storage.close();
  }
});

// ---------- tool_calls 写入点 ----------

function callsFixture(t) {
  const f = fixture(t);
  const log = FeedLog.open(f.db);
  const sessions = new SessionsRepo(f.db);
  const repo = new ToolCallsRepo(f.db, log);
  const make = () => sessions.create({ workspace_path: f.root, permission_mode: 'read-only' });
  const rev = (id) => repo.get(id).rev;
  return { ...f, log, repo, make, rev };
}

test('tool_calls：6 个写入点都取新 rev，且只唤醒本会话的等待者', async (t) => {
  const f = callsFixture(t);
  const A = f.make().id;
  const B = f.make().id;
  const a = f.repo.start(A, 'tool', '{}', 'h1');
  const b = f.repo.start(B, 'tool', '{}', 'h2');
  assert.ok(a.rev > 0 && b.rev > a.rev, 'start 写 rev');
  const seed = FeedLog.seedFromDb(f.db, 0);
  assert.equal(seed, b.rev, '库里的最大 rev 就是最后一次写入');

  // 前面写入排队的唤醒微任务先排空，再注册等待者（唤醒只是提示，同一同步段里晚注册的等待者会被前面的写入唤醒）
  await sleep(1);
  const waitA = f.log.wait(A, 5);
  const waitB = f.log.wait(B, 0.05);

  let prev = f.rev(a.id);
  const steps = [
    ['awaitApproval', () => f.repo.awaitApproval(a.id)],
    ['setApprovalScope', () => f.repo.setApprovalScope(a.id, 'session')],
    ['resume', () => f.repo.resume(a.id)],
    ['finish', () => f.repo.finish(a.id, 'completed', 'ok')],
  ];
  for (const [name, run] of steps) {
    run();
    const next = f.rev(a.id);
    assert.ok(next > prev, `${name} 应取新 rev（${prev} -> ${next}）`);
    prev = next;
  }
  assert.equal(f.rev(b.id), b.rev, '另一会话的行不受影响');
  assert.equal(f.repo.get(a.id).status, 'completed');
  assert.equal(f.repo.get(a.id).approval_scope, 'session');
  assert.equal(await waitA, 'changed');
  assert.equal(await waitB, 'timeout', '另一会话的等待者不被唤醒');
});

test('tool_calls.resume：不是 awaiting 时是空操作，不取 rev，也不唤醒', async (t) => {
  const f = callsFixture(t);
  const call = f.repo.start(f.make().id, 'tool', '{}', 'h');
  await sleep(1); // 排空 start 排队的唤醒微任务
  const before = f.log.current();
  f.repo.resume(call.id);
  f.repo.resume('no-such-call');
  assert.equal(f.log.current(), before);
  assert.equal(f.rev(call.id), call.rev);
  assert.equal(await f.log.wait(call.session_id, 0.05), 'timeout');
});

test('tool_calls.markStaleStartedAsUnknown：每行各取一个递增 rev，只改 started/awaiting，没有候选行时不消耗 rev', (t) => {
  const f = callsFixture(t);
  const A = f.make().id;
  const B = f.make().id;
  const started = f.repo.start(A, 'tool', '{}', 'h1');
  const awaiting = f.repo.start(B, 'tool', '{}', 'h2');
  f.repo.awaitApproval(awaiting.id);
  const done = f.repo.start(A, 'tool', '{}', 'h3');
  f.repo.finish(done.id, 'completed', 'ok');
  const doneRev = f.rev(done.id);
  const startedRev = f.rev(started.id);
  const awaitingRev = f.rev(awaiting.id);

  assert.equal(f.repo.markStaleStartedAsUnknown(), 2);
  const s = f.repo.get(started.id);
  const a = f.repo.get(awaiting.id);
  assert.equal(s.status, 'unknown');
  assert.equal(a.status, 'unknown');
  assert.equal(s.result_summary, 'interrupted by daemon restart');
  assert.ok(s.rev > startedRev && a.rev > awaitingRev && s.rev !== a.rev, '两行各有自己的新 rev');
  assert.equal(f.rev(done.id), doneRev, '已完成的行不动');

  const after = f.log.current();
  assert.equal(f.repo.markStaleStartedAsUnknown(), 0);
  assert.equal(f.log.current(), after, '没有候选行不消耗 rev');
});

test('tool_calls：没有 FeedLog 时行为不变——start 写 0，更新不清零已有的 rev', (t) => {
  const f = callsFixture(t);
  const plain = new ToolCallsRepo(f.db);
  const A = f.make().id;
  const fresh = plain.start(A, 'tool', '{}', 'h');
  assert.equal(fresh.rev, 0);

  const stamped = f.repo.start(A, 'tool', '{}', 'h2');
  assert.ok(stamped.rev > 0);
  plain.awaitApproval(stamped.id);
  plain.setApprovalScope(stamped.id, 'once');
  plain.resume(stamped.id);
  plain.finish(stamped.id, 'failed', 'x');
  const row = plain.get(stamped.id);
  assert.equal(row.status, 'failed');
  assert.equal(row.rev, stamped.rev, '没有 FeedLog 的写入保持 rev 不变');
  assert.equal(plain.markStaleStartedAsUnknown(), 1, '只有 fresh 这一条还是 started');
  assert.equal(plain.get(fresh.id).rev, 0);
});

// ---------- JSON 导入 ----------

function memoryDb() {
  const db = new DatabaseSync(':memory:');
  ensureCourierMessagesTable(db);
  return db;
}

function writeJson(root, body, name = 'courier-messages.json') {
  const file = path.join(root, name);
  fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
  return file;
}

test('JSON 导入：字段一一映射，rev 保留或给 0，缺 id 的补 id，文件改名为 .migrated，下次跳过', (t) => {
  const root = tmpDir(t);
  const db = memoryDb();
  const question = { title: 'pick one', options: ['a', 'b'], skip: true, input: false, answered: true, answer: 'a' };
  const file = writeJson(root, {
    v: 1,
    sessions: {
      A: [
        { id: 'm1', sessionId: 'A', kind: 'user', text: 'hello', at: 10, status: 'sent', site: 'chatgpt', targetId: 't1', conversationKey: 'k1', images: 2, rev: 5 },
        { id: 'm2', sessionId: 'A', kind: 'agent', text: 'reply', at: 20, status: 'reply', model: 'gpt', turn: 3, segment: 's1', messageId: 'mid', code: 'c', message: 'msg', question },
      ],
      B: [{ sessionId: 'B', kind: 'agent', text: 'no id', at: 5, status: 'streaming' }, { sessionId: 'B', kind: 'agent', at: 6 }, null],
    },
  });
  const logs = [];
  const result = importCourierMessagesJson(db, file, (l) => logs.push(l));
  assert.deepEqual(result, { status: 'imported', imported: 3 });
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(`${file}.migrated`), true);

  const rows = db.prepare('SELECT * FROM courier_messages ORDER BY session_id, at').all();
  assert.equal(rows.length, 3, '没有 text 的条目和空值被丢弃');
  const [m1, m2, m3] = rows;
  assert.deepEqual({ ...m1 }, {
    id: 'm1', session_id: 'A', kind: 'user', text: 'hello', at: 10, status: 'sent', site: 'chatgpt', target_id: 't1',
    conversation_key: 'k1', code: null, message: null, model: null, images: 2, turn: null, segment: null, message_id: null,
    question_json: null, rev: 5,
  });
  assert.equal(m2.rev, 0, '缺 rev 给 0');
  assert.equal(m2.turn, 3);
  assert.equal(m2.segment, 's1');
  assert.equal(m2.message_id, 'mid');
  assert.equal(m2.model, 'gpt');
  assert.deepEqual(JSON.parse(m2.question_json), question);
  assert.match(m3.id, /^[0-9a-f-]{36}$/, '缺 id 的补 UUID');
  assert.equal(m3.session_id, 'B');
  assert.ok(logs.some((l) => l.includes('imported 3')));

  assert.deepEqual(importCourierMessagesJson(db, file), { status: 'skipped', imported: 0, reason: 'no_file' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM courier_messages').get().n, 3);
});

test('JSON 导入：表非空时跳过，文件原样保留（已导入过一次）', (t) => {
  const root = tmpDir(t);
  const db = memoryDb();
  db.prepare("INSERT INTO courier_messages (id, session_id, kind, text, at, status) VALUES ('x', 'A', 'user', 'already', 1, 'sent')").run();
  const file = writeJson(root, { v: 1, sessions: { A: [{ id: 'y', text: 'new', at: 2, kind: 'user', status: 'sent' }] } });
  assert.deepEqual(importCourierMessagesJson(db, file), { status: 'skipped', imported: 0, reason: 'table_not_empty' });
  assert.equal(fs.existsSync(file), true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM courier_messages').get().n, 1);
});

test('JSON 导入：文件损坏或形状不对——记日志、保留文件、表保持为空，不抛错', (t) => {
  const root = tmpDir(t);
  const db = memoryDb();
  const logs = [];
  const broken = writeJson(root, '{ not json', 'broken.json');
  assert.deepEqual(importCourierMessagesJson(db, broken, (l) => logs.push(l)), { status: 'failed', imported: 0, reason: 'unreadable' });
  assert.equal(fs.existsSync(broken), true);

  const odd = writeJson(root, { v: 1, sessions: [] }, 'odd.json');
  assert.deepEqual(importCourierMessagesJson(db, odd, (l) => logs.push(l)), { status: 'failed', imported: 0, reason: 'bad_shape' });
  assert.equal(fs.existsSync(odd), true);

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM courier_messages').get().n, 0);
  assert.equal(logs.length, 2);

  // 没有 sessions 字段的空壳文件是合法的：导入 0 条并改名
  const empty = writeJson(root, { v: 1 }, 'empty.json');
  assert.deepEqual(importCourierMessagesJson(db, empty), { status: 'imported', imported: 0 });
  assert.equal(fs.existsSync(`${empty}.migrated`), true);
});

// ---------- SessionsRepo state 钩子 ----------

test('SessionsRepo.onStateChange：setName/setStatus（含草稿分支）都通知，草稿丢弃不通知，结束时先 onSessionEnded 再通知', (t) => {
  const f = fixture(t);
  const repo = new SessionsRepo(f.db);
  const events = [];
  repo.onStateChange = (id) => events.push(['state', id]);
  repo.onSessionEnded = (id, reason) => events.push(['ended', id, reason]);

  const stored = repo.create({ workspace_path: f.root, permission_mode: 'read-only' });
  repo.setName(stored.id, 'renamed');
  repo.setStatus(stored.id, 'paused');
  assert.deepEqual(events.splice(0), [['state', stored.id], ['state', stored.id]]);
  assert.equal(repo.get(stored.id).name, 'renamed');
  assert.equal(repo.get(stored.id).status, 'paused');

  repo.setStatus(stored.id, 'archived');
  assert.deepEqual(events.splice(0), [['ended', stored.id, 'archived'], ['state', stored.id]], '先结束清理，再重建 state');

  const draft = repo.createDraft({ workspace_path: f.root, permission_mode: 'read-only' });
  events.length = 0;
  assert.equal(repo.setName(draft.id, 'draft name').name, 'draft name');
  assert.equal(repo.setStatus(draft.id, 'paused').status, 'paused');
  assert.deepEqual(events.splice(0), [['state', draft.id], ['state', draft.id]], '草稿分支不走 SQL，钩子仍要触发');

  assert.equal(repo.setStatus(draft.id, 'revoked').status, 'revoked');
  assert.deepEqual(events.splice(0), [['ended', draft.id, 'discarded']], '草稿丢弃只走 onSessionEnded，不再通知 state');
});

test('SessionsRepo.onStateChange：回调抛错不影响写入与返回值；不设回调时行为不变', (t) => {
  const f = fixture(t);
  const repo = new SessionsRepo(f.db);
  const s = repo.create({ workspace_path: f.root, permission_mode: 'read-only' });
  assert.equal(repo.setName(s.id, 'plain').name, 'plain');
  repo.onStateChange = () => { throw new Error('listener failed'); };
  assert.equal(repo.setName(s.id, 'still works').name, 'still works');
  assert.equal(repo.setStatus(s.id, 'paused').status, 'paused');
  assert.equal(repo.get(s.id).status, 'paused');
});

// ---------- 与 FeedLog 接起来：会话改名经 touchState 唤醒等待者 ----------

test('state 链路：SessionsRepo.onStateChange → FeedLog.touchState → 等待者收到 changed，重复改同一名称不再唤醒', async (t) => {
  const f = fixture(t);
  const repo = new SessionsRepo(f.db);
  const log = FeedLog.open(f.db);
  log.setStateProvider((id) => {
    const s = repo.get(id);
    return s ? { name: s.name, status: s.status } : null;
  });
  repo.onStateChange = (id) => log.touchState(id);
  const s = repo.create({ workspace_path: f.root, permission_mode: 'read-only' });
  assert.ok(log.stateOf(s.id));
  await sleep(1); // 排空 stateOf 取 rev 时排队的唤醒，以免它把下面的等待者提前唤醒

  const wake = log.wait(s.id, 5);
  repo.setName(s.id, 'first');
  assert.equal(await wake, 'changed');
  assert.equal(log.stateOf(s.id).state.name, 'first');

  const rev = log.current();
  repo.setName(s.id, 'first');
  assert.equal(log.current(), rev, '快照没变不取新 rev');
  assert.equal(await log.wait(s.id, 0.05), 'timeout');
  await sleep(1);
});

// ---------- CourierMessages（SQLite 实现） ----------

const base = { kind: 'agent', status: 'reply', site: 'chatgpt', targetId: 't-1', conversationKey: 'k' };

function messagesFixture() {
  const db = memoryDb();
  const log = FeedLog.open(db);
  return { db, log, store: new CourierMessages(db, log) };
}

test('CourierMessages：add / upsertSegment / 补 messageId / finishStreaming 都从共享的 FeedLog 取递增 rev，且只唤醒本会话的等待者', async () => {
  const { store, log } = messagesFixture();
  const first = store.add({ ...base, sessionId: 'A', text: 'one' });
  assert.ok(first.rev > 0);
  await sleep(1);
  const waitA = log.wait('A', 5);
  const waitB = log.wait('B', 0.05);

  const created = store.upsertSegment({ ...base, sessionId: 'A', segment: 'g1', text: 'par', status: 'streaming' });
  assert.ok(created.rev > first.rev);
  const finished = store.upsertSegment({ ...base, sessionId: 'A', segment: 'g1', text: 'partial done', status: 'reply' });
  assert.ok(finished.rev > created.rev);
  const settled = log.current();
  assert.equal(store.upsertSegment({ ...base, sessionId: 'A', segment: 'g1', text: 'partial done', status: 'reply' }), null, '没变不更新');
  assert.equal(log.current(), settled, '没变不消耗 rev');

  // 补 messageId 只改 id 与 rev，内容没变时仍返回 null（沿用旧行为）
  assert.equal(store.upsertSegment({ ...base, sessionId: 'A', segment: 'g1', text: 'partial done', status: 'reply', messageId: 'page-1' }), null);
  assert.ok(log.current() > settled);
  assert.equal(store.list('A').find((m) => m.segment === 'g1').messageId, 'page-1');

  store.upsertSegment({ ...base, sessionId: 'A', segment: 'g2', text: 'tail', status: 'streaming' });
  const before = log.current();
  store.finishStreaming();
  assert.ok(log.current() > before);
  assert.equal(store.list('A').find((m) => m.segment === 'g2').status, 'reply');
  assert.equal(await waitA, 'changed');
  assert.equal(await waitB, 'timeout');
});

test('CourierMessages.changedSince：只返回 rev 大于 offset 的消息，按 rev 升序、限条数（原 courier-offset 用例）', () => {
  const { store, log } = messagesFixture();
  const stream = { ...base, status: 'streaming' };
  const a = store.add({ ...base, sessionId: 'A', text: 'one' });
  const o1 = log.current();
  store.upsertSegment({ ...stream, sessionId: 'A', segment: 'g1', text: 'par' });
  store.add({ ...base, sessionId: 'B', text: 'other' });
  assert.deepEqual(store.changedSince('A', o1, 10).map((m) => m.text), ['par']);
  const o2 = log.current();
  store.upsertSegment({ ...stream, sessionId: 'A', segment: 'g1', text: 'partial done', status: 'reply' });
  const d = store.changedSince('A', o2, 10);
  assert.equal(d.length, 1);
  assert.equal(d[0].text, 'partial done');
  assert.ok(d[0].rev > o2);
  assert.equal(store.changedSince('A', log.current(), 10).length, 0);
  assert.ok(a.rev < o2);
  assert.deepEqual(store.changedSince('A', 0, 1).map((m) => m.text), ['one'], 'rev 升序：截断时先返回最早变化的');
  store.add({ ...base, sessionId: 'A', text: 'newest' });
  assert.deepEqual(store.changedSince('A', 0, 10).map((m) => m.text), ['one', 'partial done', 'newest'], '同一条记录只保留最新版本');
});

test('CourierMessages：同一个库上新建的 store（重启）读到同样的线程，新 rev 接着往上', () => {
  const db = memoryDb();
  const s1 = new CourierMessages(db, FeedLog.open(db));
  const a = s1.add({ ...base, sessionId: 'A', text: 'one' });
  const s2 = new CourierMessages(db, FeedLog.open(db));
  assert.deepEqual(s2.list('A').map((m) => m.text), ['one']);
  const b = s2.add({ ...base, sessionId: 'A', text: 'two' });
  assert.ok(b.rev > a.rev);
  assert.deepEqual(s2.changedSince('A', a.rev, 10).map((m) => m.text), ['two']);
});

test('CourierMessages.list：按 at 升序、同 at 按写入顺序；limit 取最新的若干条；默认最多 200 条', () => {
  const { store } = messagesFixture();
  for (const at of [50, 10, 30, 20, 40]) store.add({ ...base, sessionId: 'A', text: `t${at}`, at });
  assert.deepEqual(store.list('A').map((m) => m.at), [10, 20, 30, 40, 50], '晚确认的发送以 at 归位');
  assert.deepEqual(store.list('A', 3).map((m) => m.at), [30, 40, 50]);
  for (const text of ['x', 'y', 'z']) store.add({ ...base, sessionId: 'T', text, at: 7 });
  assert.deepEqual(store.list('T').map((m) => m.text), ['x', 'y', 'z']);

  const big = messagesFixture().store;
  for (let i = 0; i < 250; i++) big.add({ ...base, sessionId: 'S', text: `m${i}`, at: i });
  const list = big.list('S');
  assert.equal(list.length, 200);
  assert.equal(list[0].text, 'm50');
  assert.equal(list.at(-1).text, 'm249');
  assert.equal(big.list('S', 1000).length, 250, '显式 limit 可以读更多');
});

test('保留期清扫 purgeCourierMessagesOlderThan：只删 at 早于切点的回复（跨会话），返回条数，边界当天的保留，清扫后 list / changedSince / rev 仍正常', () => {
  const { db, log, store } = messagesFixture();
  const DAY = 24 * 60 * 60_000, now = 1_800_000_000_000, cutoff = now - 7 * DAY;
  store.add({ ...base, sessionId: 'A', text: 'old-a', at: cutoff - DAY });
  store.add({ ...base, sessionId: 'B', text: 'old-b', at: cutoff - 1 });
  const edge = store.add({ ...base, sessionId: 'A', text: 'edge', at: cutoff });
  store.add({ ...base, sessionId: 'A', text: 'new-a', at: now });
  store.add({ ...base, sessionId: 'B', text: 'new-b', at: now - DAY });
  const before = log.current();
  assert.equal(purgeCourierMessagesOlderThan(db, cutoff), 2);
  assert.deepEqual(store.list('A').map((m) => m.text), ['edge', 'new-a'], 'at === cutoff 的保留');
  assert.deepEqual(store.list('B').map((m) => m.text), ['new-b']);
  assert.equal(log.current(), before, '清扫不取新的 rev（删的是早已不在任何客户端头部的旧行）');
  assert.equal(store.changedSince('A', 0, 10).length, 2);
  assert.equal(purgeCourierMessagesOlderThan(db, cutoff), 0, '幂等');
  const next = store.add({ ...base, sessionId: 'A', text: 'after purge', at: now + 1 });
  assert.ok(next.rev > edge.rev, '清扫后新的 rev 继续递增');
});

test('CourierMessages.add：同一 (conversationKey, turn) 的非分段 agent 回复只留一条，空 conversationKey 也一样', () => {
  const { store } = messagesFixture();
  assert.ok(store.add({ ...base, sessionId: 'A', text: 'a', turn: 1 }));
  assert.equal(store.add({ ...base, sessionId: 'A', text: 'again', turn: 1 }), null);
  assert.ok(store.add({ ...base, sessionId: 'A', text: 'other chat', turn: 1, conversationKey: 'k2' }));
  assert.ok(store.add({ ...base, sessionId: 'A', text: 'turn 2', turn: 2 }));
  assert.ok(store.add({ ...base, sessionId: 'B', text: 'other session', turn: 1 }));
  assert.ok(store.add({ ...base, sessionId: 'A', kind: 'user', text: 'user turn', turn: 1, status: 'sent' }), '用户消息不去重');
  assert.ok(store.add({ ...base, sessionId: 'N', text: 'n', turn: 1, conversationKey: null }));
  assert.equal(store.add({ ...base, sessionId: 'N', text: 'n again', turn: 1, conversationKey: null }), null);
  assert.ok(store.add({ ...base, sessionId: 'A', text: 'segmented', turn: 1, segment: 's' }), '分段回复不走这条去重');
});

test('CourierMessages：subscribe 收到每次新增与更新，坏监听者不拦其他监听者；drop 只删该会话', () => {
  const { store } = messagesFixture();
  const seen = [];
  const off = store.subscribe((m) => seen.push([m.sessionId, m.text, m.status]));
  store.subscribe(() => { throw new Error('bad listener'); });
  store.add({ ...base, sessionId: 'A', text: 'one' });
  store.upsertSegment({ ...base, sessionId: 'A', segment: 'g', text: 'p', status: 'streaming' });
  store.finishStreaming();
  assert.deepEqual(seen, [['A', 'one', 'reply'], ['A', 'p', 'streaming'], ['A', 'p', 'reply']]);
  off();
  store.add({ ...base, sessionId: 'B', text: 'after off' });
  assert.equal(seen.length, 3);
  assert.equal(store.drop('A'), true);
  assert.equal(store.drop('A'), false);
  assert.deepEqual(store.list('B').map((m) => m.text), ['after off']);
  assert.equal(store.list('A').length, 0);
});

test('CourierMessages.latestTurnMarker：与旧的「从尾部往前扫」逻辑在随机数据上给出一致的 asking 判断', () => {
  let seed = 12345;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  // 旧实现 hub.asking() 的循环：遇到用户消息即停（不在等）；遇到提问即停，未答才算在等
  const legacyAsking = (list) => {
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      if (m.kind === 'user') return false;
      if (m.question) return !m.question.answered;
    }
    return false;
  };
  const { store } = messagesFixture();
  let asking = 0;
  for (let s = 0; s < 300; s++) {
    const sid = `S${s}`;
    let at = 0;
    for (let i = 0, count = rnd(13); i < count; i++) {
      at += rnd(3) - (rnd(5) === 0 ? 1 : 0); // 包含相同 at 与略微乱序
      const roll = rnd(6);
      if (roll === 0) store.add({ ...base, sessionId: sid, kind: 'user', status: 'sent', text: `u${i}`, at });
      else if (roll <= 2) store.add({ ...base, sessionId: sid, text: `q${i}`, at, question: { title: 't', options: ['a'], skip: false, input: false, ...(rnd(2) ? { answered: true } : {}) } });
      else store.add({ ...base, sessionId: sid, text: `a${i}`, at });
    }
    const marker = store.latestTurnMarker(sid);
    const viaMarker = !!marker && marker.kind !== 'user' && !!marker.question && !marker.question.answered;
    assert.equal(viaMarker, legacyAsking(store.list(sid, 1000)), sid);
    if (viaMarker) asking += 1;
  }
  assert.ok(asking > 10, '随机数据要覆盖到「在等回答」的情况');
});

test('CourierMessages：list 与 latestTurnMarker 走 (session_id, at) 索引、不临时排序；5000 条的会话读取仍然有界', () => {
  const { db, store } = messagesFixture();
  const insert = db.prepare("INSERT INTO courier_messages (id, session_id, kind, text, at, status, rev) VALUES (?, 'S', ?, ?, ?, 'reply', 0)");
  db.exec('BEGIN');
  for (let i = 0; i < 5000; i++) insert.run(`id${i}`, i % 50 === 0 ? 'user' : 'agent', `m${i}`, i);
  db.exec('COMMIT');
  assert.equal(store.list('S').length, 200);
  assert.equal(store.list('S')[199].text, 'm4999');
  assert.equal(store.latestTurnMarker('S').text, 'm4950');

  const plan = (sql, ...args) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map((r) => r.detail).join(' | ');
  const plans = [
    plan('SELECT * FROM courier_messages WHERE session_id = ? ORDER BY at DESC, rowid DESC LIMIT ?', 'S', 200),
    plan("SELECT * FROM courier_messages WHERE session_id = ? AND (kind = 'user' OR question_json IS NOT NULL) ORDER BY at DESC, rowid DESC LIMIT 1", 'S'),
  ];
  for (const p of plans) {
    assert.match(p, /SEARCH courier_messages USING (COVERING )?INDEX idx_courier_messages_session_at/, p);
    assert.doesNotMatch(p, /TEMP B-TREE/, p);
  }
});

test('hub.status().asking：只在最近一条「用户消息或提问」是未答的提问时才算在等回答；已结束的会话不算', async () => {
  const { store } = messagesFixture();
  const list = [{ id: 's-q', name: 'Q', status: 'active' }, { id: 's-u', name: 'U', status: 'active' }, { id: 's-r', name: 'R', status: 'revoked' }];
  const h = new CourierHub({ sessions: () => list, messages: store });
  const card = (extra) => ({ title: 't', options: ['a'], skip: false, input: false, ...extra });
  store.add({ ...base, sessionId: 's-q', text: 'ask', question: card(), at: 2 });
  store.add({ ...base, sessionId: 's-u', text: 'ask', question: card(), at: 1 });
  store.add({ ...base, sessionId: 's-u', kind: 'user', status: 'sent', text: 'answered by sending', at: 2 });
  store.add({ ...base, sessionId: 's-r', text: 'ask', question: card(), at: 1 });
  assert.deepEqual((await h.status(false)).asking, ['s-q']);
  store.add({ ...base, sessionId: 's-q', text: 'ask again', question: card({ answered: true }), at: 3 });
  assert.deepEqual((await h.status(false)).asking, [], '最近一条提问已答');
});

// ---------- hub 的 state 钩子与 busy 兜底 ----------

function fakeConn() {
  const handlers = {};
  const sent = [];
  return {
    sent,
    on: (ev, fn) => { handlers[ev] = fn; },
    send: (text) => { sent.push(JSON.parse(text)); return true; },
    close: () => {},
    deliver: (m) => handlers.message(JSON.stringify(m)),
    drop: () => handlers.close(),
  };
}
const HELLO = { type: 'hello', client: 'blackhole-courier', protocol: 1, version: 't' };
const target = (over = {}) => ({ targetId: 't-x', site: 'chatgpt', label: 'X', conversationKey: 'c-x', sessionId: 's-x', open: true, ...over });

test('hub 的 state 钩子：hello / targets / 断连 / unpair / forget / pair 都通知相关会话，抛错的回调不影响 hub', () => {
  const list = [{ id: 's-x', name: 'X', status: 'active' }, { id: 's-y', name: 'Y', status: 'active' }];
  const touched = [];
  const h = new CourierHub({
    sessions: () => list, pairs: new CourierPairs(null),
    onStateChange: (id) => { touched.push(id); if (id === 'boom') throw new Error('listener failed'); },
  });
  const c = fakeConn();
  h.attach(c);
  c.deliver(HELLO);
  assert.deepEqual(touched.splice(0).sort(), ['s-x', 's-y'], 'hello：所有存活会话的 state.connected 都可能变');

  c.deliver({ type: 'targets', targets: [target()] });
  assert.deepEqual(touched.splice(0), ['s-x']);
  assert.equal(h.targetOf('s-x').targetId, 't-x');
  assert.equal(h.targetOf('s-y'), null);

  c.deliver({ type: 'targets', targets: [target({ sessionId: 's-y' })] });
  assert.deepEqual(touched.splice(0).sort(), ['s-x', 's-y'], '绑定从 s-x 移到 s-y：两边都要刷新');

  c.drop();
  assert.deepEqual(touched.splice(0).sort(), ['s-x', 's-y'], '断连通知曾绑定的会话（busy 立即清除）和所有存活会话（connected 变 false）');
  assert.equal(h.targetOf('s-y'), null);

  assert.equal(h.unpair('s-x').ok, true);
  assert.deepEqual(touched.splice(0), ['s-x']);
  h.forget('s-x', { reason: 'archived' });
  assert.deepEqual(touched.splice(0), ['s-x']);

  const c2 = fakeConn();
  h.attach(c2);
  c2.deliver(HELLO);
  touched.length = 0;
  c2.deliver({ type: 'pair', sessionId: 's-y', site: 'chatgpt', conversationKey: 'c-y' });
  assert.deepEqual(touched.splice(0), ['s-y'], 'Courier 里手动配对');

  c2.deliver({ type: 'targets', targets: [target({ sessionId: 's-y' })] });
  touched.length = 0;
  const c3 = fakeConn();
  h.attach(c3);
  c3.deliver(HELLO);
  assert.deepEqual(touched.splice(0).sort(), ['s-x', 's-y'], '新连接取代旧连接：旧绑定的会话与所有存活会话都要刷新');

  assert.doesNotThrow(() => h.forget('boom'), '回调抛错被吃掉');
  assert.deepEqual(touched.splice(0), ['boom']);
});

test('hub 的 busy 兜底：有绑定的聊天在生成时定时向 Courier 要最新目标状态，空闲、断连、关闭即停', async () => {
  const list = [{ id: 's-x', name: 'X', status: 'active' }];
  const h = new CourierHub({ sessions: () => list, pairs: new CourierPairs(null), busyRefreshMs: 15 });
  const polls = (conn) => conn.sent.filter((m) => m.type === 'targets.list').length;
  const c = fakeConn();
  h.attach(c);
  c.deliver(HELLO);

  c.deliver({ type: 'targets', targets: [target({ busy: false })] });
  await sleep(60);
  assert.equal(polls(c), 0, '没有 busy 目标不轮询');

  c.deliver({ type: 'targets', targets: [target({ busy: true })] });
  await sleep(90);
  assert.ok(polls(c) >= 3, `生成中应定时刷新（实际 ${polls(c)} 次）`);

  c.deliver({ type: 'targets', targets: [target({ busy: false })] });
  const idle = polls(c);
  await sleep(70);
  assert.equal(polls(c), idle, '空闲后停止');

  c.deliver({ type: 'targets', targets: [target({ busy: true })] });
  await sleep(50);
  assert.ok(polls(c) > idle, 'busy 再次出现时恢复');
  c.drop();
  const dropped = polls(c);
  await sleep(70);
  assert.equal(polls(c), dropped, '断连后停止');

  const c2 = fakeConn();
  h.attach(c2);
  c2.deliver(HELLO);
  c2.deliver({ type: 'targets', targets: [target({ busy: true })] });
  await sleep(50);
  assert.ok(polls(c2) >= 1, '重新连上且仍在生成时恢复');
  h.close();
  const closed = polls(c2);
  await sleep(70);
  assert.equal(polls(c2), closed, 'hub.close() 后停止');
});
