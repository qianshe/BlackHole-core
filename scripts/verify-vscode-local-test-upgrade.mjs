// Cross-version test using real signed bytes from a VSIX. Only a disposable
// HOME and random loopback port are touched. No VS Code GUI or native Desktop
// installer is executed, no real Core/database/channel is stopped or modified.
// Usage: node scripts/verify-vscode-local-test-upgrade.mjs VSIX OLD_SIGNED_CORE_ZIP
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { readArchive, verifyCoreArchive, sha256 } from './core-runtime-lib.mjs';
import { createIsolatedEnv } from './fixtures/isolated-env.mjs';

const [vsixArg,oldArchiveArg]=process.argv.slice(2);
if(process.argv.length!==4||!vsixArg||!oldArchiveArg)
  throw Error('usage: node scripts/verify-vscode-local-test-upgrade.mjs VSIX OLD_CORE_ZIP');
const repo=fileURLToPath(new URL('..',import.meta.url));
const vsix=path.resolve(vsixArg),oldArchive=path.resolve(oldArchiveArg);
const entries=await readArchive(vsix);
const entry=name=>{const match=entries.get(('extension/'+name).toLowerCase());if(!match)throw Error('vsix_entry_missing:'+name);return match.bytes;};
const manifest=JSON.parse(entry('package.json').toString('utf8'));
const bootstrap=JSON.parse(entry('dist/manager/core-bootstrap.json').toString('utf8'));
const trust=JSON.parse(entry('dist/manager/trust.json').toString('utf8'));
const embedded=entry('dist/core/core.zip');
assert.equal(manifest.version,'0.4.6','the corrected Test VSIX must be version 0.4.6');
assert.equal(manifest.blackholeSharedCore?.mode,'host-node');
assert.ok(manifest.contributes?.commands?.some(x=>x.command==='blackhole.applyBundledCoreUpdate'),
  'new Core update action must exist in the installed command palette');
assert.ok(entry('dist/extension.js').includes(Buffer.from('blackhole.applyBundledCoreUpdate')),
  'bundled extension code must implement the update action');
if(manifest.version==='0.4.6'){
  assert.ok(entry('dist/extension.js').includes(Buffer.from('BundledCoreUpdateCoordinator')),
    'host hotfix must have the persistent update coordinator');
  assert.ok(entry('dist/extension.js').includes(Buffer.from('maintenance_idle')),
    'host hotfix must defer Core mutation until the daemon reports idle');
}
assert.equal(bootstrap.source.kind,'embedded');
assert.equal(trust.environment,'test');
assert.ok(Object.keys(trust.publicKeys).includes('test-review-host-node-043'), 'must trust the installed 0.4.3 Test Core');
const iso=await createIsolatedEnv({name:'vscode-046-signed-upgrade'});
assert.notEqual(iso.port,7306);
const manager=path.join(iso.home,'core-manager-cli.mjs');
const stagedZip=path.join(iso.home,'core-046.zip');
const trustPath=path.join(iso.home,'trust.json');
fs.writeFileSync(manager,entry('dist/manager/core-manager-cli.mjs'),{flag:'wx'});
fs.writeFileSync(stagedZip,embedded,{flag:'wx'});
fs.writeFileSync(trustPath,JSON.stringify(trust),{flag:'wx'});
assert.equal(sha256(embedded),bootstrap.archiveHash);
const verifyOptions={environment:'test',platform:'win32',arch:'x64',publicKeys:trust.publicKeys};
const old=await verifyCoreArchive(oldArchive,verifyOptions);
const next=await verifyCoreArchive(stagedZip,verifyOptions);
assert.equal(old.descriptor.runtimeVersion,'0.4.3');
assert.equal(next.descriptor.runtimeVersion,'0.4.6');
assert.equal(next.descriptor.runtimeVersion,manifest.version,'VSIX and bundled Core runtime version must match');
assert.equal(next.descriptorHash,bootstrap.descriptorHash);
assert.equal(next.descriptor.migrationPolicy,'compatible');
assert.equal(old.descriptor.dataSchema.min,1);
assert.equal(next.descriptor.dataSchema.min,1);
const env={...iso.env,BH_CORE_STORE:path.join(iso.dataDir,'core'),BH_CORE_TRUST_CONFIG:trustPath,
  BLACKHOLE_CORE_IDLE_SHUTDOWN:'off'};
