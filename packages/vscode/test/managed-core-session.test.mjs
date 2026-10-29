import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildSync } from 'esbuild';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-managed-session-'));
const bundle = path.join(temp, 'session.cjs');
buildSync({entryPoints:[fileURLToPath(new URL('../src/managedCoreSession.ts', import.meta.url))],outfile:bundle,bundle:true,platform:'node',format:'cjs',logLevel:'silent'});
const { ManagedCoreSession } = createRequire(import.meta.url)(bundle);
process.on('exit', () => fs.rmSync(temp, { recursive: true, force: true }));
const pending = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise,resolve}; };
const tick = () => new Promise(r => setImmediate(r));
function setup(t, custom = {}) {
 const client = {clientId:'vscode:fixture',clientInstanceId:randomUUID(),kind:'vscode',version:'9.0',protocol:{min:1,max:1},capabilities:['web-ui']};
 const receipt = {protocolVersion:1,instanceKey:'a'.repeat(64),daemonId:'daemon-fixture',daemonVersion:'1.0',runtimeKind:'standalone-node',uiVersion:'web',configRevision:0,localUrl:'http://127.0.0.1:17306/ui/',webApiBase:'../web-api/v1/',capabilities:['web-ui'],runtimeId:'core',runtimeVersion:'1.0',buildId:'build',descriptorHash:'b'.repeat(64),dataRootId:'a'.repeat(64),webBuildId:'web',coreProtocol:{min:1,max:1},environment:'test',cloudOrigin:'https://test.invalid',lifecycleState:'managed',startFingerprint:'fingerprint'};
 const lease = {schemaVersion:1,leaseId:randomUUID(),clientId:client.clientId,clientInstanceId:client.clientInstanceId,kind:'vscode',runtimeId:receipt.runtimeId,buildId:receipt.buildId,descriptorHash:receipt.descriptorHash,dataRootId:receipt.dataRootId,daemonId:receipt.daemonId,issuedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+45000).toISOString()};
 const attachment = {receipt,lease,spawned:false};
 const calls = [], lostReasons = []; let lost = 0;
 const invoke = async request => {
  calls.push(request);
  if(custom.invoke) return custom.invoke(request,attachment);
  if(request.command==='attach-or-start') return structuredClone(attachment);
  if(request.command==='heartbeat') return {...lease,expiresAt:new Date(Date.now()+45000).toISOString()};
  return {};
 };
 const session = new ManagedCoreSession({invoke,client,...(custom.seedless ? {} : {seedArchive:'not-read-by-adapter.zip'}),
  bootstrap:custom.bootstrap ? port=>custom.bootstrap(port,attachment) : undefined,reconnectAfterUpgrade:custom.reconnectAfterUpgrade,
  environment:'test',cloudOrigin:receipt.cloudOrigin,resolvePort:custom.resolvePort,onReady:custom.onReady,dataRootId:custom.dataRootId,onLost(reason){lost++;lostReasons.push(reason)}});
 t.after(()=>session.close());
 return {session,calls,attachment,client,get lost(){return lost},get lostReasons(){return lostReasons}};
}

// Stub transport only: accepting the product port must not touch the real Core.
test('Test accepts 7306 but still validates its signed runtime channel',async t=>{
 const h=setup(t,{invoke:async(q,a)=>q.command==='attach-or-start'?{...a,receipt:{...a.receipt,localUrl:'http://127.0.0.1:7306/ui/'}}:{}});
 assert.equal((await h.session.attach(7306)).localUrl,'http://127.0.0.1:7306/ui/');
 assert.equal(h.calls[0].request.port,7306);
 const wrong=setup(t,{invoke:async(q,a)=>q.command==='attach-or-start'?{...a,receipt:{...a.receipt,localUrl:'http://127.0.0.1:7306/ui/',environment:'production'}}:{}});
 await assert.rejects(wrong.session.attach(7306),/managed_receipt_mismatch/);
});

test('a saved 7306 endpoint is accepted without replacing it with a Test default',async t=>{
 const h=setup(t,{resolvePort:async()=>7306,invoke:async(q,a)=>q.command==='attach-or-start'?{...a,receipt:{...a.receipt,localUrl:'http://127.0.0.1:7306/ui/'}}:{}});
 await h.session.attach(17306);
 assert.equal(h.calls[0].request.port,7306);
 assert.equal(h.calls[1].request.port,7306);
});

