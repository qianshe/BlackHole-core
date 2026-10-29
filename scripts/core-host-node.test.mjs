import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { generateKeyPairSync } from 'node:crypto';
import { CoreDescriptorSchema } from '../packages/contracts/dist/index.js';
import { signDescriptor, sha256, listFiles, writeArchive, verifyCoreArchive, extractVerifiedCoreArchive, verifyInstalledCore } from './core-runtime-lib.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(path.join(root, 'packages/vscode/package.json'));
const { build } = require('esbuild');
const built = await build({ entryPoints:[path.join(root,'packages/host-runtime/src/core-node-provider.ts')], bundle:true, write:false, platform:'node', format:'esm', target:'node22', logLevel:'silent' });
const { selectCoreNodeRuntime, coreNodeEnvironment } = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));

const base = {
  formatVersion:2,runtimeProvider:'host-node',nodeMinVersion:'22.13.0',
  runtimeId:'blackhole-core',runtimeVersion:'0.4.0',buildId:'host-node-test',
  platform:'win32',arch:'x64',environment:'test',cloudOrigin:'https://fixture.invalid',
  coreProtocol:{min:1,max:1},capabilities:['web-ui'],
  daemonVersion:'0.4.0',daemonEntry:'daemon/cli.js',webBuildId:'web-0.4.0',
  webRoot:'web',managerEntry:'host/core-manager-cli.mjs',
  dataSchema:{min:1,max:1},migrationPolicy:'explicit',
  signingKeyId:'test-local',signatureAlgorithm:'ed25519',createdAt:'2026-10-16T00:00:00.000Z'
};
function fixture(t,withNode=false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'bh-host-node-core-v2-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true,maxRetries:3,retryDelay:100}));
  const layout = path.join(root,'layout');
  for(const [relative,contents] of Object.entries({
    'daemon/cli.js':'process.stdout.write("fixture")',
    'host/core-manager-cli.mjs':'// fixture manager',
    'web/index.html':'<!doctype html>fixture',
    ...(withNode?{'node/node.exe':'unwanted embedded binary'}:{})
  })){
    const out=path.join(layout,relative); fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,contents);
  }
  const pair=generateKeyPairSync('ed25519');
  const unsigned={...base,members:listFiles(layout).map(file=>({path:file.relative,sha256:sha256(fs.readFileSync(file.absolute)),size:file.size}))};
  const descriptor={...unsigned,signature:signDescriptor(unsigned,pair.privateKey)};
  return {root,layout,pair,descriptor};
}
test('v2 signed Core archive contains no bundled Node yet retains all signed code and web assets',async t=>{
 const f=fixture(t);
 assert.deepEqual(CoreDescriptorSchema.parse(f.descriptor).formatVersion,2);
 const archive=path.join(f.root,'core.zip');
 await writeArchive(archive,f.layout,f.descriptor);
 const opts={publicKeys:{'test-local':f.pair.publicKey},platform:'win32',arch:'x64',environment:'test'};
 const got=await verifyCoreArchive(archive,opts);
 assert.equal(got.descriptor.formatVersion,2);
 assert.equal(got.memberCount,3);
 assert.ok(fs.statSync(archive).size < 10000);
 const installed=path.join(f.root,'installed');
 await extractVerifiedCoreArchive(archive,installed,opts);
 assert.equal(verifyInstalledCore(installed,got.descriptorHash,opts).descriptor.formatVersion,2);
 assert.equal(fs.existsSync(path.join(installed,'node')),false);
});
test('signed host-node Core explicitly refuses a node binary even when its signature is valid',async t=>{
 const f=fixture(t,true),archive=path.join(f.root,'unsafe.zip');
 await writeArchive(archive,f.layout,f.descriptor);
 await assert.rejects(verifyCoreArchive(archive,{publicKeys:{'test-local':f.pair.publicKey},platform:'win32',arch:'x64',environment:'test'}),/core_host_runtime_must_not_bundle_node/);
});
test('V1 stays compatible, but the host runtime selector uses only its verified signed node entry',()=>{
 const old={formatVersion:1,nodeEntry:'node/node.exe'};
 assert.deepEqual(selectCoreNodeRuntime(old,'C:/isolated'),{executable:path.join('C:/isolated','node/node.exe'),electronRunAsNode:false});
});
test('v2 runtime reuses the Manager host Node and explicitly marks an Electron host',()=>{
 const native=selectCoreNodeRuntime(base,'C:/isolated',{execPath:process.execPath,versions:{node:process.versions.node}});
 assert.equal(native.executable,process.execPath);
 assert.equal(native.electronRunAsNode,false);
 const electron=selectCoreNodeRuntime(base,'C:/isolated',{execPath:process.execPath,versions:{node:'24.20.0',electron:'43.6.0'}});
 assert.equal(electron.electronRunAsNode,true);
 const env=coreNodeEnvironment({NODE_OPTIONS:'--require ./inject.js',NODE_PATH:'unsafe',ELECTRON_RUN_AS_NODE:'poison',BH_CORE_STORE:'safe'},true);
 assert.equal(env.NODE_OPTIONS,undefined);assert.equal(env.NODE_PATH,undefined);
 assert.equal(env.ELECTRON_RUN_AS_NODE,'1');assert.equal(env.BH_CORE_STORE,'safe');
});
test('v2 refuses incompatible or fake host Node before daemon spawn',()=>{
 for(const value of ['22.12.0','20.19.0','not-a-version']){
   assert.throws(()=>selectCoreNodeRuntime(base,'C:/isolated',{execPath:process.execPath,versions:{node:value}}),/core_host_node_/);
 }
 assert.throws(()=>selectCoreNodeRuntime(base,'C:/isolated',{execPath:'./relative-node',versions:{node:'24.20.0'}}),/core_host_node_path_invalid/);
});
