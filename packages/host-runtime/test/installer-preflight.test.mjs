import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
const { inspectInstallerReadiness, PREFLIGHT_EXIT } = createRequire(import.meta.url)('../dist/installer-preflight.cjs');
function fixture(t) {
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'bh-install-precheck-'));
 t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const root=path.join(home,'.blackhole');
 const env={HOME:home,USERPROFILE:home};
 const canonical=process.platform==='win32'||process.platform==='darwin'?root.toLowerCase():root;
 const id=createHash('sha256').update('blackhole-data-root-v1\0'+canonical).digest('hex');
 const write=(name,data)=>{const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,typeof data==='string'?data:JSON.stringify(data));return file};
 const run=(extra={})=>inspectInstallerReadiness({env,readHealth:async()=>null,...extra});
 return {home,root,env,id,write,run};
}
test('first installation preflight creates no .blackhole, database or Manager state',async t=>{
 const f=fixture(t),result=await f.run();assert.equal(result.code,'ready');assert.equal(result.ok,true);assert.equal(fs.existsSync(f.root),false);
});
test('old 200 instance blocks before copying, without exposing its health payload',async t=>{
 const f=fixture(t);f.write('blackhole.db','data-sentinel');
 const result=await f.run({readHealth:async()=>({status:200,body:JSON.stringify({daemon_id:'old',db_path:path.join(f.root,'blackhole.db'),token:'never-echo-this',version:'0.3.200'})})});
 assert.equal(result.code,'legacy_core_running');assert.equal(PREFLIGHT_EXIT[result.code],41);assert.ok(!JSON.stringify(result).includes('never-echo-this'));assert.equal(fs.readFileSync(path.join(f.root,'blackhole.db'),'utf8'),'data-sentinel');
});
test('all managed live Cores conservatively require protected shutdown',async t=>{
 const f=fixture(t);const result=await f.run({readHealth:async()=>({status:200,body:JSON.stringify({daemon_id:'managed',db_path:path.join(f.root,'blackhole.db'),lifecycle_state:'managed'})})});
 assert.equal(result.code,'core_running');assert.equal(fs.existsSync(f.root),false);
});
test('timeout, malformed or foreign endpoint cannot be interpreted as free',async t=>{
 const f=fixture(t);
 for(const response of [{status:200,body:'garbage'},{status:302,body:'{}'},{status:200,body:'null'}])assert.equal((await f.run({readHealth:async()=>response})).code,'listener_unknown');
 assert.equal((await f.run({readHealth:async()=>{throw Error('timeout')}})).code,'listener_unknown');
});
test('saved custom endpoint is read without writing a default replacement',async t=>{
 const f=fixture(t);const file=f.write('core/state/endpoints/'+f.id+'.json',{schemaVersion:1,dataRootId:f.id,port:18500,revision:3});const before=fs.readFileSync(file);const ports=[];
 const r=await f.run({readHealth:async port=>{ports.push(port);return null}});assert.equal(r.port,18500);assert.deepEqual(ports,[7306,18500]);assert.deepEqual(fs.readFileSync(file),before);
});
test('corrupt journal or endpoint stops installation rather than recovering/deleting it',async t=>{
 const f=fixture(t);const file=f.write('core/state/upgrade/unknown.json','{"state":"unknown"}');const before=fs.readFileSync(file);
 assert.equal((await f.run()).code,'state_unreadable');assert.deepEqual(fs.readFileSync(file),before);
});
test('an unexpired lease blocks installation even without a daemon listener',async t=>{
 const f=fixture(t);f.write('core/state/client-leases/lease.json',{schemaVersion:1,leaseId:randomUUID(),clientId:'vscode:test',clientInstanceId:randomUUID(),kind:'vscode',runtimeId:'blackhole-core',buildId:'test',descriptorHash:'a'.repeat(64),dataRootId:f.id,daemonId:'old',issuedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()});
 assert.equal((await f.run()).code,'active_clients');
});
test('noncanonical inherited root is refused before network access',async t=>{
 const f=fixture(t);const r=await f.run({env:{...f.env,BLACKHOLE_HOME:path.join(f.home,'other')},readHealth:async()=>{assert.fail('must not call network')}});assert.equal(r.code,'state_unreadable');
});

test('actual Manager lock filenames block preflight without stale-lock deletion',async t=>{
 const f=fixture(t);const file=f.write('core/state/locks/install.lock/owner.json',{schemaVersion:1,pid:1});
 const before=fs.readFileSync(file);assert.equal((await f.run()).code,'recovery_required');assert.deepEqual(fs.readFileSync(file),before);
});
test('preflight checks the real singular upgrade journal directory',async t=>{
 const source=fs.readFileSync(new URL('../src/core-lifecycle.ts',import.meta.url),'utf8');
 assert.match(source,/path\.join\(this\.manager\.state, 'upgrade'/);
 const f=fixture(t);f.write('core/state/upgrade/unknown.json','not valid json');assert.equal((await f.run()).code,'state_unreadable');
});
