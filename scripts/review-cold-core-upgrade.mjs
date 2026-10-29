// Disposable Test-only cold upgrade: actual signed 0.4.0 -> 0.4.1 Core,
// Manager compare-and-swap and trust rollover. NEVER uses the real HOME,
// installs VSIX, stops a daemon, or connects public channels.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createIsolatedEnv } from './fixtures/isolated-env.mjs';

const [oldArchive,oldPublic,newArchive,newPublic,oldKey='test-review-host-node',newKey='test-review-host-node-041']=process.argv.slice(2);
if(![6,8].includes(process.argv.length) || !/^test[-_]/.test(oldKey) || !/^test[-_]/.test(newKey) || oldKey===newKey) throw Error('usage: node scripts/review-cold-core-upgrade.mjs OLD_ZIP OLD_PUBLIC NEW_ZIP NEW_PUBLIC [OLD_TEST_KEY_ID NEW_TEST_KEY_ID]');
const repo=fileURLToPath(new URL('../',import.meta.url));
const manager=path.join(repo,'packages/host-runtime/dist/core-manager-cli.mjs');
assert.equal(fs.statSync(manager).isFile(),true);
for(const f of [oldArchive,oldPublic,newArchive,newPublic]) assert.equal(fs.statSync(path.resolve(f)).isFile(),true);
const iso=await createIsolatedEnv({name:'cold-core-v041'});
assert.notEqual(iso.port,7306);
const store=path.join(iso.dataDir,'core'),trust=path.join(iso.home,'trust.json');
const publicKeys={
 [oldKey]:fs.readFileSync(path.resolve(oldPublic),'utf8'),
 [newKey]:fs.readFileSync(path.resolve(newPublic),'utf8')
};
fs.writeFileSync(trust,JSON.stringify({environment:'test',publicKeys}),{flag:'wx',mode:0o600});
const env={...iso.env,BH_CORE_STORE:store,BH_CORE_TRUST_CONFIG:trust};
for(const key of ['NODE_OPTIONS','NODE_PATH','ELECTRON_RUN_AS_NODE']) delete env[key];
async function invoke(request) {
 return new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[manager],{cwd:repo,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
  let out='',err='';
  const timer=setTimeout(()=>{child.kill();reject(Error('review_manager_timeout'))},18000);
  child.stdout.on('data',b=>out+=b.toString());
  child.stderr.on('data',b=>err+=b.toString());
  child.on('error',e=>{clearTimeout(timer);reject(e)});
  child.on('close',code=>{
   clearTimeout(timer);
   let parsed;try{parsed=JSON.parse(out.trim())}catch{reject(Error('review_manager_reply_invalid'));return;}
   if(code!==0||parsed.ok!==true){reject(Error('review_manager_refused_'+String(parsed.error?.code||code)));return;}
   resolve(parsed.result);
  });
  child.stdin.end(JSON.stringify(request));
 });
}
let done=false;
try {
 const old=await invoke({command:'provision',archive:path.resolve(oldArchive),source:'seed'});
 assert.ok(['0.4.0','0.4.1','0.4.2'].includes(old.descriptor.runtimeVersion),'exercise an actual previous test release');
 const oldName=`${old.descriptor.runtimeVersion}-${old.descriptor.buildId}`;
 await invoke({command:'activate-cold-core',request:{versionName:oldName,port:iso.port,expectedVersionName:null,expectedDescriptorHash:null}});
 assert.equal((await invoke({command:'select'})).versionName,oldName);
 const next=await invoke({command:'provision',archive:path.resolve(newArchive),source:'seed'});
 assert.equal(next.descriptor.runtimeVersion,JSON.parse(fs.readFileSync(path.join(repo,'package.json'),'utf8')).version);
 assert.equal(next.descriptor.migrationPolicy,'compatible');
 const nextName=`${next.descriptor.runtimeVersion}-${next.descriptor.buildId}`;
 await assert.rejects(invoke({command:'activate-cold-core',request:{versionName:nextName,port:iso.port,
    expectedVersionName:'0.4.0-fake',expectedDescriptorHash:old.descriptorHash}}),/core_selection_changed/);
 assert.equal((await invoke({command:'select'})).versionName,oldName,'refused CAS must not change active');
 await invoke({command:'activate-cold-core',request:{versionName:nextName,port:iso.port,
   expectedVersionName:oldName,expectedDescriptorHash:old.descriptorHash}});
 const selected=await invoke({command:'select'});
 assert.equal(selected.versionName,nextName);
 assert.equal(selected.identity.descriptorHash,next.descriptorHash);
 assert.equal((await invoke({command:'select',pointer:'known-good.json'})).versionName,oldName);
 assert.equal(await invoke({command:'inspect-start'}),null);
 assert.equal(fs.existsSync(iso.dbPath),false,'cold staging must never open a user database');
 done=true;
 console.log(JSON.stringify({ok:true,environment:'disposable-test',port:iso.port,oldVersion:old.descriptor.runtimeVersion,
  newVersion:next.descriptor.runtimeVersion,trustRoots:Object.keys(publicKeys),oneCoreSelected:true,
  guardedCas:true,noDaemonSpawn:true,noDatabaseOpened:true,cleaned:true}));
}finally{if(done)iso.cleanup();else console.error(JSON.stringify({ok:false,isolatedFixtureKept:iso.home,reason:'unknown_maintenance_review_required'}))}
