import { test } from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
const require=createRequire(import.meta.url);
const core=require('../../../.cache/vscode-auth-verify/packages/vscode/src/cloudAuthClient.js');
const cloudEnvironment=require('../../../.cache/vscode-auth-verify/packages/vscode/src/cloudEnvironment.js');
const {CloudAuthClient,CloudAuthError,CLOUD_AUTH_ORIGIN:ORIGIN,AUTH_PREFIX,credentialKey,receiptName}=core;
const CLIENT='synthetic-installation-client-0001';
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
function storage(origin=ORIGIN){
 const vault=new Map(),files=new Map();
 return {vault,files,secrets:{get:async key=>vault.get(key),store:async(key,value)=>{vault.set(key,value);},delete:async key=>{vault.delete(key);}},
  receipts:{list:async()=>[...files.values()].map(v=>structuredClone(v)),put:async value=>{files.set(receiptName(value,origin),structuredClone(value));},remove:async value=>{files.delete(receiptName(value,origin));}}};
}
function server(origin=ORIGIN){
 const flows=new Map(),sessions=new Map(),calls=[],opened=[];let sequence=0;
 const s={flows,sessions,calls,opened,now:Date.now(),user:'synthetic-user',pending:false,override:undefined,delivery:undefined,openAllowed:true};
 s.fetch=async(url,init)=>{
  assert.equal(new URL(url).origin,origin);assert.equal(init.redirect,'error');assert.equal(init.credentials,'omit');
  assert.equal(init.headers.Cookie,undefined);assert.equal(init.headers.Origin,undefined);
  const path=new URL(url).pathname,data=init.body?JSON.parse(init.body):undefined;calls.push({path,init,data});
  if(s.override){const override=await s.override(path,init,data);if(override)return override;}
  let response;
  if(path==='/api/auth/plugin/start'||/^\/api\/auth\/plugin\/(google|github)\/start$/.test(path)){
   const provider=path==='/api/auth/plugin/start'?'pending':path.split('/')[4],flowId=randomUUID(),launch=randomBytes(32).toString('base64url');flows.set(flowId,{...data,user:s.user,ready:false,launch,provider});
   const authorize=provider==='pending'?'/api/auth/plugin/authorize':'/api/auth/plugin/'+provider+'/authorize';
   response=Response.json({flowId,authorizationUrl:origin+authorize+'#'+new URLSearchParams({flow:flowId,launch}),expiresAt:Math.floor(s.now/1000)+600,pollInterval:2});
  }else if(path==='/api/auth/plugin/exchange'||/^\/api\/auth\/plugin\/(google|github)\/exchange$/.test(path)){
   const flow=flows.get(data.flowId);assert.equal(createHash('sha256').update(data.verifier).digest('base64url'),flow.challenge);
   if(!flow.ready||s.pending)response=Response.json({status:'authorization_pending'},{status:202});
   else if(flow.consumed)response=Response.json({error:'used'},{status:403});
   else {flow.consumed=true;const value={token:'bhp_'+randomBytes(32).toString('base64url'),userId:flow.user,clientId:flow.clientId,sessionId:randomUUID(),expiresAt:Math.floor(s.now/1000)+604800,loginOrder:++sequence};
    sessions.set(flow.user,value);response=Response.json(value);}
  }else if(path.endsWith('/session')){
   const value=[...sessions.values()].find(v=>'Bearer '+v.token===init.headers.Authorization);
   if(value){const {token,...facts}=value;response=Response.json(facts);}else response=Response.json({error:'revoked'},{status:401});
  }else if(path.endsWith('/logout')){
   const value=[...sessions.values()].find(v=>'Bearer '+v.token===init.headers.Authorization);if(value)sessions.delete(value.userId);
   response=new Response(null,{status:204});
  }else throw new Error('NETWORK_FORBIDDEN_IN_FIXTURE');
  return s.delivery?await s.delivery(path,response):response;
 };
 s.openExternal=async url=>{opened.push(url);const u=new URL(url),id=new URLSearchParams(u.hash.slice(1)).get('flow');assert.equal(u.origin,origin);assert.equal(u.search,'');flows.get(id).ready=true;return s.openAllowed;};
 return s;
}
function client(s,store,extra={}){const origin=extra.origin??ORIGIN;store??=storage(origin);return {store,client:new CloudAuthClient({origin,secrets:store.secrets,receipts:store.receipts,clientId:CLIENT,fetch:s.fetch,
 openExternal:s.openExternal,now:()=>s.now,sleep:async(ms,signal)=>{if(signal?.aborted)throw new CloudAuthError('cancelled');s.now+=ms;},...extra})};}
const errorCode=code=>error=>error instanceof CloudAuthError&&error.code===code;
test('runtime endpoint is immutable and ignores obsolete environment-setting arguments',()=>{
 const testOrigin='https://sandbox.blackhole.example.org';
 const expected={environment:'production',origin:ORIGIN,label:'正式环境'};
 assert.deepEqual(cloudEnvironment.resolveCloudEndpoint(),expected);
 assert.deepEqual(cloudEnvironment.resolveCloudEndpoint('test',testOrigin),expected);
 assert.equal(Object.isFrozen(cloudEnvironment.resolveCloudEndpoint()),true);
 for(const value of ['',ORIGIN,'http://sandbox.blackhole.example.org','https://sandbox.blackhole.example.org/path','https://127.0.0.1'])assert.throws(()=>cloudEnvironment.validateCloudOrigin(value));
 assert.notEqual(credentialKey('11111111-1111-4111-8111-111111111111',ORIGIN),credentialKey('11111111-1111-4111-8111-111111111111',testOrigin));
});
test('test Cloud client uses only its configured origin and an origin-isolated credential namespace',async()=>{
 const testOrigin='https://sandbox.blackhole.example.org',s=server(testOrigin),f=client(s,undefined,{origin:testOrigin});
 const view=await f.client.signIn();assert.equal(view.state,'verified');assert.equal(new URL(s.opened[0]).origin,testOrigin);
 assert.equal(f.store.vault.size,1);assert.ok([...f.store.vault.keys()][0].startsWith(cloudEnvironment.cloudAuthPrefix(testOrigin)));
 assert.ok([...f.store.files.values()].every(receipt=>receipt.origin===testOrigin));assert.equal(core.validReceipt([...f.store.files.values()][0],ORIGIN),false);
});
test('extension no longer contributes Cloud API environment settings or reload switching',()=>{
 const manifest=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')),properties=manifest.contributes.configuration.properties;
 assert.equal(properties['blackhole.cloudEnvironment'],undefined);assert.equal(properties['blackhole.cloudTestOrigin'],undefined);
 const panel=readFileSync(new URL('../src/configPanel.ts',import.meta.url),'utf8');assert.equal(panel.includes('values.cloudEnvironment'),false);assert.equal(panel.includes('values.cloudTestOrigin'),false);
});
test('Retry-After seconds/date are bounded with safe defaults',()=>{
 const now=Date.now();assert.equal(core.retryDelay('60',now),60000);assert.equal(core.retryDelay(null,now),60000);
 assert.equal(core.retryDelay('broken',now),60000);assert.equal(core.retryDelay('999999999',now),600000);
 assert.ok(core.retryDelay(new Date(now+60000).toUTCString(),now)>=59000);
});
test('login exchange honors Retry-After instead of hammering the endpoint',async()=>{
 const s=server(),f=client(s);let attempts=0,limitedAt=0,resumedAt=0;
 s.override=async path=>{if(path.endsWith('/exchange')){attempts++;if(attempts===1){limitedAt=s.now;return new Response(null,{status:429,headers:{'Retry-After':'60'}});}resumedAt=s.now;}};
 assert.equal((await f.client.signIn()).state,'verified');assert.equal(attempts,2);assert.ok(resumedAt-limitedAt>=60000);
});
test('repeated manual checks and proof calls during cooldown do not fetch or validate',async()=>{
 const s=server(),f=client(s);await f.client.signIn();s.override=async()=>new Response(null,{status:429,headers:{'Retry-After':'60'}});
 assert.equal((await f.client.check()).state,'unavailable');const count=s.calls.length;
 for(let i=0;i<5;i++)assert.equal((await f.client.check()).state,'unavailable');
 const session=[...s.sessions.values()][0];await assert.rejects(f.client.entitlementProof('x'.repeat(43),session.sessionId),errorCode('rate_limited'));
 assert.equal(s.calls.length,count);s.now+=60000;s.override=undefined;assert.equal((await f.client.check()).state,'verified');
});
test('parallel checks share one request for the same credential',async()=>{
 const s=server(),f=client(s);await f.client.signIn();const before=s.calls.length;
 await Promise.all(Array.from({length:20},()=>f.client.check()));assert.equal(s.calls.length-before,1);
});
test('subscription display uses server expiry, clears on failure and never persists profile',async()=>{
 const s=server(),f=client(s);s.delivery=async(path,response)=>path.endsWith('/session')?Response.json({...await response.json(),account:{name:'<img src=x>',email:'synthetic@example.invalid',status:'active',serviceExpiresAt:Math.floor(s.now/1000)+3600,serverNow:Math.floor(s.now/1000),salesEnabled:false,plans:[]}}):response;
 const view=await f.client.signIn();assert.equal(view.remainingSeconds,3600);assert.equal(view.account.name,'<img src=x>');
 const before=s.calls.length;s.now+=120000;assert.equal((await f.client.view()).remainingSeconds,3480);assert.equal(s.calls.length,before);
 assert.ok(!JSON.stringify([...f.store.vault.values()]).includes('synthetic@example.invalid'));
 s.now-=130000;assert.equal((await f.client.view()).account,undefined);
 s.override=async()=>new Response(null,{status:503});assert.equal((await f.client.check()).account,undefined);
});
test('malformed subscription snapshot is not displayed as validated',async()=>{
 const s=server(),f=client(s);await f.client.signIn();s.delivery=async(path,response)=>path.endsWith('/session')?Response.json({...await response.json(),account:{serviceExpiresAt:Infinity}}):response;
 assert.equal((await f.client.check()).state,'unavailable');assert.equal((await f.client.view()).account,undefined);
});
test('focused window and local receipt timer never schedule cloud verification',async()=>{
 const original=globalThis.setInterval;let tick;
 globalThis.setInterval=fn=>{tick=fn;return {unref(){}};};
 try{await withHost(async host=>{
   const s=server();globalThis.fetch=s.fetch;host.mock.env.openExternal=async value=>s.openExternal(value.toString());
   await host.registrations.get('blackhole.accountSignIn')();const before=s.calls.length;
   for(let i=0;i<80;i++){host.focus({focused:true});tick();await new Promise(r=>setImmediate(r));}
   assert.equal(s.calls.length,before);await host.registrations.get('blackhole.accountRefresh')();assert.equal(s.calls.length,before+1);
 });}finally{globalThis.setInterval=original;}
});
test('native PKCE login stores bearer only in SecretStorage and returns credential-free status',async()=>{
 const s=server(),f=client(s);assert.equal((await f.client.signIn()).state,'verified');assert.equal(s.opened.length,1);
 assert.equal(f.store.vault.size,1);assert.ok([...f.store.vault.keys()][0].startsWith(AUTH_PREFIX));
 const secret=JSON.parse([...f.store.vault.values()][0]);assert.match(secret.token,/^bhp_/);
 assert.ok(!JSON.stringify([...f.store.files.values()]).includes(secret.token));assert.ok(!JSON.stringify(await f.client.view()).includes(secret.token));
 const start=s.calls.find(v=>v.path.endsWith('/start')),exchange=s.calls.find(v=>v.path.endsWith('/exchange'));
 assert.deepEqual(Object.keys(start.data).sort(),['challenge','clientId']);assert.notEqual(start.data.challenge,exchange.data.verifier);
 assert.ok(!s.opened[0].includes(exchange.data.verifier));assert.equal(start.init.headers.Authorization,undefined);
});
test('restart and second window discover one shared credential without another login',async()=>{
 const s=server(),shared=storage(),a=client(s,shared),b=client(s,shared);await a.client.signIn();
 assert.equal((await b.client.view()).state,'saved');assert.equal((await b.client.check()).state,'verified');assert.equal(s.opened.length,1);
});


