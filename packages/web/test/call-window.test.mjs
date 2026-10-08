import test from 'node:test';
import assert from 'node:assert/strict';
import { WINDOW_MAX, applyHead, applyOlder, emptyWindow, hasOlder, headRequest, rowsOf } from '../../vscode/src/callWindow.ts';

// Rows as the daemon returns them: newest first.
const rows = (from, to) => { const r = []; for (let s = to; s >= from; s--) r.push({ id: `c${s}`, seq: s, created_at: new Date(s * 1000).toISOString() }); return r; };

test('head anchors the window; older pages extend it oldest-first', () => {
  let w = emptyWindow();
  assert.deepEqual(headRequest(w, 20), { limit: 20, restart: false });
  w = applyHead(w, { calls: rows(81, 100), total: 100, max_seq: 100 });
  assert.equal(w.anchor, 100);
  assert.equal(hasOlder(w), true);
  w = applyOlder(w, { calls: rows(61, 80), total: 100, window_total: 100, max_seq: 100 });
  const list = rowsOf(w);
  assert.equal(list.length, 40);
  assert.equal(list[0].seq, 61);
  assert.equal(list.at(-1).seq, 100);
});

test('new calls widen the head request so nothing between anchor and head is skipped', () => {
  let w = applyHead(emptyWindow(), { calls: rows(81, 100), total: 100, max_seq: 100 });
  w = applyHead(w, { calls: rows(86, 105), total: 105, max_seq: 105 });
  assert.deepEqual(headRequest(w, 20), { limit: 25, restart: false });
  w = { ...w, total: 100 + WINDOW_MAX };
  assert.equal(headRequest(w, 20).restart, true);
});

test('an empty older page (history trimmed) ends the window', () => {
  let w = applyHead(emptyWindow(), { calls: rows(81, 100), total: 100, max_seq: 100 });
  w = applyOlder(w, { calls: [], total: 20, window_total: 20, max_seq: 100 });
  assert.equal(hasOlder(w), false);
});
