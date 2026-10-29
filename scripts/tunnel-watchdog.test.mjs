import test from 'node:test';
import assert from 'node:assert/strict';
import { channelWatchdogMayStop, STALE_MS } from '../dist/tunnel/watchdog.js';
import { managedCoreHasActiveWork } from '../dist/lifecycle/idle-work.js';

const NOW = 500_000;
function fixture() {
  const state = new Map([['session', 'idle']]);
  const d = {
    lastHeartbeatAt: NOW - STALE_MS - 1000,
    webPresence: new Set(),
    sessionActivity: { pendingCount: 0, status: id => state.get(id) ?? 'idle' },
    sessions: { list: () => [{ id: 'session', status: 'active' }] },
    processes: { maintenanceBusy: () => false },
    courier: { maintenanceBusy: () => false },
    confirmations: { pendingCount: () => 0 },
  };
  return { d, state };
}

test('an idle channel still stops after heartbeat expiry; fresh host heartbeat retains it', () => {
  const { d } = fixture();
  assert.equal(managedCoreHasActiveWork(d), false);
  assert.equal(channelWatchdogMayStop(d, NOW), true);
  d.lastHeartbeatAt = NOW - STALE_MS;
  assert.equal(channelWatchdogMayStop(d, NOW), false);
  d.lastHeartbeatAt = NOW - 10_000;
  assert.equal(channelWatchdogMayStop(d, NOW), false);
});

test('managed Core keeps an explicitly started channel across long VS Code inactivity', () => {
  const { d } = fixture();
  d.runtimeIdentity = { lifecycleState: 'managed' };
  assert.equal(channelWatchdogMayStop(d, NOW), false,
    'the signed Core idle supervisor, not an unrelated UI heartbeat, owns exit');
  d.lastHeartbeatAt = NOW - 24 * 60 * 60_000;
  assert.equal(channelWatchdogMayStop(d, NOW), false,
    'sleep or an unfocused Extension Host cannot disable a managed public channel');
  delete d.runtimeIdentity;
  assert.equal(channelWatchdogMayStop(d, NOW), true,
    'legacy non-managed daemons retain their heartbeat-based safety limit');
});

test('an Agent running between MCP tool calls prevents a watchdog channel stop', () => {
  const { d, state } = fixture();
  state.set('session', 'running');
  assert.equal(d.sessionActivity.pendingCount, 0, 'no tool handler is in flight');
  assert.equal(managedCoreHasActiveWork(d), true);
  assert.equal(channelWatchdogMayStop(d, NOW), false);
  state.set('session', 'idle');
  assert.equal(channelWatchdogMayStop(d, NOW), true, 'completed turn permits eventual idle close');
});

test('pending tools, jobs, Courier work and approval requests each keep public transport alive', () => {
  const blockers = [
    d => { d.sessionActivity.pendingCount = 1 },
    d => { d.processes.maintenanceBusy = () => true },
    d => { d.courier.maintenanceBusy = () => true },
    d => { d.confirmations.pendingCount = () => 1 },
    d => { d.webPresence.add({}) },
  ];
  for (const apply of blockers) {
    const { d } = fixture();
    apply(d);
    assert.equal(channelWatchdogMayStop(d, NOW), false);
  }
});

test('missing/unknown work collectors never leave a public channel exposed by default', () => {
  for (const key of ['sessionActivity', 'sessions', 'processes', 'courier', 'confirmations']) {
    const { d } = fixture();
    delete d[key];
    assert.equal(channelWatchdogMayStop(d, NOW), true, key);
  }
  const { d } = fixture();
  d.sessions.list = () => { throw Error('activity_unavailable') };
  assert.equal(channelWatchdogMayStop(d, NOW), true);
});

test('archived, paused, or idle sessions and cached protocol pairs do not suppress stop', () => {
  const { d, state } = fixture();
  state.set('session', 'running');
  d.sessions.list = () => [{ id: 'session', status: 'archived' }];
  d.livePipes = () => 100; // not even inspected: a cached connection is not active work
  assert.equal(channelWatchdogMayStop(d, NOW), true);
});
