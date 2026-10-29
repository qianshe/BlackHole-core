// LOCAL STRUCTURAL REVIEW ONLY. Generates an in-memory test signing key, a v2
// code archive and both VSIX modes. Never launches a daemon/native Desktop,
// installs, uploads, publishes, or writes a private signing key to disk.
import fs from 'node:fs';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CoreDescriptorSchema } from '../packages/contracts/dist/index.js';
import { resolveBuildConfig } from '../packages/vscode/build-config.mjs';
import { listFiles, sha256, signDescriptor, writeArchive, verifyCoreArchive } from './core-runtime-lib.mjs';
import { auditUniversalVsix } from './audit-universal-vsix.mjs';

const repo=fileURLToPath(new URL('../',import.meta.url));
const [layoutArg,outputArg,priorPublicArg,prior041PublicArg,prior042PublicArg]=process.argv.slice(2);
if(!layoutArg||!outputArg||![4,5,6,7].includes(process.argv.length))throw Error('usage: node scripts/package-host-node-review.mjs NODE_FREE_LAYOUT FRESH_OUTPUT [V040_TEST_PUBLIC_KEY] [V041_TEST_PUBLIC_KEY] [V042_TEST_PUBLIC_KEY]');
const layout=path.resolve(layoutArg),output=path.resolve(outputArg);
if(fs.existsSync(output))throw Error('fresh_output_required');
const files=listFiles(layout);
if(files.some(f=>/(?:^|\/)node(?:[.]exe)?$/i.test(f.relative)||f.relative.toLowerCase().startsWith('node/')))throw Error('node_bundle_rejected');
const version=JSON.parse(fs.readFileSync(path.join(repo,'package.json'),'utf8')).version;
const build=resolveBuildConfig('test');
const versionTag=version.replaceAll('.','');
const keyId='test-review-host-node-'+versionTag;
const buildId='host-node-'+versionTag+'-review-20261018';
const pair=generateKeyPairSync('ed25519');
const unsigned={formatVersion:2,runtimeProvider:'host-node',nodeMinVersion:'22.13.0',runtimeId:'blackhole-core',runtimeVersion:version,buildId,
 platform:'win32',arch:'x64',environment:'test',cloudOrigin:build.origin,coreProtocol:{min:1,max:1},capabilities:['web-ui'],daemonVersion:version,daemonEntry:'daemon/cli.js',webBuildId:buildId,webRoot:'web',managerEntry:'host/core-manager-cli.mjs',dataSchema:{min:1,max:1},migrationPolicy:'compatible',
 members:files.map(f=>({path:f.relative,size:f.size,sha256:sha256(fs.readFileSync(f.absolute))})),signingKeyId:keyId,signatureAlgorithm:'ed25519',createdAt:'2026-10-17T00:00:00.000Z'};
const descriptor=CoreDescriptorSchema.parse({...unsigned,signature:signDescriptor(unsigned,pair.privateKey)});
fs.mkdirSync(output,{recursive:false});
fs.writeFileSync(path.join(output,'DO-NOT-INSTALL.txt'),'LOCAL TEST SIGNATURE / STRUCTURAL REVIEW ONLY. No production security or actual VS Code UI acceptance. The thin package URL is a test reference and is NOT published. Do not install into the working profile, distribute or upload these files. No private key is persisted.\n',{flag:'wx'});
const archive=path.join(output,'core-code-v2.zip'),pub=path.join(output,'public.pem');
fs.writeFileSync(pub,pair.publicKey.export({type:'spki',format:'pem'}),{flag:'wx'});
await writeArchive(archive,layout,descriptor);
const verified=await verifyCoreArchive(archive,{environment:'test',publicKeys:{[keyId]:pair.publicKey},platform:'win32',arch:'x64'});
const priorRoots=[];
if(priorPublicArg)priorRoots.push({keyId:'test-review-host-node',publicKey:fs.readFileSync(path.resolve(priorPublicArg),'utf8')});
if(prior041PublicArg)priorRoots.push({keyId:'test-review-host-node-041',publicKey:fs.readFileSync(path.resolve(prior041PublicArg),'utf8')});
if(prior042PublicArg)priorRoots.push({keyId:'test-review-host-node-042',publicKey:fs.readFileSync(path.resolve(prior042PublicArg),'utf8')});
const env={...process.env,BH_SEED_CORE_ARCHIVE:archive,BH_SEED_CORE_PUBLIC_KEY:pub,BH_SEED_CORE_KEY_ID:keyId,
 BH_PRIOR_TEST_CORE_PUBLIC_KEYS_JSON:JSON.stringify(priorRoots)};
delete env.BH_PRIOR_TEST_CORE_PUBLIC_KEY;delete env.BH_PRIOR_TEST_CORE_KEY_ID;
const reports=[];
for(const mode of ['thin','offline-code']){
 const vsix=path.join(output,`blackhole-vscode-${version}-${mode}-review.vsix`);
 const args=[path.join(repo,'scripts/package-vsix.mjs'),'--environment','test','--core-package',mode,'--out',vsix];
 if(mode==='thin')args.push('--core-url',`https://github.com/qianshe/BlackHole-core/releases/download/v${version}/BlackHole-Core-${version}-win32-x64-test.zip`);
 execFileSync(process.execPath,args,{cwd:repo,env,stdio:'inherit',windowsHide:true});
 reports.push(await auditUniversalVsix(vsix,build));
}
const result={kind:'local-host-node-review',installable:false,privateKeyPersisted:false,version,
 core:{bytes:fs.statSync(archive).size,sha256:verified.archiveHash,descriptorHash:verified.descriptorHash,nodeBundled:false},packages:reports};
fs.writeFileSync(path.join(output,'review-audit.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(result,null,2));
