// Public channel resume: an explicitly started channel comes back after a daemon restart or a watchdog stop.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChannelIntent, migrateDecoupledTabs, resumeChannel } from '../dist/tunnel/resume.js';

const memState = () => { const m = new Map(); return { get: (k) => m.get(k), set: (k, v) => m.set(k, v) }; };
const fakeTunnel = (status = 'off') => ({ status, starts: [], start(kind) { this.starts.push(kind); this.status = 'starting'; } });
const deps = (over = {}) => ({ channelIntent: new ChannelIntent(memState()), tunnel: fakeTunnel(), cfg: { tunnel: 'auto' }, log() {}, ...over });

test('nothing remembered: nothing starts', () => {
  const d = deps();
  assert.equal(resumeChannel(d), false);
  assert.deepEqual(d.tunnel.starts, []);
});

test('remembered channel survives a restart and starts once on the next heartbeat', () => {
  const st = memState();
  new ChannelIntent(st).set('named');
  const d = deps({ channelIntent: new ChannelIntent(st) });
  assert.equal(resumeChannel(d), true);
  assert.equal(resumeChannel(d), false, 'already starting: no second start');
  assert.deepEqual(d.tunnel.starts, ['named']);
});

test('watchdog stop (status off) resumes; errors and explicit stop do not', () => {
  const d = deps();
  d.channelIntent.set('quick');
  d.tunnel.status = 'error';
  assert.equal(resumeChannel(d), false, 'no retry loop after an error');
  d.tunnel.status = 'unavailable';
  assert.equal(resumeChannel(d), false);
  d.tunnel.status = 'off';
  assert.equal(resumeChannel(d), true, 'watchdog-closed channel comes back');
  d.tunnel.status = 'off';
  d.channelIntent.clear();
  assert.equal(resumeChannel(d), false, 'explicit stop is final');
});

test('launcher turned the channel off (custom channel mode): never resumes', () => {
  const d = deps({ cfg: { tunnel: 'off' } });
  d.channelIntent.set('quick');
  assert.equal(resumeChannel(d), false);
});

test('tab decoupling migration: custom-tab intent is dropped exactly once; other tabs keep theirs', () => {
  const st = memState();
  new ChannelIntent(st).set('named');
  assert.equal(migrateDecoupledTabs(st, 'custom'), true, 'intent remembered under the custom tab is dropped');
  assert.equal(new ChannelIntent(st).get(), null);
  new ChannelIntent(st).set('quick');
  assert.equal(migrateDecoupledTabs(st, 'custom'), false, 'runs once: a channel started after the upgrade is kept');
  assert.equal(new ChannelIntent(st).get(), 'quick');
  for (const mode of ['cloudflare', 'openai']) {
    const s = memState();
    new ChannelIntent(s).set('named');
    assert.equal(migrateDecoupledTabs(s, mode), false, mode);
    assert.equal(new ChannelIntent(s).get(), 'named', mode + ' keeps its remembered channel');
    assert.equal(s.get('channel.tabs_decoupled.v1'), '1');
  }
  const empty = memState();
  assert.equal(migrateDecoupledTabs(empty, 'custom'), false, 'nothing remembered: nothing to drop');
  assert.equal(empty.get('channel.tabs_decoupled.v1'), '1');
});

test('storage: unknown values read as nothing remembered', () => {
  const st = memState();
  st.set('tunnel.desired.v1', 'weird');
  assert.equal(new ChannelIntent(st).get(), null);
});