test('startup restores saved subscription after a transient GET failure without another login',async()=>{
 const s=server(),saved=client(s);await saved.client.signIn();const opened=s.opened.length;
 let gets=0;s.override=async path=>{if(path.endsWith('/session')&&++gets===1)return new Response(null,{status:503});};
 s.delivery=async(path,response)=>path.endsWith('/session')&&response.status===200?Response.json({...await response.json(),account:{name:'Saved',email:'saved@example.invalid',status:'active',serviceExpiresAt:Math.floor(s.now/1000)+3600,serverNow:Math.floor(s.now/1000),salesEnabled:false,plans:[]}}):response;
 const restarted=client(s,saved.store);const view=await restarted.client.restore();
 assert.equal(view.state,'verified');assert.equal(view.remainingSeconds,3600);assert.equal(gets,2);
 assert.equal(s.opened.length,opened);assert.equal(saved.store.vault.size,1);
});
test('startup restoration is bounded, retains a retryable credential and never replays login exchange',async()=>{
 const s=server(),saved=client(s);await saved.client.signIn();const before=s.calls.filter(x=>x.path.endsWith('/exchange')).length;
 let gets=0;s.override=async path=>{if(path.endsWith('/session')){gets++;throw Error('temporary network failure')}};
 const restarted=client(s,saved.store);assert.equal((await restarted.client.restore()).state,'unavailable');
 assert.equal(gets,3);assert.equal(saved.store.vault.size,1);
 assert.equal(s.calls.filter(x=>x.path.endsWith('/exchange')).length,before);
 s.override=undefined;assert.equal((await restarted.client.restore()).state,'verified');
});
test('a delayed prior-session check cannot erase the newly verified login snapshot',async()=>{
 for(const failed of [false,true]){
  const s=server(),f=client(s);await f.client.signIn();const held=deferred(),release=deferred();let first=true;
  s.delivery=async(path,response)=>{if(path.endsWith('/session')&&first){first=false;held.resolve();await release.promise;if(failed)return new Response(null,{status:503});}return response;};
  const old=f.client.check();await held.promise;s.user='new-current-user';
  assert.equal((await f.client.signIn()).state,'verified');release.resolve();await old;
  const current=await f.client.view();assert.equal(current.state,'verified');assert.equal(current.userId,'new-current-user');
 }
});
test('temporary SecretStorage unavailability recovers without deleting or replacing the saved credential',async()=>{
 const s=server(),f=client(s);await f.client.signIn();let reads=0;const get=f.store.secrets.get;
 f.store.secrets.get=async key=>++reads===1?undefined:get(key);
 const restarted=client(s,f.store);assert.equal((await restarted.client.restore()).state,'verified');
 assert.equal(s.opened.length,1);assert.equal(f.store.vault.size,1);
});
test('startup restoration respects 401 revocation and 429 cooldown instead of retrying credentials',async()=>{
 for(const status of [401,429]){
  const s=server(),saved=client(s);await saved.client.signIn();let gets=0;
  s.override=async path=>{if(path.endsWith('/session')){gets++;return new Response(null,{status,headers:{'Retry-After':'60'}})}};
  const restored=await client(s,saved.store).client.restore();
  assert.equal(gets,1);assert.equal(restored.state,status===401?'logged_out':'unavailable');
  assert.equal(saved.store.vault.size,status===401?0:1);
 }
});
test('late lower-order exchange response cannot overwrite the newer login, even after restart',async()=>{
 const s=server(),shared=storage(),a=client(s,shared),b=client(s,shared),held=deferred(),release=deferred();let first=true;
 s.delivery=async(path,response)=>{if(path.endsWith('/exchange')&&first){first=false;held.resolve();await release.promise;}return response;};
 const older=a.client.signIn();await held.promise;await b.client.signIn();const latest=[...s.sessions.values()][0];release.resolve();await older;
 assert.equal((await client(s,shared).client.check()).state,'verified');assert.equal(shared.vault.size,1);
 assert.equal(JSON.parse([...shared.vault.values()][0]).sessionId,latest.sessionId);
});
test('out-of-order different-account responses also select the latest completed login',async()=>{
 const s=server(),shared=storage(),a=client(s,shared),b=client(s,shared),held=deferred(),release=deferred();let first=true;
 s.delivery=async(path,response)=>{if(path.endsWith('/exchange')&&first){first=false;held.resolve();await release.promise;}return response;};
 const older=a.client.signIn();await held.promise;s.user='another-user';await b.client.signIn();release.resolve();await older;
 assert.equal((await client(s,shared).client.check()).userId,'another-user');
});
test('logout tombstone prevents older delayed login or other window from resurrecting an account',async()=>{
 const s=server(),shared=storage(),a=client(s,shared),b=client(s,shared),held=deferred(),release=deferred();let first=true;
 s.delivery=async(path,response)=>{if(path.endsWith('/exchange')&&first){first=false;held.resolve();await release.promise;}return response;};
 const older=a.client.signIn();await held.promise;await b.client.signIn();await b.client.signOut();release.resolve();await older;
 assert.equal((await client(s,shared).client.view()).state,'logged_out');assert.equal(shared.vault.size,0);
 const highest=Math.max(...[...shared.files.values()].map(r=>r.loginOrder));assert.ok([...shared.files.values()].some(r=>r.loginOrder===highest&&r.kind==='logout'));
});
test('stale401 completion does not erase a newer window credential',async()=>{
 const s=server(),shared=storage(),a=client(s,shared),b=client(s,shared);await a.client.signIn();
 const held=deferred(),release=deferred();let once=true;s.override=async path=>{if(path.endsWith('/session')&&once){once=false;held.resolve();await release.promise;return Response.json({error:'revoked'},{status:401});}};
 const pending=a.client.check();await held.promise;await b.client.signIn();release.resolve();await pending;
 assert.equal((await client(s,shared).client.check()).state,'verified');assert.equal(shared.vault.size,1);
});
test('logout response racing with a new login only removes the originally selected credential',async()=>{
 const s=server(),shared=storage(),a=client(s,shared),b=client(s,shared);await a.client.signIn();
 const held=deferred(),release=deferred();s.delivery=async(path,response)=>{if(path.endsWith('/logout')){held.resolve();await release.promise;}return response;};
 const pending=a.client.signOut();await held.promise;await b.client.signIn();release.resolve();await pending;
 assert.equal((await client(s,shared).client.check()).state,'verified');
});
test('remote replacement401 is detected and does not extend service or revive a cached login',async()=>{
 const s=server(),a=client(s),b=client(s);await a.client.signIn();await b.client.signIn();assert.equal((await a.client.check()).state,'logged_out');assert.equal(a.store.vault.size,0);
});
test('network outage retains retryable secret but reports unavailable, not verified',async()=>{
 const s=server(),f=client(s);await f.client.signIn();s.override=async path=>{if(path.endsWith('/session'))throw new Error('synthetic-private-network-detail');};
 assert.equal((await f.client.check()).state,'unavailable');assert.equal(f.store.vault.size,1);
});
test('failed server logout preserves secret and never publishes a success tombstone',async()=>{
 const s=server(),f=client(s);await f.client.signIn();s.override=async path=>path.endsWith('/logout')?new Response('private-error',{status:503}):undefined;
 await assert.rejects(f.client.signOut(),errorCode('not_available'));assert.equal(f.store.vault.size,1);assert.ok([...f.store.files.values()].every(r=>r.kind==='login'));
});
test('expired stored credentials are removed without an API request or extra grace',async()=>{
 const s=server(),f=client(s);await f.client.signIn();const n=s.calls.length;s.now+=604801000;
 assert.equal((await f.client.check()).state,'logged_out');assert.equal(f.store.vault.size,0);assert.equal(s.calls.length,n);
});
test('cancel before start produces no network, browser or persistent credential',async()=>{
 const s=server(),f=client(s),abort=new AbortController();abort.abort();await assert.rejects(f.client.signIn(abort.signal),errorCode('cancelled'));assert.equal(s.calls.length,0);assert.equal(f.store.files.size,0);
});
test('cancel while polling stops future exchanges and stores no credential',async()=>{
 const s=server(),abort=new AbortController();s.pending=true;const f=client(s,storage(),{sleep:async()=>{abort.abort();throw new CloudAuthError('cancelled');}});
 await assert.rejects(f.client.signIn(abort.signal),errorCode('cancelled'));assert.equal(s.calls.filter(v=>v.path.endsWith('/exchange')).length,0);assert.equal(f.store.vault.size,0);
});
test('pending authorization has a bounded deadline and no secret persistence',async()=>{
 const s=server();s.pending=true;const f=client(s);await assert.rejects(f.client.signIn(),errorCode('expired'));
 assert.ok(s.calls.length<=302);assert.equal(f.store.vault.size,0);
});
test('ambiguous exchange transport failure is not blindly retried',async()=>{
 const s=server(),f=client(s);s.override=async path=>{if(path.endsWith('/exchange'))throw new Error('do-not-print-synthetic-secret');};
 await assert.rejects(f.client.signIn(),errorCode('network'));assert.equal(s.calls.filter(v=>v.path.endsWith('/exchange')).length,1);assert.equal(f.store.vault.size,0);
});
test('closed server503 is reported before opening browser',async()=>{
 const s=server(),f=client(s);s.override=async()=>new Response('setup',{status:503});await assert.rejects(f.client.signIn(),errorCode('not_available'));assert.equal(s.opened.length,0);
});
test('system browser rejection does not start token polling',async()=>{
 const s=server();s.openAllowed=false;const f=client(s);await assert.rejects(f.client.signIn(),errorCode('browser_failed'));assert.equal(s.calls.filter(v=>v.path.endsWith('/exchange')).length,0);
});
test('same-window duplicate login is refused instead of starting another flow',async()=>{
 const s=server(),held=deferred(),release=deferred();s.delivery=async(path,response)=>{if(path.endsWith('/start')){held.resolve();await release.promise;}return response;};
 const f=client(s),first=f.client.signIn();await held.promise;await assert.rejects(f.client.signIn(),errorCode('busy'));release.resolve();await first;
});
test('reject foreign, HTTP, credential-bearing and wrong-path authorization URLs',async()=>{
 for(const url of ['https://evil.invalid/','http://blackhole.stellarbridge.dpdns.org/','https://u:p@blackhole.stellarbridge.dpdns.org/','https://blackhole.stellarbridge.dpdns.org/admin']){
  const s=server(),f=client(s);s.override=async()=>Response.json({flowId:randomUUID(),authorizationUrl:url,expiresAt:Math.floor(s.now/1000)+600,pollInterval:2});
  await assert.rejects(f.client.signIn(),errorCode('invalid_response'));assert.equal(s.opened.length,0);
 }
});
test('reject redirect responses even if a substituted transport follows them',async()=>{
 const s=server(),f=client(s);s.override=async()=>{const r=Response.json({});Object.defineProperty(r,'redirected',{value:true});return r;};
 await assert.rejects(f.client.signIn(),errorCode('invalid_response'));
});
test('invalid or oversized response is sanitized and never persisted',async()=>{
 for(const response of [()=>new Response('SYNTHETIC-PRIVATE',{headers:{'Content-Type':'text/plain'}}),()=>new Response('{"private":"'+'x'.repeat(20000)+'"}',{headers:{'Content-Type':'application/json'}})]){
  const s=server(),f=client(s);s.override=async()=>response();await assert.rejects(f.client.signIn(),errorCode('invalid_response'));assert.equal(f.store.vault.size,0);
 }
});
test('wrong installation, malformed token, unsafe ordering or excessive expiry cannot enter vault',async()=>{
 for(const change of [{clientId:'different-installation-0002'},{token:'bhp_'+ 'a'.repeat(43)+'\n'},{loginOrder:0},{loginOrder:1.5},{expiresAt:9999999999}]){
  const s=server(),f=client(s);s.delivery=async(path,response)=>path.endsWith('/exchange')?Response.json({...await response.json(),...change}):response;
  await assert.rejects(f.client.signIn(),errorCode('invalid_response'));assert.equal(f.store.vault.size,0);
 }
});
test('untrusted extra response fields are not stored or shown as client roles',async()=>{
 const s=server(),f=client(s);s.delivery=async(path,response)=>path.endsWith('/exchange')?Response.json({...await response.json(),role:'admin',clientSecret:'synthetic-forbidden-field'}):response;
 await f.client.signIn();assert.ok(![...f.store.vault.values()][0].includes('synthetic-forbidden-field'));assert.ok(!JSON.stringify(await f.client.view()).includes('admin'));
});
test('SecretStorage failure is fixed-code error and cannot be disguised as successful login',async()=>{
 const s=server(),store=storage();store.secrets.store=async()=>{throw new Error('SYNTHETIC-PRIVATE-DETAIL');};const f=client(s,store);
 await assert.rejects(f.client.signIn(),errorCode('storage'));assert.equal(store.files.size,0);
});
test('mismatched session facts never count as validated authentication',async()=>{
 const s=server(),f=client(s);await f.client.signIn();s.delivery=async(path,response)=>path.endsWith('/session')?Response.json({...await response.json(),userId:'attacker'}):response;
 assert.equal((await f.client.check()).state,'unavailable');
});

