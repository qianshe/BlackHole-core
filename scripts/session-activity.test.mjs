import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SessionActivity } from '../dist/session-activity.js';
import { activityToolRegistrar } from '../dist/mcp/activity-tools.js';
import { registerTools } from '../dist/mcp/tools.js';
import { SessionRuntime } from '../dist/runtime.js';
import { openDb } from '../dist/storage/db.js';
import { SessionsRepo } from '../dist/storage/sessions.js';
import { ToolCallsRepo } from '../dist/storage/toolCalls.js';
import { EventsRepo } from '../dist/storage/events.js';
import { TodosRepo } from '../dist/storage/todos.js';
import { ConfirmationsRepo } from '../dist/storage/confirmations.js';
import { MachineStateRepo } from '../dist/storage/machineState.js';
import { ChangeTracker } from '../dist/storage/changes.js';
import { mountControl, resolveConfirmation } from '../dist/control/api.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const result = () => ({ content: [{ type: 'text', text: '{}' }] });
function fakeClock() {
  let time = 0;
  const jobs = new Set();
  return {
    now: () => time, jobs,
    schedule(fn, delay) { const job = { fn, due: time + delay }; jobs.add(job); return () => jobs.delete(job); },
    advance(ms, deliver = true) {
      time += ms;
      if (deliver) {
        for (;;) { const job = [...jobs].find(j => j.due <= time); if (!job) break; jobs.delete(job); job.fn(); }
      }
    },
  };
}
function unit(t) {
  const clock = fakeClock(), changes = [];
  const activity = new SessionActivity(() => changes.push(clock.now()), clock);
  t.after(() => activity.dispose());
  return { clock, changes, activity };
}

test('endTurn ends the window at once, but never under a tool call still being handled', t => {
  const { activity } = unit(t);
  const done = activity.begin('a');
  activity.endTurn('a');
  assert.equal(activity.status('a'), 'running', 'a pending call keeps it running');
  done();
  assert.equal(activity.status('a'), 'running', 'finished calls keep the 60 s window');
  activity.endTurn('a');
  assert.equal(activity.status('a'), 'idle');
  activity.endTurn('unknown');
});

test('health counts only running active sessions, excluding idle and paused sessions', t => {
 const {activity,clock}=unit(t);
 const source=fs.readFileSync(new URL('../src/control/api.ts',import.meta.url),'utf8');
 const expression=/sessions_running: (.*),/.exec(source)?.[1];assert.ok(expression);
 const count=new Function('deps','return '+expression);
 const rows=[{id:'a',status:'active'},{id:'b',status:'active'},{id:'paused',status:'paused'},{id:'revoked',status:'revoked'},{id:'archived',status:'archived'}];
 const deps={sessions:{list:()=>rows},sessionActivity:activity};
 assert.equal(count(deps),0);
 const done=activity.begin('a');activity.begin('paused');activity.begin('revoked');activity.begin('archived');
 assert.equal(count(deps),1);clock.advance(120000);assert.equal(count(deps),1);
 done();assert.equal(count(deps),0);
 activity.begin('b')();assert.equal(count(deps),1);clock.advance(60000);assert.equal(count(deps),0);
 assert.equal(count({...deps,sessionActivity:undefined}),0);
});
test('production clock constructs, schedules and disposes without injected test time', () => {
  const activity = new SessionActivity(() => {});
  try {
    assert.equal(activity.status('live-clock'), 'idle');
    activity.begin('live-clock')();
    assert.equal(activity.status('live-clock'), 'running');
  } finally { activity.dispose(); }
});

