import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { CoreBootstrapSchema } from '../packages/contracts/dist/index.js';
import { listFiles, sha256, signDescriptor, writeArchive } from './core-runtime-lib.mjs';
import { hostCoreInputs, hostExtensionFile, stageHostCore } from './vsix-host-layout.mjs';
import { stageDesktopNode, verifyDesktopNodeInputs } from './desktop-node-layout.mjs';
const repo=fileURLToPath(new URL('../',import.meta.url));
const {buildSync}=createRequire(path.join(repo,'packages/vscode/package.json'))('esbuild');
const compiled=buildSync({entryPoints:[path.join(repo,'packages/vscode/src/hostCoreBootstrap.ts')],bundle:true,write:false,format:'esm',platform:'node',logLevel:'silent'});
const {loadHostCoreBuild,acquireHostCore}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const cloud={environment:'test',origin:'https://fixture.invalid'};
const url='https://github.com/qianshe/BlackHole-core/releases/download/v0.4.0/BlackHole-Core-0.4.0-win32-x64-test.zip';
function fresh(t){const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'bh-host-package-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}));return root;}
async function coreFixture(t,formatVersion=2){
 const root=fresh(t),layout=path.join(root,'core'),archive=path.join(root,'core.zip');
 const files={'daemon/cli.js':'// fixture daemon','web/index.html':'<!doctype html>fixture','host/core-manager-cli.mjs':'// fixture manager',...(formatVersion===1?{'node/node.exe':'not executable'}:{})};
 for(const [name,text]of Object.entries(files)){const p=path.join(layout,name);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,text);}
 const pair=generateKeyPairSync('ed25519');
 const unsigned={formatVersion,runtimeId:'blackhole-core',runtimeVersion:'0.4.0',buildId:'fixture',platform:'win32',arch:'x64',environment:'test',cloudOrigin:cloud.origin,coreProtocol:{min:1,max:1},capabilities:['web-ui'],
 ...(formatVersion===2?{runtimeProvider:'host-node',nodeMinVersion:'22.13.0'}:{nodeEntry:'node/node.exe',nodeVersion:'22.20.0'}),
 daemonVersion:'0.4.0',daemonEntry:'daemon/cli.js',webRoot:'web',webBuildId:'fixture',managerEntry:'host/core-manager-cli.mjs',dataSchema:{min:1,max:1},migrationPolicy:'none',
 members:listFiles(layout).map(f=>({path:f.relative,size:f.size,sha256:sha256(fs.readFileSync(f.absolute))})),signingKeyId:'test-fixture',signatureAlgorithm:'ed25519',createdAt:'2026-10-17T00:00:00.000Z'};
 const descriptor={...unsigned,signature:signDescriptor(unsigned,pair.privateKey)};
 await writeArchive(archive,layout,descriptor);
 return {root,layout,archive,descriptor,pub:pair.publicKey.export({type:'spki',format:'pem'}).toString()};
}
async function reference(t,kind='thin') {const f=await coreFixture(t);return {...f,input:await hostCoreInputs(f.archive,f.pub,'test-fixture',cloud,kind,kind==='thin'?url:undefined)};}
function extensionFixture(f){
 const ext=path.join(f.root,'extension');fs.mkdirSync(path.join(ext,'dist'),{recursive:true});
 fs.writeFileSync(path.join(ext,'dist/cloud-build.json'),JSON.stringify({...cloud,extensionSha256:'a'.repeat(64),daemonSha256:'b'.repeat(64)}));
 const pin=stageHostCore(ext,path.join(f.layout,'host/core-manager-cli.mjs'),f.input);
 return {ext,pin};
}
test('default host package selection drops all daemon, Web, native and Node duplicates',()=>{
 for(const file of ['dist/daemon/cli.js','dist/daemon/web/index.html','dist/node_modules/koffi.node','dist/node/node.exe','dist/workspace/pwsh.js','dist/win32/ffi.js','dist/extension.js.map','previous.vsix'])assert.equal(hostExtensionFile(file),false,file);
 for(const file of ['dist/extension.js','dist/settings/settings.css','dist/settings/settings.js','media/icon.svg','LICENSE','NOTICE','README.md'])assert.equal(hostExtensionFile(file),true,file);
});
test('thin and offline references require the same signed v2 code archive, never a v1 Node bundle',async t=>{
 const f=await reference(t);assert.equal(f.input.reference.source.kind,'download');
 const old=await coreFixture(t,1);await assert.rejects(hostCoreInputs(old.archive,old.pub,'test-fixture',cloud,'thin',url),/vsix_node_bundling_forbidden/);
 await assert.rejects(hostCoreInputs(undefined,undefined,undefined,cloud,'thin',url),/host_core_reference_required/);
 const wrong=generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'}).toString();
 await assert.rejects(hostCoreInputs(f.archive,wrong,'test-fixture',cloud,'thin',url),/signature_invalid/);
});
test('Test package retains multiple public roots for old Core recovery but never private keys or production Test trust',async t=>{
 const f=await coreFixture(t);
 const older=generateKeyPairSync('ed25519');
 const publicKey=older.publicKey.export({type:'spki',format:'pem'}).toString();
 const roots=[{keyId:'test-old-040',publicKey},{keyId:'test-old-041',publicKey}];
 const input=await hostCoreInputs(f.archive,f.pub,'test-fixture',cloud,'offline-code',undefined,roots);
 assert.deepEqual(Object.keys(input.trust.publicKeys).sort(),['test-fixture','test-old-040','test-old-041']);
 await assert.rejects(hostCoreInputs(f.archive,f.pub,'test-fixture',{...cloud,environment:'production'},'offline-code',undefined,roots),/previous_test_trust_invalid/);
 await assert.rejects(hostCoreInputs(f.archive,f.pub,'test-fixture',cloud,'offline-code',undefined,[...roots,roots[0]]),/previous_test_trust_invalid/);
 const privateKey=older.privateKey.export({type:'pkcs8',format:'pem'}).toString();
 await assert.rejects(hostCoreInputs(f.archive,f.pub,'test-fixture',cloud,'offline-code',undefined,[{keyId:'test-old-private',publicKey:privateKey}]),/previous_test_trust_invalid/);
 await assert.rejects(hostCoreInputs(f.archive,f.pub,'test-fixture',cloud,'offline-code',undefined,Array(8).fill(roots[0])),/previous_test_trust_invalid/);
 await assert.rejects(hostCoreInputs(f.archive,f.pub,'test-fixture',cloud,'offline-code',undefined,[{keyId:'test-invalid-pem',publicKey:'-----BEGIN PUBLIC KEY-----\ninvalid\n-----END PUBLIC KEY-----'}]),/previous_test_trust_invalid/);
});

