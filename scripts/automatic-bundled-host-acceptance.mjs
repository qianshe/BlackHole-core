// Actual signed VSIX Manager + actual VS Code startup adapter + actual Go
// Desktop client. Disposable HOME and loopback only; no main-profile install.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {readArchive,sha256} from './core-runtime-lib.mjs';
import {auditUniversalVsix} from './audit-universal-vsix.mjs';
import {createIsolatedEnv} from './fixtures/isolated-env.mjs';
const repo=fileURLToPath(new URL('../',import.meta.url));
const [vsixArg,oldArg,outArg]=process.argv.slice(2);
if(!vsixArg||!oldArg||!outArg||process.argv.length!==5)throw Error('usage: VSIX OLD_SIGNED_CORE_ZIP NEW_REPORT_DIR');
const vsix=path.resolve(vsixArg),old=path.resolve(oldArg),out=path.resolve(outArg);
const oldDescriptor=JSON.parse((await readArchive(old)).get('core-descriptor.json').bytes);
assert.match(oldDescriptor.runtimeVersion,/^\d+[.]\d+[.]\d+$/);
if(fs.existsSync(out))throw Error('fresh_report_directory_required');fs.mkdirSync(out,{recursive:true});
const audit=await auditUniversalVsix(vsix);assert.equal(audit.coreCodeBundled,true);assert.equal(audit.version,audit.coreVersion);assert.equal(audit.buildEnvironment,'test');
const iso=await createIsolatedEnv({name:'bundled-host'}),ext=path.join(iso.home,'extension');
for(const [name,item]of await readArchive(vsix)){
 if(!name.startsWith('extension/'))continue;
 const dest=path.resolve(ext,...item.name.slice(10).split('/'));assert.ok(dest.startsWith(ext+path.sep));
 fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,item.bytes,{flag:'wx'});
}
const manifest=JSON.parse(fs.readFileSync(path.join(ext,'package.json'),'utf8'));
const oldArchive=path.join(iso.home,'old-core.zip');fs.copyFileSync(old,oldArchive);
const env={...iso.env,BLACKHOLE_HOME:iso.dataDir,APPDATA:path.join(iso.home,'Roaming'),LOCALAPPDATA:path.join(iso.home,'Local')};
for(const key of ['NODE_OPTIONS','NODE_PATH','ELECTRON_RUN_AS_NODE','BH_CORE_STORE','BH_CORE_TRUST_CONFIG'])delete env[key];
const config=path.join(iso.home,'test-config.json');
fs.writeFileSync(config,JSON.stringify({Node:process.execPath,Entry:path.join(ext,'dist/manager/core-manager-cli.mjs'),Store:path.join(iso.dataDir,'core'),TrustConfig:path.join(ext,'dist/manager/trust.json'),OldArchive:oldArchive,OldHash:sha256(fs.readFileSync(oldArchive)),OldVersion:oldDescriptor.runtimeVersion,Version:audit.version,Port:iso.port}));
const goTest=path.join(iso.home,'desktop-client.test.exe');
execFileSync('go',['-C',path.join(repo,'packages/desktop-launcher'),'test','-c','./internal/coremanager','-o',goTest],{cwd:repo,stdio:'inherit',windowsHide:true});
const require=createRequire(path.join(repo,'packages/vscode/package.json'));
const adapterFile=path.join(iso.home,'adapter.cjs');
require('esbuild').buildSync({entryPoints:[path.join(repo,'packages/vscode/src/sharedCoreManager.ts')],outfile:adapterFile,bundle:true,platform:'node',format:'cjs',logLevel:'silent',define:{__BLACKHOLE_BUILD__:JSON.stringify(manifest.blackholeBuild)}});
const {SharedCoreManager}=require(adapterFile);
const before={...process.env};let adapter;
try{for(const key of Object.keys(process.env))delete process.env[key];Object.assign(process.env,env);
 adapter=new SharedCoreManager({extensionPath:ext,extension:{id:'qianshe.blackhole-vscode',packageJSON:manifest}},{appendLine(){}},()=>{throw Error('must_not_download')});
}finally{for(const key of Object.keys(process.env))delete process.env[key];Object.assign(process.env,before)}
const logfile=fs.openSync(path.join(out,'desktop-go.log'),'wx');
const child=spawn(goTest,['-test.run=^TestAutomaticBundledCrossHost$','-test.v'],{cwd:repo,env:{...env,BH_BUNDLED_HOST_TEST_CONFIG:config},stdio:['ignore',logfile,logfile],windowsHide:true});fs.closeSync(logfile);
let exit=null,spawnError;child.on('error',e=>spawnError=e);child.on('close',c=>exit=c);
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function waitFile(name,timeout=60000){const file=path.join(iso.home,name),until=Date.now()+timeout;while(Date.now()<until){if(spawnError)throw spawnError;if(fs.existsSync(file)){try{return JSON.parse(fs.readFileSync(file,'utf8'))}catch{}}if(exit!==null&&exit!==0)throw Error('desktop_test_exit_'+exit);await pause(100)}throw Error('test_wait_timeout:'+name)}
const health=async()=>{const r=await fetch('http://127.0.0.1:'+iso.port+'/api/health',{signal:AbortSignal.timeout(4000)});assert.equal(r.status,200);return r.json()};
const marker=value=>{const db=new DatabaseSync(iso.dbPath);try{db.exec('PRAGMA busy_timeout=5000');if(value)db.prepare("INSERT INTO machine_state(key,value,updated_at) VALUES('auto-upgrade-proof',?,?)").run(value,Date.now());assert.equal(Object.values(db.prepare('PRAGMA integrity_check').get())[0],'ok');return db.prepare("SELECT value FROM machine_state WHERE key='auto-upgrade-proof'").get()?.value}finally{db.close()}};
const session=adapter.createSession(()=>{});let stopped=false;
try{
 const prior=await waitFile('desktop-ready.json');assert.equal(prior.runtimeVersion,oldDescriptor.runtimeVersion);
 assert.equal(marker('retained'),'retained');
 // The original signed 0.4.3 Core can be tested in a synthetic, logged-out
 // HOME without credentials. Its MCP entitlement gate prevents manufacturing
 // a real remote tool call here. A separate signed integration fixture tests
 // the precise positive 409 active_work forced handoff boundary.
 // This is the actual host attach flow, NOT a manual upgrade-core call.
 const ready=await session.attach(iso.port);
 assert.equal(ready.runtimeVersion,audit.coreVersion);assert.notEqual(ready.daemonId,prior.daemonId);
 assert.equal(session.startupUpdateState,'updated');assert.equal((await health()).version,audit.coreVersion);
 fs.writeFileSync(path.join(iso.home,'vscode-updated.json'),JSON.stringify({daemon:ready.daemonId}));
 const peer=await waitFile('desktop-reconnected.json');assert.equal(peer.ok,true);assert.equal(peer.daemonId,ready.daemonId);assert.equal(peer.spawned,false);
 const until=Date.now()+10000;while(exit===null&&Date.now()<until)await pause(100);assert.equal(exit,0);
 await session.renew();assert.equal(session.matchesHealth(await health()),true);
 assert.equal(marker(),'retained');
 await session.maintain('stop',true);stopped=true;await adapter.close();assert.equal(await adapter.inspectStart(),null);assert.equal(marker(),'retained');
 iso.cleanup();const summary={ok:true,artifactSha256:audit.sha256,actualGoDesktopClient:true,actualVSCodeStartupAdapter:true,actualPackagedManager:true,manualUpgradeCalled:false,from:oldDescriptor.runtimeVersion,to:audit.coreVersion,peerVerifiedReconnect:true,legacyStopRefusalReproduced:false,sameDatabasePreserved:true,stoppedAndCleaned:true};
 fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary));
}catch(error){await adapter.close().catch(()=>{});const failure={ok:false,error:error.message,isolatedHome:iso.home,port:iso.port,stopped,desktopExit:exit};fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify(failure,null,2));console.error(JSON.stringify(failure));process.exitCode=1}
