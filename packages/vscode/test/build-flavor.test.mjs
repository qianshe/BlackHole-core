import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash, generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseBuildArgs as parseArgs, resolveBuildConfig, buildDefines, daemonBuildDefines, manifestForBuild, PRODUCTION_CLOUD_ORIGIN as PROD } from '../build-config.mjs';
import { auditUniversalVsix as auditArchive } from '../../../scripts/audit-universal-vsix.mjs';
import {readProfiles as readBaseProfiles} from '../../../scripts/environment-config.mjs';
const require = createRequire(import.meta.url), esbuild = require('esbuild');
const { ZipFile } = createRequire(require.resolve('@vscode/vsce/package.json'))('yazl');
const root = fileURLToPath(new URL('../../../', import.meta.url));
// Mock network-free service identities, distinct from production and the rejected offline build fixture.
const OTHER = 'https://sandbox.blackhole-ci.dev';
const TEST_KEY=generateKeyPairSync('ed25519').publicKey.export({format:'der',type:'spki'}).toString('base64');
const PROD_KEY=resolveBuildConfig().entitlementPublicKey;
const readProfiles=()=>{const p=readBaseProfiles({loadTest:false});p.test.origin='https://test.blackhole-ci.dev';p.test.entitlementPublicKey=TEST_KEY;return p;};
const parseBuildArgs=(args,options={})=>parseArgs(args,{profiles:readProfiles(),...options});
const SHARED_PROFILES=readProfiles();
const auditUniversalVsix=(file,expected)=>auditArchive(file,expected,{profiles:SHARED_PROFILES});
const testBuild=(origin,key)=>resolveBuildConfig('test',origin,key,SHARED_PROFILES);
const plain = x => JSON.parse(JSON.stringify(x));
async function endpoint(build, overrides = {}) {
  const output = await esbuild.build({ entryPoints: [fileURLToPath(new URL('../src/cloudEnvironment.ts', import.meta.url))], bundle: true,
    platform: 'node', format: 'cjs', write: false, define: build === undefined ? {} : buildDefines(build) });
  const module = { exports: {} };
  vm.runInNewContext(output.outputFiles[0].text, { module, exports: module.exports, require, URL, ...overrides });
  return module.exports;
}
test('release defaults are fixed, while packaging requires an explicit environment', () => {
  assert.deepEqual(parseBuildArgs([]).build, { environment: 'production', origin: PROD, entitlementPublicKey:PROD_KEY });
  assert.throws(() => parseBuildArgs([], { packaging: true, requireEnvironment: true }), /explicit --environment/);
  assert.deepEqual(parseBuildArgs(['--environment','production'], { packaging: true, requireEnvironment: true }).build,
    { environment: 'production', origin: PROD, entitlementPublicKey: PROD_KEY });
  assert.throws(() => parseBuildArgs(['--cloud-origin', OTHER]), /test-only/);
  assert.throws(() => parseBuildArgs(['--environment','production','--cloud-origin',PROD]), /test-only/);
});
test('configured test builds use their own origin and trust; incomplete fixtures still fail closed', () => {
  const p=readProfiles();
  assert.deepEqual(parseBuildArgs(['--environment','test']).build,{environment:'test',origin:p.test.origin,entitlementPublicKey:p.test.entitlementPublicKey});
  assert.notEqual(p.test.origin,PROD);assert.notEqual(p.test.entitlementPublicKey,PROD_KEY);
  assert.deepEqual(parseBuildArgs(['--environment','test','--cloud-origin',OTHER,'--cloud-public-key',TEST_KEY]).build,{environment:'test',origin:OTHER,entitlementPublicKey:TEST_KEY});
  const incomplete=readProfiles();incomplete.test.entitlementPublicKey=null;
  assert.throws(()=>resolveBuildConfig('test',undefined,undefined,incomplete),/incomplete/);
  assert.deepEqual(resolveBuildConfig('test',OTHER,TEST_KEY,incomplete),{environment:'test',origin:OTHER,entitlementPublicKey:TEST_KEY},'complete explicit pair wins over local/injected profile');
  assert.equal(parseBuildArgs(['--environment','test','--out','candidate.vsix'], { packaging: true, requireEnvironment: true }).out, 'candidate.vsix');
});
test('local scripts default to test, while every production package caller is explicit', () => {
  const manifest=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8'));
  const rootManifest=JSON.parse(fs.readFileSync(new URL('../../../package.json',import.meta.url),'utf8'));
  assert.equal(manifest.scripts.build,'pnpm run build:test');
  assert.match(manifest.scripts['build:test'],/esbuild\.mjs --environment test/);
  assert.match(manifest.scripts['build:production'],/esbuild\.mjs --environment production/);
  assert.equal(manifest.scripts.watch,'pnpm run watch:test');
  assert.match(manifest.scripts['watch:test'],/--watch --environment test/);
  assert.match(manifest.scripts['watch:production'],/--watch --environment production/);
  assert.equal(manifest.scripts.package,'pnpm run package:production');
  assert.match(manifest.scripts['package:test'],/package-vsix\.mjs --environment test/);
  assert.match(manifest.scripts['package:production'],/package-vsix\.mjs --environment production/);
  assert.match(manifest.scripts['vscode:prepublish'],/esbuild\.mjs --environment production/);
  assert.match(rootManifest.scripts['package:vsix'],/package-vsix\.mjs --environment production/);
  assert.match(rootManifest.scripts['package:vsix:test'],/package-vsix\.mjs --environment test/);
  assert.match(rootManifest.scripts['install:vsix'],/install-vsix\.mjs --environment production/);
  assert.match(rootManifest.scripts['package:vsix:production'],/package-vsix\.mjs --environment production/);
  assert.doesNotMatch(manifest.scripts.build,/production/);

  const packageSource=fs.readFileSync(new URL('../../../scripts/package-vsix.mjs',import.meta.url),'utf8');
  const releaseSource=fs.readFileSync(new URL('../../../scripts/release-vsix.mjs',import.meta.url),'utf8');
  const workflow=fs.readFileSync(new URL('../../../.github/workflows/vscode-extension.yml',import.meta.url),'utf8');
  assert.match(packageSource,/requireEnvironment:\s*true/);
  assert.match(releaseSource,/pack,\s*'--environment',\s*'production'/);
  // This CI workflow is a runtime gate, not a production packaging job.
  // If it ever packages, the ambiguous default package script must not be used.
  assert.doesNotMatch(workflow,/run:\s*pnpm --dir packages\/vscode run package(?:\s|$)/m);
  assert.doesNotMatch(workflow,/run:\s*pnpm --dir packages\/vscode build\s*$/m);
});
test('local flavor installer removes the same-id installed extension before installing the selected same-version VSIX', () => {
 const rootManifest=JSON.parse(fs.readFileSync(new URL('../../../package.json',import.meta.url),'utf8'));
 const source=fs.readFileSync(new URL('../../../scripts/install-vsix.mjs',import.meta.url),'utf8');
 assert.match(rootManifest.scripts['install:vsix:test'],/--environment test/);assert.match(rootManifest.scripts['install:vsix:production'],/--environment production/);
 assert.match(source,/--uninstall-extension/);assert.match(source,/blackhole-vscode-.*suffix/);assert.match(source,/packages.*vscode/s);
});
test('the pinned pnpm executable forwards the CI --out argument before any package work', { timeout: 30_000 }, () => {
  const pnpmArgs = ['--dir', path.join(root, 'packages/vscode'), 'run', 'package:production', '--out', path.join(root, '.cache', 'pnpm-forwarding-probe.txt')];
  const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const run = spawnSync(command, pnpmArgs, { cwd: root, encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32', timeout: 20_000 });
  assert.equal(run.error, undefined, run.error?.message);
  const output = String(run.stdout ?? '') + String(run.stderr ?? '');
  assert.notEqual(run.status, 0, 'the .txt probe must stop before any build/package work');
  assert.match(output, /--out must name a \.vsix file/);
  assert.doesNotMatch(output, /Invalid or duplicate build argument: --/);
});
test('malformed, duplicated and unknown arguments fail closed', () => {
  for (const args of [['--environment'],['--environment','typo'],['--environment','test','--environment','production'],['--cloud-origin',''],['--target','win32-x64'],['--out','a.vsix']]) assert.throws(() => parseBuildArgs(args));
});
test('both build and runtime validators reject unsafe or non-canonical origins', async () => {
  const runtime = await endpoint(undefined);
  assert.equal(runtime.PRODUCTION_CLOUD_ORIGIN, PROD);
  for (const origin of ['', 'http://host.example.org', OTHER+'/', OTHER+'/path', OTHER+'?x=1', OTHER+'#x', 'https://user:pass@host.example.org', 'https://host.example.org:443', 'https://host.example.org:8443', 'https://127.0.0.1', 'https://localhost', 'https://host.test', ' '+OTHER]) {
    assert.throws(() => testBuild( origin));
    assert.throws(() => runtime.validateCloudOrigin(origin, { allowProduction: true }));
  }
});
for (const build of [resolveBuildConfig(), testBuild(), testBuild( OTHER, TEST_KEY)]) {
  test('compiled endpoint is locked: '+build.environment+' '+build.origin, async () => {
    const runtime = await endpoint(build, { __BLACKHOLE_BUILD__: {environment:'test',origin:'https://injected.example.org'}, process:{env:{BLACKHOLE_CLOUD_ORIGIN:'https://injected.example.org'}} });
    const selected = runtime.resolveCloudEndpoint('test','https://injected.example.org');
    assert.deepEqual(plain(selected), {environment:build.environment,origin:build.origin,label:build.environment==='test'?'测试环境':'正式环境'});
    assert.equal(Object.isFrozen(selected),true);assert.equal(Reflect.set(selected,'origin',OTHER),false);
    assert.equal(runtime.cloudAuthPrefix(PROD), (await endpoint(undefined)).cloudAuthPrefix(PROD));
    assert.notEqual(runtime.cloudAuthPrefix(PROD),runtime.cloudAuthPrefix(OTHER));
  });
}
test('bad injected release/test metadata never falls back to the production service', async () => {
  for(const build of [{environment:'bad',origin:PROD},{environment:'production',origin:OTHER},{environment:'test',origin:''}]) await assert.rejects(endpoint(build));
});
async function archive(file, build, mutate = () => {}) {
  const manifest = manifestForBuild(JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8')),build);
  manifest.blackholeBuild = build;
  if(build.environment==='test')manifest.displayName+=' (Test)';
  const bundle = 'module.exports='+JSON.stringify(build)+';';
  const daemon = 'module.exports='+JSON.stringify({origin:build.origin,publicKey:build.entitlementPublicKey})+';';
  const info = {...build,daemonSha256:createHash('sha256').update(daemon).digest('hex'),extensionSha256:createHash('sha256').update(bundle).digest('hex')};
  const files = new Map([
    ['extension/package.json',JSON.stringify(manifest)],['extension.vsixmanifest','<PackageManifest/>'],
    ['extension/dist/cloud-build.json',JSON.stringify(info)],['extension/dist/extension.js',bundle],['extension/dist/daemon/cli.js',daemon],['extension/dist/daemon/web/index.html','<!doctype html>'],
    ['extension/dist/daemon/node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node',''],
    ...['LICENSE.txt','NOTICE','THIRD_PARTY_NOTICES.md','THIRD_PARTY_LICENSES.md','readme.md'].map(n=>['extension/'+n,'fixture']),
  ]);
  mutate(files,manifest,info);
  const zip = new ZipFile(); for(const [name,text] of files)zip.addBuffer(Buffer.from(text),name);
  await new Promise((resolve,reject)=>{const stream=fs.createWriteStream(file);zip.outputStream.pipe(stream);stream.on('close',resolve);stream.on('error',reject);zip.outputStream.on('error',reject);zip.end();});
}
test('archive audit verifies same extension identity, flavor, endpoint and actual bundle bytes', async t => {
  fs.mkdirSync(path.join(root,'.cache/tests'),{recursive:true});
  const dir=fs.mkdtempSync(path.join(root,'.cache/tests/flavor-audit-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  for(const build of [resolveBuildConfig(),testBuild(),testBuild(OTHER,TEST_KEY)]) {
    const file=path.join(dir,'good.vsix');await archive(file,build);
    const report=await auditUniversalVsix(file,build);
    assert.equal(report.buildEnvironment,build.environment);assert.equal(report.cloudOrigin,build.origin);assert.equal(report.extensionId,'qianshe.blackhole-vscode');
  }
  const prod=path.join(dir,'prod-override.vsix');await archive(prod,resolveBuildConfig(),(files,manifest)=>{manifest.contributes.configuration.properties['blackhole.daemonEntry']={type:'string'};files.set('extension/package.json',JSON.stringify(manifest));});await assert.rejects(auditUniversalVsix(prod,resolveBuildConfig()));
  const cases=[
    (files,manifest)=>{delete manifest.contributes.configuration.properties['blackhole.daemonEntry'];files.set('extension/package.json',JSON.stringify(manifest));},
    files=>files.set('extension/dist/extension.js','tampered bundle'),
    files=>files.set('extension/dist/daemon/cli.js','tampered daemon'),
    (files,manifest)=>{manifest.displayName='Wrong';files.set('extension/package.json',JSON.stringify(manifest));},
    (files,manifest)=>{manifest.blackholeBuild=resolveBuildConfig();files.set('extension/package.json',JSON.stringify(manifest));},
    files=>files.delete('extension/dist/cloud-build.json'),
    files=>files.delete('extension/dist/daemon/web/index.html'),
    (files,manifest)=>{manifest.contributes.configuration.properties['blackhole.cloudEnvironment']={type:'string'};files.set('extension/package.json',JSON.stringify(manifest));},
  ];
  for(const mutate of cases){const file=path.join(dir,'bad.vsix');await archive(file,testBuild(),mutate);await assert.rejects(auditUniversalVsix(file,testBuild()));}
  const wrong=path.join(dir,'wrong-flavor.vsix');await archive(wrong,testBuild());await assert.rejects(auditUniversalVsix(wrong,resolveBuildConfig()));
});
test('independent Cloud API and daemon trust are compiled together; URL-only switches fail',async()=>{
 assert.throws(()=>testBuild(OTHER),/public-key/);
 assert.throws(()=>testBuild(OTHER,PROD_KEY));
 assert.throws(()=>testBuild(PROD,TEST_KEY));
 for(const build of [resolveBuildConfig(),testBuild(),testBuild(OTHER,TEST_KEY)]){
  const output=await esbuild.build({entryPoints:[path.join(root,'src/cloud/entitlement-public-key.ts')],bundle:true,platform:'node',format:'cjs',write:false,define:daemonBuildDefines(build)});
  const module={exports:{}};vm.runInNewContext(output.outputFiles[0].text,{module,exports:module.exports,require,__BLACKHOLE_ENTITLEMENT_TRUST__:{origin:PROD,publicKey:'wrong'}});
  assert.equal(module.exports.ENTITLEMENT_ORIGIN,build.origin);assert.equal(module.exports.ENTITLEMENT_SPKI,build.entitlementPublicKey);
 }
});

test('archive audit checks the optional managed-process supervisor as a paired hashed asset', async t => {
  fs.mkdirSync(path.join(root,'.cache/tests'),{recursive:true});
  const dir=fs.mkdtempSync(path.join(root,'.cache/tests/process-asset-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  for(const change of ['good','missing','tampered','unhashed']) {
    const file=path.join(dir,change+'.vsix');
    await archive(file,testBuild(),(files,manifest,info)=>{
      const asset='extension/dist/daemon/process-supervisor.cjs', source='// supervised task fixture';
      files.set(asset,source);info.processSupervisorSha256=createHash('sha256').update(source).digest('hex');
      if(change==='missing')files.delete(asset);
      if(change==='tampered')files.set(asset,'// wrong asset');
      if(change==='unhashed')delete info.processSupervisorSha256;
      files.set('extension/dist/cloud-build.json',JSON.stringify(info));
    });
    if(change==='good')await auditUniversalVsix(file,testBuild());
    else await assert.rejects(auditUniversalVsix(file,testBuild()),/supervisor/);
  }
});

