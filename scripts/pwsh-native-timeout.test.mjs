import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const mode=process.env.BLACKHOLE_NATIVE_TIMEOUT_TEST;
if(mode){
 const {SandboxedPersistentShell}=await import('../dist/workspace/sandboxed-shell.js');
 const {detectPwshBin}=await import('../dist/workspace/pwsh.js');
 const bin=detectPwshBin();if(!bin)throw new Error('PowerShell is required for this native regression');
 const shell=new SandboxedPersistentShell({cwd:process.cwd(),workspaceRoot:process.cwd(),bin,mode:'read-only'});
 try{
  const ready=await shell.run('Get-Location | Select-Object -ExpandProperty Path',4000);assert.equal(ready.exit_code,0);
  if(mode==='large-stdin'){
   const started=performance.now();
   // The first line stops stdin consumption while the remaining input exceeds pipe capacity.
   // Old synchronous WriteFile blocks JS, so its timeout timer cannot fire.
   const result=await shell.run('Start-Sleep -Seconds 30\n'+'# regression input padding\n'.repeat(10000),1000);
   assert.equal(result.timed_out,true);assert.equal(result.exit_code,-1);assert.ok(performance.now()-started<5000);
   const recovered=await shell.run('Get-Location | Select-Object -ExpandProperty Path',4000);assert.equal(recovered.exit_code,0);
   process.send?.({ok:true,case:mode,timedOut:result.timed_out,recovered:true});
  }else if(mode==='child-job'){
   const quoted=bin.replaceAll("'","''");
   const result=await shell.run(`$child = Start-Process -FilePath '${quoted}' -ArgumentList '-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 30' -PassThru -WindowStyle Hidden\nWrite-Output ('CHILD_PID:' + $child.Id)\nStart-Sleep -Seconds 30`,1500);
   assert.equal(result.timed_out,true);const pid=Number(/CHILD_PID:(\d+)/.exec(result.stdout)?.[1]);assert.ok(pid>0,'child PID must be captured before timeout');
   let alive=true;for(let n=0;n<40&&alive;n++){try{process.kill(pid,0);}catch{alive=false;}if(alive)await new Promise(resolve=>setTimeout(resolve,50));}
   assert.equal(alive,false,'the owned child job must terminate, not merely disappear from UI');
   process.send?.({ok:true,case:mode,timedOut:true,childExited:true});
  }else throw new Error('unknown test case');
 }catch(error){process.send?.({ok:false,message:String(error)});process.exitCode=1;}
 finally{shell.dispose();process.disconnect?.();}
}else{
 function runCase(name){
  return new Promise((resolve,reject)=>{
   const child=fork(fileURLToPath(import.meta.url),[],{cwd:process.cwd(),env:{...process.env,BLACKHOLE_NATIVE_TIMEOUT_TEST:name},stdio:['ignore','pipe','pipe','ipc']});
   let receipt,stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});
   child.on('message',value=>{receipt=value;});
   // This watchdog belongs to this test child only. It never searches for or kills other processes.
   const timer=setTimeout(()=>{child.kill();reject(new Error(`${name}: native regression exceeded 12 seconds`));},12000);
   child.on('error',error=>{clearTimeout(timer);reject(error);});
   child.on('exit',code=>{clearTimeout(timer);if(code===0&&receipt?.ok)resolve(receipt);else reject(new Error(`${name}: ${receipt?.message??stderr??code}`));});
  });
 }
 test('native confined pipe backpressure cannot prevent the execution timeout',{skip:process.platform!=='win32',timeout:15000},async()=>{
  const result=await runCase('large-stdin');assert.equal(result.recovered,true);
 });
 test('native timeout terminates the owned child job and reports partial output',{skip:process.platform!=='win32',timeout:15000},async()=>{
  const result=await runCase('child-job');assert.equal(result.childExited,true);
 });
}
