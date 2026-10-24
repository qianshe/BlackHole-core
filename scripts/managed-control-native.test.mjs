// Real daemon routes and graceful shutdown, in a disposable profile and random
// loopback port. Never opens the serving daemon, system keychain or installer.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { createIsolatedEnv } from './fixtures/isolated-env.mjs';

function waitEvent(emitter,event,timeout=30000){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{emitter.off(event,done);reject(Error('fixture_timeout:'+event))},timeout);function done(...args){clearTimeout(timer);resolve(args)}emitter.once(event,done)})}
test('real managed daemon rejects old endpoints, respects activity and exits only on its bound grant',{timeout:60000},async t=>{
 const base=Object.fromEntries(Object.entries(process.env).filter(([k])=>['PATH','SYSTEMROOT','WINDIR','COMSPEC','PATHEXT','LANG'].includes(k.toUpperCase())));
 const iso=await createIsolatedEnv({name:'protected-core-native',env:base});
 const pair=generateKeyPairSync('ed25519'),fingerprint=randomUUID();
 const identity={runtimeId:'native-fixture',runtimeVersion:'1',buildId:'fixture',descriptorHash:'b'.repeat(64),dataRootId:'a'.repeat(64),webBuildId:'web',coreProtocol:{min:1,max:1},environment:'test',cloudOrigin:'https://fixture.invalid',lifecycleState:'managed'};
 const script=`import {startDaemon} from ${JSON.stringify(new URL('../dist/daemon.js',import.meta.url).href)};
  const daemon=await startDaemon({},()=>{});let finish;
  process.on('message',m=>{if(m==='busy'){finish=daemon.deps.sessionActivity.begin('native-fixture')}if(m==='idle'){finish?.();finish=undefined}process.send({ack:m})});
  process.send({ready:true});`;
 const child=spawn(process.execPath,['--input-type=module','-e',script],{env:{...iso.env,BLACKHOLE_HOME:iso.dataDir,APPDATA:iso.home,LOCALAPPDATA:iso.home,TEMP:iso.home,TMP:iso.home,TMPDIR:iso.home,
  BLACKHOLE_START_FINGERPRINT:fingerprint,BLACKHOLE_MANAGED_RUNTIME_IDENTITY:JSON.stringify(identity),BLACKHOLE_MANAGER_PUBLIC_KEY:pair.publicKey.export({type:'spki',format:'pem'}).toString()},stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});
 let diagnostics='';child.stderr.on('data',b=>{diagnostics=(diagnostics+b).slice(-16000)});child.stdout.resume();
 const exited=waitEvent(child,'exit',55000);
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill();await exited.catch(()=>{});iso.cleanup()});
 const [message]=await waitEvent(child,'message').catch(e=>{throw Error(e.message+' '+diagnostics)});assert.equal(message.ready,true);
 async function request(route,body,headers={}){const response=await fetch(`http://127.0.0.1:${iso.port}/api${route}`,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(5000)});return{status:response.status,body:await response.json()}}
 const health=(await request('/health')).body;assert.equal(health.lifecycle_control_version,1);assert.match(health.lifecycle_manager_key_hash,/^[a-f0-9]{64}$/);
 const grant=()=>{const claims={schemaVersion:1,operation:'stop',daemonId:health.daemon_id,startFingerprint:fingerprint,runtimeId:identity.runtimeId,buildId:identity.buildId,descriptorHash:identity.descriptorHash,dataRootId:identity.dataRootId,transactionId:randomUUID(),nonce:randomUUID(),issuedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+30000).toISOString()};const payload=Buffer.from(JSON.stringify(claims)).toString('base64url');return{claims,token:payload+'.'+sign(null,Buffer.from(payload),pair.privateKey).toString('base64url')}};
 assert.deepEqual(await request('/shutdown',{daemon_id:health.daemon_id,start_fingerprint:fingerprint}),{status:409,body:{error:'managed_stop_requires_manager'}});
 const restart=await request('/restart',{confirm:true});assert.notEqual(restart.status,200);assert.equal(restart.body.error,'managed_restart_requires_manager');
 assert.equal((await request('/core/stop',{token:grant().token},{origin:'https://untrusted.invalid'})).status,403);
 assert.equal((await request('/core/stop',{token:grant().token,force:true})).status,409);
 const busy=waitEvent(child,'message');child.send('busy');await busy;
 assert.equal((await request('/core/stop',{token:grant().token})).body.error,'active_work');
 assert.equal((await request('/health')).body.daemon_id,health.daemon_id);
 const idle=waitEvent(child,'message');child.send('idle');await idle;
 fs.writeFileSync(path.join(iso.dataDir,'sentinel.txt'),'preserved');
 const g=grant(),stopped=await request('/core/stop',{token:g.token});assert.equal(stopped.status,200,JSON.stringify(stopped));assert.equal(stopped.body.transactionId,g.claims.transactionId);
 const [code,signal]=await exited;assert.equal(code,0,diagnostics);assert.equal(signal,null);assert.equal(fs.existsSync(iso.dbPath),true);
 await assert.rejects(fetch(`http://127.0.0.1:${iso.port}/api/health`,{signal:AbortSignal.timeout(2000)}));
});

