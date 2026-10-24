import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {buildSync} from 'esbuild';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'bh-native-maint-ui-'));
const source=fileURLToPath(new URL('../src/managedMaintenanceUi.ts',import.meta.url));
const stub=path.join(temp,'vscode.cjs');fs.writeFileSync(stub,`module.exports={commands:{registerCommand:(...a)=>globalThis.__bhUi.register(...a)},window:new Proxy({},{get:(_,k)=>(...a)=>globalThis.__bhUi[k](...a)}),workspace:{getConfiguration:()=>({get:()=>undefined})}}`);
const bundle=path.join(temp,'ui.cjs');buildSync({entryPoints:[source],outfile:bundle,bundle:true,platform:'node',format:'cjs',alias:{vscode:stub},logLevel:'silent'});
const {registerManagedMaintenance}=createRequire(import.meta.url)(bundle);
process.on('exit',()=>fs.rmSync(temp,{recursive:true,force:true}));
function setup(){
 const callbacks={},calls=[],errors=[],answers=[];let pick;
 globalThis.__bhUi={register:(id,fn)=>{callbacks[id]=fn;return{dispose(){}}},showWarningMessage:async()=>answers.shift(),showInformationMessage:async text=>calls.push(['info',text]),showErrorMessage:async text=>errors.push(text),showInputBox:async()=> '17400',showQuickPick:async items=>pick?items[0]:undefined};
 const core={enabled:true,resolveEndpoint:async port=>{calls.push(['resolve',port]);return{port:17306,revision:3}},configureEndpoint:async(e,p)=>{calls.push(['configure',e,p]);return{port:p,revision:4}},inspectMaintenances:async()=>[{requestId:'request',operation:'restart',state:'recovery_required',target:{port:17306,versionName:'v1',startFingerprint:'old'}}],inspectStart:async()=>({status:'ready',startFingerprint:'new'}),recoverMaintenance:async(...args)=>calls.push(['recover',...args])};
 const daemon={isManagedCore:true,managedCoreTarget:'bound-target',maintainSharedCore:async(...args)=>{calls.push(['maintain',...args]);return true},releaseManagedClientForRecovery:async()=>calls.push(['release'])};
 const api={settings:async()=>({revision:7,pending_restart:['skillsDir']})},sync={flush:async()=>calls.push(['flush']),sync:async()=>calls.push(['sync'])};
 registerManagedMaintenance(core,daemon,api,sync);
 return{calls,errors,answers,core,daemon,api,run:(id,...args)=>callbacks['blackhole.'+id](...args),choose:()=>pick=true};
}
test('native apply binds the displayed saved revision and original target after confirmation',async()=>{const h=setup();h.answers.push('应用并重启');assert.equal(await h.run('applyCoreSettings'),true);assert.deepEqual(h.calls.filter(c=>c[0]==='maintain'),[['maintain','restart',true,'bound-target',7]]);assert.ok(h.calls.some(c=>c[0]==='sync'))});
test('cancel and revision read failure never request a mutation',async()=>{const h=setup();assert.equal(await h.run('applyCoreSettings'),false);h.api.settings=async()=>{throw Error('unavailable')};assert.equal(await h.run('applyCoreSettings'),false);assert.equal(h.calls.filter(c=>c[0]==='maintain').length,0);assert.equal(h.errors.length,1)});
test('revision conflict is a refusal, not automatic retry or claimed application',async()=>{const h=setup();h.answers.push('应用并重启');h.daemon.maintainSharedCore=async(...a)=>{h.calls.push(['attempt',...a]);throw Error('settings_revision_conflict')};assert.equal(await h.run('applyCoreSettings'),false);assert.equal(h.calls.filter(c=>c[0]==='attempt').length,1);assert.equal(h.calls.filter(c=>c[0]==='sync').length,0);assert.match(h.errors[0],/settings_revision_conflict/)});
test('cold port command sends the observed endpoint CAS and never starts or stops',async()=>{const h=setup();h.answers.push('确认修改端口');assert.equal(await h.run('configureCorePort'),true);assert.deepEqual(h.calls.filter(c=>c[0]==='configure'),[['configure',{port:17306,revision:3},17400]]);assert.equal(h.calls.filter(c=>c[0]==='maintain').length,0)});
test('inspection cancellation leaves leases and transactions unchanged',async()=>{const h=setup();await h.run('inspectCoreMaintenance');assert.equal(h.calls.length,0);h.choose();await h.run('inspectCoreMaintenance');assert.equal(h.calls.length,0)});
test('acknowledging a replacement requires a second native confirmation and exact fingerprint',async()=>{const h=setup();h.choose();h.answers.push('接纳已验证的新实例','确认接纳当前实例');await h.run('inspectCoreMaintenance');assert.deepEqual(h.calls.filter(c=>c[0]==='recover'),[['recover','request','new']]);assert.equal(h.calls.filter(c=>c[0]==='release').length,1);assert.equal(h.calls.filter(c=>c[0]==='maintain').length,0)});

test('settings page revision must still match before any native confirmation or mutation', async()=>{
 const h=setup();h.answers.push('应用并重启');
 assert.equal(await h.run('applyCoreSettings',6),false);
 assert.equal(h.calls.filter(c=>c[0]==='maintain').length,0);
 assert.deepEqual(h.answers,['应用并重启']);assert.match(h.errors[0],/settings_revision_conflict/);
});
test('settings page cannot inject a revision shape or confirmation through native command arguments',async()=>{
 for(const value of [-1,1.5,'7',null,{revision:7,confirmed:true},Number.MAX_SAFE_INTEGER+1]){
  const h=setup();assert.equal(await h.run('applyCoreSettings',value),false);
  assert.equal(h.calls.length,0);assert.match(h.errors[0],/invalid_settings_revision/);
 }
});
test('a matching settings page revision still requires the native operator confirmation',async()=>{
 const h=setup();assert.equal(await h.run('applyCoreSettings',7),false);
 assert.equal(h.calls.filter(c=>c[0]==='maintain').length,0);
 h.answers.push('应用并重启');assert.equal(await h.run('applyCoreSettings',7),true);
 assert.deepEqual(h.calls.filter(c=>c[0]==='maintain'),[['maintain','restart',true,'bound-target',7]]);
});
