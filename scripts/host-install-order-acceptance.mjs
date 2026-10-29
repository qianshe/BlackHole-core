// Test BOTH native Desktop ↔ VSIX-adapter startup orders with the exact same
// 0.4.x signed Core, but never launch the installer, interactive Desktop UI,
// public tunnel, working extension profile or production port.
// This is portable distribution/startup acceptance, NOT Inno install acceptance.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { auditUniversalVsix } from './audit-universal-vsix.mjs';
import { readArchive } from './core-runtime-lib.mjs';
import { createIsolatedEnv } from './fixtures/isolated-env.mjs';
const repo=fileURLToPath(new URL('../',import.meta.url));
const [vsixArg,desktopArg,outArg]=process.argv.slice(2);
if(process.argv.length!==5)throw Error('usage: node scripts/host-install-order-acceptance.mjs REVIEW_VSIX DESKTOP_LAYOUT NEW_REPORT_DIR');
const vsix=path.resolve(vsixArg),desktop=path.resolve(desktopArg),out=path.resolve(outArg);
assert.equal(fs.existsSync(out),false);
const audit=await auditUniversalVsix(vsix);
assert.equal(audit.coreCodeBundled,true);
const nativeAudit=JSON.parse(fs.readFileSync(path.join(desktop,'distribution-audit.json'),'utf8'));
assert.equal(nativeAudit.kind,'unsigned-desktop-candidate');
assert.equal(nativeAudit.environment,'test');
assert.equal(nativeAudit.version,audit.version);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const zip=await readArchive(vsix);
const rawSeed=zip.get('extension/dist/core/core.zip')?.bytes;
assert.ok(rawSeed);
assert.equal(sha(rawSeed),nativeAudit.files['seed/core.zip'],'native and VSIX signed Core must match byte-for-byte');
const reference=JSON.parse(zip.get('extension/dist/manager/core-bootstrap.json').bytes.toString('utf8'));
assert.equal(nativeAudit.seedDescriptorHash,reference.descriptorHash);
const require=createRequire(new URL('../packages/vscode/package.json',import.meta.url));
const { buildSync }=require('esbuild');
fs.mkdirSync(out,{recursive:false});
const reports=[];
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function scenario(order){
 const iso=await createIsolatedEnv({name:'host-order-'+order.replace('First','-first')});
 const store=path.join(iso.dataDir,'core'),app=path.join(iso.home,'installed-desktop'),
  ext=path.join(iso.home,'installed-vscode'),bin=path.join(iso.home,'vscode-adapter.cjs');
 const env={...iso.env,BLACKHOLE_HOME:iso.dataDir,BH_CORE_STORE:store,
   APPDATA:path.join(iso.home,'AppData','Roaming'),LOCALAPPDATA:path.join(iso.home,'AppData','Local'),
   BLACKHOLE_TUNNEL:'off'};
 for(const key of ['NODE_OPTIONS','NODE_PATH','ELECTRON_RUN_AS_NODE','VSCODE_IPC_HOOK_CLI'])delete env[key];
 fs.cpSync(desktop,app,{recursive:true});
 fs.mkdirSync(ext,{recursive:true});
 for(const [key,file] of zip){
  if(!key.startsWith('extension/'))continue;
  const rel=key.slice('extension/'.length),dest=path.resolve(ext,...rel.split('/'));
  assert.ok(dest.startsWith(ext+path.sep),'signed review files must remain inside isolated extension');
  fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,file.bytes,{flag:'wx'});
 }
 const manifest=JSON.parse(fs.readFileSync(path.join(ext,'package.json'),'utf8'));
 buildSync({entryPoints:[path.join(repo,'packages/vscode/src/sharedCoreManager.ts')],
   bundle:true,platform:'node',format:'cjs',outfile:bin,logLevel:'silent',
   define:{__BLACKHOLE_BUILD__:JSON.stringify(manifest.blackholeBuild)}});
 const {SharedCoreManager}=require(bin);
 let adapter,failed,session,actual;
 try{
  const old={...process.env};
  try{
   for(const k of Object.keys(process.env))delete process.env[k];
   Object.assign(process.env,env);
   adapter=new SharedCoreManager(
    {extensionPath:ext,extension:{id:'qianshe.blackhole-vscode',packageJSON:manifest}},
    {appendLine(){}},()=>{throw Error('native_vsix_must_not_download')});
  }finally{for(const k of Object.keys(process.env))delete process.env[k];Object.assign(process.env,old);}
  session=adapter.createSession(()=>{throw Error('unexpected_vscode_lease_lost')});
  const nativeExe=path.join(app,'blackhole.exe');
  const native=async(args)=>{
   const call=spawn(nativeExe,args,{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
   return await new Promise((resolve,reject)=>{
    let output='',err='';
    const timer=setTimeout(()=>reject(Error('desktop_native_probe_timeout')),40_000);
    call.stdout.on('data',b=>{output+=b;if(output.length>1_048_576)reject(Error('native_response_too_large'))});
    call.stderr.on('data',b=>{err+=b;if(err.length>1_048_576)reject(Error('native_stderr_too_large'))});
    call.once('error',e=>{clearTimeout(timer);reject(e)});
    call.once('close',code=>{
      clearTimeout(timer);
      let data;try{data=JSON.parse(output)}catch{reject(Error('desktop_native_invalid_json:'+err.slice(-300)));return}
      if(code!==0||data.ok!==true)reject(Error('desktop_native_failed:'+JSON.stringify(data).slice(-600)));
      else resolve(data);
    });
   });
  };
  const health=async()=>{
   const response=await fetch('http://127.0.0.1:'+iso.port+'/api/health',{signal:AbortSignal.timeout(4000)});
   assert.equal(response.status,200);
   return response.json();
  };
  let firstReceipt,afterReceipt,installation;
  if(order==='desktopFirst'){
   installation=await native(['--apply-bundled-core','--print']);
   assert.equal(installation.result.state,'activated','fresh Desktop selects signed Core cold');
   firstReceipt=(await native(['--print'])).receipt;
   const attach=await session.attach(iso.port);
   assert.equal(attach.daemonId,firstReceipt.daemonId);
   afterReceipt=attach;
  }else if(order==='vscodeFirst'){
   firstReceipt=await session.attach(iso.port);
   installation=await native(['--apply-bundled-core','--print']);
   assert.equal(installation.result.state,'unchanged','Desktop installer must not switch a matching VS Code Core');
   afterReceipt=(await native(['--print'])).receipt;
  }else{
   const receipts=await Promise.all([session.attach(iso.port),native(['--print'])]);
   firstReceipt=receipts[0];afterReceipt=receipts[1].receipt;
  }
  assert.equal(afterReceipt.daemonId,firstReceipt.daemonId);
  assert.equal(afterReceipt.descriptorHash,firstReceipt.descriptorHash);
  assert.equal(afterReceipt.dataRootId,firstReceipt.dataRootId);
  const h=await health();
  assert.equal(h.version,audit.version);
  assert.equal(h.daemon_id,firstReceipt.daemonId);
  assert.equal(h.descriptor_hash,nativeAudit.seedDescriptorHash);
  assert.equal(path.resolve(h.db_path),path.resolve(iso.dbPath));
  const recordDir=path.join(store,'state','running');
  assert.equal(fs.readdirSync(recordDir).filter(name=>name.endsWith('.json')).length,1);
  // Native CLI's --print lease has ended; VS Code owns the remaining lease.
  const leaseDir=path.join(store,'state','client-leases');
  const leases=fs.readdirSync(leaseDir).filter(n=>n.endsWith('.json'));
  assert.equal(leases.length,1,'native one-shot lease released independently of VS Code');
  await session.close();
  session=adapter.createSession(()=>{throw Error('unexpected_vscode_lease_lost')});
  const reopened=await session.attach(iso.port);
  assert.equal(reopened.daemonId,firstReceipt.daemonId,'reinstalled host must reuse the same healthy Core');
  assert.equal(reopened.descriptorHash,firstReceipt.descriptorHash);
  assert.equal((await session.maintain('stop',true)).operation,'stop','clean, signed Manager shutdown');
  assert.equal(await adapter.inspectStart(),null);
  await adapter.close();adapter=undefined;
  const db=new DatabaseSync(iso.dbPath);
  try{assert.equal(Object.values(db.prepare('PRAGMA integrity_check').get())[0],'ok')}
  finally{db.close()}
  actual={ok:true,order,version:audit.version,
   nativeBinaryExecuted:true,nativeInstallerExecuted:false,actualVSCodeAdapter:true,
   sharedDaemon:true,oneRunningCore:true,sharedDatabase:true,leaseIndependent:true,
   hostReattachmentReusedCore:true,
   signedCoreHash:nativeAudit.seedDescriptorHash,stopVerified:true,sqliteIntegrity:'ok',
   realCredentialsUsed:false,productionPortTouched:false};
  try{iso.cleanup();actual.cleanup='complete'}
  catch(e){if(!['EPERM','EBUSY','ENOTEMPTY'].includes(e?.code))throw e;actual.cleanup='deferred_file_lock'}
  return actual;
 }catch(e){
  failed=e;
  await adapter?.close().catch(()=>{});
  // No forced shutdown after unknown outcome. Leave isolated state for review.
  return {ok:false,order,error:String(e.message??e),isolatedHome:iso.home,
   port:iso.port,mainProfileTouched:false};
 }
}
for(const order of ['desktopFirst','vscodeFirst','concurrent']){
 const result=await scenario(order);reports.push(result);
 console.log(JSON.stringify(result));
 if(!result.ok)break;
}
fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify(reports,null,2),{flag:'wx'});
if(reports.length!==3||reports.some(r=>!r.ok))process.exitCode=1;
