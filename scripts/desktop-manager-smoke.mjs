// Explicit isolated developer acceptance. Never installs/reloads VS Code,
// uses production keys, contacts the production port, or starts the Desktop UI.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CoreManager } from '../packages/host-runtime/dist/core-manager.cjs';
import { CoreLifecycle } from '../packages/host-runtime/dist/core-lifecycle.cjs';
import { randomUUID } from 'node:crypto';
import { extractVerifiedCoreArchive } from './core-runtime-lib.mjs';

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('windows_x64_acceptance_only');
const args=process.argv.slice(2);
if(args.length!==3)throw new Error('usage: node scripts/desktop-manager-smoke.mjs <test-core.zip> <test-public.pem> <go-test.exe>');
const [archive,publicKey,probe]=args.map(p=>path.resolve(p));
for(const file of [archive,publicKey,probe])if(!fs.statSync(file).isFile())throw new Error('fixture_missing');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'bh-desktop-manager-smoke-'));
const home=path.join(root,'home'),store=path.join(home,'.blackhole','core'),trustFile=path.join(root,'trust.json');
fs.mkdirSync(home,{recursive:true});
const data=path.join(home,'.blackhole');
const manager=new CoreManager(store);
const trust={environment:'test',publicKeys:{'test-local':fs.readFileSync(publicKey,'utf8')}};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
let safeToRemove=true;
try {
  fs.writeFileSync(trustFile,JSON.stringify(trust),{flag:'wx'});
  const provisioned=await manager.provision(archive,'seed',(a,d)=>extractVerifiedCoreArchive(a,d,{...trust,platform:'win32',arch:'x64'}));
  const versionName=provisioned.descriptor.runtimeVersion+'-'+provisioned.descriptor.buildId;
  await manager.activate(versionName);
  const selection=manager.select();
  const node=path.join(selection.root,provisioned.descriptor.nodeEntry);
  const port=await new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(e=>e?reject(e):resolve(p));});});
  if(port===7306)throw new Error('isolated_port_required');
  const entry=fileURLToPath(new URL('../packages/host-runtime/dist/core-manager-cli.mjs',import.meta.url));
  const configFile=path.join(root,'probe.json');
  fs.writeFileSync(configFile,JSON.stringify({Node:node,Entry:entry,Store:store,TrustConfig:trustFile,Port:port}),{flag:'wx'});
  // PATH intentionally has no system Node. Probe and Manager both use absolute
  // paths; only the signed Core's Node is used to start the isolated daemon.
  const env={...process.env,HOME:home,USERPROFILE:home,LOCALAPPDATA:path.join(home,'AppData','Local'),APPDATA:path.join(home,'AppData','Roaming'),BLACKHOLE_HOME:data,BLACKHOLE_DB:path.join(data,'blackhole.db'),BLACKHOLE_PORT:String(port),BLACKHOLE_TUNNEL:'off',BH_DESKTOP_MANAGER_SMOKE_CONFIG:configFile,PATH:path.join(process.env.SystemRoot||'C:\\Windows','System32')};
  delete env.NODE_OPTIONS;delete env.NODE_PATH;delete env.ELECTRON_RUN_AS_NODE;
  const result=await new Promise((resolve,reject)=>{
    const child=spawn(probe,['-test.run=^TestIsolatedManagerCLI$','-test.v','-test.timeout=110s'],{env,stdio:['ignore','pipe','pipe'],windowsHide:true});
    let stdout='',stderr='';child.stdout.on('data',b=>{stdout+=b;if(stdout.length>1024*1024)child.kill();});child.stderr.on('data',b=>{stderr+=b;if(stderr.length>1024*1024)child.kill();});
    child.once('error',reject);child.once('close',code=>resolve({code,stdout,stderr}));
  });
  if(result.code!==0)throw new Error(`desktop_manager_probe_failed:${result.stdout.slice(-6000)}:${result.stderr.slice(-2000)}`);
  const line=result.stdout.split('\n').find(line=>line.includes('DESKTOP_MANAGER_SMOKE='));
  if(!line)throw new Error('desktop_manager_probe_missing_receipt');
  console.log(JSON.stringify({...JSON.parse(line.split('DESKTOP_MANAGER_SMOKE=')[1]),port,noSystemNodePath:true,seedEnvironment:'test',versionName}));
} finally {
  // Records here were created by this one fresh isolated test. Stop only a
  // daemon whose live identities match. Never kill a PID on ambiguous state;
  // leave the isolated directory and report unconfirmed cleanup instead.
  const dir=path.join(store,'state','running');
  if(fs.existsSync(dir))for(const name of fs.readdirSync(dir).filter(n=>n.endsWith('.json'))){
    const record=JSON.parse(fs.readFileSync(path.join(dir,name),'utf8'));
    if(record.port===7306||!path.resolve(record.dbPath).startsWith(path.resolve(root)+path.sep)){safeToRemove=false;continue;}
    try {
      const res=await fetch(`http://127.0.0.1:${record.port}/api/health`,{signal:AbortSignal.timeout(1500)});
      const h=await res.json();
      if(h.start_fingerprint===record.startFingerprint&&h.descriptor_hash===record.descriptorHash&&h.data_root_id===record.dataRootId&&path.resolve(h.db_path)===path.resolve(record.dbPath)) {
        // Managed daemons reject unsigned /api/shutdown by design; stop this
        // isolated daemon through the Manager's signed maintenance grant.
        const lifecycle=new CoreLifecycle(manager,trust,{...process.env,HOME:home,USERPROFILE:home,LOCALAPPDATA:path.join(home,'AppData','Local'),BLACKHOLE_HOME:data,BLACKHOLE_DB:path.join(data,'blackhole.db'),BLACKHOLE_PORT:String(record.port),BLACKHOLE_TUNNEL:'off'});
        const cleanupClient={clientId:'desktop',clientInstanceId:randomUUID(),kind:'desktop',version:'0.3.201',protocol:{min:1,max:1},capabilities:['web-ui']};
        const attached=await lifecycle.attachOrStart({client:cleanupClient,port:record.port,existingFingerprint:record.startFingerprint});
        const lease=attached.lease;
        await lifecycle.maintainCore({handle:{leaseId:lease.leaseId,clientInstanceId:lease.clientInstanceId,daemonId:lease.daemonId,dataRootId:lease.dataRootId,descriptorHash:lease.descriptorHash},client:cleanupClient,port:record.port,confirmed:true,requestId:randomUUID(),operation:'stop'});
      }
    }catch{}
    if(record.pid){
      let alive=true;
      for(let i=0;i<60;i++){try{process.kill(record.pid,0);}catch{alive=false;break;}await pause(50);}
      if(alive)safeToRemove=false;
    }else safeToRemove=false;
  }
  if(safeToRemove)fs.rmSync(root,{recursive:true,force:true,maxRetries:30,retryDelay:100});
  else throw new Error(`isolated_cleanup_unconfirmed:${root}`);
}
