// Actual VSIX installation into a brand-new, disposable VS Code profile.
// Unlike vscode-native-ui-acceptance.mjs, this uses Code.exe --install-extension,
// NOT --extensionDevelopmentPath. Never accesses the working extensions dir.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { CoreManager } from '../packages/host-runtime/dist/core-manager.cjs';
import { createIsolatedEnv } from './fixtures/isolated-env.mjs';
import { auditUniversalVsix } from './audit-universal-vsix.mjs';

const repo=fileURLToPath(new URL('../',import.meta.url));
const [vsixArg, codeArg, reportArg]=process.argv.slice(2);
if(!vsixArg||!codeArg||!reportArg||process.argv.length!==5)
 throw Error('usage: node scripts/vscode-fresh-vsix-install-acceptance.mjs TEST_VSIX CODE_EXE NEW_REPORT_DIR');
const vsix=path.resolve(vsixArg),code=path.resolve(codeArg),out=path.resolve(reportArg);
assert.equal(fs.existsSync(out),false,'new report directory required');
assert.ok(fs.statSync(code).isFile());
const audit=await auditUniversalVsix(vsix);
assert.equal(audit.coreCodeBundled,true);
assert.equal(audit.buildEnvironment,'test');
fs.mkdirSync(out,{recursive:true});
const iso=await createIsolatedEnv({name:'vscode-first-vsix'});
const ud=path.join(iso.home,'vscode-data'),extDir=path.join(iso.home,'extensions');
fs.mkdirSync(path.join(ud,'User'),{recursive:true});
fs.mkdirSync(extDir,{recursive:true});
fs.writeFileSync(path.join(ud,'User','settings.json'),JSON.stringify({
 'blackhole.port':iso.port,'extensions.autoUpdate':false,'telemetry.telemetryLevel':'off',
 'update.mode':'none','workbench.startupEditor':'none'
}),{flag:'wx'});
const env={...iso.env,BLACKHOLE_HOME:iso.dataDir,BH_CORE_STORE:path.join(iso.dataDir,'core'),
 APPDATA:path.join(iso.home,'Roaming'),LOCALAPPDATA:path.join(iso.home,'Local'),
 BH_UI_TEST_PORT:String(iso.port),BH_UI_TEST_DB:iso.dbPath,BH_UI_TEST_VERSION:audit.version,BH_UI_TEST_CORE_VERSION:audit.coreVersion};