function hostMock(){
 const registrations=new Map(),files=new Map(),vault=new Map(),messages=[],bars=[],clipboard=[];let secretListener,focusListener;
 class Disposable{constructor(fn=()=>{}){this.fn=fn;}dispose(){this.fn();}static from(...values){return new Disposable(()=>values.forEach(v=>v.dispose()));}}
 const uri=path=>({path,fsPath:path,scheme:'file',toString:()=>path});
 const mock={Disposable,Uri:{parse:value=>({toString:()=>value}),joinPath:(base,...parts)=>uri(base.path+'/'+parts.join('/'))},StatusBarAlignment:{Right:2},ProgressLocation:{Notification:15},
  env:{machineId:'SYNTHETIC-MACHINE-ID',openExternal:async()=>false,clipboard:{writeText:async value=>{clipboard.push(value);}}},
  commands:{registerCommand:(name,fn)=>{registrations.set(name,fn);return new Disposable(()=>registrations.delete(name));},executeCommand:async name=>registrations.get(name)?.()},
  workspace:{getConfiguration:()=>({get:key=>{if(key==='cloudEnvironment'||key==='cloudTestOrigin')throw Error('removed Cloud setting must never be read');return undefined;}}),fs:{createDirectory:async()=>{},readDirectory:async directory=>[...files.keys()].filter(p=>p.startsWith(directory.path+'/')).map(p=>[p.split('/').at(-1),1]),
   readFile:async value=>{if(!files.has(value.path)){const e=new Error('missing');e.code='FileNotFound';throw e;}return files.get(value.path);},
   writeFile:async(value,data)=>{files.set(value.path,data);},delete:async value=>{files.delete(value.path);}}},
  window:{createStatusBarItem:()=>{const bar={text:'',tooltip:'',show(){},dispose(){bar.disposed=true;}};bars.push(bar);return bar;},
   onDidChangeWindowState:fn=>{focusListener=fn;return new Disposable(()=>{focusListener=undefined;});},
   showInformationMessage:async text=>{messages.push(text);},showWarningMessage:async(text,options)=>{messages.push(text);return options?.modal?'退出':undefined;},showQuickPick:async()=>undefined,
   withProgress:async(_opts,fn)=>fn({}, {isCancellationRequested:false,onCancellationRequested:()=>new Disposable()})}};
 const globalState=new Map();
 const context={globalStorageUri:uri('/SYNTHETIC-EXTENSION-STORAGE'),globalState:{get:key=>globalState.get(key),update:async(key,value)=>{globalState.set(key,value);}},secrets:{get:async key=>vault.get(key),store:async(key,value)=>{vault.set(key,value);secretListener?.({key});},delete:async key=>{vault.delete(key);secretListener?.({key});},onDidChange:fn=>{secretListener=fn;return new Disposable(()=>{secretListener=undefined;});}}};
 return {mock,context,globalState,registrations,files,vault,messages,bars,clipboard,get focus(){return focusListener;}};
}
async function withHost(fn,bridge){
 const host=hostMock(),originalLoad=Module._load,originalFetch=globalThis.fetch;
 Module._load=function(name,...args){if(name==='vscode')return host.mock;return originalLoad.call(this,name,...args);};
 const module=require.resolve('../../../.cache/vscode-auth-verify/packages/vscode/src/cloudAccount.js'),billingModule=require.resolve('../../../.cache/vscode-auth-verify/packages/vscode/src/cloudBilling.js');delete require.cache[module];delete require.cache[billingModule];
 let registration;
 try{const {registerCloudAccount}=require(module);host.views=[];
  const register=()=>registerCloudAccount(host.context,view=>host.views.push(view),bridge);
  registration=register();host.reload=()=>{registration.dispose();registration=register();};await fn(host);}
 finally{registration?.dispose();delete require.cache[module];delete require.cache[billingModule];Module._load=originalLoad;globalThis.fetch=originalFetch;}
 assert.equal(host.registrations.size,0);assert.equal(host.bars.length,0);assert.equal(host.focus,undefined); // Account adapter no longer owns a second status bar.
}
test('real account adapter reload recovers a saved subscription and deduplicates daemon health notifications',async()=>{
 await withHost(async host=>{
  const s=server();s.now=Date.now();globalThis.fetch=s.fetch;host.mock.env.openExternal=async value=>s.openExternal(value.toString());
  s.delivery=async(path,response)=>path.endsWith('/session')&&response.status===200?Response.json({...await response.json(),account:{name:'Saved',email:'saved@example.invalid',status:'active',serviceExpiresAt:Math.floor(s.now/1000)+3600,serverNow:Math.floor(s.now/1000),salesEnabled:false,plans:[]}}):response;
  await host.registrations.get('blackhole.accountSignIn')();const opened=s.opened.length;let gets=0;
  s.override=async path=>{if(path.endsWith('/session')&&++gets===1)return new Response(null,{status:503});};
  host.reload();
  const view=await host.registrations.get('blackhole.accountSnapshot')({daemonId:'reload-fixture'});
  assert.equal(view.state,'verified');assert.ok(view.remainingSeconds>0);assert.equal(gets,2);
  assert.equal(host.views.at(-1).state,'verified');assert.equal(s.opened.length,opened);assert.equal(host.vault.size,1);
  const before=s.calls.length;
  for(let n=0;n<10;n++)await host.registrations.get('blackhole.accountSnapshot')({daemonId:'reload-fixture'});
  assert.equal(s.calls.length,before,'same daemon notifications must stay local');
 },{entitlement:async()=>({})});
});
test('a failed local entitlement refresh is retained until acknowledged instead of requiring login again',async()=>{
 let attempts=0;
 await withHost(async host=>{
  globalThis.fetch=async()=>{throw Error('NETWORK_FORBIDDEN')};
  await host.registrations.get('blackhole.accountStatus')();
  for(let n=0;n<5;n++){await host.registrations.get('blackhole.accountSnapshot')();await new Promise(r=>setImmediate(r));}
  assert.equal(attempts,2);assert.equal(host.vault.size,0);
 },{entitlement:async action=>{if(action==='refresh'&&++attempts===1)throw Error('daemon restarting');return {}}});
});
test('account broker binds each follow-up to the immutable origin and returned daemon identity',async()=>{
 const calls=[];
 await withHost(async host=>{
  globalThis.fetch=async()=>{throw Error('NETWORK_FORBIDDEN')};
  await host.registrations.get('blackhole.accountSnapshot')({daemonId:'observed-instance'});
  for(let n=0;n<3;n++)await new Promise(r=>setImmediate(r));
  assert.ok(calls.some(x=>x.action==='claim'));
  for(const call of calls){assert.equal(call.body.cloud_origin,ORIGIN);if(call.action!=='identity')assert.equal(call.body.daemon_id,'actual-instance');}
 },{entitlement:async(action,body)=>{calls.push({action,body});return action==='identity'?{ok:true,daemon_id:'actual-instance'}:{}}});
});

