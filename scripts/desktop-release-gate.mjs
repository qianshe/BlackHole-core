// Release policy gate, NOT a malware scanner or signature verifier. Review
// evidence is explicit; local test success cannot automatically approve it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const root=fileURLToPath(new URL('..',import.meta.url));
const gates=['securityReview','installerTransaction','uninstallChoices','nodeRuntimeLayout','platformSigning','cloudDownloadReadback'];
export function evaluateDesktopGates(policy,{mode='release',sourceSha='',approvedSha='',dirty=true,artifactHashes=[]}={}){
 if(!['candidate','prepublish','release'].includes(mode) || !policy || policy.schemaVersion!==1 || !Array.isArray(policy.blockedArtifactSha256))throw Error('release_policy_invalid');
 const communityDisclosure = name => name==='platformSigning' && policy.distributionProfile==='community' && policy[name]?.state==='disclosed' && policy[name]?.windows==='unsigned' && policy[name]?.macos==='adhoc-unnotarized' && policy[name]?.linux==='core-and-update-ed25519';
 for(const name of gates)if(!policy[name] || (!['pending','passed'].includes(policy[name].state) && !communityDisclosure(name)))throw Error('release_policy_invalid');
 const reasons=[];
 const required=mode==='candidate'?['securityReview']:mode==='prepublish'?gates.filter(name=>name!=='cloudDownloadReadback'):gates;
 for(const name of required){
  const g=policy[name];if((g.state!=='passed' && !communityDisclosure(name)) || typeof g.evidence!=='string' || !g.evidence.trim())reasons.push(name);
 }
 if(dirty)reasons.push('uncommitted_source');
 if(!/^[a-f0-9]{40}$/.test(sourceSha) || sourceSha!==approvedSha)reasons.push('source_approval_required');
 if(artifactHashes.some(h=>policy.blockedArtifactSha256.includes(h)))reasons.push('blocked_artifact');
 return {schemaVersion:1,mode,allowed:reasons.length===0,reasons,sourceSha};
}
export function main(argv=process.argv.slice(2)){
 if(argv.length<2 || argv.length>10 || argv.length%2!==0 || argv[0]!=='--mode' || !['candidate','prepublish','release'].includes(argv[1]))throw Error('usage: --mode candidate|prepublish|release [--artifact FILE]');
 const artifactHashes=[];
 for(let i=2;i<argv.length;i+=2){
  if(argv[i]!=='--artifact')throw Error('artifact_argument_invalid');
  const file=path.resolve(argv[i+1]);const info=fs.lstatSync(file);
  if(!info.isFile()||info.isSymbolicLink()||info.size>1024**3)throw Error('artifact_invalid');
  const handle=fs.openSync(file,'r'),hash=createHash('sha256'),buffer=Buffer.alloc(1024*1024);
  try{let n;while((n=fs.readSync(handle,buffer,0,buffer.length,null))>0)hash.update(buffer.subarray(0,n));}finally{fs.closeSync(handle)}
  artifactHashes.push(hash.digest('hex'));
 }
 const file=path.join(root,'release/desktop-gates.json');if(fs.statSync(file).size>65536)throw Error('release_policy_invalid');
 const policy=JSON.parse(fs.readFileSync(file,'utf8'));
 const head=spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',timeout:10000});
 const status=spawnSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8',timeout:10000});
 if(head.status!==0 || status.status!==0)throw Error('source_state_unavailable');
 const result=evaluateDesktopGates(policy,{mode:argv[1],sourceSha:head.stdout.trim(),approvedSha:process.env.BLACKHOLE_APPROVED_SOURCE_SHA??'',dirty:status.stdout.trim()!=='',artifactHashes});
 console.log(JSON.stringify(result));return result.allowed?0:1;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{process.exitCode=main()}catch{console.error(JSON.stringify({allowed:false,error:'release_gate_failed'}));process.exitCode=1}
}
