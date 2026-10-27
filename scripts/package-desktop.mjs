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

const {values:a}=parseArgs({options:{seed:{type:'string'},'public-key':{type:'string'},'key-id':{type:'string'},manager:{type:'string'},output:{type:'string'},environment:{type:'string'},platform:{type:'string'},arch:{type:'string'},iscc:{type:'string'},'package-installer':{type:'boolean'},'desktop-version':{type:'string'},'update-feed':{type:'string'},'update-public-key':{type:'string'},'node-exe':{type:'string'},'node-sha256':{type:'string'},'node-license':{type:'string'},'node-license-sha256':{type:'string'}}});
for(const name of ['seed','public-key','key-id','manager','output','environment','node-exe','node-sha256','node-license','node-license-sha256'])if(!a[name])throw new Error(`argument_required:${name}`);
if(!['test','production'].includes(a.environment))throw new Error('environment_invalid');
if(a.environment==='production'&&/^test[-_]/i.test(a['key-id']))throw new Error('production_test_key_rejected');
const platform=a.platform??process.platform;
const arch=a.arch??process.arch;
const supportedTarget=(platform==='win32'&&arch==='x64')||((platform==='darwin'||platform==='linux')&&(arch==='x64'||arch==='arm64'));
if(!supportedTarget||platform!==process.platform||arch!==process.arch)throw new Error('desktop_platform_target_unsupported');
const catalogPlatform=platform==='win32'?'windows':platform==='darwin'?'macos':'linux';
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
const verified=await verifyCoreArchive(seed,{...trust,platform,arch});
const nodeInputs={nodeExe:path.resolve(a['node-exe']),nodeSha256:a['node-sha256'],nodeLicense:path.resolve(a['node-license']),nodeLicenseSha256:a['node-license-sha256']};
verifyDesktopNodeInputs(verified.descriptor,nodeInputs);
const nodeReceipt=probeDesktopNode(nodeInputs.nodeExe,verified.descriptor.nodeMinVersion,platform,arch);
if(!fs.statSync(entry).isFile()||fs.existsSync(output))throw new Error('fresh_output_and_manager_required');
const installerPreflight=path.join(path.dirname(entry),'installer-preflight-cli.cjs');
if(platform==='win32'&&!fs.statSync(installerPreflight).isFile())throw new Error('installer_preflight_build_required');
fs.mkdirSync(path.dirname(output),{recursive:true});fs.mkdirSync(output);
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'bh-desktop-package-'));
try {
 const runtime=stageDesktopNode(output,verified.descriptor,nodeInputs);
 fs.mkdirSync(path.join(output,'seed'));
 fs.copyFileSync(entry,path.join(output,'bootstrap/core-manager-cli.mjs'));
 // Installer-only embedded preflight; never a mutable runtime entry point.
 if(fs.existsSync(installerPreflight))fs.copyFileSync(installerPreflight,path.join(output,'installer-preflight-cli.cjs'));
 fs.writeFileSync(path.join(output,'bootstrap/trust.json'),JSON.stringify(trust,null,2)+'\n',{flag:'wx'});
 fs.copyFileSync(seed,path.join(output,'seed/core.zip'));
 fs.copyFileSync(path.join(root,'LICENSE'),path.join(output,'LICENSE.txt'));
 fs.copyFileSync(path.join(root,'NOTICE'),path.join(output,'NOTICE.txt'));
 // Node's license is pinned beside its only distributed executable; Core v2
 // carries its own code/Web notices, with no duplicate runtime inside the ZIP.
 const files=Object.fromEntries(['bootstrap/node.exe','bootstrap/node-LICENSE','bootstrap/core-manager-cli.mjs','bootstrap/trust.json','seed/core.zip'].map(name=>[name,sha256(fs.readFileSync(path.join(output,name)))]));
 const manifest={environment:a.environment,version,nodeRuntime:runtime.nodeRuntime,files};
 const encoded=Buffer.from(JSON.stringify(manifest)).toString('base64');
 const exeName=platform==='win32'?'blackhole.exe':'blackhole';
 const executable=path.join(output,exeName);
 // A Go Windows GUI executable has no PE icon by default. Without a proper
 // RT_GROUP_ICON resource Windows displays the generic program icon in the
 // taskbar and Start menu even when the WebView2 window supplies WM_SETICON.
 // Generate all icon sizes from the SAME Go renderer as the systray art and
 // compile a native .syso resource via go-winres.exe make BEFORE go build links
 // the PE image (avoiding post-link PE patching + symbol stripping heuristics).
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
 if(platform==='win32'){
  const resourceConfig=path.join(iconDir,'winres.json');
  fs.writeFileSync(resourceConfig,JSON.stringify({RT_GROUP_ICON:{'#1':{'0000':iconFiles}}},null,2)+'\n',{flag:'wx'});
  const sysoPrefix=path.join(root,'packages/desktop-launcher/cmd/blackhole/rsrc');
  const sysoFile=path.join(root,'packages/desktop-launcher/cmd/blackhole/rsrc_windows_amd64.syso');
  try {
   const iconMake=spawnSync('go-winres.exe',['make','--in',resourceConfig,'--arch','amd64','--out',sysoPrefix],{cwd:iconDir,encoding:'utf8',windowsHide:true});
   if(iconMake.status!==0||!fs.existsSync(sysoFile))throw new Error(`desktop_icon_resource_failed:${iconMake.error?.message??iconMake.stderr}`);
   const build=spawnSync('go',['-C',path.join(root,'packages/desktop-launcher'),'build','-trimpath','-ldflags',`-H=windowsgui -X blackhole/desktop-launcher/internal/distribution.EncodedManifest=${encoded} -X blackhole/desktop-launcher/internal/updatefeed.EncodedConfig=${updaterPin}`,'-o',executable,'./cmd/blackhole'],{encoding:'utf8',windowsHide:true});
   if(build.status!==0)throw new Error(`desktop_build_failed:${build.stderr}`);
  } finally {
   fs.rmSync(sysoFile,{force:true});
  }

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
 } else {
  const build=spawnSync('go',['-C',path.join(root,'packages/desktop-launcher'),'build','-trimpath','-ldflags',`-X blackhole/desktop-launcher/internal/distribution.EncodedManifest=${encoded} -X blackhole/desktop-launcher/internal/updatefeed.EncodedConfig=${updaterPin}`,'-o',executable,'./cmd/blackhole'],{encoding:'utf8',env:{...process.env,CGO_ENABLED:'1'}});
  if(build.status!==0)throw new Error(`desktop_build_failed:${build.stderr}`);
  fs.chmodSync(executable,0o755);
 }
 const gitHead=spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',windowsHide:true});
 const gitStatus=spawnSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8',windowsHide:true});
 const sourceHead=gitHead.status===0?gitHead.stdout.trim():null;
 const dirtyWorktree=gitStatus.status===0?gitStatus.stdout.trim()!=='':true;
 const audit={kind:'unsigned-desktop-candidate',platform,arch,catalogPlatform,...manifest,sourceHead,dirtyWorktree,seedDescriptorHash:verified.descriptorHash,
  core:{runtimeVersion:verified.descriptor.runtimeVersion,buildId:verified.descriptor.buildId,webBuildId:verified.descriptor.webBuildId,formatVersion:verified.descriptor.formatVersion,signingKeyId:verified.descriptor.signingKeyId,migrationPolicy:verified.descriptor.migrationPolicy},
  node:{version:nodeReceipt.node,sha256:files['bootstrap/node.exe'],licenseSha256:files['bootstrap/node-LICENSE'],distributedCopies:1,coreArchiveContainsNode:false},
  windowsIcon:{resourceId:1,sizes:iconSizes,source:'BlackHole shared tray mark'},
  updates:{configured:Boolean(updaterPin),feedOrigin:a['update-feed']?new URL(a['update-feed']).origin:null,publicKey:updaterPublicKey},
  signing:{
   coreEd25519:{verified:true,keyId:verified.descriptor.signingKeyId,descriptorHash:verified.descriptorHash,archiveSha256:verified.archiveHash},
   updateFeedEd25519:{configured:Boolean(updaterPin),publicKey:updaterPublicKey},
   windowsAuthenticode:{launcherSigned:false,installerSigned:false,status:'unsigned-candidate',productionRequiresAuthenticode:platform==='win32',note:'Core Ed25519 signature does not substitute for Windows Authenticode signing of blackhole.exe or setup.exe.'},
  },
  launcherSha256:sha256(fs.readFileSync(executable)),launcherBytes:fs.statSync(executable).size,installedPayloadBytes:fs.statSync(executable).size+Object.keys(files).reduce((n,name)=>n+fs.statSync(path.join(output,name)).size,0),nativeUIAccepted:false,installerAccepted:false};
 fs.writeFileSync(path.join(output,'distribution-audit.json'),JSON.stringify(audit,null,2)+'\n',{flag:'wx'});
 if(platform==='win32'&&a.iscc){
  const compiler=path.resolve(a.iscc);if(!fs.statSync(compiler).isFile())throw new Error('inno_compiler_missing');
  const compile=spawnSync(compiler,[`/DStageRoot=${output}`,`/DAppVersion=${version}`,`/DBuildEnvironment=${a.environment}`,path.join(root,'installers/windows/desktop.iss')],{encoding:'utf8',windowsHide:true});
  fs.mkdirSync(path.join(output,'installer'),{recursive:true});
  fs.writeFileSync(path.join(output,'installer/compiler.log'),`${compile.stdout??''}\n${compile.stderr??''}`);
  if(compile.status!==0)throw new Error(`inno_compile_failed:${compile.stdout}:${compile.stderr}`);
  const name=a.environment==='production'?`BlackHole-Desktop-${version}-windows-x64-setup.exe`:`BlackHole-Desktop-${version}-test-unsigned-setup.exe`;
  const file=path.join(output,'installer',name);
  audit.installer={compiled:true,file:`installer/${name}`,bytes:fs.statSync(file).size,sha256:sha256(fs.readFileSync(file)),executed:false,compilerSha256:sha256(fs.readFileSync(compiler)),compilerVersion:compile.stdout?.match(/Compiler engine version: ([^\r\n]+)/)?.[1]??'unknown',commercialLicenseVerified:false};
  fs.writeFileSync(path.join(output,'distribution-audit.json'),JSON.stringify(audit,null,2)+'\n');
 } else if(platform==='darwin'&&a['package-installer']){
  const suffix=a.environment==='test'?'-test':'';
  const appName=a.environment==='test'?'BlackHole (Test).app':'BlackHole.app';
  const bundleId=a.environment==='test'?'dpdns.stellarbridge.blackhole.desktop.test':'dpdns.stellarbridge.blackhole.desktop';
  const dmgStage=path.join(temp,'dmg-stage');
  const contents=path.join(dmgStage,appName,'Contents');
  const macosDir=path.join(contents,'MacOS');
  const resDir=path.join(contents,'Resources');
  fs.mkdirSync(macosDir,{recursive:true});fs.mkdirSync(resDir,{recursive:true});
  fs.copyFileSync(executable,path.join(macosDir,'blackhole'));fs.chmodSync(path.join(macosDir,'blackhole'),0o755);
  fs.cpSync(path.join(output,'bootstrap'),path.join(macosDir,'bootstrap'),{recursive:true});
  fs.chmodSync(path.join(macosDir,'bootstrap','node.exe'),0o755);
  fs.cpSync(path.join(output,'seed'),path.join(macosDir,'seed'),{recursive:true});
  fs.copyFileSync(path.join(output,'LICENSE.txt'),path.join(macosDir,'LICENSE.txt'));
  fs.copyFileSync(path.join(output,'NOTICE.txt'),path.join(macosDir,'NOTICE.txt'));
  fs.copyFileSync(path.join(iconDir,'icon-256.png'),path.join(resDir,'icon.png'));
  fs.writeFileSync(path.join(contents,'Info.plist'),[
   '<?xml version="1.0" encoding="UTF-8"?>',
   '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
   '<plist version="1.0"><dict>',
   `<key>CFBundleExecutable</key><string>blackhole</string>`,
   `<key>CFBundleIdentifier</key><string>${bundleId}</string>`,
   `<key>CFBundleName</key><string>${a.environment==='test'?'BlackHole (Test)':'BlackHole'}</string>`,
   `<key>CFBundleShortVersionString</key><string>${version}</string>`,
   `<key>CFBundleVersion</key><string>${version}</string>`,
   '<key>CFBundlePackageType</key><string>APPL</string>',
   '<key>NSHighResolutionCapable</key><true/>',
   '</dict></plist>',
  ].join('\n')+'\n');
  fs.mkdirSync(path.join(output,'installer'),{recursive:true});
  const name=`BlackHole-Desktop-${version}-macos-${arch}${suffix}.dmg`;
  const file=path.join(output,'installer',name);
  const dmg=spawnSync('hdiutil',['create','-volname',a.environment==='test'?'BlackHole Desktop Test':'BlackHole Desktop','-srcfolder',dmgStage,'-ov','-format','UDZO',file],{encoding:'utf8'});
  if(dmg.status!==0)throw new Error(`macos_dmg_build_failed:${dmg.stderr||dmg.stdout}`);
  audit.installer={compiled:true,file:`installer/${name}`,bytes:fs.statSync(file).size,sha256:sha256(fs.readFileSync(file)),executed:false,compilerVersion:'hdiutil UDZO'};
  fs.writeFileSync(path.join(output,'distribution-audit.json'),JSON.stringify(audit,null,2)+'\n');
 } else if(platform==='linux'&&a['package-installer']){
  const suffix=a.environment==='test'?'-test':'';
  const debArch=arch==='arm64'?'arm64':'amd64';
  const pkgName=a.environment==='test'?'blackhole-desktop-test':'blackhole-desktop';
  const installDir=a.environment==='test'?'/opt/BlackHole-Test':'/opt/BlackHole';
  const debRoot=path.join(temp,'deb-root');
  const optDir=path.join(debRoot,...installDir.slice(1).split('/'));
  const binDir=path.join(debRoot,'usr','bin');
  const appsDir=path.join(debRoot,'usr','share','applications');
  const iconsDir=path.join(debRoot,'usr','share','icons','hicolor','256x256','apps');
  const debianDir=path.join(debRoot,'DEBIAN');
  for(const d of [optDir,binDir,appsDir,iconsDir,debianDir])fs.mkdirSync(d,{recursive:true});
  fs.copyFileSync(executable,path.join(optDir,'blackhole'));fs.chmodSync(path.join(optDir,'blackhole'),0o755);
  fs.cpSync(path.join(output,'bootstrap'),path.join(optDir,'bootstrap'),{recursive:true});
  fs.chmodSync(path.join(optDir,'bootstrap','node.exe'),0o755);
  fs.cpSync(path.join(output,'seed'),path.join(optDir,'seed'),{recursive:true});
  fs.copyFileSync(path.join(output,'LICENSE.txt'),path.join(optDir,'LICENSE.txt'));
  fs.copyFileSync(path.join(output,'NOTICE.txt'),path.join(optDir,'NOTICE.txt'));
  fs.copyFileSync(path.join(iconDir,'icon-256.png'),path.join(iconsDir,`${pkgName}.png`));
  const wrapper=path.join(binDir,pkgName);
  fs.writeFileSync(wrapper,`#!/bin/sh\nexec "${installDir}/blackhole" "$@"\n`,{mode:0o755});
  fs.writeFileSync(path.join(appsDir,`${pkgName}.desktop`),[
   '[Desktop Entry]',
   'Type=Application',
   `Name=${a.environment==='test'?'BlackHole Desktop (Test)':'BlackHole Desktop'}`,
   `Exec=${installDir}/blackhole`,
   `Icon=${pkgName}`,
   'Terminal=false',
   'Categories=Development;Utility;',
  ].join('\n')+'\n');
  fs.writeFileSync(path.join(debianDir,'control'),[
   `Package: ${pkgName}`,
   `Version: ${version}`,
   'Section: devel',
   'Priority: optional',
   `Architecture: ${debArch}`,
   'Maintainer: BlackHole <support@stellarbridge.dpdns.org>',
   'Description: BlackHole Desktop shared-core native shell',
  ].join('\n')+'\n');
  fs.mkdirSync(path.join(output,'installer'),{recursive:true});
  const name=`BlackHole-Desktop-${version}-linux-${arch}${suffix}.deb`;
  const file=path.join(output,'installer',name);
  const deb=spawnSync('dpkg-deb',['--root-owner-group','--build',debRoot,file],{encoding:'utf8'});
  if(deb.status!==0)throw new Error(`linux_deb_build_failed:${deb.stderr||deb.stdout}`);
  audit.installer={compiled:true,file:`installer/${name}`,bytes:fs.statSync(file).size,sha256:sha256(fs.readFileSync(file)),executed:false,compilerVersion:'dpkg-deb'};
  fs.writeFileSync(path.join(output,'distribution-audit.json'),JSON.stringify(audit,null,2)+'\n');
 }
 console.log(JSON.stringify({ok:true,output,...audit,installerCompiled:Boolean(audit.installer?.compiled)}));
}finally{fs.rmSync(temp,{recursive:true,force:true,maxRetries:20,retryDelay:100});}
