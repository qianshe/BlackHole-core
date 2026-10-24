import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { MaintenanceGate, ManagedControl } from '../dist/lifecycle/managed-control.js';
import { SessionActivity } from '../dist/session-activity.js';
import { restartSelf } from '../dist/util/self-restart.js';
import { MaintainCoreRequestSchema, MaintainCoreResultSchema } from '../packages/contracts/dist/manager-protocol.js';

function fixture(extra = {}) {
 const pair=generateKeyPairSync('ed25519'),publicKeyPem=pair.publicKey.export({type:'spki',format:'pem'}).toString();
 const identity={runtimeId:'core',runtimeVersion:'1',buildId:'a',descriptorHash:'b'.repeat(64),dataRootId:'a'.repeat(64),webBuildId:'web',coreProtocol:{min:1,max:1},environment:'test',cloudOrigin:'https://fixture.invalid',lifecycleState:'managed'};
 let busy=false,now=Date.now();const gate=new MaintenanceGate();
 const control=new ManagedControl({publicKeyPem,identity,daemonId:'daemon',startFingerprint:'fingerprint',gate,now:()=>now,assertIdle(){if(busy)throw Error('active_work')},...extra});
 const grant=(overrides={},key=pair.privateKey)=>{
  const claims={schemaVersion:1,operation:'stop',daemonId:'daemon',startFingerprint:'fingerprint',runtimeId:identity.runtimeId,buildId:identity.buildId,descriptorHash:identity.descriptorHash,dataRootId:identity.dataRootId,transactionId:randomUUID(),nonce:randomUUID(),issuedAt:new Date(now).toISOString(),expiresAt:new Date(now+30000).toISOString(),...overrides};
  const payload=Buffer.from(JSON.stringify(claims)).toString('base64url');return payload+'.'+sign(null,Buffer.from(payload),key).toString('base64url');
 };
 return {gate,control,grant,identity,pair,setBusy:v=>{busy=v},tick:n=>{now+=n}};
}
function response(){const r=new EventEmitter();r.status=n=>{r.code=n;return r};r.json=b=>{r.body=b;return r};return r}

test('a valid short-lived grant atomically seals ingress without exposing a token',()=>{
 const f=fixture();const accepted=f.control.acceptStop(f.grant());assert.equal(accepted.daemonId,'daemon');assert.equal(f.gate.accepting,false);assert.equal(f.identity.lifecycleState,'stopping');
 const res=response();let next=0;f.gate.middleware({method:'POST',path:'/mcp/test'},res,()=>next++);assert.equal(res.code,503);assert.equal(next,0);assert.equal(JSON.stringify(accepted).includes('token'),false);
});
test('busy work rejects without sealing, and a refused grant cannot be replayed',()=>{
 const f=fixture(),token=f.grant();f.setBusy(true);assert.throws(()=>f.control.acceptStop(token),/active_work/);assert.equal(f.gate.accepting,true);
 f.setBusy(false);assert.throws(()=>f.control.acceptStop(token),/replayed/);f.control.acceptStop(f.grant());assert.equal(f.gate.accepting,false);
});
test('pending HTTP work is counted once across finish and close and blocks sealing',()=>{
 const f=fixture(),r=response();f.gate.middleware({method:'POST',path:'/api/work'},r,()=>{});assert.equal(f.gate.pendingRequests,1);
 assert.throws(()=>f.control.acceptStop(f.grant()),/active_requests/);r.emit('close');r.emit('finish');assert.equal(f.gate.pendingRequests,0);
 f.control.acceptStop(f.grant());
});
test('health and the native maintenance route remain observable after seal',()=>{
 const f=fixture();f.control.acceptStop(f.grant());let calls=0;
 for(const [method,path] of [['GET','/api/health'],['POST','/api/core/stop']])f.gate.middleware({method,path},response(),()=>calls++);
 assert.equal(calls,2);assert.equal(f.gate.pendingRequests,0);
});
test('wrong key, target, descriptor, operation, expired and oversized grants never seal',()=>{
 const f=fixture();assert.throws(()=>f.control.acceptStop(f.grant({},generateKeyPairSync('ed25519').privateKey)),/signature/);
 for(const override of [{daemonId:'other'},{startFingerprint:'other'},{dataRootId:'c'.repeat(64)},{descriptorHash:'d'.repeat(64)},{runtimeId:'other'},{buildId:'other'},{operation:'handover'}])assert.throws(()=>f.control.acceptStop(f.grant(override)),/target/);
 const token=f.grant();f.tick(31000);assert.throws(()=>f.control.acceptStop(token),/expired/);
 assert.throws(()=>f.control.acceptStop('x'.repeat(9000)),/invalid/);assert.equal(f.gate.accepting,true);
});
test('pending tool count survives session forget and late completion is idempotent',()=>{
 const a=new SessionActivity(()=>{});const end=a.begin('fixture');assert.equal(a.pendingCount,1);a.forget('fixture');assert.equal(a.pendingCount,1);end();end();assert.equal(a.pendingCount,0);a.dispose();
});
test('managed self-restart never spawns or shuts down outside Manager',async()=>{
 let calls=0;const result=await restartSelf({runtimeIdentity:{lifecycleState:'managed'},events:{append(){calls++}},log(){calls++},shutdown:async()=>{calls++}},'test',()=>{calls++;throw Error('must not spawn')});
 assert.deepEqual(result,{ok:false,error:'managed_restart_requires_manager'});assert.equal(calls,0);
});
test('maintenance contract requires confirmation, a bounded target and no force field',()=>{
 const request={client:{clientId:'fixture',clientInstanceId:randomUUID(),kind:'vscode',version:'1',protocol:{min:1,max:1},capabilities:['web-ui']},handle:{leaseId:randomUUID(),clientInstanceId:randomUUID(),daemonId:'d',dataRootId:'a'.repeat(64),descriptorHash:'b'.repeat(64)},port:12345,confirmed:true,requestId:randomUUID(),operation:'stop'};
 assert.equal(MaintainCoreRequestSchema.safeParse(request).success,true);
 for(const extra of [{confirmed:false},{force:true},{requestId:'../outside'}])assert.equal(MaintainCoreRequestSchema.safeParse({...request,...extra}).success,false);
 assert.equal(MaintainCoreResultSchema.safeParse({operation:'stop',stopped:true,requestId:request.requestId,token:'secret'}).success,false);
});

