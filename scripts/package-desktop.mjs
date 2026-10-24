// Creates an unsigned developer/candidate Desktop layout, never installs it.
// The native launcher pins bootstrap hashes at compile time; mutable metadata
// is audit output only, not a runtime source of trust.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { createPublicKey } from 'node:crypto';
import { verifyCoreArchive, sha256 } from './core-runtime-lib.mjs';
import { verifyDesktopNodeInputs, probeDesktopNode, stageDesktopNode } from './desktop-node-layout.mjs';

const {values:a}=parseArgs({options:{seed:{type:'string'},'public-key':{type:'string'},'key-id':{type:'string'},manager:{type:'string'},output:{type:'string'},environment:{type:'string'},iscc:{type:'string'},'desktop-version':{type:'string'},'update-feed':{type:'string'},'update-public-key':{type:'string'},'node-exe':{type:'string'},'node-sha256':{type:'string'},'node-license':{type:'string'},'node-license-sha256':{type:'string'}}});
for(const name of ['seed','public-key','key-id','manager','output','environment','node-exe','node-sha256','node-license','node-license-sha256'])if(!a[name])throw new Error(`argument_required:${name}`);
if(process.platform!=='win32'||process.arch!=='x64')throw new Error('windows_x64_only');
if(!['test','production'].includes(a.environment))throw new Error('environment_invalid');
if(a.environment==='production'&&/^test[-_]/i.test(a['key-id']))throw new Error('production_test_key_rejected');
const root=fileURLToPath(new URL('..',import.meta.url));
// The native shell's installer version is intentionally independent from
// the bundled signed Core's runtimeVersion. Retain the old default for CI.
const version=a['desktop-version']??JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version;
if(!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))throw new Error('desktop_version_invalid');
// An update feed is optional until the release owner configures a separate
// signing key and HTTPS endpoint. Never embed a private key or allow URL env
// overrides in the installed launcher.
if(Boolean(a['update-feed'])!==Boolean(a['update-public-key']))throw new Error('update_feed_key_pair_required');
let updaterPin='';
let updaterPublicKey=null;
if(a['update-feed']){
 const u=new URL(a['update-feed']);
 if(u.protocol!=='https:'||!u.hostname||u.username||u.password||u.hash||u.search)throw new Error('update_feed_url_invalid');
 const der=createPublicKey(fs.readFileSync(path.resolve(a['update-public-key']))).export({type:'spki',format:'der'});
 const prefix=Buffer.from('302a300506032b6570032100','hex');
 if(!der.subarray(0,prefix.length).equals(prefix)||der.length!==prefix.length+32)throw new Error('update_key_not_ed25519');
 updaterPublicKey=der.subarray(prefix.length).toString('base64');
 updaterPin=Buffer.from(JSON.stringify({environment:a.environment,currentVersion:version,feedUrl:u.href,publicKey:updaterPublicKey})).toString('base64');
}
const trust={environment:a.environment,publicKeys:{[a['key-id']]:fs.readFileSync(path.resolve(a['public-key']),'utf8')}};
if(a.environment==='test'&&process.env.BH_PRIOR_TEST_CORE_PUBLIC_KEYS_JSON){
 const prior=JSON.parse(process.env.BH_PRIOR_TEST_CORE_PUBLIC_KEYS_JSON);
 if(!Array.isArray(prior)||prior.length>7)throw new Error('previous_test_trust_invalid');
 for(const item of prior){
  if(typeof item?.keyId!=='string'||!/^test[-_][A-Za-z0-9_-]{1,100}$/.test(item.keyId)||typeof item?.publicKey!=='string'||createPublicKey(item.publicKey).asymmetricKeyType!=='ed25519')throw new Error('previous_test_trust_invalid');
  if(!Object.hasOwn(trust.publicKeys,item.keyId))trust.publicKeys[item.keyId]=item.publicKey;
 }
}
const seed=path.resolve(a.seed),entry=path.resolve(a.manager),output=path.resolve(a.output);
const verified=await verifyCoreArchive(seed,{...trust,platform:'win32',arch:'x64'});
const nodeInputs={nodeExe:path.resolve(a['node-exe']),nodeSha256:a['node-sha256'],nodeLicense:path.resolve(a['node-license']),nodeLicenseSha256:a['node-license-sha256']};
verifyDesktopNodeInputs(verified.descriptor,nodeInputs);
const nodeReceipt=probeDesktopNode(nodeInputs.nodeExe,verified.descriptor.nodeMinVersion);
if(!fs.statSync(entry).isFile()||fs.existsSync(output))throw new Error('fresh_output_and_manager_required');
const installerPreflight=path.join(path.dirname(entry),'installer-preflight-cli.cjs');
if(!fs.statSync(installerPreflight).isFile())throw new Error('installer_preflight_build_required');
fs.mkdirSync(path.dirname(output),{recursive:true});fs.mkdirSync(output);
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'bh-desktop-package-'));
try {
 const runtime=stageDesktopNode(output,verified.descriptor,nodeInputs);
 fs.mkdirSync(path.join(output,'seed'));
 fs.copyFileSync(entry,path.join(output,'bootstrap/core-manager-cli.mjs'));
 // Installer-only embedded preflight; never a mutable runtime entry point.
 fs.copyFileSync(installerPreflight,path.join(output,'installer-preflight-cli.cjs'));
 fs.writeFileSync(path.join(output,'bootstrap/trust.json'),JSON.stringify(trust,null,2)+'\n',{flag:'wx'});
 fs.copyFileSync(seed,path.join(output,'seed/core.zip'));
 fs.copyFileSync(path.join(root,'LICENSE'),path.join(output,'LICENSE.txt'));
 fs.copyFileSync(path.join(root,'NOTICE'),path.join(output,'NOTICE.txt'));
 // Node's license is pinned beside its only distributed executable; Core v2
 // carries its own code/Web notices, with no duplicate runtime inside the ZIP.
 const files=Object.fromEntries(['bootstrap/node.exe','bootstrap/node-LICENSE','bootstrap/core-manager-cli.mjs','bootstrap/trust.json','seed/core.zip'].map(name=>[name,sha256(fs.readFileSync(path.join(output,name)))]));
 const manifest={environment:a.environment,version,nodeRuntime:runtime.nodeRuntime,files};
 const encoded=Buffer.from(JSON.stringify(manifest)).toString('base64');
 const executable=path.join(output,'blackhole.exe');
 const build=spawnSync('go',['-C',path.join(root,'packages/desktop-launcher'),'build','-trimpath','-ldflags',`-H=windowsgui -s -w -X blackhole/desktop-launcher/internal/distribution.EncodedManifest=${encoded} -X blackhole/desktop-launcher/internal/updatefeed.EncodedConfig=${updaterPin}`,'-o',executable,'./cmd/blackhole'],{encoding:'utf8',windowsHide:true});
 if(build.status!==0)throw new Error(`desktop_build_failed:${build.stderr}`);

 // A Go Windows GUI executable has no PE icon by default. Without a proper
 // RT_GROUP_ICON resource Windows displays the generic program icon in the
 // taskbar and Start menu even when the WebView2 window supplies WM_SETICON.
 // Generate all icon sizes from the SAME Go renderer as the systray art.
 const iconDir=path.join(temp,'desktop-icon');
 const iconSizes=[16,24,32,48,64,128,256];
 const render=spawnSync('go',['-C',path.join(root,'packages/desktop-launcher'),'run','./cmd/icon-resource',iconDir],{encoding:'utf8',windowsHide:true});
 if(render.status!==0)throw new Error(`desktop_icon_render_failed:${render.error?.message??render.stderr}`);
 const iconFiles=iconSizes.map(size=>`icon-${size}.png`);
 for (const [index,name] of iconFiles.entries()){
  const bytes=fs.readFileSync(path.join(iconDir,name));
  if(bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'
    || bytes.readUInt32BE(16)!==iconSizes[index]
    || bytes.readUInt32BE(20)!==iconSizes[index])
   throw new Error(`desktop_icon_dimension_invalid:${name}`);
 }
 const resourceConfig=path.join(iconDir,'winres.json');
 fs.writeFileSync(resourceConfig,JSON.stringify({RT_GROUP_ICON:{'#1':{'0000':iconFiles}}},null,2)+'\n',{flag:'wx'});
 // The resource patch is applied only to the freshly built candidate,
 // never to an installed executable or signed release binary.
 const iconPatch=spawnSync('go-winres.exe',['patch','--in',resourceConfig,'--no-backup',executable],{encoding:'utf8',windowsHide:true});
 if(iconPatch.status!==0)throw new Error(`desktop_icon_resource_failed:${iconPatch.error?.message??iconPatch.stderr}`);

 // Read back the actual PE resources, not merely the temporary source images:
 // a successful patch command must leave every intended DPI size in the EXE.
 const extracted=path.join(temp,'verify-embedded-icon');
 const resourceReadback=spawnSync('go-winres.exe',['extract','--dir',extracted,executable],{encoding:'utf8',windowsHide:true});
 if(resourceReadback.status!==0)throw new Error(`desktop_icon_readback_failed:${resourceReadback.error?.message??resourceReadback.stderr}`);
 const gotConfig=JSON.parse(fs.readFileSync(path.join(extracted,'winres.json'),'utf8'));
 const gotIcon=gotConfig.RT_GROUP_ICON?.['#1']?.['0000'];
 if(typeof gotIcon!=='string')throw new Error('desktop_icon_group_missing');
 const ico=fs.readFileSync(path.join(extracted,gotIcon));
 if(ico.readUInt16LE(0)!==0||ico.readUInt16LE(2)!==1||ico.readUInt16LE(4)!==iconSizes.length)throw new Error('desktop_icon_entries_missing');
 const gotSizes=[];
 for(let i=0;i<iconSizes.length;i++){
  const entrySize=ico[6+i*16];
  gotSizes.push(entrySize===0?256:entrySize);
 }
 if(iconSizes.some(size=>!gotSizes.includes(size)))throw new Error('desktop_icon_sizes_missing');
 const audit={kind:'unsigned-desktop-candidate',...manifest,seedDescriptorHash:verified.descriptorHash,
  core:{runtimeVersion:verified.descriptor.runtimeVersion,buildId:verified.descriptor.buildId,webBuildId:verified.descriptor.webBuildId,formatVersion:verified.descriptor.formatVersion},
  node:{version:nodeReceipt.node,sha256:files['bootstrap/node.exe'],licenseSha256:files['bootstrap/node-LICENSE'],distributedCopies:1,coreArchiveContainsNode:false},
  windowsIcon:{resourceId:1,sizes:iconSizes,source:'BlackHole shared tray mark'},
  updates:{configured:Boolean(updaterPin),feedOrigin:a['update-feed']?new URL(a['update-feed']).origin:null,publicKey:updaterPublicKey},
  launcherSha256:sha256(fs.readFileSync(executable)),installedPayloadBytes:fs.statSync(executable).size+Object.keys(files).reduce((n,name)=>n+fs.statSync(path.join(output,name)).size,0),nativeUIAccepted:false,installerAccepted:false};
 fs.writeFileSync(path.join(output,'distribution-audit.json'),JSON.stringify(audit,null,2)+'\n',{flag:'wx'});
 if(a.iscc){
  const compiler=path.resolve(a.iscc);if(!fs.statSync(compiler).isFile())throw new Error('inno_compiler_missing');
  const compile=spawnSync(compiler,[`/DStageRoot=${output}`,`/DAppVersion=${version}`,`/DBuildEnvironment=${a.environment}`,path.join(root,'installers/windows/desktop.iss')],{encoding:'utf8',windowsHide:true});
  fs.mkdirSync(path.join(output,'installer'),{recursive:true});
  fs.writeFileSync(path.join(output,'installer/compiler.log'),`${compile.stdout??''}\n${compile.stderr??''}`);
  if(compile.status!==0)throw new Error(`inno_compile_failed:${compile.stdout}:${compile.stderr}`);
  const name=`BlackHole-Desktop-${version}-${a.environment}-unsigned-setup.exe`,file=path.join(output,'installer',name);
  audit.installer={compiled:true,file:`installer/${name}`,bytes:fs.statSync(file).size,sha256:sha256(fs.readFileSync(file)),executed:false,compilerSha256:sha256(fs.readFileSync(compiler)),compilerVersion:compile.stdout?.match(/Compiler engine version: ([^\r\n]+)/)?.[1]??'unknown',commercialLicenseVerified:false};
  fs.writeFileSync(path.join(output,'distribution-audit.json'),JSON.stringify(audit,null,2)+'\n');
 }
 console.log(JSON.stringify({ok:true,output,...audit,installerCompiled:Boolean(a.iscc)}));
}finally{fs.rmSync(temp,{recursive:true,force:true,maxRetries:20,retryDelay:100});}
