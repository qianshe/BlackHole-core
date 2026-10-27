// Local Windows x64 Test candidate builder (Core v2 + VSIX + Desktop + Inno Setup
// Installer + signed Update Feed + Artifact Manifest + Preflight + SBOM).
// Does not install, restart, publish or touch the real Core. Ephemeral signing
// private keys exist only during packaging and are deleted before completion;
// the output directory retains only public verification keys and audit proofs.
//
// Usage:
//   node scripts/package-vscode-local-test.mjs FRESH_OUTPUT_DIR [EXISTING_TEST_TRUST_JSON INSTALLED_CORE_DESCRIPTOR_JSON]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, execFileSync, spawnSync } from 'node:child_process';
import { generateKeyPairSync, createPrivateKey, createPublicKey, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CoreDescriptorSchema } from '../packages/contracts/dist/index.js';
import { resolveBuildConfig } from '../packages/vscode/build-config.mjs';
import { listFiles, sha256, signDescriptor, writeArchive, verifyCoreArchive } from './core-runtime-lib.mjs';
import { auditUniversalVsix } from './audit-universal-vsix.mjs';
import { buildArtifactManifest, buildReleaseMetadata } from './release-metadata.mjs';
import { runPreflight } from './shared-core-acceptance-preflight.mjs';
import { evaluateDesktopGates } from './desktop-release-gate.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const args=process.argv.slice(2);
if(args.length!==1&&args.length!==3)
  throw Error('usage: node scripts/package-vscode-local-test.mjs FRESH_OUTPUT [EXISTING_TEST_TRUST INSTALLED_CORE_DESCRIPTOR]');
const [targetArg,trustArg,previousDescriptorArg]=args;
const output=path.resolve(targetArg),tempRoot=path.resolve(root,'.tmp');
if(!output.startsWith(tempRoot+path.sep)||fs.existsSync(output))
  throw Error('fresh_workspace_test_output_required');

function resolveDefaultInputs(){
  const home=os.homedir();
  const activeFile=path.join(home,'.blackhole','core','active.json');
  const active=JSON.parse(fs.readFileSync(activeFile,'utf8'));
  const descriptorPath=path.join(home,'.blackhole','core','versions',active.versionName,'core-descriptor.json');
  const extRoot=path.join(home,'.vscode','extensions');
  const extJson=JSON.parse(fs.readFileSync(path.join(extRoot,'extensions.json'),'utf8'));
  const entry=extJson.find(x=>String(x?.identifier?.id).toLowerCase()==='qianshe.blackhole-vscode');
  if(!entry?.relativeLocation)throw Error('installed_vscode_extension_not_found');
  const trustPath=path.join(extRoot,entry.relativeLocation,'dist','manager','trust.json');
  return {trustPath,descriptorPath};
}
const resolvedInputs=trustArg&&previousDescriptorArg
  ? {trustPath:path.resolve(trustArg),descriptorPath:path.resolve(previousDescriptorArg)}
  : resolveDefaultInputs();
const trustPath=resolvedInputs.trustPath,previousPath=resolvedInputs.descriptorPath;
const trust=JSON.parse(fs.readFileSync(trustPath,'utf8'));
const previous=CoreDescriptorSchema.parse(JSON.parse(fs.readFileSync(previousPath,'utf8')));
const activePointerPath=path.join(os.homedir(),'.blackhole','core','active.json');
if(fs.existsSync(activePointerPath)){
  const activePointer=JSON.parse(fs.readFileSync(activePointerPath,'utf8'));
  const activeDescPath=path.join(os.homedir(),'.blackhole','core','versions',activePointer.versionName,'core-descriptor.json');
  if(fs.existsSync(activeDescPath)){
    const activeDesc=JSON.parse(fs.readFileSync(activeDescPath,'utf8'));
    if(activeDesc.environment==='test'&&!Object.hasOwn(trust.publicKeys??{},activeDesc.signingKeyId))
      throw Error(`active_core_signing_key_missing_from_trust:${activeDesc.signingKeyId}`);
  }
}
const profile=resolveBuildConfig('test');
if(trust.environment!=='test'||!trust.publicKeys||Object.keys(trust.publicKeys).length<1
  ||Object.keys(trust.publicKeys).length>8||previous.environment!=='test'
  ||previous.cloudOrigin!==profile.origin||previous.platform!=='win32'
  ||previous.arch!=='x64'||!/^0[.]4[.]\d+$/.test(previous.runtimeVersion)
  ||previous.dataSchema.min!==1||previous.dataSchema.max!==1
  ||previous.coreProtocol.min>1||previous.coreProtocol.max<1
  ||!Object.hasOwn(trust.publicKeys,previous.signingKeyId))
  throw Error('incompatible_previous_test_runtime_or_trust');
