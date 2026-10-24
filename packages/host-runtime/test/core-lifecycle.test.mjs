import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { createRequire } from 'node:module';
const { buildSync } = createRequire(new URL('../../vscode/package.json', import.meta.url))('esbuild');
import { fileURLToPath } from 'node:url';
import { CoreManager } from '../dist/core-manager.cjs';
import { CoreLifecycle } from '../dist/core-lifecycle.cjs';
import { AttachCoreResultSchema, LeaseHandleSchema, RunningCoreRecordSchema } from '../../contracts/dist/index.js';
import { openManagedBrowser } from '../dist/core-browser.cjs';
import { sha256, signDescriptor, writeArchive } from '../../../scripts/core-runtime-lib.mjs';

const nodeHash = sha256(fs.readFileSync(process.execPath));
const nodeSize = fs.statSync(process.execPath).size;
const controllerSource = buildSync({entryPoints:[fileURLToPath(new URL('../../../src/lifecycle/managed-control.ts',import.meta.url))],bundle:true,platform:'node',format:'cjs',write:false}).outputFiles[0].text;
const daemonSource = `
const fs=require('node:fs'),http=require('node:http'),path=require('node:path');
const identity=JSON.parse(process.env.BLACKHOLE_MANAGED_RUNTIME_IDENTITY);
const port=Number(process.env.BLACKHOLE_PORT), home=process.env.BLACKHOLE_HOME;
fs.mkdirSync(home,{recursive:true});
fs.appendFileSync(path.join(home,'fixture-spawns.jsonl'),JSON.stringify({pid:process.pid,port})+'\\n');
const health={ok:true,version:'1.0.0',daemon_id:'fixture-'+process.pid,settings_revision:0,started_settings_revision:0,
 start_fingerprint:process.env.BLACKHOLE_START_FINGERPRINT,db_path:process.env.BLACKHOLE_DB,
 runtime_id:identity.runtimeId,runtime_version:identity.runtimeVersion,build_id:identity.buildId,
 descriptor_hash:identity.descriptorHash,data_root_id:identity.dataRootId,web_build_id:identity.webBuildId,
 core_protocol:identity.coreProtocol,core_environment:identity.environment,core_cloud_origin:identity.cloudOrigin,
 cloud_origin:identity.cloudOrigin,lifecycle_state:'managed'};
const {MaintenanceGate,ManagedControl}=require('./managed-control.cjs');
const gate=new MaintenanceGate();
const isBusy=()=>Boolean(process.env.TEST_MAINTENANCE_BUSY);
const control=new ManagedControl({publicKeyPem:process.env.BLACKHOLE_MANAGER_PUBLIC_KEY,identity,daemonId:health.daemon_id,startFingerprint:health.start_fingerprint,gate,settingsRevision:()=>health.settings_revision,assertIdle(){if(isBusy())throw Error('active_work')}});
if(!process.env.TEST_MAINTENANCE_OFF)Object.assign(health,{lifecycle_control_version:1,lifecycle_manager_key_hash:control.publicKeyHash});
if(!process.env.TEST_SETTINGS_OFF)health.lifecycle_settings_version=1;
Object.assign(health,JSON.parse(process.env.TEST_HEALTH_OVERRIDE||'{}'));
let healthReads=0;
if(process.env.TEST_LIFECYCLE_MODE==='late') setTimeout(()=>{},60000);
else if(process.env.TEST_LIFECYCLE_MODE==='exit') process.exit(17);
else http.createServer((req,res)=>{
 if(req.url==='/api/health'){res.setHeader('content-type','application/json');const wait=healthReads++===0?Number(process.env.TEST_FIRST_HEALTH_DELAY||0):0;setTimeout(()=>res.end(JSON.stringify({...health,maintenance_idle:!isBusy()})),wait);}
 else if(req.url==='/ui/'){res.statusCode=Number(process.env.TEST_WEB_STATUS||302);res.end();}
 else if(req.url==='/api/web/bootstrap'){res.setHeader('content-type','application/json');res.end(process.env.TEST_TICKET_MODE==='invalid'?'secret-fixture invalid JSON':JSON.stringify({path:'/ui/',ticket:'a'.repeat(43)}));}
 else if(req.url==='/api/core/stop'){
  fs.appendFileSync(path.join(home,'fixture-maintenance.log'),'request\\n');let body='';req.on('data',b=>body+=b);req.on('end',()=>{
   try{if(process.env.TEST_SETTINGS_RACE)health.settings_revision++;const result=control.acceptStop(JSON.parse(body).token);health.lifecycle_state=identity.lifecycleState;
    if(process.env.TEST_MAINTENANCE_LOST){res.destroy();return;}
    res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,...result}));setTimeout(()=>process.exit(0),30);
   }catch(e){res.statusCode=409;res.end(JSON.stringify({error:e.message}));}
  });
 }
 else if(req.url==='/fixture-stop'){res.end();setTimeout(()=>process.exit(0),5);}
 else{res.statusCode=404;res.end();}
}).listen(port,'127.0.0.1');
`;
const client = (kind = 'desktop', instance = randomUUID()) => ({ clientId: kind, clientInstanceId: instance, kind, version: '1.0.0', protocol: { min: 1, max: 1 }, capabilities: ['web-ui'] });
const handle = (lease) => LeaseHandleSchema.parse(Object.fromEntries(['leaseId','clientInstanceId','daemonId','dataRootId','descriptorHash'].map((key)=>[key,lease[key]])));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const port=server.address().port;
  await new Promise((resolve)=>server.close(resolve));
  assert.notEqual(port,7306);return port;
}
async function fixture(t, extraEnv = {}, coreFormat = 1) {
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'bh-lifecycle-'));
  const home=path.join(temp,'home'), data=path.join(home,'.blackhole'), store=path.join(data,'core');
  fs.mkdirSync(data,{recursive:true});
  const port=await freePort();
  const env={...process.env,HOME:home,USERPROFILE:home,LOCALAPPDATA:path.join(home,'AppData','Local'),BLACKHOLE_HOME:data,BLACKHOLE_DB:path.join(data,'blackhole.db'),BLACKHOLE_PORT:String(port),BLACKHOLE_TUNNEL:'off',...extraEnv};
  const pair=generateKeyPairSync('ed25519');
  const trust={environment:'test',publicKeys:{'test-lifecycle':pair.publicKey.export({type:'spki',format:'pem'}).toString()}};
  let now=Date.now(); const manager=new CoreManager(store,()=>new Date(now));
  const lifecycle=new CoreLifecycle(manager,trust,env);
  const fixtureFile=path.join(data,'fixture-spawns.jsonl');
  const spawns=()=>fs.existsSync(fixtureFile)?fs.readFileSync(fixtureFile,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
  const deadPids=new Set();
  t.after(async()=>{
    for(const record of spawns()) {if(deadPids.has(record.pid))continue;try{process.kill(record.pid);}catch{}}
    // Only processes launched from this test's signed fixture are terminated.
    for(let i=0;i<50;i++) {if(spawns().every(({pid})=>{try{process.kill(pid,0);return false;}catch{return true;}})) break; await pause(50);}
    // Yield while Windows retires this fixture's child handles; blocking the
    // event loop during recursive removal can keep those handles alive.
    await fs.promises.rm(temp,{recursive:true,force:true,maxRetries:30,retryDelay:100});
  });
  async function addCore(buildId='a') {
    let descriptor;
    const installed=await manager.provision('fixture.zip','seed',async(_archive,destination)=>{
      const nodeEntry=process.platform==='win32'?'node/node.exe':'node/node';
      const files={...(coreFormat === 1 ? {[nodeEntry]:null} : {}),'daemon/cli.cjs':daemonSource,'daemon/managed-control.cjs':controllerSource,'host/manager.mjs':'// signed fixture manager\n','web/index.html':'<!doctype html>fixture'};
      const members=[];
      for(const [name,content] of Object.entries(files)) {
        const file=path.join(destination,name);fs.mkdirSync(path.dirname(file),{recursive:true});
        if(content===null)fs.copyFileSync(process.execPath,file);else fs.writeFileSync(file,content);
        members.push({path:name,sha256:content===null?nodeHash:sha256(Buffer.from(content)),size:content===null?nodeSize:Buffer.byteLength(content)});
      }
      const unsigned={formatVersion:coreFormat,runtimeId:'blackhole-core',runtimeVersion:'1.0.0',buildId,platform:process.platform,arch:process.arch,environment:'test',cloudOrigin:'https://fixture.invalid',coreProtocol:{min:1,max:1},capabilities:['web-ui'],...(coreFormat === 1 ? {nodeVersion:process.version,nodeEntry} : {runtimeProvider:'host-node',nodeMinVersion:'22.13.0'}),daemonVersion:'1.0.0',daemonEntry:'daemon/cli.cjs',webBuildId:'web-'+buildId,webRoot:'web',managerEntry:'host/manager.mjs',dataSchema:{min:1,max:1},migrationPolicy:'none',members,signingKeyId:'test-lifecycle',signatureAlgorithm:'ed25519',createdAt:new Date(now).toISOString()};
      descriptor={...unsigned,signature:signDescriptor(unsigned,pair.privateKey)};
      const bytes=Buffer.from(JSON.stringify(descriptor,null,2)+'\n');
      fs.writeFileSync(path.join(destination,'core-descriptor.json'),bytes);
      return {descriptor,descriptorHash:sha256(bytes)};
    });
    return {...installed,root:path.join(store,'versions','1.0.0-'+buildId),versionName:'1.0.0-'+buildId};
  }
  const core=await addCore();await manager.activate(core.versionName);
  const request={client:client(),port,readyTimeoutMs:5_000};
  return {temp,home,store,data,env,trust,manager,lifecycle,port,core,request,spawns,addCore,deadPids,tick:(ms)=>{now+=ms;}};
}
async function invokeCLI(f, input) {
  const trustFile=path.join(f.temp,'trust.json');fs.writeFileSync(trustFile,JSON.stringify(f.trust));
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[fileURLToPath(new URL('../dist/core-manager-cli.mjs',import.meta.url))],{env:{...f.env,BH_CORE_STORE:f.store,BH_CORE_TRUST_CONFIG:trustFile},stdio:['pipe','pipe','pipe'],windowsHide:true});
    let out='',err='';child.stdout.on('data',b=>{out+=b;});child.stderr.on('data',b=>{err+=b;});child.on('error',reject);
    child.on('close',code=>{try{resolve({code,response:JSON.parse(out),stderr:err});}catch(e){reject(new Error('CLI output invalid: '+out+err));}});
    child.stdin.end(JSON.stringify(input));
  });
}