for(const key of ['NODE_OPTIONS','NODE_PATH','ELECTRON_RUN_AS_NODE','VSCODE_IPC_HOOK_CLI'])delete env[key];
const baseArgs=['--user-data-dir='+ud,'--extensions-dir='+extDir];
// Windows Code.exe is the graphical entry point. Run its official bundled
// cli.js in ELECTRON_RUN_AS_NODE mode, exactly like bin/code.cmd does.
const codeRoot=path.dirname(code);
const launcher=fs.readFileSync(path.join(codeRoot,'bin','code.cmd'),'utf8');
const cliRelative=launcher.match(/"%~dp0\.\.\\([^"\r\n]+\\resources\\app\\out\\cli[.]js)"/i)?.[1];
assert.ok(cliRelative,'official code.cmd must identify its installed CLI entry');
const cliEntry=path.resolve(codeRoot,cliRelative);
assert.ok(cliEntry.startsWith(codeRoot+path.sep)&&fs.statSync(cliEntry).isFile(),'CLI must remain inside this VS Code installation');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function run(args,name,deadlineMs){
 const file=path.join(out,name+'.log');
 const fd=fs.openSync(file,'wx');
 const child=spawn(code,[cliEntry,...baseArgs,...args],{cwd:repo,env:{...env,ELECTRON_RUN_AS_NODE:'1'},windowsHide:true,stdio:['ignore',fd,fd]});
 fs.closeSync(fd);
 return new Promise((resolve,reject)=>{
  let finished=false;
  const timer=setTimeout(()=>{if(!finished){child.kill();reject(Error(name+'_timeout'))}},deadlineMs);
  child.once('error',err=>{finished=true;clearTimeout(timer);reject(err)});
  child.once('close',exit=>{finished=true;clearTimeout(timer);resolve({exit,log:file})});
 });
}
function blackholeLogs(dir){
 if(!fs.existsSync(dir))return [];
 const files=[];
 for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
  const file=path.join(dir,entry.name);
  if(entry.isDirectory())files.push(...blackholeLogs(file));
  else if(/BlackHole[.]log$/i.test(entry.name))files.push(file);
 }
 return files;
}
let phase='preinstall',installed=false,gui=false,stopped=false;
try{
 const before=fs.readdirSync(extDir);
 assert.equal(before.length,0,'new profile must start with no extensions installed');
 const pre=await run(['--list-extensions','--show-versions'],'before',20_000);
 assert.equal(pre.exit,0,'CLI must read isolated empty profile');
 const outputBefore=fs.readFileSync(pre.log,'utf8');
 assert.doesNotMatch(outputBefore,/qianshe[.]blackhole-vscode/i,'fresh profile must not have BlackHole');
 phase='install';
 const install=await run(['--install-extension',vsix,'--force'],'install',70_000);
 assert.equal(install.exit,0,'VSIX install failed: '+fs.readFileSync(install.log,'utf8').slice(-1200));
 installed=true;
 const after=await run(['--list-extensions','--show-versions'],'after',20_000);
 assert.equal(after.exit,0,'CLI list after install failed');
 const outputAfter=fs.readFileSync(after.log,'utf8');
 assert.match(outputAfter,new RegExp('qianshe[.]blackhole-vscode@'+audit.version.replaceAll('.','[.]'),'i'),
  'real extension list must show installed VSIX/version');
 const candidates=fs.readdirSync(extDir).filter(name=>name.startsWith('qianshe.blackhole-vscode-'));
 assert.equal(candidates.length,1,'exactly one installed BlackHole extension');
 const manifest=JSON.parse(fs.readFileSync(path.join(extDir,candidates[0],'package.json'),'utf8'));
 assert.equal(manifest.version,audit.version);
 assert.equal(manifest.blackholeSharedCore.mode,'host-node');
 async function activateInstalled(name,holdLockMs=0){
 const guiReport=path.join(out,name+'-gui.json'),startupGate=path.join(out,name+'-host-ready.txt');
 let release;
 const gate=new Promise(resolve=>{release=resolve;});
 const manager=new CoreManager(path.join(iso.dataDir,'core'));
 const held=holdLockMs?manager.withLock('install',()=>gate):Promise.resolve();
 let releaseTimer;
 const unlock=(async()=>{
  if(!holdLockMs)return;
  const deadline=Date.now()+30000;
  while(!fs.existsSync(startupGate)&&Date.now()<deadline)await pause(100);
  if(!fs.existsSync(startupGate)){release();return;}
  releaseTimer=setTimeout(release,holdLockMs);
 })();
 // The VS Code extension-test harness only discovers test code in extension
 // development mode. Point that mode at the extension installed by the CLI,
 // not at an unpacked review directory; assert the installed bytes above.
 const child=spawn(code,[...baseArgs,'--extensionDevelopmentPath='+path.join(extDir,candidates[0]),
  '--extensionTestsPath='+path.join(repo,'scripts/fixtures/vscode-ui-acceptance.cjs'),
  '--new-window','--skip-welcome','--skip-release-notes'],
 {cwd:repo,env:{...env,BH_UI_TEST_REPORT:guiReport,...(holdLockMs?{BH_UI_TEST_STARTUP_GATE:startupGate}:{})},windowsHide:true,stdio:['ignore','pipe','pipe']});
 let error='',std='';
 child.stdout.on('data',buf=>{if(std.length<8000)std+=buf.toString()});
 child.stderr.on('data',buf=>{if(error.length<8000)error+=buf.toString()});
 let guiResult;
 try{guiResult=await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{child.kill();reject(Error('fresh_gui_test_timeout'))},95_000);
  child.once('error',err=>{clearTimeout(timer);reject(err)});
  child.once('close',exit=>{clearTimeout(timer);resolve({exit})});
 });}finally{release();await unlock;clearTimeout(releaseTimer);await held;}
 fs.writeFileSync(path.join(out,name+'-gui-host.log'),std+'\n'+error);
 assert.equal(guiResult.exit,0,'real installed extension GUI host failed: '+error.slice(-1200));
 assert.ok(fs.existsSync(guiReport),'installed extension did not produce a GUI result');
 const guiData=JSON.parse(fs.readFileSync(guiReport,'utf8'));
 assert.equal(guiData.ok,true,guiData.error);
 assert.equal(guiData.actualPackagedExtension,true);
 assert.equal(guiData.version,audit.version);
 if(holdLockMs)assert.ok(fs.existsSync(startupGate),'the competing lock must cover real Extension Host startup');
 return guiData;
 }
 async function waitForStop(){
 let closed=false;
 const running=path.join(iso.dataDir,'core','state','running');
 for(const deadline=Date.now()+120_000;Date.now()<deadline;){
  const open=await fetch('http://127.0.0.1:'+iso.port+'/api/health',{signal:AbortSignal.timeout(1600)}).then(r=>r.ok,()=>false);
  const markers=fs.existsSync(running)?fs.readdirSync(running).filter(x=>x.endsWith('.json')):[];
  if(!open&&markers.length===0){closed=true;break}
  await pause(1000);
 }
 assert.equal(closed,true,'Core must auto-stop after isolated installed VS Code host exits');
 }
 phase='activate';
 const first=await activateInstalled('first-install',17000);gui=true;
 phase='first-auto-stop';await waitForStop();stopped=true;
 phase='reinstall';
 const reinstall=await run(['--install-extension',vsix,'--force'],'reinstall',70_000);
 assert.equal(reinstall.exit,0,'closed isolated profile reinstall failed');
 assert.equal(JSON.parse(fs.readFileSync(path.join(extDir,candidates[0],'package.json'),'utf8')).version,audit.version);
 phase='reinstall-activate';
 const second=await activateInstalled('reinstall',17000);
 phase='reinstall-auto-stop';await waitForStop();
 const logs=blackholeLogs(path.join(ud,'logs'));
 assert.ok(logs.length>0,'real Extension Host output must be available for startup error checks');
 const forbidden=/daemon lifecycle failed:|Shared Core bridge failed closed:|Core 更新状态:status_unavailable/;
 for(const file of logs)assert.doesNotMatch(fs.readFileSync(file,'utf8'),forbidden,'unexpected startup error in '+file);
 const db=new DatabaseSync(iso.dbPath);
 try{assert.equal(Object.values(db.prepare('PRAGMA integrity_check').get())[0],'ok')}
 finally{db.close()}
 const result={ok:true,scenario:'VSIX installed into brand-new VS Code profile',
  version:audit.version,sha256:audit.sha256,initialExtensions:0,
  installedViaCodeCli:true,installedVersionVerified:true,realVSCodeUI:true,
  reinstalledViaCodeCli:true,firstInstallStartupLockMs:17000,reinstallStartupLockMs:17000,startupErrors:0,
  firstDaemonId:first.daemonId,reinstalledDaemonId:second.daemonId,
  signedCoreStarted:true,accountState:'logged_out',lastWindowAutoStopped:true,
  sqliteIntegrity:'ok',realAccountUsed:false,mainExtensionsModified:false,publicChannelStarted:false};
 try{iso.cleanup();result.cleanup='complete'}
 catch(err){if(!['EPERM','EBUSY','ENOTEMPTY'].includes(err?.code))throw err;result.cleanup='deferred_external_file_lock'}
 fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify(result,null,2));
 console.log(JSON.stringify(result));
}catch(err){
 const result={ok:false,phase,installed,gui,stopped,code:String(err.message??err),
  isolatedHome:iso.home,port:iso.port,mainExtensionsModified:false};
 fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify(result,null,2));
 console.error(JSON.stringify(result));
 process.exitCode=1;
}
