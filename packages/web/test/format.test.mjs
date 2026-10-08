import test from 'node:test';
import assert from 'node:assert/strict';
import { argsPreview, baseName, callDuration, callTone, countByFilter, errorText, groupSessions, matchCall, pickDefaultSession, shortTime, matchSession, pathCrumbs, percent, readViewState, relativeTime, searchAll, sessionTitle, sessionTone, takeTicket, underPath, writeViewState } from '../src/format.ts';

test('console view state round-trips through the query string; unknown values fall back', () => {
  assert.deepEqual(readViewState(''), { session: null, view: 'session', settings: null });
  const v = { session: 'abc', view: 'channels', settings: 'agents' };
  assert.equal(writeViewState(v), '?s=abc&v=channels&set=agents');
  assert.deepEqual(readViewState(writeViewState(v)), v);
  assert.equal(readViewState('?set=overview').settings, 'home');
  assert.equal(readViewState('?set=channel').settings, 'connections');
  assert.equal(readViewState('?set=proxies').settings, 'agents');
  assert.deepEqual(readViewState('?v=evil&set=evil'), { session: null, view: 'session', settings: 'home' });
  assert.equal(writeViewState({ session: null, view: 'session', settings: null }), '');
});

test('errorText: known codes, server message, fallback', () => {
  assert.match(errorText('project_exists'), /已经在项目列表/);
  assert.equal(errorText('invalid_input', 'invalid workspace_path: ENOENT'), 'invalid workspace_path: ENOENT');
  assert.equal(errorText('weird'), '操作失败（weird）');
});

const T = 'A'.repeat(43);

test('takeTicket accepts only a bare 43-char base64url fragment', () => {
  assert.equal(takeTicket(`#${T}`), T);
  assert.equal(takeTicket(`#t=${T}`), null);
  assert.equal(takeTicket('#short'), null);
  assert.equal(takeTicket('#' + 'A'.repeat(42) + '<'), null);
  assert.equal(takeTicket(''), null);
});

test('session filters', () => {
  const s = { id: 'abc', name: null, workspace_path: 'D:\\work\\blackhole', status: 'active' };
  assert.equal(baseName(s.workspace_path), 'blackhole');
  assert.equal(sessionTitle(s), 'blackhole');
  assert.ok(matchSession(s, 'live', ''));
  assert.ok(matchSession(s, 'active', 'BLACK'));
  assert.ok(!matchSession(s, 'paused', ''));
  assert.ok(!matchSession({ ...s, status: 'revoked' }, 'live', ''));
  assert.ok(matchSession({ ...s, status: 'archived' }, 'ended', ''));
  assert.ok(!matchSession(s, 'all', 'nomatch'));
});

test('call filters and preview', () => {
  const c = { tool: 'exec', status: 'completed', result_summary: 'exit 0', args: { command: 'git   status' } };
  assert.equal(argsPreview(c.args), 'git status');
  assert.ok(matchCall(c, 'exec', 'completed', 'git'));
  assert.ok(!matchCall(c, 'editor', '', ''));
  assert.ok(!matchCall(c, '', 'failed', ''));
  assert.equal(argsPreview({ command: 'x'.repeat(200) }, 10), 'xxxxxxxxxx…');
});

test('relative time and percent', () => {
  const now = Date.parse('2026-09-26T12:00:00Z');
  const ago = (ms) => new Date(now - ms).toISOString();
  assert.equal(relativeTime(ago(3_000), now), '刚刚');
  assert.equal(relativeTime(ago(42_000), now), '42 秒前');
  assert.equal(relativeTime(ago(5 * 60_000), now), '5 分钟前');
  assert.equal(relativeTime(ago(3 * 3_600_000), now), '3 小时前');
  assert.equal(relativeTime(ago(2 * 86_400_000), now), '2 天前');
  assert.equal(relativeTime(null, now), '—');
  assert.equal(percent(1, 3), 33);
  assert.equal(percent(0, 0), 0);
});

test('tones pair every status with a colour role', () => {
  assert.equal(sessionTone('active', true), 'run');
  assert.equal(sessionTone('active', false), 'ok');
  assert.equal(sessionTone('paused', false), 'warn');
  assert.equal(sessionTone('revoked', false), 'muted');
  assert.equal(callTone('failed'), 'bad');
  assert.equal(callTone('denied'), 'bad');
  assert.equal(callTone('awaiting'), 'warn');
  assert.equal(callTone('started'), 'run');
});

test('filter counts', () => {
  const list = [{ status: 'active' }, { status: 'paused' }, { status: 'revoked' }, { status: 'archived' }].map((x, i) => ({ ...x, id: String(i), name: null, workspace_path: '/w' }));
  assert.deepEqual(countByFilter(list), { live: 2, active: 1, paused: 1, ended: 2, all: 4 });
});