test('managed attach starts bundled Node once, shares identity, renews and detaches only one client', async(t)=>{
  const f=await fixture(t,{NODE_OPTIONS:'--require definitely-not-a-module',NODE_PATH:'not-a-runtime',ELECTRON_RUN_AS_NODE:'1'});
  const first=AttachCoreResultSchema.parse(await f.lifecycle.attachOrStart(f.request));
  assert.equal(first.spawned,true); assert.match(first.receipt.localUrl,/^http:\/\/127\.0\.0\.1:/);
  const other=await f.lifecycle.attachOrStart({...f.request,client:client('vscode')});
  assert.equal(other.spawned,false);assert.equal(first.receipt.daemonId,other.receipt.daemonId);
  assert.notEqual(first.lease.leaseId,other.lease.leaseId);assert.equal(f.spawns().length,1);
  const retry=await f.lifecycle.attachOrStart(f.request);assert.equal(retry.lease.leaseId,first.lease.leaseId);
  await assert.rejects(new CoreLifecycle(f.manager,{...f.trust,environment:'production'},f.env).heartbeat({handle:handle(first.lease),port:f.port}),/environment_mismatch/);
  f.tick(5_000);const renewed=await f.lifecycle.heartbeat({handle:handle(first.lease),port:f.port});
  assert.ok(renewed.expiresAt>first.lease.expiresAt);
  await assert.rejects(f.lifecycle.detach({...handle(first.lease),clientInstanceId:randomUUID()}),/lease_target_mismatch/);
  await f.lifecycle.detach(handle(first.lease));await f.lifecycle.detach(handle(first.lease));
  await assert.rejects(f.lifecycle.heartbeat({handle:handle(first.lease),port:f.port}),/lease_missing/);
  assert.deepEqual(f.manager.liveLeases().map(x=>x.leaseId),[other.lease.leaseId]);
  const health=await (await fetch(`http://127.0.0.1:${f.port}/api/health`)).json();assert.equal(health.daemon_id,first.receipt.daemonId);
  const inventory=JSON.parse(fs.readFileSync(path.join(f.store,'clients.json')));assert.equal(inventory.clients.length,2);
});
test('VS Code first then native Desktop: one signed Core, one data root, independent leases', async t => {
  const f = await fixture(t);
  const first = AttachCoreResultSchema.parse(
    await f.lifecycle.attachOrStart({ ...f.request, client: client('vscode') }));
  assert.equal(first.spawned, true);
  const desktop = AttachCoreResultSchema.parse(
    await f.lifecycle.attachOrStart({ ...f.request, client: client('desktop') }));
  assert.equal(desktop.spawned, false);
  assert.equal(first.receipt.daemonId, desktop.receipt.daemonId);
  assert.equal(first.receipt.descriptorHash, desktop.receipt.descriptorHash);
  assert.equal(first.receipt.dataRootId, desktop.receipt.dataRootId);
  assert.equal(f.spawns().length, 1, 'no duplicate daemon from the second host');
  const health = await (await fetch('http://127.0.0.1:' + f.port + '/api/health')).json();
  assert.equal(path.resolve(health.db_path), path.resolve(f.env.BLACKHOLE_DB));
  assert.deepEqual(new Set(f.manager.liveLeases().map(l => l.kind)),
    new Set(['vscode', 'desktop']));
  await f.lifecycle.detach(handle(first.lease));
  assert.deepEqual(f.manager.liveLeases().map(l => l.leaseId), [desktop.lease.leaseId]);
  assert.equal((await (await fetch('http://127.0.0.1:' + f.port + '/api/health')).json()).daemon_id,
    first.receipt.daemonId, 'closing VS Code must not stop Desktop-owned Core');
  await f.lifecycle.detach(handle(desktop.lease));
});

test('CLI JSON seam supports attach, heartbeat, detach; null request is bounded structured failure',async(t)=>{
  const f=await fixture(t);
  const first=await invokeCLI(f,{command:'attach-or-start',request:f.request});assert.equal(first.code,0,JSON.stringify(first));
  const result=AttachCoreResultSchema.parse(first.response.result);
  const beat=await invokeCLI(f,{command:'heartbeat',request:{handle:handle(result.lease),port:f.port}});assert.equal(beat.code,0);
  const detach=await invokeCLI(f,{command:'detach',handle:handle(result.lease)});assert.equal(detach.response.result.detached,true);
  const bad=await invokeCLI(f,null);assert.equal(bad.code,1);assert.equal(bad.response.error.code,'request_invalid');
});

test('concurrent clients cannot both launch; retry attaches after a positively reported lock conflict',async(t)=>{
  const f=await fixture(t);
  const requests=[f.request,{...f.request,client:client('vscode')}];
  const results=await Promise.allSettled(requests.map(r=>f.lifecycle.attachOrStart(r)));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  const loser=results.findIndex(r=>r.status==='rejected');assert.ok(loser>=0);assert.equal(results[loser].reason.code,'lock_busy');
  assert.equal((await f.lifecycle.attachOrStart(requests[loser])).spawned,false);assert.equal(f.spawns().length,1);
});

test('member tampering and an untrusted signing key cannot run code',async(t)=>{
  const f=await fixture(t);
  await assert.rejects(new CoreLifecycle(f.manager,{environment:'test',publicKeys:{}},f.env).attachOrStart(f.request),/signature_invalid/);
  fs.appendFileSync(path.join(f.core.root,'daemon/cli.cjs'),'// tampered');
  await assert.rejects(f.lifecycle.attachOrStart(f.request),/member_hash_invalid/);
  assert.equal(f.spawns().length,0);
});

test('environment, protocol and capability mismatch never spawn',async(t)=>{
  const f=await fixture(t);
  await assert.rejects(new CoreLifecycle(f.manager,{...f.trust,environment:'production'},f.env).attachOrStart(f.request),/signature_invalid|environment_mismatch/);
  await assert.rejects(f.lifecycle.attachOrStart({...f.request,client:{...f.request.client,protocol:{min:2,max:2}}}),/client_update_required/);
  await assert.rejects(f.lifecycle.attachOrStart({...f.request,client:{...f.request.client,capabilities:['process']}}),/client_update_required/);
  assert.equal(f.spawns().length,0);
});

