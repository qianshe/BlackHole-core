import test from 'node:test';
import assert from 'node:assert/strict';
import { phoneEndpointLabel, phoneEndpoints, phoneSelection, phoneStatus } from '../src/panel/phone-state.ts';
const entry = (origin, kind, state) => ({ origin, kind, scope: 'private', verification: { state, checked_at: null, reason: null } });

test('configured-only and older daemon endpoints never show a green success', () => {
  const endpoints = phoneEndpoints({ origin: 'https://a.test', kind: 'fixed', available: true });
  assert.equal(endpoints[0].verification.state, 'unverified');
  assert.notEqual(phoneStatus(endpoints[0]).cls, 'ok');
  assert.match(phoneStatus(endpoints[0]).text, /未验证/);
});

test('the selected endpoint controls status and quick lifecycle text, not the default', () => {
  const fixed = entry('https://fixed.test', 'fixed', 'passed');
  const quick = entry('https://quick.test', 'quick', 'unverified');
  assert.match(phoneStatus(fixed).text, /固定.*本机检测通过/);
  assert.match(phoneStatus(quick).text, /临时.*未验证/);
  assert.notEqual(phoneStatus(quick).cls, 'ok');
});

test('a removed selection never silently falls back to another available channel', () => {
  const fixed = entry('https://fixed.test', 'fixed', 'passed');
  const quick = entry('https://quick.test', 'quick', 'unverified');
  assert.equal(phoneSelection('', [fixed, quick]), fixed.origin);
  assert.equal(phoneSelection(fixed.origin, [quick]), fixed.origin);
  assert.match(phoneStatus(undefined).note, /不会自动切换/);
});

test('compact endpoint labels distinguish temporary, private and public without claiming reachability', () => {
  assert.equal(phoneEndpointLabel(entry('http://192.168.1.8:7307', 'fixed', 'unverified')), '内网 · 192.168.1.8:7307');
  assert.equal(phoneEndpointLabel({ ...entry('https://quick.example.test', 'quick', 'passed'), scope: 'public' }), '临时渠道 · quick.example.test');
  assert.equal(phoneEndpointLabel({ ...entry('https://example.test', 'fixed', 'unverified'), scope: 'public' }), '固定入口 · example.test');
  assert.equal(phoneEndpointLabel({ ...entry('http://127.0.0.1:7307', 'fixed', 'unverified'), scope: 'loopback' }), '本机 · 127.0.0.1:7307');
});
