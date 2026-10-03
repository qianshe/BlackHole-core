// 渠道总开关的文案（用户 2026-10-03）：悬停说明写清开了会启动哪个渠道、缺什么、上次为什么失败；缺前提的码都有提示。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CHANNEL_SWITCH_HINT, switchTitle } from '../src/console/channelSwitchText.ts';

const base = { on: false, state: 'off', running: [], next: 'quick', last: null, missing: null, reason: null };

test('悬停说明：关着时说会启动哪个渠道，开着时说会停止哪些', () => {
  assert.equal(switchTitle(base), '开启：临时渠道');
  assert.equal(switchTitle({ ...base, next: 'named', last: 'named' }), '开启：持久渠道（上次使用）');
  assert.equal(switchTitle({ ...base, missing: 'cloudflared' }), '开启：临时渠道 · 需要先安装 cloudflared');
  assert.equal(switchTitle({ ...base, state: 'error', reason: '连不上' }), '开启：临时渠道 · 上次失败：连不上');
  assert.equal(switchTitle({ ...base, on: true, state: 'on', running: ['quick', 'openai'] }), '关闭：停止临时渠道、OpenAI 渠道');
});

test('缺前提的每个码都有中文提示', () => {
  for (const code of ['cloudflared', 'named_url', 'openai_setup', 'openai_unavailable', 'start_failed']) assert.ok(CHANNEL_SWITCH_HINT[code], code);
});

test('开关组件：role=switch、aria-checked、状态色和减少动效都在；侧栏开关是导航按钮的兄弟而不是子节点', () => {
  const tsx = fs.readFileSync(new URL('../src/console/ChannelSwitch.tsx', import.meta.url), 'utf8');
  assert.match(tsx, /role="switch"/); assert.match(tsx, /aria-checked=\{view\.on\}/); assert.match(tsx, /data-state=\{busy \? 'starting' : view\.state\}/);
  const css = fs.readFileSync(new URL('../src/console/console.module.css', import.meta.url), 'utf8');
  assert.match(css, /\.chSwitch\[data-state='on'\]/); assert.match(css, /prefers-reduced-motion/); assert.match(css, /\.chSwitch:focus-visible/);
  const sidebar = fs.readFileSync(new URL('../src/console/Sidebar.tsx', import.meta.url), 'utf8');
  const row = sidebar.slice(sidebar.indexOf('<div className={c.navRow}>'), sidebar.indexOf('<nav className={c.sideScroll}'));
  assert.ok(row.indexOf('</button>') < row.indexOf('<ChannelSwitch'), '开关在导航按钮之后（不嵌套按钮）');
});
