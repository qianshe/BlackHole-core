import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const file = fileURLToPath(import.meta.url);

if (process.env.BH_MACOS_NESTED_SEATBELT_CHILD === '1') {
  const {
    inspectSandboxCapability,
    probeRunner,
    SandboxError,
  } = await import('../dist/workspace/posix-sandbox.js');

  const capability = inspectSandboxCapability('darwin');
  let failure = null;
  try {
    probeRunner('darwin');
  } catch (error) {
    failure = error instanceof SandboxError
      ? {
          name: error.name,
          code: error.code,
          backend: error.backend,
          commandStarted: error.commandStarted,
          message: error.message,
        }
      : {
          name: error instanceof Error ? error.name : 'UnknownError',
          code: null,
          backend: null,
          commandStarted: null,
          message: error instanceof Error ? error.message : String(error),
        };
  }
  process.stdout.write(JSON.stringify({ capability, failure }) + '\n');
} else {
  test('macOS nested Seatbelt is either usable or classified as a pre-command runner failure', {
    skip: process.platform !== 'darwin',
    timeout: 15_000,
  }, (t) => {
    const outerProfile = '(version 1) (allow default)';
    const child = spawnSync('/usr/bin/sandbox-exec', [
      '-p',
      outerProfile,
      process.execPath,
      file,
    ], {
      env: {
        ...process.env,
        BH_MACOS_NESTED_SEATBELT_CHILD: '1',
      },
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });

    assert.equal(child.error, undefined, child.error?.message);
    assert.equal(child.status, 0, `outer Seatbelt fixture failed (${child.status}): ${child.stderr}`);
    const line = child.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
    assert.ok(line, `nested fixture returned no JSON: ${child.stderr}`);
    const result = JSON.parse(line);
    t.diagnostic(JSON.stringify(result));

    if (result.capability.status === 'available') {
      assert.equal(result.capability.backend, 'seatbelt');
      assert.equal(result.capability.reason, null);
      assert.equal(result.failure, null);
      return;
    }

    assert.equal(result.capability.backend, 'seatbelt');
    assert.equal(result.capability.status, 'unavailable');
    assert.equal(result.capability.reason, 'sandbox_runner_nested');
    assert.match(result.capability.detail ?? '', /sandbox_apply:\s*Operation not permitted/i);
    assert.equal(result.failure?.name, 'SandboxError');
    assert.equal(result.failure?.code, 'sandbox_runner_nested');
    assert.equal(result.failure?.backend, 'seatbelt');
    assert.equal(result.failure?.commandStarted, false);
    assert.match(result.failure?.message ?? '', /refusing to run the command unconfined/i);
  });
}
