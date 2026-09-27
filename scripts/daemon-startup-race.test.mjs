import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../dist/storage/db.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitForHealth(base, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(600) });
      if (response.ok) return await response.json();
      lastError = new Error(`health HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw lastError ?? new Error('health timeout');
}

async function waitForExit(child, timeoutMs = 8_000) {
  if (child.exitCode !== null) return child.exitCode;
  return await Promise.race([
    new Promise(resolve => child.once('exit', code => resolve(code))),
    sleep(timeoutMs).then(() => { throw new Error(`process ${child.pid} did not exit`); }),
  ]);
}

test('daemon startup tolerates a retiring SQLite writer and stale shutdowns cannot kill its replacement', { timeout: 30_000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-daemon-race-'));
  const dbPath = path.join(dir, 'blackhole.db');
  const proxyPath = path.join(dir, 'mcp-proxies.yaml');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const initial = openDb(dbPath);
  const busy = initial.db.prepare('PRAGMA busy_timeout').get();
  assert.equal(Number(Object.values(busy)[0]), 5_000, 'openDb installs a bounded SQLite busy timeout');
  initial.close();

  const holderScript = [
    "import { DatabaseSync } from 'node:sqlite';",
    'const db = new DatabaseSync(process.argv[1]);',
    "db.exec('PRAGMA journal_mode = WAL; BEGIN IMMEDIATE;');",
    "process.stdout.write('LOCKED\\n');",
    "setTimeout(() => { db.exec('COMMIT;'); db.close(); process.exit(0); }, 1800);",
  ].join('\n');
  const holder = spawn(process.execPath, ['--input-type=module', '-e', holderScript, dbPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  let holderOutput = '';
  holder.stdout.on('data', chunk => { holderOutput += chunk; });
  holder.stderr.on('data', chunk => { holderOutput += chunk; });
  t.after(() => { if (holder.exitCode === null) holder.kill('SIGKILL'); });
  const lockDeadline = Date.now() + 5_000;
  while (!holderOutput.includes('LOCKED') && holder.exitCode === null && Date.now() < lockDeadline) await sleep(20);
  assert.match(holderOutput, /LOCKED/, `holder failed to acquire lock: ${holderOutput}`);

  const port = await freePort();
  const fingerprint = 'daemon-startup-race-fixture';
  const env = {
    ...process.env,
    BLACKHOLE_DB: dbPath,
    BLACKHOLE_PORT: String(port),
    BLACKHOLE_TUNNEL: 'off',
    BLACKHOLE_SEMANTIC: 'off',
    BLACKHOLE_PROXY_CONFIG: proxyPath,
    BLACKHOLE_START_FINGERPRINT: fingerprint,
  };
  const daemon = spawn(process.execPath, ['dist/cli.js', 'serve', '--port', String(port), '--db', dbPath, '--tunnel', 'off'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let daemonOutput = '';
  daemon.stdout.on('data', chunk => { daemonOutput += chunk; });
  daemon.stderr.on('data', chunk => { daemonOutput += chunk; });
  t.after(() => { if (daemon.exitCode === null) daemon.kill('SIGKILL'); });
  await sleep(300);
  assert.equal(holder.exitCode, null, 'fixture writer still holds the database lock');
  assert.equal(daemon.exitCode, null, `daemon exited instead of waiting for the transient lock: ${daemonOutput}`);
  assert.doesNotMatch(daemonOutput, /database is locked/i);

  const base = `http://127.0.0.1:${port}`;
  const health = await waitForHealth(base);
  assert.equal(health.start_fingerprint, fingerprint);
  assert.ok(typeof health.daemon_id === 'string' && health.daemon_id.length > 0);
  assert.doesNotMatch(daemonOutput, /database is locked/i);

  const stale = await fetch(`${base}/api/shutdown`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ daemon_id: 'stale-daemon-id', start_fingerprint: health.start_fingerprint }),
  });
  assert.equal(stale.status, 409);
  assert.deepEqual(await stale.json(), { error: 'daemon_changed', daemon_id: health.daemon_id });
  assert.equal((await waitForHealth(base, 2_000)).daemon_id, health.daemon_id, 'stale shutdown leaves the replacement alive');

  // 0.3.165 sent no preconditions; 0.3.167 sent only daemon_id. Neither
  // older extension host may terminate the replacement after an upgrade.
  for (const body of [{}, { daemon_id: health.daemon_id },
    { daemon_id: health.daemon_id, start_fingerprint: 'stale-fingerprint' }]) {
    const legacy = await fetch(`${base}/api/shutdown`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal(legacy.status, 409, 'missing/stale shutdown preconditions must be rejected');
    assert.equal((await waitForHealth(base, 2_000)).daemon_id, health.daemon_id);
  }

  const accepted = await fetch(`${base}/api/shutdown`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ daemon_id: health.daemon_id, start_fingerprint: health.start_fingerprint }),
  });
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { ok: true });
  assert.equal(await waitForExit(daemon), 0, daemonOutput);
  assert.equal(await waitForExit(holder), 0, holderOutput);
  assert.doesNotMatch(daemonOutput, /database is locked/i);

});


test('concurrent daemon starts claim the loopback port before touching shared SQLite', { timeout: 30_000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-daemon-singleton-'));
  const dbPath = path.join(dir, 'blackhole.db');
  const proxyPath = path.join(dir, 'mcp-proxies.yaml');
  const port = await freePort();
  const baseEnv = {
    ...process.env,
    BLACKHOLE_DB: dbPath,
    BLACKHOLE_PORT: String(port),
    BLACKHOLE_TUNNEL: 'off',
    BLACKHOLE_SEMANTIC: 'off',
    BLACKHOLE_PROXY_CONFIG: proxyPath,
  };
  const launch = fingerprint => {
    const child = spawn(process.execPath, ['dist/cli.js', 'serve', '--port', String(port), '--db', dbPath, '--tunnel', 'off'], {
      env: { ...baseEnv, BLACKHOLE_START_FINGERPRINT: fingerprint },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    return { child, fingerprint, get output() { return output; } };
  };
  const a = launch('race-a'), b = launch('race-b');
  t.after(() => {
    for (const item of [a, b]) if (item.child.exitCode === null) item.child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  const health = await waitForHealth(base);
  const winner = health.start_fingerprint === a.fingerprint ? a : health.start_fingerprint === b.fingerprint ? b : undefined;
  assert.ok(winner, `unexpected startup fingerprint: ${health.start_fingerprint}`);
  const loser = winner === a ? b : a;
  const loserCode = await waitForExit(loser.child);
  assert.notEqual(loserCode, 0, loser.output);
  assert.match(loser.output, /EADDRINUSE|address already in use/i);
  assert.doesNotMatch(loser.output, /database is locked|storage: retention|context_search:|blackhole daemon v/i,
    'the losing process must fail at the kernel port claim before database startup');
  assert.equal(winner.child.exitCode, null, winner.output);

  const accepted = await fetch(`${base}/api/shutdown`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ daemon_id: health.daemon_id, start_fingerprint: health.start_fingerprint }),
  });
  assert.equal(accepted.status, 200);
  assert.equal(await waitForExit(winner.child), 0, winner.output);
  assert.doesNotMatch(`${a.output}\n${b.output}`, /database is locked/i);
});
