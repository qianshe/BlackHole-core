import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMembershipCatalogue, parseMembershipStatus, membershipPlanLabel } from '../dist/membership.js';
import { validSettingsRequest } from '../dist/settings-host.js';
const now = 1792144800;
const plan = { sku: 'opaque-month', displayName: '会员', amountMinor: 1990, currency: 'CNY', durationPeriod: 'MONTH' };
const catalogue = { enabled: true, salesEnabled: true, productId: 'DIRECT_example', productName: 'BlackHole', capabilityStatus: 'ENABLED', plans: [plan], checkedAt: now };
test('all renderers consume calendar periods and server prices, not a fixed day SKU', () => {
  assert.deepEqual(parseMembershipCatalogue(catalogue), catalogue);
  assert.equal(membershipPlanLabel(plan), '会员 · 一个月 · ¥19.90');
  for (const durationPeriod of ['DAY', '30_DAYS', '']) assert.throws(() => parseMembershipCatalogue({ ...catalogue, plans: [{ ...plan, durationPeriod }] }));
  for (const amountMinor of [-1, 19.9, NaN, Infinity, '1990']) assert.throws(() => parseMembershipCatalogue({ ...catalogue, plans: [{ ...plan, amountMinor }] }));
  assert.throws(() => parseMembershipCatalogue({ ...catalogue, plans: [plan, plan] }));
});
test('unknown or disabled catalogue has no sale/price fallback', () => {
  assert.deepEqual(parseMembershipCatalogue({ ...catalogue, enabled: false, salesEnabled: false, plans: [], capabilityStatus: 'UNAVAILABLE' }).plans, []);
  assert.throws(() => parseMembershipCatalogue({ ...catalogue, enabled: false }));
  assert.throws(() => parseMembershipCatalogue({ ...catalogue, capabilityStatus: 'DISABLED' }));
});
test('membership state cannot authorize a repeated purchase or an expired interval', () => {
  const state = { decision: 'ALLOW', validFrom: now - 100, validUntil: now + 100, legacyExpiresAt: 0, canPurchase: false, checkedAt: now };
  assert.deepEqual(parseMembershipStatus(state), state);
  assert.throws(() => parseMembershipStatus({ ...state, canPurchase: true }));
  assert.throws(() => parseMembershipStatus({ ...state, validUntil: now }));
  assert.throws(() => parseMembershipStatus({ ...state, decision: 'DENY' }));
  assert.throws(() => parseMembershipStatus({ ...state, decision: 'PURCHASE_REQUIRED', validFrom: null, validUntil: null, legacyExpiresAt: now + 100, canPurchase: true }));
});
test('host bridge only admits named membership operations, never arbitrary purchase URLs or query identities', () => {
  for (const [method, path] of [['GET','/account/membership'],['GET','/account/membership/status'],['POST','/account/membership/checkout']]) assert.equal(validSettingsRequest({ id:'t', method, path, ...(method==='POST'?{body:{}}:{}) }), true);
  for (const path of ['/account/membership?userId=other','/account/membership/notify','/account/membership/checkout?url=https://evil.invalid','//evil.invalid']) assert.equal(validSettingsRequest({ id:'t',method:'POST',path,body:{} }), false);
});