test('signed reference URL is fixed to repository, version and clean HTTPS path',async t=>{
 const {input}=await reference(t);
 for(const unsafe of [url.replace('https:','http:'),url.replace('/qianshe/','/other/'),url.replace('v0.4.0/','v0.3.200/'),url+'?token=x',url.replace('github.com','github.com@evil.example'),url.replace('BlackHole-Core-','%42lackHole-Core-')])assert.equal(CoreBootstrapSchema.safeParse({...input.reference,source:{kind:'download',url:unsafe}}).success,false,unsafe);
});
test('host bootstrap pins manager, reference, trust and correct platform before execution',async t=>{
 const f=await reference(t),{ext,pin}=extensionFixture(f);
 assert.deepEqual(loadHostCoreBuild(ext,pin,cloud,'win32','x64'),f.input.reference);
 assert.throws(()=>loadHostCoreBuild(ext,pin,cloud,'linux','x64'),/platform_unsupported/);
 fs.appendFileSync(path.join(ext,'dist/manager/core-manager-cli.mjs'),'changed');
 assert.throws(()=>loadHostCoreBuild(ext,pin,cloud,'win32','x64'),/integrity_failed/);
});
test('offline-code bootstrap never downloads Node or contacts the network',async t=>{
 const f=await reference(t,'offline-code'),{ext}=extensionFixture(f);
 const got=await acquireHostCore(f.input.reference,ext,path.join(f.root,'updates'),{fetcher(){throw Error('network forbidden')}});
 assert.equal(got.archive,path.join(ext,'dist/core/core.zip'));got.cleanup();assert.ok(fs.existsSync(got.archive));
 fs.appendFileSync(got.archive,'corrupt');await assert.rejects(acquireHostCore(f.input.reference,ext,path.join(f.root,'updates')),/file_invalid|integrity_failed/);
});
test('online bootstrap follows GitHub CDN with no account credentials and verifies exact archive bytes',async t=>{
 const f=await reference(t);const bytes=fs.readFileSync(f.archive);let count=0;
 const got=await acquireHostCore(f.input.reference,f.root,path.join(f.root,'updates'),{fetcher:async(address,options)=>{
  assert.equal(options.credentials,'omit');assert.deepEqual(options.headers,{Accept:'application/octet-stream'});
  count++;if(count===1)return new Response(null,{status:302,headers:{location:'https://release-assets.githubusercontent.com/asset?signature=opaque'}});
  assert.ok(address.startsWith('https://release-assets.githubusercontent.com/'));return new Response(bytes,{headers:{'content-length':String(bytes.length)}});
 }});
 assert.equal(count,2);assert.equal(sha256(fs.readFileSync(got.archive)),f.input.reference.archiveHash);got.cleanup();assert.equal(fs.existsSync(got.archive),false);
});
test('foreign or plaintext redirect is rejected before making another request',async t=>{
 const f=await reference(t);
 for(const target of ['http://github.com/file','https://evil.example/file']){let count=0;await assert.rejects(acquireHostCore(f.input.reference,f.root,path.join(f.root,'updates'),{fetcher:async()=>{count++;return new Response(null,{status:302,headers:{location:target}})}}),/redirect_rejected/);assert.equal(count,1);}
});
test('cancel, truncation and corrupted code never publish a ready archive; unrelated files survive',async t=>{
 const f=await reference(t),updates=path.join(f.root,'updates');fs.mkdirSync(updates);fs.writeFileSync(path.join(updates,'sentinel'),'keep');
 for(const mode of ['cancel','truncate','corrupt']){
  const controller=new AbortController();const bytes=fs.readFileSync(f.archive);if(mode==='corrupt')bytes[0]^=1;
  await assert.rejects(acquireHostCore(f.input.reference,f.root,updates,{signal:controller.signal,fetcher:async()=>new Response(mode==='truncate'?bytes.subarray(0,10):bytes),onProgress(){if(mode==='cancel')controller.abort()}}),/cancelled|integrity_failed/);
  assert.deepEqual(fs.readdirSync(updates),['sentinel']);
 }
});
test('download directory validation rejects a file ancestor without writing outside the requested tree',async t=>{
 const f=await reference(t);const block=path.join(f.root,'not-a-directory');fs.writeFileSync(block,'untouched');let calls=0;
 await assert.rejects(acquireHostCore(f.input.reference,f.root,path.join(block,'updates'),{fetcher:async()=>{calls++;throw Error('network must not run')}}),/core_download_link_rejected/);
 assert.equal(calls,0);assert.equal(fs.readFileSync(block,'utf8'),'untouched');
});
test('Desktop v2 payload delivers one pinned Node with license and rejects missing/wrong pins or old Core',async t=>{
 const f=await reference(t);const node=path.join(f.root,'node.exe'),license=path.join(f.root,'LICENSE');fs.writeFileSync(node,'NON EXECUTABLE TEST NODE');fs.writeFileSync(license,'fixture license');
 const inputs={nodeExe:node,nodeSha256:sha256(fs.readFileSync(node)),nodeLicense:license,nodeLicenseSha256:sha256(fs.readFileSync(license))};
 const out=path.join(f.root,'desktop');const result=stageDesktopNode(out,f.descriptor,inputs);
 assert.equal(result.nodeRuntime,'shared-cache');assert.deepEqual(fs.readdirSync(path.join(out,'bootstrap')).sort(),['node-LICENSE','node.exe']);
 assert.throws(()=>verifyDesktopNodeInputs(f.descriptor,{...inputs,nodeSha256:'0'.repeat(64)}),/integrity_failed/);
 assert.throws(()=>verifyDesktopNodeInputs({...f.descriptor,formatVersion:1},inputs),/requires_runtime_neutral/);
 assert.throws(()=>verifyDesktopNodeInputs({...f.descriptor,members:[{path:'node/node.exe'}]},inputs),/duplicate_node/);
});
test('host-mode activation has an explicit return before old bridge migration/legacy start',()=>{
 const text=fs.readFileSync(path.join(repo,'packages/vscode/src/extension.ts'),'utf8');
 const start=text.indexOf('if (sharedCore.hostProvided) {'),end=text.indexOf('let state = context.globalState',start);
 assert.ok(start>0&&end>start);assert.match(text.slice(start,end),/daemon.useCoreManager/);assert.match(text.slice(start,end),/return;/);assert.doesNotMatch(text.slice(start,end),/allowLegacyStartup|daemon.stop\(/);
});
