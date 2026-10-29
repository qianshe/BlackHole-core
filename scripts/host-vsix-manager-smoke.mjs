// Real packaged Manager + signed Core code + actual VS Code adapter (headless).
// This does NOT load the VS Code GUI or execute a native Desktop candidate.
// It prepares only a disposable HOME, and stops via signed Manager maintenance.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { readArchive } from './core-runtime-lib.mjs';
import { auditUniversalVsix } from './audit-universal-vsix.mjs';
import { createIsolatedEnv } from './fixtures/isolated-env.mjs';

const repo=fileURLToPath(new URL('../',import.meta.url));
const require=createRequire(path.join(repo,'packages/vscode/package.json'));
const {buildSync}=require('esbuild');
const [offlineArg,thinArg]=process.argv.slice(2);
if(!offlineArg||!thinArg||process.argv.length!==4)throw Error('usage: node scripts/host-vsix-manager-smoke.mjs OFFLINE_CODE_VSIX THIN_VSIX');
const offline=await auditUniversalVsix(path.resolve(offlineArg));
const thin=await auditUniversalVsix(path.resolve(thinArg));
assert.equal(offline.buildEnvironment,'test');assert.equal(thin.buildEnvironment,'test');
assert.equal(offline.mode,'host-node');assert.equal(offline.coreCodeBundled,true);
assert.equal(thin.mode,'host-node');assert.equal(thin.coreCodeBundled,false);
assert.equal(offline.coreArchiveSha256,thin.coreArchiveSha256);
const iso=await createIsolatedEnv({name:'host-vsix-v2'});
assert.notEqual(iso.port,17306);
const store=path.join(iso.dataDir,'core');
const env={...iso.env,BLACKHOLE_HOME:iso.dataDir,BH_CORE_STORE:store,LOCALAPPDATA:path.join(iso.home,'Local'),APPDATA:path.join(iso.home,'Roaming')};
for(const key of ['NODE_OPTIONS','NODE_PATH','ELECTRON_RUN_AS_NODE'])delete env[key];
const adapters=[],sessions=[];
let ready=false,closed=false;
const cases=[];
const report={actualPackagedManager:true,actualCoreCode:true,actualVSCodeAdapter:true,actualVSCodeUI:false,actualElectronHost:Boolean(process.versions.electron),hostNode:process.versions.node,hostElectron:process.versions.electron??null,nativeDesktopExecuted:false,nodeBundled:false};
async function unpack(file,name){
 const root=path.join(iso.home,name),entries=await readArchive(file);
 for(const [key,entry]of entries){
  if(!key.startsWith('extension/'))continue;
  const relative=entry.name.slice('extension/'.length);
  const dest=path.join(root,...relative.split('/'));fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,entry.bytes,{flag:'wx'});
 }
 return {root,manifest:JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'))};
}
const health=async()=>{
 const res=await fetch(`http://127.0.0.1:${iso.port}/api/health`,{signal:AbortSignal.timeout(3000)});assert.equal(res.status,200);return res.json();
};
const marker=(value)=>{
 const db=new DatabaseSync(iso.dbPath);
 try {
  db.exec('PRAGMA busy_timeout=5000');
  if(value!==undefined)db.prepare("INSERT INTO machine_state(key,value,updated_at) VALUES('host-node-smoke',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(value,Date.now());
  assert.equal(Object.values(db.prepare('PRAGMA integrity_check').get())[0],'ok');
  return db.prepare("SELECT value FROM machine_state WHERE key='host-node-smoke'").get()?.value;
 }finally{db.close();}
};
try {
 const packages=[await unpack(path.resolve(offlineArg),'offline-extension'),await unpack(path.resolve(thinArg),'thin-extension')];
 const module=path.join(iso.home,'adapter.cjs');
 buildSync({entryPoints:[path.join(repo,'packages/vscode/src/sharedCoreManager.ts')],outfile:module,bundle:true,format:'cjs',platform:'node',define:{__BLACKHOLE_BUILD__:JSON.stringify(packages[0].manifest.blackholeBuild)},logLevel:'silent'});
 const {SharedCoreManager}=require(module);
 const previous={...process.env};
 try {
  for(const key of Object.keys(process.env))delete process.env[key];Object.assign(process.env,env);
  for(const p of packages)adapters.push(new SharedCoreManager({extensionPath:p.root,extension:{id:'qianshe.blackhole-vscode',packageJSON:p.manifest}},{appendLine(){}},()=>{throw Error('existing_Core_must_not_download')}));
 } finally {for(const key of Object.keys(process.env))delete process.env[key];Object.assign(process.env,previous);}
 let lost=0;
 for(const adapter of adapters)sessions.push(adapter.createSession(()=>{lost++;}));
 const first=await sessions[0].attach(iso.port);ready=true;
 cases.push('offline v2 package starts under host Node without a bundled runtime');
 const h=await health();assert.equal(h.version,offline.version);assert.equal(h.descriptor_hash,first.descriptorHash);assert.equal(path.resolve(h.db_path),path.resolve(iso.dbPath));
 assert.ok(!fs.existsSync(path.join(store,'versions',offline.coreVersion+'-'+h.build_id,'node')));
 const ui=await fetch(`http://127.0.0.1:${iso.port}/ui/`,{redirect:'manual',signal:AbortSignal.timeout(3000)});assert.ok([200,302].includes(ui.status));
 cases.push('actual signed Core/Web and isolated original-style .blackhole layout verified');
 assert.equal(marker('retained'),'retained');
 const second=await sessions[1].attach(iso.port);assert.equal(second.daemonId,first.daemonId);assert.equal(second.descriptorHash,first.descriptorHash);
 cases.push('thin plugin reuses identical running Core with no download');
 await sessions[0].renew();await sessions[1].renew();assert.equal(lost,0);
 await assert.rejects(sessions[0].maintain('stop',true),/active_clients/);
 cases.push('another active client blocks Stop without interrupting Core');
 await adapters[1].close();assert.equal((await health()).daemon_id,first.daemonId);
 cases.push('closing one plugin detaches only its lease');
 const stop=await sessions[0].maintain('stop',true);assert.equal(stop.operation,'stop');closed=true;
 assert.equal(await adapters[0].inspectStart(),null);
 assert.equal(marker(),'retained');
 cases.push('Manager-confirmed shutdown preserves SQLite contents and integrity');
 await adapters[0].close();
 // Conclusive stop and no guard before removing the disposable environment.
 const listening=await fetch(`http://127.0.0.1:${iso.port}/api/health`,{signal:AbortSignal.timeout(1000)}).then(()=>true,()=>false);
 assert.equal(listening,false);
 for(const adapter of adapters)await adapter.close();
 iso.cleanup();
 console.log(JSON.stringify({ok:true,port:iso.port,cases,report,cleaned:true}));
} catch(error) {
 for(const adapter of adapters)await adapter.close().catch(()=>{});
 console.log(JSON.stringify({ok:false,port:iso.port,error:error instanceof Error?error.message:String(error),ready,stopped:closed,keptFixture:iso.home,report}));
 // Unknown running state is deliberately retained, never force-killed/deleted.
 process.exitCode=1;
}