test('foreign listener and malformed health are never treated as an available port',async(t)=>{
  const f=await fixture(t);let body='not-json',status=200;
  const server=http.createServer((_req,res)=>{res.statusCode=status;res.end(body);});
  await new Promise(resolve=>server.listen(f.port,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  await assert.rejects(f.lifecycle.attachOrStart(f.request),/foreign_listener/);
  body=JSON.stringify({ok:true,version:'legacy',daemon_id:'legacy'});
  await assert.rejects(f.lifecycle.attachOrStart(f.request),/managed_core_required/);
  status=503;await assert.rejects(f.lifecycle.attachOrStart(f.request),/foreign_listener/);
  assert.equal(f.spawns().length,0);
});

test('timeout leaves a durable start guard; repeating attach never spawns a second process',async(t)=>{
  const f=await fixture(t,{TEST_LIFECYCLE_MODE:'late'});
  await assert.rejects(f.lifecycle.attachOrStart({...f.request,readyTimeoutMs:500}),/ready_timeout/);
  assert.equal(f.spawns().length,1);
  await assert.rejects(f.lifecycle.attachOrStart(f.request),/daemon_state_unknown/);assert.equal(f.spawns().length,1);
  const records=fs.readdirSync(path.join(f.store,'state/running'));assert.equal(records.length,1);
  const record=JSON.parse(fs.readFileSync(path.join(f.store,'state/running',records[0])));assert.equal(record.status,'starting');
  assert.equal(f.manager.liveLeases().length,0);
});

test('readiness rejects forged runtime identity, data root and missing Web assets',async(t)=>{
  for(const [name,env,pattern] of [
    ['wrong-data',{TEST_HEALTH_OVERRIDE:JSON.stringify({data_root_id:'a'.repeat(64)})},/core_identity_conflict/],
    ['wrong-build',{TEST_HEALTH_OVERRIDE:JSON.stringify({build_id:'foreign'})},/core_identity_conflict/],
    ['wrong-cloud',{TEST_HEALTH_OVERRIDE:JSON.stringify({cloud_origin:'https://wrong.invalid'})},/core_identity_conflict/],
    ['missing-web',{TEST_WEB_STATUS:'404'},/web_assets_missing/],
  ]) await t.test(name,async(t)=>{const f=await fixture(t,env);await assert.rejects(f.lifecycle.attachOrStart(f.request),pattern);assert.equal(f.manager.liveLeases().length,0);});
});

test('running Core survives Quit, pointer advancement and GC; compatible callers attach without downgrade',async(t)=>{
  const f=await fixture(t);const first=await f.lifecycle.attachOrStart(f.request);
  const second=await f.addCore('b');await f.manager.activate(second.versionName);
  await f.lifecycle.detach(handle(first.lease));
  fs.writeFileSync(path.join(f.store,'known-good.json'),JSON.stringify({schemaVersion:1,versionName:second.versionName,descriptorHash:second.descriptorHash}));
  assert.deepEqual(await f.manager.garbageCollect(),[]);assert.ok(fs.existsSync(f.core.root));
  const again=await f.lifecycle.attachOrStart({...f.request,client:client('vscode')});
  assert.equal(again.receipt.daemonId,first.receipt.daemonId);assert.equal(f.manager.select().versionName,second.versionName);assert.equal(f.spawns().length,1);
  fs.writeFileSync(path.join(f.store,'state/running/corrupt.json'),'{');
  await assert.rejects(f.manager.garbageCollect());
});

test('data-root port changes, expired leases and wrong instance handles fail closed',async(t)=>{
  const f=await fixture(t);const first=await f.lifecycle.attachOrStart(f.request);
  await assert.rejects(f.lifecycle.attachOrStart({...f.request,port:await freePort()}),/data_root_conflict/);
  await assert.rejects(f.lifecycle.heartbeat({handle:{...handle(first.lease),daemonId:'other'},port:f.port}),/lease_target_mismatch/);
  f.tick(50_000);await assert.rejects(f.lifecycle.heartbeat({handle:handle(first.lease),port:f.port}),/lease_expired/);
  await f.lifecycle.detach(handle(first.lease));assert.equal(f.spawns().length,1);
});

test('VS Code wake rebinds an expired lease only to the same signed running Core',async t=>{
  const f=await fixture(t);
  const vscode=client('vscode');
  const first=await f.lifecycle.attachOrStart({...f.request,client:vscode});
  f.tick(50_000);
  await assert.rejects(f.lifecycle.heartbeat({handle:handle(first.lease),port:f.port}),/lease_expired/);
  const recovered=await f.lifecycle.attachOrStart({...f.request,client:vscode,existingFingerprint:first.receipt.startFingerprint});
  assert.equal(recovered.spawned,false);
  assert.equal(recovered.receipt.daemonId,first.receipt.daemonId);
  assert.equal(recovered.receipt.descriptorHash,first.receipt.descriptorHash);
  assert.notEqual(recovered.lease.leaseId,first.lease.leaseId,'expired handle is never renewed as if still live');
  assert.equal(recovered.lease.clientInstanceId,first.lease.clientInstanceId);
  assert.equal(f.spawns().length,1);
  await assert.rejects(f.lifecycle.attachOrStart({...f.request,client:client('vscode'),existingFingerprint:'stale-fingerprint'}),/managed_running_core_required/);
  assert.equal(f.spawns().length,1,'refused recovery must not spawn another Core');
});

test('paths inside Core, path-shaped lease IDs and secret-bearing receipts are rejected',async(t)=>{
  const f=await fixture(t);
  assert.throws(() => new CoreLifecycle(f.manager,f.trust,{...f.env,BLACKHOLE_HOME:path.join(f.core.root,'userdata')}), /noncanonical_storage_path/);
  const misplacedHome = path.join(f.core.root, 'userdata');
  await assert.rejects(new CoreLifecycle(f.manager,f.trust,{...f.env,HOME:misplacedHome,USERPROFILE:misplacedHome,BLACKHOLE_HOME:path.join(misplacedHome,'.blackhole'),BLACKHOLE_DB:path.join(misplacedHome,'.blackhole','blackhole.db')}).attachOrStart(f.request), /data_root_inside_core_store/);
  assert.equal(f.spawns().length,0);
  await assert.rejects(f.lifecycle.detach({leaseId:'../active',clientInstanceId:randomUUID(),daemonId:'x',dataRootId:'a'.repeat(64),descriptorHash:'a'.repeat(64)}));
  assert.throws(()=>f.manager.select('../outside.json'),/invalid_pointer_name/);
  const first=await f.lifecycle.attachOrStart(f.request);
  assert.equal(AttachCoreResultSchema.safeParse({...first,receipt:{...first.receipt,ticket:'secret'}}).success,false);
  assert.equal(RunningCoreRecordSchema.safeParse({schemaVersion:1,status:'ready',versionName:'a',descriptorHash:'a'.repeat(64),dataRootId:'a'.repeat(64),port:1,dbPath:'db',startFingerprint:'fp'}).success,false);
});


test('a silent listener is unknown, not down, and never causes spawn',async(t)=>{
  const f=await fixture(t);
  const server=http.createServer(()=>{});
  await new Promise(resolve=>server.listen(f.port,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
  await assert.rejects(f.lifecycle.attachOrStart(f.request),/daemon_probe_unknown/);
  assert.equal(f.spawns().length,0);assert.equal(f.manager.liveLeases().length,0);
});

test('a crashed child leaves an unresolved record and is not respawned automatically',async(t)=>{
  const f=await fixture(t,{TEST_LIFECYCLE_MODE:'exit'});
  await assert.rejects(f.lifecycle.attachOrStart(f.request),/kernel_exited/);
  await assert.rejects(f.lifecycle.attachOrStart(f.request),/daemon_state_unknown/);
  assert.equal(f.spawns().length,1);
});

test('broken active pointers fail closed; absent active may reuse verified known-good without switching',async(t)=>{
  const f=await fixture(t),active=path.join(f.store,'active.json');
  const valid=fs.readFileSync(active);
  fs.writeFileSync(active,JSON.stringify({schemaVersion:1,versionName:'missing',descriptorHash:f.core.descriptorHash}));
  await assert.rejects(f.lifecycle.attachOrStart(f.request),/broken_pointer/);assert.equal(f.spawns().length,0);
  fs.writeFileSync(path.join(f.store,'known-good.json'),valid);fs.unlinkSync(active);
  assert.equal((await f.lifecycle.attachOrStart(f.request)).spawned,true);assert.equal(fs.existsSync(active),false);
});

test('ensure-core prefers verified active/known-good and never downgrades or masks corruption with Seed',async(t)=>{
  const f=await fixture(t), newer=await f.addCore('newer');await f.manager.activate(newer.versionName);
  const request={client:f.request.client,port:f.port,seedArchive:path.join(f.temp,'missing-seed.zip'),seedArchiveHash:'0'.repeat(64)};
  assert.deepEqual(await f.lifecycle.ensureCore(request),{versionName:newer.versionName,reused:true});
  const active=path.join(f.store,'active.json'), bytes=fs.readFileSync(active);
  fs.writeFileSync(path.join(f.store,'known-good.json'),bytes);fs.unlinkSync(active);
  assert.equal((await f.lifecycle.ensureCore(request)).versionName,newer.versionName);assert.equal(fs.existsSync(active),false);
  fs.writeFileSync(active,bytes);fs.appendFileSync(path.join(newer.root,'web/index.html'),'tamper');
  await assert.rejects(f.lifecycle.ensureCore(request),/core_member_hash_invalid/);
  fs.writeFileSync(active,'{');await assert.rejects(f.lifecycle.ensureCore(request));
  assert.equal(f.spawns().length,0);
});

test('ensure-core preserves the verified running Core even after the active pointer advances',async(t)=>{
  const f=await fixture(t);await f.lifecycle.attachOrStart(f.request);const newer=await f.addCore('newer');await f.manager.activate(newer.versionName);fs.appendFileSync(path.join(newer.root,'web/index.html'),'corrupt inactive future Core');
  assert.deepEqual(await f.lifecycle.ensureCore({client:f.request.client,port:f.port,seedArchive:'missing.zip'}),{versionName:f.core.versionName,reused:true});assert.equal(f.manager.select().versionName,newer.versionName);assert.equal(f.spawns().length,1);
});

test('ensure-core verifies and provisions offline Seed without spawning; foreign listener prevents activation',async(t)=>{
  const f=await fixture(t), archive=path.join(f.temp,'core.zip');
  await writeArchive(archive,f.core.root,f.core.descriptor);
  const manager=new CoreManager(path.join(f.temp,'fresh-store'));
  const lifecycle=new CoreLifecycle(manager,f.trust,f.env);
  const request={client:f.request.client,port:f.port,seedArchive:archive,seedArchiveHash:sha256(fs.readFileSync(archive))};
  await assert.rejects(lifecycle.ensureCore({...request,seedArchiveHash:'0'.repeat(64)}),/core_seed_hash_invalid/);
  assert.equal(manager.select(),undefined);
  assert.deepEqual(await lifecycle.ensureCore(request),{versionName:f.core.versionName,reused:false});
  assert.equal((await lifecycle.ensureCore({...request,seedArchive:'missing.zip'})).reused,true);
  assert.equal(f.spawns().length,0);
  const foreign=http.createServer((_req,res)=>{res.end(JSON.stringify({ok:true,daemon_id:'legacy'}));});
  await new Promise(resolve=>foreign.listen(f.port,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>foreign.close(resolve)));
  const blockedManager=new CoreManager(path.join(f.temp,'blocked-store'));
  await assert.rejects(new CoreLifecycle(blockedManager,f.trust,f.env).ensureCore(request),/managed_core_required/);
  assert.equal(blockedManager.select(),undefined);assert.equal(f.spawns().length,0);
});

test('activate-if-absent preserves a concurrently selected Core and never invokes the Seed guard',async(t)=>{
  const f=await fixture(t), newer=await f.addCore('newer');await f.manager.activate(newer.versionName);
  const result=await f.manager.activateIfAbsent(f.core.versionName,async()=>{throw new Error('must not execute');});
  assert.equal(result.versionName,newer.versionName);assert.equal(f.manager.select().versionName,newer.versionName);
});

test('explicit start recovery requires confirmation, exact target, dead PID and no live lease; preserves audit',async(t)=>{
  const f=await fixture(t,{TEST_LIFECYCLE_MODE:'exit'});
  await assert.rejects(f.lifecycle.attachOrStart(f.request),/kernel_exited/);
  const state=await f.lifecycle.inspectStart(),file=path.join(f.store,'state/running',state.dataRootId+'.json');
  const request={confirmed:true,dataRootId:state.dataRootId,descriptorHash:state.descriptorHash,startFingerprint:state.startFingerprint};
  await assert.rejects(f.lifecycle.recoverStart({...request,confirmed:false}));
  await assert.rejects(f.lifecycle.recoverStart({...request,startFingerprint:'different'}),/recovery_target_mismatch/);
  await assert.rejects(f.lifecycle.recoverStart({...request,dataRootId:'f'.repeat(64)}),/data_root_conflict/);
  const noPid={...state};delete noPid.pid;fs.writeFileSync(file,JSON.stringify(noPid));
  await assert.rejects(f.lifecycle.recoverStart(request),/recovery_process_unknown/);
  fs.writeFileSync(file,JSON.stringify({...state,pid:process.pid}));
  await assert.rejects(f.lifecycle.recoverStart(request),/recovery_process_alive/);
  fs.writeFileSync(file,JSON.stringify(state));
  const lease={schemaVersion:1,leaseId:randomUUID(),clientId:'desktop',clientInstanceId:randomUUID(),kind:'desktop',runtimeId:state.receipt?.runtimeId??'blackhole-core',buildId:'a',descriptorHash:state.descriptorHash,dataRootId:state.dataRootId,daemonId:'dead-fixture',issuedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+30000).toISOString()};
  await f.manager.writeLease(lease);
  await assert.rejects(f.lifecycle.recoverStart(request),/active_clients/);
  await f.lifecycle.detach(handle(lease));
  assert.deepEqual(await f.lifecycle.recoverStart(request),{recovered:true});
  assert.equal(await f.lifecycle.inspectStart(),null);
  assert.equal(fs.readdirSync(path.join(f.store,'state/recovered-starts')).length,1);
  assert.deepEqual(await f.lifecycle.recoverStart(request),{recovered:false});
  await assert.rejects(f.lifecycle.attachOrStart(f.request),/kernel_exited/);assert.equal(f.spawns().length,2);
});

test('recovery cannot clear a live managed instance',async(t)=>{
  const f=await fixture(t);await f.lifecycle.attachOrStart(f.request);const state=await f.lifecycle.inspectStart();
  await assert.rejects(f.lifecycle.recoverStart({confirmed:true,dataRootId:state.dataRootId,descriptorHash:state.descriptorHash,startFingerprint:state.startFingerprint}),/daemon_still_running/);
  assert.equal((await f.lifecycle.inspectStart()).startFingerprint,state.startFingerprint);assert.equal(f.spawns().length,1);
});

test('managed browser fallback uses a ticket-free filename, cleans failed launch and never falls back to bootstrap',async(t)=>{
  const f=await fixture(t),attached=await f.lifecycle.attachOrStart(f.request);let file;
  await assert.rejects(openManagedBrowser(f.lifecycle,{handle:handle(attached.lease),port:f.port},async(value)=>{file=value;assert.ok(fs.readFileSync(file,'utf8').includes('a'.repeat(43)));assert.ok(!file.includes('a'.repeat(43)));await f.lifecycle.scheduleRedirectCleanup(handle(attached.lease),file,25);for(let i=0;i<100&&fs.existsSync(file);i++)await pause(20);assert.equal(fs.existsSync(file),false);return false;}),/browser_unavailable/);
  assert.ok(file);assert.equal(fs.existsSync(file),false);assert.equal(f.spawns().length,1);
  await f.lifecycle.detach(handle(attached.lease));
  await assert.rejects(openManagedBrowser(f.lifecycle,{handle:handle(attached.lease),port:f.port},async()=>{throw new Error('opener must not be called');}),/lease_missing/);
});

test('malformed browser ticket responses never leak response text into errors',async(t)=>{
  const f=await fixture(t,{TEST_TICKET_MODE:'invalid'}),attached=await f.lifecycle.attachOrStart(f.request);
  await assert.rejects(openManagedBrowser(f.lifecycle,{handle:handle(attached.lease),port:f.port},async()=>false),err=>err.message==='web_ticket_invalid'&&!err.message.includes('secret-fixture'));
});

test('daemon replacement rejects heartbeat and attach without erasing another live lease',async(t)=>{
  const f=await fixture(t),first=await f.lifecycle.attachOrStart(f.request);
  const health=await(await fetch(`http://127.0.0.1:${f.port}/api/health`)).json();
  await fetch(`http://127.0.0.1:${f.port}/fixture-stop`);
  for(let i=0;i<100;i++){try{await fetch(`http://127.0.0.1:${f.port}/api/health`);}catch{break;}await pause(20);}
  const replacement=http.createServer((_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({...health,daemon_id:'replacement'}));});
  await new Promise(resolve=>replacement.listen(f.port,'127.0.0.1',resolve));
  t.after(()=>{replacement.closeAllConnections();return new Promise(resolve=>replacement.close(resolve));});
  await assert.rejects(f.lifecycle.heartbeat({handle:handle(first.lease),port:f.port}),/core_identity_conflict/);
  await assert.rejects(f.lifecycle.attachOrStart(f.request),/core_identity_conflict/);
  assert.equal(f.manager.liveLeases()[0].expiresAt,first.lease.expiresAt);assert.equal(f.spawns().length,1);
});

test('cold activation validates the candidate and only changes pointers on a proved closed port',async t=>{
  const f=await fixture(t),next=await f.addCore('cold');
  assert.deepEqual(await f.lifecycle.activateColdCore({versionName:next.versionName,port:f.port}),{versionName:next.versionName});
  assert.equal(f.manager.select().versionName,next.versionName);assert.equal(f.spawns().length,0);
});
test('cold activation rejects foreign listeners and leaves both pointers unchanged',async t=>{
  const f=await fixture(t),next=await f.addCore('cold');
  const before=fs.readFileSync(path.join(f.store,'active.json'),'utf8');
  const server=http.createServer((_q,res)=>res.end(JSON.stringify({ok:true,version:'legacy',daemon_id:'legacy'})));
  await new Promise(resolve=>server.listen(f.port,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve))});
  await assert.rejects(f.lifecycle.activateColdCore({versionName:next.versionName,port:f.port}),/managed_core_required/);
  assert.equal(fs.readFileSync(path.join(f.store,'active.json'),'utf8'),before);
  assert.equal(fs.existsSync(path.join(f.store,'known-good.json')),false);assert.equal(f.spawns().length,0);
});
test('cold activation refuses a running record even after the caller detaches',async t=>{
  const f=await fixture(t),first=await f.lifecycle.attachOrStart(f.request),next=await f.addCore('cold');
  await f.lifecycle.detach(handle(first.lease));
  await assert.rejects(f.lifecycle.activateColdCore({versionName:next.versionName,port:f.port}),/daemon_state_unknown/);
  assert.equal(f.manager.select().versionName,f.core.versionName);assert.equal(f.spawns().length,1);
});
test('cold activation rejects tampered candidates and the CLI exposes the same guard',async t=>{
  const f=await fixture(t),next=await f.addCore('cold');fs.appendFileSync(path.join(next.root,'web/index.html'),'tamper');
  const result=await invokeCLI(f,{command:'activate-cold-core',request:{versionName:next.versionName,port:f.port}});
  assert.equal(result.code,1);assert.equal(result.response.ok,false);
  assert.equal(f.manager.select().versionName,f.core.versionName);
});


