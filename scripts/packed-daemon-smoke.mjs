// Exercise the shipped daemon, not dist/ or the user's running instance.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {pipeline} from 'node:stream/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {auditUniversalVsix} from './audit-universal-vsix.mjs';
const req=createRequire(new URL('../packages/vscode/package.json',import.meta.url));
const {open}=createRequire(req.resolve('@vscode/vsce/package.json'))('yauzl');
const extensionVersion=JSON.parse(fs.readFileSync(new URL('../packages/vscode/package.json',import.meta.url),'utf8')).version;
const file=path.resolve(process.argv[2]||`packages/vscode/blackhole-vscode-${extensionVersion}.vsix`);
const audit=await auditUniversalVsix(file);
fs.mkdirSync('.cache/tests',{recursive:true});
const directory=fs.mkdtempSync(path.resolve('.cache/tests/packed-daemon-'));
let child,client;
try {
 await new Promise((resolve,reject)=>open(file,{lazyEntries:true},(error,zip)=>{
  if(error)return reject(error);
  const fail=e=>{zip.close();reject(e)};zip.on('error',fail);zip.on('end',resolve);
  zip.on('entry',entry=>{
   const destination=path.resolve(directory,entry.fileName);
   if(!destination.startsWith(directory+path.sep))return fail(Error('Archive path escaped fixture'));
   if(entry.fileName.endsWith('/')){fs.mkdirSync(destination,{recursive:true});zip.readEntry();return}
   fs.mkdirSync(path.dirname(destination),{recursive:true});
   zip.openReadStream(entry,(error,stream)=>{if(error)return fail(error);pipeline(stream,fs.createWriteStream(destination)).then(()=>zip.readEntry(),fail)});
  });zip.readEntry();
 }));
 const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));
 const port=socket.address().port;await new Promise(r=>socket.close(r));
 // No account/token environment, no real DB/config, no public tunnel or semantic service.
 const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>['PATH','SYSTEMROOT','COMSPEC','TEMP','TMP'].includes(k.toUpperCase())));
 Object.assign(env,{HOME:directory,USERPROFILE:directory,APPDATA:directory,LOCALAPPDATA:directory,TEMP:directory,TMP:directory,ELECTRON_RUN_AS_NODE:'1',BLACKHOLE_PROXY_CONFIG:path.join(directory,'proxies.yaml'),BLACKHOLE_SEMANTIC:'off',BLACKHOLE_TUNNEL:'off',BLACKHOLE_SKILLS_DIR:''});
 const entry=path.join(directory,'extension/dist/daemon/cli.js');
 child=spawn(process.env.BH_PACKED_TEST_RUNTIME??process.execPath,[entry,'serve','--port',String(port),'--db',path.join(directory,'fixture.db'),'--tunnel','off'],{env,stdio:['ignore','pipe','pipe'],windowsHide:true});
 child.stdout.resume();child.stderr.resume();
 let spawnError;child.on('error',e=>{spawnError=e});
 const request=async(route,body)=>{
  const res=await fetch(`http://127.0.0.1:${port}/api${route}`,{signal:AbortSignal.timeout(1000),method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  assert.equal(res.status,200,route);return res.json();
 };
 let health;const start=Date.now();
 while(Date.now()-start<12000){
  if(spawnError)throw spawnError;
  if(child.exitCode!==null)throw Error('Packaged daemon exited before health');
  try{health=await request('/health');break}catch{await new Promise(r=>setTimeout(r,100))}
 }
 assert.ok(health?.ok,'Packaged daemon must start within extension deadline');
 assert.equal(health.version,audit.version);assert.equal(health.activity_days.length,7);
 assert.ok(health.activity_days.every(d=>d.total===0));
 assert.equal(health.entitlement_bridge_version,2);
 const legacy=await fetch(`http://127.0.0.1:${port}/api/entitlement/identity`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(1000)});
 assert.equal(legacy.status,409);assert.equal((await legacy.json()).error,'entitlement_bridge_upgrade_required');
 client=new Client({name:'packaged-fixture',version:'1'});
 await client.connect(new StreamableHTTPClientTransport(new URL(health.mcp_url)));
 assert.ok((await client.listTools()).tools.some(t=>t.name==='proxy'));
 const added=await request('/proxies/add',{name:'fixture-disabled',enabled:false,transport:'stdio',command:process.execPath,args:[],prewarm:'never'});
 assert.equal(added.starting,false);
 const catalog=await request('/proxies/tools',{server:'fixture-disabled',refresh:true});
 assert.equal(catalog.disabled,true);assert.deepEqual(catalog.tools,[]);
 const staleShutdown=await fetch(`http://127.0.0.1:${port}/api/shutdown`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({daemon_id:health.daemon_id}),signal:AbortSignal.timeout(1000)});
 assert.equal(staleShutdown.status,409,'an old extension window cannot close the packaged daemon with only its id');
 assert.equal((await staleShutdown.json()).error,'shutdown_precondition_required');
 assert.equal((await request('/health')).daemon_id,health.daemon_id);
 console.log(JSON.stringify({packagedDaemon:'pass',version:audit.version,startedWithin12s:true,activityDays:7,stableProxyEntry:true,disabledTools:0,staleShutdownProtected:true,liveUserDataAccessed:false}));
} catch(error) {
 // Do not print the full startup log (it contains even the fixture's MCP URL).
 throw new Error('Packaged daemon smoke failed: '+error.message,{cause:error});
} finally {
 await client?.close().catch(()=>{});
 if(child && child.exitCode===null){child.kill();await new Promise(resolve=>{child.once('exit',resolve);setTimeout(resolve,2500).unref()})}
 fs.rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
