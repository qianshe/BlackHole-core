// Isolated acceptance for an already running Core 0.4.3 and a newly installed
// VS Code extension 0.4.4. Verifies same daemon, lease renewal beyond the
// original TTL, no duplicate Core, and clean signed Manager shutdown.
// Does NOT touch 7306, the installed main profile, a public channel or login.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createIsolatedEnv } from './fixtures/isolated-env.mjs';
import { auditUniversalVsix } from './audit-universal-vsix.mjs';
import { readArchive } from './core-runtime-lib.mjs';

const repo=fileURLToPath(new URL('../',import.meta.url));
const [oldFile,newFile]=process.argv.slice(2);
if(!oldFile||!newFile||process.argv.length!==4)throw Error('usage: node scripts/host-044-existing-043-acceptance.mjs OLD_043_VSIX NEW_044_VSIX');
// The audit library deliberately checks against CURRENT source package.json
// (0.4.4). For the prior delivered 0.4.3 VSIX compare its exact known
// SHA-256 and pinned immutable Core metadata instead of weakening that audit.
const oldBytes=fs.readFileSync(path.resolve(oldFile));
assert.equal((await import('node:crypto')).createHash('sha256').update(oldBytes).digest('hex'),
 '36e4fc15d8253e23dead3f90125b87eda407e18221d4fe8c4877cb05cb47864d');
const oldZip=await readArchive(path.resolve(oldFile));
const oldManifest=JSON.parse(oldZip.get('extension/package.json').bytes.toString('utf8'));
const oldReference=JSON.parse(oldZip.get('extension/dist/manager/core-bootstrap.json').bytes.toString('utf8'));
const older={version:oldManifest.version,coreVersion:oldReference.runtimeVersion,
 coreCodeBundled:oldReference.source.kind==='embedded',coreArchiveSha256:oldReference.archiveHash};
const newer=await auditUniversalVsix(path.resolve(newFile));
assert.equal(older.version,'0.4.3');
assert.equal(newer.version,'0.4.4');
assert.equal(older.coreVersion,'0.4.3');
assert.equal(newer.coreVersion,'0.4.3');
assert.equal(older.coreCodeBundled,true);
assert.equal(newer.coreCodeBundled,true);
assert.equal(newer.coreArchiveSha256,older.coreArchiveSha256);
const iso=await createIsolatedEnv({name:'existing-core-043-with-host-044'});
assert.notEqual(iso.port,7306);
const store=path.join(iso.dataDir,'core');
const env={...iso.env,BLACKHOLE_HOME:iso.dataDir,BH_CORE_STORE:store,
 APPDATA:path.join(iso.home,'Roaming'),LOCALAPPDATA:path.join(iso.home,'Local'),BLACKHOLE_TUNNEL:'off'};
for(const k of ['NODE_OPTIONS','NODE_PATH','ELECTRON_RUN_AS_NODE','BLACKHOLE_CORE_IDLE_SHUTDOWN'])delete env[k];
const require=createRequire(path.join(repo,'packages/vscode/package.json'));
const {buildSync}=require('esbuild');
const codePath=path.join(iso.home,'adapter.cjs');
buildSync({entryPoints:[path.join(repo,'packages/vscode/src/sharedCoreManager.ts')],outfile:codePath,
 format:'cjs',platform:'node',bundle:true,logLevel:'silent',
 define:{__BLACKHOLE_BUILD__:JSON.stringify((await import('../packages/vscode/build-config.mjs')).resolveBuildConfig('test'))}});