test('slow first health after our recorded spawn waits without spawning again',async t=>{
  const f=await fixture(t,{TEST_FIRST_HEALTH_DELAY:'2600'});
  const result=await f.lifecycle.attachOrStart({...f.request,readyTimeoutMs:8000});
  assert.equal(result.spawned,true);assert.equal(f.spawns().length,1);
  assert.equal((await f.lifecycle.inspectStart()).status,'ready');
});
const maintenance=(f,attachment,operation='stop')=>({handle:handle(attachment.lease),client:f.request.client,port:f.port,confirmed:true,requestId:randomUUID(),operation});


test('protected maintenance refuses other client leases without posting a grant',async t=>{
 const f=await fixture(t),first=await f.lifecycle.attachOrStart(f.request);
 await f.lifecycle.attachOrStart({...f.request,client:client('vscode')});
 await assert.rejects(f.lifecycle.maintainCore(maintenance(f,first)),/active_clients/);
 assert.equal(fs.existsSync(path.join(f.data,'fixture-maintenance.log')),false);assert.equal(f.spawns().length,1);
});
test('protected stop confirms process exit, archives guard, preserves data and rejects replay',async t=>{
 const f=await fixture(t),first=await f.lifecycle.attachOrStart(f.request),request=maintenance(f,first);
 const pid=(await f.lifecycle.inspectStart()).pid;
 fs.writeFileSync(path.join(f.data,'sentinel.txt'),'keep');
 const result=await f.lifecycle.maintainCore(request);assert.equal(result.operation,'stop');f.deadPids.add(pid);
 assert.equal(await f.lifecycle.inspectStart(),null);assert.equal(f.manager.liveLeases().length,0);
 assert.equal(fs.readFileSync(path.join(f.data,'sentinel.txt'),'utf8'),'keep');
 assert.equal((await f.lifecycle.inspectMaintenance(request.requestId)).state,'completed');
 await assert.rejects(f.lifecycle.maintainCore(request),/maintenance_outcome_requires_inspection/);
 assert.equal(f.spawns().length,1);
});
function idleRequest(f, attachment) {
  return { port: f.port, daemonId: attachment.receipt.daemonId, dataRootId: attachment.receipt.dataRootId,
    descriptorHash: attachment.receipt.descriptorHash, startFingerprint: attachment.receipt.startFingerprint };
}
function ageIdle(f, request, elapsedMs) {
  // Move only the disposable idle marker's timestamp; changing the Manager
  // clock would make signed lifecycle tokens future-dated to the real daemon.
  const file = path.join(f.manager.state, 'idle', request.dataRootId + '.json');
  const marker = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...marker, since: f.manager.clock().getTime() - elapsedMs }) + '\n');
}

