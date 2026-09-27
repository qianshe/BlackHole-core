import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function until(read, accept, timeout = 12000) {
  const deadline = Date.now() + timeout;
  for (;;) { const value = await read(); if (accept(value)) return value; if (Date.now() >= deadline) throw Error('Timed out: ' + JSON.stringify(value)); await delay(50); }
}
export async function startFixture(t, { env: extraEnv = {} } = {}) {
  fs.mkdirSync('.cache/tests', { recursive: true });
  const root = fs.realpathSync(fs.mkdtempSync('.cache/tests/process-http-'));
  const project = path.join(root, 'project'), temp = path.join(root, 'temp'), home = path.join(root, 'home');
  for (const dir of [project, temp, home, path.join(home, 'roaming'), path.join(home, 'local')]) fs.mkdirSync(dir, { recursive: true });
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const env = { ...process.env, ...extraEnv, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'roaming'), LOCALAPPDATA: path.join(home, 'local'), TEMP: temp, TMP: temp,
    BLACKHOLE_DB: path.join(root, 'fixture.db'), BLACKHOLE_TUNNEL: 'off', BLACKHOLE_SEMANTIC: 'off', BLACKHOLE_SEMANTIC_KEY: '',
    BLACKHOLE_SEMANTIC_KEY_FILE: path.join(home, 'missing-key'), BLACKHOLE_PROXY_CONFIG: path.join(root, 'missing-proxies.yaml'), BLACKHOLE_SKILLS_DIR: '',
    BH_PROCESS_TEST_ROOT: root, BH_PROCESS_TEST_PORT: String(port) };
  delete env.BLACKHOLE_PUBLIC_URL; delete env.NODE_OPTIONS;
  const child = fork(fileURLToPath(new URL('./process-daemon.mjs', import.meta.url)), [], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  let stderr = ''; child.stderr.on('data', data => { stderr = (stderr + data).slice(-32000); }); child.stdout.resume();
  const clients = [], exited = new Promise(resolve => child.once('exit', resolve));
  let closed = false;
  const close = async () => {
    if (closed) return; closed = true;
    for (const client of clients) await client.close().catch(() => {});
    if (child.connected) child.send('stop');
    let timeout;
    await Promise.race([exited, new Promise(resolve => { timeout = setTimeout(() => { child.kill(); resolve(); }, 8000); })]);
    if (timeout) clearTimeout(timeout); await exited;
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };
  t?.after(close);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Fixture startup: ' + stderr)), 15000);
    child.once('message', message => { clearTimeout(timer); message.ready ? resolve() : reject(Error('No ready receipt')); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(Error('Fixture exited: ' + code + ' ' + stderr)); });
  });
  const base = 'http://127.0.0.1:' + port;
  const api = async (route, body, method = body === undefined ? 'GET' : 'POST', headers = {}) => {
    const response = await fetch(base + '/api' + route, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await response.json(); if (!response.ok) throw Object.assign(Error(JSON.stringify(data)), { status: response.status, data }); return data;
  };
  const session = async (permission_mode = 'danger-full-access') => api('/sessions', { workspace_path: project, permission_mode, name: 'isolated process test' });
  const connect = async session => {
    if (new URL(session.mcp_url).origin !== base) throw Error('Fixture MCP escaped local origin');
    const client = new Client({ name: 'process-fixture', version: '1' }); clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(session.mcp_url))); return client;
  };
  const call = async (client, session, command, args = {}) => {
    const reply = await client.callTool({ name: 'process', arguments: { sessionId: session.session_id, command, ...args } });
    if (reply.structuredContent) return reply.structuredContent;
    try { return JSON.parse(reply.content[0].text); } catch { throw Error('MCP response: ' + reply.content[0].text); }
  };
  const quote = value => "'" + String(value).replaceAll("'", process.platform === 'win32' ? "''" : "'\\''") + "'";
  const fixtureScript = (...args) => (process.platform === 'win32' ? '& ' : '')
    + [process.execPath, fileURLToPath(new URL('./process-child.mjs', import.meta.url)), ...args].map(quote).join(' ');
  return { root, project, env, base, api, session, connect, call, fixtureScript, child, close };
}
