import {test} from 'node:test';
import { handoffModules } from './handoff-modules.mjs';
import { toolNames } from '../../../scripts/fixtures/tool-names.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),ts=require('typescript');
const pause=()=>new Promise(r=>setImmediate(r));
function setup(){
 const events=new Set(),ticks=new Set(),subscribe=fn=>{events.add(fn);return{dispose:()=>events.delete(fn)}};
 const subscribeTick=fn=>{const sub=subscribe(fn);ticks.add(fn);return{dispose(){ticks.delete(fn);sub.dispose()}}};
 const clipboard=[];
 const vscode={commands:{},env:{clipboard:{writeText:async value=>{clipboard.push(value)}}},workspace:{workspaceFolders:[]},window:{showErrorMessage(){}}};
 const source=fs.readFileSync(new URL('../src/sidebar.ts',import.meta.url),'utf8');
 const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const module={exports:{}};
 vm.runInNewContext(js,{module,exports:module.exports,console,require:n=>n in handoffModules?handoffModules[n]:n==='./config'?{getConfig:()=>({})}:n==='./toolNames'?toolNames:n==='vscode'?vscode:n==='./icons'?{sidebarIcons:()=>'{}'}:n==='./callFormat'?{}:n==='./editorNavigation'?{editorNavigationPreview:()=>undefined,resolveEditorNavigation:()=>({state:'file_only'})}:require(n)});
 const api={changes:async()=>({epoch:1}),listSessions:async()=>({sessions:[]}),health:async()=>({tunnel:'offline'}),confirmations:async()=>({confirmations:[]})};
 const provider=new module.exports.SidebarProvider(api,{currentState:'running',onDidChangeState:subscribe},{onTick:subscribeTick},{});
 const panel=()=>{
  let closed=false,disposer;const messages=[];
  const webview={html:'',options:{},postMessage:async m=>{if(closed)throw Error('Webview is disposed');messages.push(m);return true},onDidReceiveMessage:()=>({dispose(){}})};
  return{messages,get webview(){if(closed)throw Error('Webview is disposed');return webview},onDidDispose(fn){disposer=fn;return{dispose(){}}},close(){closed=true;disposer?.()}};
 };
 return{provider,api,events,panel,clipboard,vscode,tick:async()=>{for(const fn of ticks)fn();await pause()}};
}
test('Task Contract Goal reaches the call-list view, updates without item changes and clears on navigation',async()=>{
 const h=setup();let contract={goal:'Expected outcome',nonGoals:[],successCriteria:[],verification:[]},items=[{content:'step',status:'completed'}];
 h.api.listSessions=async()=>({sessions:[session('idle')]});
 h.api.callsPage=async()=>({calls:[],total:0,window_total:0,max_seq:0});
 h.api.todos=async()=>({items,contract,updated_at:1});
 h.provider.mode='calls';h.provider.selectedId='fixture';const p=await mount(h);
 assert.equal(p.messages.at(-1).goal,contract.goal);
 const scripts=[...p.webview.html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];assert.ok(scripts.length);for(const [,script]of scripts)new vm.Script(script);
 contract={...contract,goal:'Updated outcome'};await h.provider.refresh(true);assert.equal(p.messages.at(-1).goal,contract.goal);
 contract=undefined;await h.provider.refresh(true);assert.equal(p.messages.at(-1).goal,undefined);assert.equal(p.messages.at(-1).todos.length,1);
 contract={goal:'Next task',nonGoals:[],successCriteria:[],verification:[]};await h.provider.refresh(true);h.provider.mode='sessions';await h.provider.refresh(true);assert.equal(p.messages.at(-1).goal,undefined);assert.equal(p.messages.at(-1).todos.length,0);
 h.provider.showCalls({...session('idle'),id:'other'});assert.equal(h.provider.todoGoal,undefined);h.provider.dispose();
});