test('a disconnected HTTP response cannot hide an unfinished async handler',async()=>{
 const f=fixture(),res=response();let release;const pending=new Promise(r=>{release=r});const req={method:'POST',path:'/api/work',originalUrl:'/api/work'};
 f.gate.middleware(req,res,()=>{});
 const handler=f.gate.trackHandler(async()=>{await pending});const work=handler(req,res,()=>{});
 res.emit('close');assert.equal(f.gate.pendingRequests,0);assert.throws(()=>f.control.acceptStop(f.grant()),/active_handlers/);
 release();await work;f.control.acceptStop(f.grant());
 let called=false;f.gate.trackHandler(()=>{called=true})(req,response(),()=>{});assert.equal(called,false);
});
test('unhandshaken Courier sockets are visible to maintenance and cannot enter after seal',async()=>{
 const {CourierHub}=await import('../dist/courier/hub.js');let accepting=true;const hub=new CourierHub({canAccept:()=>accepting});
 const socket=new EventEmitter();socket.close=()=>socket.emit('close');socket.send=()=>{};
 hub.attach(socket);assert.equal(hub.maintenanceBusy(),true);socket.close();assert.equal(hub.maintenanceBusy(),false);
 accepting=false;hub.attach(socket);assert.equal(hub.maintenanceBusy(),false);hub.close();
});

test('only a signed upgrade purpose uses the upgrade predicate; idle-stop remains unchanged',()=>{
 let task=false;
 const f=fixture({assertUpgradeable(){if(task)throw Error('active_work')}});f.setBusy(true);
 assert.throws(()=>f.control.acceptStop(f.grant()),/active_work/);
 task=true;assert.throws(()=>f.control.acceptStop(f.grant({operation:'upgrade'})),/active_work/);
 assert.equal(f.gate.accepting,true);
 task=false;f.control.acceptStop(f.grant({operation:'upgrade'}));assert.equal(f.gate.accepting,false);
});
test('upgrade admission still protects unfinished async work after its HTTP transport closed',async()=>{
 const f=fixture({assertUpgradeable(){}}),res=response();let release;
 const wait=new Promise(r=>release=r),req={method:'POST',path:'/mcp/tool',originalUrl:'/mcp/tool'};
 f.gate.middleware(req,res,()=>{});
 const work=f.gate.trackHandler(async()=>{await wait})(req,res,()=>{});res.emit('close');
 assert.throws(()=>f.control.acceptStop(f.grant({operation:'upgrade'})),/active_handlers/);
 release();await work;f.control.acceptStop(f.grant({operation:'upgrade'}));
 assert.equal(f.gate.accepting,false);
});

// Presence is an authenticated, explicitly marked reconnectable response, not
// an unfinished operation. A URL alone must never acquire this exemption.
test('an opted-in presence stream closes only after signed upgrade seals admission',()=>{
 const f=fixture({assertUpgradeable(){}}),r=response();let ended=0;
 r.end=()=>{ended++;r.emit('finish');r.emit('close')};
 f.gate.middleware({method:'GET',path:'/web-api/v1/presence'},r,()=>{});
 assert.equal(f.gate.pendingRequests,1);
 f.gate.markReconnectableResponse(r);
 assert.equal(f.gate.pendingRequests,0);
 f.setBusy(true);
 assert.throws(()=>f.control.acceptStop(f.grant()),/active_work/);
 assert.equal(ended,0,'an open page still prevents ordinary idle Stop');
 f.control.acceptStop(f.grant({operation:'upgrade'}));
 assert.equal(ended,1);assert.equal(f.gate.accepting,false);
 assert.equal(f.gate.pendingRequests,0,'finish/close cannot release the same request twice');
});
test('an unmarked presence URL and unfinished handler still block an upgrade',async()=>{
 const f=fixture({assertUpgradeable(){}}),r=response();r.end=()=>r.emit('finish');
 const req={method:'GET',path:'/web-api/v1/presence',originalUrl:'/web-api/v1/presence'};
 f.gate.middleware(req,r,()=>{});
 assert.throws(()=>f.control.acceptStop(f.grant({operation:'upgrade'})),/active_requests/);
 let release;const wait=new Promise(resolve=>release=resolve);
 const work=f.gate.trackHandler(async()=>{f.gate.markReconnectableResponse(r);await wait})(req,r,()=>{});
 assert.throws(()=>f.control.acceptStop(f.grant({operation:'upgrade'})),/active_handlers/);
 release();await work;f.control.acceptStop(f.grant({operation:'upgrade'}));
 assert.equal(f.gate.accepting,false);
});