test('receipt directory failure on reload recovers the existing login without another browser exchange',async()=>{
 await withHost(async host=>{
  const s=server();globalThis.fetch=s.fetch;host.mock.env.openExternal=async url=>s.openExternal(url.toString());
  await host.registrations.get('blackhole.accountSignIn')();const tokenSlots=[...host.vault.entries()],opened=s.opened.length;
  let attempts=0;host.mock.workspace.fs.createDirectory=async()=>{if(++attempts===1)throw Error('temporary directory failure');};
  host.reload();
  await host.registrations.get('blackhole.accountRefresh')();
  const view=await host.registrations.get('blackhole.accountSnapshot')();
  assert.equal(view?.state,'verified');assert.ok(attempts>=2&&attempts<=3);
  assert.deepEqual([...host.vault.entries()],tokenSlots);assert.equal(s.opened.length,opened);
 });
});
test('persistent initialization failure is bounded; an explicit refresh can retry after storage recovers',async()=>{
 await withHost(async host=>{
  let attempts=0;host.mock.workspace.fs.createDirectory=async()=>{attempts++;throw Error('directory denied');};
  host.reload();await host.registrations.get('blackhole.accountRefresh')();
  const before=attempts;assert.ok(before<=3);
  for(let n=0;n<5;n++)await host.registrations.get('blackhole.accountSnapshot')();
  assert.equal(attempts,before,'passive snapshots cannot create a retry storm');
  host.mock.workspace.fs.createDirectory=async()=>{attempts++;};
  await host.registrations.get('blackhole.accountRefresh')();
  const view=await host.registrations.get('blackhole.accountSnapshot')();
  assert.equal(view?.state,'logged_out');assert.equal(attempts,before+1);
 });
});
test('VS Code adapter registers actual commands, starts with no network, and disposes all handlers',async()=>{
 await withHost(async host=>{
  globalThis.fetch=async()=>{throw new Error('NETWORK_FORBIDDEN_IN_FIXTURE');};
  assert.deepEqual([...host.registrations.keys()],['blackhole.accountSignIn','blackhole.accountRedeemCard','blackhole.accountSignOut','blackhole.accountStatus','blackhole.accountSnapshot','blackhole.accountRefresh','blackhole.accountBuyCard','blackhole.accountOrders','blackhole.accountRefund']);
  await host.registrations.get('blackhole.accountStatus')();assert.equal(host.vault.size,0);assert.equal(host.files.size,0);
 });
});
test('VS Code login command reports closed server without displaying provider error body',async()=>{
 await withHost(async host=>{
  globalThis.fetch=async()=>new Response('SYNTHETIC-PRIVATE-RESPONSE',{status:503});await host.registrations.get('blackhole.accountSignIn')();
  assert.ok(host.messages.some(m=>m.includes('尚未开启')));assert.ok(!host.messages.join('').includes('SYNTHETIC-PRIVATE'));assert.equal(host.files.size,0);
 });
});
test('actual VS Code adapter uses system browser, secure slots, nonsecret receipts and independent logout',async()=>{
 await withHost(async host=>{
  const s=server();s.now=Date.now();globalThis.fetch=s.fetch;host.mock.env.openExternal=async value=>s.openExternal(value.toString());
  await host.registrations.get('blackhole.accountSignIn')();assert.equal(host.vault.size,1);assert.equal(s.opened.length,1);
  const secret=JSON.parse([...host.vault.values()][0]);assert.equal(secret.clientId,createHash('sha256').update('blackhole-installation-v1\0'+ORIGIN+'\0SYNTHETIC-MACHINE-ID').digest('base64url'));
  assert.ok(![...host.files.values()].map(v=>Buffer.from(v).toString()).join('').includes(secret.token));assert.ok(!host.messages.join('').includes(secret.token));
  await host.registrations.get('blackhole.accountSignOut')();assert.equal(host.vault.size,0);assert.equal(s.sessions.size,0);
  assert.ok(host.messages.every(text=>!String(text).includes('管理员网页')));
 });
});
test('extension activation and command contributions are wired without exposing backend secrets',()=>{
 const extension=readFileSync(new URL('../src/extension.ts',import.meta.url),'utf8'),pkg=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));
 assert.match(extension,/registerCloudAccount\(context, view => \{ statusBar\.updateAccount\(view\); sidebar\.updateAccount\(view\); \}, api\)/);
 assert.equal((extension.match(/new StatusBarController\(/g)||[]).length,1);
 assert.ok(!readFileSync(new URL('../src/cloudAccount.ts',import.meta.url),'utf8').includes('createStatusBarItem'));
 const ignores=readFileSync(new URL('../.vscodeignore',import.meta.url),'utf8');for(const rule of ['test/**','**/.dev.vars*','**/.env*'])assert.ok(ignores.includes(rule));
 for(const name of ['accountSignIn','accountSignOut','accountStatus','accountBuyCard','accountOrders','accountRefund'])assert.equal(pkg.contributes.commands.filter(v=>v.command==='blackhole.'+name).length,1);
 const accountSource=readFileSync(new URL('../src/cloudAccount.ts',import.meta.url),'utf8'),panel=readFileSync(new URL('../src/configPanel.ts',import.meta.url),'utf8');
 assert.equal(pkg.contributes.commands.filter(v=>v.command==='blackhole.accountSignInGitHub').length,0);
 assert.ok(!accountSource.includes('accountSignInGitHub'));assert.ok(!panel.includes('cloudSignInGitHub'));
 assert.equal(panel.split('id="cloudSignIn"').length-1,1);
 assert.ok(panel.includes("$('cloudSignIn').style.display=loggedIn?'none':''"));
 assert.ok(panel.includes('id="cloudBuyModal"'));assert.ok(panel.includes("$('cloudBuyConfirm').onclick"));assert.ok(panel.includes("m.action==='buyCard'?[m.sku,true]:[]"));
 assert.ok(panel.includes('id="cloudRefund"'));assert.ok(panel.includes("refund:'blackhole.accountRefund'"));
 assert.ok(panel.includes("event.target===$('cloudBuyModal')"));assert.ok(panel.includes("event.key==='Escape'"));
 for(const name of ['../src/cloudAuthClient.ts','../src/cloudAccount.ts','../../../src/account/cloud-auth-client.ts']){
  const source=readFileSync(new URL(name,import.meta.url),'utf8');assert.ok(!source.includes('GOOGLE_CLIENT_SECRET'));assert.ok(!source.includes('console.log'));assert.ok(!source.includes('log.append'));
 }
});

