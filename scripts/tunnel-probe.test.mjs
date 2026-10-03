import test from 'node:test';
import assert from 'node:assert/strict';
import { describeHttpFailure } from '../dist/tunnel/manager.js';

const CF_530 = '<!doctype html>\n<!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]-->\n<title>Cloudflare Tunnel error | trycloudflare.com | Cloudflare</title>\n<span class="cf-error-code">1033</span> Error 1033';

test('a Cloudflare 530 error page becomes one line without markup', () => {
  const d = describeHttpFailure(530, CF_530);
  assert.equal(d, 'Cloudflare 找不到隧道连接器（HTTP 530 / 1033）');
  assert.doesNotMatch(d, /</);
});

test('other HTML error pages show only the status; plain text keeps a short excerpt', () => {
  assert.equal(describeHttpFailure(503, '<html><body>down</body></html>'), 'HTTP 503');
  assert.equal(describeHttpFailure(502, '<html>bad gateway</html>'), 'Cloudflare 连不上本机服务（HTTP 502）');
  assert.equal(describeHttpFailure(404, ''), 'HTTP 404');
  assert.equal(describeHttpFailure(418, 'short\n  text'), 'HTTP 418（short text）');
});
