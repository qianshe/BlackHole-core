import assert from 'node:assert/strict';
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

const url = 'https://reconnect-test.trycloudflare.com';
const probes = [
  { ok: true },
  { ok: false, kind: 'http', status: 530, detail: 'edge answered 530' },
  { ok: false, kind: 'http', status: 530, detail: 'edge answered 530' },
  { ok: true },
];
const children = [];
const events = [];

const tm = new TunnelManager(7399, {
  enabled: true,
  bin: process.execPath,
  probe: async () => probes.shift() ?? { ok: true },
  healthCheckIntervalMs: 10,
  healthFailureThreshold: 2,
  reconnectBackoffBaseMs: 1,
  reconnectBackoffMaxMs: 1,
  spawnProcess: () => {
    const child = new FakeChild();
    children.push(child);
    queueMicrotask(() => child.stdout.emit('data', `${url}\n`));
    return child;
  },
  onEvent: (status, detail) => events.push({ status, detail }),
  log: () => undefined,
});

const waitFor = async (predicate, manager = tm, childList = children, timeoutMs = 1500) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for condition (status=${manager.status}, starts=${childList.length})`);
};

tm.start('quick');
await waitFor(() => tm.status === 'online');
assert.equal(children.length, 1, 'initial start should create one child');

await waitFor(() => children.length === 2 && tm.status === 'online');
assert.equal(tm.url, url, 'the recovered quick tunnel should publish its current URL');
assert.ok(events.some((event) => event.status === 'starting' && event.detail.reconnecting === true), 'reconnect should be observable');

await tm.stop();
assert.equal(tm.status, 'off');

const networkChildren = [];
let networkProbeKind = 'dns';
const networkTm = new TunnelManager(7399, {
  enabled: true,
  bin: process.execPath,
  probe: async () => networkProbeKind === 'dns'
    ? { ok: false, kind: 'dns', detail: 'cannot resolve the public hostname locally (ENOTFOUND)' }
    : { ok: false, kind: 'reset', detail: 'ECONNRESET' },
  healthCheckIntervalMs: 10,
  healthFailureThreshold: 2,
  reconnectBackoffBaseMs: 1,
  reconnectBackoffMaxMs: 1,
  spawnProcess: () => {
    const child = new FakeChild();
    networkChildren.push(child);
    queueMicrotask(() => child.stdout.emit('data', `${url}\n`));
    return child;
  },
  onEvent: () => undefined,
  log: () => undefined,
});

networkTm.start('quick');
await waitFor(() => networkTm.status === 'online', networkTm, networkChildren);
assert.equal(networkTm.url, url, 'a registered quick-tunnel URL must remain published when local DNS cannot resolve it');
assert.match(networkTm.reason ?? '', /ENOTFOUND/, 'startup DNS failure should be reported as a local self-probe problem');
assert.match(networkTm.reason ?? '', /连接器正常.*通常无需处理/, 'startup DNS failure must not be treated as channel-offline evidence');
networkProbeKind = 'reset';
await new Promise((resolve) => setTimeout(resolve, 90));
assert.equal(networkChildren.length, 1, 'local probe resets must not rotate a possibly-healthy public URL');
assert.equal(networkTm.status, 'online', 'local self-probe failures must not downgrade a registered connector');
assert.match(networkTm.reason ?? '', /本机检测公网地址被中断.*连接器正常/, 'online status should retain a user-facing local-probe warning');
await networkTm.stop();

console.log('tunnel reconnect fallback: ok');
