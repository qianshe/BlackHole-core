// Reproduce an administrator/service-style inherited token DACL without elevating,
// changing the host token, or touching machine ACLs. Only fixture tokens are altered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const windows = process.platform === 'win32' && process.arch === 'x64';
test('restricted child can create pipeline handles with an administrator-style inherited default DACL', { skip: !windows, timeout: 20000 }, async t => {
  const { default: koffi } = await import('koffi');
  const { win32, allocPtrSlot, decodePtr } = await import('../dist/win32/ffi.js');
  const { ProcessManager } = await import('../dist/process/manager.js');
  const { loadProcessBackend } = await import('../dist/process/backend.js');
  const api = win32(), advapi = koffi.load('advapi32.dll');
  const convert = advapi.func('__stdcall', 'ConvertStringSecurityDescriptorToSecurityDescriptorW', 'int', ['str16', 'uint32', 'void **', 'void *']);
  const getDacl = advapi.func('__stdcall', 'GetSecurityDescriptorDacl', 'int', ['void *', 'int *', 'void **', 'int *']);
  fs.mkdirSync('.cache/tests', { recursive: true });
  const root = fs.realpathSync(fs.mkdtempSync('.cache/tests/pipe-token-'));
  const manager = new ProcessManager({ daemonId: 'pipe-token', backend: await loadProcessBackend() });
  const original = api.createRestrictedToken;
  let injected = 0;
  api.createRestrictedToken = (...args) => {
    const result = original(...args);
    if (!result) return result;
    const descriptorSlot = allocPtrSlot(), daclSlot = allocPtrSlot();
    let descriptor;
    try {
      assert.ok(convert('D:(A;;GA;;;SY)(A;;GA;;;BA)', 1, descriptorSlot, null));
      descriptor = decodePtr(descriptorSlot);
      assert.ok(getDacl(descriptor, Buffer.alloc(4), daclSlot, Buffer.alloc(4)));
      const info = Buffer.alloc(8); info.writeBigUInt64LE(BigInt(decodePtr(daclSlot)));
      assert.ok(api.setTokenInformation(decodePtr(args[8]), 6, info, info.length), 'set only the newly created fixture token default DACL');
      injected++;
    } finally {
      if (descriptor) api.localFree(descriptor);
      koffi.free(descriptorSlot); koffi.free(daclSlot);
    }
    return result;
  };
  try {
    const owner = { sessionId: 'fixture', workspace: root, mode: 'workspace-write', writableDirs: [] };
    let row = await manager.start(owner, { requestId: 'pipeline', script: "cmd.exe /d /c ver | Out-String -Stream; Write-Output 'pipeline-completed'; exit 7" }, async () => {});
    api.createRestrictedToken = original;
    assert.equal(injected, 1);
    const deadline = Date.now() + 10000;
    while (!['exited', 'failed', 'unknown'].includes(row.state) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 30)); row = manager.status(owner.sessionId, row.processId);
    }
    t.diagnostic(JSON.stringify({ state: row.state, exitCode: row.exitCode, stdout: row.output.stdout, stderr: row.output.stderr }));
    assert.equal(row.state, 'exited');
    assert.equal(row.exitCode, 7, JSON.stringify(row));
    assert.match(row.output.stdout, /pipeline-completed/);
  } finally {
    api.createRestrictedToken = original;
    await manager.dispose();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
