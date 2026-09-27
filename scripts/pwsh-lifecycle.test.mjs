import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PersistentShell} from '../dist/workspace/pwsh.js';
import { spawnSync } from 'node:child_process';

// No external commands: exercise lifecycle events through the public backend seam.
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){
 const backends=[];
 const shell=new PersistentShell({cwd:process.cwd(),bin:'unused-fixture',backend:()=>{
  const b={line:'',kills:0,out:()=>{},err:()=>{},exit:()=>{},
   write(line){this.line=line;},onStdout(cb){this.out=cb;},onStderr(cb){this.err=cb;},onExit(cb){this.exit=cb;},kill(){this.kills++;},
   finish(){const marker=this.line.match(/BH_END_[a-f0-9]+_/)[0];this.err(`${marker}\r\n`);this.out(`${marker}code=0;pwd=${process.cwd()}\r\n`);}};
  backends.push(b);return b;
 }});return {shell,backends};
}

test('an awaited command keeps its deadline alive even without other Node handles', {timeout:5000}, () => {
 const script = `
  import { PersistentShell } from './dist/workspace/pwsh.js';
  const shell = new PersistentShell({cwd:process.cwd(),bin:'no-native-process-fixture',backend:()=>({
   write(){},onStdout(){},onStderr(){},onExit(){},kill(){}
  })});
  try { const result=await shell.run('wait-for-deadline',30); console.log(JSON.stringify(result)); }
  finally { shell.dispose(); }
 `;
 const child=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:3000});
 assert.equal(child.status,0,child.error?.message||child.stderr||child.stdout);
 const result=JSON.parse(child.stdout.trim());
 assert.equal(result.timed_out,true);assert.equal(result.exit_code,-1);
});
test('shell reset settles the active call even when the backend does not emit exit',{timeout:2000},async()=>{
 const {shell,backends}=fixture();const result=shell.run('fixture',1000);await tick();
 backends[0].out('partial output\n');shell.kill();
 const value=await result;assert.equal(value.exit_code,-1);assert.match(value.stderr,/interrupted/);assert.equal(value.stdout,'partial output\n');assert.equal(backends[0].kills,1);
});
test('late events from a replaced backend cannot settle or corrupt the next command',{timeout:2000},async()=>{
 const {shell,backends}=fixture();const first=shell.run('first fixture',1000);await tick();shell.kill();await first;
 const second=shell.run('second fixture',1000);await tick();let done=false;void second.then(()=>{done=true;});
 backends[0].out('stale output\n');backends[0].err('stale error');backends[0].exit(1);await tick();assert.equal(done,false);
 backends[1].out('current output\n');backends[1].finish();const value=await second;
 assert.equal(value.stdout,'current output\n');assert.equal(value.stderr,'');assert.equal(value.exit_code,0);shell.dispose();
});
test('execution timeout ends the call and permits a fresh subsequent shell',{timeout:2000},async()=>{
 const {shell,backends}=fixture();const keepAlive=setTimeout(()=>{},1500);
 try{
  const value=await shell.run('timeout fixture',25);assert.equal(value.timed_out,true);assert.equal(value.exit_code,-1);assert.equal(backends[0].kills,1);
  const recovered=shell.run('recovery fixture',1000);await tick();backends[1].finish();assert.equal((await recovered).exit_code,0);
 }finally{clearTimeout(keepAlive);shell.dispose();}
});

test('queued command has its own deadline and is never started after it expires',{timeout:2000},async()=>{
 const {shell,backends}=fixture(),keepAlive=setTimeout(()=>{},1500);
 try{
  const first=shell.run('first fixture',1000);await tick();
  const queued=await shell.run('queued fixture',25);assert.equal(queued.timed_out,true);assert.match(queued.stderr,/waiting for the previous pwsh command/);assert.equal(backends.length,1);assert.ok(!backends[0].line.includes('queued fixture'));
  backends[0].finish();assert.equal((await first).exit_code,0);await tick();
  const recovered=shell.run('after queue timeout',1000);await tick();backends[0].finish();assert.equal((await recovered).exit_code,0);
 }finally{clearTimeout(keepAlive);shell.dispose();}
});

