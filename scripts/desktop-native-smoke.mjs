// Real packaged native entry, but no UI/installer/registry or real-user state.
// Removing a copied shell directory below is NOT Inno uninstall acceptance.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createIsolatedEnv } from './fixtures/isolated-env.mjs';
import { CoreManager } from '../packages/host-runtime/dist/core-manager.cjs';

if(process.platform!=='win32'||process.arch!=='x64')throw new Error('windows_x64_only');
if(process.argv.length!==3)throw new Error('usage: node scripts/desktop-native-smoke.mjs <unsigned-test-desktop-layout>');
const source=path.resolve(process.argv[2]);
const audit=JSON.parse(fs.readFileSync(path.join(source,'distribution-audit.json'),'utf8'));
if(audit.environment!=='test'||audit.kind!=='unsigned-desktop-candidate')throw new Error('test_candidate_required');
const iso=await createIsolatedEnv({name:'desktop-native'}),root=iso.home,store=path.join(root,'Core'),app=path.join(root,'app');
const env={...iso.env,BLACKHOLE_HOME:iso.dataDir,LOCALAPPDATA:path.join(root,'AppData/Local'),APPDATA:path.join(root,'AppData/Roaming'),BH_CORE_STORE:store,PATH:path.join(process.env.SystemRoot||'C:\\Windows','System32'),NODE_OPTIONS:'--require definitely-not-allowed',NODE_PATH:'must-not-be-used',ELECTRON_RUN_AS_NODE:'1'};
const manager=new CoreManager(store),pause=ms=>new Promise(r=>setTimeout(r,ms));
let safeToRemove=true;
async function execute(executable,args,input,customEnv=env){
 return new Promise((resolve,reject)=>{
  const child=spawn(executable,args,{env:customEnv,stdio:['pipe','pipe','pipe'],windowsHide:true});let out='',err='',exceeded=false;
  const timer=setTimeout(()=>{exceeded=true;child.kill();},120000);
  child.stdout.on('data',b=>{out+=b;if(out.length>1024*1024){exceeded=true;child.kill();}});
  child.stderr.on('data',b=>{err+=b;if(err.length>1024*1024){exceeded=true;child.kill();}});
  child.once('error',e=>{clearTimeout(timer);reject(e)});child.once('close',code=>{clearTimeout(timer);if(exceeded)return reject(new Error('native_outcome_unknown'));let result;try{result=JSON.parse(out)}catch{}resolve({code,result,stderr:err.slice(-2000)});});
  child.stdin.on('error',()=>{});child.stdin.end(input??'');
 });
}
async function native(args=['--print'],customEnv=env,location=app){return execute(path.join(location,'blackhole.exe'),args,undefined,customEnv)}
async function cli(request){const clean={...env,BH_CORE_TRUST_CONFIG:path.join(app,'bootstrap/trust.json')};for(const key of Object.keys(clean))if(['NODE_OPTIONS','NODE_PATH','ELECTRON_RUN_AS_NODE'].includes(key.toUpperCase()))delete clean[key];const r=await execute(path.join(app,'bootstrap/node.exe'),[path.join(app,'bootstrap/core-manager-cli.mjs')],JSON.stringify(request),clean);assert.equal(r.code,0,JSON.stringify(r));assert.equal(r.result.ok,true);return r.result.result;}
async function health(){const response=await fetch(`http://127.0.0.1:${iso.port}/api/health`,{signal:AbortSignal.timeout(2000)});assert.equal(response.status,200);return response.json()}
const handle=lease=>Object.fromEntries(['leaseId','clientInstanceId','daemonId','dataRootId','descriptorHash'].map(key=>[key,lease[key]]));
try{
 fs.cpSync(source,app,{recursive:true});
 let result=await native(['--provision-only','--print']);assert.equal(result.code,0,JSON.stringify(result));assert.equal(result.result.provisioned,true);
 assert.ok(manager.select());assert.equal(fs.existsSync(path.join(store,'state/running')),false);
 result=await native();assert.equal(result.code,0,JSON.stringify(result));const first=result.result.receipt;
 assert.equal(first.environment,'test');assert.equal(first.descriptorHash,audit.seedDescriptorHash);assert.equal((await health()).daemon_id,first.daemonId);assert.equal(manager.liveLeases().length,0);
 const other=await cli({command:'attach-or-start',request:{client:{clientId:'vscode-native-smoke',clientInstanceId:randomUUID(),kind:'vscode',version:audit.version,protocol:{min:1,max:1},capabilities:['web-ui']},port:iso.port}});
 assert.equal(other.spawned,false);assert.equal(other.receipt.daemonId,first.daemonId);
 result=await native();assert.equal(result.code,0,JSON.stringify(result));assert.equal(result.result.receipt.daemonId,first.daemonId);assert.equal(manager.liveLeases().length,1);
 await cli({command:'heartbeat',request:{handle:handle(other.lease),port:iso.port}});
 // A broken/missing Seed must not replace an already verified compatible Core.
 const seed=path.join(app,'seed/core.zip');fs.appendFileSync(seed,'tamper');
 result=await native();assert.equal(result.code,0,JSON.stringify(result));assert.equal(result.result.receipt.descriptorHash,first.descriptorHash);
 result=await native(['--provision-only','--print'],{...env,BH_CORE_STORE:path.join(root,'BadCore')});assert.notEqual(result.code,0);assert.match(result.result.message,/core_seed_hash_invalid/);
 fs.rmSync(seed);result=await native();assert.equal(result.code,0,JSON.stringify(result));assert.equal(result.result.receipt.daemonId,first.daemonId);
 fs.copyFileSync(path.join(source,'seed/core.zip'),seed);
 // Every executable trust input is compiler-pinned; no legacy/PATH retry.
 for(const name of ['bootstrap/node.exe','bootstrap/core-manager-cli.mjs','bootstrap/trust.json']){
  const file=path.join(app,name);fs.appendFileSync(file,'tamper');result=await native();assert.notEqual(result.code,0);assert.match(result.result.message,/distribution_integrity_failed/);fs.copyFileSync(path.join(source,name),file);assert.equal((await health()).daemon_id,first.daemonId);
 }
 result=await native(['--stop','--print']);assert.notEqual(result.code,0);assert.match(result.result.message,/managed_stop_not_available/);
 result=await native(['--legacy-dev','--print']);assert.notEqual(result.code,0);assert.match(result.stderr,/legacy_runtime_disabled/);
 result=await native(['--repair-start','--confirm-repair','--print']);assert.notEqual(result.code,0);assert.match(result.result.message,/daemon_still_running/);
 assert.equal((await health()).daemon_id,first.daemonId);
 await cli({command:'heartbeat',request:{handle:handle(other.lease),port:iso.port}});
 const replacement=path.join(root,'replacement-app');fs.cpSync(source,replacement,{recursive:true});result=await native(['--print'],env,replacement);assert.equal(result.code,0,JSON.stringify(result));assert.equal(result.result.receipt.daemonId,first.daemonId);fs.rmSync(replacement,{recursive:true,force:true,maxRetries:20,retryDelay:100});
 await cli({command:'detach',handle:handle(other.lease)});assert.equal(manager.liveLeases().length,0);
 fs.rmSync(app,{recursive:true,force:true,maxRetries:20,retryDelay:100});
 assert.equal((await health()).daemon_id,first.daemonId);assert.ok(fs.existsSync(iso.dbPath));assert.ok(fs.existsSync(path.join(store,'active.json')));
 console.log(JSON.stringify({ok:true,port:iso.port,daemonId:first.daemonId,descriptorHash:first.descriptorHash,dataRootId:first.dataRootId,noSystemNodePath:true,nativeEntry:true,offlineSeedProvision:true,sharedClientReuse:true,tamperRejected:true,seedDeferredForReuse:true,quitPreservedDaemon:true,shellReplacementPreservedCore:true,shellRemovalPreservedCore:true,nativeUIAccepted:false,installerAccepted:false}));
}finally{
 const dir=path.join(store,'state/running');
 if(fs.existsSync(dir))for(const name of fs.readdirSync(dir).filter(name=>name.endsWith('.json'))){
  const record=JSON.parse(fs.readFileSync(path.join(dir,name),'utf8'));
  if(record.port===7306||!path.resolve(record.dbPath).startsWith(path.resolve(root)+path.sep)){safeToRemove=false;continue;}
  try{const h=await health();if(h.start_fingerprint===record.startFingerprint&&h.descriptor_hash===record.descriptorHash&&h.data_root_id===record.dataRootId&&path.resolve(h.db_path)===path.resolve(record.dbPath))await fetch(`http://127.0.0.1:${record.port}/api/shutdown`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({daemon_id:h.daemon_id,start_fingerprint:h.start_fingerprint}),signal:AbortSignal.timeout(2000)}).catch(()=>{});}catch{}
  if(record.pid){let alive=true;for(let i=0;i<60;i++){try{process.kill(record.pid,0)}catch(e){if(e.code==='ESRCH'){alive=false;break}}await pause(50)}if(alive)safeToRemove=false;}else safeToRemove=false;
 }
 if(safeToRemove)fs.rmSync(root,{recursive:true,force:true,maxRetries:30,retryDelay:100});else throw new Error(`isolated_cleanup_unconfirmed:${root}`);
}