test('concurrent attach coalesces; Core version is independent of extension version; close only detaches',async t=>{
 const h=setup(t);const first=h.session.attach(17306), second=h.session.attach(17306);
 assert.equal(first,second);assert.equal((await first).daemonVersion,'1.0');
 assert.deepEqual(h.calls.map(x=>x.command),['ensure-core','attach-or-start']);
 assert.equal((await h.session.attach(17306)).daemonId,'daemon-fixture');
 await h.session.close();await h.session.close();
 assert.equal(h.calls.filter(x=>x.command==='detach').length,1);
 assert.ok(!h.calls.some(x=>['stop','shutdown','activate','write-lease'].includes(x.command)));
});

test('full host startup publishes only the post-bootstrap receipt without a separate update command',async t=>{
 const ready=[];
 const h=setup(t,{bootstrap:async(port,a)=>{const next=replacement(a);next.receipt.runtimeVersion='1.1.0';return {state:'updated',targetVersionName:'1.1.0-new',attachment:next}},onReady:r=>ready.push(r.runtimeVersion)});
 const result=await h.session.attach(17306);
 assert.equal(result.runtimeVersion,'1.1.0');assert.deepEqual(ready,['1.1.0']);
 assert.deepEqual(h.calls,[],'ensure/attach must not precede the complete bundled startup');
 assert.equal(h.session.startupUpdateState,'updated');
});
test('a lost peer lease can rebind only through the Manager committed-upgrade command, never a fresh spawn',async t=>{
 const h=setup(t,{reconnectAfterUpgrade:true,invoke:async(q,a)=>{
  if(q.command==='attach-or-start')return a;
  if(q.command==='heartbeat')throw Error('lease_missing');
  if(q.command==='reconnect-core')return {...replacement(a),spawned:false};
  return {};
 }});
 const old=await h.session.attach(17306);await h.session.renew();
 assert.notEqual(h.session.receipt.daemonId,old.daemonId);
 assert.equal(h.lost,0);
 assert.deepEqual(h.calls.map(q=>q.command),['ensure-core','attach-or-start','heartbeat','reconnect-core']);
});
test('unproven peer replacement remains a lease loss rather than automatic adoption',async t=>{
 const h=setup(t,{reconnectAfterUpgrade:true,invoke:async(q,a)=>{
  if(q.command==='attach-or-start')return a;
  if(q.command==='heartbeat')throw Error('lease_missing');
  if(q.command==='reconnect-core')throw Error('core_reconnect_unproven');
  return {};
 }});
 await h.session.attach(17306);await h.session.renew();
 assert.equal(h.session.receipt,undefined);assert.equal(h.lost,1);
 assert.equal(h.calls.filter(q=>q.command==='attach-or-start').length,1);
});

