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

function actions(health, reply, choose) {
  const clipboard = [], warnings = [], infos = [], statuses = [], errors = [], quickPicks = [];
  const vscode = {
    env: { clipboard: { writeText: async v => { clipboard.push(v); } } },
    workspace: { workspaceFolders: [] },
    window: {
      showWarningMessage: async s => { warnings.push(s); }, showErrorMessage: async s => { errors.push(s); },
      showInformationMessage: async (s, ...options) => { infos.push([s, options]); return reply; },
      showQuickPick: async (items) => { quickPicks.push(items); return choose ? choose(items) : items[0]; },
      setStatusBarMessage: s => { statuses.push(s); },
    },
  };
  const mod = load('sessionActions', n => n === 'vscode' ? vscode
    : n === './config' ? { getConfig: () => ({ connectorName: 'Team', openaiTunnelId: TID }) }
      : n === './templates' ? templates : require(n));
  const api = { health: async () => health, getSession: async () => ({ session_id: '000000000000000000000000000000000000123' }) };
  return { mod, api, node: { id: 's1', name: 'fix it', workspace_path: '/w' }, clipboard, warnings, infos, statuses, errors, quickPicks };
}

function multiDirectHealth(scope = 'private') {
  return {mcp_url:LOOP,connection_routes:{selected_route:'direct',needs_choice:true,reason:'direct_multiple',connector_ready:false,connector_kind:null,preferred_mcp_url:null,preferred_mcp_kind:null,preferred_mcp_scope:null,sandbox_mcp_url:null,sandbox_kind:null,openai:'off',mcp_candidates:[
    {id:'a',kind:'direct',scope,url:scope==='public'?'https://direct.example/mcp/token':'http://192.168.1.5:7307/mcp/token',label:'Direct A'},
    {id:'b',kind:'direct',scope:'private',url:'http://100.64.1.2:7307/mcp/token',label:'Direct B'},
  ]}};
}

test('direct address cancellation never copies or changes a route', async () => {
  const h=actions(multiDirectHealth(),undefined,()=>undefined);let reads=0;h.api.health=async()=>{reads++;return multiDirectHealth();};
  await h.mod.copyCurrentConnection(h.api);
  assert.equal(reads,1);assert.deepEqual(h.clipboard,[]);assert.deepEqual(h.warnings,[]);
});

test('direct address selection rejects a route changed while the picker was open', async () => {
  const initial=multiDirectHealth(),h=actions(initial);let reads=0;
  h.api.health=async()=>++reads===1?initial:{...initial,connection_routes:{...initial.connection_routes,selected_route:'cloudflare'}};
  await h.mod.copyCurrentConnection(h.api);
  assert.deepEqual(h.clipboard,[]);assert.match(h.warnings.join('\n'),/连接状态已变化/);
});

test('sandbox picker does not publish a private address as a cloud bootstrap', async () => {
  const h=actions(multiDirectHealth());
  await h.mod.copyTemplateSession(h.api,h.node,'sandbox');
  assert.equal(h.quickPicks.length,1);assert.deepEqual(h.clipboard,[]);assert.match(h.warnings.join('\n'),/私网/);
});

test('public sandbox selection re-reads the session credential after the address picker', async () => {
  const h=actions(multiDirectHealth('public'));let reads=0;
  h.api.getSession=async()=>({session_id:String(++reads).padStart(39,'0')});
  await h.mod.copyTemplateSession(h.api,h.node,'sandbox');
  assert.equal(reads,2);assert.equal(h.clipboard.length,1);
  assert.ok(h.clipboard[0].includes('https://direct.example/bh.md'));
  assert.ok(h.clipboard[0].includes(String(2).padStart(39,'0')));
  assert.deepEqual(h.warnings,[]);
});

test('OpenAI-only: connector prompt copies without a loopback warning and names the connector', async () => {
  const h = actions(oaOnly);
  await h.mod.copyTemplateSession(h.api, h.node, 'connector');
  assert.equal(h.clipboard.length, 1);
  assert.ok(h.clipboard[0].startsWith('@Team\n')); assert.ok(!h.clipboard[0].includes('127.0.0.1')); assert.doesNotMatch(h.clipboard[0], /Task:|fix it|paste your task/i);
  assert.deepEqual(h.warnings, []); assert.match(h.statuses[0], /OpenAI Tunnel.*@Team/);
});

test('sandbox prompt is never copied with a loopback bootstrap URL; a public URL still works beside OpenAI', async () => {
  for (const [health, re] of [[oaOnly, /OpenAI Tunnel.*不能直接用于沙箱提示词/], [{ ...oaOnly, openai_tunnel: null }, /沙箱提示词需要.*公网地址/]]) {
    const h = actions(health);
    await h.mod.copyTemplateSession(h.api, h.node, 'sandbox');
    assert.deepEqual(h.clipboard, []); assert.match(h.warnings.join('\n'), re);
  }
  const both = actions({ ...oaOnly, mcp_url: PUB, tunnel: 'online', tunnel_url: 'https://pub.example' });
  await both.mod.copyTemplateSession(both.api, both.node, 'sandbox');
  assert.match(both.clipboard[0], /^BlackHole MCP Manual: https:\/\/pub\.example\/bh\.md$/m);
  assert.match(both.clipboard[0], /^sessionId: 000000000000000000000000000000000000123$/m);
  assert.match(both.clipboard[0], /Read this Manual, familiarize yourself with the BlackHole MCP/);
  assert.match(both.clipboard[0], /Refer back to it whenever needed\./);
  assert.doesNotMatch(both.clipboard[0], /Task:|bh\.py|curl|python3|preflight|BLACKHOLE\.md/);
  assert.deepEqual(both.warnings, []);
});

test('no channel: connector prompt still copies and reports the selected connection is not ready', async () => {
  const h = actions({ ...oaOnly, openai_tunnel: { status: 'off', active_tunnel_id: null } });
  await h.mod.copyTemplateSession(h.api, h.node, 'connector');
  assert.equal(h.clipboard.length, 1); assert.match(h.warnings[0], /当前选择的连接方式尚未就绪/);
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

test('multi-interface direct choice never lists Cloudflare/custom candidates', async () => {
  const health = {
    mcp_url: LOOP,
    connection_routes: {
      preferred_mcp_url: null,
      preferred_mcp_kind: null,
      preferred_mcp_scope: null,
      selected_route: 'direct',
      needs_choice: true,
      reason: 'direct_multiple',
      sandbox_mcp_url: null,
      connector_ready: false,
      connector_kind: null,
      openai: 'off',
      mcp_candidates: [
        { id: 'direct:a', kind: 'direct', scope: 'private', url: 'http://192.168.1.2:7307/mcp/token', label: '192.168.1.2' },
        { id: 'direct:b', kind: 'direct', scope: 'private', url: 'http://100.64.0.2:7307/mcp/token', label: '100.64.0.2' },
        { id: 'cloudflare', kind: 'cloudflare', scope: 'public', url: 'https://quick.example/mcp/token', label: 'Cloudflare' },
      ],
    },
  };
  const h = actions(health);
  await h.mod.copySessionUrl(h.api, h.node);
  assert.equal(h.quickPicks.length, 1);
  assert.deepEqual(h.quickPicks[0].map((x) => x.url), [
    'http://192.168.1.2:7307/mcp/token',
    'http://100.64.0.2:7307/mcp/token',
  ]);
  assert.deepEqual(h.clipboard, ['http://192.168.1.2:7307/mcp/token']);
});
