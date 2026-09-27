import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../dist/storage/db.js';
import { ToolCallsRepo } from '../dist/storage/toolCalls.js';
import { migrateActivity, activityDate } from '../dist/storage/activity.js';

function fixture(t) {
  fs.mkdirSync('.cache/tests', { recursive: true });
  const dir = fs.mkdtempSync(path.resolve('.cache/tests/activity-'));
  const storage = openDb(path.join(dir, 'test.db'));
  t.after(() => { storage.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { db: storage.db, repo: new ToolCallsRepo(storage.db) };
}
const today = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
const result = (added, removed, extra = '') => JSON.stringify({ result: { diff: { added, removed }, message: extra } });

test('today excludes future buckets and days normalize unsorted duplicate and invalid input', t => {
  const {db,repo}=fixture(t), day=today(), next=new Date(day);next.setDate(next.getDate()+1);
  const tomorrow=next.getTime();
  db.prepare('INSERT INTO daily_activity(day,total,diff_added,diff_removed) VALUES(?,?,?,?)').run(activityDate(day),3,5,2);
  db.prepare('INSERT INTO daily_activity(day,total,diff_added,diff_removed) VALUES(?,?,?,?)').run(activityDate(tomorrow),9000,9,8);
  assert.deepEqual(repo.dailyStats(day),{total:3,diff_added:5,diff_removed:2});
  assert.deepEqual(repo.activityDays([tomorrow,day+3600000,NaN,day,Infinity,1e20]),[
    {start:day,total:3,diff_added:5,diff_removed:2},{start:tomorrow,total:9000,diff_added:9,diff_removed:8}]);
  assert.deepEqual(repo.activityDays([NaN,Infinity,1e20]),[]);
  assert.deepEqual(repo.dailyStats(NaN),{total:0,diff_added:0,diff_removed:0});
});
test('completion after midnight retains the start-day bucket and repeated completion is idempotent', t => {
  const {repo}=fixture(t),day=today(),next=new Date(day);next.setDate(next.getDate()+1);const midnight=next.getTime();
  const clock=t.mock.method(Date,'now',()=>midnight-1000);
  const call=repo.start('cross-midnight','editor','{}','hash');
  clock.mock.mockImplementation(()=>midnight+1000);
  repo.finish(call.id,'completed',result(4,2));repo.finish(call.id,'completed',result(4,2));
  assert.deepEqual(repo.dailyStats(day),{total:1,diff_added:4,diff_removed:2});
  assert.deepEqual(repo.dailyStats(midnight),{total:0,diff_added:0,diff_removed:0});
});
test('health reuses seven-day snapshot instead of a separate today query', () => {
  const source=fs.readFileSync(new URL('../src/control/api.ts',import.meta.url),'utf8');
  assert.equal((source.match(/deps\.toolCalls\.activityDays\(activityStarts\)/g)||[]).length,1);
  assert.ok(!source.includes('deps.toolCalls.dailyStats('));
  assert.ok(source.includes('activity_days: activityDays'));
  assert.ok(source.includes('day.start === dayStart.getTime()'));
});
test('activity counts survive detail retention and do not read tool_calls on display', t => {
  const { db, repo } = fixture(t);
  const call = repo.start('demo', 'editor', '{}', 'hash');
  repo.finish(call.id, 'completed', result(8, 3));
  repo.purgeSession('demo');
  assert.deepEqual(repo.dailyStats(today()), { total: 1, diff_added: 8, diff_removed: 3 });
  // Strong seam: the display remains independent of the large detail table.
  db.exec('DROP TABLE tool_calls');
  assert.deepEqual(repo.activityDays([today()]), [{ start: today(), total: 1, diff_added: 8, diff_removed: 3 }]);
});
test('repeated completion updates are idempotent; non-editor and failed results are not code changes', t => {
  const { repo } = fixture(t);
  const a = repo.start('demo', 'editor', '{}', 'hash');
  repo.finish(a.id, 'completed', result(5, 2));
  repo.finish(a.id, 'completed', result(5, 2));
  const b = repo.start('demo', 'proxy', '{}', 'hash');
  repo.finish(b.id, 'completed', result(999, 999));
  const c = repo.start('demo', 'editor', '{}', 'hash');
  repo.finish(c.id, 'failed', result(999, 999));
  assert.deepEqual(repo.dailyStats(today()), { total: 3, diff_added: 5, diff_removed: 2 });
});
test('persisted JSON including escaping has a byte cap and retains numeric editor deltas', t => {
  const { repo } = fixture(t);
  const a = repo.start('demo', 'editor', '{}', 'hash');
  repo.finish(a.id, 'completed', result(12, 4, '\"\\\n中'.repeat(20000)));
  const text = repo.get(a.id).result_summary;
  assert.ok(Buffer.byteLength(text) <= 32768);
  assert.equal(JSON.parse(text).truncated, true);
  assert.deepEqual(JSON.parse(text).result.diff, { added: 12, removed: 4 });
  assert.deepEqual(repo.dailyStats(today()), { total: 1, diff_added: 12, diff_removed: 4 });
});
test('legacy counters are backfilled once and later completion cannot double-count', t => {
  const {db,repo}=fixture(t);
  const call=repo.start('demo','editor','{}','hash');repo.finish(call.id,'completed',result(9,2));
  db.exec('DROP TABLE daily_activity');
  migrateActivity(db);migrateActivity(db);
  repo.finish(call.id,'completed',result(9,2));
  assert.deepEqual(repo.dailyStats(today()),{total:1,diff_added:9,diff_removed:2});
  db.exec('DROP TABLE tool_calls');migrateActivity(db);
  assert.deepEqual(repo.dailyStats(today()),{total:1,diff_added:9,diff_removed:2});
});
test('call insert and counter update roll back together on a storage failure', t => {
  const {db,repo}=fixture(t);
  db.exec("CREATE TRIGGER deny_counter BEFORE INSERT ON daily_activity BEGIN SELECT RAISE(ABORT,'fixture'); END");
  assert.throws(()=>repo.start('demo','proxy','{}','hash'),/fixture/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tool_calls').get().n,0);
});
test('bad/negative/non-numeric deltas never poison totals and empty days remain numeric zero', t => {
  const { repo } = fixture(t);
  const a = repo.start('demo', 'editor', '{}', 'hash');
  repo.finish(a.id, 'completed', result(-1, '200'));
  assert.deepEqual(repo.dailyStats(today()), { total: 1, diff_added: 0, diff_removed: 0 });
  const tomorrow = new Date(today()); tomorrow.setDate(tomorrow.getDate() + 1);
  assert.deepEqual(repo.activityDays([tomorrow.getTime()]), [{ start: tomorrow.getTime(), total: 0, diff_added: 0, diff_removed: 0 }]);
});

test('health machine-event counters use the partial index, not a scan of every machine event', t => {
  const { db } = fixture(t);
  const plan = db.prepare("EXPLAIN QUERY PLAN SELECT COUNT(*) AS n FROM session_events WHERE session_id IS NULL AND event_type = ? AND created_at >= ?")
    .all('mcp_initialize', 0).map(r => r.detail).join(' | ');
  assert.match(plan, /idx_events_machine_type_time/, plan);
});