test('seedless VS Code bridge asks only to reuse the signed shared Core and never supplies a runtime path',async t=>{
 const h=setup(t,{seedless:true});
 await h.session.attach(17306);
 assert.deepEqual(h.calls.map(x=>x.command),['ensure-core','attach-or-start']);
 assert.deepEqual(h.calls[0].request,{client:h.client,port:17306});
});
test('renew verifies the original lease; simultaneous renewals coalesce',async t=>{
 const h=setup(t);await h.session.attach(17306);
 const a=h.session.renew(),b=h.session.renew();assert.equal(a,b);await a;
 assert.equal(h.calls.filter(x=>x.command==='heartbeat').length,1);assert.equal(h.lost,0);
});
test('failed heartbeat detaches and does not schedule a restart or adopt another daemon',async t=>{
 const h=setup(t,{invoke:async(q,a)=>{if(q.command==='attach-or-start')return a;if(q.command==='heartbeat')throw Error('core_identity_conflict');return{}}});
 await h.session.attach(17306);await h.session.renew();await h.session.renew();
 assert.equal(h.session.receipt,undefined);assert.equal(h.lost,1);
 assert.deepEqual(h.calls.map(x=>x.command),['ensure-core','attach-or-start','heartbeat','detach']);
});
test('ambiguous attach failure never retries or falls back',async t=>{
 const h=setup(t,{invoke:async q=>{if(q.command==='attach-or-start')throw Error('timeout_unknown_outcome');return{}}});
 await assert.rejects(h.session.attach(17306),/timeout_unknown_outcome/);
 await tick();assert.deepEqual(h.calls.map(x=>x.command),['ensure-core','attach-or-start']);
});
test('close racing successful attach detaches the late lease without starting a timer',async t=>{
 const gate=pending();const h=setup(t,{invoke:async(q,a)=>{if(q.command==='attach-or-start'){await gate.promise;return a}return{}}});
 const start=h.session.attach(17306);const rejection=assert.rejects(start,/managed_client_disposed/);await tick();
 const close=h.session.close();gate.resolve();await close;await rejection;
 assert.equal(h.session.receipt,undefined);assert.equal(h.calls.filter(x=>x.command==='detach').length,1);
});
test('close waits for heartbeat before detach and cannot resurrect the lease',async t=>{
 const gate=pending();const h=setup(t,{invoke:async(q,a)=>{if(q.command==='attach-or-start')return a;if(q.command==='heartbeat'){await gate.promise;return a.lease}return{}}});
 await h.session.attach(17306);const renew=h.session.renew();const close=h.session.close();gate.resolve();await Promise.all([renew,close]);
 assert.equal(h.session.receipt,undefined);assert.deepEqual(h.calls.slice(-2).map(x=>x.command),['heartbeat','detach']);
});
test('foreign receipt or another window lease is rejected',async t=>{
 const h=setup(t,{invoke:async(q,a)=>q.command==='attach-or-start'?{...a,lease:{...a.lease,clientInstanceId:randomUUID()}}:{}});
 await assert.rejects(h.session.attach(17306),/managed_receipt_mismatch/);assert.equal(h.session.receipt,undefined);
});
test('heartbeat cannot replace the bound lease with another daemon',async t=>{
 const h=setup(t,{invoke:async(q,a)=>q.command==='attach-or-start'?a:q.command==='heartbeat'?{...a.lease,daemonId:'other'}:{}});
 await h.session.attach(17306);await h.session.renew();assert.equal(h.lost,1);assert.equal(h.session.receipt,undefined);
});
test('client rejects invalid ports and live port changes without stopping Core',async t=>{
 const h=setup(t);await assert.rejects(h.session.attach(65536),/port_invalid/);assert.equal(h.calls.length,0);
 await h.session.attach(17306);await assert.rejects(h.session.attach(17307),/managed_port_change/);assert.equal(h.calls.length,2);
});
test('health requires the complete receipt identity and a live lease, not extension version',async t=>{
 const h=setup(t);const r=await h.session.attach(17306);
 const health={ok:true,lifecycle_state:'managed',daemon_id:r.daemonId,version:r.daemonVersion,runtime_id:r.runtimeId,runtime_version:r.runtimeVersion,build_id:r.buildId,descriptor_hash:r.descriptorHash,data_root_id:r.dataRootId,web_build_id:r.webBuildId,core_environment:r.environment,core_cloud_origin:r.cloudOrigin,cloud_origin:r.cloudOrigin,start_fingerprint:r.startFingerprint,core_protocol:r.coreProtocol};
 assert.equal(h.session.matchesHealth(health),true);
 for(const key of ['daemon_id','descriptor_hash','data_root_id','start_fingerprint','cloud_origin','web_build_id'])assert.equal(h.session.matchesHealth({...health,[key]:'wrong'}),false,key);
 await h.session.close();assert.equal(h.session.matchesHealth(health),false);
});
function replacement(a){const next=structuredClone(a);next.receipt.daemonId='replacement';next.receipt.startFingerprint='replacement-fingerprint';next.lease.daemonId=next.receipt.daemonId;next.lease.leaseId=randomUUID();next.spawned=true;return next}
test('one temporarily unavailable Manager heartbeat does NOT discard a still-live VS Code lease', async t => {
 const h=setup(t,{invoke:(()=>{let attempts=0;return async(q,a)=>{
   if(q.command==='attach-or-start')return a;
   if(q.command==='heartbeat') {if(++attempts===1)throw Error('lock_busy');return {...a.lease,expiresAt:new Date(Date.now()+45_000).toISOString()};}
   return {};
 };})()});
 const receipt=await h.session.attach(17306);
 await h.session.renew();
 assert.equal(h.session.bindingState,'renewal_unconfirmed');
 assert.equal(h.session.receipt?.daemonId,receipt.daemonId,'original receipt retained only until expiry');
 assert.equal(h.lost,0,'transient lock cannot trigger onLost');
 assert.equal(h.calls.filter(c=>c.command==='detach').length,0);
 await h.session.renew();
 assert.equal(h.session.bindingState,'bound');
 assert.equal(h.lost,0);
 assert.deepEqual(h.calls.filter(c=>c.command==='heartbeat').length,2);
});
test('Manager timeout retries the SAME lease handle, never provisions or adopts another Core',async t=>{
 let heartbeats=0;const h=setup(t,{invoke:async(q,a)=>{
   if(q.command==='attach-or-start')return a;
   if(q.command==='heartbeat'){heartbeats++;if(heartbeats===1)throw Error('shared_core_manager_timeout');return {...a.lease,expiresAt:new Date(Date.now()+45_000).toISOString()};}
   return {};
 }});
 await h.session.attach(17306);
 await h.session.renew();
 assert.equal(h.session.bindingState,'renewal_unconfirmed');
 await h.session.renew();
 assert.equal(h.session.bindingState,'bound');
 const handles=h.calls.filter(c=>c.command==='heartbeat').map(c=>c.request.handle);
 assert.deepEqual(handles[0],handles[1]);
 assert.deepEqual(h.calls.map(x=>x.command),['ensure-core','attach-or-start','heartbeat','heartbeat']);
});
test('temporary missing Core health is not a proven identity conflict: retry original lease',async t=>{
 let tries=0;
 const h=setup(t,{invoke:async(q,a)=>{
  if(q.command==='attach-or-start')return a;
  if(q.command==='heartbeat'){
   if(++tries===1)throw Error('daemon_state_unknown');
   return {...a.lease,expiresAt:new Date(Date.now()+45_000).toISOString()};
  }
  return {};
 }});
 await h.session.attach(17306);
 const original=h.attachment.lease.leaseId;
 await h.session.renew();
 assert.equal(h.session.bindingState,'renewal_unconfirmed');
 assert.equal(h.lost,0);
 assert.equal(h.calls.filter(x=>x.command==='detach').length,0);
 await h.session.renew();
 assert.equal(h.session.bindingState,'bound');
 assert.equal(h.lost,0);
 const handles=h.calls.filter(x=>x.command==='heartbeat').map(x=>x.request.handle.leaseId);
 assert.deepEqual(handles,[original,original]);
});

