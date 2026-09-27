// Isolated real-daemon/real-clock gate; deliberately takes just over one minute.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

if (process.argv.includes('--fixture-daemon')) {
  const { startDaemon } = await import('../dist/daemon.js');
  const daemon = await startDaemon({ port: Number(process.env.SMOKE_PORT), dbPath: process.env.BLACKHOLE_DB, tunnel: 'off' }, () => {});
  process.on('message', message => {
    if (message === 'stop') void daemon.stop().then(() => process.exit(0), () => process.exit(1));
  });
  process.send({ ready: true });
} else {
  test('real HTTP daemon: connections stay idle, tools become running, timer expires without another tool', { timeout: 90_000 }, async t => {
    fs.mkdirSync('.cache/tests', { recursive: true });
    const root = fs.mkdtempSync(path.resolve('.cache/tests/session-activity-http-'));
    const home = path.join(root, 'home'); fs.mkdirSync(home);
    const socket = net.createServer();
    await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
    const port = socket.address().port;
    await new Promise(resolve => socket.close(resolve));
    const env = { ...process.env,
      HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
      BLACKHOLE_DB: path.join(root, 'fixture.db'), BLACKHOLE_TUNNEL: 'off', BLACKHOLE_PUBLIC_URL: '',
      BLACKHOLE_SEMANTIC: 'off', BLACKHOLE_SEMANTIC_KEY: '', BLACKHOLE_SEMANTIC_KEY_FILE: path.join(home, 'semantic-key'),
      BLACKHOLE_PROXY_CONFIG: path.join(home, 'missing-proxies.yaml'), BLACKHOLE_SKILLS_DIR: '', SMOKE_PORT: String(port),
    };
    delete env.BLACKHOLE_PUBLIC_URL; // Unset, not an empty origin override.
    const child = fork(fileURLToPath(import.meta.url), ['--fixture-daemon'], { env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const clients = [];
    const exited = new Promise(resolve => child.once('exit', resolve));
    t.after(async () => {
      for (const client of clients) await client.close().catch(() => {});
      if (child.connected) child.send('stop');
      let timer;
      await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => { child.kill(); resolve(); }, 4000); })]);
      clearTimeout(timer); await exited;
      fs.rmSync(root, { recursive: true, force: true });
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('isolated daemon startup timeout')), 12_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); reject(Error(`isolated daemon exited before ready: ${code}`)); });
      child.once('message', message => { clearTimeout(timer); message.ready ? resolve() : reject(Error('unexpected fixture message')); });
    });
    const base = `http://127.0.0.1:${port}`;
    const api = async (route, body) => {
      const res = await fetch(base + '/api' + route, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      assert.ok(res.ok); return res.json();
    };
    const session = await api('/sessions', { workspace_path: root, permission_mode: 'danger-full-access', name: 'activity fixture' });
    assert.equal(session.activity, 'idle');
    assert.equal(new URL(session.mcp_url).origin, base, 'fixture must stay on its own loopback daemon');
    for (let i = 0; i < 2; i++) {
      const client = new Client({ name: `fixture-agent-${i}`, version: '1' }); clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL(session.mcp_url)));
      await client.listTools();
    }
    assert.equal((await api(`/sessions/${session.id}`)).activity, 'idle');
    for (const client of clients) await client.callTool({ name: 'guide', arguments: { sessionId: session.session_id } });
    assert.equal((await api(`/sessions/${session.id}`)).activity, 'running');
    const epoch = (await api('/changes')).epoch;
    await delay(60_100); // Real monotonic clock and default unref timer, not an injected clock.
    assert.ok((await api('/changes')).epoch > epoch);
    assert.equal((await api(`/sessions/${session.id}`)).activity, 'idle');
  });
}