test('last managed host leaves: two leases protect Core, then 30-second grace signs a safe Stop', async t => {
  const f = await fixture(t), a = await f.lifecycle.attachOrStart(f.request);
  const b = await f.lifecycle.attachOrStart({ ...f.request, client: client('vscode') });
  const request = idleRequest(f, a), pid = (await f.lifecycle.inspectStart()).pid;
  assert.deepEqual(await f.lifecycle.stopIdleCore(request), { state: 'clients' });
  await f.lifecycle.detach(handle(a.lease));
  assert.deepEqual(await f.lifecycle.stopIdleCore(request), { state: 'clients' });
  await f.lifecycle.detach(handle(b.lease));
  assert.deepEqual(await f.lifecycle.stopIdleCore(request), { state: 'grace' });
  ageIdle(f, request, 29_000);
  assert.deepEqual(await f.lifecycle.stopIdleCore(request), { state: 'grace' });
  assert.equal(fs.existsSync(path.join(f.data, 'fixture-maintenance.log')), false);
  ageIdle(f, request, 31_000);
  assert.deepEqual(await f.lifecycle.stopIdleCore(request), { state: 'stopped' });
  f.deadPids.add(pid);
  assert.equal(await f.lifecycle.inspectStart(), null);
  assert.equal(f.manager.liveLeases().length, 0);
  assert.equal(f.spawns().length, 1, 'never replace the retiring Core');
});

test('VS Code reload during grace resets idle clock; a new host is never stopped', async t => {
  const f = await fixture(t), a = await f.lifecycle.attachOrStart(f.request);
  const request = idleRequest(f, a), pid = (await f.lifecycle.inspectStart()).pid;
  await f.lifecycle.detach(handle(a.lease));
  assert.equal((await f.lifecycle.stopIdleCore(request)).state, 'grace');
  ageIdle(f, request, 29_000);
  const b = await f.lifecycle.attachOrStart({ ...f.request, client: client('vscode') });
  assert.equal((await f.lifecycle.stopIdleCore(request)).state, 'clients');
  await f.lifecycle.detach(handle(b.lease));
  assert.equal((await f.lifecycle.stopIdleCore(request)).state, 'grace', 'new attachment invalidates old idle marker');
  ageIdle(f, request, 29_900);
  assert.equal((await f.lifecycle.stopIdleCore(request)).state, 'grace');
  assert.equal((await f.lifecycle.inspectStart()).pid, pid);
  ageIdle(f, request, 30_100);
  assert.equal((await f.lifecycle.stopIdleCore(request)).state, 'stopped');
  f.deadPids.add(pid);
});

test('active tool/background work does not block auto Stop once all host leases are gone for 30s', async t => {
  const f = await fixture(t), a = await f.lifecycle.attachOrStart(f.request);
  const request = idleRequest(f, a), pid = (await f.lifecycle.inspectStart()).pid;
  fs.writeFileSync(path.join(f.data, 'fixture-work-busy'), '1');
  await f.lifecycle.detach(handle(a.lease));
  assert.equal((await f.lifecycle.stopIdleCore(request)).state, 'grace');
  ageIdle(f, request, 95_000);
  assert.equal((await f.lifecycle.stopIdleCore(request)).state, 'stopped');
  f.deadPids.add(pid);
  assert.equal(await f.lifecycle.inspectStart(), null);
});

test('idle Stop requires exact running incarnation, verified Core and trusted grace', async t => {
  const f = await fixture(t), a = await f.lifecycle.attachOrStart(f.request);
  const request = idleRequest(f, a);
  await f.lifecycle.detach(handle(a.lease));
  assert.equal((await f.lifecycle.stopIdleCore({ ...request, daemonId: 'other-daemon' })).state, 'superseded');
  assert.equal((await f.lifecycle.stopIdleCore(request)).state, 'grace');
  const bad = { ...request, descriptorHash: '0'.repeat(64) };
  ageIdle(f, request, 31_000);
  assert.equal((await f.lifecycle.stopIdleCore(bad)).state, 'superseded');
  assert.equal((await f.lifecycle.stopIdleCore(request)).state, 'stopped');
  f.deadPids.add((f.spawns())[0].pid);
  assert.equal((await f.lifecycle.stopIdleCore(request)).state, 'superseded');
});

