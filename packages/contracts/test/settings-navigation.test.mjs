import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SETTINGS_PAGES,
  SETTINGS_LABELS,
  renderSettingsNavItems,
  SettingsRouteSchema,
  settingsRouteFromLegacy,
  normalizeSettingsRoute,
} from '../dist/index.js';

test('settings pages are stable and overview migrates to home', () => {
  assert.deepEqual(SETTINGS_PAGES, ['home', 'connections', 'network', 'agents', 'security', 'account', 'advanced']);
  assert.deepEqual(settingsRouteFromLegacy('devices'), { page: 'security', section: 'devices' });
  assert.deepEqual(settingsRouteFromLegacy('overview'), { page: 'home' });
  assert.deepEqual(settingsRouteFromLegacy('channel'), { page: 'connections', section: 'channels' });
  assert.deepEqual(settingsRouteFromLegacy('proxies'), { page: 'agents', section: 'proxies' });
});

test('settings navigation uses concise consistent labels without changing page keys', () => {
  const expected = { home: '首页', connections: '连接与渠道', network: '直连', agents: 'Agent 与工具', security: '安全', account: '账号与订阅', advanced: '高级' };
  assert.deepEqual(SETTINGS_LABELS, expected);
  assert.deepEqual(Object.keys(expected), [...SETTINGS_PAGES]);
  const html = renderSettingsNavItems({ page: 'home', buttonClassName: 'nav', iconClassName: 'icon', labelClassName: 'text' });
  for (const [id, label] of Object.entries(expected)) {
    assert.ok(html.includes(`data-settings-target="${id}" aria-label="${label}"`), id);
    assert.ok(html.includes(`class="text">${label}</span>`), id);
  }
});

test('invalid settings routes fall back without carrying arbitrary values', () => {
  assert.deepEqual(normalizeSettingsRoute({ page: 'nope', field: 'x' }), { page: 'home' });
  assert.equal(SettingsRouteSchema.safeParse({ page: 'network', field: 'proxy.password', secret: 'x' }).success, false);
  assert.equal(SettingsRouteSchema.safeParse({ page: 'network', section: '../x' }).success, false);
});
