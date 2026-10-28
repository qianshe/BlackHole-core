import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyNativeReceipt,targets} from './review-desktop-community-release.mjs';
const sha='a'.repeat(40),digest='b'.repeat(64);
function fixture(){
 const manifest={platform:'linux',arch:'arm64',version:'0.4.31',coreVersion:'0.4.31',coreBuildId:'release-arm64',installerSha256:digest,installerBytes:1000000};
 const audit={sourceHead:sha,dirtyWorktree:false,environment:'production',platform:'linux',arch:'arm64',version:'0.4.31',core:{runtimeVersion:'0.4.31',buildId:'release-arm64'},installer:{sha256:digest,bytes:1000000}};
 const receipt={schemaVersion:1,sourceSha:sha,platform:'linux',arch:'arm64',version:'0.4.31',installerSha256:digest,installed:true,reinstalled:true,bootstrapHealth:true,nodePinVerified:true,uninstalled:true,userDataRetained:true,nativeUIAccepted:false};
 return {manifest,audit,receipt};
}
test('the release requires all five OS/architecture targets',()=>assert.deepEqual(targets,['windows-x64','macos-x64','macos-arm64','linux-x64','linux-arm64']));
test('native headless receipt binds source, target, artifact and installation results',()=>{
 const f=fixture();assert.equal(verifyNativeReceipt(f.audit,f.receipt,f.manifest,{sourceSha:sha,target:'linux-arm64'}),true);
});
for(const field of ['sourceSha','installerSha256','arch','version','reinstalled','userDataRetained'])test('rejects mismatched native evidence: '+field,()=>{
 const f=fixture();f.receipt[field]=typeof f.receipt[field]==='boolean'?false:'wrong';
 assert.throws(()=>verifyNativeReceipt(f.audit,f.receipt,f.manifest,{sourceSha:sha,target:'linux-arm64'}));
});
test('an unsigned Mac receipt cannot claim ad-hoc verification',()=>{
 const f=fixture();f.manifest.platform='macos';f.audit.platform='darwin';f.receipt.platform='darwin';f.audit.signing={macos:{identity:'none',verified:false}};
 assert.throws(()=>verifyNativeReceipt(f.audit,f.receipt,f.manifest,{sourceSha:sha,target:'macos-arm64'}));
});
