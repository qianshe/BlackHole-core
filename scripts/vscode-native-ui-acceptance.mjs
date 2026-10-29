// Runs two REAL VS Code extension-test hosts against the unchanged VSIX bytes.
// This is not a main-profile install. Cloud/credentials/public channels are off.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { readArchive } from './core-runtime-lib.mjs';
import { auditUniversalVsix } from './audit-universal-vsix.mjs';
import { createIsolatedEnv } from './fixtures/isolated-env.mjs';
const repo=fileURLToPath(new URL('../',import.meta.url));
const [vsixArg,codeArg,outputArg,oldArchiveArg]=process.argv.slice(2);
if(!vsixArg||!codeArg||!outputArg||![5,6].includes(process.argv.length))throw Error('usage: node scripts/vscode-native-ui-acceptance.mjs VSIX CODE_EXE NEW_REPORT_DIR [OLD_SIGNED_CORE_ZIP]');
const out=path.resolve(outputArg),vsix=path.resolve(vsixArg),code=path.resolve(codeArg);
assert.equal(fs.existsSync(out),false,'new report directory required');
assert.ok(fs.statSync(code).isFile());
const audit=await auditUniversalVsix(vsix);
assert.equal(audit.version,JSON.parse(fs.readFileSync(path.join(repo,'package.json'),'utf8')).version);assert.equal(audit.buildEnvironment,'test');assert.equal(audit.coreCodeBundled,true);
fs.mkdirSync(out,{recursive:true});
const iso=await createIsolatedEnv({name:'native-vscode-'+audit.version.replaceAll('.','')});
const ext=path.join(iso.home,'extension'),ud=path.join(iso.home,'vscode-data'),extensions=path.join(iso.home,'extensions');
for(const dir of [ext,path.join(ud,'User'),extensions])fs.mkdirSync(dir,{recursive:true});
for(const [key,entry]of await readArchive(vsix)){
 if(!key.startsWith('extension/'))continue;
 const relative=entry.name.slice('extension/'.length),dest=path.resolve(ext,...relative.split('/'));
 assert.ok(dest.startsWith(ext+path.sep));
 fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,entry.bytes,{flag:'wx'});
}
fs.writeFileSync(path.join(ud,'User/settings.json'),JSON.stringify({'blackhole.port':iso.port,'extensions.autoUpdate':false,'telemetry.telemetryLevel':'off','update.mode':'none','workbench.startupEditor':'none'}));
const manifest=JSON.parse(fs.readFileSync(path.join(ext,'package.json'),'utf8'));
const env={...iso.env,BLACKHOLE_HOME:iso.dataDir,BH_CORE_STORE:path.join(iso.dataDir,'core'),
 APPDATA:path.join(iso.home,'Roaming'),LOCALAPPDATA:path.join(iso.home,'Local'),
 BH_UI_TEST_PORT:String(iso.port),BH_UI_TEST_DB:iso.dbPath,BH_UI_TEST_VERSION:audit.version,BH_UI_TEST_CORE_VERSION:audit.coreVersion};
