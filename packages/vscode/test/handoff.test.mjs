import { test } from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { handoffModules } from './handoff-modules.mjs';

const { prepareHandoffPrompt } = handoffModules['./handoffCopy'];
const { renderPrompt } = handoffModules['./templates'];
const { handoffMarkup, handoffStyles, handoffScript } = handoffModules['./handoffView'];
const sid = '000000000000000000000000000000000000123';
function snapshot() {
  return {
    available: true,
    session: { id: 'session-a', session_id: sid, status: 'active', name: 'old task name' },
    handoff: { id: 'handoff-a', content: 'Goal: finish the feature\nVerified: tests passed\ntask：', created_at: 123456789 },
    mcp_url: 'https://example.invalid/bridge/mcp/token',
  };
}

test('both handoff copy modes reuse the existing template with fresh credentials and full task context', async () => {
  let current = snapshot(); const reads = [];
  const api = { handoff: async id => { reads.push(id); return current; } };
  for (const kind of ['connector', 'sandbox']) {
    const actual = await prepareHandoffPrompt(api, 'session-a', 'handoff-a', kind, 'Team BlackHole');
    assert.equal(actual, renderPrompt(kind, current.mcp_url, sid, { kind: 'handoff', text: current.handoff.content }, 'Team BlackHole'));
    assert.ok(actual.endsWith('Handoff context:\n' + current.handoff.content));
    assert.doesNotMatch(actual, /^Task:/m);
    assert.ok(!actual.includes('old task name'));
    if (kind === 'sandbox') {
      assert.match(actual, /^BlackHole MCP Manual: https:\/\/example\.invalid\/bridge\/bh\.md/m);
      assert.ok(actual.includes('sessionId: ' + sid));
      assert.match(actual, /Read this Manual, familiarize yourself with the BlackHole MCP/);
      assert.match(actual, /Refer back to it whenever needed\./);
      assert.doesNotMatch(actual, /^Task:|bh\.py|curl|python3|BLACKHOLE\.md/m);
    }
  }
  current = { ...current, session: { ...current.session, session_id: '000000000000000000000000000000000000456' }, mcp_url: 'https://new.example.invalid/path/mcp/new-token' };
  const rotated = await prepareHandoffPrompt(api, 'session-a', 'handoff-a', 'sandbox', 'BlackHole');
  assert.ok(rotated.includes(current.session.session_id)); assert.ok(!rotated.includes(sid));
  assert.ok(rotated.includes('https://new.example.invalid/path/bh.md')); assert.ok(rotated.includes('sessionId: ' + current.session.session_id)); assert.doesNotMatch(rotated, /bh\.py|bh\.md\?sessionid=/);
  assert.deepEqual(reads, ['session-a', 'session-a', 'session-a']);
  assert.equal(current.handoff.id, 'handoff-a', 'copy does not mutate or consume pending context');
});

test('copy refuses consumed, replaced, mismatched or inactive snapshots without a stale fallback', async () => {
  for (const mutate of [
    value => { value.handoff = null; }, value => { value.handoff.id = 'replacement'; },
    value => { value.session.id = 'session-b'; }, value => { value.available = false; },
    value => { value.session.status = 'paused'; }, value => { value.session.session_id = ''; },
    value => { value.handoff.content = '   '; }, value => { value.mcp_url = 'bad URL'; },
    value => { value.mcp_url = 'file:///workspace'; },
    value => { value.mcp_url = 'http://127.0.0.1/mcp/token'; },
  ]) {
    const value = snapshot(); mutate(value);
    await assert.rejects(prepareHandoffPrompt({ handoff: async () => value }, 'session-a', 'handoff-a', 'sandbox', 'BlackHole'));
  }
  await assert.rejects(prepareHandoffPrompt({ handoff: async () => { throw Error('offline'); } }, 'session-a', 'handoff-a', 'connector', 'BlackHole'), /offline/);
  await assert.rejects(prepareHandoffPrompt({ handoff: async () => snapshot() }, 'session-a', 'handoff-a', 'unknown', 'BlackHole'));
});