for(const name of ['NODE_OPTIONS','NODE_PATH','ELECTRON_RUN_AS_NODE'])delete env[name];
const host=(kind='vscode')=>({
  clientId:kind==='vscode'?'vscode:qianshe.blackhole-vscode':'desktop:fixture',
  clientInstanceId:randomUUID(),kind,version:kind==='vscode'?manifest.version:'0.4.4',
  protocol:{min:1,max:1},capabilities:['web-ui']
});
const handle=lease=>Object.fromEntries(['leaseId','clientInstanceId','daemonId','dataRootId','descriptorHash'].map(key=>[key,lease[key]]));
async function invoke(request,timeoutMs=120000) {
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[manager],{cwd:repo,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
    let out='',err='',done=false;
    const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve(value)};
    const timer=setTimeout(()=>{child.kill();finish(Error('isolated_manager_timeout'))},timeoutMs);
    child.stdout.on('data',chunk=>{out+=chunk;if(out.length>2*1024*1024){child.kill();finish(Error('manager_output_too_large'))}});
    child.stderr.on('data',chunk=>{err+=chunk;if(err.length>4096){child.kill();finish(Error('manager_error_output_too_large'))}});
    child.on('error',error=>finish(error));
    child.on('close',code=>{
      if(done)return;
      let reply;try{reply=JSON.parse(out.trim())}catch{finish(Error('manager_response_invalid'));return}
      if(code!==0||reply.ok!==true){const code=String(reply.error?.code??'manager_failed');finish(Error(code));return}
      finish(null,reply.result);
    });
    child.stdin.on('error',error=>finish(error));
    child.stdin.end(JSON.stringify(request));
  });
}
const localHealth=async()=>{
 const response=await fetch(`http://127.0.0.1:${iso.port}/api/health`,{signal:AbortSignal.timeout(5000)});
 assert.equal(response.status,200);
 return response.json();
};
const readMarker=value=>{
 const db=new DatabaseSync(iso.dbPath);
 try {
   db.exec('PRAGMA busy_timeout=5000');
   if(value!==undefined)
     db.prepare("INSERT INTO machine_state(key,value,updated_at) VALUES('signed-upgrade-smoke',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(value,Date.now());
   assert.equal(Object.values(db.prepare('PRAGMA integrity_check').get())[0],'ok');
   return db.prepare("SELECT value FROM machine_state WHERE key='signed-upgrade-smoke'").get()?.value;
 } finally { db.close() }
};
const oldClient=host('vscode'),peer=host('desktop');
const nameOf=descriptor=>descriptor.runtimeVersion+'-'+descriptor.buildId;
let stopped=false,initial,upgraded,peerAttached,progress='start';
try {
  progress='provision previous signed Core';
  const oldStage=await invoke({command:'provision',archive:oldArchive,source:'seed'});
  assert.equal(oldStage.descriptorHash,old.descriptorHash);
  await invoke({command:'activate-cold-core',request:{versionName:nameOf(old.descriptor),port:iso.port,
    expectedVersionName:null,expectedDescriptorHash:null}});
  initial=await invoke({command:'attach-or-start',request:{client:oldClient,port:iso.port}});
  assert.equal(initial.receipt.runtimeVersion,'0.4.3');
  assert.equal((await localHealth()).version,'0.4.3');
  assert.equal(readMarker('preserved-through-046'),'preserved-through-046');
  progress='verify newer signed candidate and peer lease rejection';
  const staged=await invoke({command:'provision',archive:stagedZip,source:'seed'});
  assert.equal(staged.descriptorHash,next.descriptorHash);
  assert.equal((await localHealth()).version,'0.4.3','staging may not restart or replace the running Core');
  peerAttached=await invoke({command:'attach-or-start',request:{client:peer,port:iso.port}});
  assert.equal(peerAttached.receipt.daemonId,initial.receipt.daemonId);
  const upgradeRequest=()=>({confirmed:true,requestId:randomUUID(),client:oldClient,
    handle:handle(initial.lease),port:iso.port,targetVersionName:nameOf(next.descriptor)});
  await assert.rejects(invoke({command:'upgrade-core',request:upgradeRequest()}),/active_clients/);
  assert.equal((await localHealth()).daemon_id,initial.receipt.daemonId);
  await invoke({command:'detach',handle:handle(peerAttached.lease)});
  peerAttached=null;
  progress='upgrade signed shared Core 0.4.3 to 0.4.6';
  upgraded=await invoke({command:'upgrade-core',request:upgradeRequest()});
  assert.equal(upgraded.state,'committed');
  assert.equal(upgraded.attachment.receipt.runtimeVersion,'0.4.6');
  assert.equal(upgraded.attachment.receipt.descriptorHash,next.descriptorHash);
  assert.notEqual(upgraded.attachment.receipt.daemonId,initial.receipt.daemonId);
  const health=await localHealth();
  assert.equal(health.version,'0.4.6');
  assert.equal(health.descriptor_hash,next.descriptorHash);
  assert.equal(readMarker(),'preserved-through-046');
  const web=await fetch(`http://127.0.0.1:${iso.port}/ui/`,{redirect:'manual',signal:AbortSignal.timeout(5000)});
  assert.ok([200,302].includes(web.status),'signed Web assets must respond after upgrade');
  progress='manager signed Stop and fixture cleanup';
  const stop=await invoke({command:'maintain-core',request:{operation:'stop',
    confirmed:true,requestId:randomUUID(),client:oldClient,
    handle:handle(upgraded.attachment.lease),port:iso.port}});
  assert.equal(stop.stopped,true);
  stopped=true;
  assert.equal(await invoke({command:'inspect-start'}),null);
  assert.equal(readMarker(),'preserved-through-046');
  const live=await fetch(`http://127.0.0.1:${iso.port}/api/health`,{signal:AbortSignal.timeout(900)})
    .then(()=>true,()=>false);
  assert.equal(live,false);
  iso.cleanup();
  console.log(JSON.stringify({ok:true,origin:'real signed VSIX',oldVersion:'0.4.3',newVersion:'0.4.6',
    coreEmbedded:true,peerLeaseRefusal:true,oneSharedCore:true,signedUpgradeCommitted:true,
    databaseIntegrity:true,webAssetsReady:true,stoppedAndCleaned:true,uiAndInstallerNotTested:true},null,2));
} catch(error) {
  // Never kill a possibly still running signed Core or delete an ambiguous
  // transaction. A failed fixture stays inside isolated TEMP for diagnosis.
  console.error(JSON.stringify({ok:false,progress,reason:error instanceof Error?error.message:String(error),
    isolatedHome:iso.home,isolatedPort:iso.port,stopped,hasUpgradeReceipt:Boolean(upgraded)}));
  process.exitCode=1;
}
