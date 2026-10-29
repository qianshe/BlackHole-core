import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { initializeOpenAITunnelClient, verifyOpenAITunnelClient } from '../dist/tunnel/openai-tunnel-install.js';

const expectedPlatform = process.env.EXPECT_PLATFORM;
const expectedArch = process.env.EXPECT_ARCH;
if (expectedPlatform && process.platform !== expectedPlatform) {
  throw new Error(`native runner platform mismatch: expected ${expectedPlatform}, got ${process.platform}`);
}
if (expectedArch && process.arch !== expectedArch) {
  throw new Error(`native runner architecture mismatch: expected ${expectedArch}, got ${process.arch}`);
}

const parent = path.resolve('.cache', 'openai-tunnel-runtime-native');
await mkdir(parent, { recursive: true });
const root = await mkdtemp(path.join(parent, `${process.platform}-${process.arch}-`));

try {
  const installed = await initializeOpenAITunnelClient('', {
    platform: process.platform,
    arch: process.arch,
    pathValue: '',
    root,
    fetch: globalThis.fetch,
  });
  assert.equal(installed.installed, true, 'native verification must exercise a fresh managed install');
  assert.match(installed.version, /^v\d+\.\d+\.\d+$/);
  assert.equal(await verifyOpenAITunnelClient(installed.path), installed.version);
  console.log(JSON.stringify({
    ok: true,
    platform: process.platform,
    arch: process.arch,
    version: installed.version,
    executable: path.basename(installed.path),
  }));
} finally {
  await rm(root, { recursive: true, force: true });
}