test('idle Stop opt-out preserves background Core even after detached client', async t => {
  const f = await fixture(t, { BLACKHOLE_CORE_IDLE_SHUTDOWN: 'off' });
  const a = await f.lifecycle.attachOrStart(f.request);
  await f.lifecycle.detach(handle(a.lease));
  f.tick(120_000);
  assert.equal((await f.lifecycle.stopIdleCore(idleRequest(f, a))).state, 'disabled');
  assert.ok(await f.lifecycle.inspectStart());
  assert.equal(fs.existsSync(path.join(f.data, 'fixture-maintenance.log')), false);
});

test('Manager CLI exposes only a guarded idle proposal and never stops an attached Core', async t => {
  const f = await fixture(t), a = await f.lifecycle.attachOrStart(f.request);
  const request = { command: 'stop-idle-core', request: idleRequest(f, a) };
  const first = await invokeCLI(f, request);
  assert.equal(first.code, 0, JSON.stringify(first.response));
  assert.deepEqual(first.response.result, { state: 'clients' });
  await f.lifecycle.detach(handle(a.lease));
  const second = await invokeCLI(f, request);
  assert.equal(second.code, 0, JSON.stringify(second.response));
  assert.deepEqual(second.response.result, { state: 'grace' });
  assert.equal(fs.existsSync(path.join(f.data, 'fixture-maintenance.log')), false);
});

test('protected restart pins the running version despite an advanced active pointer',async t=>{
 const f=await fixture(t),first=await f.lifecycle.attachOrStart(f.request),next=await f.addCore('newer');
 const pid=(await f.lifecycle.inspectStart()).pid;await f.manager.activate(next.versionName);
 const request=maintenance(f,first,'restart'),result=await f.lifecycle.maintainCore(request);f.deadPids.add(pid);
 assert.equal(result.operation,'restart');assert.notEqual(result.attachment.receipt.daemonId,first.receipt.daemonId);
 assert.equal(result.attachment.receipt.descriptorHash,first.receipt.descriptorHash);
 assert.equal(f.manager.select().versionName,next.versionName);assert.equal(f.spawns().length,2);
 assert.equal(f.manager.liveLeases().length,1);assert.equal((await f.lifecycle.inspectMaintenance(request.requestId)).state,'completed');
});
test('daemon activity refusal preserves its guard and lease without a replacement',async t=>{
 const f=await fixture(t,{TEST_MAINTENANCE_BUSY:'1'}),first=await f.lifecycle.attachOrStart(f.request),request=maintenance(f,first);
 await assert.rejects(f.lifecycle.maintainCore(request),/active_work/);
 assert.equal((await f.lifecycle.inspectMaintenance(request.requestId)).state,'refused');
 assert.equal((await f.lifecycle.inspectStart()).receipt.daemonId,first.receipt.daemonId);
 assert.equal(f.manager.liveLeases().length,1);assert.equal(f.spawns().length,1);
});
test('lost stop response never respawns and retains a GC-protected recovery target',async t=>{
 const f=await fixture(t,{TEST_MAINTENANCE_LOST:'1'}),first=await f.lifecycle.attachOrStart(f.request),request=maintenance(f,first,'restart');
 await assert.rejects(f.lifecycle.maintainCore(request));
 assert.equal((await f.lifecycle.inspectMaintenance(request.requestId)).state,'recovery_required');
 assert.ok(await f.lifecycle.inspectStart());assert.equal(f.spawns().length,1);
 const next=await f.addCore('newer');await f.manager.activate(next.versionName);
 assert.equal(f.manager.retentionSet().has(f.core.versionName),true);
});
test('older Core without protected control cannot be stopped by legacy fallback',async t=>{
 const f=await fixture(t,{TEST_MAINTENANCE_OFF:'1'}),first=await f.lifecycle.attachOrStart(f.request);
 await assert.rejects(f.lifecycle.maintainCore(maintenance(f,first)),/core_update_required/);
 assert.equal(fs.existsSync(path.join(f.data,'fixture-maintenance.log')),false);assert.equal(f.spawns().length,1);
});
test('maintenance rejects wrong binding, expired lease and missing confirmation before network mutation',async t=>{
 const f=await fixture(t),first=await f.lifecycle.attachOrStart(f.request),request=maintenance(f,first);
 await assert.rejects(f.lifecycle.maintainCore({...request,confirmed:false}));
 await assert.rejects(f.lifecycle.maintainCore({...request,client:{...request.client,clientInstanceId:randomUUID()}}),/lease_target_mismatch/);
 f.tick(46000);await assert.rejects(f.lifecycle.maintainCore(request),/lease_expired/);
 assert.equal(fs.existsSync(path.join(f.data,'fixture-maintenance.log')),false);
});

test('maintenance recovery requires positive exit proofs and no leases; never automatically restarts',async t=>{
 const f=await fixture(t,{TEST_MAINTENANCE_LOST:'1'}),first=await f.lifecycle.attachOrStart(f.request),request=maintenance(f,first,'restart');
 const pid=(await f.lifecycle.inspectStart()).pid;await assert.rejects(f.lifecycle.maintainCore(request));
 await assert.rejects(f.lifecycle.attachOrStart(f.request),/maintenance_recovery_required/);
 await assert.rejects(f.lifecycle.recoverMaintenance({requestId:request.requestId,confirmed:true}));
 // Only the test-owned fixture endpoint simulates the already-sealed process exiting.
 await fetch(`http://127.0.0.1:${f.port}/fixture-stop`);
 let dead=false;for(let i=0;i<100;i++){try{process.kill(pid,0)}catch(e){if(e.code==='ESRCH'){dead=true;break}throw e}await pause(25)}
 assert.equal(dead,true);f.deadPids.add(pid);
 await assert.rejects(f.lifecycle.recoverMaintenance({requestId:request.requestId,confirmed:true}),/active_clients/);
 await f.lifecycle.detach(handle(first.lease));
 const result=await f.lifecycle.recoverMaintenance({requestId:request.requestId,confirmed:true});assert.equal(result.restarted,false);
 assert.equal(await f.lifecycle.inspectStart(),null);assert.equal((await f.lifecycle.inspectMaintenance(request.requestId)).state,'recovered_stopped');assert.equal(f.spawns().length,1);
 const next=await f.addCore('post-recovery');await f.manager.activate(next.versionName);assert.equal(f.manager.retentionSet().has(f.core.versionName),true); // still the rollback pointer
 const newer=await f.addCore('post-recovery-2');await f.manager.activate(newer.versionName);assert.equal(f.manager.retentionSet().has(f.core.versionName),false);
});
test('external CLI cannot mint arbitrary lifecycle grants',async t=>{
 const f=await fixture(t);for(const command of ['issue-lifecycle-token','consume-lifecycle-token']){const response=await invokeCLI(f,{command});assert.equal(response.response.error.code,'command_unknown')}
});



test('cold endpoint CAS is canonical across hosts and rejects stale attach without spawning',async t=>{
 const f=await fixture(t),next=await freePort(),original=await f.lifecycle.resolveEndpoint({fallbackPort:f.port});
 const changed=await f.lifecycle.configureEndpoint({confirmed:true,expectedPort:original.port,expectedRevision:original.revision,port:next});
 assert.equal(changed.revision,1);assert.equal(changed.port,next);
 assert.deepEqual((await invokeCLI(f,{command:'resolve-endpoint',request:{fallbackPort:f.port}})).response.result,changed);
 await assert.rejects(f.lifecycle.configureEndpoint({confirmed:true,expectedPort:f.port,expectedRevision:0,port:next}),/endpoint_revision_conflict/);
 await assert.rejects(f.lifecycle.attachOrStart(f.request),/endpoint_changed/);assert.equal(f.spawns().length,0);
 const a=await f.lifecycle.attachOrStart({...f.request,port:next});assert.equal(a.receipt.localUrl,`http://127.0.0.1:${next}/ui/`);
 await assert.rejects(f.lifecycle.configureEndpoint({confirmed:true,expectedPort:next,expectedRevision:1,port:f.port}),/core_stop_required/);
});
test('both channels may resolve 7306 without starting or contacting a daemon',async t=>{
 const f=await fixture(t);
 for(const environment of ['test','production']) {
  const lifecycle=new CoreLifecycle(f.manager,{...f.trust,environment},f.env);
  const endpoint=await lifecycle.resolveEndpoint({fallbackPort:7306});
  assert.equal(endpoint.port,7306);
  assert.equal(endpoint.revision,0);
 }
 assert.equal(f.spawns().length,0);
});

