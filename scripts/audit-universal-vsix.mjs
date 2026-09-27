import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync,statSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {resolveBuildConfig,PRODUCTION_CLOUD_ORIGIN} from '../packages/vscode/build-config.mjs';

const ext=fileURLToPath(new URL('../packages/vscode/',import.meta.url));
const require=createRequire(path.join(ext,'package.json'));
// Use the ZIP reader already used by the installed packaging tool.
const {open}=createRequire(require.resolve('@vscode/vsce/package.json'))('yauzl');
export async function auditUniversalVsix(file,expectedBuild,{profiles}={}){
 const entries=[],texts=new Map(),hashes=new Map();
 await new Promise((resolve,reject)=>open(file,{lazyEntries:true},(error,zip)=>{
  if(error)return reject(error);
  const fail=e=>{zip.close();reject(e);};zip.on('error',fail);zip.on('end',resolve);
  zip.on('entry',entry=>{
   const name=entry.fileName;entries.push(name);
   if(!['extension/package.json','extension.vsixmanifest','extension/dist/cloud-build.json','extension/dist/extension.js','extension/dist/daemon/cli.js','extension/dist/daemon/process-supervisor.cjs'].includes(name)){zip.readEntry();return;}
   if(entry.uncompressedSize>((name.endsWith('/extension.js')||name.endsWith('/cli.js'))?32:1)*1024*1024)return fail(new Error('Oversized package metadata/bundle'));
   zip.openReadStream(entry,(err,stream)=>{
    if(err)return fail(err);const chunks=[],hash=createHash('sha256');stream.on('error',fail);
    stream.on('data',chunk=>{hash.update(chunk);if(!(name.endsWith('/extension.js')||name.endsWith('/cli.js')))chunks.push(chunk);});stream.on('end',()=>{hashes.set(name,hash.digest('hex'));if(!(name.endsWith('/extension.js')||name.endsWith('/cli.js')))texts.set(name,Buffer.concat(chunks).toString('utf8'));zip.readEntry();});
   });
  });zip.readEntry();
 }));
 const expected=JSON.parse(readFileSync(path.join(ext,'package.json'),'utf8'));
 const manifest=JSON.parse(texts.get('extension/package.json'));
 assert.equal(manifest.version,expected.version);assert.equal(manifest.publisher,expected.publisher);
 assert.equal(manifest.name,expected.name);
 assert.doesNotMatch(texts.get('extension.vsixmanifest'),/TargetPlatform\s*=/);
 assert.ok(!entries.some(name=>/(^|\/)cloudflared(?:\.exe)?$/i.test(name)),'cloudflared must be external');
 assert.ok(!entries.some(name=>/(^|\/)(?:\.dev\.vars[^/]*|\.env[^/]*|wrangler[^/]*|cloud-api|cloud-web)(\/|$)/i.test(name)),'server configuration/source must not ship');
 assert.ok(entries.includes('extension/dist/extension.js'));
 assert.ok(entries.includes('extension/dist/daemon/cli.js'));
 assert.ok(entries.includes('extension/dist/daemon/web/index.html'),'local Web page must ship');
 assert.ok(entries.some(name=>/koffi-win32-x64\/win32_x64\/koffi\.node$/.test(name)),'universal candidate must retain Windows x64 native support');
for(const target of ['win32-x64-msvc','win32-arm64-msvc','darwin-x64','darwin-arm64','linux-x64-gnu','linux-arm64-gnu'])assert.ok(entries.some(name=>name.endsWith(`dist/daemon/node_modules/@napi-rs/keyring-${target}/keyring.${target}.node`)),`universal candidate must ship the ${target} keyring binary (run scripts/fetch-keyring-prebuilds.mjs)`);
 for(const name of ['LICENSE.txt','NOTICE','THIRD_PARTY_NOTICES.md','readme.md'])assert.ok(entries.includes('extension/'+name),'missing '+name);
 let buildReport={};
 const rawBuild=texts.get('extension/dist/cloud-build.json');
 if(expectedBuild)assert.ok(rawBuild,'build metadata must ship');
 if(rawBuild){
  const info=JSON.parse(rawBuild);
  const selected=resolveBuildConfig(info.environment,info.environment==='test'?info.origin:undefined,info.environment==='test'?info.entitlementPublicKey:undefined,profiles);
  assert.equal(info.origin,selected.origin);
  assert.equal(info.entitlementPublicKey,selected.entitlementPublicKey);
  assert.equal(info.daemonSha256,hashes.get('extension/dist/daemon/cli.js'),'stale or mixed daemon bundle');
  const supervisorHash=hashes.get('extension/dist/daemon/process-supervisor.cjs');
  if(info.processSupervisorSha256!==undefined||supervisorHash!==undefined){
   assert.ok(typeof info.processSupervisorSha256==='string'&&/^[a-f0-9]{64}$/.test(info.processSupervisorSha256),'missing or invalid supervisor hash');
   assert.equal(info.processSupervisorSha256,supervisorHash,'missing or stale supervisor asset');
  }
  if(expectedBuild)assert.deepEqual(selected,expectedBuild,'packaged environment differs from requested build');
  assert.deepEqual(manifest.blackholeBuild,selected,'manifest and bundle metadata must agree');
  assert.equal(info.extensionSha256,hashes.get('extension/dist/extension.js'),'stale or mixed extension bundle');
  assert.equal(manifest.displayName,expected.displayName+(selected.environment==='test'?' (Test)':''));
  for(const key of ['blackhole.cloudEnvironment','blackhole.cloudTestOrigin'])assert.equal(manifest.contributes?.configuration?.properties?.[key],undefined,'runtime cloud environment settings must not ship');
  assert.equal(Object.hasOwn(manifest.contributes.configuration.properties,'blackhole.daemonEntry'),selected.environment==='test','daemon override setting must ship only in test builds');
  buildReport={buildEnvironment:selected.environment,cloudOrigin:selected.origin,usesProductionService:selected.origin===PRODUCTION_CLOUD_ORIGIN,extensionBundleSha256:info.extensionSha256,daemonBundleSha256:info.daemonSha256,entitlementPublicKeySha256:createHash('sha256').update(Buffer.from(info.entitlementPublicKey,'base64')).digest('hex')};
 }
 const bytes=statSync(file).size,sha256=createHash('sha256').update(readFileSync(file)).digest('hex');
 const report={file:path.resolve(file),extensionId:manifest.publisher+'.'+manifest.name,version:manifest.version,target:'universal',cloudflaredBundled:false,files:entries.length,bytes,sha256,...buildReport};
 return report;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(!process.argv[2])throw new Error('Usage: node scripts/audit-universal-vsix.mjs <file.vsix>');
 console.log(JSON.stringify(await auditUniversalVsix(path.resolve(process.argv[2])),null,2));
}
