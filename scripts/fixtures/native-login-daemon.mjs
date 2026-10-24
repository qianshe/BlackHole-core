// Test-only real daemon/account service. All cloud IO and browser opening
// remain in-process and synthetic. No production/test installation is touched.
import {createHash,randomUUID} from 'node:crypto';
import {startDaemon} from '../../dist/daemon.js';
import {AccountService} from '../../dist/account/service.js';
import {memorySecretPort} from '../../dist/account/secret-store.js';

const origin='https://sandbox.blackhole.example.org';
const daemon=await startDaemon({port:Number(process.env.BLACKHOLE_PORT),dbPath:process.env.BLACKHOLE_DB,tunnel:'off'},()=>{});
// The daemon created its own account observer. Drain it before replacing the
// service, so only the synthetic account below can renew during this test.
await daemon.deps.account?.stop();
let mode='pending',flow=null,credential=null,opens=0;
const requests={starts:0,exchanges:0,sessions:0};
const state=new Map();
const fetchCloud=async(input,init)=>{
 const u=new URL(String(input));
 if(u.origin!==origin)throw Error('external_network_forbidden');
 const body=init?.body?JSON.parse(init.body):{};
 if(u.pathname==='/api/auth/plugin/start'){
   requests.starts++;
   if(mode==='failure')return Response.json({error:'not_available'},{status:503});
   flow={id:randomUUID(),clientId:body.clientId,challenge:body.challenge};
   return Response.json({flowId:flow.id,authorizationUrl:origin+'/api/auth/plugin/authorize#flow='+flow.id+'&launch='+'A'.repeat(43),expiresAt:Math.floor(Date.now()/1000)+600,pollInterval:2});
 }
 if(u.pathname==='/api/auth/plugin/exchange'){
   requests.exchanges++;
   if(!flow||body.flowId!==flow.id||createHash('sha256').update(body.verifier).digest('base64url')!==flow.challenge)return Response.json({error:'rejected'},{status:401});
   if(mode!=='authorized')return Response.json({status:'authorization_pending'},{status:202});
   credential={token:'bhp_'+'a'.repeat(43),userId:'native_fixture_user',clientId:flow.clientId,sessionId:randomUUID(),expiresAt:Math.floor(Date.now()/1000)+3600,loginOrder:1};
   return Response.json(credential);
 }
 if(u.pathname==='/api/auth/plugin/session'){
   requests.sessions++;
   if(mode==='session-unavailable')return Response.json({error:'not_available'},{status:503});
   if(!credential)return Response.json({error:'rejected'},{status:401});
   const {token,...facts}=credential;return Response.json(facts);
 }
 if(u.pathname==='/api/auth/plugin/logout')return new Response(null,{status:204});
 throw Error('unexpected_synthetic_request');
};
const account=new AccountService({origin,dataDir:process.env.BLACKHOLE_HOME,
 machineState:{get:k=>state.get(k),set:(k,v)=>state.set(k,v)},
 secrets:{kind:'memory',port:memorySecretPort()},fetch:fetchCloud,
 openExternal:async raw=>{const u=new URL(raw);if(u.origin!==origin||u.pathname!=='/api/auth/plugin/authorize')throw Error('invalid_auth_url');opens++;process.send?.({browserOpened:opens});return true;},log:()=>{}});
daemon.deps.account=account;
await account.start();
const snapshot=()=>({state:account.webAuthStatus(),job:account.signInState(),opens,requests:{...requests}});
process.on('message',m=>{
 if(m?.command==='mode'){mode=m.value;process.send?.({ack:m.id,mode});}
 if(m?.command==='state'){process.send?.({ack:m.id,...snapshot()});}
 if(m?.command==='check'){
   // Public service method only; never mutate the credential, cached phase,
   // freshness clock or observer timer to manufacture a recovery.
   void account.call('check',[]).then(
     ()=>process.send?.({ack:m.id,...snapshot()}),
     e=>process.send?.({ack:m.id,error:e instanceof Error?e.message:String(e)}),
   );
 }
 if(m==='stop')void daemon.stop().then(()=>process.exit(0),()=>process.exit(1));
});
process.send?.({ready:true});
