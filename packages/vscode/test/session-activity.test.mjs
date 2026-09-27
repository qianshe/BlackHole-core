import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Exercise the actual embedded renderer, not a duplicate of its rules.
const source = fs.readFileSync(new URL('../src/sidebar.ts', import.meta.url), 'utf8');
const body = source.match(/    function sessionStatus\(s, d(?:, [^)]*)?\) \{[\s\S]*?\n    \}/)?.[0];
assert.ok(body, 'sidebar session-status renderer exists');
const render = vm.runInNewContext(`(${body.trim()})`, { esc: s => String(s) });
const session = { id: 'a', status: 'active', activity: 'idle' };
const online = { tunnel: { status: 'online' }, pending: [] };

test('online channel does not make an idle session running', () => {
  assert.match(render(session, online), /空闲/);
  assert.doesNotMatch(render(session, online), /运行中/);
});
test('a running tool remains running even when the tunnel is offline', () => {
  assert.match(render({ ...session, activity: 'running' }, { tunnel: { status: 'offline' } }), /运行中/);
});
test('pause and pending-approval labels keep precedence over activity', () => {
  const d = { ...online, pending: [{ session_id: 'a' }] };
  assert.match(render({ ...session, status: 'paused', activity: 'running' }, d), /已暂停/);
  assert.match(render({ ...session, activity: 'running' }, d), /待审批/);
});
test('another session approval does not change this session badge', () => {
  assert.match(render(session, { ...online, pending: [{ session_id: 'b' }] }), /空闲/);
});
test('older daemon without activity is unknown, never guessed from channel state', () => {
  for (const status of ['online', 'offline']) {
    assert.match(render({ ...session, activity: undefined }, { tunnel: { status } }), /状态未知/);
  }
});
test('archived and revoked lifecycle states are not replaced by activity', () => {
  for (const status of ['revoked', 'archived']) assert.match(render({ ...session, status }, online), new RegExp(status));
});


test('session list stays stable while the detail header keeps last-tool age', () => {
  const running = render({ ...session, activity: 'running' }, online);
  assert.match(running, /● 运行中/);
  assert.doesNotMatch(running, /lastToolAge|last-tool-age/);
  const detail = render({ ...session, activity: 'running' }, online, true);
  assert.match(detail, /lastToolAge|last-tool-age/);
  assert.match(source, /sessionStatus\(s, d, true\)/);
  assert.match(source, /lastToolActivityAt = pageCalls\.reduce/);
  assert.match(source, /renderLastToolAge\(\)/);
});
test('tool call rows show duration only and never render an absolute created-at clock', () => {
  assert.doesNotMatch(source, /function fmtTs\(/);
  assert.doesNotMatch(source, /fmtTs\(c\.created_at\)/);
  assert.match(source, /meta\.textContent = fmtDur\(durMs\)/);
  assert.match(source, /const meta = fmtDur\(ctx\.durMs\)/);
  assert.match(source, /c\.updated_at - c\.created_at/);
});
