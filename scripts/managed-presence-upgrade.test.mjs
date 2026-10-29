// Real HTTP, authenticated Web cookie and presence stream in a throwaway HOME.
// Cloud auth is the existing child's exact synthetic fixture; no real account IO.
import assert from 'node:assert/strict';
import test from 'node:test';
import {fork} from 'node:child_process';
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createIsolatedEnv} from './fixtures/isolated-env.mjs';

test('real authenticated Web presence blocks idle exit but disconnects for a signed product upgrade',{timeout:35000},async t=>{
 const iso=await createIsolatedEnv({name:'presence-upgrade'});
 const pair=generateKeyPairSync('ed25519'),fingerprint=randomUUID(),expires=Math.floor(Date.now()/1000)+3600;
 const identity={runtimeId:'presence-fixture',runtimeVersion:'1.0.0',buildId:'fixture',descriptorHash:'b'.repeat(64),dataRootId:'a'.repeat(64),webBuildId:'web',coreProtocol:{min:1,max:1},environment:'test',cloudOrigin:'https://fixture.invalid',lifecycleState:'managed'};
 const env={...iso.env,BLACKHOLE_HOME:iso.dataDir,APPDATA:iso.home,LOCALAPPDATA:iso.home,BLACKHOLE_ACCOUNT_OFFLINE:'0',WEB_TEST_AUTH_EXPIRES_AT:String(expires),
  BLACKHOLE_START_FINGERPRINT:fingerprint,BLACKHOLE_MANAGED_RUNTIME_IDENTITY:JSON.stringify(identity),BLACKHOLE_MANAGER_PUBLIC_KEY:pair.publicKey.export({type:'spki',format:'pem'}).toString()};
 const child=fork(fileURLToPath(new URL('./local-web.test.mjs',import.meta.url)),['--fixture-daemon'],{env,stdio:['ignore','ignore','pipe','ipc']});
 child.stderr.resume();const exited=new Promise(resolve=>child.once('exit',resolve));
 const controller=new AbortController();
 t.after(async()=>{controller.abort();if(child.connected)child.send('stop');await exited;iso.cleanup()});
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('fixture_start_timeout')),15000);child.once('message',m=>{clearTimeout(timer);m.ready?resolve():reject(Error('not_ready'))});child.once('error',reject)});
 const base=`http://127.0.0.1:${iso.port}`;
 async function request(route,body,headers={}){const response=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(4000)});return{status:response.status,body:await response.json(),headers:response.headers}}
 const credential={token:'bhp_'+'a'.repeat(43),userId:'user_1',clientId:'c'.repeat(22),sessionId:'11111111-2222-4333-8444-555555555555',expiresAt:expires,loginOrder:7};
 assert.equal((await request('/api/account/migrate',{credential})).body.migrated,true);
 assert.equal((await request('/api/account/call',{method:'check',args:[]})).body.result.state,'verified');
 const ticket=(await request('/api/web/bootstrap',{})).body.ticket;
 const exchanged=await request('/web-api/v1/auth/exchange',{ticket},{origin:base,'x-blackhole-web':'1'});
 assert.equal(exchanged.status,200);
 const cookie=exchanged.headers.get('set-cookie').split(';')[0];
 const stream=await fetch(base+'/web-api/v1/presence',{headers:{cookie,'x-blackhole-web':'1'},signal:controller.signal});
 assert.equal(stream.status,200);const reader=stream.body.getReader();assert.equal((await reader.read()).done,false);
 const health=(await request('/api/health')).body;
 assert.equal(health.maintenance_idle,false);assert.equal(health.lifecycle_upgrade_version,1);assert.equal(health.upgrade_idle,true);
 const grant=operation=>{const now=Date.now();const claims={schemaVersion:1,operation,daemonId:health.daemon_id,startFingerprint:fingerprint,runtimeId:identity.runtimeId,buildId:identity.buildId,descriptorHash:identity.descriptorHash,dataRootId:identity.dataRootId,transactionId:randomUUID(),nonce:randomUUID(),issuedAt:new Date(now).toISOString(),expiresAt:new Date(now+30000).toISOString()};const payload=Buffer.from(JSON.stringify(claims)).toString('base64url');return payload+'.'+sign(null,Buffer.from(payload),pair.privateKey).toString('base64url')};
 assert.equal((await request('/api/core/stop',{token:grant('stop')})).body.error,'active_work');
 assert.equal((await request('/api/core/stop',{token:grant('upgrade')})).status,200);
 let done=false;while(!done){done=(await reader.read()).done}
 assert.equal(await exited,0,'signed graceful stop must terminate the isolated daemon');
});
