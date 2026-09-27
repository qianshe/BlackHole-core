import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import fs from 'node:fs';import path from 'node:path';import net from 'node:net';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {startDaemon} from '../dist/daemon.js';import {mcpUrl} from '../dist/deps.js';
import {EntitlementGate} from '../dist/cloud/entitlement-gate.js';
fs.mkdirSync('.cache',{recursive:true});const tmp=fs.mkdtempSync(path.resolve('.cache/entitlement-http-'));
const reservation=net.createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));
const keys=generateKeyPairSync('ed25519'),origin='https://synthetic.invalid';
const gate=new EntitlementGate(keys.publicKey.export({format:'der',type:'spki'}).toString('base64'),origin);
const daemon=await startDaemon({port,dbPath:path.join(tmp,'state.db'),semantic:'off',tunnel:'off',proxyConfigPath:path.join(tmp,'absent.yaml'),publicBaseUrl:`http://127.0.0.1:${port}`},()=>{},gate);
const client=new Client({name:'entitlement-http-smoke',version:'1'}),transport=new StreamableHTTPClientTransport(new URL(mcpUrl(daemon.deps)));
const post=(action,body={},headers={},legacy=false)=>fetch(`http://127.0.0.1:${port}/api/entitlement/${action}`,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify({...(!legacy?{cloud_origin:origin,daemon_id:daemon.deps.daemonId}:{}),...body})});
let broker,working=false,proofs=0,brokerError;let brokerTask=Promise.resolve();
try {
 await client.connect(transport);
 await assert.rejects(client.callTool({name:'guide',arguments:{}}));
 assert.equal((await post('identity',{}, {Origin:'https://evil.invalid'})).status,403);
 const identity={userId:'test-user',clientId:'test-client',sessionId:'test-session',loginOrder:1,expiresAt:Math.floor(Date.now()/1000)+86400,kind:'login'};
 const health=await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
 assert.equal((await post('identity',{cloud_origin:'https://other-environment.invalid',identity:{...identity,loginOrder:999}})).status,409,'foreign environment must not poison the login ordering');
 assert.equal((await post('identity',{cloud_origin:origin,daemon_id:'retired-daemon',identity:{...identity,loginOrder:999}})).status,409,'old bridge work must not mutate a replacement');
 assert.equal(health.cloud_origin,origin);
 for(const action of ['identity','refresh','claim','complete','fail']){
  const response=await post(action,{identity:{...identity,loginOrder:999},worker:'legacy_window_worker'}, {}, true);
  assert.equal(response.status,409,`legacy ${action} must not mutate or claim the new gate`);
  assert.equal((await response.json()).error,'entitlement_bridge_upgrade_required');
 }
 assert.equal((await post('refresh',{cloud_origin:origin,daemon_id:undefined})).status,409,'follow-ups must carry the bound daemon id');
 broker=setInterval(()=>{if(working)return;working=true;brokerTask=(async()=>{try{const {pending}=await (await post('claim',{worker:'synthetic_http_broker'})).json();if(!pending)return;
  const issuedAt=Math.floor(Date.now()/1000),bytes=Buffer.from(JSON.stringify({schema:1,issuer:origin,audience:'blackhole-daemon',...identity,challenge:pending.challenge,issuedAt,expiresAt:issuedAt+3600}));
  assert.equal((await post('complete',{challenge:pending.challenge,ticket:{payload:bytes.toString('base64url'),signature:sign(null,bytes,keys.privateKey).toString('base64url')}})).status,200);proofs++;
 }finally{working=false;}})().catch(error=>{brokerError=error;});},20);
 assert.equal((await post('identity',{identity})).status,200);
 const result=await client.callTool({name:'guide',arguments:{}});assert.notEqual(result.isError,true);assert.ok(proofs>=1);
 await post('identity',{identity:{...identity,kind:'logout'}});await assert.rejects(client.callTool({name:'guide',arguments:{}}));
 assert.equal(brokerError,undefined);
 console.log('PASS actual daemon MCP ingress rejects missing/logged-out credentials, accepts challenge signature, and rejects browser bridge traffic; no real cloud credentials used.');
}finally{clearInterval(broker);await brokerTask;await client.close();gate.invalidate();await daemon.stop();fs.rmSync(tmp,{recursive:true,force:true});}
