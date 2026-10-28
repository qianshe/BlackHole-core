// Review actual CI-produced bytes and native receipts. No publishing or mutation of policy.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {parseArgs} from 'node:util';
import {createHash} from 'node:crypto';
import {verifyCatalogFeedEntry} from './generate-cloud-desktop-catalog.mjs';
import {verifyCoreArchive} from './core-runtime-lib.mjs';
import {evaluateDesktopGates} from './desktop-release-gate.mjs';
const ROOT=fileURLToPath(new URL('..',import.meta.url));
export const targets=['windows-x64','macos-x64','macos-arm64','linux-x64','linux-arm64'];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function verifyNativeReceipt(audit,receipt,manifest,{sourceSha,target}) {
 const platform={windows:'win32',macos:'darwin',linux:'linux'}[manifest.platform];
 assert.equal(manifest.platform+'-'+manifest.arch,target);
 assert.equal(audit.sourceHead,sourceSha);assert.equal(audit.dirtyWorktree,false);
 assert.equal(audit.environment,'production');assert.equal(audit.platform,platform);assert.equal(audit.arch,manifest.arch);
 assert.equal(audit.version,manifest.version);assert.equal(audit.core.runtimeVersion,manifest.coreVersion);
 assert.equal(audit.core.buildId,manifest.coreBuildId);
 assert.equal(audit.installer.sha256,manifest.installerSha256);assert.equal(audit.installer.bytes,manifest.installerBytes);
 assert.equal(receipt.schemaVersion,1);assert.equal(receipt.sourceSha,sourceSha);
 assert.equal(receipt.platform,platform);assert.equal(receipt.arch,manifest.arch);assert.equal(receipt.version,manifest.version);
 assert.equal(receipt.installerSha256,manifest.installerSha256);
 for(const field of ['installed','reinstalled','bootstrapHealth','nodePinVerified','uninstalled','userDataRetained'])assert.equal(receipt[field],true,'native receipt missing '+field);
 // No interactive UI acceptance is inferred from a headless bootstrap.
 assert.equal(receipt.nativeUIAccepted,false);
 if(platform==='darwin'){
  assert.equal(audit.signing.macos.identity,'ad-hoc');assert.equal(audit.signing.macos.verified,true);
  assert.equal(audit.signing.macos.developerId,false);assert.equal(audit.signing.macos.notarized,false);
  assert.equal(audit.signing.macos.pinnedPayloadUnchanged,true);
 }
 return true;
}
export async function reviewBundle(directory,{sourceSha,approvedSha,mode='prepublish',dirty=false}={}) {
 assert.ok(['prepublish','release'].includes(mode));
 const pins=JSON.parse(fs.readFileSync(path.join(ROOT,'release/production-public-keys.json')));
 const version=JSON.parse(fs.readFileSync(path.join(ROOT,'package.json'))).version;
 const artifacts=[],entries=[];
 for(const target of targets){
  const at=path.join(directory,'desktop-release-'+target);
  const raw=fs.readFileSync(path.join(at,'update-feed',target,'latest.json'),'utf8');
  const signature=fs.readFileSync(path.join(at,'update-feed',target,'latest.json.sig'),'utf8');
  const {manifest}=verifyCatalogFeedEntry(raw,signature,pins.updatePublicKey);
  assert.equal(manifest.version,version);
  const audit=JSON.parse(fs.readFileSync(path.join(at,'desktop/distribution-audit.json')));
  const receipt=JSON.parse(fs.readFileSync(path.join(at,'desktop/installer-smoke.json')));
  verifyNativeReceipt(audit,receipt,manifest,{sourceSha,target});
  const name=new URL(manifest.installerUrl).pathname.split('/').at(-1);
  const installer=fs.readFileSync(path.join(at,'desktop/installer',name));
  assert.equal(installer.length,manifest.installerBytes);assert.equal(hash(installer),manifest.installerSha256);
  const coreFiles=fs.readdirSync(at).filter(name=>/^BlackHole-Core-.*\.zip$/.test(name));assert.equal(coreFiles.length,1);
  const core=await verifyCoreArchive(path.join(at,coreFiles[0]),{publicKeys:{[pins.coreKeyId]:pins.corePublicKey},platform:audit.platform,arch:audit.arch,environment:'production'});
  assert.equal(core.descriptor.cloudOrigin,'https://blackhole.stellarbridge.dpdns.org');
  assert.equal(core.descriptor.runtimeVersion,manifest.coreVersion);assert.equal(core.descriptor.buildId,manifest.coreBuildId);
  assert.equal(core.archiveHash,audit.signing.coreEd25519.archiveSha256);assert.equal(core.descriptorHash,audit.seedDescriptorHash);
  artifacts.push(core.archiveHash,manifest.installerSha256);
  entries.push({target,manifest,raw,signature:signature.trim()});
 }
 const policy=JSON.parse(fs.readFileSync(path.join(ROOT,'release/desktop-gates.json')));
 assert.equal(policy.distributionProfile,'community');assert.equal(policy.platformSigning.state,'disclosed');
 const evidence='Verified five native installer receipts and signed artifact bytes for '+sourceSha;
 for(const name of ['installerTransaction','uninstallChoices','nodeRuntimeLayout'])policy[name]={state:'passed',evidence};
 if(mode==='release'){
  for(const {target,manifest,raw,signature} of entries){
   const feed='https://blackhole.stellarbridge.dpdns.org/downloads/updates/stable/'+target+'/latest.json';
   const r=await fetch(feed,{signal:AbortSignal.timeout(30000)});assert.equal(r.status,200);assert.equal(await r.text(),raw);
   const s=await fetch(feed+'.sig',{signal:AbortSignal.timeout(30000)});assert.equal(s.status,200);assert.equal((await s.text()).trim(),signature);
   const download=await fetch(manifest.installerUrl,{signal:AbortSignal.timeout(180000)});assert.equal(download.status,200);
   const digest=createHash('sha256');let bytes=0;
   for await(const chunk of download.body){bytes+=chunk.length;assert.ok(bytes<=manifest.installerBytes);digest.update(chunk)}
   assert.equal(bytes,manifest.installerBytes);assert.equal(digest.digest('hex'),manifest.installerSha256);
   console.log(JSON.stringify({readback:target,verified:true}));
  }
  policy.cloudDownloadReadback={state:'passed',evidence:'Live Cloud feeds and GitHub installer bytes downloaded and verified at '+new Date().toISOString()};
 }
 const report=evaluateDesktopGates(policy,{mode,sourceSha,approvedSha,dirty,artifactHashes:artifacts});
 assert.equal(report.allowed,true,JSON.stringify(report));
 return {...report,version,targets,signing:policy.platformSigning,installerEvidence:evidence,nativeUIAccepted:false};
}
async function main() {
 const {values}=parseArgs({options:{artifacts:{type:'string'},mode:{type:'string',default:'prepublish'},output:{type:'string'}}});
 assert.ok(values.artifacts);
 const git=args=>{const r=spawnSync('git',args,{cwd:ROOT,encoding:'utf8'});assert.equal(r.status,0);return r.stdout.trim()};
 const report=await reviewBundle(path.resolve(values.artifacts),{sourceSha:git(['rev-parse','HEAD']),approvedSha:process.env.BLACKHOLE_APPROVED_SOURCE_SHA??'',mode:values.mode,dirty:git(['status','--porcelain'])!==''});
 if(values.output)fs.writeFileSync(values.output,JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e.message);process.exitCode=1});
