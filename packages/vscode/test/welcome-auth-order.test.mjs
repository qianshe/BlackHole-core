import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/sidebar.ts', import.meta.url), 'utf8');
const match = source.match(/    function onboardingState\(d\) \{[\s\S]*?\n    \}/);
assert.ok(match, 'sidebar onboarding state function must be present');
const stage = vm.runInNewContext('(' + match[0].trim() + ')');

const state = (account, options = {}) => ({
  account, setup: null, openaiOnboarding: null, setupConfigured: false, setupDismissed: false, ...options,
});

test('logged-out users must see login, never connection choices', () => {
  assert.equal(stage(state('logged_out')), 'login');
  assert.equal(stage(state('logged_out', { setup: { step: 'install' } })), 'login');
  assert.equal(stage(state('logged_out', { setupConfigured: true })), 'login');
});
test('uncertain/saved identity is not treated as signed in', () => {
  for (const account of [null, undefined, 'saved', 'unavailable'])
    assert.equal(stage(state(account)), 'account-check', String(account));
});
test('verified users choose channels only if not configured or skipped', () => {
  assert.equal(stage(state('verified')), 'choose');
  assert.equal(stage(state('verified', { setupConfigured: true })), null);
  assert.equal(stage(state('verified', { setupDismissed: true })), null);
  assert.equal(stage(state('verified', { setupConfigured: null })), 'setup-check');
});
test('channel preparation is shown only after a verified account', () => {
  assert.equal(stage(state('verified', { setup: { step: 'install' } })), 'install');
  assert.equal(stage(state('verified', { openaiOnboarding: { step: 'connecting' } })), 'openai');
  assert.equal(stage(state('saved', { openaiOnboarding: { step: 'connecting' } })), 'account-check');
});
test('welcome renders no channel action inside login step, and keeps direct choice after sign-in', () => {
  const loginCase = source.split("} else if (state === 'login') {")[1]?.split("} else if (state === 'ready')")[0];
  assert.ok(loginCase, 'login content should have a dedicated branch');
  assert.doesNotMatch(loginCase, /id="guideQuick"|id="guideOpenai"|id="guideDirect"|guideQuick.*?guideOpenai/s,
    'pre-login stage should not expose channel installation actions');
  const chooseCase = source.split("body = '<h2 id=\"guideTitle\" tabindex=\"-1\">选择连接方式")[1];
  assert.ok(chooseCase, 'connection-choice stage should exist');
  assert.match(chooseCase, /id="guideQuick"/);
  assert.match(chooseCase, /id="guideOpenai"/);
  assert.match(chooseCase, /id="guideDirect"/);
});