test('definitive signed Core identity conflict loses the lease with a diagnosable reason',async t=>{
 const h=setup(t,{invoke:async(q,a)=>{
  if(q.command==='attach-or-start')return a;
  if(q.command==='heartbeat')throw Error('core_identity_conflict');
  return {};
 }});
 await h.session.attach(17306);
 await h.session.renew();
 assert.equal(h.session.bindingState,'unbound');
 assert.deepEqual(h.lostReasons,['core_identity_conflict']);
});

test('unconfirmed renewal never outlives its trusted lease deadline',async t=>{
 const h=setup(t,{invoke:async(q,a)=>q.command==='attach-or-start' && q.request.existingFingerprint
   ? Promise.reject(Error('daemon_state_unknown'))
   : q.command==='attach-or-start'?a:q.command==='heartbeat'?Promise.reject(Error('lock_busy')):{}});
 await h.session.attach(17306);
 await h.session.renew();
 assert.equal(h.session.bindingState,'renewal_unconfirmed');
 h.session.attachment.lease.expiresAt=new Date(Date.now()-100).toISOString();
 assert.equal(h.session.bindingState,'lease_expired');
 await h.session.renew();
 assert.equal(h.session.bindingState,'unbound');
 assert.equal(h.lost,1);
 assert.equal(h.calls.filter(c=>c.command==='detach').length,1);
 await h.session.renew();
 assert.equal(h.lost,1);
});

