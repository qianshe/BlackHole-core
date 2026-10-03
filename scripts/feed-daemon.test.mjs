// session-feed 检查点 A 的 daemon 接线（隔离 daemon）：启动时导入旧 JSON、FeedLog 接入 ToolCallsRepo 并按墙钟取种子。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createIsolatedEnv } from './fixtures/isolated-env.mjs';

if (process.argv.includes('--fixture-daemon')) {
  const { startDaemon } = await import('../dist/daemon.js');
  const daemon = await startDaemon({ port: Number(process.env.BLACKHOLE_PORT), dbPath: process.env.BLACKHOLE_DB, tunnel: 'off' }, () => {});
  process.on('message', (message) => {
    if (message === 'stop') void daemon.stop().then(() => process.exit(0), () => process.exit(1));
  });
  process.send({ ready: true });
} else {
  test('daemon 接线：启动时把旧 JSON 回复线程导入 SQLite，进行中的调用被 FeedLog 标上墙钟量级的 rev', { timeout: 60_000 }, async (t) => {
    const { openDb } = await import('../dist/storage/db.js');
    const { SessionsRepo } = await import('../dist/storage/sessions.js');
    const { ToolCallsRepo } = await import('../dist/storage/toolCalls.js');
    const iso = await createIsolatedEnv({ name: 'feed' });

    // 预置：一个会话 + 一条「进行中」的工具调用（没有 FeedLog，rev = 0），以及旧的 courier-messages.json
    const seedDb = openDb(iso.dbPath);
    const session = new SessionsRepo(seedDb.db).create({ workspace_path: iso.home, permission_mode: 'read-only' });
    const inflight = new ToolCallsRepo(seedDb.db).start(session.id, 'shell', '{}', 'h');
    assert.equal(inflight.rev, 0);
    seedDb.close();
    const jsonFile = path.join(iso.dataDir, 'courier-messages.json');
    // 回复保留 7 天：导入后的启动清扫会删掉更旧的行（ancient），近期的保留
    const recent = Date.now() - 60_000;
    fs.writeFileSync(jsonFile, JSON.stringify({
      v: 1,
      sessions: {
        [session.id]: [
          { id: 'm0', sessionId: session.id, kind: 'user', text: 'ancient', at: 1, status: 'sent', site: 'chatgpt', targetId: null, conversationKey: 'k' },
          { id: 'm1', sessionId: session.id, kind: 'user', text: 'hello', at: recent, status: 'sent', site: 'chatgpt', targetId: null, conversationKey: 'k', rev: 3 },
          { id: 'm2', sessionId: session.id, kind: 'agent', text: 'hi there', at: recent + 1, status: 'reply', site: 'chatgpt', targetId: null, conversationKey: 'k' },
        ],
      },
    }));
    const startedAt = Date.now();

    const child = fork(fileURLToPath(import.meta.url), ['--fixture-daemon'], { env: iso.env, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const exited = new Promise((resolve) => child.once('exit', resolve));
    t.after(async () => {
      if (child.connected) child.send('stop');
      let timer;
      await Promise.race([exited, new Promise((resolve) => { timer = setTimeout(() => { child.kill(); resolve(); }, 5000); })]);
      clearTimeout(timer);
      iso.cleanup();
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('isolated daemon startup timeout')), 20_000);
      child.once('exit', (code) => { clearTimeout(timer); reject(Error(`daemon exited before ready: ${code}`)); });
      child.once('message', (m) => { clearTimeout(timer); m.ready ? resolve() : reject(Error('unexpected message')); });
    });

    // 导入接线：daemon 的 CourierMessages 读的是 SQLite，旧 JSON 的线程已经在里面
    const res = await fetch(`http://127.0.0.1:${iso.port}/api/courier/messages?sessionId=${session.id}`);
    assert.equal(res.status, 200);
    const { messages } = await res.json();
    assert.deepEqual(messages.map((m) => m.text), ['hello', 'hi there']);
    assert.equal(fs.existsSync(jsonFile), false, '旧文件已改名');
    assert.equal(fs.existsSync(`${jsonFile}.migrated`), true);

    // VS Code 的 control API 上的同名路由：共用同一份处理函数，调用原样输出行（含 args_json），回复来自导入的 SQLite
    const control = async (route) => (await fetch(`http://127.0.0.1:${iso.port}/api${route}`)).json();
    const feed = await control(`/sessions/${session.id}/feed`);
    assert.equal(feed.full, true);
    assert.deepEqual(feed.messages.map((m) => m.text), ['hello', 'hi there'], 'deps.courier.messageStore 已接线');
    assert.equal(feed.calls.length, 1);
    assert.equal(feed.calls[0].args_json, '{}');
    assert.equal(feed.calls[0].status, 'unknown');
    assert.ok(feed.calls[0].rev > startedAt, '头部窗口里的调用带 rev（FeedLog 已接入它的写入）');
    assert.equal(feed.state.status, 'active');
    assert.equal(feed.state.connected, false, '没有 Courier 连接');
    assert.equal(feed.state.target, null);
    assert.equal(feed.state.link, 'direct');
    assert.equal(feed.older, null);
    const history = await control(`/sessions/${session.id}/history`);
    assert.deepEqual(history.items.messages.map((m) => m.text), ['hello', 'hi there']);
    assert.equal(history.items.calls.length, 1);
    assert.equal((await fetch(`http://127.0.0.1:${iso.port}/api/sessions/nope/feed`)).status, 404);

    // 停掉 daemon 再读库
    child.send('stop');
    await exited;
    const db = new DatabaseSync(iso.dbPath);
    try {
      const call = db.prepare('SELECT status, rev FROM tool_calls WHERE id = ?').get(inflight.id);
      assert.equal(call.status, 'unknown', '重启恢复把进行中的调用标成 unknown');
      assert.ok(call.rev > startedAt, `恢复写入的 rev 来自 FeedLog（种子是墙钟），实际 ${call.rev}，启动前墙钟 ${startedAt}`);
      const rows = db.prepare('SELECT id, rev FROM courier_messages ORDER BY at').all();
      assert.deepEqual(rows.map((r) => [r.id, r.rev]), [['m1', 3], ['m2', 0]], '导入保留原 rev，缺失的为 0');
    } finally {
      db.close();
    }
  });
}