test('cold endpoint rejects unconfirmed, invalid ports and foreign listeners',async t=>{
 const f=await fixture(t),next=await freePort();
 await assert.rejects(f.lifecycle.configureEndpoint({expectedPort:f.port,expectedRevision:0,port:next}));
 // Invalid range is rejected before any network access; never bind/probe the
 // operator's real 7306 service from an isolated test.
 await assert.rejects(f.lifecycle.configureEndpoint({confirmed:true,expectedPort:f.port,expectedRevision:0,port:65536}));
 const server=http.createServer((_q,res)=>res.end('foreign'));await new Promise(r=>server.listen(next,'127.0.0.1',r));
 t.after(()=>{server.closeAllConnections();return new Promise(r=>server.close(r))});
 await assert.rejects(f.lifecycle.configureEndpoint({confirmed:true,expectedPort:f.port,expectedRevision:0,port:next}),/foreign_listener/);
 assert.equal((await f.lifecycle.resolveEndpoint({fallbackPort:f.port})).revision,0);assert.equal(f.spawns().length,0);
});
test('cold endpoint does not bypass a retained unknown maintenance transaction',async t=>{
 const f=await fixture(t,{TEST_MAINTENANCE_LOST:'1'}),a=await f.lifecycle.attachOrStart(f.request),req=maintenance(f,a);
 await assert.rejects(f.lifecycle.maintainCore(req),/maintenance_outcome_unknown/);
 const pending=await f.lifecycle.inspectMaintenances();assert.equal(pending.length,1);assert.equal(pending[0].requestId,req.requestId);
 assert.equal((await invokeCLI(f,{command:'inspect-maintenances'})).response.result[0].requestId,req.requestId);
 await assert.rejects(f.lifecycle.configureEndpoint({confirmed:true,expectedPort:f.port,expectedRevision:0,port:await freePort()}),/maintenance_recovery_required/);
});
test('configuration restart refuses old capability and stale revision before POST',async t=>{
 for(const env of [{TEST_SETTINGS_OFF:'1'},{TEST_HEALTH_OVERRIDE:JSON.stringify({settings_revision:9})}]){
  const f=await fixture(t,env),a=await f.lifecycle.attachOrStart(f.request);
  await assert.rejects(f.lifecycle.maintainCore({...maintenance(f,a,'restart'),settingsRevision:0}),/core_update_required|settings_revision_conflict/);
  assert.equal(fs.existsSync(path.join(f.data,'fixture-maintenance.log')),false);assert.equal(f.spawns().length,1);
 }
});
test('configuration revision is rechecked at the synchronous shutdown seal',async t=>{
 const f=await fixture(t,{TEST_SETTINGS_RACE:'1'}),a=await f.lifecycle.attachOrStart(f.request),req={...maintenance(f,a,'restart'),settingsRevision:0};
 await assert.rejects(f.lifecycle.maintainCore(req),/settings_revision_conflict/);
 assert.equal((await f.lifecycle.inspectMaintenance(req.requestId)).state,'refused');assert.equal(f.spawns().length,1);
 assert.equal((await f.lifecycle.inspectStart()).receipt.daemonId,a.receipt.daemonId);
});
test('configuration restart verifies both boot and current revision on its pinned replacement',async t=>{
 const f=await fixture(t),a=await f.lifecycle.attachOrStart(f.request),req={...maintenance(f,a,'restart'),settingsRevision:0};
 const result=await f.lifecycle.maintainCore(req);assert.notEqual(result.attachment.receipt.daemonId,a.receipt.daemonId);
 assert.equal(result.attachment.receipt.configRevision,0);assert.equal((await f.lifecycle.inspectMaintenance(req.requestId)).state,'completed');
 assert.equal(f.spawns().length,2);
});
test('unconfirmed settings application preserves journal; only exact verified replacement may be acknowledged',async t=>{
 const f=await fixture(t,{TEST_HEALTH_OVERRIDE:JSON.stringify({started_settings_revision:99})}),a=await f.lifecycle.attachOrStart(f.request),req={...maintenance(f,a,'restart'),settingsRevision:0};
 await assert.rejects(f.lifecycle.maintainCore(req),/settings_application_unconfirmed/);
 const current=await f.lifecycle.inspectStart();assert.notEqual(current.receipt.daemonId,a.receipt.daemonId);
 await assert.rejects(f.lifecycle.attachOrStart(f.request),/maintenance_recovery_required/);
 await assert.rejects(f.lifecycle.recoverMaintenance({requestId:req.requestId,confirmed:true}),/recovery_target_mismatch/);
 await assert.rejects(f.lifecycle.recoverMaintenance({requestId:req.requestId,confirmed:true,currentFingerprint:'wrong'}),/recovery_target_mismatch/);
 const recovered=await f.lifecycle.recoverMaintenance({requestId:req.requestId,confirmed:true,currentFingerprint:current.startFingerprint});
 assert.equal(recovered.observed,'running');assert.equal(recovered.restarted,false);
 assert.equal((await f.lifecycle.inspectMaintenance(req.requestId)).state,'recovered_running');assert.equal((await f.lifecycle.inspectMaintenances()).length,0);
 const attached=await f.lifecycle.attachOrStart(f.request);assert.equal(attached.receipt.daemonId,current.receipt.daemonId);assert.equal(f.spawns().length,2);
});

test('a maintenance-only attachment binds an existing ready fingerprint and never cold-starts',async t=>{
 const f=await fixture(t);
 await assert.rejects(f.lifecycle.attachOrStart({...f.request,existingFingerprint:'absent'}),/managed_running_core_required/);assert.equal(f.spawns().length,0);
 const a=await f.lifecycle.attachOrStart(f.request);
 await assert.rejects(f.lifecycle.attachOrStart({...f.request,existingFingerprint:'stale'}),/managed_running_core_required/);
 const admin=await f.lifecycle.attachOrStart({...f.request,existingFingerprint:a.receipt.startFingerprint,client:client()});assert.equal(admin.spawned,false);assert.equal(admin.receipt.daemonId,a.receipt.daemonId);assert.equal(f.spawns().length,1);
});
test('a cold port change refuses a still-live orphan lease even without a run guard',async t=>{
 const f=await fixture(t),a=await f.lifecycle.attachOrStart(f.request);await f.lifecycle.maintainCore(maintenance(f,a));
 f.manager.writeLease(a.lease);
 await assert.rejects(f.lifecycle.configureEndpoint({confirmed:true,expectedPort:f.port,expectedRevision:0,port:await freePort()}),/active_clients/);
 assert.equal((await f.lifecycle.resolveEndpoint({fallbackPort:f.port})).revision,0);
});
test('corrupt canonical endpoint ownership cannot be silently replaced by a host fallback',async t=>{
 const f=await fixture(t),endpoint=await f.lifecycle.resolveEndpoint({fallbackPort:f.port});
 const file=path.join(f.manager.state,'endpoints',endpoint.dataRootId+'.json');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify({...endpoint,dataRootId:'f'.repeat(64)}));
 await assert.rejects(f.lifecycle.resolveEndpoint({fallbackPort:f.port}),/endpoint_state_unknown/);await assert.rejects(f.lifecycle.attachOrStart(f.request),/endpoint_state_unknown/);assert.equal(f.spawns().length,0);
});

test('host-provided Node v2 launches one verified Core without shipping Node, shares with VS Code and stops via Manager',async t=>{
 const f=await fixture(t,{NODE_OPTIONS:'--require definitely-invalid-module',NODE_PATH:'untrusted-path',ELECTRON_RUN_AS_NODE:'poison'},2);
 assert.equal(fs.existsSync(path.join(f.core.root,'node')),false);
 const desktop=await f.lifecycle.attachOrStart(f.request);
 assert.equal(desktop.spawned,true);
 const plugin=await f.lifecycle.attachOrStart({...f.request,client:client('vscode')});
 assert.equal(plugin.spawned,false);
 assert.equal(plugin.receipt.daemonId,desktop.receipt.daemonId);
 assert.equal(f.spawns().length,1);
 const running=await f.lifecycle.inspectStart();
 assert.equal(running.descriptorHash,desktop.receipt.descriptorHash);
 await assert.rejects(f.lifecycle.maintainCore(maintenance(f,desktop)),/active_clients/);
 await f.lifecycle.detach(handle(plugin.lease));
 const stopped=await f.lifecycle.maintainCore(maintenance(f,desktop));
 assert.equal(stopped.operation,'stop');
 f.deadPids.add(running.pid);
 assert.equal(await f.lifecycle.inspectStart(),null);
});

test('seedless Core discovery reuses a signed active v2 but never fabricates a missing Core',async t=>{
 const f=await fixture(t,{},2);
 assert.deepEqual(await f.lifecycle.ensureCore({client:f.request.client,port:f.port}),{versionName:f.core.versionName,reused:true});
 assert.equal(f.spawns().length,0);
 fs.rmSync(path.join(f.store,'active.json'));
 await assert.rejects(f.lifecycle.ensureCore({client:f.request.client,port:f.port}),/core_missing/);
 assert.equal(f.spawns().length,0);
});

