import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sandboxArgv,shellEnvironment,probeRunner,inspectSandboxCapability,sandboxCapability,resetSandboxCapabilityCacheForTests,SandboxError} from '../dist/workspace/posix-sandbox.js';

const base={mode:'workspace-write',workspace:'/work/project',extraWritableDirs:['/work/output'],tempDir:'/tmp/bh-private',argv:['/bin/bash','-c','echo ok']};
test('Linux confines host writes, uses a private PID/proc namespace and grants only explicit roots',()=>{
 const p=sandboxArgv('linux',base);
 assert.equal(p[0],'/usr/bin/bwrap');
 for(const flag of ['--ro-bind','--unshare-pid','--proc','--die-with-parent','--new-session'])assert.ok(p.includes(flag));
 const mounts=p.flatMap((v,i)=>v==='--bind'?[[p[i+1],p[i+2]]]:[]);
 assert.deepEqual(mounts,[['/work/project','/work/project'],['/work/output','/work/output'],['/tmp/bh-private','/tmp/bh-private']]);
 assert.deepEqual(p.slice(-4),['--','/bin/bash','-c','echo ok']);
});
test('read-only grants no workspace or extra writable directory on either platform',()=>{
 const policy={...base,mode:'read-only'};
 assert.ok(!sandboxArgv('linux',policy).includes('--bind'));
 const mac=sandboxArgv('darwin',policy);
 assert.ok(mac[2].includes('(deny file-write*)'));assert.ok(!mac[2].includes('/work'));
});
test('Seatbelt quotes canonical path literals, allows only writes under approved roots',()=>{
 const mac=sandboxArgv('darwin',{...base,workspace:'/work/a"b\\c'});
 assert.equal(mac[0],'/usr/bin/sandbox-exec');assert.equal(mac[1],'-p');
 assert.ok(mac[2].includes('(subpath "/work/a\\"b\\\\c")'));
 assert.ok(mac[2].includes('/work/output'));assert.ok(mac[2].includes('/tmp/bh-private'));
});
test('invalid policy/root and unsupported platforms do not become an unconfined command',()=>{
 assert.throws(()=>sandboxArgv('freebsd',base),/SANDBOX_UNAVAILABLE/);
 assert.throws(()=>sandboxArgv('linux',{...base,workspace:'/'}),/root/);
 assert.throws(()=>sandboxArgv('darwin',{...base,workspace:'/bad\npath'}),/path/);
});
test('launch environment never inherits daemon tokens or preload hooks',()=>{
 const env=shellEnvironment({PATH:'/bin',HOME:'/home/me',LANG:'C',AIPAY_PRIVATE_KEY:'secret',BLACKHOLE_SEMANTIC_KEY:'secret',NODE_OPTIONS:'--require evil',LD_PRELOAD:'evil',BASH_ENV:'evil'});
 assert.equal(env.HOME,'/home/me');for(const k of ['AIPAY_PRIVATE_KEY','BLACKHOLE_SEMANTIC_KEY','NODE_OPTIONS','LD_PRELOAD','BASH_ENV'])assert.equal(env[k],undefined);
});
test('unavailable kernel runner is reported before any user command is submitted',()=>{
 let call;
 assert.throws(()=>probeRunner('linux',(bin,args)=>{call={bin,args};return {status:1,stderr:'unshare: Operation not permitted'};}),/SANDBOX_UNAVAILABLE/);
 assert.equal(call.bin,'/usr/bin/bwrap');assert.ok(call.args.includes('/usr/bin/true'));assert.ok(!call.args.includes('echo ok'));
});


test('sandbox capability distinguishes missing, nested and generic runner failures',()=>{
 const missing=inspectSandboxCapability('darwin',()=>({status:null,error:Object.assign(new Error('spawn ENOENT'),{code:'ENOENT'})}));
 assert.deepEqual({backend:missing.backend,status:missing.status,reason:missing.reason},{backend:'seatbelt',status:'unavailable',reason:'sandbox_runner_missing'});
 const nested=inspectSandboxCapability('darwin',()=>({status:71,stderr:'sandbox-exec: sandbox_apply: Operation not permitted'}));
 assert.equal(nested.reason,'sandbox_runner_nested');assert.match(nested.detail,/sandbox_apply/);
 const generic=inspectSandboxCapability('linux',()=>({status:1,stderr:'bwrap: Creating new namespace failed: Operation not permitted'}));
 assert.equal(generic.reason,'sandbox_runner_failed');assert.equal(generic.backend,'bubblewrap');
 const ok=inspectSandboxCapability('darwin',()=>({status:0,stderr:'WARNING: sandbox-exec is deprecated'}));
 assert.equal(ok.status,'available');assert.equal(ok.reason,null);assert.equal(ok.detail,null);
});

test('sandbox capability caches both success and failure for the daemon lifetime',()=>{
 resetSandboxCapabilityCacheForTests();let calls=0;
 const probe=()=>{calls+=1;return {status:71,stderr:'sandbox-exec: sandbox_apply: Operation not permitted'};};
 const first=sandboxCapability('darwin',probe),second=sandboxCapability('darwin',()=>{throw new Error('must not re-probe');});
 assert.equal(first.reason,'sandbox_runner_nested');assert.equal(second.reason,'sandbox_runner_nested');assert.equal(calls,1);
 resetSandboxCapabilityCacheForTests();
});

test('probeRunner exposes a stable machine-readable SandboxError without running user code',()=>{
 assert.throws(()=>probeRunner('darwin',()=>({status:71,stderr:'sandbox-exec: sandbox_apply: Operation not permitted'})),error=>{
  assert.ok(error instanceof SandboxError);assert.equal(error.code,'sandbox_runner_nested');assert.equal(error.backend,'seatbelt');
  assert.equal(error.commandStarted,false);assert.match(error.hint,/BlackHole|sandbox/i);return true;
 });
});
