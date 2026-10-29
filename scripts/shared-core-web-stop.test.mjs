// Focused unit regression for the actual Local Web stop handler. This does not
// claim HTTP/authentication or GUI acceptance. Timers and shutdown are inert.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import test from 'node:test';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const source = fs.readFileSync(new URL('../src/web/local-web.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('local-web.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const handlers = [];
function visit(node) {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'post' && node.arguments.length >= 2
      && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === '/daemon/stop') {
    handlers.push(node.arguments[1].getText(ast));
  }
  ts.forEachChild(node, visit);
}
visit(ast);
assert.equal(handlers.length, 1, 'test must target exactly one actual Web stop handler');
const javascript = ts.transpileModule('module.exports = (' + handlers[0] + ');', {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
function invoke(managed, confirmed) {
  const effects = { events: 0, timers: 0, shutdowns: 0 }, reply = { status: 200, body: undefined };
  const module = { exports: {} };
  const deps = { ...(managed ? { runtimeIdentity: { lifecycleState: 'managed' } } : {}),
    events: { append() { effects.events++; } }, shutdown: async () => { effects.shutdowns++; } };
  vm.runInNewContext(javascript, { module, deps,
    setTimeout() { effects.timers++; return { unref() {} }; },
    process: { exit() { throw new Error('unit test must never exit a process'); } },
  }, { timeout: 1000 });
  const response = { status(code) { reply.status = code; return this; }, json(body) { reply.body = JSON.parse(JSON.stringify(body)); return this; } };
  module.exports({ body: { confirm: confirmed } }, response);
  return { reply, effects };
}
test('managed Local Web Stop cannot bypass Manager leases and admission protection', () => {
  const { reply, effects } = invoke(true, true);
  assert.equal(reply.status, 409);
  assert.deepEqual(reply.body, { error: 'managed_stop_requires_manager' });
  assert.deepEqual(effects, { events: 0, timers: 0, shutdowns: 0 });
});
test('legacy Local Web Stop still requires explicit confirmation without scheduling a stop', () => {
  const { reply, effects } = invoke(false, false);
  assert.equal(reply.status, 400);
  assert.deepEqual(effects, { events: 0, timers: 0, shutdowns: 0 });
});
test('confirmed legacy Stop retains its existing response and deferred shutdown scheduling', () => {
  const { reply, effects } = invoke(false, true);
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.body, { ok: true });
  assert.deepEqual(effects, { events: 1, timers: 1, shutdowns: 0 });
});
