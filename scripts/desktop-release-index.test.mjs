import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {renderDesktopReleaseIndex} from './generate-cloud-desktop-catalog.mjs';
const pair=generateKeyPairSync('ed25519'),publicKeyPem=pair.publicKey.export({type:'spki',format:'pem'});
function feeds(){return ['windows-x64','macos-x64','macos-arm64','linux-x64','linux-arm64'].map(target=>{
 const [platform,arch]=target.split('-'),ext=platform==='windows'?'exe':platform==='macos'?'dmg':'deb';
 const manifestJson=JSON.stringify({schemaVersion:1,environment:'production',platform,arch,version:'0.4.32',buildId:'build-32',coreVersion:'0.4.32',coreBuildId:'core-32',installerUrl:'https://github.com/qianshe/BlackHole-core/releases/download/v0.4.32/BlackHole-Desktop-0.4.32-'+target+'.'+ext,installerSha256:'a'.repeat(64),installerBytes:60000000});
 return {manifestJson,signature:sign(null,Buffer.from(manifestJson),pair.privateKey).toString('base64')};
});}
const options=()=>({keyId:'prod-fixture',publicKeyPem,feeds:feeds()});
test('public index preserves all five signed manifest bytes without including trust roots or executable source',()=>{
 const o=options(),index=JSON.parse(renderDesktopReleaseIndex(o));
 assert.deepEqual(Object.keys(index).sort(),['entries','schemaVersion','version']);assert.equal(index.version,'0.4.32');assert.equal(index.entries.length,5);
 for(const f of o.feeds){const e=index.entries.find(e=>e.manifestJson===f.manifestJson);assert.equal(e.signature,f.signature);assert.equal(e.channel,'stable');}
});
test('partial and duplicate platform releases cannot produce a discoverable index',()=>{
 const o=options();o.feeds.pop();assert.throws(()=>renderDesktopReleaseIndex(o),/five_targets/);
 const dup=options();dup.feeds[1]=dup.feeds[0];assert.throws(()=>renderDesktopReleaseIndex(dup),/duplicate/);
});
test('test/preview channel and modified signed bytes never become a stable index',()=>{
 assert.throws(()=>renderDesktopReleaseIndex({...options(),channel:'preview'}),/stable_only/);
 const o=options();o.feeds[0].manifestJson+=' ';assert.throws(()=>renderDesktopReleaseIndex(o),/signature_verification/);
});