test('default idle; short call expires exactly 60 seconds from START, without any read', t => {
  const { activity: a, clock: c, changes } = unit(t);
  assert.equal(a.status('a'), 'idle'); assert.equal(c.jobs.size, 0);
  const done = a.begin('a'); c.advance(10_000); done();
  assert.deepEqual(changes, [0]); assert.equal(c.jobs.size, 1);
  c.advance(49_999); assert.equal(a.status('a'), 'running');
  c.advance(1); assert.deepEqual(changes, [0, 60_000]);
  assert.equal(a.status('a'), 'idle'); assert.equal(c.jobs.size, 0);
});
test('each new call slides the window and a cancelled old timer cannot expire the new window', t => {
  const { activity: a, clock: c, changes } = unit(t);
  a.begin('a')(); const stale = [...c.jobs][0];
  c.advance(50_000); a.begin('a')(); stale.fn();
  assert.equal(c.jobs.size, 1);
  c.advance(10_000); assert.equal(a.status('a'), 'running');
  c.advance(50_000); assert.equal(a.status('a'), 'idle');
  assert.deepEqual(changes, [0, 110_000]);
});
test('overlapping calls aggregate per session; finishing twice cannot release someone else', t => {
  const { activity: a, clock: c } = unit(t);
  const one = a.begin('a'), two = a.begin('a');
  a.begin('b')(); c.advance(90_000);
  one(); one(); assert.equal(a.status('a'), 'running'); assert.equal(a.status('b'), 'idle');
  two(); assert.equal(a.status('a'), 'idle'); assert.equal(c.jobs.size, 0);
});
test('long call has no expiry timer while pending and no extra minute after completion', t => {
  const { activity: a, clock: c } = unit(t);
  const done = a.begin('a'); c.advance(600_000);
  assert.equal(c.jobs.size, 0); assert.equal(a.status('a'), 'running');
  done(); assert.equal(a.status('a'), 'idle');
});
test('delayed/early timers cannot extend or shorten the authoritative window', t => {
  const { activity: a, clock: c } = unit(t);
  a.begin('a')(); const early = [...c.jobs][0]; c.jobs.delete(early); early.fn();
  assert.equal(a.status('a'), 'running'); assert.equal(c.jobs.size, 1);
  c.advance(60_000, false); assert.equal(a.status('a'), 'idle'); assert.equal(c.jobs.size, 0);
});
test('wall-clock jumps have no effect on activity duration', t => {
  const { activity: a, clock: c } = unit(t);
  a.begin('a')(); t.mock.method(Date, 'now', () => -9_000_000);
  c.advance(59_999); assert.equal(a.status('a'), 'running');
  t.mock.method(Date, 'now', () => 9_000_000_000_000);
  c.advance(1); assert.equal(a.status('a'), 'idle');
});
test('forget/dispose remove timers and late completions never revive or decrement replacements', t => {
  const { activity: a, clock: c } = unit(t);
  const old = a.begin('a'); a.forget('a'); const current = a.begin('a');
  old(); c.advance(70_000); assert.equal(a.status('a'), 'running'); current();
  a.begin('b')(); assert.equal(c.jobs.size, 1); a.dispose();
  assert.equal(c.jobs.size, 0); a.begin('b')(); assert.equal(a.status('b'), 'idle');
  const restarted = new SessionActivity(() => {}, c); assert.equal(restarted.status('a'), 'idle'); restarted.dispose();
});

