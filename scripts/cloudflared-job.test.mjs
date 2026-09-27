// cloudflared initialization job owned by the daemon: single instance, polled state, never saves.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CloudflaredJob } from '../dist/tunnel/cloudflared-job.js';

const deferred = () => { let resolve, reject; const p = new Promise((a, b) => { resolve = a; reject = b; }); return { p, resolve, reject }; };

test('single instance: a second start while running is ignored', async () => {
  const d = deferred(); const calls = [];
  const job = new CloudflaredJob((p) => { calls.push(p); return d.p; });
  assert.equal(job.view().state, 'idle');
  assert.equal(job.start(''), true);
  assert.equal(job.start('/other'), false);
  assert.equal(job.view().state, 'running');
  d.resolve({ path: '/bin/cloudflared', installed: true });
  await d.p; await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, ['']);
  const v = job.view();
  assert.equal(v.state, 'done'); assert.equal(v.path, '/bin/cloudflared'); assert.equal(v.installed, true);
});

test('failure is reported and a new run may start', async () => {
  const job = new CloudflaredJob(async () => { throw new Error('下载失败'); });
  job.start('');
  await new Promise((r) => setImmediate(r));
  assert.equal(job.view().state, 'error');
  assert.equal(job.view().error, '下载失败');
  assert.equal(job.start(''), true);
});
