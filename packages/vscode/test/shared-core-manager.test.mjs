import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildSync } from 'esbuild';

test('bridge adapter and lease use the sole user-profile root and shared Manager store',async(t)=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'bh-bridge-identity-'));
  const keys=['HOME','USERPROFILE','BLACKHOLE_HOME','BLACKHOLE_DB','BH_CORE_STORE','BLACKHOLE_SHARED_BIN'];
  const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  for(const key of keys)delete process.env[key];
  process.env.HOME=temp;process.env.USERPROFILE=temp;
  t.after(()=>{for(const key of keys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}fs.rmSync(temp,{recursive:true,force:true});});
  const bundle=path.join(temp,'adapter.cjs');
  buildSync({entryPoints:[fileURLToPath(new URL('../src/sharedCoreManager.ts',import.meta.url))],outfile:bundle,bundle:true,platform:'node',format:'cjs',logLevel:'silent'});
  const {SharedCoreManager,compareCoreVersions}=createRequire(import.meta.url)(bundle);
  assert.equal(compareCoreVersions('0.4.5','0.4.3'),1);
  assert.equal(compareCoreVersions('0.4.3','0.4.5'),-1);
  assert.equal(compareCoreVersions('0.4.3','0.4.3'),0);
  assert.throws(()=>compareCoreVersions('0.4.3-beta','0.4.3'),/core_version_format_unsupported/);
  const context={extensionPath:temp,extension:{id:'test.extension',packageJSON:{version:'1'}}};
  const adapter=new SharedCoreManager(context,{appendLine(){}});
  const root=path.join(temp,'.blackhole');
  assert.equal(adapter.storeRoot,path.join(root,'core'));
  const canonical=(process.platform==='win32'||process.platform==='darwin')?root.toLowerCase():root;
  const expected=createHash('sha256').update('blackhole-data-root-v1\0'+canonical).digest('hex');
  assert.equal(adapter.dataRoot,root);assert.equal(adapter.dataRootId,expected);
  let request;adapter.invoke=async(value)=>{request=value;return {written:true};};
  await adapter.writeLease({runtimeId:'core',buildId:'build',descriptorHash:'a'.repeat(64)},'daemon',root);
  assert.equal(request.command,'write-lease');assert.equal(request.lease.dataRootId,expected);

  // A VSIX carrying a newer signed Core must not replace a running Desktop or
  // VS Code daemon. It may prepare bytes and use guarded cold selection later.
  context.extension.packageJSON.blackholeSharedCore={mode:'host-node'};
  const newer=new SharedCoreManager(context,{appendLine(){}});
  newer.hostCoreReference=()=>({source:{kind:'embedded'},runtimeVersion:'0.4.5'});
  newer.selectActive=async()=>({versionName:'0.4.3-old',identity:{runtimeVersion:'0.4.3'}});
  let stageCount=0, coldCount=0, ensureCount=0;
  newer.stageBundledCore=async()=>{stageCount++;return '0.4.5-new'};
  newer.activateBundledCoreCold=async()=>{coldCount++;return '0.4.5-new'};
  newer.invoke=async q=>{if(q.command==='ensure-core'){ensureCount++;return{versionName:'0.4.3-old',reused:true}}throw Error('unexpected_command:'+q.command)};
  newer.requireFixedMcpCore=async()=>{};
  newer.inspectStart=async()=>({versionName:'0.4.3-old'});
  await newer.ensureHostCore({port:17306});
  assert.deepEqual([stageCount,coldCount,ensureCount],[1,0,1],'live instance keeps running');
  newer.inspectStart=async()=>null;
  await newer.ensureHostCore({port:17306});
  assert.deepEqual([stageCount,coldCount,ensureCount],[1,1,2],'stopped instance can select newer version');

});