test('expired lease recovery retries only a fingerprint-pinned attach after transient Manager lock contention',async t=>{
 let pinnedAttempts=0;
 const h=setup(t,{invoke:async(q,a)=>{
   if(q.command==='attach-or-start'&&!q.request.existingFingerprint)return a;
   if(q.command==='attach-or-start'){
     if(++pinnedAttempts===1)throw Error('lock_busy');
     const next=structuredClone(a);next.lease.leaseId=randomUUID();
     next.lease.expiresAt=new Date(Date.now()+45_000).toISOString();
     return next;
   }
   return {};
 }});
 await h.session.attach(17306);
 h.session.attachment.lease.expiresAt=new Date(Date.now()-1000).toISOString();
 await h.session.renew();
 assert.equal(h.lost,0);
 assert.equal(h.session.bindingState,'lease_expired');
 assert.equal(h.calls.filter(x=>x.command==='ensure-core').length,1);
 await h.session.renew();
 assert.equal(h.lost,0);
 assert.equal(h.session.bindingState,'bound');
 assert.equal(pinnedAttempts,2);
 assert.equal(h.calls.filter(x=>x.command==='attach-or-start').every((x,i)=>i===0||x.request.existingFingerprint==='fingerprint'),true);
 assert.equal(h.calls.filter(x=>x.command==='ensure-core').length,1);
});
test('wake from long sleep rebinds only the exact running Core without re-provisioning or restarting', async t => {
 let attaches=0;
 const h=setup(t,{invoke:async(q,a)=>{
   if(q.command==='attach-or-start'){
     if(++attaches===1)return a;
     const rebound=structuredClone(a);
     rebound.lease.leaseId=randomUUID();
     rebound.lease.expiresAt=new Date(Date.now()+45_000).toISOString();
     return rebound;
   }
   if(q.command==='heartbeat')throw Error('lease_expired');
   return {};
 }});
 const original=await h.session.attach(17306);
 h.session.attachment.lease.expiresAt=new Date(Date.now()-60_000).toISOString();
 await h.session.renew();
 assert.equal(h.session.bindingState,'bound');
 assert.equal(h.session.receipt.daemonId,original.daemonId);
 assert.equal(h.lost,0);
 assert.deepEqual(h.calls.map(x=>x.command),['ensure-core','attach-or-start','attach-or-start']);
 assert.equal(h.calls.at(-1).request.existingFingerprint,original.startFingerprint);
 assert.equal(h.calls.at(-1).request.port,17306);
 assert.equal(h.calls.at(-1).request.client.clientInstanceId,h.client.clientInstanceId);
});

test('successful expiry recovery schedules the following heartbeat instead of silently losing the lease again',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 let rebound;
 const h=setup(t,{invoke:async(q,a)=>{
   if(q.command==='attach-or-start') {
     if(!q.request.existingFingerprint)return a;
     rebound=structuredClone(a);rebound.lease.leaseId=randomUUID();
     rebound.lease.expiresAt=new Date(Date.now()+45_000).toISOString();return rebound;
   }
   if(q.command==='heartbeat')return {...rebound.lease,expiresAt:new Date(Date.now()+45_000).toISOString()};
   return {};
 }});
 await h.session.attach(17306);
 h.session.attachment.lease.expiresAt=new Date(Date.now()-1).toISOString();
 await h.session.renew();
 t.mock.timers.tick(15000);await tick();
 assert.equal(h.calls.filter(q=>q.command==='heartbeat').length,1,'rebound must continue automatic renewals');
 assert.equal(h.session.bindingState,'bound');
});

test('long-idle lease recovery refuses any new daemon or changed signed fingerprint',async t=>{
 const h=setup(t,{invoke:async(q,a)=>q.command==='attach-or-start' && !q.request.existingFingerprint
   ? a : q.command==='attach-or-start' ? replacement(a) : {}});
 await h.session.attach(17306);
 h.session.attachment.lease.expiresAt=new Date(Date.now()-100).toISOString();
 await h.session.renew();
 assert.equal(h.session.bindingState,'unbound');
 assert.deepEqual(h.lostReasons,['lease_expired_rebind_unconfirmed']);
 assert.equal(h.calls.filter(x=>x.command==='attach-or-start').length,2);
 assert.equal(h.calls.filter(x=>x.command==='ensure-core').length,1);
 assert.equal(h.calls.filter(x=>x.command==='detach').length,2,'release only own leases, never stop daemon');
});

