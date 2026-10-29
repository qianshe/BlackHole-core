// Verify the exact staging-vs-signed-Core file-layout contract. Previous 0.4.2
// would return HTTP 503 for EVERY MCP tool call because it looked for Web
// assets under daemon/web even though the signed archive serves sibling web/.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../packages/vscode/package.json', import.meta.url));
const { buildSync } = require('esbuild');
const staging = path.join(root, 'packages/vscode/dist/daemon');
const marker = /<<BHI:([A-Za-z0-9+/= ]*):BHI>>/;
function fixture(t, managed) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-layout-seal-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }));
  const dir = path.join(temp, 'daemon');
  fs.cpSync(staging, dir, { recursive: true });
  const cli = fs.readFileSync(path.join(dir, 'cli.js'), 'latin1');
  const found = marker.exec(cli);
  assert.ok(found?.[1]?.trim(), 'test requires sealed daemon bundle');
  const manifest = JSON.parse(Buffer.from(found[1].trim(), 'base64').toString('utf8'));
  assert.ok(Object.keys(manifest).some(name => name.startsWith('web/')), 'Web assets must be covered by seal');
  buildSync({
    entryPoints: [path.join(root, 'src/integrity.ts')], outfile: path.join(dir, 'integrity-bundle.cjs'),
    platform: 'node', format: 'cjs', bundle: true, logLevel: 'silent',
    define: { __BLACKHOLE_INTEGRITY__: JSON.stringify(found[0]) },
  });
  const check = path.join(dir, 'check.cjs');
  fs.writeFileSync(check, "const {integrityFailures}=require('./integrity-bundle.cjs');process.stdout.write(JSON.stringify(integrityFailures()));\n", { flag: 'wx' });
  if (managed) {
    fs.renameSync(path.join(dir, 'web'), path.join(temp, 'web'));
    // A genuine installed Core gets this signed and hash-checked descriptor from
    // Manager; this isolated test only exercises integrity path resolution.
    fs.writeFileSync(path.join(temp, 'core-descriptor.json'), '{"test":"layout-marker"}\n', { flag: 'wx' });
  }
  const run = () => {
    const env = { ...process.env };
    delete env.BLACKHOLE_MANAGED_RUNTIME_IDENTITY;
    if (managed) env.BLACKHOLE_MANAGED_RUNTIME_IDENTITY = '{"fixture":"managed"}';
    return JSON.parse(execFileSync(process.execPath, [check], {
      cwd: temp, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }));
  };
  return { temp, dir, manifest, run };
}

test('staged daemon/web remains compatible with unchanged embedded integrity seal', t => {
  const f = fixture(t, false);
  assert.deepEqual(f.run(), []);
  fs.appendFileSync(path.join(f.dir, 'web/index.html'), '\n<!-- tampered -->');
  assert.deepEqual(f.run(), ['web/index.html']);
});

test('signed Core uses sibling web layout and validates the actually served assets', t => {
  const f = fixture(t, true);
  assert.deepEqual(f.run(), [], 'intact sibling Core web must not block guide/exec');
  fs.mkdirSync(path.join(f.dir, 'web'));
  fs.copyFileSync(path.join(f.temp, 'web/index.html'), path.join(f.dir, 'web/index.html'));
  fs.appendFileSync(path.join(f.temp, 'web/index.html'), '\n<!-- tampered served file -->');
  assert.deepEqual(f.run(), ['web/index.html'], 'a good shadow copy must never mask served Web corruption');
});

test('missing signed Core Web member or descriptor must fail closed', t => {
  const f = fixture(t, true);
  fs.rmSync(path.join(f.temp, 'web/index.html'));
  assert.ok(f.run().includes('web/index.html'));
  fs.rmSync(path.join(f.temp, 'core-descriptor.json'));
  assert.deepEqual(f.run(), ['core-descriptor.json']);
});