test('cancel while system browser confirmation is pending stops this client without token polling',async()=>{
 const s=server(),shown=deferred(),pending=deferred(),abort=new AbortController();
 const f=client(s,storage(),{openExternal:async()=>{shown.resolve();return pending.promise;}});
 const login=f.client.signIn(abort.signal);await shown.promise;abort.abort();await assert.rejects(login,errorCode('cancelled'));pending.resolve(true);
 assert.equal(s.calls.filter(v=>v.path.endsWith('/exchange')).length,0);assert.equal(f.store.vault.size,0);
});
test('clock rollback does not extend cached verified status',async()=>{
 const s=server(),f=client(s);await f.client.signIn();s.now-=3600000;assert.equal((await f.client.view()).state,'saved');
});


test('single plugin login opens the provider chooser and polls the provider-neutral exchange',async()=>{
 const s=server(),f=client(s);assert.equal((await f.client.signIn()).state,'verified');
 assert.ok(s.calls.some(c=>c.path==='/api/auth/plugin/start'));assert.ok(s.calls.some(c=>c.path==='/api/auth/plugin/exchange'));
 assert.equal(new URL(s.opened[0]).pathname,'/api/auth/plugin/authorize');assert.equal(f.store.vault.size,1);
 assert.ok(!s.calls.some(c=>/\/plugin\/(google|github)\/start$/.test(c.path)));
});
test('single login rejects a provider-specific launcher returned by the generic start',async()=>{
 const s=server(),f=client(s);s.delivery=async(path,response)=>path==='/api/auth/plugin/start'?Response.json({...await response.json(),authorizationUrl:ORIGIN+'/api/auth/plugin/google/authorize#flow='+randomUUID()}):response;
 await assert.rejects(f.client.signIn(),errorCode('invalid_response'));assert.equal(s.opened.length,0);
});
const billingOrder=(id,status='payment_pending',extra={})=>({id,sku:'pro_day',amountMinor:100,currency:'CNY',durationSeconds:86400,status,provider:'alipay',environment:'sandbox',noAutoRenew:true,createdAt:1789467000,expiresAt:1789468800,paidAt:status==='payment_pending'?null:1789467060,fulfilledAt:status==='fulfilled'?1789467070:null,...extra});
const checkoutUrl=id=>ORIGIN+'/api/billing/checkout#'+new URLSearchParams({order:id,checkout:'C'.repeat(43)});
const refundQuoteToken='1789467200.0.5.'+'A'.repeat(43);
const billingRefundQuote=(orderId,extra={})=>({orderId,amountMinor:5,currency:'CNY',unusedSeconds:1,refundableSeconds:3600,quoteMode:'remaining_prorata',generatedAt:1789467200,existingStatus:null,quoteToken:refundQuoteToken,...extra});
const billingRefund=(orderId,extra={})=>({refundId:randomUUID(),orderId,amountMinor:5,currency:'CNY',status:'refunded',requestedAt:1789467200,providerConfirmedAt:1789467201,finalizedAt:1789467202,duplicate:false,...extra});
test('billing client uses the authenticated account and validates automatic-fulfillment order responses',async()=>{
 const s=server(),f=client(s);await f.client.signIn();const orderId=randomUUID(),checkout=checkoutUrl(orderId);
 let status='payment_pending';
 s.override=async(path,init,data)=>{
  if(path==='/api/billing/plans')return Response.json({enabled:true,environment:'sandbox',plans:[{sku:'pro_day',amountMinor:100,currency:'CNY',durationSeconds:86400}]});
  if(path==='/api/billing/orders'&&init.method==='POST'){assert.equal(init.headers['Idempotency-Key'],'billing-request-fixture-0001');assert.deepEqual(data,{sku:'pro_day'});return Response.json({order:billingOrder(orderId),checkoutUrl:checkout});}
  if(path==='/api/billing/orders'&&init.method==='GET')return Response.json({orders:[billingOrder(orderId,status)]});
  if(path.endsWith('/reconcile')){status='fulfilled';return Response.json({order:billingOrder(orderId,'fulfilled')});}
  if(path.endsWith('/checkout-link'))return Response.json({order:billingOrder(orderId,status),checkoutUrl:checkout});
  if(path.endsWith('/cancel')){status='expired';return Response.json({order:billingOrder(orderId,'expired',{paidAt:null})});}
 };
 const plans=await f.client.billingPlans(s.user);assert.equal(plans.plans[0].amountMinor,100);
 const created=await f.client.createBillingOrder(s.user,'pro_day','billing-request-fixture-0001');assert.equal(created.checkoutUrl,checkout);
 assert.equal((await f.client.reconcileBillingOrder(s.user,orderId)).status,'fulfilled');
 assert.equal((await f.client.billingOrders(s.user))[0].status,'fulfilled');
 const before=s.calls.length;await assert.rejects(f.client.billingPlans('different-user'),errorCode('rejected'));assert.equal(s.calls.length,before);
});
test('billing refund client validates a buyer-favouring quote and submits the bound quote with confirmation and idempotency',async()=>{
 const s=server(),f=client(s);await f.client.signIn();const orderId=randomUUID(),refund=billingRefund(orderId);
 s.override=async(path,init,data)=>{
  if(path.endsWith('/refund-quote')){assert.equal(init.method,'GET');assert.equal(data,undefined);return Response.json({quote:billingRefundQuote(orderId)});}
  if(path.endsWith('/refund')){assert.equal(init.method,'POST');assert.deepEqual(data,{confirmation:'refund',quoteToken:refundQuoteToken});assert.equal(init.headers['Idempotency-Key'],'buyer-refund-client-0001');return Response.json({refund});}
 };
 assert.deepEqual(await f.client.billingRefundQuote(s.user,orderId),billingRefundQuote(orderId));
 assert.deepEqual(await f.client.refundBillingOrder(s.user,orderId,'buyer-refund-client-0001',refundQuoteToken),refund);
 const before=s.calls.length;await assert.rejects(f.client.billingRefundQuote('different-user',orderId),errorCode('rejected'));assert.equal(s.calls.length,before);
});
test('billing refund client rejects malformed facts and maps ineligible or uncertain results safely',async()=>{
 const s=server(),f=client(s);await f.client.signIn();const orderId=randomUUID();
 s.override=async path=>path.endsWith('/refund-quote')?Response.json({quote:billingRefundQuote(orderId,{refundableSeconds:3599})}):undefined;
 await assert.rejects(f.client.billingRefundQuote(s.user,orderId),errorCode('invalid_response'));
 s.override=async path=>path.endsWith('/refund')?Response.json({refund:billingRefund(orderId,{status:'requested',providerConfirmedAt:1789467201,finalizedAt:null})}):undefined;
 await assert.rejects(f.client.refundBillingOrder(s.user,orderId,'buyer-refund-client-0002',refundQuoteToken),errorCode('invalid_response'));
 s.override=async path=>path.endsWith('/refund-quote')?Response.json({error:'not_eligible'},{status:409}):undefined;
 await assert.rejects(f.client.billingRefundQuote(s.user,orderId),errorCode('refund_not_eligible'));
 s.override=async path=>path.endsWith('/refund')?Response.json({error:'unknown'},{status:503}):undefined;
 await assert.rejects(f.client.refundBillingOrder(s.user,orderId,'buyer-refund-client-0003',refundQuoteToken),errorCode('refund_result_unknown'));
});
test('billing client rejects foreign checkout origins and untrusted response fields',async()=>{
 const s=server(),f=client(s);await f.client.signIn();const orderId=randomUUID();
 s.override=async path=>path==='/api/billing/orders'?Response.json({order:billingOrder(orderId),checkoutUrl:'https://evil.invalid/api/billing/checkout#order='+orderId+'&checkout='+'C'.repeat(43)}):undefined;
 await assert.rejects(f.client.createBillingOrder(s.user,'pro_day','billing-request-fixture-0002'),errorCode('invalid_response'));
 s.override=async path=>path==='/api/billing/plans'?Response.json({enabled:true,environment:'sandbox',plans:[],serverSecret:'never-trust-extra-fields'}):undefined;
 await assert.rejects(f.client.billingPlans(s.user),errorCode('invalid_response'));
});
test('price changes after acceptance confirmation never open an unexpected-price checkout',async()=>{
 await withHost(async host=>{
  const s=server();globalThis.fetch=s.fetch;host.mock.env.openExternal=async value=>s.openExternal(value.toString());await host.registrations.get('blackhole.accountSignIn')();
  let opened=0;const id=randomUUID();host.mock.env.openExternal=async()=>{opened++;return true;};
  host.mock.window.showInformationMessage=async(_text,options)=>options?.modal?'前往付款':undefined;
  s.override=async(path,init)=>{
   if(path==='/api/billing/plans')return Response.json({enabled:true,environment:'production',plans:[{sku:'pro_day',amountMinor:1,currency:'CNY',durationSeconds:86400}]});
   if(path==='/api/billing/orders'&&init.method==='POST')return Response.json({order:billingOrder(id,'payment_pending',{amountMinor:100}),checkoutUrl:ORIGIN+'/api/billing/checkout#'+new URLSearchParams({order:id,checkout:'S'.repeat(43)})});
  };
  await host.registrations.get('blackhole.accountBuyCard')('pro_day',true);assert.equal(opened,0);
 });
});
test('one-cent acceptance reconfirms actual server price even when launched from settings',async()=>{
 for(const approve of [false,true])await withHost(async host=>{
  const s=server();globalThis.fetch=s.fetch;host.mock.env.openExternal=async value=>s.openExternal(value.toString());await host.registrations.get('blackhole.accountSignIn')();
  let confirmations=0,created=0;const id=randomUUID();host.mock.env.openExternal=async()=>false;
  host.mock.window.showInformationMessage=async(text,options)=>{
   if(options?.modal){confirmations++;assert.match(text,/支付验收/);assert.match(text,/¥0\.01/);assert.match(options.detail,/不会自动续费/);return approve?'前往付款':undefined;}
  };
  s.override=async(path,init)=>{
   if(path==='/api/billing/plans')return Response.json({enabled:true,environment:'production',plans:[{sku:'pro_day',amountMinor:1,currency:'CNY',durationSeconds:86400}]});
   if(path==='/api/billing/orders'&&init.method==='POST'){created++;return Response.json({order:billingOrder(id,'payment_pending',{amountMinor:1,environment:'production'}),checkoutUrl:ORIGIN+'/api/billing/checkout#'+new URLSearchParams({order:id,checkout:'S'.repeat(43)})});}
  };
  await host.registrations.get('blackhole.accountBuyCard')('pro_day',true);
  assert.equal(confirmations,1);assert.equal(created,approve?1:0);
 });
});
test('VS Code purchase opens the system browser, tolerates a transient query failure and refreshes after automatic fulfillment',async()=>{
 const actions=[];
 await withHost(async host=>{
  const s=server();globalThis.fetch=s.fetch;host.mock.env.openExternal=async value=>s.openExternal(value.toString());await host.registrations.get('blackhole.accountSignIn')();
  const orderId=randomUUID(),checkout=ORIGIN+'/api/billing/checkout#'+new URLSearchParams({order:orderId,checkout:'D'.repeat(43)});let opened='',reconcileCalls=0;
  host.mock.env.openExternal=async value=>{opened=value.toString();return true;};
  host.mock.window.showQuickPick=async items=>items[0];
  host.mock.window.showInformationMessage=async text=>{host.messages.push(text);if(text.startsWith('确认购买'))return '前往付款';};
  s.override=async(path,init)=>{
   if(path==='/api/billing/plans')return Response.json({enabled:true,environment:'sandbox',plans:[{sku:'pro_day',amountMinor:100,currency:'CNY',durationSeconds:86400}]});
   if(path==='/api/billing/orders'&&init.method==='POST')return Response.json({order:billingOrder(orderId),checkoutUrl:checkout});
   if(path.endsWith('/reconcile')){reconcileCalls++;if(reconcileCalls===1)return Response.json({error:'alipay_query_unavailable'},{status:503});return Response.json({order:billingOrder(orderId,'fulfilled')});}
  };
  await host.registrations.get('blackhole.accountBuyCard')();await new Promise(r=>setImmediate(r));
  assert.equal(opened,checkout);assert.equal(reconcileCalls,2);assert.ok(actions.includes('refresh'));
  assert.ok(host.messages.some(message=>message.includes('已自动叠加到当前账号')));assert.ok(!s.calls.some(call=>call.path.includes('claim-card')||call.path.includes('ack-card')||call.path.includes('/cards/redeem')));
 },{entitlement:async action=>{actions.push(action);return {};}});
});
test('VS Code settings refund command quotes the selected paid order, explains exclusions and refreshes after success',async()=>{
 const actions=[];
 await withHost(async host=>{
  const s=server();globalThis.fetch=s.fetch;host.mock.env.openExternal=async value=>s.openExternal(value.toString());await host.registrations.get('blackhole.accountSignIn')();
  const orderId=randomUUID(),result=billingRefund(orderId);let detail='';
  host.mock.window.showQuickPick=async items=>items[0];
  host.mock.window.showInformationMessage=async(text,options,...items)=>{host.messages.push(text);if(options?.modal){detail=options.detail;assert.ok(items.includes('确认退款'));return '确认退款';}};
  s.override=async(path,init,data)=>{
   if(path==='/api/billing/refundable-orders'&&init.method==='GET')return Response.json({orders:[billingOrder(orderId,'fulfilled')],nextCursor:null});
   if(path.endsWith('/refund-quote'))return Response.json({quote:billingRefundQuote(orderId)});
   if(path.endsWith('/refund')){assert.deepEqual(data,{confirmation:'refund',quoteToken:refundQuoteToken});assert.match(init.headers['Idempotency-Key'],/^[0-9a-f-]{36}$/);return Response.json({refund:result});}
  };
  await host.registrations.get('blackhole.accountRefund')();await new Promise(r=>setImmediate(r));
  assert.ok(detail.includes('免费体验'));assert.ok(detail.includes('订阅卡'));assert.ok(detail.includes('不足整小时'));assert.ok(detail.includes('¥0.05'));
  assert.ok(host.messages.some(message=>message.includes('已退款 ¥0.05')));assert.ok(actions.includes('refresh'));
  assert.equal(s.calls.filter(call=>call.path.endsWith('/refund')).length,1);
 },{entitlement:async action=>{actions.push(action);return {};}});
});
test('cancelling the local VS Code payment wait never mutates the remote order',{timeout:10000},async()=>{
 await withHost(async host=>{
  const s=server();globalThis.fetch=s.fetch;host.mock.env.openExternal=async value=>s.openExternal(value.toString());await host.registrations.get('blackhole.accountSignIn')();const orderId=randomUUID(),checkout=checkoutUrl(orderId);
  host.mock.env.openExternal=async()=>true;host.mock.window.showQuickPick=async items=>items[0];host.mock.window.showInformationMessage=async text=>{host.messages.push(text);if(text.startsWith('确认购买'))return '前往付款';};
  host.mock.window.withProgress=async(_opts,fn)=>{let cancel;const running=fn({}, {isCancellationRequested:false,onCancellationRequested:cb=>{cancel=cb;return new host.mock.Disposable();}});await new Promise(r=>setImmediate(r));cancel();return running;};
  s.override=async(path,init)=>{if(path==='/api/billing/plans')return Response.json({enabled:true,environment:'sandbox',plans:[{sku:'pro_day',amountMinor:100,currency:'CNY',durationSeconds:86400}]});if(path==='/api/billing/orders'&&init.method==='POST')return Response.json({order:billingOrder(orderId),checkoutUrl:checkout});if(path.endsWith('/reconcile'))return Response.json({order:billingOrder(orderId)});};
  await host.registrations.get('blackhole.accountBuyCard')();assert.ok(!s.calls.some(call=>call.path.endsWith('/cancel')));assert.ok(host.messages.some(message=>message.includes('停止等待')));
 },{entitlement:async()=>({})});
});
test('completed purchase releases the mutex before its passive success toast is dismissed',{timeout:15000},async()=>{
 const actions=[],toast=deferred(),shown=deferred();
 await withHost(async host=>{
  const s=server();globalThis.fetch=s.fetch;host.mock.env.openExternal=async value=>s.openExternal(value.toString());await host.registrations.get('blackhole.accountSignIn')();
  const refreshesBefore=actions.filter(action=>action==='refresh').length;host.mock.env.openExternal=async()=>true;
  const orderIds=[randomUUID(),randomUUID()];let created=0;
  host.mock.window.showQuickPick=async items=>items[0];
  host.mock.window.showInformationMessage=async text=>{
   host.messages.push(text);if(text.startsWith('确认购买'))return '前往付款';
   if(text.includes('已自动叠加到当前账号')){shown.resolve();return toast.promise;}
  };
  s.override=async(path,init)=>{
   if(path==='/api/billing/plans')return Response.json({enabled:true,environment:'sandbox',plans:[{sku:'pro_day',amountMinor:100,currency:'CNY',durationSeconds:86400}]});
   if(path==='/api/billing/orders'&&init.method==='POST'){const id=orderIds[created++];return Response.json({order:billingOrder(id),checkoutUrl:ORIGIN+'/api/billing/checkout#'+new URLSearchParams({order:id,checkout:'E'.repeat(43)})});}
   if(path.endsWith('/reconcile')){const id=path.split('/')[4];return Response.json({order:billingOrder(id,'fulfilled')});}
  };
  const first=host.registrations.get('blackhole.accountBuyCard')();await shown.promise;await new Promise(r=>setImmediate(r));
  const second=host.registrations.get('blackhole.accountBuyCard')();await new Promise(r=>setImmediate(r));
  assert.equal(created,2);assert.ok(!host.messages.some(message=>message.includes('当前购买或订单核对仍在进行')));
  toast.resolve();await Promise.all([first,second]);
  assert.equal(actions.filter(action=>action==='refresh').length,refreshesBefore+2);
 },{entitlement:async action=>{actions.push(action);return {};}});
});
test('an in-flight payment still prevents concurrent purchases and releases after confirmation',{timeout:15000},async()=>{
 const querying=deferred(),payment=deferred();
 await withHost(async host=>{
  const s=server();globalThis.fetch=s.fetch;host.mock.env.openExternal=async value=>s.openExternal(value.toString());await host.registrations.get('blackhole.accountSignIn')();
  host.mock.env.openExternal=async()=>true;host.mock.window.showQuickPick=async items=>items[0];
  host.mock.window.showInformationMessage=async text=>{host.messages.push(text);if(text.startsWith('确认购买'))return '前往付款';};
  const id=randomUUID();let created=0;
  s.override=async(path,init)=>{
   if(path==='/api/billing/plans')return Response.json({enabled:true,environment:'sandbox',plans:[{sku:'pro_day',amountMinor:100,currency:'CNY',durationSeconds:86400}]});
   if(path==='/api/billing/orders'&&init.method==='POST'){created++;return Response.json({order:billingOrder(id),checkoutUrl:ORIGIN+'/api/billing/checkout#'+new URLSearchParams({order:id,checkout:'F'.repeat(43)})});}
   if(path.endsWith('/reconcile')){querying.resolve();await payment.promise;return Response.json({order:billingOrder(id,'fulfilled')});}
  };
  const first=host.registrations.get('blackhole.accountBuyCard')();
  try{await querying.promise;await host.registrations.get('blackhole.accountBuyCard')();assert.equal(created,1);assert.ok(host.messages.some(text=>text.includes('当前购买、订单核对或退款仍在进行')));}
  finally{payment.resolve();await first;}
 });
});
const cardCode='BH1-'+Array(6).fill('A1B2C3D4').join('-');
const redeemed=userId=>({cardId:randomUUID(),userId,grantId:randomUUID(),expiresAt:Math.floor(Date.now()/1000)+2592000,duplicate:false});
test('card redemption sends only code with authenticated bearer, retains no plaintext and does not log in again',async()=>{
 const s=server(),f=client(s);await f.client.signIn();const value=redeemed(s.user);
 s.override=async(path,init,data)=>{if(path.endsWith('/cards/redeem')){assert.deepEqual(Object.keys(data),['code']);assert.equal(init.headers.Authorization,'Bearer '+s.sessions.get(s.user).token);return Response.json(value);}};
 assert.deepEqual(await f.client.redeemCard(cardCode,s.user),value);assert.equal(s.opened.length,1);
 assert.ok(!JSON.stringify([...f.store.vault,...f.store.files]).includes(cardCode));
});
test('card confirmation is pinned to the selected user and refuses account switch before sending',async()=>{
 const s=server(),shared=storage(),a=client(s,shared),b=client(s,shared);await a.client.signIn();const selected=s.user;
 s.user='second-user';await b.client.signIn();const before=s.calls.length;
 await assert.rejects(a.client.redeemCard(cardCode,selected),errorCode('rejected'));assert.equal(s.calls.length,before);
});
test('ambiguous card transport failure is reported separately and never automatically retries',async()=>{
 const s=server(),f=client(s);await f.client.signIn();let attempts=0;
 s.override=async path=>{if(path.endsWith('/cards/redeem')){attempts++;throw new Error('synthetic dropped response');}};
 await assert.rejects(f.client.redeemCard(cardCode,s.user),errorCode('card_result_unknown'));assert.equal(attempts,1);assert.equal(f.store.vault.size,1);
});
test('known card receipt is returned despite later refresh failure; wrong-user receipts are not trusted',async()=>{
 const s=server(),f=client(s);await f.client.signIn();const result=redeemed(s.user);
 s.override=async path=>path.endsWith('/cards/redeem')?Response.json(result):new Response(null,{status:503});
 assert.equal((await f.client.redeemCard(cardCode,s.user)).grantId,result.grantId);assert.equal((await f.client.check()).state,'unavailable');
 s.override=async()=>Response.json({...result,userId:'someone-else'});
 await assert.rejects(f.client.redeemCard(cardCode,s.user),errorCode('card_result_unknown'));
});
test('VS Code redemption asks for a secret input, confirms identity, and explicitly refreshes the daemon gate after success',async()=>{
 const actions=[];
 await withHost(async host=>{
  const s=server();globalThis.fetch=s.fetch;host.mock.env.openExternal=async value=>s.openExternal(value.toString());
  await host.registrations.get('blackhole.accountSignIn')();const before=actions.filter(a=>a==='refresh').length;
  host.mock.window.showInputBox=async options=>{assert.equal(options.password,true);assert.equal(options.validateInput(cardCode),undefined);return cardCode;};
  host.mock.window.showWarningMessage=async(message,options)=>{assert.equal(options.modal,true);assert.ok(message.includes(s.user));return '确认兑换';};
  s.override=async path=>path.endsWith('/cards/redeem')?Response.json(redeemed(s.user)):new Response(null,{status:503});
  await host.registrations.get('blackhole.accountRedeemCard')();await new Promise(r=>setImmediate(r));
  assert.ok(host.messages.some(m=>m.includes('兑换已到账')));assert.ok(actions.filter(a=>a==='refresh').length>before);
  assert.ok(!host.messages.join('').includes(cardCode));assert.ok(!JSON.stringify([...host.files,...host.vault]).includes(cardCode));
 },{entitlement:async action=>{actions.push(action);return {};}});
});