class Node {
  constructor(id='') { this.id=id; this.hidden=false; this.textContent=''; this.disabled=false; this.open=false; this.listeners=new Map(); this.opens=0; this.children=[]; this.dataset={}; this.isConnected=true; }
  addEventListener(event,handler) { const hs=this.listeners.get(event)||[]; hs.push(handler); this.listeners.set(event,hs); }
  emit(event) { for(const fn of this.listeners.get(event)||[])fn({target:this,stopPropagation(){},preventDefault(){}}); }
  click() { if(!this.disabled)this.emit('click'); }
  appendChild(n) { this.children.push(n); return n; }
  replaceChildren() { this.children=[]; }
  setAttribute(k,v) { this[k]=v; }
  focus() { this.focused=true; }
  showModal() { this.open=true; this.opens++; }
  close() { this.open=false; this.emit('close'); }
  set innerHTML(_) { throw Error('Never parse Agent content as HTML'); }
}
function view() {
 const nodes=new Map([...handoffMarkup.matchAll(/id="([^"]+)"/g)].map(([,id])=>[id,new Node(id)]));
 const sent=[], document={getElementById:id=>nodes.get(id),createElement:()=>new Node(),querySelector:()=>null};
 const mount=vm.runInNewContext(handoffScript+'\nmountHandoffView;');
 return{ui:mount(document,m=>sent.push(m)),sent,get:id=>nodes.get(id),bar:()=>nodes.get('handoffBanner').children[0]?.children};
}
const sessionData=(id='session-a',hid='handoff-a')=>({id,status:'active',pending_handoff:{id:hid,created_at:123456789}});
const data=(mode='calls',rows=[sessionData()])=>({mode,sessions:rows,selected:mode==='calls'?rows[0]:undefined,handoffSynchronized:true,handoffGeneration:0});
function loadPreview(f,content='<script>inert()</script>') {
 f.bar()[0].click(); const request=f.sent.at(-1);
 f.ui.preview({...request,ok:true,handoff:{id:request.handoffId,content,created_at:123456789}}); return request;
}
test('list uses one preview entry; detail and preview copies keep ID-only requests',()=>{
 for(const where of ['list','detail','preview'])for(const kind of ['connector','sandbox']) {
  const f=view();f.ui.render(data(where==='list'?'sessions':'calls'));
  let buttons=f.bar();
  if(where==='list'){const parent=new Node();f.ui.attach(parent,sessionData());buttons=parent.children[0].children;}
  if(where==='preview'||where==='list'){if(where==='list'){assert.equal(buttons.length,1);buttons[0].click();}else loadPreview(f); f.get(kind==='connector'?'handoffConnector':'handoffSandbox').click();}
  else buttons[kind==='connector'?1:2].click();
  const req=f.sent.at(-1);assert.equal(req.type,'copyHandoff');assert.equal(req.kind,kind);
  assert.equal(req.id,'session-a');assert.equal(req.handoffId,'handoff-a');assert.ok(req.requestId);
  assert.deepEqual(Object.keys(req).sort(),['handoffId','id','kind','requestId','type']);
  assert.equal(f.get('handoffDialog').opens,where==='detail'?0:1);
 }
});
test('preview is lazy, plain text, optional, and late replies cannot reopen it',()=>{
 const f=view();f.ui.render(data());assert.equal(f.sent.length,0);assert.equal(f.get('handoffBody').textContent,'');
 const req=loadPreview(f);assert.equal(f.get('handoffBody').textContent,'<script>inert()</script>');
 f.get('handoffClose').click();assert.equal(f.get('handoffBody').textContent,'');
 f.ui.preview({...req,ok:true,handoff:{id:'handoff-a',content:'late'}});
 assert.equal(f.get('handoffBody').textContent,'');assert.equal(f.get('handoffDialog').open,false);
});
test('copy is serialized, correlated, retryable, and persists feedback without consuming',()=>{
 const f=view();f.ui.render(data());f.bar()[1].click();const req=f.sent.at(-1);
 f.bar()[2].click();assert.equal(f.sent.length,1);assert.equal(f.bar()[2].disabled,true);
 f.ui.copied({...req,requestId:'foreign',ok:true});assert.equal(f.bar()[2].disabled,true);
 f.ui.copied({...req,ok:false,error:'clipboard unavailable'});assert.equal(f.bar()[1].disabled,false);
 assert.equal(f.get('handoffStatus').textContent,'clipboard unavailable');
 f.bar()[2].click();f.ui.copied({...f.sent.at(-1),ok:true});f.ui.render(data());
 assert.equal(f.get('handoffBanner').hidden,false);assert.match(f.bar()[0].title,/已复制/);
 assert.equal(f.bar()[0].textContent,'Handoff','copy feedback must not widen the compact row label');
 assert.equal(f.get('handoffDialog').opens,0);
});
test('replacement, consumption, navigation and disconnect clear preview; recovery does not reopen',()=>{
 for(const next of [data('calls',[sessionData('session-a','new')]),data('calls',[]),data('sessions'),{...data(),handoffSynchronized:false},{...data(),handoffGeneration:1}]) {
  const f=view();f.ui.render(data());const req=loadPreview(f);f.ui.render(next);
  assert.equal(f.get('handoffBody').textContent,'');assert.equal(f.get('handoffDialog').open,false);
  f.ui.preview({...req,ok:true,handoff:{id:'handoff-a',content:'late'}});assert.equal(f.get('handoffBody').textContent,'');
  f.ui.render(data());assert.equal(f.get('handoffDialog').open,false);
 }
});
test('paused sessions retain optional preview but disable copies; legacy capability stays distinct',()=>{
 const f=view();f.ui.render(data('calls',[{...sessionData(),status:'paused'}]));
 assert.equal(f.bar()[0].disabled,false);assert.equal(f.bar()[1].disabled,true);loadPreview(f);
 assert.equal(f.get('handoffConnector').disabled,true);
 f.ui.render({...data('calls',[{id:'session-a',status:'active'}]),handoffUnsupported:true});
 assert.equal(f.get('handoffBanner').hidden,true);assert.match(f.get('handoffStatus').textContent,/更新服务/);
 assert.match(handoffMarkup,/aria-live="polite"/);assert.match(handoffMarkup,/<dialog/);
});

test('handoff copy labels context, preserves its final task and leaves ordinary prompts unchanged', async () => {
  for (const kind of ['connector', 'sandbox']) for (const task of ['', '只读取 fixture.txt，不修改']) {
    const value = snapshot();
    value.handoff.content = '当前状态：合成测试，非真实任务。\n命令示例：echo "Task: literal"\ntask：' + task;
    const result = await prepareHandoffPrompt({handoff:async()=>value}, 'session-a', 'handoff-a', kind, 'BlackHole');
    assert.ok(result.endsWith('Handoff context:\n' + value.handoff.content));
    assert.equal((result.match(/^task：/gm)||[]).length, 1);
    assert.doesNotMatch(result, /^Task:/m);
    assert.ok(renderPrompt(kind, value.mcp_url, sid, { kind: 'user', text: '普通任务' }).endsWith('\n\n普通任务'));
    assert.doesNotMatch(renderPrompt(kind, value.mcp_url, sid, { kind: 'user', text: '普通任务' }), /^Task:/m);
  }
});

test('handoff has one list entry while urgent and paused statuses remain visible', () => {
  const source = fs.readFileSync(new URL('../src/sidebar.ts', import.meta.url), 'utf8');
  const method = source.match(/function rowStatus\(s, d\) \{[\s\S]*?\r?\n    \}/)?.[0];
  assert.ok(method);
  const rowStatus = vm.runInNewContext('(' + method + ')');
  const session = { ...sessionData(), activity: 'idle', todos_total: 0 };
  assert.equal(rowStatus(session, {}), '');
  assert.match(rowStatus({ ...session, status: 'paused' }, {}), /已暂停/);
  assert.match(rowStatus(session, { pending: [{ session_id: session.id }] }), /待审批/);
  assert.match(rowStatus({ ...session, activity: 'running' }, {}), /运行中/);
  assert.ok(source.includes(String.raw`handoffView.attach(row.querySelector('.name'), s);`), 'a session row gets one compact Handoff entry');
  assert.ok(source.includes(String.raw`tag.className = 'cur'; tag.textContent = '当前';`), 'the Current workspace marker is rendered for matching rows');
  assert.ok(!handoffStyles.includes(String.raw`.row:has(.handoffBar) .cur { display:none; }`), 'Handoff must not hide the Current marker');
});

test('list Handoff actions use a right anchor and a shared status column', () => {
  assert.match(handoffStyles, /\.row \.handoffBar\s*\{[^}]*margin-left:auto/);
  assert.match(handoffStyles, /#list\[data-mode="sessions"\]\s*\{[^}]*grid-template-columns:28px minmax\(0,1fr\) max-content 32px/);
  assert.match(handoffStyles, /#list\[data-mode="sessions"\] > \.row\s*\{[^}]*grid-column:1\/-1;[^}]*grid-template-columns:subgrid/);
  assert.match(handoffStyles, /#list\[data-mode="sessions"\] > \.empty\s*\{[^}]*grid-column:1\/-1/);
  assert.match(handoffStyles, /grid-template-columns:16px minmax\(0,1fr\) max-content 24px/);
  assert.match(handoffStyles, /#list\[data-mode="sessions"\] \.row \.st\s*\{[^}]*text-align:right/);
  assert.doesNotMatch(handoffStyles, /\.st\s*\{[^}]*width:\s*7em/);
});

test('OpenAI-only handoff: URL-free connector prompt is allowed, sandbox is refused with guidance', async () => {
  const local = over => ({ ...snapshot(), mcp_url: 'http://127.0.0.1:7306/mcp/token', ...over });
  const ready = local({ openai_tunnel: { status: 'ready' } });
  const text = await prepareHandoffPrompt({ handoff: async () => ready }, 'session-a', 'handoff-a', 'connector', 'BlackHole');
  assert.ok(text.startsWith('@BlackHole\n')); assert.ok(!text.includes('127.0.0.1'));
  await assert.rejects(prepareHandoffPrompt({ handoff: async () => ready }, 'session-a', 'handoff-a', 'sandbox', 'BlackHole'), /沙箱提示词需要/);
  // Connector handoff is URL-free: copying context is not blocked by route startup/offline state.
  for (const oa of [{ status: 'starting' }, undefined, null, { status: 'off' }, { status: 'error' }, { status: 'stopping' }]) {
    const copied = await prepareHandoffPrompt({ handoff: async () => local({ openai_tunnel: oa }) }, 'session-a', 'handoff-a', 'connector', 'BlackHole');
    assert.ok(copied.startsWith('@BlackHole\n'));
  }
  const both = { ...snapshot(), openai_tunnel: { status: 'ready' } };
  const sandbox = await prepareHandoffPrompt({ handoff: async () => both }, 'session-a', 'handoff-a', 'sandbox', 'BlackHole');
  assert.ok(sandbox.includes('https://example.invalid/bridge/bh.md')); assert.ok(sandbox.includes('sessionId: ' + sid)); assert.doesNotMatch(sandbox, /bh\.md\?sessionid=/);
});

test('connectionTarget is the one pure decision for create, copy and handoff', () => {
  const { connectionTarget } = handoffModules['./templates'];
  const t = h => { const x = connectionTarget(h); return { publicUrl: x.publicUrl, openai: x.openai, connector: x.connector, sandbox: x.sandbox }; };
  const none = { publicUrl: null, openai: 'off', connector: false, sandbox: false };
  assert.deepEqual(t(null), none);
  assert.deepEqual(t({ tunnel: 'online', tunnel_url: 'https://q.example' }), { publicUrl: 'https://q.example', openai: 'off', connector: true, sandbox: true });
  assert.deepEqual(t({ tunnel: 'starting', tunnel_url: 'https://q.example' }), none);
  assert.deepEqual(t({ tunnel: 'off', public_base_url: 'https://fixed.example' }), { publicUrl: 'https://fixed.example', openai: 'off', connector: true, sandbox: true });
  assert.deepEqual(t({ tunnel: 'off', openai_tunnel: { status: 'ready' } }), { publicUrl: null, openai: 'ready', connector: true, sandbox: false });
  assert.deepEqual(t({ openai_tunnel: { status: 'recovering' } }), { publicUrl: null, openai: 'ready', connector: true, sandbox: false });
  assert.deepEqual(t({ openai_tunnel: { status: 'starting' } }), { ...none, openai: 'starting' });
  for (const status of ['off', 'stopping', 'error', 'unavailable']) assert.deepEqual(t({ openai_tunnel: { status } }), none);
});
