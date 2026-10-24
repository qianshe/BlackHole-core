import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
const require=createRequire(import.meta.url);
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'bh-fixed-core-channel-'));
process.on('exit',()=>fs.rmSync(temp,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
function load(name){
 const out=path.join(temp,name+'.cjs');
 buildSync({entryPoints:[fileURLToPath(new URL('../src/'+name+'.ts',import.meta.url))],outfile:out,bundle:true,platform:'node',format:'cjs',logLevel:'silent'});
 return require(out);
}
const {prepareManagedCloudflared}=load('prepareManagedCloudflared');
const {SharedCoreManager}=load('sharedCoreManager');
function fixture(){
 let saved={managed:true,revision:9,values:{cloudflaredPath:'C:/old/cloudflared.exe'}};
 const calls=[];
 const api={
  settings:async()=>structuredClone(saved),
  installRuntime:async(...args)=>{calls.push(['install',...args]);return {path:'C:/verified/cloudflared.exe',installed:true}},
  patchSettings:async(values,revision)=>{calls.push(['patch',values,revision]);saved={...saved,values:{...saved.values,...values},revision:revision+1};return structuredClone(saved)}
 };
 return {api,calls,get saved(){return saved},set saved(v){saved=v}};
}
test('managed sidebar writes the verified path to authoritative Core settings with revision CAS',async()=>{
 const f=fixture();await prepareManagedCloudflared(f.api);
 assert.deepEqual(f.calls,[['install','cloudflared','C:/old/cloudflared.exe'],['patch',{cloudflaredPath:'C:/verified/cloudflared.exe'},9]]);
 assert.equal(f.saved.values.cloudflaredPath,'C:/verified/cloudflared.exe');
});
test('concurrent operator path change refuses to overwrite and never restarts or starts channels',async()=>{
 const f=fixture();f.api.installRuntime=async()=>{f.saved={...f.saved,values:{cloudflaredPath:'C:/other-choice.exe'}};return{path:'C:/verified/cloudflared.exe'}};
 await assert.rejects(prepareManagedCloudflared(f.api),/cloudflared_path_changed_during_install/);
 assert.equal(f.calls.length,0);
});
test('matching saved runtime is reused without another settings write',async()=>{
 const f=fixture();f.saved={...f.saved,values:{cloudflaredPath:'C:/verified/cloudflared.exe'}};
 await prepareManagedCloudflared(f.api);assert.equal(f.calls.length,1);
});
test('legacy or unverifiable saves cannot be reported as managed initialization success',async()=>{
 const f=fixture();f.saved={...f.saved,managed:false};
 await assert.rejects(prepareManagedCloudflared(f.api),/shared_core_settings_required/);assert.equal(f.calls.length,0);
 const g=fixture();g.api.patchSettings=async()=>g.saved;
 await assert.rejects(prepareManagedCloudflared(g.api),/cloudflared_path_save_unconfirmed/);
});
for(const version of ['0.3.200','0.4.0','0.4.1','0.4.2','bad'])test('old/unrecognized Core '+version+' cannot silently satisfy a fixed plugin',async()=>{
 const manager=Object.create(SharedCoreManager.prototype),calls=[];
 manager.invoke=async request=>{calls.push(request.command);return{reused:true}};
 manager.selectActive=async()=>({identity:{runtimeVersion:version}});
 await assert.rejects(manager.ensureHostCore({}),/bundled_core_update_required/);
 assert.deepEqual(calls,['ensure-core']);
});
for(const version of ['0.4.3','0.4.4','0.5.0'])test('compatible fixed Core '+version+' is reused without downloading',async()=>{
 const manager=Object.create(SharedCoreManager.prototype),calls=[];
 manager.invoke=async request=>{calls.push(request.command);return{reused:true}};
 const descriptorHash='a'.repeat(64);
 manager.hostCoreReference=()=>({runtimeVersion:'0.4.3',descriptorHash});
 manager.selectActive=async()=>({identity:{runtimeVersion:version,descriptorHash}});
 assert.deepEqual(await manager.ensureHostCore({}),{reused:true});assert.deepEqual(calls,['ensure-core']);
});
test('same-version Core with different signed descriptor cannot masquerade as this VSIX bundle',async()=>{
 const manager=Object.create(SharedCoreManager.prototype),calls=[];
 manager.invoke=async request=>{calls.push(request.command);return {reused:true};};
 manager.hostCoreReference=()=>({runtimeVersion:'0.4.3',descriptorHash:'a'.repeat(64)});
 manager.selectActive=async()=>({identity:{runtimeVersion:'0.4.3',descriptorHash:'b'.repeat(64)}});
 await assert.rejects(manager.ensureHostCore({}),/bundled_core_update_required/);
 assert.deepEqual(calls,['ensure-core']);
});