test('expired shell admission cannot start in a microtask before its overdue timer',{timeout:2000},async()=>{
 const {shell,backends}=fixture(),keepAlive=setTimeout(()=>{},1500);
 try{
  const first=shell.run('first fixture',1000);await tick();
  const queued=shell.run('must never start after deadline',20);
  const until=performance.now()+60;while(performance.now()<until){} // deliberately delay the timers phase
  backends[0].finish();await first;const result=await queued;
  assert.equal(result.timed_out,true);assert.match(result.stderr,/waiting for the previous pwsh command/);
  assert.ok(!backends[0].line.includes('must never start'),'expired input must never reach stdin');
 }finally{clearTimeout(keepAlive);shell.dispose();}
});

test('outer session queue deadline expires without later executing the command',{timeout:2000},async()=>{
 const {SessionRuntime}=await import('../dist/runtime.js');
 const rt=new SessionRuntime({workspace_path:process.cwd(),cwd:process.cwd()},{});
 let release,executed=false,checks=0;rt.beforeExecute=async()=>{checks++;};
 const blocked=rt.serialize(()=>new Promise(resolve=>{release=resolve;}));await tick();
 const cleanup=setTimeout(()=>release(),200);
 try{
  const result=await rt.serialize(async()=>{executed=true;return 'executed';},{timeoutMs:25,onTimeout:()=> 'queue-expired'});
  assert.equal(result,'queue-expired');assert.equal(executed,false);
  release();await blocked;await tick();assert.equal(executed,false);assert.equal(checks,1);
  assert.equal(await rt.serialize(async()=> 'recovered'),'recovered');
 }finally{clearTimeout(cleanup);release();}
});

test('outer deadline bounds admission validation and skips command when validation finishes late',{timeout:2000},async()=>{
 const {SessionRuntime}=await import('../dist/runtime.js');
 const rt=new SessionRuntime({workspace_path:process.cwd(),cwd:process.cwd()},{});
 let release,executed=false;rt.beforeExecute=()=>new Promise(resolve=>{release=resolve;});
 const cleanup=setTimeout(()=>release?.(),200);
 try{
  const result=await rt.serialize(async()=>{executed=true;return 'executed';},{timeoutMs:25,onTimeout:()=> 'queue-expired'});
  assert.equal(result,'queue-expired');assert.equal(executed,false);
  release();await tick();assert.equal(executed,false);rt.beforeExecute=undefined;
  assert.equal(await rt.serialize(async()=> 'recovered'),'recovered');
 }finally{clearTimeout(cleanup);release?.();}
});

test('outer queue passes only remaining monotonic execution budget',{timeout:2000},async()=>{
 const {SessionRuntime}=await import('../dist/runtime.js');
 const rt=new SessionRuntime({workspace_path:process.cwd(),cwd:process.cwd()},{});
 const first=rt.serialize(()=>new Promise(resolve=>setTimeout(resolve,60)));
 const remaining=await rt.serialize(async budget=>budget,{timeoutMs:500,onTimeout:()=> -1});await first;
 assert.ok(remaining>0&&remaining<470,'time spent queued must be subtracted');
});

