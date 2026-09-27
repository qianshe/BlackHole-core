import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { openDb } from '../dist/storage/db.js';
import { SessionsRepo } from '../dist/storage/sessions.js';
import { HandoffsRepo, HANDOFF_MAX_BYTES } from '../dist/storage/handoffs.js';
import { mountControl } from '../dist/control/api.js';

function fixture(t) {
  const cache = path.resolve('.cache'); fs.mkdirSync(cache, { recursive: true });
  const root = fs.mkdtempSync(path.join(cache, 'handoff-test-'));
  const file = path.join(root, 'state.sqlite');
  let storage = openDb(file), changes = 0;
  const make = () => ({
    sessions: new SessionsRepo(storage.db),
    handoffs: new HandoffsRepo(storage.db, () => changes++),
  });
  let repos = make();
  t.after(() => { storage.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return {
    get db() { return storage.db; }, get sessions() { return repos.sessions; }, get handoffs() { return repos.handoffs; },
    get changes() { return changes; },
    create: extra => repos.sessions.create({ workspace_path: root, permission_mode: 'read-only', ...extra }),
    reopen() { storage.close(); storage = openDb(file); repos = make(); },
  };
}

test('one pending document survives database reopen and is not aged like audit history', t => {
  const f = fixture(t), session = f.create();
  const saved = f.handoffs.set(session.id, 'Goal: finish the test\nNext step: inspect the result');
  f.db.prepare('UPDATE session_handoffs SET created_at = ? WHERE session_id = ?').run(1, session.id);
  f.reopen();
  assert.deepEqual(f.handoffs.get(session.id), { ...saved, created_at: 1 });
  assert.equal(f.handoffs.pendingId(session.id), saved.id);
  assert.equal(f.handoffs.get('missing'), null);
});

test('replacement and compare-and-delete isolate sessions and protect a newly submitted handoff', t => {
  const f = fixture(t), a = f.create(), b = f.create();
  const first = f.handoffs.set(a.id, 'first');
  const other = f.handoffs.set(b.id, 'other session');
  const second = f.handoffs.set(a.id, 'replacement');
  assert.notEqual(first.id, second.id);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM session_handoffs').get().n, 2);
  assert.equal(f.handoffs.consume(a.id, first.id), false);
  assert.equal(f.handoffs.consume(b.id, second.id), false);
  assert.deepEqual(f.handoffs.get(a.id), second);
  assert.deepEqual(f.handoffs.get(b.id), other);
  assert.equal(f.changes, 3);
  assert.equal(f.handoffs.consume(a.id, second.id), true);
  assert.equal(f.handoffs.consume(a.id, second.id), false);
  assert.equal(f.handoffs.get(a.id), null);
  assert.equal(f.changes, 4);
});

test('empty and UTF-8 oversized submissions are rejected without losing the pending document', t => {
  const f = fixture(t), session = f.create();
  const saved = f.handoffs.set(session.id, '  keep internal\n  indentation  ');
  assert.equal(saved.content, 'keep internal\n  indentation');
  for (const content of ['', ' \r\n\t', null, 'x'.repeat(HANDOFF_MAX_BYTES + 1), '中'.repeat(Math.ceil(HANDOFF_MAX_BYTES / 3))]) {
    assert.throws(() => f.handoffs.set(session.id, content));
    assert.deepEqual(f.handoffs.get(session.id), saved);
  }
  assert.equal(f.handoffs.set(session.id, 'x'.repeat(HANDOFF_MAX_BYTES)).content.length, HANDOFF_MAX_BYTES);
});

test('inactive, expired and missing sessions cannot write or consume pending context', t => {
  const f = fixture(t), session = f.create(), expired = f.create({ expires_at: Date.now() - 1 });
  const saved = f.handoffs.set(session.id, 'pending');
  f.sessions.setStatus(session.id, 'paused');
  for (const id of [session.id, expired.id, 'missing']) assert.throws(() => f.handoffs.set(id, 'not admitted'), /not active/);
  assert.equal(f.handoffs.consume(session.id, saved.id), false);
  assert.deepEqual(f.handoffs.get(session.id), saved);
  f.sessions.setStatus(session.id, 'active');
  assert.equal(f.handoffs.consume(session.id, saved.id), true);
});

test('credential rotation preserves content; terminal status and deletion clear it atomically', t => {
  const f = fixture(t), session = f.create();
  const saved = f.handoffs.set(session.id, 'pending');
  const rotated = f.sessions.rotateCredential(session.id);
  assert.notEqual(rotated.credential_id, session.credential_id);
  assert.deepEqual(f.handoffs.get(session.id), saved);
  for (const status of ['revoked', 'archived', 'deleted']) {
    const row = f.create(); f.handoffs.set(row.id, 'discard on termination');
    if (status === 'deleted') f.db.prepare('DELETE FROM sessions WHERE id = ?').run(row.id);
    else f.sessions.setStatus(row.id, status);
    assert.equal(f.handoffs.get(row.id), null);
  }
});

test('change notifications cannot turn a durable write into a reported failure', t => {
  const f = fixture(t), session = f.create();
  const repo = new HandoffsRepo(f.db, () => { throw Error('presentation unavailable'); });
  const saved = repo.set(session.id, 'still durable');
  assert.deepEqual(repo.get(session.id), saved);
  assert.equal(repo.purgeSession(session.id), 1);
  assert.equal(repo.purgeSession(session.id), 0);
});

test('local handoff snapshot is read-only and contains the current credential and connection URL', async t => {
  const f = fixture(t), row = f.create();
  const saved = f.handoffs.set(row.id, 'verified continuation context');
  const deps = {
    cfg: { bodyLimitBytes: 256 * 1024, publicBaseUrl: 'https://handoff.example.invalid', host: '127.0.0.1', port: 1 },
    sessions: f.sessions, handoffs: f.handoffs, events: { append() {} },
    tunnel: { status: 'off' },
  };
  const app = express(); mountControl(app, deps);
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const read = () => fetch(`${base}/sessions/${row.id}/handoff`);
  let response = await read(), snapshot = await response.json();
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(snapshot.handoff, saved);
  assert.equal(snapshot.session.session_id, row.credential_id);
  assert.match(snapshot.mcp_url, /^https:\/\/handoff\.example\.invalid\/mcp\//);
  const rotated = f.sessions.rotateCredential(row.id);
  deps.tunnel = { status: 'online', url: 'https://new-connection.example.invalid' };
  snapshot = await (await read()).json();
  assert.equal(snapshot.session.session_id, rotated.credential_id);
  assert.match(snapshot.mcp_url, /^https:\/\/new-connection\.example\.invalid\/mcp\//);
  assert.deepEqual(f.handoffs.get(row.id), saved, 'preview and copy reads never consume');
  assert.equal((await fetch(`${base}/sessions/missing/handoff`)).status, 404);
  assert.equal((await fetch(`${base}/sessions/${row.id}/handoff`, { headers: { 'x-forwarded-for': '203.0.113.1' } })).status, 403);
  f.sessions.setStatus(row.id, 'revoked');
  assert.equal((await (await read()).json()).handoff, null);
});

test('summary projection batches metadata without reading documents across session responses', async t => {
  const f = fixture(t), a = f.create(), b = f.create();
  const saved = f.handoffs.set(a.id, 'SUMMARY-PRIVATE-CONTENT');
  const summary = { id: saved.id, created_at: saved.created_at };
  assert.deepEqual(f.handoffs.getSummary(a.id), summary);
  assert.equal(f.handoffs.getSummary(b.id), null);
  assert.deepEqual(f.handoffs.listSummaries().get(a.id), summary);
  let batch = 0, single = 0;
  const handoffs = {
    get() { throw Error('summary must never read content'); },
    getSummary(id) { single++; return f.handoffs.getSummary(id); },
    listSummaries() { batch++; return f.handoffs.listSummaries(); },
  };
  const app = express(); mountControl(app, {
    cfg: { bodyLimitBytes: 256 * 1024, publicBaseUrl: 'https://summary.example.invalid', host: '127.0.0.1', port: 1 },
    sessions: f.sessions, handoffs, events: { append() {} }, tunnel: { status: 'off' },
    changes: { bump() {} }, runtimes: new Map(),
  });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/sessions`);
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  const rows = (await response.json()).sessions;
  assert.deepEqual(rows.find(s => s.id === a.id).pending_handoff, summary);
  assert.equal(rows.find(s => s.id === b.id).pending_handoff, null);
  assert.equal(batch, 1); assert.equal(single, 0);
  for (let i = 0; i < 15; i++) f.create();
  await fetch(`${base}/sessions`); assert.equal(batch, 2); assert.equal(single, 0);
  const detail = await (await fetch(`${base}/sessions/${a.id}`)).json();
  assert.deepEqual(detail.pending_handoff, summary); assert.equal(single, 1);
  const request = async (url, method, body) => {
    const r = await fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(r.status, 200); return r.json();
  };
  const ordered = await request('/sessions/reorder', 'POST', { ids: f.sessions.list().map(s => s.id).reverse() });
  assert.deepEqual(ordered.sessions.find(s => s.id === a.id).pending_handoff, summary);
  assert.equal(batch, 3); assert.equal(single, 1);
  for (const action of ['pause', 'resume', 'rotate']) {
    assert.deepEqual((await request(`/sessions/${a.id}/${action}`, 'POST', {})).pending_handoff, summary);
  }
  for (const [action, body] of [
    ['mode', { permission_mode: 'read-only' }],
    ['mode', { permission_mode: 'workspace-write' }],
    ['writable_dirs', { writable_dirs: [] }], ['auto_approve', { auto_approve: false }],
  ]) assert.deepEqual((await request(`/sessions/${a.id}/${action}`, 'PATCH', body)).pending_handoff, summary);
  f.sessions.setStatus(a.id, 'paused');
  assert.deepEqual((await (await fetch(`${base}/sessions/${a.id}`)).json()).pending_handoff, summary);
  f.sessions.rotateCredential(a.id);
  assert.deepEqual((await (await fetch(`${base}/sessions/${a.id}`)).json()).pending_handoff, summary);
  f.reopen();
  assert.deepEqual(f.handoffs.getSummary(a.id), summary);
});