for(const key of ['NODE_OPTIONS','NODE_PATH','ELECTRON_RUN_AS_NODE','VSCODE_IPC_HOOK_CLI'])delete env[key];
const reports=[];let stopped=false,priorReceipt;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
try{
 if(oldArchiveArg){
  const manager=path.join(ext,'dist/manager/core-manager-cli.mjs');
  const seed=path.join(iso.home,'previous-core.zip');fs.copyFileSync(path.resolve(oldArchiveArg),seed);
  const seedEnv={...env,BLACKHOLE_CORE_IDLE_SHUTDOWN:'off',BH_CORE_TRUST_CONFIG:path.join(ext,'dist/manager/trust.json')};
  const invoke=request=>{
   const result=JSON.parse(execFileSync(process.execPath,[manager],{cwd:repo,env:seedEnv,input:JSON.stringify(request),encoding:'utf8',windowsHide:true,timeout:90000}));
   assert.equal(result.ok,true);return result.result;
  };
  const staged=invoke({command:'provision',source:'seed',archive:seed});
  assert.equal(staged.descriptor.runtimeVersion,'0.4.3');
  const versionName=staged.descriptor.runtimeVersion+'-'+staged.descriptor.buildId;
  invoke({command:'activate-cold-core',request:{versionName,port:iso.port,expectedVersionName:null,expectedDescriptorHash:null}});
  const client={clientId:'native-ui-upgrade-fixture',clientInstanceId:randomUUID(),kind:'vscode',version:audit.version,protocol:{min:1,max:1},capabilities:['web-ui']};
  const old=invoke({command:'attach-or-start',request:{client,port:iso.port}});
  priorReceipt=old.receipt;
  invoke({command:'detach',handle:Object.fromEntries(['leaseId','clientInstanceId','daemonId','dataRootId','descriptorHash'].map(key=>[key,old.lease[key]]))});
  const db=new DatabaseSync(iso.dbPath);
  try{db.prepare("INSERT INTO machine_state(key,value,updated_at) VALUES('native-upgrade-proof','retained',?)").run(Date.now());}finally{db.close()}
 }
 for(const phase of ['startup','pause-recovery','reload']){
  const report=path.join(out,phase+'.json'),log=fs.openSync(path.join(out,phase+'.log'),'wx');
  const child=spawn(code,[`--user-data-dir=${ud}`,`--extensions-dir=${extensions}`,`--extensionDevelopmentPath=${ext}`,
   `--extensionTestsPath=${path.join(repo,'scripts/fixtures/vscode-ui-acceptance.cjs')}`,'--new-window','--skip-welcome','--skip-release-notes'],
   {cwd:repo,env:{...env,BLACKHOLE_CORE_IDLE_SHUTDOWN:'on',BH_UI_TEST_REPORT:report,
     BH_UI_TEST_SAMPLE_COUNT:phase==='startup'?'13':phase==='pause-recovery'?'7':'8',
     BH_UI_TEST_SAMPLE_DELAY:phase==='startup'?'4000':phase==='pause-recovery'?'3000':'750',
     BH_UI_TEST_STALL_MS:phase==='pause-recovery'?'50000':'0'},windowsHide:false,stdio:['ignore',log,log]});
  fs.closeSync(log);let exit=null,spawnError;
  child.once('error',e=>{spawnError=e;});child.once('close',c=>{exit=c;});
  const deadline=Date.now()+95000;
  while(Date.now()<deadline){
   if(spawnError)throw spawnError;
   if(fs.existsSync(report)&&exit!==null)break;
   if(exit!==null&&exit!==0&&!fs.existsSync(report))throw Error('vscode_test_host_exit_'+exit);
   await pause(300);
  }
  assert.ok(fs.existsSync(report),'real VS Code did not produce '+phase+' result');
  const result=JSON.parse(fs.readFileSync(report,'utf8'));
  assert.equal(result.ok,true,result.error);
  assert.equal(exit,0,'test host must exit normally before reload/cleanup');
  reports.push({phase,...result});
 }
 for(const report of reports)assert.equal(report.daemonId,reports[0].daemonId,'reloading or pausing the extension must reuse the same compatible Core');
 assert.equal(reports.find(r=>r.phase==='pause-recovery')?.expiredLeaseRecovered,true);
 assert.equal(reports.find(r=>r.phase==='pause-recovery')?.postRecoveryRenewalObserved,true);
 if(priorReceipt)assert.notEqual(reports[0].daemonId,priorReceipt.daemonId,'activation must replace the older Core without a manual upgrade command');
 // Real GUI exit must release leases; Manager will wait 30 seconds then sign the safe Stop.
 const guardDir=path.join(iso.dataDir,'core/state/running');
 const until=Date.now()+120000;
 while(Date.now()<until){
  const alive=await fetch('http://127.0.0.1:'+iso.port+'/api/health',{signal:AbortSignal.timeout(2000)}).then(r=>r.ok,()=>false);
  const guards=fs.existsSync(guardDir)?fs.readdirSync(guardDir).filter(n=>n.endsWith('.json')):[];
  if(!alive&&guards.length===0){stopped=true;break;}
  await pause(1000);
 }


 assert.equal(stopped,true,'Core must exit and archive its run record after the last GUI host');
 const db=new DatabaseSync(iso.dbPath);
 try{
  assert.equal(Object.values(db.prepare('PRAGMA integrity_check').get())[0],'ok');
  if(priorReceipt)assert.equal(db.prepare("SELECT value FROM machine_state WHERE key='native-upgrade-proof'").get()?.value,'retained');
 }finally{db.close();}
 const result={ok:true,artifactSha256:audit.sha256,actualVSCodeUI:true,actualPackagedExtension:true,
  extensionVersion:audit.version,coreVersion:audit.coreVersion,port:iso.port,phases:reports,reloadReusedCore:true,
  ...(priorReceipt?{automaticUpgradeFrom:priorReceipt.runtimeVersion,automaticUpgradeTo:audit.coreVersion,manualUpgradeCommandUsed:false,databaseMarkerPreserved:true}:{}),
  publicChannelStarted:false,realUserCredentialsUsed:false,coreStoppedByManager:stopped,autoStoppedAfterLastWindow:true};
 // Input methods may leave an unrelated log open even after both test
 // windows and the signed Core exited. Report cleanup separately; never kill
 // an operator's IME or mislabel passing runtime checks as a product failure.
 try { iso.cleanup(); result.cleanup='complete'; }
 catch(error) {
  if(!['EBUSY','EPERM','ENOTEMPTY'].includes(error?.code)) throw error;
  result.cleanup='deferred_external_file_lock';result.cleanupPath=iso.home;
 }
 fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify(result,null,2),{flag:'wx'});
 console.log(JSON.stringify(result));
}catch(error){
 const result={ok:false,error:String(error.message),isolatedHome:iso.home,port:iso.port,stopped,completedPhases:reports};
 fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify(result,null,2));
 console.error(JSON.stringify(result));process.exitCode=1;
}