// stdout and stderr are independent pipes: completing one cannot drain the other.
const markerOf=b=>b.line.match(/BH_END_[a-f0-9]+_/)[0];
test('Windows stderr fence uses absolute cmd and accepts its separator space',{skip:process.platform!=='win32',timeout:2000},async t=>{
 const {shell,backends}=fixture();t.after(()=>shell.dispose());
 const pending=shell.run('fence command fixture',1000);await tick();const b=backends[0],marker=markerOf(b);
 assert.match(b.line,/[A-Za-z]:\\[^\r\n']*\\cmd\.exe' \/d \/s \/c/);assert.doesNotMatch(b.line,/ELECTRON_RUN_AS_NODE| -e /);
 b.out(`${marker}code=0;pwd=${process.cwd()}\r\n`);b.err(`${marker} \r\n`);
 const value=await pending;assert.equal(value.exit_code,0);assert.equal(value.stderr,'');
});
test('stdout completion must wait for late stderr before releasing the next command',{timeout:2000},async t=>{
 const {shell,backends}=fixture();t.after(()=>shell.dispose());
 const first=shell.run('first stream fixture',1000);await tick();const b=backends[0],marker=markerOf(b);
 let resolved=false;void first.then(()=>{resolved=true;});
 const second=shell.run('second stream fixture',1000);
 b.out(`first-output${marker}code=7;pwd=${process.cwd()}\r\n`);await tick();
 assert.equal(resolved,false,'stdout completion must not resolve before stderr is drained');
 assert.ok(b.line.includes('first stream fixture'),'queued command must not start before both fences');
 b.err('late-native-error'+marker.slice(0,9));await tick();assert.equal(resolved,false);
 b.err(marker.slice(9)+'\r');await tick();assert.equal(resolved,false,'a fragmented CRLF fence is not complete');
 b.err('\n');const value=await first;
 assert.equal(value.stdout,'first-output');assert.equal(value.stderr,'late-native-error');assert.equal(value.exit_code,7);assert.equal(value.cwd,process.cwd());
 await tick();assert.ok(b.line.includes('second stream fixture'));
 b.out('second-output');b.finish();const next=await second;
 assert.equal(next.stdout,'second-output');assert.equal(next.stderr,'');assert.equal(next.exit_code,0);
});
test('stderr-first and character-split fences preserve both streams without protocol leakage',{timeout:2000},async t=>{
 const {shell,backends}=fixture();t.after(()=>shell.dispose());
 const result=shell.run('stderr first fixture',1000);await tick();const b=backends[0],marker=markerOf(b);
 let resolved=false;void result.then(()=>{resolved=true;});
 for(const c of 'stderr-no-newline'+marker+'\n')b.err(c);
 await tick();assert.equal(resolved,false);
 for(const c of 'stdout-no-newline'+marker+`code=0;pwd=${process.cwd()}\r`)b.out(c);
 await tick();assert.equal(resolved,false,'stdout metadata must include the complete line ending');
 b.out('\n');const value=await result;
 assert.equal(value.stdout,'stdout-no-newline');assert.equal(value.stderr,'stderr-no-newline');assert.equal(value.exit_code,0);
});
for(const completed of ['stdout','stderr'])test(`missing ${completed==='stdout'?'stderr':'stdout'} fence times out and cannot contaminate a replacement shell`,{timeout:2000},async t=>{
 const {shell,backends}=fixture(),keepAlive=setTimeout(()=>{},1500);t.after(()=>{clearTimeout(keepAlive);shell.dispose();});
 const first=shell.run('missing fence fixture',50);await tick();const old=backends[0],marker=markerOf(old);
 old.out('partial output');old.err('partial error');
 if(completed==='stdout')old.out(`${marker}code=0;pwd=${process.cwd()}\n`);else old.err(marker+'\n');
 const value=await first;assert.equal(value.timed_out,true);assert.equal(value.exit_code,-1);assert.equal(value.stdout,'partial output');
 assert.match(value.stderr,/partial error/);assert.doesNotMatch(value.stderr,/BH_END_/);assert.equal(old.kills,1);
 const recovered=shell.run('replacement fixture',1000);await tick();
 old.err('stale error'+marker+'\n');old.out('stale stdout');old.exit(1);
 backends[1].finish();const next=await recovered;assert.equal(next.stdout,'');assert.equal(next.stderr,'');assert.equal(next.exit_code,0);
});
for(const ending of ['reset','exit'])test(`${ending} while waiting for stderr settles without exposing stdout framing`,{timeout:2000},async t=>{
 const {shell,backends}=fixture();t.after(()=>shell.dispose());
 const pending=shell.run('interrupted fence fixture',1000);await tick();const b=backends[0],marker=markerOf(b);
 b.out(`partial${marker}code=0;pwd=${process.cwd()}\n`);
 if(ending==='reset')shell.kill();else b.exit(9);
 const result=await pending;assert.equal(result.stdout,'partial');assert.equal(result.exit_code,ending==='reset'?-1:9);
 assert.match(result.stderr,ending==='reset'?/interrupted/:/session ended/);
});

