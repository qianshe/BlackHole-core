// Purely isolated native cold Core update adapter tests: no user profile or daemon.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const pkg = fileURLToPath(new URL('../package.json', import.meta.url));
const require=createRequire(pkg);
const base=fs.mkdtempSync(path.join(os.tmpdir(),'bh-cold-switch-unit-'));
const compiled=path.join(base,'client.cjs');
buildSync({entryPoints:[fileURLToPath(new URL('../src/sharedCoreManager.ts',import.meta.url))],
  outfile:compiled,bundle:true,platform:'node',format:'cjs',logLevel:'silent'});
const {SharedCoreManager}=require(compiled);
process.on('exit',()=>fs.rmSync(base,{recursive:true,force:true,maxRetries:3,retryDelay:100}));

function setup(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bh-cold-switch-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:100}));
  const ext=path.join(root,'extension'),archive=path.join(ext,'dist/core/core.zip');
  fs.mkdirSync(path.dirname(archive),{recursive:true});
  const contents=Buffer.from('NON-EXECUTABLE TEST DATA FOR ONLY CORE HASH PIN');
  fs.writeFileSync(archive,contents);
  const hash=createHash('sha256').update(contents).digest('hex');
  const descriptorHash='b'.repeat(64);
  const reference={schemaVersion:1,environment:'test',cloudOrigin:'https://test.example.invalid',platform:'win32',arch:'x64',
    runtimeVersion:'0.4.1',buildId:'host-node-041-review-20261017',descriptorHash,
    archiveHash:hash,archiveBytes:contents.length,source:{kind:'embedded'}};
  const context={extensionPath:ext,extension:{id:'test.'+randomUUID(),packageJSON:{version:'0.4.1',blackholeSharedCore:{mode:'host-node'}}}};
  const old={versionName:'0.4.0-host-node-040-review-20261017',identity:{descriptorHash:'a'.repeat(64)}};
  const manager=new SharedCoreManager(context,{appendLine(){}});
  manager.hostCoreReference=()=>reference;
  const calls=[];
  manager.selectActive=async()=>old;
  manager.inspectStart=async()=>null;
  manager.invoke=async request=>{
    calls.push(request);
    if(request.command==='provision')return{descriptorHash,descriptor:{runtimeVersion:reference.runtimeVersion,buildId:reference.buildId}};
    if(request.command==='activate-cold-core')return{versionName:request.request.versionName};
    throw Error('unexpected_manager_mutation');
  };
  return{root,archive,manager,reference,old,calls};
}
test('explicit cold update uses same pinned embedded code, exact previous CAS and no legacy shutdown',async t=>{
 const h=setup(t);
 const name=await h.manager.activateBundledCoreCold(54321);
 assert.equal(name,'0.4.1-host-node-041-review-20261017');
 assert.deepEqual(h.calls.map(x=>x.command),['provision','activate-cold-core']);
 assert.deepEqual(h.calls[1].request,{versionName:name,port:54321,expectedVersionName:h.old.versionName,
   expectedDescriptorHash:h.old.identity.descriptorHash});
 assert.equal(h.calls[0].archive,h.archive);
});
test('a stale signed running guard is never bypassed by cold update',async t=>{
 const h=setup(t);h.manager.inspectStart=async()=>({status:'ready',pid:123});
 await assert.rejects(h.manager.activateBundledCoreCold(54321),/daemon_state_unknown/);
 assert.equal(h.calls.length,0);
});
test('signed reference tamper prevents any Manager provisioning or selector change',async t=>{
 const h=setup(t);fs.writeFileSync(h.archive,'TAMPER');
 await assert.rejects(h.manager.activateBundledCoreCold(54321),/host_core_build_integrity_failed|host_core_file_invalid/);
 assert.equal(h.calls.length,0);
});
test('rejected cold activation never retries, ignores stale user selection or performs a stop',async t=>{
 const h=setup(t);
 h.manager.invoke=async request=>{h.calls.push(request);
  if(request.command==='provision')return{descriptorHash:h.reference.descriptorHash,descriptor:{runtimeVersion:h.reference.runtimeVersion,buildId:h.reference.buildId}};
  if(request.command==='activate-cold-core')throw Error('active_clients');
 };
 await assert.rejects(h.manager.activateBundledCoreCold(54321),/active_clients/);
 assert.deepEqual(h.calls.map(x=>x.command),['provision','activate-cold-core']);
});