const {SharedCoreManager}=require(codePath);
async function unpack(file,name){
 const root=path.join(iso.home,name);
 fs.mkdirSync(root,{recursive:true});
 for(const [entry,bytes] of await readArchive(path.resolve(file))){
  if(!entry.startsWith('extension/'))continue;
  const relative=entry.slice('extension/'.length),destination=path.resolve(root,...relative.split('/'));
  assert.ok(destination.startsWith(root+path.sep),'unsafe zip entry');
  fs.mkdirSync(path.dirname(destination),{recursive:true});
  fs.writeFileSync(destination,bytes.bytes,{flag:'wx'});
 }
 return {root,packageJSON:JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'))};
}
const old=await unpack(oldFile,'old-vscode-043');
const updated=await unpack(newFile,'new-vscode-044');
const adapters=[];
let started=false,stopped=false;
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const health=async()=>await fetch('http://127.0.0.1:'+iso.port+'/api/health',{signal:AbortSignal.timeout(3500)}).then(async r=>{assert.equal(r.status,200);return r.json()});
const leases=()=>fs.readdirSync(path.join(store,'state','client-leases')).filter(n=>n.endsWith('.json')).map(name=>JSON.parse(fs.readFileSync(path.join(store,'state','client-leases',name),'utf8'))).filter(row=>Date.parse(row.expiresAt)>Date.now());
try{
 // Extension context must be built with the disposable data root environment
 // but Manager child environment is captured by the constructor.
 const save={...process.env};
 try{
  for(const key of Object.keys(process.env))delete process.env[key];
  Object.assign(process.env,env);
  adapters.push(new SharedCoreManager({extensionPath:old.root,extension:{id:'qianshe.blackhole-vscode',packageJSON:old.packageJSON}},{appendLine(){}},()=>{throw Error('offline_old_must_not_download')}));
  adapters.push(new SharedCoreManager({extensionPath:updated.root,extension:{id:'qianshe.blackhole-vscode',packageJSON:updated.packageJSON}},{appendLine(){}},()=>{throw Error('offline_new_must_not_download')}));
 }finally{
  for(const key of Object.keys(process.env))delete process.env[key];
  Object.assign(process.env,save);
 }
 const s0=adapters[0].createSession(()=>{throw Error('unexpected_old_lease_lost')});
 const s1=adapters[1].createSession(()=>{throw Error('unexpected_new_lease_lost')});
 const initial=await s0.attach(iso.port);started=true;
 assert.equal((await health()).daemon_id,initial.daemonId);
 assert.equal((await health()).version,'0.4.3');
 const next=await s1.attach(iso.port);
 assert.equal(next.daemonId,initial.daemonId);
 assert.equal(next.descriptorHash,initial.descriptorHash);
 assert.equal(next.dataRootId,initial.dataRootId);
 assert.equal(s1.bindingState,'bound');
 assert.equal(leases().length,2);
 const fingerprint=initial.startFingerprint;
 // Wait past the original 45s lease TTL so timer-based renewals must work.
 await wait(52_000);
 const h=await health();
 assert.equal(h.daemon_id,initial.daemonId,'no daemon restart during host version change');
 assert.equal(h.start_fingerprint,fingerprint);
 assert.equal(path.resolve(h.db_path),path.resolve(iso.dbPath));
 assert.equal(s1.bindingState,'bound','0.4.4 window lease renewed successfully');
 assert.equal(s0.bindingState,'bound','old window lease remains separate');
 const live=leases(); assert.equal(live.length,2,'two host leases must still be live after 45s');
 assert.ok(live.every(l=>Date.parse(l.expiresAt)>Date.now()));
 await adapters[0].close();
 assert.equal(leases().length,1,'closing v043 host must not revoke v044 host');
 assert.equal((await health()).daemon_id,initial.daemonId);
 const stop=await s1.maintain('stop',true);
 assert.equal(stop.operation,'stop');stopped=true;
 assert.equal(await adapters[1].inspectStart(),null);
 await adapters[1].close();
 const db=new DatabaseSync(iso.dbPath);
 try{assert.equal(Object.values(db.prepare('PRAGMA integrity_check').get())[0],'ok');}
 finally{db.close()}
 const result={ok:true,pluginVersions:['0.4.3','0.4.4'],coreVersion:'0.4.3',
  coreHash:newer.coreArchiveSha256,daemonReused:true,leasesLiveAfterOriginalTtl:true,
  waitMs:52_000,newHostBound:true,oldHostCloseKeepsNew:true,
  signedStopConfirmed:true,sqliteIntegrity:'ok',realUserProfileUsed:false,publicChannelStarted:false};
 try{iso.cleanup();result.cleanup='complete';}
 catch(error){if(!['EBUSY','EPERM','ENOTEMPTY'].includes(error?.code))throw error;result.cleanup='deferred_external_file_lock';}
 console.log(JSON.stringify(result));
}catch(error){
 await Promise.allSettled(adapters.map(adapter=>adapter.close()));
 console.error(JSON.stringify({ok:false,started,stopped,reason:String(error.message??error),
  isolatedHome:iso.home,port:iso.port,realUserProfileUsed:false}));
 process.exitCode=1;
}
