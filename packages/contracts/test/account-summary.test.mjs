import test from 'node:test';
import assert from 'node:assert/strict';
import { accountSummary, accountSummaryKey, formatRemaining } from '../dist/index.js';

test('remaining time is precise enough and unknown never becomes expired', () => {
  assert.equal(formatRemaining(null), '时长待确认');
  assert.equal(formatRemaining(0), '订阅已到期');
  assert.equal(formatRemaining(30), '剩余不足 1 分钟');
  assert.equal(formatRemaining(5 * 60), '剩余 5 分钟');
  assert.equal(formatRemaining(8 * 3600 + 32 * 60), '剩余 8 小时 32 分钟');
  assert.equal(formatRemaining(12 * 86400 + 6 * 3600), '剩余 12 天 6 小时');
});

test('summary prefers name and keeps verified updates distinguishable', () => {
  const a = accountSummary({ state: 'verified', userId: 'user_123456789012345', checkedAt: 10, remainingSeconds: 3600, account: { name: 'Alice', email: 'a@example.test', status: 'active', serviceExpiresAt: 999 } });
  const b = accountSummary({ state: 'verified', userId: 'user_123456789012345', checkedAt: 20, remainingSeconds: 7200, account: { name: 'Alice', email: 'a@example.test', status: 'active', serviceExpiresAt: 1999 } });
  assert.equal(a.displayName, 'Alice');
  assert.equal(a.remainingSeconds, 3600);
  assert.notEqual(accountSummaryKey(a), accountSummaryKey(b));
});

test('unavailable and saved states remain unknown rather than pretending expiry', () => {
  assert.equal(accountSummary({ state: 'unavailable', userId: 'u' }).remainingSeconds, null);
  assert.equal(accountSummary({ state: 'saved', userId: 'u' }).freshness, 'saved');
});


test('unknown identity is never presented as a signed-in account and cannot sign out', () => {
  for (const input of [null, undefined, { state: 'unavailable' }, { state: 'saved' }, { state: 'verified', userId: ' ' }]) {
    const summary = accountSummary(input);
    assert.equal(summary.displayName, '账号状态待确认');
    assert.equal(summary.userId, null);
    assert.equal(summary.canSignOut, false);
    assert.equal(summary.remainingSeconds, null);
    assert.equal(summary.freshness, 'unknown');
  }
});

test('logged-out or identity-less snapshots never carry stale account details', () => {
  for (const state of ['logged_out', 'unavailable']) {
    const summary = accountSummary({ state, ...(state === 'logged_out' ? { userId: 'old-user' } : {}), checkedAt: 10, remainingSeconds: 900,
      account: { name: 'Old account', email: 'old@example.test', status: 'active', serviceExpiresAt: 999 } });
    assert.equal(summary.displayName, state === 'logged_out' ? '未登录' : '账号状态待确认');
    assert.equal(summary.email, null);
    assert.equal(summary.canSignOut, false);
    assert.equal(summary.remainingSeconds, null);
    assert.equal(summary.serviceExpiresAt, null);
    assert.equal(summary.checkedAt, null);
  }
});

test('known identity remains removable when online verification is unavailable', () => {
  const summary = accountSummary({ state: 'unavailable', userId: 'fixture-user' });
  assert.equal(summary.displayName, 'fixture-user');
  assert.equal(summary.canSignOut, true);
  assert.equal(summary.freshness, 'unknown');
  assert.equal(summary.remainingSeconds, null);
});