test('disposing the sidebar view clears its handle before a delayed refresh completes',async()=>{
 const h=setup(),p=h.panel(),refresh=h.provider.refresh.bind(h.provider);
 h.provider.refresh=async()=>{};h.provider.resolveWebviewView(p);h.provider.refresh=refresh;
 let resolve;h.api.listSessions=()=>new Promise(r=>{resolve=r});
 const task=h.provider.refresh(true);await pause();p.close();
 assert.equal(h.provider.resolved,false);
 resolve({sessions:[]});await assert.doesNotReject(task);h.provider.dispose();
});
test('inline approval availability follows actual visibility, not retained view existence',async()=>{
 const h=setup();assert.equal(h.provider.visible,false);
 const p=h.panel();p.visible=true;h.provider.resolveWebviewView(p);await pause();
 assert.equal(h.provider.visible,true);p.visible=false;
 assert.equal(h.provider.resolved,true);assert.equal(h.provider.visible,false);
 p.visible=true;assert.equal(h.provider.visible,true);p.close();assert.equal(h.provider.visible,false);h.provider.dispose();
});
test('provider disposal unregisters polling and daemon listeners',()=>{
 const h=setup();assert.equal(h.events.size,2);h.provider.dispose();assert.equal(h.events.size,0);
});
async function mount(h) {
 const p=h.panel();h.provider.resolveWebviewView(p);await pause();
 // The first forced render intentionally does not acknowledge an epoch.
 await h.tick();return p;
}
const session=activity=>({id:'fixture',status:'active',workspace_path:'D:/fixture',activity});
test('poll ticks update activity in both directions and skip unchanged snapshots',async()=>{
 const h=setup();let epoch=1,activity='idle',reads=0;
 h.api.changes=async()=>({epoch});h.api.listSessions=async()=>{reads++;return{sessions:[session(activity)]}};
 const p=await mount(h);assert.equal(p.messages.at(-1).sessions[0].activity,'idle');
 const before=reads;await h.tick();assert.equal(reads,before);
 activity='running';epoch++;await h.tick();assert.equal(p.messages.at(-1).sessions[0].activity,'running');
 activity='idle';epoch++;await h.tick();assert.equal(p.messages.at(-1).sessions[0].activity,'idle');
 assert.equal(reads,before+2);h.provider.dispose();
});
test('a failed session read retries the same epoch on the next poll tick',async()=>{
 const h=setup();let epoch=1,activity='running',fail=false,reads=0;
 h.api.changes=async()=>({epoch});h.api.listSessions=async()=>{reads++;if(fail){fail=false;throw Error('temporary failure')}return{sessions:[session(activity)]}};
 const p=await mount(h);activity='idle';epoch++;fail=true;await h.tick();
 assert.equal(p.messages.at(-1).sessions[0].activity,'running');const before=reads;
 await h.tick();assert.equal(reads,before+1);assert.equal(p.messages.at(-1).sessions[0].activity,'idle');
 await h.tick();assert.equal(reads,before+1);h.provider.dispose();
});
for(const endpoint of ['health','confirmations','callsPage','todos']) {
 test(`a failed ${endpoint} read does not consume the refresh epoch`,async()=>{
  const h=setup();let epoch=1;
  h.api.changes=async()=>({epoch});h.api.listSessions=async()=>({sessions:[session('idle')]});
  h.api.callsPage=async()=>({calls:[],total:0,window_total:0,max_seq:0});
  h.api.todos=async()=>({items:[],updated_at:0});
  if(endpoint==='callsPage'||endpoint==='todos'){h.provider.mode='calls';h.provider.selectedId='fixture'}
  const p=await mount(h);const original=h.api[endpoint];let reads=0;
  h.api[endpoint]=async()=>{if(++reads===1)throw Error('temporary failure');return original()};
  epoch++;await h.tick();assert.equal(reads,1);
  if(endpoint==='todos')assert.equal(p.messages.at(-1).todosUnavailable,true,'failed todo snapshot is explicitly marked unavailable');
  await h.tick();assert.equal(reads,2);
  if(endpoint==='todos')assert.equal(p.messages.at(-1).todosUnavailable,false,'successful retry clears the unavailable marker');
  await h.tick();assert.equal(reads,2);h.provider.dispose();
 });
}
test('manual refresh bypasses an acknowledged epoch and failed force refresh retries',async()=>{
 const h=setup();let activity='running',fail=false;
 h.api.listSessions=async()=>{if(fail){fail=false;throw Error('temporary failure')}return{sessions:[session(activity)]}};
 const p=await mount(h);activity='idle';await h.provider.refresh(true);
 assert.equal(p.messages.at(-1).sessions[0].activity,'idle');await h.tick();
 activity='running';fail=true;await h.provider.refresh(true);
 assert.equal(p.messages.at(-1).sessions[0].activity,'idle');await h.tick();
 assert.equal(p.messages.at(-1).sessions[0].activity,'running');h.provider.dispose();
});
test('unavailable changes endpoint falls back to a full refresh and recovers',async()=>{
 const h=setup();let activity='running',offline=false,reads=0;
 h.api.changes=async()=>{if(offline)throw Error('temporary failure');return{epoch:1}};
 h.api.listSessions=async()=>{reads++;return{sessions:[session(activity)]}};
 const p=await mount(h);offline=true;activity='idle';await h.tick();
 assert.equal(p.messages.at(-1).sessions[0].activity,'idle');
 offline=false;activity='running';const before=reads;await h.tick();
 assert.equal(reads,before+1);assert.equal(p.messages.at(-1).sessions[0].activity,'running');
 await h.tick();assert.equal(reads,before+1);h.provider.dispose();
});


