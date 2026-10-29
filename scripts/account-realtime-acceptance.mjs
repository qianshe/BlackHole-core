// Real wall-clock acceptance of the 60-second regression. Synthetic Cloud and
// disposable credentials only; no user profile, public channel or real login.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { AccountService } from '../dist/account/service.js';
import { memorySecretPort } from '../dist/account/secret-store.js';
const require=createRequire(import.meta.url);
const {DaemonAuthClient}=require('../.cache/vscode-auth-verify/packages/vscode/src/daemonAccount.js');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'bh-account-realtime-'));
const origin='https://cloud.blackhole-fixture.org';
const credential={token:'bhp_'+'a'.repeat(43),userId:'realtime-fixture',clientId:'realtime-client-000001',
  sessionId:'12345678-1234-4234-8234-123456789abc',loginOrder:1,expiresAt:Math.floor(Date.now()/1000)+3600};
const calls=[];let available=true;
const state=new Map();
const svc=new AccountService({origin,dataDir:root,secrets:{kind:'memory',port:memorySecretPort()},
 machineState:{get:k=>state.get(k),set:(k,v)=>state.set(k,v)},log(){},
 openExternal:async()=>{throw Error('UNEXPECTED_BROWSER_LOGIN')},
 fetch:async(url,options)=>{
  const u=new URL(url);assert.equal(u.origin,origin);
  calls.push({path:u.pathname,method:options.method,at:Date.now()});
  if(u.pathname.endsWith('/session')){
   assert.equal(options.method,'GET');
   assert.equal(options.headers.Authorization,'Bearer '+credential.token);
   if(!available)return Response.json({error:'unavailable'},{status:503});
   const {token,...facts}=credential;
   return Response.json(facts);
  }
  if(u.pathname.endsWith('/logout'))return new Response(null,{status:204});
  throw Error('UNEXPECTED_CLOUD_WRITE');
 }
});
const api={accountCall:async(method,args)=>({result:await svc.call(method,args)}),
 account:()=>svc.view(),accountSignIn:async()=>{throw Error('UNEXPECTED_SIGNIN')},
 accountSignInState:async()=>({state:'idle'}),accountSignInCancel:async()=>({state:'idle'}),
 accountMigrate:async()=>{throw Error('NO_SECOND_MIGRATION')}};
let a=new DaemonAuthClient(api);const b=new DaemonAuthClient(api);
try {
 await svc.migrate(credential);
 assert.equal((await svc.call('check',[])).state,'verified');
 const started=Date.now();let samples=0,reloaded=false;
 while(Date.now()-started<130000){
  const views=await Promise.all([a.view(),b.view(),svc.view(),a.view()]);
  assert.ok(views.every(v=>v.state==='verified'),'account must not fall back to saved after 60 seconds');
  assert.equal(svc.webAuthStatus(),'verified');samples++;
  if(!reloaded&&Date.now()-started>=65000){
   a=new DaemonAuthClient(api);assert.equal((await a.restore()).state,'verified');reloaded=true;
  }
  await new Promise(r=>setTimeout(r,2000));
 }
 const reads=calls.filter(c=>c.path.endsWith('/session')).length;
 assert.ok(reads>=3&&reads<=6,'bounded shared reads across multiple freshness intervals');
 available=false;
 assert.equal((await svc.call('check',[])).state,'unavailable');
 assert.equal(svc.currentVerifiedUserId(),null);
 available=true;
 assert.equal((await svc.call('check',[])).state,'verified');
 await svc.call('signOut',[]);
 assert.equal((await a.view()).state,'logged_out');
 console.log(JSON.stringify({ok:true,wallClockMs:Date.now()-started,samples,clients:2,
  clientRecreated:reloaded,sessionReadsDuringSteadyUse:reads,browserLogins:0,
  accountSource:'real AccountService + real DaemonAuthClient, synthetic Cloud',
  outageRevokesVerified:true,recoveryWithoutNewLogin:true,logoutAuthoritative:true}));
}finally{fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
