import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';

const LIVE = process.env.BH_CLOUDFLARED_LIVE === '1';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const source = fs.readFileSync(new URL('../../../src/tunnel/cloudflared-install.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const module = { exports: {} };
vm.runInNewContext(js, {
  module, exports: module.exports, require, Buffer, process, fetch, AbortSignal,
});
const { initializeCloudflared } = module.exports;

function runVersion(file) {
  return new Promise((resolve, reject) => {
    execFile(file, ['--version'], { encoding: 'utf8', timeout: 15_000, windowsHide: true, shell: false }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

test('production installer downloads, verifies, reuses and PATH-detects cloudflared', { skip: !LIVE, timeout: 180_000 }, async t => {
  const expectedPlatform = process.env.BH_EXPECTED_PLATFORM;
  const expectedArch = process.env.BH_EXPECTED_ARCH;
  if (expectedPlatform) assert.equal(process.platform, expectedPlatform, 'runner platform does not match the workflow matrix');
  if (expectedArch) assert.equal(process.arch, expectedArch, 'runner architecture does not match the workflow matrix');

  const root = fs.mkdtempSync(path.join(process.cwd(), '.cloudflared-live-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const managedRoot = path.join(root, 'managed');
  const first = await initializeCloudflared('', { pathValue: '', root: managedRoot });
  assert.equal(first.installed, true, 'a clean managed root must perform a real installation');
  assert.ok(path.isAbsolute(first.path));
  assert.ok(fs.statSync(first.path).isFile());
  assert.match(await runVersion(first.path), /^cloudflared version \d+\.\d+\.\d+/m);

  const second = await initializeCloudflared('', { pathValue: '', root: managedRoot });
  assert.equal(second.path, first.path, 'the second initialization must reuse the verified managed binary');
  assert.equal(second.installed, false);

  const detectionRoot = path.join(root, 'must-not-be-created');
  const detected = await initializeCloudflared('', {
    pathValue: path.dirname(first.path),
    root: detectionRoot,
  });
  assert.equal(detected.path, first.path, 'PATH detection must reuse the first usable cloudflared');
  assert.equal(detected.installed, false);
  assert.equal(fs.existsSync(detectionRoot), false, 'PATH detection must not download or create a managed installation');
});