const allPreviousKeys=Object.entries(trust.publicKeys).map(([keyId,publicKey])=>{
  if(!/^test[-_][A-Za-z0-9_-]{1,100}$/.test(keyId)
    ||typeof publicKey!=='string'||!publicKey.includes('-----BEGIN PUBLIC KEY-----')
    ||createPublicKey(publicKey).asymmetricKeyType!=='ed25519')
    throw Error('previous_test_key_invalid');
  return {keyId,publicKey};
});
function ensurePersistentTestKeyPair(privateKeyPath,publicKeyPath){
  if(fs.existsSync(privateKeyPath)){
    const privatePem=fs.readFileSync(privateKeyPath,'utf8');
    const privateKey=createPrivateKey(privatePem);
    if(privateKey.asymmetricKeyType!=='ed25519')throw Error(`invalid_ed25519_key:${privateKeyPath}`);
    const publicKey=createPublicKey(privateKey);
    const publicPem=publicKey.export({type:'spki',format:'pem'}).toString();
    if(publicKeyPath&&!fs.existsSync(publicKeyPath))fs.writeFileSync(publicKeyPath,publicPem,{mode:0o600});
    return {privateKey,publicKey,privateKeyPath:path.resolve(privateKeyPath),publicPem};
  }
  fs.mkdirSync(path.dirname(privateKeyPath),{recursive:true,mode:0o700});
  const pair=generateKeyPairSync('ed25519');
  const privatePem=pair.privateKey.export({type:'pkcs8',format:'pem'}).toString();
  const publicPem=pair.publicKey.export({type:'spki',format:'pem'}).toString();
  fs.writeFileSync(privateKeyPath,privatePem,{flag:'wx',mode:0o600});
  if(publicKeyPath)fs.writeFileSync(publicKeyPath,publicPem,{flag:'wx',mode:0o600});
  return {privateKey:pair.privateKey,publicKey:pair.publicKey,privateKeyPath:path.resolve(privateKeyPath),publicPem};
}

const persistentKeysDir=path.join(os.homedir(),'.blackhole','update-signing');
const coreKeyFile=process.env.BH_TEST_CORE_SIGNING_KEY?.trim()
  ? path.resolve(process.env.BH_TEST_CORE_SIGNING_KEY.trim())
  : path.join(persistentKeysDir,'crossplatform-core.pem');
const corePubFile=path.join(persistentKeysDir,'crossplatform-core-public.pem');
const signingKeyId=process.env.BH_TEST_CORE_KEY_ID?.trim()||'test-persistent-host-node-v1';
if(!/^test[-_][A-Za-z0-9_-]{1,100}$/.test(signingKeyId))throw Error('invalid_test_core_key_id');
const coreSigner=ensurePersistentTestKeyPair(coreKeyFile,corePubFile);

const updateKeyFile=process.env.BH_TEST_UPDATE_SIGNING_KEY?.trim()
  ? path.resolve(process.env.BH_TEST_UPDATE_SIGNING_KEY.trim())
  : path.join(persistentKeysDir,'ed25519.pem');
