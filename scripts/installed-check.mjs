#!/usr/bin/env node
// Installed-artifact check: exercises the VSIX-installed daemon (not the repo
// dist) end to end — boot with a proxy config, create a session, MCP
// tools/list + proxy list/explain/call over the machine URL, clean shutdown
// with no orphaned upstream children. Run after `code --install-extension`
// (from the repo root):   node scripts/installed-check.mjs
// The repo-side approval/panel UI flows stay covered by the proxy E2E suite.
import assert from 'node:assert';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const PORT = Number(process.env.CHECK_PORT ?? 17399);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-installed-'));
const db = path.join(tmp, 'db.sqlite');
const cfgFile = path.join(tmp, 'proxies.yaml');
const ws = path.join(tmp, 'ws');
fs.mkdirSync(ws, { recursive: true });
// forward slashes: valid on Windows, escape-free inside YAML
const FAKE = path.join(process.cwd(), 'scripts', 'fake-upstream.mjs').split(path.sep).join('/');
assert.ok(fs.existsSync(path.join(process.cwd(), 'scripts', 'fake-upstream.mjs')), 'run from the repo root');

// find the newest installed extension daemon
const extRoot = path.join(os.homedir(), '.vscode', 'extensions');
const cands = fs.readdirSync(extRoot)
  .filter((d) => /^blackhole\.blackhole-vscode-\d/.test(d))
  .map((d) => ({ d, v: d.split('-').slice(2).join('-') }))
  .filter((c) => fs.existsSync(path.join(extRoot, c.d, 'dist', 'daemon', 'cli.js')))
  .sort((a, b) => a.v.localeCompare(b.v, undefined, { numeric: true }));
assert.ok(cands.length > 0, 'no installed blackhole extension found — code --install-extension first');
const CLI = path.join(extRoot, cands[cands.length - 1].d, 'dist', 'daemon', 'cli.js');
console.log(`installed daemon: ${CLI}`);

fs.writeFileSync(cfgFile, [
  'proxies:',
  '  - name: gate',
  '    transport: stdio',
  `    command: ${JSON.stringify(process.execPath.split(path.sep).join('/'))}`,
  `    args: [${JSON.stringify(FAKE)}]`,
  '    risk:',
  '      echo: allow',
  '    surface:',
  '      expose: [echo]',
  '',
].join('\n'));

const run = (args) => execFileSync(process.execPath, [CLI, ...args, '--port', String(PORT), '--db', db], { encoding: 'utf8', timeout: 60_000 });
const daemon = spawn(process.execPath, [CLI, 'serve', '--port', String(PORT), '--tunnel', 'off', '--db', db], {
  cwd: tmp,
  env: { ...process.env, BLACKHOLE_PROXY_CONFIG: cfgFile },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let daemonLog = '';
daemon.stdout.on('data', (b) => { daemonLog += b; });
daemon.stderr.on('data', (b) => { daemonLog += b; });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  // 1. health
  let up = false;
  let version = '';
  for (let i = 0; i < 40; i++) {
    try {
      const h = await (await fetch(`http://127.0.0.1:${PORT}/api/health`)).json();
      if (h.version) { up = true; version = h.version; break; }
    } catch { /* not yet */ }
    await sleep(250);
  }
  assert.ok(up, 'daemon never became healthy');
  console.log(`OK installed daemon v${version} healthy`);

  // 2. session via installed CLI (JSON stdout)
  const created = JSON.parse(run(['create', ws, '--name', 'installed-check']));
  const url = created.mcp_url;
  const sid = created.session_id ?? created.id;
  assert.ok(typeof url === 'string' && typeof sid === 'string', `create output missing url/session: ${JSON.stringify(created)}`);
  console.log('OK installed CLI created a session');

  // 3. MCP surface + proxy chain through the installed daemon
  const client = new Client({ name: 'installed-check', version: '0.0.1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  const tools = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(tools.includes('proxy'), `proxy tool missing from installed surface: ${tools}`);
  console.log(`OK tools/list carries proxy (${tools.length} tools)`);

  const call = async (args) => {
    const r = await client.callTool({ name: 'proxy', arguments: { sessionId: sid, ...args } });
    return JSON.parse(r.content[0].text);
  };
  const listed = await call({ command: 'list' });
  assert.equal(listed.status, 'ok');
  assert.ok(JSON.stringify(listed).includes('echo'), `agent-visible tool "echo" not listed: ${JSON.stringify(listed)}`);
  assert.ok(!JSON.stringify(listed).includes('gate'), `agent list leaked server identity "gate": ${JSON.stringify(listed)}`);
  const explained = await call({ command: 'explain', tool: 'echo' });
  assert.equal(explained.status, 'ok');
  const echoed = await call({ command: 'call', tool: 'echo', argsJson: JSON.stringify({ payload: 'installed-round-trip' }) });
  assert.equal(echoed.status, 'ok');
  assert.ok(JSON.stringify(echoed).includes('installed-round-trip'), 'echo payload missing');
  console.log('OK proxy list -> explain -> call round trip (stdio upstream spawned by the installed daemon)');

  // 3b. Proxy-first: upstream tools never become native host tools.
  const tools2 = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(!tools2.includes('gate_echo'), `upstream tool "gate_echo" leaked into host tools/list: ${tools2}`);
  console.log('OK proxy-first surface: upstream tools stay behind the proxy wrapper');

  // 4. session-scoped cleanup: stop daemon, no fake-upstream orphan
  const childPids = [...daemonLog.matchAll(/upstream "gate" started \(pid (\d+)/g)].map((m) => Number(m[1]));
  assert.ok(childPids.length > 0, `daemon log never reported the upstream pid:\n${daemonLog}`);
  daemon.kill();
  for (let i = 0; i < 20; i++) {
    try { process.kill(childPids[0], 0); await sleep(250); } catch { break; }
  }
  let orphan = false;
  try { process.kill(childPids[0], 0); orphan = true; } catch { /* gone */ }
  assert.ok(!orphan, `upstream child ${childPids[0]} survived the daemon`);
  console.log('OK daemon stop reaped the upstream child (no orphan)');
  console.log('INSTALLED CHECK PASS — 6 checks');
} catch (e) {
  console.error(`INSTALL-CHECK FAIL: ${e.message}`);
  console.error(`--- daemon log ---\n${daemonLog}`);
  process.exitCode = 1;
} finally {
  try { daemon.kill(); } catch { /* already */ }
  const wipe = (tries) => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { if (tries > 0) setTimeout(() => wipe(tries - 1), 500); } };
  wipe(10);
}
