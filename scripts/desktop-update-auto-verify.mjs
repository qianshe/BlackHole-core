// Run REAL packaged Windows Desktop + signed Core in a disposable user's
// canonical HOME/.blackhole layout, identical to installed-host storage.
// No installer, registry mutation, real-user credentials or production port.
// Cleanup uses the Manager's guarded stop; on uncertainty keep the whole fixture.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createIsolatedEnv } from './fixtures/isolated-env.mjs';

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('windows_x64_only');
const layout = path.resolve(process.argv[2] ?? '');
if (!fs.existsSync(path.join(layout, 'distribution-audit.json'))) throw new Error('candidate_layout_required');
const audit = JSON.parse(fs.readFileSync(path.join(layout, 'distribution-audit.json'), 'utf8'));
if (audit.environment !== 'test' || audit.kind !== 'unsigned-desktop-candidate') throw new Error('isolated_test_layout_required');
const iso = await createIsolatedEnv({name: 'desktop-update-acceptance'});
if (iso.port === 17306 || iso.port === 7306) throw new Error('reserved_port');
const appDir = path.join(iso.home, 'application');
const store = path.join(iso.dataDir, 'core');
fs.cpSync(layout, appDir, {recursive:true});
const env = {
  ...iso.env,
  HOME:iso.home,
  USERPROFILE:iso.home,
  LOCALAPPDATA:path.join(iso.home, 'Local'),
  APPDATA:path.join(iso.home,'Roaming'),
  BH_CORE_STORE:store,
  BLACKHOLE_HOME:iso.dataDir,
  BLACKHOLE_DB:iso.dbPath,
  BLACKHOLE_PORT:String(iso.port),
  BLACKHOLE_ACCOUNT_SECRETS:'memory',
  BLACKHOLE_ACCOUNT_OFFLINE:'1',
  BLACKHOLE_TUNNEL:'off',
};
for (const key of ['NODE_OPTIONS','NODE_PATH','ELECTRON_RUN_AS_NODE']) delete env[key];
const exe = path.join(appDir, 'blackhole.exe');
const report = {isolation:iso.home, port:iso.port, cases:[]};
let active = false;
async function native(args) {
  return new Promise((resolve,reject)=>{
    const cp=spawn(exe,args,{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='',timedOut=false;
    const timer=setTimeout(()=>{timedOut=true;cp.kill();},60000);
    cp.stdout.on('data',buf=>{stdout+=buf;if(stdout.length>1024*1024){timedOut=true;cp.kill();}});
    cp.stderr.on('data',buf=>{stderr+=buf;if(stderr.length>1024*1024){timedOut=true;cp.kill();}});
    cp.once('error',err=>{clearTimeout(timer);reject(err);});
    cp.once('close',code=>{
      clearTimeout(timer);
      if(timedOut) return reject(new Error('isolated_subprocess_outcome_unknown'));
      let parsed;try{parsed=JSON.parse(stdout)}catch{parsed={raw:stdout.slice(0,1000)}}
      resolve({code,parsed,stderr:stderr.slice(0,800)});
    });
  });
}
function check(label,result,expectedState){
  assert.equal(result.code,0,label+' exit code '+JSON.stringify(result));
  assert.equal(result.parsed.ok,true,label+' status '+JSON.stringify(result));
  if(expectedState) assert.equal(result.parsed.result.state,expectedState,label+' state');
  report.cases.push({name:label,status:'pass',state:expectedState??null});
}
async function health(){
  const response=await fetch('http://127.0.0.1:'+iso.port+'/api/health',{signal:AbortSignal.timeout(5000)});
  assert.equal(response.status,200);
  return response.json();
}
// SQLite WAL/checkpoint can legitimately change raw database bytes on stop.
// Verify logical contents and integrity rather than comparing live file hashes.
function readMarker(value){
  const db=new DatabaseSync(iso.dbPath);
  try {
    db.exec('PRAGMA busy_timeout=5000');
    if(value!==undefined) db.prepare("INSERT INTO machine_state(key,value,updated_at) VALUES('update-smoke-marker',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(value,Date.now());
    const row=db.prepare("SELECT value FROM machine_state WHERE key='update-smoke-marker'").get();
    const integrity=db.prepare('PRAGMA integrity_check').get();
    assert.equal(Object.values(integrity)[0],'ok','SQLite integrity check');
    return row?.value;
  }finally{db.close()}
}
try {
  check('fresh signed Core activation',await native(['--apply-bundled-core','--print']),'activated');
  check('same bundle repeated activation',await native(['--apply-bundled-core','--print']),'unchanged');
  const pointer=JSON.parse(fs.readFileSync(path.join(store,'active.json'),'utf8'));
  assert.equal(pointer.descriptorHash,audit.seedDescriptorHash);
  assert.equal(fs.existsSync(iso.dbPath),false,'provisioning without start should not create DB');
  report.cases.push({name:'cold install signature/data untouched',status:'pass'});

  const first=await native(['--print']);
  check('actual packaged launcher starts managed Core',first);
  active=true;
  const old=await health();
  assert.equal(old.build_id,audit.core.buildId);
  assert.equal(old.descriptor_hash,audit.seedDescriptorHash);
  assert.equal(path.resolve(old.db_path).toLowerCase(),path.resolve(iso.dbPath).toLowerCase());
  const ui=await fetch('http://127.0.0.1:'+iso.port+'/ui/',{signal:AbortSignal.timeout(5000)});
  assert.equal(ui.status,200,'actual signed Web assets should be served');
  report.cases.push({name:'signed Core/Web health, DB path and UI',status:'pass',coreBuildId:old.build_id});

  check('running identical Core remains unchanged',await native(['--apply-bundled-core','--print']),'unchanged');
  const now=await health();
  assert.equal(now.daemon_id,old.daemon_id);
  assert.equal(now.start_fingerprint,old.start_fingerprint);
  const seed=path.join(appDir,'seed','core.zip');
  fs.appendFileSync(seed,Buffer.from('integrity-corruption-for-isolated-smoke'));
  const rejected=await native(['--apply-bundled-core','--print']);
  assert.notEqual(rejected.code,0,'tampered Seed must fail');
  assert.match(rejected.parsed.message??'',/integrity|hash_invalid/i);
  const alive=await health();
  assert.equal(alive.daemon_id,old.daemon_id,'tampering must never stop running Core');
  report.cases.push({name:'tampered bundled Seed refused; old Core remains running',status:'pass'});
  fs.copyFileSync(path.join(layout,'seed','core.zip'),seed);
  assert.equal(readMarker('preserved-across-graceful-core-stop'),'preserved-across-graceful-core-stop');
  const stop=await native(['--stop','--confirm-maintenance','--print']);
  check('Manager protected shutdown after all client leases are released',stop);
  assert.equal(stop.parsed.result.stopped,true);
  active=false;
  let closed=false;
  for(let i=0;i<25;i++){
    try{await health()}catch{closed=true;break}
    await new Promise(resolve=>setTimeout(resolve,150));
  }
  assert.ok(closed,'isolated daemon still responds after confirmed stop');
  assert.equal(readMarker(),'preserved-across-graceful-core-stop','Core user data must remain readable');
  report.cases.push({name:'no dangling listener, SQLite integrity and record preserved',status:'pass'});
  // The test can now be safely removed: the temporary Core is positively dead.
  fs.rmSync(iso.home,{recursive:true,force:true,maxRetries:15,retryDelay:100});
  report.disposition='isolated data removed after Manager-confirmed shutdown';
  console.log(JSON.stringify({ok:true,report}));
}catch(err){
  report.disposition='kept isolated fixture for inspection; no forced process stop';
  report.error=err instanceof Error?err.message:String(err);
  console.log(JSON.stringify({ok:false,report}));
  process.exitCode=1;
}