test('real managed restart loads saved settings, reports boot revision and clears a seeded inherited binary',{timeout:60000},async t=>{
 const base=Object.fromEntries(Object.entries(process.env).filter(([k])=>['PATH','SYSTEMROOT','WINDIR','COMSPEC','PATHEXT','LANG'].includes(k.toUpperCase())));
 const iso=await createIsolatedEnv({name:'settings-apply-native',env:base}),pair=generateKeyPairSync('ed25519');
 const identity={runtimeId:'settings-fixture',runtimeVersion:'1',buildId:'fixture',descriptorHash:'b'.repeat(64),dataRootId:'a'.repeat(64),webBuildId:'web',coreProtocol:{min:1,max:1},environment:'test',cloudOrigin:'https://fixture.invalid',lifecycleState:'managed'};
 const children=[];t.after(async()=>{for(const c of children){if(c.child.exitCode===null&&c.child.signalCode===null)c.child.kill();await c.exited.catch(()=>{})}iso.cleanup()});
 async function start(){
  const fingerprint=randomUUID(),script=`import {startDaemon} from ${JSON.stringify(new URL('../dist/daemon.js',import.meta.url).href)};const daemon=await startDaemon({},()=>{});process.send({ready:true,started:daemon.deps.startedSettings});`;
  const child=spawn(process.execPath,['--input-type=module','-e',script],{env:{...iso.env,BLACKHOLE_HOME:iso.dataDir,APPDATA:iso.home,LOCALAPPDATA:iso.home,TEMP:iso.home,TMP:iso.home,TMPDIR:iso.home,BLACKHOLE_CLOUDFLARED:path.join(iso.home,'inherited-never-run.exe'),BLACKHOLE_SKILLS_DIR:path.join(iso.home,'old-skills'),BLACKHOLE_START_FINGERPRINT:fingerprint,BLACKHOLE_MANAGED_RUNTIME_IDENTITY:JSON.stringify(identity),BLACKHOLE_MANAGER_PUBLIC_KEY:pair.publicKey.export({type:'spki',format:'pem'}).toString()},stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});
  const exited=waitEvent(child,'exit',55000);child.stdout.resume();let diagnostics='';child.stderr.on('data',b=>diagnostics=(diagnostics+b).slice(-8000));
  const c={child,exited,fingerprint};children.push(c);const [m]=await waitEvent(child,'message').catch(e=>{throw Error(e.message+diagnostics)});assert.equal(m.ready,true);c.started=m.started;return c;
 }
 async function request(route,body,method=body===undefined?'GET':'POST'){
  const response=await fetch(`http://127.0.0.1:${iso.port}/api${route}`,{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(5000)});return{status:response.status,body:await response.json()};
 }
 function grant(c,h,revision){const claims={schemaVersion:1,operation:'restart',settingsRevision:revision,daemonId:h.daemon_id,startFingerprint:c.fingerprint,runtimeId:identity.runtimeId,buildId:identity.buildId,descriptorHash:identity.descriptorHash,dataRootId:identity.dataRootId,transactionId:randomUUID(),nonce:randomUUID(),issuedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+30000).toISOString()};const p=Buffer.from(JSON.stringify(claims)).toString('base64url');return p+'.'+sign(null,Buffer.from(p),pair.privateKey).toString('base64url')}
 const first=await start(),health=(await request('/health')).body,initial=(await request('/settings')).body;
 assert.equal(health.lifecycle_settings_version,1);assert.equal(initial.application.started_revision,health.started_settings_revision);assert.deepEqual(initial.pending_restart,[]);
 assert.match(first.started.cloudflaredPath,/inherited-never-run/);
 const values={cloudflaredPath:'',skillsDir:path.join(iso.home,'new-skills'),namedTunnelName:'saved-settings-fixture',semanticMode:'off'};
 const saved=await request('/settings',{revision:initial.revision,values},'PATCH');assert.equal(saved.status,200);assert.ok(saved.body.pending_restart.includes('skillsDir'));
 const stale=await request('/core/stop',{token:grant(first,health,initial.revision)});assert.equal(stale.body.error,'settings_revision_conflict');assert.equal((await request('/health')).body.daemon_id,health.daemon_id);
 const stop=await request('/core/stop',{token:grant(first,health,saved.body.revision)});assert.equal(stop.status,200,JSON.stringify(stop));assert.equal((await first.exited)[0],0);
 const second=await start(),nextHealth=(await request('/health')).body,applied=(await request('/settings')).body;
 assert.equal(nextHealth.started_settings_revision,saved.body.revision);assert.equal(nextHealth.settings_revision,saved.body.revision);assert.notEqual(nextHealth.daemon_id,health.daemon_id);
 for(const [key,value] of Object.entries(values))assert.equal(second.started[key],value,key);
 assert.deepEqual(applied.pending_restart,[]);assert.equal(applied.application.restart,'manager-confirmation');
 assert.equal((await request('/core/stop',{token:grant(second,nextHealth,saved.body.revision)})).status,200);assert.equal((await second.exited)[0],0);
});
