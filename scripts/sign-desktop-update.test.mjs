// Isolated signer acceptance: no release keys, installed apps or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {generateKeyPairSync,createHash,verify} from 'node:crypto';
import {spawnSync} from 'node:child_process';

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
