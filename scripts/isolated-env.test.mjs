import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createIsolatedEnv, PRODUCTION_PORT } from './fixtures/isolated-env.mjs';

test('isolated env redirects home-derived paths and never uses production defaults', async (t) => {
  const iso = await createIsolatedEnv({ name: 'selftest' });
  t.after(iso.cleanup);
  assert.notEqual(iso.port, PRODUCTION_PORT);
  assert.ok(fs.existsSync(iso.dataDir));
  assert.ok(!iso.dbPath.startsWith(path.join(os.homedir(), '.blackhole')));
  assert.equal(iso.env.BLACKHOLE_TUNNEL, 'off');
  assert.equal(iso.env.BLACKHOLE_PUBLIC_URL, undefined);

  // A child process sees the isolated home, so ~/.blackhole and ~/.agents resolve inside it.
  const probe = spawnSync(process.execPath, ['-e', 'process.stdout.write(require("node:os").homedir())'], { env: iso.env, encoding: 'utf8' });
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(path.resolve(probe.stdout), path.resolve(iso.home));
});

test('isolated env refuses the production port', async () => {
  await assert.rejects(createIsolatedEnv({ name: 'refuse', port: PRODUCTION_PORT }), /production port/);
});

test('cleanup removes the isolated home', async () => {
  const iso = await createIsolatedEnv({ name: 'cleanup' });
  iso.cleanup();
  assert.equal(fs.existsSync(iso.home), false);
});