const updatePubFile=path.join(persistentKeysDir,'public.pem');
const updateSigner=ensurePersistentTestKeyPair(updateKeyFile,updatePubFile);

const previousKeys=[
  ...allPreviousKeys.filter(x=>x.keyId===previous.signingKeyId&&x.keyId!==signingKeyId),
  ...allPreviousKeys.filter(x=>x.keyId!==previous.signingKeyId&&x.keyId!==signingKeyId),
].slice(0,7);
const version=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version;
const extensionVersion=JSON.parse(fs.readFileSync(path.join(root,'packages/vscode/package.json'),'utf8')).version;
const daemonVersion=/export const VERSION = '([^']+)'/.exec(fs.readFileSync(path.join(root,'src/version.ts'),'utf8'))?.[1];
if(!/^0[.]4[.]\d+$/.test(version)||extensionVersion!==version||daemonVersion!==version)
  throw Error('test_host_and_core_versions_must_match');
const releaseId=new Date().toISOString().slice(0,10).replaceAll('-','');
const suffix=randomBytes(3).toString('hex');
const versionTag=version.replaceAll('.','');
const buildId=`host-node-${versionTag}-local-${releaseId}-${suffix}`;
const publicPem=coreSigner.publicPem;
const notReady=path.join(output,'NOT-READY.txt');
fs.mkdirSync(output,{recursive:false});
fs.writeFileSync(notReady,'This candidate is incomplete. Do not install.\n',{flag:'wx'});
const layout=path.join(output,'layout');
const archive=path.join(output,`BlackHole-Core-${version}-win32-x64-test.zip`);
const publicFile=path.join(output,'public.pem');
const vsix=path.join(output,`blackhole-vscode-${version}-test.vsix`);
fs.writeFileSync(publicFile,publicPem,{flag:'wx',mode:0o600});
execSync('pnpm build',{cwd:root,stdio:'inherit',windowsHide:true});
execSync('pnpm --dir packages/web build',{cwd:root,stdio:'inherit',windowsHide:true});
execFileSync(process.execPath,[path.join(root,'packages/host-runtime/build.mjs'),'--environment','test'],
  {cwd:root,stdio:'inherit',windowsHide:true});
execFileSync(process.execPath,[path.join(root,'packages/vscode/esbuild.mjs'),'--environment','test'],
  {cwd:path.join(root,'packages','vscode'),stdio:'inherit',windowsHide:true});
execFileSync(process.execPath,[path.join(root,'scripts/assemble-core-runtime.mjs'),
  '--output',layout,'--without-node'],{cwd:root,stdio:'inherit',windowsHide:true});
const members=listFiles(layout);
assert.ok(members.length>5,'signed Core layout must be complete');
const unsigned={
  formatVersion:2,runtimeProvider:'host-node',nodeMinVersion:'22.13.0',
  runtimeId:'blackhole-core',runtimeVersion:version,buildId,
  platform:'win32',arch:'x64',environment:'test',cloudOrigin:profile.origin,
  coreProtocol:{min:1,max:1},capabilities:['web-ui'],
  daemonVersion:version,daemonEntry:'daemon/cli.js',
  webBuildId:buildId,webRoot:'web',managerEntry:'host/core-manager-cli.mjs',
  // Explicit Test release decision: the previous signed Core has 1..1 schema,
  // and this candidate preserves the same storage schema without migration.
  dataSchema:{min:1,max:1},migrationPolicy:'compatible',
  members:members.map(f=>({path:f.relative,size:f.size,sha256:sha256(fs.readFileSync(f.absolute))})),
  signingKeyId,signatureAlgorithm:'ed25519',createdAt:new Date().toISOString()
};
const descriptor=CoreDescriptorSchema.parse({...unsigned,signature:signDescriptor(unsigned,coreSigner.privateKey)});
await writeArchive(archive,layout,descriptor);
const verified=await verifyCoreArchive(archive,{
  environment:'test',publicKeys:{[signingKeyId]:coreSigner.publicKey},
  platform:'win32',arch:'x64'
});
if(!verified.descriptor.members.some(member=>member.path==='host/core-handoff.exe')
  ||verified.descriptorHash!==sha256(Buffer.from(JSON.stringify(descriptor,null,2)+'\n'))
  ||verified.descriptor.runtimeVersion!==version
  ||verified.descriptor.buildId!==buildId
  ||verified.descriptor.migrationPolicy!=='compatible')
  throw Error('core_archive_verification_failed');
