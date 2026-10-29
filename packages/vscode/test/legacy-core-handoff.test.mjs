// Native legacy handoff only. All fixtures are synthetic and never contact the real 7306.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fs.mkdtempSync(path.join(os.tmpdir(),'bh-legacy-040-handoff-'));
const file = path.join(root,'handoff.cjs');
buildSync({entryPoints:[fileURLToPath(new URL('../src/legacyCoreHandoff.ts',import.meta.url))],outfile:file,bundle:true,platform:'node',format:'cjs',logLevel:'silent'});
const { stopLegacyForHandoff } = createRequire(import.meta.url)(file);
process.on('exit',()=>fs.rmSync(root,{recursive:true,force:true}));

function fixture(t) {
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'bh-legacy-040-test-'));
  t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
  const db=path.join(tmp,'.blackhole','blackhole.db');
  fs.mkdirSync(path.dirname(db),{recursive:true});
  fs.writeFileSync(db,'unchanged');
  const health={ok:true,version:'0.3.200',daemon_id:'legacy-fixture',start_fingerprint:'original',db_path:db,sessions_running:0,approvals_pending:0};
  let reads=0,shutdowns=0;
  const calls=[];
  const api={
    async health(){reads++;return structuredClone(health)},
    async listSessions(port){assert.equal(port,54321,'session activity must use the target port even if window config changes');return {sessions:[{status:'active',activity:'idle'}]}},
    async shutdown(id,fp,port){shutdowns++;calls.push({id,fp,port});return{ok:true}}
  };
  const approval=async()=>true;
  return{db,health,api,approval,calls,get reads(){return reads},get shutdowns(){return shutdowns}};
}
test('single approved identity-bound legacy stop permits retry only after two positive closure observations',async t=>{
 const f=fixture(t), probes=[false,true,true];
 const ok=await stopLegacyForHandoff(f.api,54321,f.db,f.approval,async()=>probes.shift()??true);
 assert.equal(ok,true);assert.equal(f.reads,2);assert.equal(f.shutdowns,1);
 assert.deepEqual(f.calls,[{id:'legacy-fixture',fp:'original',port:54321}]);
 assert.equal(fs.readFileSync(f.db,'utf8'),'unchanged');
});
test('active work, pending approvals or running sessions refuse before any user approval or shutdown',async t=>{
 const f=fixture(t);let approvals=0;
 for(const key of ['sessions_running','approvals_pending']){
   f.health[key]=1;
   await assert.rejects(stopLegacyForHandoff(f.api,54321,f.db,async()=>{approvals++;return true},async()=>true),/active_work/);
   f.health[key]=0;
 }
 f.api.listSessions=async()=>({sessions:[{status:'active',activity:'running'}]});
 await assert.rejects(stopLegacyForHandoff(f.api,54321,f.db,async()=>{approvals++;return true},async()=>true),/active_work/);
 assert.equal(approvals,0);assert.equal(f.shutdowns,0);
});
test('foreign, managed, unknown-activity and wrong-database listeners cannot be stopped',async t=>{
 const f=fixture(t);
 for(const changes of [
   {version:'0.4.0'}, {lifecycle_state:'managed'}, {start_fingerprint:''}, {sessions_running:undefined}, {db_path:path.join(f.db,'wrong')}
 ]){
   const before={...f.health};Object.assign(f.health,changes);
   await assert.rejects(stopLegacyForHandoff(f.api,54321,f.db,f.approval,async()=>true));
   Object.assign(f.health,before);
 }
 assert.equal(f.shutdowns,0);
});
test('cancel and changed identity refuse without a shutdown',async t=>{
 const f=fixture(t);
 assert.equal(await stopLegacyForHandoff(f.api,54321,f.db,async()=>false,async()=>true),false);
 f.api.health=async()=>{const row={...f.health};if(++f.healthReads===2)row.daemon_id='replacement';return row;};
 f.healthReads=0;
 await assert.rejects(stopLegacyForHandoff(f.api,54321,f.db,f.approval,async()=>true),/legacy_core_identity_changed/);
 assert.equal(f.shutdowns,0);
});
test('lost stop acknowledgement and unproven closure never spawn or retry',async t=>{
 const f=fixture(t);
 f.api.shutdown=async()=>{f.calls.push('one');throw Error('unknown_shutdown_response');};
 await assert.rejects(stopLegacyForHandoff(f.api,54321,f.db,f.approval,async()=>true),/unknown_shutdown_response/);
 assert.equal(f.calls.length,1);
});