test('billing quote changes request a fresh confirmation, not an uncertain refund retry',async()=>{
 const s=server(),f=client(s);await f.client.signIn();const orderId=randomUUID();
 s.override=async path=>path.endsWith('/refund')?Response.json({error:'refund_quote_changed'},{status:409}):undefined;
 await assert.rejects(f.client.refundBillingOrder(s.user,orderId,'buyer-quote-changed-key',refundQuoteToken),errorCode('refund_quote_changed'));
});
test('expired orders offer reconciliation but never reopen the payment window',async()=>{
 await withHost(async host=>{
  const s=server();globalThis.fetch=s.fetch;host.mock.env.openExternal=async value=>s.openExternal(value.toString());await host.registrations.get('blackhole.accountSignIn')();
  const orderId=randomUUID();let options=[],queries=0;
  host.mock.window.showQuickPick=async items=>{if(typeof items[0]==='string')options=items;return items[0];};
  s.override=async path=>{
   if(path==='/api/billing/orders')return Response.json({orders:[billingOrder(orderId,'expired')]});
   if(path.endsWith('/reconcile')){queries++;return Response.json({order:billingOrder(orderId,'fulfilled')});}
  };
  await host.registrations.get('blackhole.accountOrders')();
  assert.deepEqual(options,['核对支付结果']);assert.equal(queries,1);assert.ok(!s.calls.some(c=>c.path.endsWith('/checkout-link')));
 });
});
test('refund picker can reach the next page without loading unbounded history',async()=>{
 await withHost(async host=>{
  const s=server();globalThis.fetch=s.fetch;host.mock.env.openExternal=async value=>s.openExternal(value.toString());await host.registrations.get('blackhole.accountSignIn')();
  const first=randomUUID(),older=randomUUID(),cursor='1789467000.'+first;let pages=0,quoted='';
  host.mock.window.showQuickPick=async items=>items.find(item=>item.more)||items[0];
  host.mock.window.showInformationMessage=async()=>undefined;
  s.override=async path=>{
   if(path==='/api/billing/refundable-orders'){pages++;return Response.json({orders:[billingOrder(pages===1?first:older,'fulfilled')],nextCursor:pages===1?cursor:null});}
   if(path.endsWith('/refund-quote')){quoted=path;return Response.json({quote:billingRefundQuote(older)});}
  };
  await host.registrations.get('blackhole.accountRefund')();
  assert.equal(pages,2);assert.equal(quoted,'/api/billing/orders/'+older+'/refund-quote');assert.ok(!s.calls.some(c=>c.path.endsWith('/refund')));
 });
});
test('refund uncertainty still refreshes authoritative balance so the reservation is visible',async()=>{
 const actions=[];
 await withHost(async host=>{
  const s=server();globalThis.fetch=s.fetch;host.mock.env.openExternal=async value=>s.openExternal(value.toString());await host.registrations.get('blackhole.accountSignIn')();
  const orderId=randomUUID();host.mock.window.showQuickPick=async items=>items[0];
  host.mock.window.showInformationMessage=async(text,options)=>options?.modal?'确认退款':undefined;
  s.override=async path=>{
   if(path==='/api/billing/refundable-orders')return Response.json({orders:[billingOrder(orderId,'fulfilled')],nextCursor:null});
   if(path.endsWith('/refund-quote'))return Response.json({quote:billingRefundQuote(orderId)});
   if(path.endsWith('/refund'))return Response.json({error:'refund_result_unknown'},{status:503});
  };
  await host.registrations.get('blackhole.accountRefund')();assert.ok(actions.includes('refresh'));
  assert.ok(host.messages.some(m=>m.includes('退款结果暂时无法确认')));
 },{entitlement:async action=>{actions.push(action);return {};}});
});