const env={...process.env,
  BH_SEED_CORE_ARCHIVE:archive,
  BH_SEED_CORE_PUBLIC_KEY:publicFile,
  BH_SEED_CORE_KEY_ID:signingKeyId,
  BH_PRIOR_TEST_CORE_PUBLIC_KEYS_JSON:JSON.stringify(previousKeys),
};
for(const key of ['BH_PRIOR_TEST_CORE_PUBLIC_KEY','BH_PRIOR_TEST_CORE_KEY_ID'])delete env[key];
execFileSync(process.execPath,[path.join(root,'scripts/package-vsix.mjs'),
  '--environment','test','--core-package','offline-code','--out',vsix],
  {cwd:root,env,stdio:'inherit',windowsHide:true});
const audit=await auditUniversalVsix(vsix,profile);
if(audit.version!==version||audit.coreCodeBundled!==true
  ||audit.coreArchiveSha256!==verified.archiveHash
  ||audit.coreVersion!==version)
  throw Error('embedded_core_release_audit_failed');

// Package matched Desktop launcher + Inno Setup installer with the exact same
// signed Core archive, persistent test update key and prior test trust roots.
const desktopOut=path.join(output,'desktop');
const isccPath=path.join(root,'.tmp','toolchains','inno-6.7.3','compiler','ISCC.exe');
if(!fs.existsSync(isccPath))throw Error('pinned_inno_compiler_missing');
const nodeExe=process.execPath;
const nodeLicense=path.join(path.dirname(nodeExe),'LICENSE');
const nodeSha256=sha256(fs.readFileSync(nodeExe));
const nodeLicenseSha256=sha256(fs.readFileSync(nodeLicense));
const updatePublicFile=path.join(output,'update-public.pem');
fs.writeFileSync(updatePublicFile,updateSigner.publicPem,{flag:'wx',mode:0o600});
const updateFeedUrl=process.env.BH_TEST_UPDATE_FEED_URL?.trim()
  ||'https://github.com/qianshe/BlackHole-core/releases/download/desktop-test/latest.json';
const installerUrl=process.env.BH_TEST_INSTALLER_URL?.trim()
  ||`https://github.com/qianshe/BlackHole-core/releases/download/desktop-test/BlackHole-Desktop-${version}-test-unsigned-setup.exe`;
execFileSync(process.execPath,[
  path.join(root,'scripts/package-desktop.mjs'),
  '--seed',archive,
  '--public-key',publicFile,
  '--key-id',signingKeyId,
  '--manager',path.join(root,'packages/host-runtime/dist/core-manager-cli.mjs'),
  '--output',desktopOut,
  '--environment','test',
  '--iscc',isccPath,
  '--node-exe',nodeExe,
  '--node-sha256',nodeSha256,
  '--node-license',nodeLicense,
  '--node-license-sha256',nodeLicenseSha256,
  '--update-feed',updateFeedUrl,
  '--update-public-key',updatePublicFile,
],{cwd:root,env,stdio:'inherit',windowsHide:true});

const desktopAudit=JSON.parse(fs.readFileSync(path.join(desktopOut,'distribution-audit.json'),'utf8'));
if(desktopAudit.files['seed/core.zip']!==verified.archiveHash
  ||desktopAudit.seedDescriptorHash!==verified.descriptorHash
  ||desktopAudit.core.buildId!==buildId
  ||!desktopAudit.installer?.compiled)
  throw Error('desktop_core_parity_verification_failed');

