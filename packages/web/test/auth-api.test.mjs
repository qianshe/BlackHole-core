import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
function load(fetch) {
  const deadlines = [];
  const js = ts.transpileModule(fs.readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(js, { module, exports: module.exports, fetch,
    AbortSignal: { timeout(ms) { deadlines.push(ms); return AbortSignal.timeout(10); } },
    require: name => name === './settings/host' ? { settingsHost: () => ({ kind: 'desktop' }) } : require(name),
  });
  return { api: module.exports.api, deadlines };
}

test('all welcome HTTP requests have a deadline including local login and session recovery', async () => {
  const routes = [];
  const h = load(async (path, init) => {
    routes.push(path);
    assert.ok(init.signal, 'pending HTTP must eventually release the welcome poll');
    assert.equal(init.credentials, 'same-origin');
    return Response.json(path.endsWith('/status') ? { state: 'verified' }
      : path.endsWith('/session') ? { authenticated: true, account_required: false, version: '0.4.9' } : { ok: true });
  });
  await h.api.authStatus(); await h.api.localLogin(); await h.api.session();
  assert.deepEqual(h.deadlines, [5000, 5000, 5000]);
  assert.deepEqual(routes, ['/web-api/v1/auth/status', '/web-api/v1/auth/local', '/web-api/v1/auth/session']);
});

test('a timed-out 200 response body cannot become a successful empty authentication reply', async () => {
  const h = load(async (_path, init) => ({ ok: true, status: 200,
    json: () => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    }),
  }));
  // AbortSignal.timeout uses an unreferenced timer; keep this isolated test alive.
  const keepalive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(h.api.authStatus(), error => error.name === 'TimeoutError');
    await assert.rejects(h.api.session(), error => error.name === 'TimeoutError');
  } finally { clearTimeout(keepalive); }
});

test('malformed authentication replies cannot grant workspace entry', async () => {
  for (const value of [{}, { authenticated: false, version: 'x' }, { authenticated: true, version: '' }]) {
    const h = load(async () => Response.json(value));
    await assert.rejects(h.api.session(), error => error.code === 'invalid_auth_response');
    await assert.rejects(h.api.authStatus(), error => error.code === 'invalid_auth_response');
  }
});