test('review purchase record directly refunds the selected order with full-unfulfilled explanation and no second picker',async()=>{
 const actions=[];await withHost(async host=>{
  const s=server();globalThis.fetch=s.fetch;host.mock.env.openExternal=async value=>s.openExternal(value.toString());await host.registrations.get('blackhole.accountSignIn')();
  const orderId=randomUUID();let picks=0,detail='';
  host.mock.window.showQuickPick=async items=>{picks++;if(typeof items[0]==='string')assert.deepEqual(items,['申请退款']);return items[0];};
  host.mock.window.showInformationMessage=async(text,options)=>{host.messages.push(text);if(options?.modal){detail=options.detail;return '确认退款';}};
  s.override=async(path,init,data)=>{
   if(path==='/api/billing/orders')return Response.json({orders:[billingOrder(orderId,'review',{paidAt:1789468801})]});
   if(path.endsWith('/refund-quote')){assert.equal(path,'/api/billing/orders/'+orderId+'/refund-quote');return Response.json({quote:billingRefundQuote(orderId,{amountMinor:100,unusedSeconds:86400,refundableSeconds:86400})});}
   if(path.endsWith('/refund')){assert.equal(path,'/api/billing/orders/'+orderId+'/refund');assert.deepEqual(data,{confirmation:'refund',quoteToken:refundQuoteToken});return Response.json({refund:billingRefund(orderId,{amountMinor:100})});}
  };
  await host.registrations.get('blackhole.accountOrders')();assert.equal(picks,2);assert.match(detail,/未交付订单退款/);assert.match(detail,/预计退款：¥1.00/);assert.ok(!s.calls.some(c=>c.path.endsWith('/reconcile')||c.path.endsWith('/refundable-orders')||c.path.endsWith('/checkout-link')));assert.equal(s.calls.filter(c=>c.path.endsWith('/refund')).length,1);assert.ok(actions.includes('refresh'));assert.ok(host.messages.some(m=>m.includes('该订单未交付权益')));
 },{entitlement:async action=>{actions.push(action);return {};}});
});
test('cancelling a review-order refund preview sends no refund or payment reconciliation',async()=>{
 await withHost(async host=>{
  const s=server();globalThis.fetch=s.fetch;host.mock.env.openExternal=async value=>s.openExternal(value.toString());await host.registrations.get('blackhole.accountSignIn')();const orderId=randomUUID();
  host.mock.window.showQuickPick=async items=>items[0];host.mock.window.showInformationMessage=async()=>undefined;
  s.override=async path=>path==='/api/billing/orders'?Response.json({orders:[billingOrder(orderId,'review',{paidAt:1789468801})]}):path.endsWith('/refund-quote')?Response.json({quote:billingRefundQuote(orderId,{amountMinor:100,unusedSeconds:86400,refundableSeconds:86400})}):undefined;
  await host.registrations.get('blackhole.accountOrders')();assert.equal(s.calls.filter(c=>c.path.endsWith('/refund-quote')).length,1);assert.ok(!s.calls.some(c=>c.path.endsWith('/refund')||c.path.endsWith('/reconcile')));
 });
});

