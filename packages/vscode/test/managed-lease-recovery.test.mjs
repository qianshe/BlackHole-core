// Regression for the field incident after explicit 0.4.2 -> 0.4.3 cold
// selection: Core identity is healthy but no VS Code lease exists. A passive
// health poll must not invent a positive identity conflict; an in-flight
// failed startup must be joined before the explicit post-selection attach.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const path = new URL('../src/daemonManager.ts', import.meta.url);
const source = fs.readFileSync(path, 'utf8');
const js = ts.transpileModule(source, { compilerOptions: {
 module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
} }).outputText;
class EventEmitter {
 constructor(){this.listeners=new Set();}
 fire(s){for(const fn of this.listeners)fn(s)}
 get event(){return fn=>{this.listeners.add(fn);return{dispose:()=>this.listeners.delete(fn)}}}
 dispose(){this.listeners.clear()}
}
const notice=[], commandsIssued=[];
let nextDecision;
const vscode = {
 commands: { executeCommand(command) { commandsIssued.push(command); return Promise.resolve(true); } },
 EventEmitter, ProgressLocation: { Notification: 1 }, env: { appRoot: 'C:/VSCode' },
 window: {showWarningMessage(...args){notice.push(args[0]);const choice=nextDecision;nextDecision=undefined;return Promise.resolve(choice)},
  showErrorMessage(...args){notice.push(args[0]);return Promise.resolve(undefined)},
  withProgress(_options,work){return work()}},
 workspace: {getConfiguration(){return{get(){return undefined}}}},
};
const mod={exports:{}};
vm.runInNewContext(js,{
 module:mod,exports:mod.exports,console,process,Buffer,Date,URL,Error,AbortController,
 setTimeout,clearTimeout,setInterval,clearInterval,
 require(name){
   if(name==='vscode')return vscode;
   if(name==='./cloudEnvironment')return{resolveCloudEndpoint:()=>({environment:'test',origin:'https://fixture.invalid'})};
   if(name==='./vscodeRipgrep')return{pathFromEnvironment:()=>'',prependToolDirectory:()=>'',resolveExecutionRg:()=>''};
   if(name==='./hostCoreUi')return{reportHostCoreFailure:()=>{}};
   return require(name);
 },
});
const {DaemonManager}=mod.exports;
const health={ok:true,daemon_id:'fixture-daemon',version:'0.4.3',lifecycle_state:'managed'};
const nextTick=()=>new Promise(resolve=>setImmediate(resolve));
function setup(session){
 const logs=[],states=[];
 const context={extension:{id:'fixture.blackhole',packageJSON:{version:'0.4.3',blackholeSharedCore:{mode:'host-node'}},extensionPath:'fixture'},globalState:{get(){return undefined},update:async()=>{}}};
 const api={health:async()=>health};
 const daemon=new DaemonManager(context,()=>({port:7306}),api,{appendLine:line=>logs.push(line)});
 daemon.useCoreManager(session);
 daemon.onDidChangeState(state=>states.push(state));
 return {daemon,logs,states};
}
test('no Manager lease after cold selection is NOT an identity mismatch and never masks original error',()=>{
 const {daemon}=setup({bindingState:'unbound',matchesHealth:()=>false});
 daemon.state='error';daemon.lastError='bundled_core_update_required';
 assert.equal(daemon.observeHealth(health,daemon.captureHealthObservation()),false);
 assert.equal(daemon.currentState,'error');
 assert.equal(daemon.error,'bundled_core_update_required');
});
test('unbound Core displays actionable lease recovery status, not a forged signature mismatch',()=>{
 const {daemon}=setup({bindingState:'unbound',matchesHealth:()=>false});
 daemon.state='running';
 assert.equal(daemon.observeHealth(health,daemon.captureHealthObservation()),false);
 assert.equal(daemon.error,'managed_core_not_attached');
});
test('uncertain heartbeat never claims healthy or mismatch; matching renewed lease restores state',()=>{
 const binding={bindingState:'renewal_unconfirmed',matchesHealth:()=>binding.bindingState==='bound'};
 const {daemon}=setup(binding);
 daemon.state='running';
 assert.equal(daemon.observeHealth(health,daemon.captureHealthObservation()),false);
 assert.equal(daemon.currentState,'starting');
 binding.bindingState='bound';
 assert.equal(daemon.observeHealth(health,daemon.captureHealthObservation()),true);
 assert.equal(daemon.currentState,'running');
 assert.equal(daemon.error,'');
});
test('positive foreign Core identity still fails closed and reports exact mismatch',()=>{
 const {daemon}=setup({bindingState:'bound',matchesHealth:()=>false});
 daemon.state='running';
 assert.equal(daemon.observeHealth(health,daemon.captureHealthObservation()),false);
 assert.equal(daemon.error,'managed_core_identity_or_lease_mismatch');
});
test('unknown signed maintenance remains an actionable error, never a harmless renewal spinner',()=>{
 const {daemon}=setup({bindingState:'maintenance_unknown',matchesHealth:()=>false});
 daemon.state='error';daemon.lastError='maintenance_outcome_requires_inspection';
 assert.equal(daemon.observeHealth(health,daemon.captureHealthObservation()),false);
 assert.equal(daemon.currentState,'error');
 assert.equal(daemon.error,'maintenance_outcome_requires_inspection');
});