function fixture(t) {
  fs.mkdirSync('.cache/tests', { recursive: true });
  const dir = fs.mkdtempSync(path.resolve('.cache/tests/session-activity-'));
  fs.mkdirSync(path.join(dir, 'skills', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'skills', 'demo', 'SKILL.md'), '# Fixture\n');
  const storage = openDb(path.join(dir, 'test.db'));
  const sessions = new SessionsRepo(storage.db), changes = new ChangeTracker(), clock = fakeClock();
  const sessionActivity = new SessionActivity(() => changes.bump(), clock);
  const machineState = new MachineStateRepo(storage.db);
  const deps = {
    cfg: { skillsDir: path.join(dir, 'skills'), bodyLimitBytes: 1_048_576, execTimeoutMs: 1000, execMaxTimeoutMs: 2000 },
    sessions, changes, sessionActivity, machineState,
    toolCalls: new ToolCallsRepo(storage.db), events: new EventsRepo(storage.db, 16_384, () => changes.bump()),
    todos: new TodosRepo(storage.db, () => changes.bump()), confirmations: new ConfirmationsRepo(storage.db, machineState),
    runtimes: new Map(), log() {}, tunnel: { status: 'offline' },
  };
  const a = sessions.create({ workspace_path: dir, permission_mode: 'danger-full-access', name: 'a' });
  const b = sessions.create({ workspace_path: dir, permission_mode: 'danger-full-access', name: 'b' });
  const resolve = sid => {
    const row = sessions.byCredential(sid);
    if (!row || row.status !== 'active' || row.expires_at !== null && row.expires_at < Date.now()) return { error: 'invalid fixture session' };
    let rt = deps.runtimes.get(row.id);
    if (!rt) { rt = new SessionRuntime(row, {}); deps.runtimes.set(row.id, rt); }
    return rt;
  };
  const closers = [];
  t.after(async () => { for (const close of closers) await close(); sessionActivity.dispose(); storage.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  async function connect(custom) {
    const server = new McpServer({ name: 'activity-fixture', version: '1' });
    if (custom) custom(activityToolRegistrar(server, deps));
    else registerTools(server, resolve, deps, { execDescription: 'Isolated fake shell only.' });
    const client = new Client({ name: 'activity-client', version: '1' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st); await client.connect(ct);
    closers.push(async () => { await client.close(); await server.close(); });
    return { server, client, call: (name, args = {}) => client.callTool({ name, arguments: { sessionId: a.credential_id, ...args } }) };
  }
  async function control() {
    const app = express(); mountControl(app, deps);
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    closers.push(() => new Promise(resolve => server.close(resolve)));
    const origin = `http://127.0.0.1:${server.address().port}`;
    return async (route, options) => { const res = await fetch(origin + route, options); assert.equal(res.status, 200); return res.json(); };
  }
  return { dir, storage, deps, a, b, clock, connect, resolve, control };
}

test('SDK handshake/discovery and invalid schema/session do not start or renew activity', async t => {
  const f = fixture(t), { client, call } = await f.connect(), activity = f.deps.sessionActivity;
  await client.listTools(); assert.equal(activity.status(f.a.id), 'idle');
  await call('todo', { command: 'not-valid' }).catch(() => {});
  await call('todo', { command: 'read', sessionId: '7'.repeat(39) });
  await call('guide', { sessionId: undefined });
  await call('skill', { name: 'demo', sessionId: undefined });
  assert.equal(activity.status(f.a.id), 'idle');
  await call('todo', { command: 'read' }); f.clock.advance(59_000);
  await client.listTools(); await f.connect();
  await call('todo', { command: 'not-valid' }).catch(() => {});
  f.clock.advance(1000); assert.equal(activity.status(f.a.id), 'idle');
});
test('guide, skill, todo and failed editor calls refresh activity, without touching other sessions', async t => {
  const f = fixture(t), { call } = await f.connect(), activity = f.deps.sessionActivity;
  for (const [tool, args] of [['guide', {}], ['skill', { name: 'demo' }], ['todo', { command: 'read' }], ['editor', { path: 'missing.txt', operation: { command: 'view' } }]]) {
    await call(tool, args); assert.equal(activity.status(f.a.id), 'running'); assert.equal(activity.status(f.b.id), 'idle');
    f.clock.advance(60_000); assert.equal(activity.status(f.a.id), 'idle');
  }
});
test('paused/expired/revoked calls cannot activate a session, including keyless attribution', async t => {
  const f = fixture(t), { call } = await f.connect();
  for (const status of ['paused', 'revoked', 'archived']) {
    f.deps.sessions.setStatus(f.a.id, status);
    await call('todo', { command: 'read' }); await call('guide');
    assert.equal(f.deps.sessionActivity.status(f.a.id), 'idle');
  }
  f.deps.sessions.setStatus(f.a.id, 'active');
  f.storage.db.prepare('UPDATE sessions SET expires_at=? WHERE id=?').run(Date.now() - 1, f.a.id);
  await call('todo', { command: 'read' }); assert.equal(f.deps.sessionActivity.status(f.a.id), 'idle');
});
test('two SDK connections share pending counts; shell queue waits and later throws settle correctly', async t => {
  const f = fixture(t), first = await f.connect(), second = await f.connect();
  const started = deferred(), release = deferred(), runtime = f.resolve(f.a.credential_id);
  let runs = 0;
  runtime.pwsh = { run: async () => { runs++; if (runs === 1) { started.resolve(); await release.promise; } else throw Error('fixture shell failure'); return { stdout: '', stderr: '', exit_code: 0, cwd: f.dir }; } };
  const one = first.call('exec', { command: 'echo first' }); await started.promise;
  const two = second.call('exec', { command: 'echo second' }); await tick();
  assert.equal(runs, 1); f.clock.advance(120_000);
  assert.equal(f.deps.sessionActivity.status(f.a.id), 'running');
  release.resolve(); await one; const failed = await two; assert.equal(failed.isError, true);
  assert.equal(runs, 2); assert.equal(f.deps.sessionActivity.status(f.a.id), 'idle');
});
test('approval waits stay active beyond a minute and denial settles without execution', async t => {
  const f = fixture(t), { call } = await f.connect();
  f.deps.sessions.setPermissionMode(f.a.id, 'workspace-write');
  const rt = f.resolve(f.a.credential_id);
  rt.pwsh = { run: async () => { assert.fail('denied fake command must not execute'); } };
  const pending = call('exec', { command: 'Remove-Item -Recurse -Force ./fixture-only' }); await tick();
  const confirmation = f.deps.confirmations.list().find(c => c.status === 'pending');
  assert.ok(confirmation); f.clock.advance(70_000);
  assert.equal(f.deps.sessionActivity.status(f.a.id), 'running');
  resolveConfirmation(f.deps, confirmation, 'deny', undefined); await pending;
  assert.equal(f.deps.sessionActivity.status(f.a.id), 'idle');
});
test('proxy catalog wait is included before audit tracking; rejection settles the activity', async t => {
  const f = fixture(t), entered = deferred(), release = deferred();
  f.deps.proxy = { servers: [], secretValues: [], registry: { resolveGlobal: async () => { entered.resolve(); await release.promise; return undefined; } } };
  const { call } = await f.connect();
  const pending = call('proxy', { command: 'explain', tool: 'fixture_missing_tool' }); await entered.promise;
  assert.equal(f.deps.toolCalls.listForSession(f.a.id).length, 0);
  f.clock.advance(70_000); assert.equal(f.deps.sessionActivity.status(f.a.id), 'running');
  release.resolve(); await pending; assert.equal(f.deps.sessionActivity.status(f.a.id), 'idle');
});
test('abort does not release an unfinished handler; eventual completion does', async t => {
  const f = fixture(t), entered = deferred(), aborted = deferred(), release = deferred(), settled = deferred();
  const { client } = await f.connect(register => register('slow', { inputSchema: { sessionId: z.string() } }, async (_a, extra) => {
    extra.signal.addEventListener('abort', () => aborted.resolve(), { once: true }); entered.resolve();
    await release.promise; settled.resolve(); return result();
  }));
  const controller = new AbortController();
  const request = client.callTool({ name: 'slow', arguments: { sessionId: f.a.credential_id } }, undefined, { signal: controller.signal }).catch(e => e);
  await entered.promise; controller.abort(); await aborted.promise; f.clock.advance(70_000);
  assert.equal(f.deps.sessionActivity.status(f.a.id), 'running');
  release.resolve(); await settled.promise; await tick(); await request;
  assert.equal(f.deps.sessionActivity.status(f.a.id), 'idle');
});
test('synchronous handler throws and audit storage errors never leak a pending count', async t => {
  const f = fixture(t);
  const c = await f.connect(register => register('throws', { inputSchema: { sessionId: z.string() } }, () => { throw Error('fixture sync throw'); }));
  await c.call('throws').catch(() => {}); f.clock.advance(60_000);
  assert.equal(f.deps.sessionActivity.status(f.a.id), 'idle');
  const real = await f.connect();
  f.storage.db.exec("CREATE TRIGGER deny_calls BEFORE INSERT ON tool_calls BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END");
  await real.call('todo', { command: 'read' }).catch(() => {}); f.clock.advance(60_000);
  assert.equal(f.deps.sessionActivity.status(f.a.id), 'idle');
});
test('control API exposes activity; time-only expiry bumps /changes; polling/settings/rotation do not renew', async t => {
  const f = fixture(t), get = await f.control(), { call } = await f.connect();
  assert.equal((await get('/sessions')).sessions.find(s => s.id === f.a.id).activity, 'idle');
  await call('todo', { command: 'read' });
  assert.equal((await get(`/sessions/${f.a.id}`)).activity, 'running');
  f.clock.advance(59_000);
  f.deps.sessions.setAutoApprove(f.a.id, true); f.deps.sessions.rotateCredential(f.a.id);
  await get('/sessions'); await get('/changes');
  const epoch = (await get('/changes')).epoch;
  f.clock.advance(1000);
  assert.ok((await get('/changes')).epoch > epoch);
  assert.equal((await get(`/sessions/${f.a.id}`)).activity, 'idle');
  assert.equal(f.clock.jobs.size, 0);
});
test('revoke clears activity while a late call completion cannot restore it', async t => {
  const f = fixture(t), get = await f.control(), entered = deferred(), release = deferred();
  const c = await f.connect(register => register('held', { inputSchema: { sessionId: z.string() } }, async () => {
    entered.resolve(); await release.promise; return result();
  }));
  const pending = c.call('held'); await entered.promise;
  const revoked = await get(`/sessions/${f.a.id}/revoke`, { method: 'POST' });
  assert.equal(revoked.status, 'revoked'); assert.equal(revoked.activity, 'idle');
  release.resolve(); await pending; assert.equal(f.deps.sessionActivity.status(f.a.id), 'idle');
});
