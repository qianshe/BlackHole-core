// Local Windows Test handoff. Does not install, restart, publish or touch the
// real Core. The one-off signing key exists only in process memory; the signed
// Core ZIP and VSIX carry public verification metadata only.
// Usage: node scripts/package-vscode-local-test.mjs FRESH_OUTPUT_DIR
//          EXISTING_TEST_TRUST_JSON INSTALLED_CORE_DESCRIPTOR_JSON
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execSync, execFileSync } from 'node:child_process';
import { generateKeyPairSync, createPublicKey, randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CoreDescriptorSchema } from '../packages/contracts/dist/index.js';
import { resolveBuildConfig } from '../packages/vscode/build-config.mjs';
import { listFiles, sha256, signDescriptor, writeArchive, verifyCoreArchive } from './core-runtime-lib.mjs';
import { auditUniversalVsix } from './audit-universal-vsix.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const [targetArg,trustArg,previousDescriptorArg]=process.argv.slice(2);
if(process.argv.length!==5||!targetArg||!trustArg||!previousDescriptorArg)
  throw Error('usage: node scripts/package-vscode-local-test.mjs FRESH_OUTPUT EXISTING_TEST_TRUST INSTALLED_CORE_DESCRIPTOR');
const output=path.resolve(targetArg),tempRoot=path.resolve(root,'.tmp');
if(!output.startsWith(tempRoot+path.sep)||fs.existsSync(output))
  throw Error('fresh_workspace_test_output_required');
const trustPath=path.resolve(trustArg),previousPath=path.resolve(previousDescriptorArg);
const trust=JSON.parse(fs.readFileSync(trustPath,'utf8'));
const previous=CoreDescriptorSchema.parse(JSON.parse(fs.readFileSync(previousPath,'utf8')));
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
const previousKeys=[
  ...allPreviousKeys.filter(x=>x.keyId===previous.signingKeyId),
  ...allPreviousKeys.filter(x=>x.keyId!==previous.signingKeyId),
].slice(0,7);
const version=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version;
const extensionVersion=JSON.parse(fs.readFileSync(path.join(root,'packages/vscode/package.json'),'utf8')).version;
if(!/^0[.]4[.]26$/.test(version)||extensionVersion!==version)throw Error('test_host_and_core_versions_must_match');
const releaseId=new Date().toISOString().slice(0,10).replaceAll('-','');
const suffix=randomBytes(3).toString('hex');
const versionTag=version.replaceAll('.','');
const signingKeyId=`test-review-host-node-${versionTag}-${releaseId}-${suffix}`;
const buildId=`host-node-${versionTag}-local-${releaseId}-${suffix}`;
const pair=generateKeyPairSync('ed25519');
const publicPem=pair.publicKey.export({type:'spki',format:'pem'}).toString();
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
const descriptor=CoreDescriptorSchema.parse({...unsigned,signature:signDescriptor(unsigned,pair.privateKey)});
await writeArchive(archive,layout,descriptor);
const verified=await verifyCoreArchive(archive,{
  environment:'test',publicKeys:{[signingKeyId]:pair.publicKey},
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
const pkgHash=sha256(fs.readFileSync(vsix));
const report={
  status:'local-test-candidate',productionReady:false,
  version,coreVersion:version,buildId,signingKeyId,
  previousCoreVersion:previous.runtimeVersion,
  previousTrustKeys:previousKeys.map(x=>x.keyId),
  descriptorHash:verified.descriptorHash,
  coreArchiveSha256:verified.archiveHash,vsixSha256:pkgHash,
  coreArchiveBytes:fs.statSync(archive).size,vsixBytes:fs.statSync(vsix).size,
  coreEmbedded:true,privateSigningKeyPersisted:false,
  signedMigrationPolicy:descriptor.migrationPolicy,buildCloudOrigin:profile.origin,
  vsixFile:path.basename(vsix),audit
};
fs.writeFileSync(path.join(output,'candidate-audit.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
fs.writeFileSync(path.join(output,'READ-ME-FIRST.txt'),[
 `BlackHole ${version} local TEST candidate (Windows x64). NOT a production release.`,
 `This VSIX embeds one signed Core ${version} archive and the public verification`,
 `roots needed to validate the existing ${previous.runtimeVersion} Test Core. No Core download.`,
 'Installer path: '+vsix,
 'SHA-256: '+pkgHash,
 `Do not overwrite an installed VSIX version ${version}. Install from VSIX in VS Code`,
 'and Reload Window. The new host automatically applies the embedded Core',
 'without another update confirmation. The signed bundled upgrade can',
 'replace a known legacy daemon after a definitive active_work refusal.',
 'The upgrade restarts Core; active remote tools or public channels may be',
 'interrupted. Do not install during an unfinished external operation.',
 'Never manually terminate the daemon or remove Core, lease or database files.',
 'Full local GUI, Desktop cross-host and public-channel tests are separate',
 'acceptance gates. The core code and source tree remain local Test only.',
].join('\n')+'\n',{flag:'wx'});
fs.rmSync(notReady);
console.log(JSON.stringify({ok:true,artifact:vsix,sha256:pkgHash,coreVersion:version,
  signedCoreEmbedded:true,privateKeyPersisted:false},null,2));
