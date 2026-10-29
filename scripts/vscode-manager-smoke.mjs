// Isolated headless integration: actual VSIX adapter + packaged Desktop CLI + real signed Core.
// Does not install/reload VS Code, open GUI, edit HKCU, or use a real profile/production listener.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { verifyCoreArchive } from './core-runtime-lib.mjs';
const ROOT=fileURLToPath(new URL('../',import.meta.url));
const require=createRequire(path.join(ROOT,'packages/vscode/package.json'));
const {buildSync}=require('esbuild');
if(process.platform!=='win32'||process.arch!=='x64')throw Error('windows_x64_only');
if(process.argv.length!==5)throw Error('usage: node scripts/vscode-manager-smoke.mjs <test-seed.zip> <public.pem> <test-desktop-blackhole.exe>');
const [archive,keyFile,desktop]=process.argv.slice(2).map(p=>path.resolve(p));
const expectedLauncher='998b29ceb348c9ecc44f9edbd221e154a926eb8c0c3a3ff48c8a83dafab5295b';
const actualLauncher=createHash('sha256').update(fs.readFileSync(desktop)).digest('hex');
const releasePolicy=JSON.parse(fs.readFileSync(path.join(ROOT,'release/desktop-gates.json'),'utf8'));
if(releasePolicy.blockedArtifactSha256.includes(actualLauncher))throw Error('blocked_desktop_fixture');
if(actualLauncher!==expectedLauncher){
 // Fresh candidates require explicit reviewed-source approval, not an
 // arbitrary environment-supplied executable hash or renamed AV sample.
 const gate=spawnSync(process.execPath,[path.join(ROOT,'scripts/desktop-release-gate.mjs'),'--mode','candidate'],{cwd:ROOT,encoding:'utf8',windowsHide:true,timeout:20000});
 if(gate.status!==0)throw Error('use_reviewed_test_desktop_fixture');
 const audit=JSON.parse(fs.readFileSync(path.join(path.dirname(desktop),'distribution-audit.json'),'utf8'));
 if(audit.environment!=='test'||audit.kind!=='unsigned-desktop-candidate'||audit.launcherSha256!==actualLauncher||audit.files?.['seed/core.zip']!==createHash('sha256').update(fs.readFileSync(archive)).digest('hex'))throw Error('candidate_fixture_identity_mismatch');
}
const trust={environment:'test',publicKeys:{'test-local':fs.readFileSync(keyFile,'utf8')}};
const verified=await verifyCoreArchive(archive,{...trust,platform:'win32',arch:'x64'});
const root=fs.mkdtempSync(path.join(os.tmpdir(),'bh-vscode-manager-')),home=path.join(root,'home'),data=path.join(home,'.blackhole'),store=path.join(data,'core'),extension=path.join(root,'extension');
const port=await new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(e=>e?reject(e):resolve(p))})});
if(port===7306)throw Error('isolated_port_required');
const env={...process.env,HOME:home,USERPROFILE:home,LOCALAPPDATA:path.join(home,'AppData','Local'),APPDATA:path.join(home,'AppData','Roaming'),BH_CORE_STORE:store,BLACKHOLE_HOME:data,BLACKHOLE_DB:path.join(data,'blackhole.db'),BLACKHOLE_PORT:String(port),BLACKHOLE_TUNNEL:'off',BLACKHOLE_ACCOUNT_OFFLINE:'1',BLACKHOLE_ACCOUNT_SECRETS:'memory',BLACKHOLE_SEMANTIC:'off'};
for(const name of ['NODE_OPTIONS','NODE_PATH','ELECTRON_RUN_AS_NODE'])delete env[name];
fs.mkdirSync(home,{recursive:true});
for(const dir of ['dist/manager','dist/seed-core'])fs.mkdirSync(path.join(extension,dir),{recursive:true});
fs.copyFileSync(path.join(ROOT,'packages/host-runtime/dist/core-manager-cli.mjs'),path.join(extension,'dist/manager/core-manager-cli.mjs'));
fs.copyFileSync(archive,path.join(extension,'dist/seed-core/core-win32-x64.zip'));
fs.writeFileSync(path.join(extension,'dist/seed-core/trust.json'),JSON.stringify(trust));
const bundle=path.join(root,'adapter.cjs');
buildSync({entryPoints:[path.join(ROOT,'packages/vscode/src/sharedCoreManager.ts')],outfile:bundle,bundle:true,format:'cjs',platform:'node',define:{__BLACKHOLE_BUILD__:JSON.stringify({environment:'test',origin:verified.descriptor.cloudOrigin})},logLevel:'silent'});
const {SharedCoreManager}=require(bundle);
const adapters=[];let safeToRemove=true;let primaryFailure;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function desktopAttach(){
 return new Promise((resolve,reject)=>{
  const child=spawn(desktop,['--print'],{env,stdio:['ignore','pipe','pipe'],windowsHide:true});let out='',err='';
  const timer=setTimeout(()=>reject(Error('desktop_probe_timeout_unknown_outcome')),90000);
  child.stdout.on('data',b=>{out+=b;if(out.length>1024*1024){clearTimeout(timer);reject(Error('desktop_probe_output_too_large'))}});
  child.stderr.on('data',b=>{err+=b;if(err.length>1024*1024){clearTimeout(timer);reject(Error('desktop_probe_output_too_large'))}});
  child.once('error',e=>{clearTimeout(timer);reject(e)});
  child.once('close',code=>{clearTimeout(timer);try{const result=JSON.parse(out);if(code!==0||!result.ok)throw Error('desktop_probe_failed:'+String(result.message||result.code).slice(0,250));resolve(result.receipt)}catch(e){reject(e)}});
 });
}
const health=async()=>{const response=await fetch(`http://127.0.0.1:${port}/api/health`,{redirect:'error',signal:AbortSignal.timeout(3000)});assert.equal(response.status,200);return response.json()};
try {
 const first=await desktopAttach();
 // Construct each adapter with the exact isolated environment, then immediately restore ours.
 const before={...process.env};
 try {
  for(const k of Object.keys(process.env))delete process.env[k];Object.assign(process.env,env);
  for(let i=0;i<2;i++)adapters.push(new SharedCoreManager({extensionPath:extension,extension:{id:'fixture.vscode',packageJSON:{version:'adapter-next',blackholeSharedCore:{mode:'bridge'}}}},{appendLine(){}}));
 } finally {for(const k of Object.keys(process.env))delete process.env[k];Object.assign(process.env,before)}
 let lost=0;const sessions=adapters.map(a=>a.createSession(()=>{lost++}));
 const receipts=[];
 for(const session of sessions)receipts.push(await session.attach(port));
 for(const receipt of receipts){assert.equal(receipt.daemonId,first.daemonId);assert.equal(receipt.descriptorHash,first.descriptorHash);assert.equal(receipt.dataRootId,first.dataRootId)}
 assert.notEqual(adapters[0].clientInstanceId,adapters[1].clientInstanceId);
 const leaseDir=path.join(store,'state/client-leases');
 const live=()=>fs.readdirSync(leaseDir).filter(f=>f.endsWith('.json')).map(f=>JSON.parse(fs.readFileSync(path.join(leaseDir,f),'utf8'))).filter(l=>Date.parse(l.expiresAt)>Date.now());
 const initial=live();assert.equal(initial.length,2);
 // Exceed the original 45-second TTL: startup-only write-lease cannot pass.
 await delay(50_000);
 assert.equal(lost,0);const renewed=live();assert.equal(renewed.length,2);
 for(const lease of renewed)assert.ok(Date.parse(lease.expiresAt)>Date.parse(initial.find(x=>x.leaseId===lease.leaseId).expiresAt));
 const current=await health();assert.equal(sessions.every(s=>s.matchesHealth(current)),true);
 await adapters[0].close();assert.equal(live().length,1);assert.equal((await health()).daemon_id,first.daemonId);
 await adapters[1].close();assert.equal(live().length,0);assert.equal((await health()).daemon_id,first.daemonId);
 const again=await desktopAttach();assert.equal(again.daemonId,first.daemonId);
 console.log(JSON.stringify({ok:true,port,daemonId:first.daemonId,descriptorHash:first.descriptorHash,dataRootId:first.dataRootId,actualVSCodeAdapter:true,actualDesktopCLI:true,desktopFirst:true,twoExtensionHostInstances:true,renewedBeyondInitialTTL:true,independentDetach:true,desktopReattachPreservedCore:true,actualVSCodeUI:false,installerExecuted:false}));
} catch(error) { primaryFailure=error; throw error; } finally {
 for(const adapter of adapters)await adapter.close().catch(()=>{});
 const runningDir=path.join(store,'state/running');
 if(fs.existsSync(runningDir))for(const name of fs.readdirSync(runningDir).filter(n=>n.endsWith('.json'))){
  const record=JSON.parse(fs.readFileSync(path.join(runningDir,name),'utf8'));
  if(record.port!==port||port===7306||!path.resolve(record.dbPath).startsWith(root+path.sep)){safeToRemove=false;continue}
  try {const h=await health();if((record.status==='starting'||h.daemon_id===record.receipt?.daemonId)&&h.start_fingerprint===record.startFingerprint&&h.descriptor_hash===record.descriptorHash&&h.data_root_id===record.dataRootId&&path.resolve(h.db_path)===path.resolve(record.dbPath)){
   // Managed daemons reject unsigned /api/shutdown by design; stop this
   // isolated daemon through the Manager CLI's signed maintenance grant.
   const { spawnSync } = await import('node:child_process');
   const trustFile=path.join(root,'cleanup-trust.json');fs.writeFileSync(trustFile,JSON.stringify(trust));
   const managerCli=(request)=>{const r=spawnSync(process.execPath,[path.join(ROOT,'packages/host-runtime/dist/core-manager-cli.mjs')],{input:JSON.stringify(request),encoding:'utf8',env:{...env,BH_CORE_TRUST_CONFIG:trustFile},maxBuffer:4*1024*1024});const parsed=JSON.parse(r.stdout);if(r.status!==0||!parsed.ok)throw Error('cleanup_manager_failed:'+r.stdout);return parsed.result};
   const cleanupClient={clientId:'vscode',clientInstanceId:randomUUID(),kind:'vscode',version:'0.3.201',protocol:{min:1,max:1},capabilities:['web-ui']};
   const attached=managerCli({command:'attach-or-start',request:{client:cleanupClient,port,existingFingerprint:record.startFingerprint}});
   const lease=attached.lease;
   managerCli({command:'maintain-core',request:{handle:{leaseId:lease.leaseId,clientInstanceId:lease.clientInstanceId,daemonId:lease.daemonId,dataRootId:lease.dataRootId,descriptorHash:lease.descriptorHash},client:cleanupClient,port,confirmed:true,requestId:randomUUID(),operation:'stop'}});
  }}catch{}
  if(!record.pid){safeToRemove=false;continue}
  let dead=false;for(let i=0;i<100;i++){try{process.kill(record.pid,0)}catch(e){if(e.code==='ESRCH')dead=true;break}await delay(50)}
  if(!dead)safeToRemove=false;
 }
 if(safeToRemove)fs.rmSync(root,{recursive:true,force:true,maxRetries:30,retryDelay:100});
 else throw new AggregateError(primaryFailure?[primaryFailure]:[],'isolated_cleanup_unconfirmed:'+root);
}
