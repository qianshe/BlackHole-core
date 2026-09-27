import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startFixture, until } from './fixtures/process-harness.mjs';

// Exercise the actual MCP queue: changes must invalidate commands already
// accepted under an earlier session policy.
for (const action of ['mode', 'revoke']) test(`queued exec cannot run after session ${action}`, { timeout: 30000 }, async t => {
  const f = await startFixture(t), session = await f.session(), client = await f.connect(session);
  const tools = (await client.listTools()).tools;
  assert.ok(tools.some(tool => tool.name === 'exec'));
  assert.equal(tools.some(tool => ['pwsh', 'bash', 'cmd'].includes(tool.name)), false);
  const invoke = command => client.callTool({ name: 'exec', arguments: { sessionId: session.session_id, command, timeout_ms: 20000 } });
  const blocked = invoke(`node -e "const fs=require('fs');fs.writeFileSync('queue-ready',String(process.pid));const t=setInterval(()=>{if(fs.existsSync('release-queue'))clearInterval(t)},25);setTimeout(()=>process.exit(0),20000).unref()"`);
  await until(() => fs.existsSync(path.join(f.project, 'queue-ready')), Boolean);
  const queued = invoke(`node -e "require('fs').writeFileSync('must-not-run','violation')"`);
  await until(() => f.api(`/sessions/${session.id}/calls`), reply => reply.calls.filter(row => row.status === 'started').length === 2);
  if (action === 'mode') await f.api(`/sessions/${session.id}/mode`, { permission_mode: 'read-only' }, 'PATCH');
  else await f.api(`/sessions/${session.id}/revoke`, {});
  const childPid = Number(fs.readFileSync(path.join(f.project, 'queue-ready'), 'utf8'));
  if (process.platform === 'win32') {
    await until(() => { try { process.kill(childPid, 0); return true; } catch { return false; } }, alive => !alive, 5000);
  }
  fs.writeFileSync(path.join(f.project, 'release-queue'), 'release');
  const [, result] = await Promise.all([blocked, queued]);
  assert.equal(fs.existsSync(path.join(f.project, 'must-not-run')), false, 'queued command executed after its original authorization was invalidated');
  assert.equal(result.isError, true, JSON.stringify(result));
});
