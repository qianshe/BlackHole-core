import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {generateKeyPairSync} from 'node:crypto';
import {readProfiles,assertServiceBuild,PRODUCTION_ORIGIN,PRODUCTION_KEY} from './environment-config.mjs';
import {resolveBuildConfig,parseBuildArgs} from '../packages/vscode/build-config.mjs';
const key=()=>generateKeyPairSync('ed25519').publicKey.export({format:'der',type:'spki'}).toString('base64');
const root=fileURLToPath(new URL('../',import.meta.url));

test('offline fixture can compile but cannot become an installable VSIX',()=>{
 const profiles=readProfiles({loadTest:false});
 const build=resolveBuildConfig('test',undefined,undefined,profiles);
 assert.match(build.origin,/example\.org/);
 assert.throws(()=>assertServiceBuild(build),/Fixture\/example/);
 assert.throws(()=>parseBuildArgs(['--environment','test'],{profiles,packaging:true}),/Fixture\/example/);
});
test('all reserved example domains and production aliases are rejected for distribution',()=>{
 for(const host of ['example.com','nested.example.com','a.example.org','example.net','unit.invalid','foo.test','ci-fixture.blackhole-profiles.dev']){
  assert.throws(()=>assertServiceBuild({environment:'test',origin:'https://'+host,entitlementPublicKey:key()}));
 }
 assert.throws(()=>assertServiceBuild({environment:'test',origin:PRODUCTION_ORIGIN,entitlementPublicKey:PRODUCTION_KEY}));
 assert.throws(()=>resolveBuildConfig('test',PRODUCTION_ORIGIN,PRODUCTION_KEY));
});
test('explicit test origin/key pair takes precedence; ambient variables cannot change official packaging',()=>{
 const profiles=readProfiles({loadTest:false});profiles.test.entitlementPublicKey=null;
 const origin='https://test.blackhole-packaging.dev',publicKey=key();
 assert.deepEqual(parseBuildArgs(['--environment','test','--cloud-origin',origin,'--cloud-public-key',publicKey],{profiles,packaging:true}).build,{environment:'test',origin,entitlementPublicKey:publicKey});
 const names=['NODE_ENV','BLACKHOLE_CLOUD_ORIGIN','BLACKHOLE_CLOUD_PUBLIC_KEY','CLOUDFLARE_ENV'];
 const before=Object.fromEntries(names.map(k=>[k,process.env[k]]));
 try{
  for(const name of names)process.env[name]='https://wrong.example.org';
  assert.deepEqual(parseBuildArgs(['--environment','production'],{packaging:true}).build,{environment:'production',origin:PRODUCTION_ORIGIN,entitlementPublicKey:PRODUCTION_KEY});
 }finally{for(const name of names)if(before[name]===undefined)delete process.env[name];else process.env[name]=before[name];}
});
test('optional test.json is public-only, invalid files fail closed, and production can ignore them',t=>{
 const cache=path.join(root,'.cache');fs.mkdirSync(cache,{recursive:true});const dir=fs.mkdtempSync(path.join(cache,'environment-regression-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'test.json'),profile={schema:1,environment:'test',clientTarget:'test',origin:'https://test.blackhole-packaging.dev',entitlementPublicKey:key()};
 fs.writeFileSync(file,JSON.stringify(profile));assert.deepEqual(readProfiles({testProfilePath:file}).test,profile);
 fs.writeFileSync(file,'malformed');assert.throws(()=>readProfiles({testProfilePath:file}));assert.equal(readProfiles({loadTest:false,testProfilePath:file}).production.origin,PRODUCTION_ORIGIN);
 fs.writeFileSync(file,JSON.stringify({...profile,privateKey:'must-not-be-read-as-config'}));assert.throws(()=>readProfiles({testProfilePath:file}));
});
test('install validates the archive before uninstall; default package/install commands select production',()=>{
 const source=fs.readFileSync(new URL('./install-vsix.mjs',import.meta.url),'utf8');
 assert.ok(source.indexOf('await auditUniversalVsix')<source.indexOf('const removed=spawnSync'));
 const manifest=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8'));
 assert.match(manifest.scripts['package:vsix'],/--environment production$/);
 assert.match(manifest.scripts['install:vsix'],/--environment production$/);
});


test('production build and runtime defaults share one versioned public JSON profile', async () => {
 const production=JSON.parse(fs.readFileSync(path.join(root,'src/environments/production.json'),'utf8'));
 assert.deepEqual(Object.keys(production).sort(),['clientTarget','entitlementPublicKey','environment','origin','schema']);
 assert.deepEqual(readProfiles({loadTest:false}).production,production);
 assert.equal(resolveBuildConfig('production').origin,production.origin);
 assert.equal(resolveBuildConfig('production').entitlementPublicKey,production.entitlementPublicKey);
 for(const relative of ['scripts/environment-config.mjs','src/account/cloud-origin.ts','src/cloud/entitlement-public-key.ts']){
  const text=fs.readFileSync(path.join(root,relative),'utf8');
  assert.equal(text.includes(production.origin),false,relative+' must not duplicate the production origin');
  assert.equal(text.includes(production.entitlementPublicKey),false,relative+' must not duplicate the production key');
 }
 const {createRequire}=await import('node:module');
 const {runInNewContext}=await import('node:vm');
 const require=createRequire(path.join(root,'packages/vscode/package.json'));
 const esbuild=require('esbuild');
 for(const [entry,expected] of [
  ['src/account/cloud-origin.ts',{PRODUCTION_CLOUD_ORIGIN:production.origin}],
  ['src/cloud/entitlement-public-key.ts',{ENTITLEMENT_ORIGIN:production.origin,ENTITLEMENT_SPKI:production.entitlementPublicKey}],
 ]){
  const output=await esbuild.build({entryPoints:[path.join(root,entry)],bundle:true,platform:'node',format:'cjs',write:false,logLevel:'silent'});
  const module={exports:{}};
  runInNewContext(output.outputFiles[0].text,{module,exports:module.exports,require,URL});
  for(const [name,value] of Object.entries(expected))assert.equal(module.exports[name],value,entry+' '+name);
 }
});
