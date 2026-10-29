// Offline release-owner tool. Signs a complete Desktop + Core bundle manifest
// after verifying the immutable layout. It never deploys/uploads anything.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createPrivateKey, createPublicKey, sign, createHash } from 'node:crypto';

const {values:a}=parseArgs({options:{
  layout:{type:'string'},'installer-url':{type:'string'},
  'signing-key':{type:'string'},output:{type:'string'},
  'confirm-production-signing':{type:'boolean'}
}});
for(const field of ['layout','installer-url','signing-key','output'])if(!a[field])throw new Error('update_manifest_argument_required:'+field);
const layout=path.resolve(a.layout),output=path.resolve(a.output);
if(fs.existsSync(output))throw new Error('fresh_output_required');
const raw=JSON.parse(fs.readFileSync(path.join(layout,'distribution-audit.json'),'utf8'));
if(raw.kind!=='unsigned-desktop-candidate'||!['test','production'].includes(raw.environment)||!raw.updates?.configured||!raw.updates.publicKey){
  throw new Error('signed_test_release_required');
}
if(raw.environment==='production'&&a['confirm-production-signing']!==true){
  // Production feed signing requires explicit release-owner confirmation.
  throw new Error('signed_test_release_required');
}
if(!/^\d+\.\d+\.\d+$/.test(raw.version) || !/^\d+\.\d+\.\d+$/.test(raw.core?.runtimeVersion) ||
   !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(raw.core?.buildId??''))throw new Error('release_version_invalid');
const catalogPlatform=raw.catalogPlatform??(raw.platform==='darwin'?'macos':raw.platform==='linux'?'linux':'windows');
const catalogArch=raw.arch??'x64';
if(!['windows','macos','linux'].includes(catalogPlatform)||!['x64','arm64'].includes(catalogArch))throw new Error('update_platform_invalid');
const installer=path.resolve(layout,raw.installer?.file??'');
if(!installer.startsWith(path.join(layout,'installer')+path.sep) || !fs.statSync(installer).isFile())throw new Error('release_installer_missing');
const installerBytes=fs.readFileSync(installer);
const hash=createHash('sha256').update(installerBytes).digest('hex');
if(hash!==raw.installer.sha256 || installerBytes.length!==raw.installer.bytes)throw new Error('installer_audit_mismatch');
const url=new URL(a['installer-url']);
if(url.protocol!=='https:'||!url.hostname||url.username||url.password||url.hash||url.search||url.href!==a['installer-url'])throw new Error('update_installer_url_invalid');
if(raw.environment==='production'){
  const prefix=`/qianshe/BlackHole-core/releases/download/v${raw.version}/`;
  const filename=url.pathname.slice(prefix.length);
  const ext=catalogPlatform==='windows'?/\.exe$/:catalogPlatform==='macos'?/\.(dmg|zip)$/:/\.(AppImage|deb|rpm)$/;
  if(url.origin!=='https://github.com'||!url.pathname.startsWith(prefix)||!/^BlackHole-[A-Za-z0-9._-]+$/.test(filename)||!ext.test(filename)||/unsigned|test|candidate/i.test(filename)){
    throw new Error('production_installer_url_invalid');
  }
}
const keyFile=path.resolve(a['signing-key']);
const privateKey=createPrivateKey(fs.readFileSync(keyFile));
if(privateKey.asymmetricKeyType!=='ed25519')throw new Error('update_signing_key_invalid');
const der=createPublicKey(privateKey).export({format:'der',type:'spki'});
const prefix=Buffer.from('302a300506032b6570032100','hex');
if(!der.subarray(0,prefix.length).equals(prefix)||der.length!==prefix.length+32)throw new Error('update_signing_key_invalid');
if(der.subarray(prefix.length).toString('base64')!==raw.updates.publicKey)throw new Error('update_signer_mismatch');
const manifest={
 schemaVersion:1,environment:raw.environment,platform:catalogPlatform,arch:catalogArch,
 version:raw.version,buildId:raw.launcherSha256?.slice(0,16)??'',
 coreVersion:raw.core.runtimeVersion,coreBuildId:raw.core.buildId,
 installerUrl:url.href,installerSha256:hash,installerBytes:installerBytes.length,
};
if(!manifest.buildId)throw new Error('update_build_id_missing');
const content=Buffer.from(JSON.stringify(manifest,null,2)+'\n');
const signature=sign(null,content,privateKey).toString('base64')+'\n';
fs.mkdirSync(output,{recursive:true});
fs.writeFileSync(path.join(output,'latest.json'),content,{flag:'wx'});
fs.writeFileSync(path.join(output,'latest.json.sig'),signature,{flag:'wx'});
console.log(JSON.stringify({ok:true,environment:raw.environment,platform:catalogPlatform,arch:catalogArch,manifestSha256:createHash('sha256').update(content).digest('hex'),installerSha256:hash,coreDescriptorHash:raw.seedDescriptorHash,files:['latest.json','latest.json.sig']}));