test('unknown result of pinned rebind does not retry a spawn or claim a live lease',async t=>{
 const h=setup(t,{invoke:async(q,a)=>q.command==='attach-or-start' && !q.request.existingFingerprint
   ? a : q.command==='attach-or-start' ? Promise.reject(Error('daemon_state_unknown')) : {}});
 await h.session.attach(17306);
 h.session.attachment.lease.expiresAt=new Date(Date.now()-100).toISOString();
 await h.session.renew();
 assert.equal(h.session.bindingState,'unbound');
 assert.equal(h.lost,1);
 await h.session.renew();
 assert.deepEqual(h.calls.map(x=>x.command),['ensure-core','attach-or-start','attach-or-start','detach']);
});
test('bundled Core upgrade uses the current client lease and verifies the new signed incarnation',async t=>{
  const targetHash='c'.repeat(64);
  const h=setup(t,{invoke:async(q,a)=>{
    if(q.command==='attach-or-start')return a;
    if(q.command==='upgrade-core'){
      const upgraded=replacement(a);
      upgraded.receipt.descriptorHash=targetHash;
      upgraded.receipt.runtimeVersion='0.4.5';
      upgraded.receipt.daemonVersion='0.4.5';
      upgraded.receipt.buildId='new-build';
      upgraded.lease.descriptorHash=targetHash;
      upgraded.lease.buildId='new-build';
      return {operation:'upgrade',requestId:q.request.requestId,state:'committed',
        fromVersionName:'1.0-build',targetVersionName:q.request.targetVersionName,attachment:upgraded};
    }
    return {};
  }});
  const original=await h.session.attach(17306);
  const result=await h.session.upgradeCore('0.4.5-new-build',targetHash);
  assert.equal(result.state,'committed');
  assert.equal(h.session.receipt.runtimeVersion,'0.4.5');
  assert.notEqual(h.session.receipt.daemonId,original.daemonId);
  const calls=h.calls.filter(x=>x.command==='upgrade-core');
  assert.equal(calls.length,1);
  assert.equal(calls[0].request.confirmed,true);
  assert.equal(calls[0].request.handle.daemonId,original.daemonId);
  assert.equal(calls[0].request.client.clientInstanceId,h.client.clientInstanceId);
  assert.equal(h.lost,0);
  assert.equal(h.calls.filter(x=>x.command==='attach-or-start').length,1,'upgrade may not spawn through a second attach');
});
test('active Desktop lease rejects an upgrade without losing the original renewable Core',async t=>{
  const h=setup(t,{invoke:async(q,a)=>{
    if(q.command==='attach-or-start')return a;
    if(q.command==='upgrade-core')throw Error('active_clients');
    if(q.command==='heartbeat')return {...a.lease,expiresAt:new Date(Date.now()+45_000).toISOString()};
    return {};
  }});
  const before=await h.session.attach(17306);
  await assert.rejects(h.session.upgradeCore('0.4.5-new','c'.repeat(64)),/active_clients/);
  await h.session.renew();
  assert.equal(h.session.receipt.daemonId,before.daemonId);
  assert.equal(h.session.bindingState,'bound');
  assert.equal(h.lost,0);
  assert.equal(h.calls.filter(x=>x.command==='upgrade-core').length,1);
});
test('peer signing incompatibility is a known pre-stop refusal and retains the original lease',async t=>{
 const h=setup(t,{invoke:async(q,a)=>{
  if(q.command==='attach-or-start')return a;
  if(q.command==='upgrade-core')throw Error('peer_core_update_required');
  if(q.command==='heartbeat')return {...a.lease,expiresAt:new Date(Date.now()+45_000).toISOString()};
  return {};
 }});
 const before=await h.session.attach(17306);
 await assert.rejects(h.session.upgradeCore('0.4.7-next','c'.repeat(64)),/^Error: peer_core_update_required$/);
 await h.session.renew();
 assert.equal(h.session.bindingState,'bound');assert.equal(h.session.receipt.daemonId,before.daemonId);
 assert.equal(h.lost,0);assert.equal(h.calls.filter(q=>q.command==='upgrade-core').length,1);
});

