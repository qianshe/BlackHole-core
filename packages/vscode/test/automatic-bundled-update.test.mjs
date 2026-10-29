import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {test} from 'node:test';
const require=createRequire(import.meta.url),ts=require('typescript');
const source=fs.readFileSync(new URL('../src/bundledCoreUpdateCoordinator.ts',import.meta.url),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function fixture(t){
 const ui={prompts:0,warnings:[],shown:false,timer:null};
 const item={text:'',tooltip:'',show(){ui.shown=true},hide(){ui.shown=false},dispose(){ui.shown=false}};
 const mod={exports:{}};
 vm.runInNewContext(code,{module:mod,exports:mod.exports,require(name){if(name!=='vscode')return require(name);return {
  StatusBarAlignment:{Right:1},window:{createStatusBarItem(){return item},
   showInformationMessage(){ui.prompts++;return Promise.resolve()},showWarningMessage(text){ui.warnings.push(text);return Promise.resolve()},
  }}},setInterval(fn){ui.timer=fn;return 1},clearInterval(){ui.timer=null},Date,Promise,Error});
 const candidate={runningVersion:'0.4.6',bundledVersion:'0.4.7',targetVersionName:'0.4.7-signed',descriptorHash:'b'.repeat(64)};
 const state={candidate,idle:false,legacy:false,matching:true,updates:0,committed:0,error:null,readsFail:false};
 const manager={async bundledCoreUpdateStatus(){if(state.readsFail)throw Error('temporary');return state.candidate},
  async applyBundledCoreUpdate(){state.updates++;if(state.error)throw Error(state.error);state.candidate=null;return 'committed'}};
 const session={bindingState:'bound',startupUpdateState:'deferred',matchesHealth(){return state.matching}};
 const api={async health(){if(state.readsFail)throw Error('temporary');return state.legacy?{maintenance_idle:state.idle}:{lifecycle_upgrade_version:1,upgrade_idle:state.idle,maintenance_idle:false,upgrade_blockers:['tools_running']}}};
 const instance=new mod.exports.BundledCoreUpdateCoordinator(manager,{managedCoreSession:session},api,()=>12345,{appendLine(){}},async()=>{state.committed++});
 t.after(()=>instance.dispose());return{instance,ui,item,state,session};
}
test('installed bundle applies automatically at idle with no confirmation or success popup',async t=>{
 const f=fixture(t);f.state.idle=true;await f.instance.refresh();
 assert.equal(f.state.updates,1);assert.equal(f.state.committed,1);assert.equal(f.ui.prompts,0);assert.equal(f.ui.warnings.length,0);assert.equal(f.ui.shown,false);
});
test('actual work defers then automatically proceeds; a passive open page does not block upgrade readiness',async t=>{
 const f=fixture(t);await f.instance.refresh();assert.equal(f.state.updates,0);assert.equal(f.ui.shown,true);assert.match(f.item.tooltip,/正在执行工具/);
 f.state.idle=true;await f.instance.refresh();assert.equal(f.state.updates,1);assert.equal(f.ui.prompts,0);
});
test('legacy Core is never assumed upgradeable merely because a new host has a new predicate',async t=>{
 const f=fixture(t);f.state.legacy=true;await f.instance.refresh();assert.equal(f.state.updates,0);assert.match(f.item.tooltip,/旧 Core/);
 f.state.idle=true;await f.instance.request();assert.equal(f.state.updates,1);assert.equal(f.ui.prompts,0);
});
test('peer compatibility refusal preserves the pending update; unknown signed outcomes halt retries',async t=>{
 const f=fixture(t);f.state.idle=true;f.state.error='peer_core_update_required';await f.instance.refresh();
 assert.equal(f.state.updates,1);assert.equal(f.ui.warnings.length,0);
 f.state.error='maintenance_outcome_requires_inspection';await f.instance.refresh();assert.equal(f.state.updates,2);assert.equal(f.ui.warnings.length,1);
 f.state.error=null;await f.instance.refresh();assert.equal(f.state.updates,2,'must not retry an unconfirmed mutation');
});
test('read failures can recover but never authorize mutation from an unverified health identity',async t=>{
 const f=fixture(t);f.state.readsFail=true;await f.instance.refresh();assert.equal(f.state.updates,0);
 f.state.readsFail=false;f.state.idle=true;f.state.matching=false;await f.instance.refresh();assert.equal(f.state.updates,0);
 f.state.matching=true;await f.instance.refresh();assert.equal(f.state.updates,1);
});
test('a rolled-back startup is not immediately retried by the background continuation',async t=>{
 const f=fixture(t);f.session.startupUpdateState='rolled_back';f.state.idle=true;await f.instance.refresh();await f.instance.refresh();
 assert.equal(f.state.updates,0);assert.equal(f.ui.warnings.length,1);
});