const gitHead=spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',windowsHide:true});
const gitStatus=spawnSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8',windowsHide:true});
const sourceHead=gitHead.status===0&&/^[a-f0-9]{40}$/.test(gitHead.stdout.trim())?gitHead.stdout.trim():'0'.repeat(40);
const dirtyWorktree=gitStatus.status===0?gitStatus.stdout.trim()!=='':true;
const installerRel=`desktop/${desktopAudit.installer.file}`;
const manifestPath=path.join(output,'artifact-manifest.json');
const signaturesPath=path.join(output,'signatures.json');
const downloadMetadataPath=path.join(output,'download-metadata.json');
const preflightPath=path.join(output,'preflight-report.json');
const sbomPath=path.join(output,'sbom.cdx.json');

execFileSync(process.execPath,[
  path.join(root,'scripts/sign-desktop-update.mjs'),
  '--layout',desktopOut,
  '--installer-url',installerUrl,
  '--signing-key',updateSigner.privateKeyPath,
  '--output',path.join(output,'update-feed'),
],{cwd:root,stdio:'inherit',windowsHide:true});
const artifactManifest=buildArtifactManifest({
  artifactsDir:output,
  environment:'test',
  version,
  platform:'win32',
  arch:'x64',
  sourceHead,
  buildId,
  seedArchive:path.basename(archive),
  descriptorSha256:verified.descriptorHash,
  signingKeyId,
  vsixFile:path.basename(vsix),
  vsixCorePackage:'offline-code',
  desktopLauncher:'desktop/blackhole.exe',
  desktopInstaller:installerRel,
});
fs.writeFileSync(manifestPath,JSON.stringify(artifactManifest,null,2)+'\n',{flag:'wx'});
execFileSync(process.execPath,[
  path.join(root,'scripts/sign-artifacts.mjs'),
  'sign',
  '--manifest',manifestPath,
  '--artifacts-dir',output,
  '--private-key',coreSigner.privateKeyPath,
  '--key-id',signingKeyId,
  '--environment','test',
  '--output',signaturesPath,
],{cwd:root,stdio:'inherit',windowsHide:true});
execFileSync(process.execPath,[
  path.join(root,'scripts/sign-artifacts.mjs'),
  'verify',
  '--manifest',manifestPath,
  '--artifacts-dir',output,
  '--signatures',signaturesPath,
  '--public-key',publicFile,
],{cwd:root,stdio:'inherit',windowsHide:true});

const preflightReport=await runPreflight({manifestPath,environment:'test'});
fs.writeFileSync(preflightPath,JSON.stringify(preflightReport,null,2)+'\n',{flag:'wx'});
const downloadMetadata=buildReleaseMetadata({
  manifest:JSON.parse(fs.readFileSync(manifestPath,'utf8')),
  channel:'test',
  baseUrl:process.env.BH_TEST_DOWNLOAD_BASE_URL?.trim()||'https://github.com/qianshe/BlackHole-core/releases/download',
  signatures:JSON.parse(fs.readFileSync(signaturesPath,'utf8')),
  publicKeyPem:publicPem,
});
fs.writeFileSync(downloadMetadataPath,JSON.stringify(downloadMetadata,null,2)+'\n',{flag:'wx'});
execFileSync(process.execPath,[
  path.join(root,'scripts/generate-sbom.mjs'),
  '--output',sbomPath,
  '--artifacts',manifestPath,
],{cwd:root,stdio:'inherit',windowsHide:true});