test('underPath: case-insensitive, either slash, no prefix false positives', () => {
  assert.ok(underPath('D:\\a\\b', 'd:/a'));
  assert.ok(underPath('D:\\a\\', 'D:\\a'));
  assert.ok(!underPath('D:\\ab', 'D:\\a'));
  assert.ok(!underPath('D:\\a', 'D:\\a\\b'));
});

test('groupSessions: deepest project, pinned first, ended to recent', () => {
  const t = (m) => new Date(Date.UTC(2026, 0, 1, 0, m)).toISOString();
  const S = (id, path, status, m) => ({ id, name: null, workspace_path: path, status, last_active_at: t(m), created_at: t(0) });
  const projects = [
    { id: 'p1', path: 'D:\\w', label: 'w', pinned: false },
    { id: 'p2', path: 'D:\\w\\app', label: 'app', pinned: false },
    { id: 'p3', path: 'E:\\z', label: 'z', pinned: true },
  ];
  const sessions = [S('a', 'D:\\w\\app\\src', 'active', 5), S('b', 'D:\\w\\x', 'paused', 9), S('c', 'F:\\loose', 'active', 1), S('d', 'D:\\w', 'revoked', 7), S('e', 'D:\\w', 'active', 3)];
  const r = groupSessions(projects, sessions);
  assert.deepEqual(r.groups.map((g) => g.project.id), ['p3', 'p1', 'p2']);
  assert.deepEqual(r.groups.find((g) => g.project.id === 'p1').sessions.map((x) => x.id), ['b', 'e']);
  assert.deepEqual(r.groups.find((g) => g.project.id === 'p2').sessions.map((x) => x.id), ['a']);
  assert.deepEqual(r.recent.map((x) => x.id), ['d']);
  assert.deepEqual(r.loose.map((x) => x.id), ['c']);
});

test('pathCrumbs and callDuration', () => {
  assert.deepEqual(pathCrumbs('D:\\work\\tools\\demo'), ['work', 'tools', 'demo']);
  assert.deepEqual(pathCrumbs('/home/u/a/b', 2), ['a', 'b']);
  const at = (ms) => new Date(Date.UTC(2026, 0, 1) + ms).toISOString();
  assert.equal(callDuration({ status: 'completed', created_at: at(0), updated_at: at(420) }), '420ms');
  assert.equal(callDuration({ status: 'failed', created_at: at(0), updated_at: at(2500) }), '2.5s');
  assert.equal(callDuration({ status: 'completed', created_at: at(0), updated_at: at(125_000) }), '2m5s');
  assert.equal(callDuration({ status: 'started', created_at: at(0), updated_at: at(9000) }), null);
  assert.equal(callDuration({ status: 'completed', created_at: null, updated_at: at(1) }), null);
});

test('searchAll: live sessions when empty; ranks exact > prefix > substring; projects by label', () => {
  const sessions = [
    { id: '11', name: 'api', workspace_path: 'D:\\srv\\api', status: 'active' },
    { id: '22', name: 'web-api', workspace_path: 'D:\\web', status: 'active' },
    { id: '33', name: 'old', workspace_path: 'D:\\old', status: 'revoked' },
  ];
  const projects = [{ id: 'p', path: 'D:\\apis', label: 'apis', pinned: false }];
  assert.deepEqual(searchAll('', sessions, projects).map((h) => h.id), ['11', '22']);
  assert.deepEqual(searchAll('api', sessions, projects).map((h) => h.id), ['11', 'p', '22']);
  assert.deepEqual(searchAll('old', sessions, projects).map((h) => h.id), ['33']);
  assert.deepEqual(searchAll('33', sessions, projects).map((h) => h.id), ['33']);
});

test('shortTime: relative within a week, then month-day; year only when different', () => {
  const now = Date.parse('2026-09-27T12:00:00');
  assert.equal(shortTime(new Date(now - 3 * 3600_000).toISOString(), now), '3 小时前');
  assert.equal(shortTime(new Date('2026-09-15T17:12:53').toISOString(), now), '9月15日');
  assert.equal(shortTime(new Date('2025-12-31T10:00:00').toISOString(), now), '2025年12月31日');
  assert.equal(shortTime(null, now), '—');
});

test('pickDefaultSession: running, then most recent live, else newest', () => {
  const S = (id, status, m, activity = null) => ({ id, name: null, workspace_path: '/w', status, activity, last_active_at: new Date(Date.UTC(2026, 0, 1, 0, m)).toISOString(), created_at: null });
  assert.equal(pickDefaultSession([S('a', 'active', 50), S('b', 'active', 10, 'running'), S('c', 'active', 59)]).id, 'b');
  assert.equal(pickDefaultSession([S('a', 'active', 5), S('c', 'paused', 40), S('d', 'revoked', 59)]).id, 'c');
  assert.equal(pickDefaultSession([S('a', 'revoked', 5), S('d', 'archived', 9)]).id, 'd');
  assert.equal(pickDefaultSession([]), undefined);
});
