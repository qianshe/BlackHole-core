// Source-level real HTTP/MCP authorized tool acceptance. This fixture uses a
// fresh ephemeral Ed25519 entitlement key and signs authentic challenge-bound
// tickets; it never bypasses the production gate or touches real OS secrets.
// The packed/signed daemon is checked separately by managed-idle-acceptance.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startDaemon } from '../dist/daemon.js';
import { EntitlementGate } from '../dist/cloud/entitlement-gate.js';
import { createIsolatedEnv } from './fixtures/isolated-env.mjs';

test('real HTTP MCP guide and read-only exec work with valid signed entitlement', { timeout: 55_000 }, async t => {
  const iso = await createIsolatedEnv({ name: 'signed-mcp-tool' });
  const origin = 'https://fixture-entitlement.blackhole.invalid';
  const keys = generateKeyPairSync('ed25519');
  const spki = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const gate = new EntitlementGate(spki, origin);
  const current = { userId: 'fixture-user', clientId: 'fixture-client', sessionId: 'fixture-subscription',
    loginOrder: 1, kind: 'login', expiresAt: Math.floor(Date.now() / 1000) + 600 };
  const oldEnv = { ...process.env };
  const env = { ...iso.env, BLACKHOLE_HOME: iso.dataDir, BLACKHOLE_TUNNEL: 'off',
    BLACKHOLE_ACCOUNT_OFFLINE: '1', BLACKHOLE_SEMANTIC: 'off' };
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env);
  let daemon, mcp;
  try {
    daemon = await startDaemon({ port: iso.port, dbPath: iso.dbPath, tunnel: 'off' }, () => {}, gate);
    // Core normally uses its own account prover; a fake local issuer is only
    // injected into this in-process fixture after the daemon is ready.
    gate.setProver(async (challenge, sessionId) => {
      assert.equal(sessionId, current.sessionId);
      const now = Math.floor(Date.now() / 1000);
      const payload = Buffer.from(JSON.stringify({ schema: 1, issuer: origin,
        audience: 'blackhole-daemon', challenge, userId: current.userId,
        clientId: current.clientId, sessionId, loginOrder: current.loginOrder,
        issuedAt: now, expiresAt: now + 120 })).toString('base64url');
      return { payload, signature: sign(null, Buffer.from(payload, 'base64url'), keys.privateKey).toString('base64url') };
    });
    gate.setIdentity(current);
    const base = 'http://127.0.0.1:' + iso.port;
    const created = await fetch(base + '/api/sessions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace_path: iso.home, permission_mode: 'workspace-write', name: 'fixture active tool' }),
    });
    assert.equal(created.status, 201);
    const session = await created.json();
    mcp = new Client({ name: 'blackhole-local-signed-entitlement-fixture', version: '1.0' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(session.mcp_url)));
    const list = await mcp.listTools();
    assert.ok(list.tools.some(tool => tool.name === 'guide'));
    assert.ok(list.tools.some(tool => tool.name === 'exec'));
    const manual = await mcp.callTool({ name: 'guide', arguments: { sessionId: session.session_id } });
    assert.notEqual(manual.isError, true);
    assert.match(JSON.stringify(manual), /BlackHole/);
    const execution = await mcp.callTool({
      name: 'exec', arguments: { sessionId: session.session_id,
        command: process.platform === 'win32' ? "Write-Output 'MCP_REAL_EXEC_OK'" : "printf 'MCP_REAL_EXEC_OK\\n'",
        timeout_ms: 20000 },
    });
    assert.notEqual(execution.isError, true, 'actual tool must succeed with valid signed entitlement');
    assert.match(JSON.stringify(execution), /MCP_REAL_EXEC_OK/);
    console.log(JSON.stringify({ ok: true, guide: true, exec: true, signedChallenge: true,
      toolAuthBypass: false, actualSdk: true, realCredentialsUsed: false, port: iso.port }));
  } finally {
    await mcp?.close().catch(() => {});
    await daemon?.stop().catch(() => {});
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, oldEnv);
    try { iso.cleanup(); } catch (error) {
      if (!['EBUSY','EPERM','ENOTEMPTY'].includes(error?.code)) throw error;
    }
  }
});
