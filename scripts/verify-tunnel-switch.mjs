import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { TunnelManager } from '../dist/tunnel/manager.js';

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.exitCode = null;
  }

  kill() {
    if (this.exitCode !== null) return false;
    this.exitCode = 0;
    queueMicrotask(() => this.emit('exit', 0, null));
    return true;
  }
}

const quickUrl = 'https://switch-test.trycloudflare.com';
const namedUrl = 'https://bh.switch-test.example';
// FakeChild prints a URL the moment it is spawned; the KIND decides which
// line the manager should accept (quick scans for trycloudflare, named for
// the "registered tunnel connection" banner).
const children = [];
const spawnCalls = [];
const events = [];

const tm = new TunnelManager(7399, {
  enabled: true,
  bin: process.execPath,
  namedUrl,
  tunnelName: 'blackhole',
  probe: async () => ({ ok: true }),
  spawnProcess: (bin, args) => {
    spawnCalls.push({ bin, args });
    const child = new FakeChild();
    children.push(child);
    queueMicrotask(() => {
      child.stdout.emit('data', `${quickUrl}\n`);
      child.stderr.emit('data', `INF Registered tunnel connection for ${namedUrl}\n`);
    });
    return child;
  },
  onEvent: (status, detail) => events.push({ status, detail }),
  log: () => undefined,
});

const waitFor = async (predicate, manager = tm, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for condition (status=${manager.status}, mode=${manager.mode})`);
};

// 1. persistent channel comes online first
tm.start('named');
await waitFor(() => tm.status === 'online' && tm.mode === 'named');
assert.equal(children.length, 1, 'named start should spawn exactly one child');
assert.deepEqual(spawnCalls[0].args, ['tunnel', '--no-autoupdate', 'run', 'blackhole'], 'named tunnel must keep its normal config lookup');
assert.equal(tm.url, namedUrl, 'named online should publish the fixed public URL');

// 2. another start while a channel is live must NOT switch it.
// The operator has to click 停止 first, then choose the other channel.
tm.start('quick');
await new Promise((resolve) => setTimeout(resolve, 40));
assert.equal(children.length, 1, 'quick start must be ignored while named is live');
assert.equal(tm.mode, 'named');
assert.equal(tm.status, 'online');
assert.equal(tm.url, namedUrl);

// 3. stop frees the single connector slot.
await tm.stop();
assert.equal(tm.status, 'off');
assert.notEqual(children[0].exitCode, null, 'stop must terminate the named connector');

// 4. only after stop may the temporary channel start.
tm.start('quick');
await waitFor(() => children.length === 2 && tm.status === 'online' && tm.mode === 'quick');
assert.equal(tm.url, quickUrl);
const quickArgs = spawnCalls[1].args;
assert.deepEqual(quickArgs.slice(0, 2), ['tunnel', '--config'], 'quick tunnel must explicitly isolate its config');
const quickConfigPath = quickArgs[2];
assert.equal(fs.readFileSync(quickConfigPath, 'utf8'), '{}\n', 'quick tunnel config must have no ingress rules');

// 5. named start is likewise ignored until quick is stopped.
tm.start('named');
await new Promise((resolve) => setTimeout(resolve, 40));
assert.equal(children.length, 2, 'named start must be ignored while quick is live');
assert.equal(tm.mode, 'quick');
assert.equal(tm.status, 'online');

await tm.stop();
assert.equal(tm.status, 'off');
assert.equal(fs.existsSync(quickConfigPath), false, 'temporary quick-tunnel config must be removed after stop');

// 6. Terminal startup failures clear the attempted mode. Presentation policy
// must never treat a failed quick start as an active quick ingress.
const failureOptions = (spawnProcess, probe = async () => ({ ok: true })) => ({
  enabled: true,
  bin: process.execPath,
  probe,
  spawnProcess,
  onEvent: () => undefined,
  log: () => undefined,
});

const spawnFailure = new TunnelManager(7399, failureOptions(() => { throw new Error('spawn failed'); }));
spawnFailure.start('quick');
await waitFor(() => spawnFailure.status === 'error', spawnFailure);
assert.equal(spawnFailure.mode, undefined, 'a spawn failure must clear the attempted quick mode');
assert.equal(spawnFailure.url, undefined);

const exitFailure = new TunnelManager(7399, failureOptions(() => {
  const child = new FakeChild();
  queueMicrotask(() => { child.exitCode = 1; child.emit('exit', 1, null); });
  return child;
}));
exitFailure.start('quick');
await waitFor(() => exitFailure.status === 'error', exitFailure);
assert.equal(exitFailure.mode, undefined, 'an early child exit must clear the attempted quick mode');
assert.equal(exitFailure.url, undefined);

const edgeFailure = new TunnelManager(7399, failureOptions(
  () => {
    const child = new FakeChild();
    queueMicrotask(() => child.stdout.emit('data', `${quickUrl}\n`));
    return child;
  },
  async () => ({ ok: false, kind: 'http', status: 404, detail: 'edge answered 404' }),
));
edgeFailure.start('quick');
await waitFor(() => edgeFailure.status === 'error', edgeFailure);
assert.equal(edgeFailure.mode, undefined, 'a terminal public-edge failure must clear the attempted quick mode');
assert.equal(edgeFailure.url, undefined);
console.log('tunnel channel stop-before-switch: ok');