test('pending review refund explains original-request recovery without claiming nonexistent rights were frozen',async()=>{
 await withHost(async host=>{
  const s=server();globalThis.fetch=s.fetch;host.mock.env.openExternal=async value=>s.openExternal(value.toString());await host.registrations.get('blackhole.accountSignIn')();const orderId=randomUUID();let detail='';
  host.mock.window.showQuickPick=async items=>items[0];host.mock.window.showInformationMessage=async(text,options)=>{if(options?.modal){detail=options.detail;return '确认退款';}};
  s.override=async path=>path==='/api/billing/orders'?Response.json({orders:[billingOrder(orderId,'review',{paidAt:1789468801})]}):path.endsWith('/refund-quote')?Response.json({quote:billingRefundQuote(orderId,{amountMinor:100,unusedSeconds:86400,refundableSeconds:86400,existingStatus:'requested'})}):path.endsWith('/refund')?Response.json({refund:billingRefund(orderId,{amountMinor:100,status:'requested',providerConfirmedAt:null,finalizedAt:null})}):undefined;
  await host.registrations.get('blackhole.accountOrders')();assert.match(detail,/本次将核对同一笔退款/);assert.doesNotMatch(detail,/冻结|权益恢复/);assert.ok(host.messages.some(m=>m.includes('退款请求已保留')&&m.includes('尚未交付权益')&&!m.includes('冻结')));
 });
});


// ─── plan 6.11: daemon-owned account, same UI ─────────────────────────────
const until=async(fn,ms=3000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,20));}assert.fail('condition not met');};
function seedLocalLogin(host,over={}){
 const {createHash}=require('node:crypto'),origin=cloudEnvironment.PRODUCTION_CLOUD_ORIGIN;
 const value={token:'bhp_'+'b'.repeat(43),userId:'local_user',clientId:'SYNTHETIC-CLIENT-ID-0001',sessionId:'33333333-2222-4333-8444-555555555555',expiresAt:Math.floor(Date.now()/1000)+3600,loginOrder:4,...over};
 host.vault.set(cloudEnvironment.cloudAuthPrefix(origin)+'.session.'+value.sessionId,JSON.stringify(value));
 const receipt={version:1,origin,loginOrder:value.loginOrder,sessionId:value.sessionId,kind:'login'};
 const dir='/SYNTHETIC-EXTENSION-STORAGE/cloud-auth-v1/'+createHash('sha256').update(origin).digest('hex');
 host.files.set(dir+'/'+core.receiptName(receipt,origin),Buffer.from(JSON.stringify(receipt)));
 return value;
}
function daemonBridge(over={}){
 const log={migrate:[],calls:[],entitlement:[],signIn:0,cancel:0};let state='idle';
 const bridge={
  entitlement:async action=>{log.entitlement.push(action);return {daemon_id:'d1',pending:null};},
  health:async()=>({ok:true,daemon_id:'d1',account_api_version:1,account_storage:'available',cloud_origin:cloudEnvironment.PRODUCTION_CLOUD_ORIGIN,...over.health}),
  account:async()=>({state:'saved',userId:'daemon_user'}),
  accountMigrate:async credential=>{log.migrate.push(credential);return {migrated:true};},
  accountCall:async(method)=>{log.calls.push(method);if(over.callError)throw over.callError;return {result:{state:'saved',userId:'daemon_user',expiresAt:Math.floor(Date.now()/1000)+3600}};},
  accountSignIn:async()=>{log.signIn++;state='running';setTimeout(()=>{if(state==='running')state='done';},over.signInMs??50);return {state};},
  accountSignInState:async()=>({state}),
  accountSignInCancel:async()=>{log.cancel++;state='idle';return {state};},
 };
 return {bridge,log};
}

test('daemon account: an existing VS Code login moves to the daemon once, the UI reads the daemon',async()=>{
 const {bridge,log}=daemonBridge();
 await withHost(async host=>{
  const local=seedLocalLogin(host);host.reload();
  await until(()=>host.views.some(v=>v.userId==='daemon_user'));
  assert.equal(log.migrate.length,1);assert.equal(log.migrate[0].sessionId,local.sessionId);assert.equal(log.migrate[0].clientId,local.clientId);
  assert.ok([...host.globalState.keys()].some(k=>k.startsWith('blackhole.account.migrated.')));
  assert.ok(host.vault.size>=1,'local copy stays as a backup');
  assert.deepEqual(log.entitlement,[],'the daemon proves entitlement itself; no bridge traffic');
  host.reload();await until(()=>log.calls.length>3);
  assert.equal(log.migrate.length,1,'never migrates twice');
  await host.registrations.get('blackhole.accountSignOut')();
  assert.ok(log.calls.includes('signOut'));
 },bridge);
});

test('daemon account: a fresh install with no local login marks migration done without sending anything',async()=>{
 const {bridge,log}=daemonBridge();
 await withHost(async host=>{
  await until(()=>host.views.some(v=>v.userId==='daemon_user'));
  assert.equal(log.migrate.length,0);
  assert.ok([...host.globalState.keys()].some(k=>k.startsWith('blackhole.account.migrated.')));
 },bridge);
});

test('daemon account: an older daemon or an unavailable OS store keeps the local login working',async()=>{
 for(const health of [{account_api_version:undefined},{account_storage:'unavailable'},{cloud_origin:'https://other.blackhole-fixture.org'}]){
  const {bridge,log}=daemonBridge({health});
  await withHost(async host=>{
   globalThis.fetch=async()=>{throw new TypeError('offline');};
   seedLocalLogin(host);host.reload();
   await until(()=>host.views.some(v=>v.userId==='local_user'),8000);
   assert.equal(log.migrate.length,0,JSON.stringify(health));assert.equal(log.calls.length,0);
  },bridge);
 }
});

test('daemon account: daemon unreachable during migration falls back to the local login and retries later',async()=>{
 const {bridge,log}=daemonBridge();bridge.accountMigrate=async()=>{log.migrate.push('x');const e=new Error('fetch failed');throw e;};
 await withHost(async host=>{
  globalThis.fetch=async()=>{throw new TypeError('offline');};
  seedLocalLogin(host);host.reload();
  await until(()=>host.views.some(v=>v.userId==='local_user'),8000);
  assert.ok(![...host.globalState.keys()].some(k=>k.startsWith('blackhole.account.migrated.')),'not marked, so it retries');
 },bridge);
});

test('daemon account: sign-in waits for the daemon and cancel reaches it; errors keep the same codes',async()=>{
 const {DaemonAuthClient,toAuthError}=require('../../../.cache/vscode-auth-verify/packages/vscode/src/daemonAccount.js');
 const ok=daemonBridge();const view=await new DaemonAuthClient(ok.bridge).signIn();assert.equal(view.userId,'daemon_user');
 const slow=daemonBridge({signInMs:60_000}),abort=new AbortController();
 const pending=new DaemonAuthClient(slow.bridge).signIn(abort.signal);setTimeout(()=>abort.abort(),30);
 await assert.rejects(pending,errorCode('cancelled'));assert.equal(slow.log.cancel,1);
 assert.equal(toAuthError(new Error('storage_unavailable')).code,'storage');
 assert.equal(toAuthError(new Error('rate_limited')).code,'rate_limited');
 assert.equal(toAuthError(new TypeError('fetch failed')).code,'network');
 const bad=daemonBridge({callError:Object.assign(new Error('card_unavailable'),{status:502})});
 await assert.rejects(new DaemonAuthClient(bad.bridge).redeemCard('BH1','u'),errorCode('card_unavailable'));
});

test('same-account sign-in: another account is discarded, ended on the server and never replaces the saved login',async()=>{
 const s=server(),f=client(s);s.user='user_a';assert.equal((await f.client.signIn()).state,'verified');
 const before=(await f.client.gateIdentity());assert.equal(before.userId,'user_a');
 s.user='user_b';await assert.rejects(f.client.signIn(undefined,'user_a'),errorCode('account_mismatch'));
 const after=await f.client.gateIdentity();assert.equal(after.userId,'user_a');assert.equal(after.sessionId,before.sessionId);
 assert.ok(s.calls.some(c=>c.path.endsWith('/logout')),'the stray user_b session is ended');
 s.user='user_a';assert.equal((await f.client.signIn(undefined,'user_a')).state,'verified','the same account is accepted');
});
