// Runs the bundled bootstrap against an isolated daemon (never 7306 or the real ~/.blackhole).
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createIsolatedEnv } from '../../../scripts/fixtures/isolated-env.mjs';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const bootstrap = path.join(here, '../dist/bootstrap.cjs');
const daemonEntry = path.join(here, '../../../dist/cli.js');

async function boot(env, extra = []) {
  try {
    const { stdout } = await run(process.execPath, [bootstrap, '--daemon-entry', daemonEntry, '--no-browser', ...extra], { env, timeout: 45_000 });
    return { code: 0, result: JSON.parse(stdout) };
  } catch (e) {
    return { code: e.code, result: JSON.parse(e.stdout) };
  }
}

async function stopDaemon(port) {
  const res = await fetch(`http://127.0.0.1:${port}/api/health`).catch(() => null);
  if (!res) return;
  const h = await res.json();
  await fetch(`http://127.0.0.1:${port}/api/shutdown`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ daemon_id: h.daemon_id, start_fingerprint: h.start_fingerprint ?? null }),
  }).catch(() => null);
  for (let i = 0; i < 40; i++) {
    if (!(await fetch(`http://127.0.0.1:${port}/api/health`).catch(() => null))) return;
    await new Promise((r) => setTimeout(r, 250));
  }
}

test('starts a daemon, then attaches to it without a second spawn', async (t) => {
  const iso = await createIsolatedEnv({ name: 'launcher' });
  t.after(async () => {
    await stopDaemon(iso.port);
    try { iso.cleanup(); } catch { /* windows file locks */ }
  });

  const first = await boot(iso.env);
  assert.equal(first.code, 0, JSON.stringify(first.result));
  assert.equal(first.result.ok, true);
  const r = first.result.receipt;
  assert.equal(r.runtimeKind, 'standalone-node');
  assert.equal(r.localUrl, `http://127.0.0.1:${iso.port}/`);
  assert.deepEqual(r.capabilities, ['web-ui']);
  assert.ok(!JSON.stringify(first.result).match(/ticket|token|secret/i));

  const health = await (await fetch(`http://127.0.0.1:${iso.port}/api/health`)).json();
  assert.equal(health.daemon_id, r.daemonId);
  assert.equal(path.resolve(health.db_path), path.resolve(iso.dbPath));

  const second = await boot(iso.env);
  assert.equal(second.code, 0);
  assert.equal(second.result.receipt.daemonId, r.daemonId, 'must attach, not restart');
  assert.equal(second.result.receipt.runtimeKind, 'vscode-electron');

  // A signed-in ticket can still be issued by the daemon the launcher started.
  const ticket = await fetch(`http://127.0.0.1:${iso.port}/api/web/bootstrap`, { method: 'POST' });
  assert.equal(ticket.status, 200);
});

test('reports port_conflict when something else owns the port', async (t) => {
  const iso = await createIsolatedEnv({ name: 'launcher-conflict' });
  const http = await import('node:http');
  const server = http.createServer((_q, s) => { s.statusCode = 200; s.end('hello'); });
  await new Promise((r) => server.listen(iso.port, '127.0.0.1', r));
  t.after(() => { server.close(); iso.cleanup(); });
  const out = await boot(iso.env);
  assert.equal(out.code, 1);
  assert.equal(out.result.code, 'port_conflict');
});

test('reports runtime_asset_missing for a bad daemon entry', async (t) => {
  const iso = await createIsolatedEnv({ name: 'launcher-missing' });
  t.after(() => iso.cleanup());
  try {
    await run(process.execPath, [bootstrap, '--daemon-entry', path.join(iso.home, 'nope.js'), '--no-browser'], { env: iso.env });
    assert.fail('expected failure');
  } catch (e) {
    const res = JSON.parse(e.stdout);
    assert.equal(res.code, 'runtime_asset_missing');
  }
  assert.ok(!fs.existsSync(path.join(iso.dataDir, 'logs', 'launcher-daemon.log')));
});

async function stopCmd(env) {
  try {
    const { stdout } = await run(process.execPath, [bootstrap, '--stop'], { env, timeout: 30_000 });
    return { code: 0, result: JSON.parse(stdout) };
  } catch (e) {
    return { code: e.code, result: JSON.parse(e.stdout) };
  }
}

test('--stop shuts a running daemon down and is a no-op when nothing runs', async (t) => {
  const iso = await createIsolatedEnv({ name: 'launcher-stop' });
  t.after(async () => {
    await stopDaemon(iso.port);
    try { iso.cleanup(); } catch { /* windows file locks */ }
  });
  const idle = await stopCmd(iso.env);
  assert.deepEqual([idle.code, idle.result.ok, idle.result.stopped, idle.result.code], [0, true, false, 'not_running']);
  const up = await boot(iso.env);
  assert.equal(up.result.ok, true, JSON.stringify(up.result));
  const r = await stopCmd(iso.env);
  assert.deepEqual([r.code, r.result.ok, r.result.stopped], [0, true, true], JSON.stringify(r.result));
  assert.equal(await fetch(`http://127.0.0.1:${iso.port}/api/health`).catch(() => null), null);
});
