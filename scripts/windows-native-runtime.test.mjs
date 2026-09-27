import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {assignPidToKillOnCloseJob,closeJobHandle} from '../dist/proxy/win32job.js';
import {cloudflaredInstallHint} from '../dist/tunnel/install-guide.js';

test('Windows native job loads lazily and closes its own test child',async t=>{
 if(process.platform!=='win32'||process.arch!=='x64'){t.skip('requires Windows x64');return;}
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
 await once(child,'spawn');const exited=once(child,'exit');let job=null,timer;
 try{
  job=assignPidToKillOnCloseJob(child.pid);assert.ok(job);closeJobHandle(job);job=null;
  await Promise.race([exited,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('native job did not terminate test child')),5000);})]);
 }finally{clearTimeout(timer);closeJobHandle(job);if(child.exitCode===null)child.kill();}
});
test('missing connector guidance selects the OS without changing configuration',()=>{
 assert.ok(cloudflaredInstallHint('darwin').includes('brew install cloudflared'));
 assert.ok(cloudflaredInstallHint('linux').includes('Linux'));
 assert.ok(!cloudflaredInstallHint('linux').includes('winget'));
 for(const os of ['win32','darwin','linux']){const hint=cloudflaredInstallHint(os);assert.ok(hint.includes('blackhole.cloudflaredPath'));assert.ok(hint.includes('#channels'));}
});
