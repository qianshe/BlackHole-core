// Isolated signer acceptance: no release keys, installed apps or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {generateKeyPairSync,createHash,verify,sign} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {renderDesktopReleaseCatalog} from './generate-cloud-desktop-catalog.mjs';

const signer=fileURLToPath(new URL('./sign-desktop-update.mjs', import.meta.url));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bh-update-publish-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const layout=path.join(root,'desktop');
  fs.mkdirSync(path.join(layout,'installer'),{recursive:true});
  const content=Buffer.alloc(1024*1024+1024,0x42);
  const exe=path.join(layout,'installer','setup.exe');
  fs.writeFileSync(exe,content);
  const signer=generateKeyPairSync('ed25519');
  const key=path.join(root,'signing.pem');
  fs.writeFileSync(key,signer.privateKey.export({format:'pem',type:'pkcs8'}));
  const der=signer.publicKey.export({format:'der',type:'spki'});
  const pub=der.subarray(-32).toString('base64');
  const audit={
    kind:'unsigned-desktop-candidate',environment:'test',version:'0.3.202',
    launcherSha256:'a'.repeat(64),
    core:{runtimeVersion:'0.3.202',buildId:'test-upgrade',webBuildId:'web-test'},
    seedDescriptorHash:'b'.repeat(64),
    updates:{configured:true,feedOrigin:'https://updates.example.com',publicKey:pub},
    installer:{file:'installer/setup.exe',sha256:hash(content),bytes:content.length},
  };
  const auditFile=path.join(layout,'distribution-audit.json');
  const writeAudit=()=>fs.writeFileSync(auditFile,JSON.stringify(audit));
  writeAudit();
  const output=path.join(root,'release');
  const invoke=(keyFile=key)=>spawnSync(process.execPath,[signerPath,'--layout',layout,'--installer-url','https://updates.example.com/download/setup.exe','--signing-key',keyFile,'--output',output],{encoding:'utf8',windowsHide:true});
  const signerPath=fileURLToPath(new URL('./sign-desktop-update.mjs',import.meta.url));
  return {root,layout,content,signer,output,audit,writeAudit,invoke};
}
test('test release publisher binds signed manifest to installer and Core version',t=>{
  const f=fixture(t),result=f.invoke();
  assert.equal(result.status,0,result.stderr);
  const raw=fs.readFileSync(path.join(f.output,'latest.json'));
  const sig=Buffer.from(fs.readFileSync(path.join(f.output,'latest.json.sig'),'utf8').trim(),'base64');
  assert.equal(verify(null,raw,f.signer.publicKey,sig),true);
  const manifest=JSON.parse(raw);
  assert.equal(manifest.version,'0.3.202');
  assert.equal(manifest.buildId,'a'.repeat(16));
  assert.equal(manifest.coreVersion,'0.3.202');
  assert.equal(manifest.coreBuildId,'test-upgrade');
  assert.equal(manifest.installerBytes,f.content.length);
  assert.equal(manifest.installerSha256,hash(f.content));
  assert.notEqual(f.invoke().status,0,'publisher must not overwrite existing signed release');
});
test('publication refuses corrupt installer hashes, production and unconfigured feeds',t=>{
  const f=fixture(t);
  f.audit.installer.sha256='c'.repeat(64);f.writeAudit();
  assert.match(f.invoke().stderr,/installer_audit_mismatch/);
  f.audit.installer.sha256=hash(f.content);
  f.audit.environment='production';f.writeAudit();
  assert.match(f.invoke().stderr,/signed_test_release_required/);
  f.audit.environment='test';f.audit.updates.configured=false;f.writeAudit();
  assert.match(f.invoke().stderr,/signed_test_release_required/);
});
test('publication rejects a signer differing from the updater public-key pin',t=>{
  const f=fixture(t);
  const other=generateKeyPairSync('ed25519');
  const otherKey=path.join(f.root,'wrong.pem');
  fs.writeFileSync(otherKey,other.privateKey.export({format:'pem',type:'pkcs8'}));
  assert.match(f.invoke(otherKey).stderr,/update_signer_mismatch/);
  assert.equal(fs.existsSync(f.output),false);
});
test('confirmed production signing validates multi-platform GitHub release URLs and rejects test/unsigned filenames',t=>{
  const f=fixture(t);
  f.audit.environment='production';
  f.audit.platform='darwin';
  f.audit.arch='arm64';
  f.audit.catalogPlatform='macos';
  const dmg=path.join(f.layout,'installer','BlackHole-Desktop-0.3.202-macos-arm64.dmg');
  fs.writeFileSync(dmg,f.content);
  f.audit.installer={file:'installer/BlackHole-Desktop-0.3.202-macos-arm64.dmg',sha256:hash(f.content),bytes:f.content.length};
  f.writeAudit();
  const keyFile=path.join(f.root,'signing.pem');
  const badUrl=spawnSync(process.execPath,[signer,'--layout',f.layout,'--installer-url','https://github.com/qianshe/BlackHole-core/releases/download/v0.3.202/BlackHole-Desktop-0.3.202-macos-arm64-unsigned.dmg','--signing-key',keyFile,'--output',f.output,'--confirm-production-signing'],{encoding:'utf8',windowsHide:true});
  assert.notEqual(badUrl.status,0);
  assert.match(badUrl.stderr,/production_installer_url_invalid/);
  const goodUrl=spawnSync(process.execPath,[signer,'--layout',f.layout,'--installer-url','https://github.com/qianshe/BlackHole-core/releases/download/v0.3.202/BlackHole-Desktop-0.3.202-macos-arm64.dmg','--signing-key',keyFile,'--output',f.output,'--confirm-production-signing'],{encoding:'utf8',windowsHide:true});
  assert.equal(goodUrl.status,0,goodUrl.stderr);
  const manifest=JSON.parse(fs.readFileSync(path.join(f.output,'latest.json'),'utf8'));
  assert.equal(manifest.environment,'production');
  assert.equal(manifest.platform,'macos');
  assert.equal(manifest.arch,'arm64');
});
test('generate-cloud-desktop-catalog renders multi-platform Cloud catalog and rejects test keys or duplicate targets',()=>{
  const pair=generateKeyPairSync('ed25519');
  const pubPem=pair.publicKey.export({type:'spki',format:'pem'}).toString();
  const makeFeed=(platform,arch,ext)=>{
    const m={
      schemaVersion:1,environment:'production',platform,arch,
      version:'0.4.26',buildId:`build-${platform}-${arch}`,
      coreVersion:'0.4.26',coreBuildId:`core-${platform}-${arch}`,
      installerUrl:`https://github.com/qianshe/BlackHole-core/releases/download/v0.4.26/BlackHole-Desktop-0.4.26-${platform}-${arch}${ext}`,
      installerSha256:'a'.repeat(64),installerBytes:34000000,
    };
    const manifestJson=JSON.stringify(m,null,2)+'\n';
    const signature=sign(null,Buffer.from(manifestJson,'utf8'),pair.privateKey).toString('base64');
    return {manifestJson,signature};
  };
  const feeds=[
    makeFeed('windows','x64','-setup.exe'),
    makeFeed('macos','arm64','.dmg'),
    makeFeed('macos','x64','.dmg'),
    makeFeed('linux','x64','.deb'),
    makeFeed('linux','arm64','.deb'),
  ];
  const rendered=renderDesktopReleaseCatalog({
    keyId:'prod-update-2026-v1',
    publicKeyPem:pubPem,
    channel:'stable',
    feeds,
  });
  assert.equal(rendered.entries,5);
  assert.deepEqual(rendered.targets,['linux-arm64','linux-x64','macos-arm64','macos-x64','windows-x64']);
  assert.match(rendered.source,/export const desktopReleaseKeys/);
  assert.match(rendered.source,/export const desktopReleaseCatalog/);

  assert.throws(()=>renderDesktopReleaseCatalog({
    keyId:'test-update-2026',
    publicKeyPem:pubPem,
    feeds,
  }),/catalog_key_id_invalid/);

  assert.throws(()=>renderDesktopReleaseCatalog({
    keyId:'prod-update-2026-v1',
    publicKeyPem:pubPem,
    feeds:[feeds[0],feeds[0]],
  }),/catalog_duplicate_platform_target/);
});