const gatePolicy=JSON.parse(fs.readFileSync(path.join(root,'release','desktop-gates.json'),'utf8'));
const candidateGate=evaluateDesktopGates(gatePolicy,{
  mode:'candidate',
  sourceSha:sourceHead,
  approvedSha:process.env.BLACKHOLE_APPROVED_SOURCE_SHA??'',
  dirty:dirtyWorktree,
  artifactHashes:[desktopAudit.launcherSha256,desktopAudit.installer.sha256],
});
const releaseGate=evaluateDesktopGates(gatePolicy,{
  mode:'release',
  sourceSha:sourceHead,
  approvedSha:process.env.BLACKHOLE_APPROVED_SOURCE_SHA??'',
  dirty:dirtyWorktree,
  artifactHashes:[desktopAudit.launcherSha256,desktopAudit.installer.sha256],
});

const pkgHash=sha256(fs.readFileSync(vsix));
const report={
  status:'local-test-candidate',productionReady:false,
  sourceHead,dirtyWorktree,
  version,coreVersion:version,buildId,signingKeyId,
  persistentKeysDir,
  updateFeedUrl,
  installerUrl,
  previousCoreVersion:previous.runtimeVersion,
  previousTrustKeys:previousKeys.map(x=>x.keyId),
  descriptorHash:verified.descriptorHash,
  coreArchiveSha256:verified.archiveHash,vsixSha256:pkgHash,
  desktopLauncherSha256:desktopAudit.launcherSha256,
  desktopInstallerSha256:desktopAudit.installer.sha256,
  coreArchiveBytes:fs.statSync(archive).size,vsixBytes:fs.statSync(vsix).size,
  desktopLauncherBytes:desktopAudit.launcherBytes,
  desktopInstallerBytes:desktopAudit.installer.bytes,
  coreEmbedded:true,desktopCoreBytesIdentical:true,privateSigningKeyPersisted:false,
  signedMigrationPolicy:descriptor.migrationPolicy,buildCloudOrigin:profile.origin,
  vsixFile:path.basename(vsix),
  desktopLauncherFile:'desktop/blackhole.exe',
  desktopInstallerFile:installerRel,
  artifactManifest:'artifact-manifest.json',
  signaturesFile:'signatures.json',
  downloadMetadataFile:'download-metadata.json',
  preflightReportFile:'preflight-report.json',
  sbomFile:'sbom.cdx.json',
  gates:{candidate:candidateGate,release:releaseGate},
  audit,
  desktopAudit,
};
fs.writeFileSync(path.join(output,'candidate-audit.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
fs.writeFileSync(path.join(output,'READ-ME-FIRST.txt'),[
 `BlackHole ${version} local TEST candidate (Windows x64). NOT a production release.`,
 `Build ID: ${buildId} (Source HEAD: ${sourceHead}${dirtyWorktree?' [dirty]':''})`,
 `This candidate bundles identical signed Core ${version} bytes in both VSIX and Desktop`,
 `plus the public verification roots needed to validate the existing ${previous.runtimeVersion} Test Core.`,
 'Core ZIP: '+archive+' ('+verified.archiveHash+')',
 'VSIX path: '+vsix+' ('+pkgHash+')',
 'Desktop EXE: '+path.join(output,'desktop','blackhole.exe')+' ('+desktopAudit.launcherSha256+')',
 'Desktop Installer: '+path.join(output,installerRel)+' ('+desktopAudit.installer.sha256+')',
 `Do not overwrite an installed VSIX version ${version} while VS Code is running.`,
 'Never manually terminate the daemon or remove Core, lease or database files.',
 'Release gates remain enforced; see candidate-audit.json and release/desktop-gates.json.',
].join('\n')+'\n',{flag:'wx'});
fs.rmSync(notReady);
console.log(JSON.stringify({ok:true,output,version,buildId,
  coreArchiveSha256:verified.archiveHash,vsixSha256:pkgHash,
  desktopLauncherSha256:desktopAudit.launcherSha256,
  desktopInstallerSha256:desktopAudit.installer.sha256,
  preflightOk:preflightReport.ok,privateKeyPersisted:false},null,2));