test('unknown upgrade result becomes a sticky inspection case without a repeated signed Stop',async t=>{
  const h=setup(t,{invoke:async(q,a)=>{
    if(q.command==='attach-or-start')return a;
    if(q.command==='upgrade-core')throw Error('shared_core_manager_timeout');
    return {};
  }});
  await h.session.attach(17306);
  await assert.rejects(h.session.upgradeCore('0.4.5-new','c'.repeat(64)),/maintenance_outcome_requires_inspection/);
  assert.equal(h.session.bindingState,'maintenance_unknown');
  assert.deepEqual(h.lostReasons,['maintenance_outcome_requires_inspection']);
  await assert.rejects(h.session.upgradeCore('0.4.5-new','c'.repeat(64)),/inspection/);
  assert.equal(h.calls.filter(x=>x.command==='upgrade-core').length,1);
});
test('no successful attach is distinguishable from a positive foreign-identity mismatch',async t=>{
 const h=setup(t,{invoke:async(q,a)=>{if(q.command==='attach-or-start')throw Error('bundled_core_update_required');return{}}});
 assert.equal(h.session.bindingState,'unbound');
 await assert.rejects(h.session.attach(17306),/bundled_core_update_required/);
 await tick();
 assert.equal(h.session.bindingState,'unbound');
 assert.equal(h.session.receipt,undefined);
});
test('confirmed stop uses one bound Manager transaction and never legacy shutdown',async t=>{
 const h=setup(t,{invoke:async(q,a)=>q.command==='attach-or-start'?a:q.command==='maintain-core'?{operation:'stop',stopped:true,requestId:q.request.requestId}:{}});
 await h.session.attach(17306);await assert.rejects(h.session.maintain('stop',false),/confirmation/);
 const result=await h.session.maintain('stop',true);assert.equal(result.stopped,true);assert.equal(h.session.receipt,undefined);
 const calls=h.calls.filter(c=>c.command==='maintain-core');assert.equal(calls.length,1);assert.equal(calls[0].request.handle.daemonId,h.attachment.receipt.daemonId);assert.equal(calls[0].request.confirmed,true);
 await h.session.close();assert.equal(h.calls.filter(c=>c.command==='detach').length,0);
});
test('restart validates a fresh incarnation of the same pinned Core and detaches only its new lease',async t=>{
 let next;const h=setup(t,{invoke:async(q,a)=>{if(q.command==='attach-or-start')return a;if(q.command==='maintain-core'){next=replacement(a);return{operation:'restart',stopped:true,requestId:q.request.requestId,attachment:next}}return{}}});
 await h.session.attach(17306);await h.session.maintain('restart',true);assert.equal(h.session.receipt.daemonId,'replacement');
 await h.session.close();assert.equal(h.calls.at(-1).handle.leaseId,next.lease.leaseId);
});
test('known busy refusal retains receipt and renewal without automatic mutation retry',async t=>{
 const h=setup(t,{invoke:async(q,a)=>{if(q.command==='attach-or-start')return a;if(q.command==='maintain-core')throw Error('active_clients');if(q.command==='heartbeat')return a.lease;return{}}});
 await h.session.attach(17306);await assert.rejects(h.session.maintain('stop',true),/active_clients/);await tick();await h.session.renew();
 assert.equal(h.session.receipt.daemonId,'daemon-fixture');assert.equal(h.lost,0);assert.equal(h.calls.filter(c=>c.command==='maintain-core').length,1);
});
test('unknown maintenance is sticky: no renew, attach or blind retry; original binding only on close',async t=>{
 const h=setup(t,{invoke:async(q,a)=>{if(q.command==='attach-or-start')return a;if(q.command==='maintain-core')throw Error('shared_core_manager_timeout');return{}}});
 await h.session.attach(17306);await assert.rejects(h.session.maintain('restart',true),/maintenance_outcome_requires_inspection:/);await tick();
 assert.equal(h.session.receipt,undefined);assert.ok(h.session.maintenanceRequestId);assert.equal(h.lost,1);
 await h.session.renew();await assert.rejects(h.session.attach(17306),/inspection/);await assert.rejects(h.session.maintain('restart',true),/inspection/);
 assert.equal(h.calls.filter(c=>c.command==='maintain-core').length,1);assert.equal(h.calls.filter(c=>c.command==='heartbeat').length,0);
 await h.session.close();assert.equal(h.calls.at(-1).handle.daemonId,'daemon-fixture');
});
test('close waits for maintenance and detaches late replacement rather than resurrecting renewal',async t=>{
 const gate=pending();let next;const h=setup(t,{invoke:async(q,a)=>{if(q.command==='attach-or-start')return a;if(q.command==='maintain-core'){await gate.promise;next=replacement(a);return{operation:'restart',stopped:true,requestId:q.request.requestId,attachment:next}}return{}}});
 await h.session.attach(17306);const operation=h.session.maintain('restart',true);await tick();const close=h.session.close();gate.resolve();await Promise.all([operation,close]);
 assert.equal(h.session.receipt,undefined);assert.equal(h.calls.at(-1).handle.leaseId,next.lease.leaseId);assert.equal(h.calls.filter(c=>c.command==='detach').length,1);
});
test('maintenance waits for an in-flight renewal and blocks a concurrent mutation',async t=>{
 const gate=pending();const h=setup(t,{invoke:async(q,a)=>{if(q.command==='attach-or-start')return a;if(q.command==='heartbeat'){await gate.promise;return a.lease}if(q.command==='maintain-core')return{operation:'stop',stopped:true,requestId:q.request.requestId};return{}}});
 await h.session.attach(17306);const renew=h.session.renew(),stop=h.session.maintain('stop',true);
 await assert.rejects(h.session.maintain('restart',true),/in_progress/);assert.equal(h.calls.filter(c=>c.command==='maintain-core').length,0);
 gate.resolve();await Promise.all([renew,stop]);assert.deepEqual(h.calls.slice(-2).map(c=>c.command),['heartbeat','maintain-core']);
});
test('a stale receipt, foreign build or wrong transaction never becomes a successful restart',async t=>{
 const h=setup(t,{invoke:async(q,a)=>q.command==='attach-or-start'?a:q.command==='maintain-core'?{operation:'restart',stopped:true,requestId:q.request.requestId,attachment:a}:{}});
 await h.session.attach(17306);await assert.rejects(h.session.maintain('restart',true),/inspection/);assert.equal(h.session.receipt,undefined);
});


