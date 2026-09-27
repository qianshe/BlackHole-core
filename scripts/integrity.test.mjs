// Install integrity seal (plan 6.14 O4): the packaging build's seal must verify
// with the runtime checker (src/integrity.ts), and any edit must be detected.
// Requires a packaged build: `node esbuild.mjs --environment test` in packages/vscode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as esbuild from '../packages/vscode/node_modules/esbuild/lib/main.js';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'packages/vscode/dist/daemon');

function copyTree(src, dest) {
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const from = path.join(src, e.name), to = path.join(dest, e.name);
    if (e.isDirectory()) copyTree(from, to);
    else { fs.mkdirSync(dest, { recursive: true }); fs.copyFileSync(from, to); }
  }
}

test('sealed daemon passes its self-check and detects edits', async () => {
  const cli = fs.readFileSync(path.join(dist, 'cli.js'), 'latin1');
  const m = /<<BHI:([A-Za-z0-9+/= ]*):BHI>>/.exec(cli);
  assert.ok(m && m[1].trim(), 'cli.js carries a sealed manifest');
  const manifest = JSON.parse(Buffer.from(m[1].trim(), 'base64').toString('utf8'));
  assert.ok(manifest['cli.js'] && manifest['process-supervisor.cjs'] && manifest['web/index.html']);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-integrity-'));
  try {
    copyTree(dist, dir);
    await esbuild.build({
      stdin: { contents: "import { integrityFailures } from './src/integrity.ts'; process.stdout.write(JSON.stringify(integrityFailures()));", resolveDir: root, loader: 'ts' },
      bundle: true, platform: 'node', format: 'cjs', outfile: path.join(dir, 'check.cjs'), logLevel: 'silent',
      define: { __BLACKHOLE_INTEGRITY__: JSON.stringify(m[0]) },
    });
    const run = () => JSON.parse(execFileSync(process.execPath, [path.join(dir, 'check.cjs')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    assert.deepEqual(run(), [], 'intact install');

    fs.appendFileSync(path.join(dir, 'web/index.html'), '<!-- x -->');
    assert.deepEqual(run(), ['web/index.html']);

    const c = path.join(dir, 'cli.js');
    fs.writeFileSync(c, fs.readFileSync(c, 'latin1').replace('entitlement_verification_required', 'entitlement_verification_requirex'), 'latin1');
    assert.deepEqual(run().sort(), ['cli.js', 'web/index.html']);

    fs.rmSync(path.join(dir, 'process-supervisor.cjs'));
    assert.ok(run().includes('process-supervisor.cjs'), 'missing file');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// End to end on the packaged daemon: the seal must not block an intact install,
// and a modified install must refuse tool calls before anything else runs.
test('packaged daemon refuses tool calls only when its files were modified', async () => {
  const { spawn } = await import('node:child_process');
  const net = await import('node:net');
  const src = path.join(root, 'packages/vscode/dist');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-integrity-e2e-'));
  const copyAll = (a, b) => { for (const e of fs.readdirSync(a, { withFileTypes: true })) { const f = path.join(a, e.name), t = path.join(b, e.name); if (e.isDirectory()) copyAll(f, t); else { fs.mkdirSync(b, { recursive: true }); fs.copyFileSync(f, t); } } };
  copyAll(src, path.join(dir, 'dist'));
  const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => ['PATH', 'SYSTEMROOT', 'COMSPEC'].includes(k.toUpperCase())));
  Object.assign(env, { HOME: dir, USERPROFILE: dir, APPDATA: dir, LOCALAPPDATA: dir, TEMP: dir, TMP: dir, BLACKHOLE_PROXY_CONFIG: path.join(dir, 'proxies.yaml'), BLACKHOLE_SEMANTIC: 'off', BLACKHOLE_TUNNEL: 'off', BLACKHOLE_SKILLS_DIR: '' });
  async function toolCallStatus() {
    const port = await freePort();
    const child = spawn(process.execPath, [path.join(dir, 'dist/daemon/cli.js'), 'serve', '--port', String(port), '--db', path.join(dir, 'fixture.db'), '--tunnel', 'off'], { env, stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
    try {
      let health;
      for (const t0 = Date.now(); Date.now() - t0 < 15000;) {
        try { health = await (await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) })).json(); break; } catch { await new Promise((r) => setTimeout(r, 150)); }
      }
      assert.ok(health?.mcp_url, 'daemon started');
      const res = await fetch(health.mcp_url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'guide', arguments: {} } }) });
      return { status: res.status, text: await res.text() };
    } finally {
      child.kill();
      await new Promise((r) => child.once('exit', r));
    }
  }
  try {
    const intact = await toolCallStatus();
    assert.ok(!intact.text.includes('install_corrupted'), `intact install passes the self-check (got ${intact.status})`);
    fs.appendFileSync(path.join(dir, 'dist/daemon/web/index.html'), '<!-- x -->');
    const bad = await toolCallStatus();
    assert.equal(bad.status, 503);
    assert.match(bad.text, /install_corrupted/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
