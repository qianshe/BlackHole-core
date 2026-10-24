import assert from 'node:assert/strict';
import test from 'node:test';
import { AttachCoreRequestSchema, LeaseHandleSchema, ManagedReadyReceiptSchema, RunningCoreRecordSchema, UpgradeCoreRequestSchema, CoreUpgradeRecordSchema } from '../dist/index.js';

const id='11111111-1111-4111-8111-111111111111',hash='a'.repeat(64);
const client={clientId:'desktop',clientInstanceId:id,kind:'desktop',version:'1',protocol:{min:1,max:1},capabilities:['web-ui']};
const receipt={protocolVersion:1,instanceKey:hash,daemonId:'daemon',daemonVersion:'1',runtimeKind:'standalone-node',uiVersion:'web',configRevision:0,localUrl:'http://127.0.0.1:49222/ui/',webApiBase:'../web-api/v1/',capabilities:['web-ui'],runtimeId:'core',runtimeVersion:'1',buildId:'build',descriptorHash:hash,dataRootId:hash,webBuildId:'web',coreProtocol:{min:1,max:1},environment:'test',cloudOrigin:'https://fixture.invalid',lifecycleState:'managed',startFingerprint:'fp'};

test('managed attach request is strict, bounded and per instance',()=>{
  assert.equal(AttachCoreRequestSchema.parse({client,port:49222}).readyTimeoutMs,30000);
  for(const request of [{client,port:0},{client,port:49222,readyTimeoutMs:90000},{client:{...client,clientInstanceId:'../state'},port:49222},{client,port:49222,daemonEntry:'untrusted.js'}])assert.equal(AttachCoreRequestSchema.safeParse(request).success,false);
});
test('managed receipt cannot be a legacy receipt or carry credentials',()=>{
  assert.equal(ManagedReadyReceiptSchema.safeParse(receipt).success,true);
  const {startFingerprint,...legacy}=receipt;assert.equal(ManagedReadyReceiptSchema.safeParse(legacy).success,false);
  for(const extra of [{ticket:'secret'},{accessToken:'secret'},{lifecycleState:'legacy'}])assert.equal(ManagedReadyReceiptSchema.safeParse({...receipt,...extra}).success,false);
});
test('lease handles bind instance, daemon, data root and descriptor, not a path',()=>{
  const handle={leaseId:id,clientInstanceId:id,daemonId:'daemon',dataRootId:hash,descriptorHash:hash};
  assert.equal(LeaseHandleSchema.safeParse(handle).success,true);
  assert.equal(LeaseHandleSchema.safeParse({...handle,leaseId:'../active'}).success,false);
  assert.equal(LeaseHandleSchema.safeParse({...handle,port:7306}).success,false);
});
test('ready records need matching receipt; ambiguous starts cannot contain unsafe version paths',()=>{
  const base={schemaVersion:1,status:'ready',versionName:'1-build',descriptorHash:hash,dataRootId:hash,dbPath:'isolated.db',port:49222,startFingerprint:'fp',receipt};
  assert.equal(RunningCoreRecordSchema.safeParse(base).success,true);
  for(const extra of [{receipt:undefined},{dataRootId:'b'.repeat(64)},{startFingerprint:'other'},{port:123},{versionName:'../outside'},{pid:-1}])assert.equal(RunningCoreRecordSchema.safeParse({...base,...extra}).success,false);
});
test('upgrade requests are confirmed, journalled and target a safe version name',()=>{
  const handle={leaseId:id,clientInstanceId:id,daemonId:'daemon',dataRootId:hash,descriptorHash:hash};
  const request={handle,client,port:49222,confirmed:true,requestId:id,targetVersionName:'0.3.202-product-b'};
  assert.equal(UpgradeCoreRequestSchema.parse(request).readyTimeoutMs,30000);
  for(const bad of [{...request,confirmed:false},{...request,targetVersionName:'../outside'},{...request,requestId:'reuse-me'},{...request,extra:'nope'}])assert.equal(UpgradeCoreRequestSchema.safeParse(bad).success,false);
  const from={schemaVersion:1,status:'ready',versionName:'1-build',descriptorHash:hash,dataRootId:hash,dbPath:'isolated.db',port:49222,startFingerprint:'fp',receipt};
  const record={schemaVersion:1,requestId:id,requestHash:hash,from,targetVersionName:'0.3.202-product-b',targetDescriptorHash:hash,state:'staged',updatedAt:new Date().toISOString()};
  assert.equal(CoreUpgradeRecordSchema.safeParse(record).success,true);
  assert.equal(CoreUpgradeRecordSchema.safeParse({...record,state:'done'}).success,false);
});