test('endpoint discovery precedes ensure and attach and publishes only the validated ready port',async t=>{
 let ready;const h=setup(t,{resolvePort:async()=>17400,onReady:r=>ready=r,invoke:async(q,a)=>q.command==='attach-or-start'?{...a,receipt:{...a.receipt,localUrl:'http://127.0.0.1:17400/ui/'}}:{}});
 await h.session.attach(17306);assert.equal(ready.localUrl,'http://127.0.0.1:17400/ui/');assert.equal(h.calls[0].request.port,17400);assert.equal(h.calls[1].request.port,17400);
});
test('unknown endpoint discovery cannot provision or spawn as fallback',async t=>{
 const h=setup(t,{resolvePort:async()=>{throw Error('endpoint_state_unknown')}});await assert.rejects(h.session.attach(17306),/endpoint_state_unknown/);assert.equal(h.calls.length,0);
});
test('settings revision is forwarded once; a revision conflict retains the renewable binding',async t=>{
 const h=setup(t,{invoke:async(q,a)=>{if(q.command==='attach-or-start')return a;if(q.command==='maintain-core')throw Error('settings_revision_conflict');if(q.command==='heartbeat')return a.lease;return{}}});
 await h.session.attach(17306);await assert.rejects(h.session.maintain('restart',true,7),/settings_revision_conflict/);await tick();await h.session.renew();
 assert.equal(h.calls.find(c=>c.command==='maintain-core').request.settingsRevision,7);assert.equal(h.lost,0);assert.equal(h.session.receipt.daemonId,'daemon-fixture');
 await assert.rejects(h.session.maintain('stop',true,7),/settings_revision_invalid/);assert.equal(h.calls.filter(c=>c.command==='maintain-core').length,1);
});
test('a coordinated cold port change may be adopted after confirmed Stop, not during an attachment',async t=>{
 let port=17306;const h=setup(t,{resolvePort:async()=>port,invoke:async(q,a)=>q.command==='attach-or-start'?{...a,receipt:{...a.receipt,localUrl:`http://127.0.0.1:${port}/ui/`}}:q.command==='maintain-core'?{operation:'stop',stopped:true,requestId:q.request.requestId}:{}});
 await h.session.attach(17306);await assert.rejects(h.session.attach(17400),/coordinated_restart/);await h.session.maintain('stop',true);port=17400;assert.match((await h.session.attach(17400)).localUrl,/:17400/);
});
test('an internally consistent receipt for a different canonical data root is still rejected',async t=>{
 const h=setup(t,{dataRootId:'f'.repeat(64)});await assert.rejects(h.session.attach(17306),/managed_receipt_mismatch/);assert.equal(h.session.receipt,undefined);
});