test('a provably dead ready Core record after OS shutdown is archived on startup once no peer lease remains',async t=>{
 const f=await fixture(t,{},2);
 const first=await f.lifecycle.attachOrStart(f.request);
 const peer=await f.lifecycle.attachOrStart({...f.request,client:client('vscode')});
 const state=await f.lifecycle.inspectStart();
 await fetch(`http://127.0.0.1:${f.port}/fixture-stop`);
 for(let i=0;i<100;i++){try{await fetch(`http://127.0.0.1:${f.port}/api/health`);}catch{break;}await pause(20);}
 for(let i=0;i<100;i++){try{process.kill(state.pid,0);await pause(20);}catch{break;}}
 f.deadPids.add(state.pid);
 // While another peer still holds a live lease, or when a pinned rebind is requested, do not cold-start.
 await assert.rejects(f.lifecycle.attachOrStart(f.request),/daemon_state_unknown/);
 await assert.rejects(f.lifecycle.attachOrStart({...f.request,existingFingerprint:first.receipt.startFingerprint}),/daemon_state_unknown/);
 await f.lifecycle.detach(handle(peer.lease));
 const restarted=await f.lifecycle.attachOrStart(f.request);
 assert.equal(restarted.spawned,true);
 assert.notEqual(restarted.receipt.daemonId,first.receipt.daemonId);
 assert.equal(fs.readdirSync(path.join(f.store,'state/recovered-starts')).length,1);
 assert.equal(f.spawns().length,2);
});

// ---------------------------------------------------------------------------
// Windows recycles PIDs. After a reboot the number recorded for a killed Core
// can belong to an unrelated live process, which used to make every recovery
// path refuse forever (`daemon_state_unknown`). Death must therefore be proven
// from evidence that is independent of PID existence.
// ---------------------------------------------------------------------------
const runPath = (f, id) => path.join(f.store, 'state', 'running', `${id}.json`);
const beatPath = (f, id) => path.join(f.store, 'state', 'alive', `${id}.json`);
function writeRecord(f, record) { fs.writeFileSync(runPath(f, record.dataRootId), JSON.stringify(record, null, 2) + '\n'); }
function writeHeartbeat(f, state, at, overrides = {}) {
  fs.mkdirSync(path.join(f.store, 'state', 'alive'), { recursive: true });
  fs.writeFileSync(beatPath(f, state.dataRootId), JSON.stringify({ schemaVersion: 1, dataRootId: state.dataRootId,
    startFingerprint: state.startFingerprint, daemonId: state.receipt?.daemonId ?? 'stale', pid: process.pid, at, ...overrides }));
}
/** Stop the fixture Core and release every lease, leaving a stale ready record. */
async function stopAndRelease(f) {
  const state = await f.lifecycle.inspectStart();
  await fetch(`http://127.0.0.1:${f.port}/fixture-stop`).catch(() => {});
  for (let i = 0; i < 100; i++) { try { await fetch(`http://127.0.0.1:${f.port}/api/health`); } catch { break; } await pause(20); }
  for (let i = 0; i < 100; i++) { try { process.kill(state.pid, 0); await pause(20); } catch { break; } }
  f.deadPids.add(state.pid);
  for (const lease of f.manager.liveLeases()) await f.lifecycle.detach(handle(lease));
  return state;
}

test('a recycled PID recorded before this OS boot is archived instead of blocking startup', async (t) => {
  const f = await fixture(t);
  const first = await f.lifecycle.attachOrStart(f.request);
  const state = await stopAndRelease(f);
  // process.pid is alive and is NOT this Core: proof comes only from the boot stamp.
  writeRecord(f, { ...state, pid: process.pid, bootId: 'boot-from-a-previous-session' });
  const restarted = await f.lifecycle.attachOrStart(f.request);
  assert.equal(restarted.spawned, true);
  assert.notEqual(restarted.receipt.daemonId, first.receipt.daemonId);
  assert.equal(fs.readdirSync(path.join(f.store, 'state/recovered-starts')).length, 1);
  assert.equal(f.spawns().length, 2);
});

test('a live PID with a fresh Core heartbeat is never treated as dead', async (t) => {
  const f = await fixture(t);
  await f.lifecycle.attachOrStart(f.request);
  const state = await stopAndRelease(f);
  writeHeartbeat(f, state, Date.now());
  writeRecord(f, { ...state, pid: process.pid, bootId: f.manager.bootIdentity() });
  await assert.rejects(f.lifecycle.attachOrStart(f.request), /daemon_state_unknown/);
  assert.equal(f.spawns().length, 1);
});

test('a Core that stopped refreshing its heartbeat lease is archived', async (t) => {
  const f = await fixture(t);
  const first = await f.lifecycle.attachOrStart(f.request);
  const state = await stopAndRelease(f);
  writeHeartbeat(f, state, Date.now() - 120_000);
  writeRecord(f, { ...state, pid: process.pid, bootId: f.manager.bootIdentity() });
  const restarted = await f.lifecycle.attachOrStart(f.request);
  assert.equal(restarted.spawned, true);
  assert.notEqual(restarted.receipt.daemonId, first.receipt.daemonId);
});

test('a heartbeat left by another incarnation is not evidence about this one', async (t) => {
  const f = await fixture(t);
  await f.lifecycle.attachOrStart(f.request);
  const state = await stopAndRelease(f);
  writeHeartbeat(f, state, Date.now() - 120_000, { startFingerprint: 'some-earlier-incarnation' });
  writeRecord(f, { ...state, pid: process.pid, bootId: f.manager.bootIdentity() });
  // Fresh record + foreign lease: still ambiguous, so still refused.
  await assert.rejects(f.lifecycle.attachOrStart(f.request), /daemon_state_unknown/);
});

test('a slow launch keeps its starting record even when it is older than the lease window', async (t) => {
  const f = await fixture(t);
  const first = await f.lifecycle.attachOrStart(f.request);
  const state = await stopAndRelease(f);
  writeRecord(f, { ...state, status: 'starting', pid: process.pid, bootId: f.manager.bootIdentity() });
  const old = new Date(Date.now() - 600_000);
  fs.utimesSync(runPath(f, state.dataRootId), old, old);
  await assert.rejects(f.lifecycle.attachOrStart(f.request), /daemon_state_unknown/);
  assert.equal(f.spawns().length, 1);
  assert.notEqual(first.receipt.daemonId, undefined);
});

test('recover-start needs proof, refuses live leases, and force only applies to a closed port', async (t) => {
  const f = await fixture(t);
  const first = await f.lifecycle.attachOrStart(f.request);
  const peer = await f.lifecycle.attachOrStart({ ...f.request, client: client('vscode') });
  const state = await f.lifecycle.inspectStart();
  await fetch(`http://127.0.0.1:${f.port}/fixture-stop`).catch(() => {});
  for (let i = 0; i < 100; i++) { try { await fetch(`http://127.0.0.1:${f.port}/api/health`); } catch { break; } await pause(20); }
  for (let i = 0; i < 100; i++) { try { process.kill(state.pid, 0); await pause(20); } catch { break; } }
  f.deadPids.add(state.pid);
  writeHeartbeat(f, state, Date.now());
  writeRecord(f, { ...state, pid: process.pid, bootId: f.manager.bootIdentity() });
  const target = { confirmed: true, dataRootId: state.dataRootId, descriptorHash: state.descriptorHash, startFingerprint: state.startFingerprint };
  await assert.rejects(f.lifecycle.recoverStart(target), /recovery_process_alive/);
  await assert.rejects(f.lifecycle.recoverStart({ ...target, force: true }), /active_clients/);
  await f.lifecycle.detach(handle(first.lease));
  await f.lifecycle.detach(handle(peer.lease));
  assert.deepEqual(await f.lifecycle.recoverStart({ ...target, force: true }), { recovered: true });
  assert.equal(await f.lifecycle.inspectStart(), null);
  assert.equal(fs.existsSync(beatPath(f, state.dataRootId)), false);
});

test('an idle-stop request outlasts a momentarily held store lock instead of deferring', async (t) => {
  const f = await fixture(t);
  const lockDir = path.join(f.store, 'state', 'locks', 'install.lock');
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ schemaVersion: 1, lockId: randomUUID(), pid: process.pid, createdAt: new Date().toISOString() }));
  const release = setTimeout(() => fs.rmSync(lockDir, { recursive: true, force: true }), 600);
  try {
    const { response } = await invokeCLI(f, { command: 'stop-idle-core', request: {
      port: f.port, daemonId: 'not-the-live-core', dataRootId: 'a'.repeat(64),
      descriptorHash: 'b'.repeat(64), startFingerprint: 'fingerprint' } });
    assert.equal(response.ok, true, 'a short lock hold must not turn into a deferred idle stop');
    assert.equal(response.result.state, 'superseded');
  } finally { clearTimeout(release); }
});
