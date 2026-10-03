// OpenAI-only copy paths (plan section 6 / R6): connector prompts are URL-free, a sandbox
// prompt never carries a loopback bootstrap URL, and the MCP link row offers the Tunnel ID.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), ts = require('typescript');
const compile = name => ts.transpileModule(fs.readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
const load = (name, requireFn) => { const module = { exports: {} }; vm.runInNewContext(compile(name), { module, exports: module.exports, console, URL, URLSearchParams, require: requireFn }); return module.exports; };
const templates = load('templates', require);
const LOOP = 'http://127.0.0.1:7306/mcp/token', PUB = 'https://pub.example/mcp/token';
const TID = 'tunnel_0123456789abcdef0123456789abcdef';
const oaOnly = { mcp_url: LOOP, tunnel: 'off', tunnel_url: null, public_base_url: null, openai_tunnel: { status: 'ready', active_tunnel_id: TID } };

function actions(health, reply) {
  const clipboard = [], warnings = [], infos = [], statuses = [], errors = [];
  const vscode = {
    env: { clipboard: { writeText: async v => { clipboard.push(v); } } },
    workspace: { workspaceFolders: [] },
    window: {
      showWarningMessage: async s => { warnings.push(s); }, showErrorMessage: async s => { errors.push(s); },
      showInformationMessage: async (s, ...options) => { infos.push([s, options]); return reply; },
      setStatusBarMessage: s => { statuses.push(s); },
    },
  };
  const mod = load('sessionActions', n => n === 'vscode' ? vscode
    : n === './config' ? { getConfig: () => ({ connectorName: 'Team', openaiTunnelId: TID }) }
      : n === './templates' ? templates : require(n));
  const api = { health: async () => health, getSession: async () => ({ session_id: '000000000000000000000000000000000000123' }) };
  return { mod, api, node: { id: 's1', name: 'fix it', workspace_path: '/w' }, clipboard, warnings, infos, statuses, errors };
}

test('OpenAI-only: connector prompt copies without a loopback warning and names the connector', async () => {
  const h = actions(oaOnly);
  await h.mod.copyTemplateSession(h.api, h.node, 'connector');
  assert.equal(h.clipboard.length, 1);
  assert.ok(h.clipboard[0].startsWith('@Team\n')); assert.ok(!h.clipboard[0].includes('127.0.0.1')); assert.doesNotMatch(h.clipboard[0], /Task:|fix it|paste your task/i);
  assert.deepEqual(h.warnings, []); assert.match(h.statuses[0], /OpenAI 渠道.*@Team/);
});

test('sandbox prompt is never copied with a loopback bootstrap URL; a public URL still works beside OpenAI', async () => {
  for (const [health, re] of [[oaOnly, /OpenAI 渠道只支持连接器方式/], [{ ...oaOnly, openai_tunnel: null }, /启动 Cloudflare 渠道或配置自定义地址/]]) {
    const h = actions(health);
    await h.mod.copyTemplateSession(h.api, h.node, 'sandbox');
    assert.deepEqual(h.clipboard, []); assert.match(h.warnings.join('\n'), re);
  }
  const both = actions({ ...oaOnly, mcp_url: PUB, tunnel: 'online', tunnel_url: 'https://pub.example' });
  await both.mod.copyTemplateSession(both.api, both.node, 'sandbox');
  assert.match(both.clipboard[0], /BlackHole MCP: https:\/\/pub\.example\/mcp\/token/); assert.match(both.clipboard[0], /entry: "sandbox"/); assert.doesNotMatch(both.clipboard[0], /bh\.py|curl|python|Task:/); assert.deepEqual(both.warnings, []);
});

test('no channel: connector prompt still copies but asks to start Cloudflare or OpenAI', async () => {
  const h = actions({ ...oaOnly, openai_tunnel: { status: 'off', active_tunnel_id: null } });
  await h.mod.copyTemplateSession(h.api, h.node, 'connector');
  assert.equal(h.clipboard.length, 1); assert.match(h.warnings[0], /Cloudflare 或 OpenAI/);
});

test('MCP link copy under OpenAI-only offers the Tunnel ID instead of a loopback URL', async () => {
  const h = actions(oaOnly, '复制 Tunnel ID');
  await h.mod.copySessionUrl(h.api, h.node);
  assert.deepEqual(h.clipboard, [TID]); assert.match(h.infos[0][0], /Tunnel/); assert.deepEqual(h.infos[0][1], ['复制 Tunnel ID']);
  const dismissed = actions(oaOnly);
  await dismissed.mod.copySessionUrl(dismissed.api, dismissed.node);
  assert.deepEqual(dismissed.clipboard, []);
  const legacy = actions({ ...oaOnly, openai_tunnel: null });
  await legacy.mod.copySessionUrl(legacy.api, legacy.node);
  assert.deepEqual(legacy.clipboard, [LOOP]); assert.match(legacy.warnings[0], /本机回环/);
  const pub = actions({ ...oaOnly, mcp_url: PUB, tunnel: 'online', tunnel_url: 'https://pub.example' });
  await pub.mod.copySessionUrl(pub.api, pub.node);
  assert.deepEqual(pub.clipboard, [PUB]); assert.deepEqual(pub.warnings, []);
});