test('successful pinned recovery clears an idle warning promptly without waiting for the UI poller',()=>{
 const binding={bindingState:'bound',matchesHealth:()=>true};
 const {daemon}=setup(binding);
 daemon.state='error';daemon.lastError='managed_core_lease_expired';
 const revision=daemon.captureHealthObservation().revision;
 daemon.managedLeaseRebound();
 assert.equal(daemon.currentState,'running');
 assert.equal(daemon.error,'');
 assert.equal(daemon.captureHealthObservation().revision,revision+1,'old in-flight health must not override a verified reattachment');
});

test('a recovery callback cannot clear a positive identity or maintenance conflict',()=>{
 const binding={bindingState:'bound',matchesHealth:()=>false};
 const {daemon}=setup(binding);
 daemon.state='error';daemon.lastError='managed_core_identity_or_lease_mismatch';
 daemon.managedLeaseRebound();
 assert.equal(daemon.error,'managed_core_identity_or_lease_mismatch');
 binding.bindingState='unbound';
 daemon.state='error';daemon.lastError='managed_core_lease_expired';
 daemon.managedLeaseRebound();
 assert.equal(daemon.error,'managed_core_lease_expired');
});
test('lost lease reports a bounded reason and offers explicit reattach, never automatic shutdown',async()=>{
 const {daemon,logs}=setup({bindingState:'unbound',matchesHealth:()=>false});
 const beforeCommands=commandsIssued.length, beforeNotices=notice.length;
 nextDecision='验证并重新连接';
 daemon.managedLeaseLost('lease_expired_after_unconfirmed');
 assert.equal(daemon.error,'managed_core_lease_lost');
 assert.ok(logs.some(x=>x.includes('lease_expired_after_unconfirmed')));
 await nextTick();
 assert.equal(notice.length,beforeNotices+1);
 assert.deepEqual(commandsIssued.slice(beforeCommands),['blackhole.retrySharedCore'],
   'a user-confirmed command reattaches; neither daemon stop nor restart was requested');
 daemon.managedLeaseLost('lease_expired_after_unconfirmed');
 await nextTick();
 assert.equal(notice.length,beforeNotices+1,'one prompt per lost binding');
});
test('unknown signed maintenance NEVER offers a blind lease retry action',async()=>{
 const {daemon,logs}=setup({bindingState:'maintenance_unknown',matchesHealth:()=>false});
 const before=notice.length;
 daemon.managedLeaseLost('maintenance_outcome_requires_inspection');
 await nextTick();
 assert.equal(notice.length,before);
 assert.ok(logs.some(x=>x.includes('maintenance_outcome_requires_inspection')));
 assert.equal(daemon.error,'managed_core_lease_lost');
});
test('explicit cold selection joins failed initial startup, then attaches once to the verified Core',async()=>{
 let fail; const gate=new Promise(resolve=>{fail=resolve});
 let count=0;const binding={bindingState:'unbound',
  async attach(){count++;if(count===1){await gate;throw Error('bundled_core_update_required')}
   binding.bindingState='bound';return{localUrl:'http://127.0.0.1:7306/ui/'}},
  matchesHealth:()=>true};
 const {daemon,logs}=setup(binding);
 const first=daemon.ensureRunning();
 await nextTick();
 const after=daemon.attachAfterVerifiedColdSelection();
 fail();
 assert.equal(await first,false);
 assert.equal(await after,true);
 assert.equal(count,2,'one failed pre-selection attach, one post-selection attach');
 assert.equal(daemon.currentState,'running');
 assert.equal(logs.filter(msg=>msg.includes('daemon lifecycle failed: bundled_core_update_required')).length,1);
});
test('cold selection refuses blind retry when earlier attach result was ambiguous',async()=>{
 let fail;const gate=new Promise(resolve=>fail=resolve);
 let count=0;const binding={bindingState:'unbound',
  async attach(){count++;await gate;throw Error('shared_core_manager_timeout')},matchesHealth:()=>false};
 const {daemon,logs}=setup(binding);
 const first=daemon.ensureRunning();
 await nextTick();
 const after=daemon.attachAfterVerifiedColdSelection();
 fail();
 assert.equal(await first,false);
 assert.equal(await after,false);
 assert.equal(count,1,'never re-attach after a timed-out mutation');
 assert.ok(logs.some(x=>x.includes('did not retry an ambiguous previous startup')));
 assert.equal(daemon.currentState,'error');
 assert.equal(daemon.error,'shared_core_manager_timeout');
});