const pendingHandoff=(id='handoff-a')=>({id,content:'Verified continuation context\ntask：',created_at:123456789});
const request=(kind='connector',requestId='r1')=>({type:'copyHandoff',id:'fixture',handoffId:'handoff-a',requestId,kind});
async function handoffFixture(t) {
 const h=setup(); h.snapshot={session:{...session('idle'),session_id:'000000000000000000000000000000000000999'},available:true,handoff:pendingHandoff(),mcp_url:'https://new.example.invalid/bridge/mcp/token'};
 h.api.listSessions=async()=>({sessions:[{...session('idle'),pending_handoff:h.snapshot.handoff?{id:h.snapshot.handoff.id,created_at:h.snapshot.handoff.created_at}:null},{...session('idle'),id:'other',pending_handoff:null}]});
 h.api.callsPage=async()=>({calls:[],total:0,window_total:0,max_seq:0});
 h.api.todos=async()=>({items:[{content:'Existing Todo',status:'in_progress'}],updated_at:1});
 h.api.handoff=async()=>h.snapshot; h.provider.mode='calls';h.provider.selectedId='fixture';
 h.panelView=await mount(h);t.after(()=>h.provider.dispose());return h;
}
test('handoff summary coexists with Todo, polling sends no body, both copies fetch fresh snapshot',async t=>{
 const h=await handoffFixture(t);let reads=0;h.api.handoff=async()=>{reads++;return h.snapshot};
 await h.provider.refresh(true);assert.equal(reads,0);
 assert.equal(h.panelView.messages.at(-1).selected.pending_handoff.id,'handoff-a');
 assert.equal(h.panelView.messages.at(-1).todos[0].content,'Existing Todo');
 for(const kind of ['connector','sandbox'])await h.provider.onMessage(request(kind,kind));
 assert.equal(reads,2);assert.equal(h.clipboard.length,2);assert.ok(h.snapshot.handoff);
 assert.ok(h.clipboard[1].includes(h.snapshot.session.session_id));
 assert.ok(!JSON.stringify(h.panelView.messages).includes(h.snapshot.handoff.content));
});
test('list copies both kinds without preview or selected session',async t=>{
 const h=await handoffFixture(t);await h.provider.onMessage({type:'back'});await pause();
 for(const kind of ['connector','sandbox'])await h.provider.onMessage(request(kind,kind));
 assert.equal(h.clipboard.length,2);assert.equal(h.provider.mode,'sessions');
});
test('host rejects forged IDs/kinds and replaced snapshots, refresh permits direct retry',async t=>{
 const h=await handoffFixture(t);
 for(const bad of [{id:'other'},{handoffId:'wrong'},{kind:'bad'},{requestId:''}])await h.provider.onMessage({...request(),...bad});
 assert.equal(h.clipboard.length,0);
 h.snapshot.handoff=pendingHandoff('new');await h.provider.onMessage(request());
 assert.equal(h.clipboard.length,0);assert.match(h.panelView.messages.findLast(m=>m.type==='handoffCopied').error,/更新/);
 await h.provider.onMessage({...request('sandbox','retry'),handoffId:'new'});assert.equal(h.clipboard.length,1);
 h.snapshot.handoff=null;await h.provider.onMessage({...request('sandbox','consumed'),handoffId:'new'});assert.equal(h.clipboard.length,1);
});
test('host serializes clipboard requests and releases busy after failure',async t=>{
 const h=await handoffFixture(t);let resolve;h.api.handoff=()=>new Promise(r=>{resolve=r});
 const first=h.provider.onMessage(request());await h.provider.onMessage(request('sandbox','second'));
 assert.match(h.panelView.messages.at(-1).error,/正在复制/);resolve(h.snapshot);await first;assert.equal(h.clipboard.length,1);
 h.api.handoff=async()=>{throw Error('offline')};await h.provider.onMessage(request('sandbox','fail'));
 h.api.handoff=async()=>h.snapshot;await h.provider.onMessage(request('sandbox','retry'));assert.equal(h.clipboard.length,2);
});
test('A-B-A navigation invalidates old copy even when final selected ID matches',async t=>{
 const h=await handoffFixture(t);h.provider.refresh=async()=>{};let resolve;h.api.handoff=()=>new Promise(r=>{resolve=r});
 const copying=h.provider.onMessage(request());h.provider.showCalls({...session('idle'),id:'other'});h.provider.showCalls(session('idle'));
 resolve(h.snapshot);await copying;assert.equal(h.clipboard.length,0);assert.equal(h.provider.handoffCopyToken,undefined);
});
test('late previews are discarded after close or navigation and never include credentials',async t=>{
 const h=await handoffFixture(t);const req={...request(),type:'previewHandoff'};
 await h.provider.onMessage(req);const result=h.panelView.messages.findLast(m=>m.type==='handoffPreview');
 assert.equal(result.handoff.content,h.snapshot.handoff.content);assert.ok(!JSON.stringify(result).includes(h.snapshot.session.session_id));
 let resolve;h.api.handoff=()=>new Promise(r=>{resolve=r});const before=h.panelView.messages.length;
 const reading=h.provider.onMessage({...req,requestId:'late'});await h.provider.onMessage({type:'cancelHandoffPreview'});resolve(h.snapshot);await reading;
 assert.equal(h.panelView.messages.length,before);
});
test('disconnect retains summary but disables actions; recovery and consumption resynchronize',async t=>{
 const h=await handoffFixture(t),list=h.api.listSessions;h.api.listSessions=async()=>{throw Error('offline')};
 await h.provider.refresh(true);assert.equal(h.panelView.messages.at(-1).handoffSynchronized,false);
 assert.equal(h.panelView.messages.at(-1).selected.pending_handoff.id,'handoff-a');await h.provider.onMessage(request());assert.equal(h.clipboard.length,0);
 h.api.listSessions=list;await h.tick();assert.equal(h.panelView.messages.at(-1).handoffSynchronized,true);
 h.snapshot.handoff=null;await h.provider.refresh(true);assert.equal(h.panelView.messages.at(-1).selected.pending_handoff,null);assert.equal(h.panelView.messages.at(-1).todos.length,1);
});
test('legacy daemon never triggers per-session body fallback or disables epoch gating',async t=>{
 const h=await handoffFixture(t);let reads=0;h.api.listSessions=async()=>({sessions:[session('idle')]});h.api.handoff=async()=>{reads++;throw Error('404')};
 await h.provider.refresh(true);await h.tick();await h.tick();assert.equal(reads,0);assert.equal(h.panelView.messages.at(-1).handoffUnsupported,true);
});
test('disposed view discards in-flight copies and leaves persisted record intact',async t=>{
 const h=await handoffFixture(t);let resolve;h.api.handoff=()=>new Promise(r=>{resolve=r});const copying=h.provider.onMessage(request());h.panelView.close();resolve(h.snapshot);await copying;
 assert.equal(h.clipboard.length,0);assert.equal(h.provider.handoff,null);assert.ok(h.snapshot.handoff);
});
test('ordinary same-record refresh does not cancel copy; daemon change does',async t=>{
 for(const changed of [false,true]){
  const h=await handoffFixture(t);h.api.health=async()=>({tunnel:'offline',daemon_id:'one'});await h.provider.refresh(true);
  let resolve;h.api.handoff=()=>new Promise(r=>{resolve=r});const copying=h.provider.onMessage(request());
  if(changed)h.api.health=async()=>({tunnel:'offline',daemon_id:'two'});
  await h.provider.refresh(true);resolve(h.snapshot);await copying;assert.equal(h.clipboard.length,changed?0:1);
 }
});

test('clipboard API failure has a correlated reply, releases the host lock, and permits retry',async t=>{
 const h=await handoffFixture(t),write=h.vscode.env.clipboard.writeText;
 h.vscode.env.clipboard.writeText=async()=>{throw Error('clipboard denied')};
 await h.provider.onMessage(request());
 const result=h.panelView.messages.findLast(m=>m.type==='handoffCopied');assert.equal(result.requestId,'r1');assert.equal(result.ok,false);assert.match(result.error,/clipboard denied/);assert.equal(h.provider.handoffCopyToken,undefined);
 h.vscode.env.clipboard.writeText=write;await h.provider.onMessage(request('sandbox','retry'));assert.equal(h.clipboard.length,1);
});
