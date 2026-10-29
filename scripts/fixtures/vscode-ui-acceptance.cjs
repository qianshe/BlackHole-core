// Executed only by VS Code's --extensionTestsPath in a disposable profile.
const vscode=require('vscode');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
exports.run=async function(){
 const port=Number(process.env.BH_UI_TEST_PORT),out=process.env.BH_UI_TEST_REPORT;
 const expectedVersion=process.env.BH_UI_TEST_VERSION;
 const expectedCoreVersion=process.env.BH_UI_TEST_CORE_VERSION??expectedVersion;
 assert.match(expectedVersion??'',/^\d+\.\d+\.\d+$/);
 assert.match(expectedCoreVersion??'',/^\d+\.\d+\.\d+$/);
 assert.ok(port>1024&&port!==7306&&port!==17306);
 assert.ok(out&&path.isAbsolute(out));
 const started=Date.now();
 try{
  const extension=vscode.extensions.getExtension('qianshe.blackhole-vscode');
  assert.ok(extension,'packaged extension discovered by the real extension host');
  assert.equal(extension.packageJSON.version,expectedVersion);
  assert.equal(extension.packageJSON.blackholeSharedCore.mode,'host-node');
  if(process.env.BH_UI_TEST_STARTUP_GATE){
   const marker=process.env.BH_UI_TEST_STARTUP_GATE;
   assert.ok(path.isAbsolute(marker));
   fs.writeFileSync(marker,'extension host ready\n',{flag:'wx'});
  }
  await extension.activate();
  let health;
  const deadline=Date.now()+45000;
  while(Date.now()<deadline){
   try{
    const res=await fetch('http://127.0.0.1:'+port+'/api/health',{signal:AbortSignal.timeout(2000)});
    if(res.ok){health=await res.json();if(health.version===expectedCoreVersion&&health.lifecycle_state==='managed')break;}
   }catch{}
   await new Promise(r=>setTimeout(r,250));
  }
  assert.equal(health?.version,expectedCoreVersion);
  assert.equal(health.lifecycle_state,'managed');
  assert.equal(path.resolve(health.db_path),path.resolve(process.env.BH_UI_TEST_DB));
  const bootstrap=JSON.parse(fs.readFileSync(path.join(extension.extensionPath,'dist/manager/core-bootstrap.json'),'utf8'));
  assert.equal(health.descriptor_hash,bootstrap.descriptorHash,'running code must match the signed bundled descriptor');
  const leaseDir=path.join(path.dirname(process.env.BH_UI_TEST_DB),'core/state/client-leases');
  const readLease=()=>fs.readdirSync(leaseDir).filter(n=>n.endsWith('.json')).map(n=>JSON.parse(fs.readFileSync(path.join(leaseDir,n),'utf8')))
    .filter(l=>l.clientId==='vscode:qianshe.blackhole-vscode'&&l.daemonId===health.daemon_id&&Date.parse(l.expiresAt)>Date.now())
    .sort((a,b)=>Date.parse(b.expiresAt)-Date.parse(a.expiresAt))[0];
  // HTTP readiness precedes the Manager's final lease write by a short
  // interval. Wait for actual host attachment rather than sampling mid-start.
  let firstLease;const leaseDeadline=Date.now()+10000;
  while(Date.now()<leaseDeadline){firstLease=readLease();if(firstLease)break;await new Promise(r=>setTimeout(r,100));}
  assert.ok(firstLease,'the real Extension Host must receive its own verified lease');
  const id=health.daemon_id;
  const stallMs=Number(process.env.BH_UI_TEST_STALL_MS??0);assert.ok(stallMs===0||stallMs===50000);
  let renewalBaseline=firstLease;
  if(stallMs){
   // Freeze only this disposable Extension Host, not Windows or the user's
   // running editor. The independent Core must survive and rebind after TTL.
   await new Promise(r=>setTimeout(r,1000));
   Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,stallMs);
   const recoveryDeadline=Date.now()+15000;let recovered;
   while(Date.now()<recoveryDeadline){recovered=readLease();if(recovered&&recovered.leaseId!==firstLease.leaseId)break;await new Promise(r=>setTimeout(r,100));}
   assert.ok(recovered&&recovered.leaseId!==firstLease.leaseId,'expired lease must be replaced after the host resumes');
   assert.equal(recovered.daemonId,id,'recovery must not restart or replace a healthy Core');
   renewalBaseline=recovered;
  }
  await vscode.commands.executeCommand('workbench.view.extension.blackhole');
  await vscode.commands.executeCommand('blackhole.openSettings');
  const samples=[],sampleCount=Number(process.env.BH_UI_TEST_SAMPLE_COUNT??8),sampleDelay=Number(process.env.BH_UI_TEST_SAMPLE_DELAY??750);
  assert.ok(sampleCount>=1&&sampleCount<=20&&sampleDelay>=500&&sampleDelay<=4000);
  for(let i=0;i<sampleCount;i++){
   const account=await vscode.commands.executeCommand('blackhole.accountSnapshot',{daemonId:id});
   assert.equal(account?.state,'logged_out','empty disposable profile must not fabricate verified login or use main credentials');
   const current=await (await fetch('http://127.0.0.1:'+port+'/api/health')).json();
   assert.equal(current.daemon_id,id,'UI/settings/polling must not restart Core');
   samples.push(account.state);
   await new Promise(r=>setTimeout(r,sampleDelay));
  }
  const renewedLease=readLease();assert.ok(renewedLease);
  assert.equal(renewedLease.leaseId,renewalBaseline.leaseId,'healthy polling should renew, not constantly reattach');
  assert.ok(Date.parse(renewedLease.expiresAt)>Date.now());
  const renewalAdvance=Date.parse(renewedLease.expiresAt)-Date.parse(renewalBaseline.expiresAt);
  if(sampleCount*sampleDelay>=45000)assert.ok(renewalAdvance>=30000,'actual Extension Host must keep renewing beyond the original lease TTL');
  if(stallMs)assert.ok(renewalAdvance>=15000,'the recovered lease must keep scheduling subsequent heartbeats');
  const commands=await vscode.commands.getCommands(true);
  for(const name of ['blackhole.handoffLegacyCore','blackhole.activateBundledCoreCold','blackhole.retrySharedCore'])assert.ok(commands.includes(name));
  const result={ok:true,actualVSCodeExtensionHost:true,actualPackagedExtension:true,
   version:extension.packageJSON.version,node:process.versions.node,electron:process.versions.electron,
   daemonId:id,coreVersion:health.version,descriptorHash:health.descriptor_hash,port,accountStates:samples,uiViewsOpened:['sidebar','settings'],
   leaseRenewalObserved:renewalAdvance>0,observedMs:sampleCount*sampleDelay,
   extensionHostStallMs:stallMs,expiredLeaseRecovered:stallMs>0&&renewalBaseline.leaseId!==firstLease.leaseId,
   postRecoveryRenewalObserved:stallMs>0&&renewalAdvance>=15000,
   mainProfileUsed:false,elapsedMs:Date.now()-started};
  fs.writeFileSync(out,JSON.stringify(result,null,2),{flag:'wx'});
 }catch(error){
  fs.writeFileSync(out,JSON.stringify({ok:false,error:String(error.message),elapsedMs:Date.now()-started}),{flag:'wx'});
  throw error;
 }
};
