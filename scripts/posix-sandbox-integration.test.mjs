import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {runShell,detectShell} from '../dist/workspace/shell.js';
import {probeRunner} from '../dist/workspace/posix-sandbox.js';

const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
test('POSIX kernel confines writes including symlink and environment-hook paths',async t=>{
 if(!['linux','darwin'].includes(process.platform)){t.skip('requires Linux or macOS');return;}
 try{probeRunner(process.platform);}catch(e){if(process.env.BH_REQUIRE_SANDBOX==='1')throw e;t.skip(e.message);return;}
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bh-confinement-test-'));
 const workspace=path.join(dir,'work'),extra=path.join(dir,'extra'),outside=path.join(dir,'outside');
 fs.mkdirSync(workspace);fs.mkdirSync(extra);fs.mkdirSync(outside);
 const sentinel=path.join(outside,'keep.txt');fs.writeFileSync(sentinel,'unchanged');
 fs.symlinkSync(sentinel,path.join(workspace,'external-link'));
 const run=(command,mode='workspace-write',env)=>runShell({command,mode,cwd:workspace,workspace,extraWritableDirs:[extra],timeoutMs:10000,outputCapBytes:65536,env},detectShell());
 try{
  await t.test('workspace-write writes to workspace and explicit extra root',async()=>{
   const r=await run(`printf ok > inside.txt; printf extra > ${quote(path.join(extra,'ok.txt'))}`);assert.equal(r.exit_code,0,r.stderr);
   assert.equal(fs.readFileSync(path.join(workspace,'inside.txt'),'utf8'),'ok');
   assert.equal(fs.readFileSync(path.join(extra,'ok.txt'),'utf8'),'extra');
  });
  await t.test('outside direct writes and workspace symlinks cannot mutate external files',async()=>{
   assert.notEqual((await run(`printf bad > ${quote(sentinel)}`)).exit_code,0);
   assert.notEqual((await run('printf bad > external-link')).exit_code,0);
   assert.equal(fs.readFileSync(sentinel,'utf8'),'unchanged');
  });
  await t.test('read-only refuses both workspace and extra-root writes',async()=>{
   assert.notEqual((await run('printf bad > readonly.txt','read-only')).exit_code,0);
   assert.notEqual((await run(`printf bad > ${quote(path.join(extra,'readonly.txt'))}`,'read-only')).exit_code,0);
   assert.ok(!fs.existsSync(path.join(workspace,'readonly.txt')));
  });
  await t.test('shell startup hooks run only after confinement',async()=>{
   const hook=path.join(workspace,'hook.sh');fs.writeFileSync(hook,`printf escaped > ${quote(sentinel)}\n`);
   await run('true','workspace-write',{BASH_ENV:hook});assert.equal(fs.readFileSync(sentinel,'utf8'),'unchanged');
  });
  await t.test('only explicitly selected full access bypasses the write boundary',async()=>{
   const r=await run(`printf full > ${quote(sentinel)}`,'danger-full-access');assert.equal(r.exit_code,0,r.stderr);
   assert.equal(fs.readFileSync(sentinel,'utf8'),'full');
  });
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('nested macOS Seatbelt is reported as a runner fact rather than a command denial', {skip:process.platform!=='darwin'}, t=>{
 const moduleUrl=pathToFileURL(path.resolve('dist/workspace/posix-sandbox.js')).href;
 const source=`const {inspectSandboxCapability}=await import(${JSON.stringify(moduleUrl)});console.log(JSON.stringify(inspectSandboxCapability('darwin')));`;
 const child=spawnSync('/usr/bin/sandbox-exec',['-p','(version 1) (allow default)',process.execPath,'--input-type=module','-e',source],{
  cwd:process.cwd(),env:{...process.env,NO_COLOR:'1'},encoding:'utf8',timeout:10000,maxBuffer:65536,
 });
 assert.equal(child.error,undefined,child.error?.message);
 assert.equal(child.status,0,child.stderr||child.stdout);
 const line=child.stdout.split(/\r?\n/).map(value=>value.trim()).filter(value=>value.startsWith('{')).at(-1);
 assert.ok(line,`nested capability result missing: ${child.stdout}\n${child.stderr}`);
 const capability=JSON.parse(line);
 assert.equal(capability.backend,'seatbelt');
 assert.ok(['available','unavailable'].includes(capability.status));
 if(capability.status==='unavailable')assert.equal(capability.reason,'sandbox_runner_nested',JSON.stringify(capability));
 else t.diagnostic('This macOS runner permits the nested probe; unit coverage still verifies the nested-failure classifier.');
});

test('an unsupported backend rejects before running user code',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bh-no-backend-test-'));
 const original=Object.getOwnPropertyDescriptor(process,'platform');
 try{
  Object.defineProperty(process,'platform',{value:'freebsd'});
  const adapter={name:'test',buildScript:()=>'',toArgv:()=>({argv:[process.execPath,'-e',`require('node:fs').writeFileSync(${JSON.stringify(path.join(dir,'executed'))},'bad')`]})};
  await assert.rejects(runShell({command:'must not execute',mode:'workspace-write',cwd:dir,workspace:dir,timeoutMs:1000,outputCapBytes:100},adapter),/SANDBOX_UNAVAILABLE/);
  assert.ok(!fs.existsSync(path.join(dir,'executed')));
 }finally{Object.defineProperty(process,'platform',original);fs.rmSync(dir,{recursive:true,force:true});}
});
