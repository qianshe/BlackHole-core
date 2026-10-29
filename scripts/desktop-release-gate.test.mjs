import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { evaluateDesktopGates } from './desktop-release-gate.mjs';
const actual=JSON.parse(fs.readFileSync(new URL('../release/desktop-gates.json',import.meta.url),'utf8'));
const sourceSha='a'.repeat(40);
const options={sourceSha,approvedSha:sourceSha,dirty:false};
function approved(){const copy=structuredClone(actual);for(const [key,value]of Object.entries(copy))if(value&&typeof value==='object'&&!Array.isArray(value)&&'state'in value)copy[key]={state:'passed',evidence:'review-fixture://'+key};return copy}
test('unresolved security and install issues keep publication closed',()=>{
 const pending=structuredClone(actual);pending.securityReview={state:'pending',evidence:null};pending.installerTransaction={state:'pending',evidence:null};
 const report=evaluateDesktopGates(pending,options);assert.equal(report.allowed,false);assert.ok(report.reasons.includes('securityReview'));assert.ok(report.reasons.includes('installerTransaction'));
});
test('approval must match exact committed source and never accept dirty worktree',()=>{
 const p=approved();assert.equal(evaluateDesktopGates(p,options).allowed,true);
 assert.ok(evaluateDesktopGates(p,{...options,dirty:true}).reasons.includes('uncommitted_source'));
 assert.ok(evaluateDesktopGates(p,{...options,approvedSha:'b'.repeat(40)}).reasons.includes('source_approval_required'));
});
test('candidate gate needs security evidence, not production signing credentials',()=>{
 const p=structuredClone(actual);p.securityReview={state:'passed',evidence:'review-fixture://security'};
 assert.equal(evaluateDesktopGates(p,{...options,mode:'candidate'}).allowed,true);
 assert.equal(evaluateDesktopGates(p,{...options,mode:'release'}).allowed,false);
 p.securityReview.evidence='';assert.equal(evaluateDesktopGates(p,{...options,mode:'candidate'}).allowed,false);
});
test('known blocked artifact hash cannot be authorized by toggling review flags',()=>{
 const p=approved();const report=evaluateDesktopGates(p,{...options,artifactHashes:[actual.blockedArtifactSha256[0]]});assert.equal(report.allowed,false);assert.ok(report.reasons.includes('blocked_artifact'));
});
test('missing and invalid policy states are not approvals',()=>{
 const p=approved();delete p.securityReview;assert.throws(()=>evaluateDesktopGates(p,options),/release_policy_invalid/);
});

test('community disclosure is explicit and never claims a vendor certificate',()=>{
 const p=approved();
 p.distributionProfile='community';
 p.platformSigning={state:'disclosed',evidence:'release/community-install.txt',windows:'unsigned',macos:'adhoc-unnotarized',linux:'core-and-update-ed25519'};
 assert.equal(evaluateDesktopGates(p,options).allowed,true);
 delete p.distributionProfile;
 assert.throws(()=>evaluateDesktopGates(p,options),/release_policy_invalid/);
});
test('prepublish retains installer requirements but defers Cloud readback until assets exist',()=>{
 const p=approved();p.cloudDownloadReadback={state:'pending',evidence:null};
 assert.equal(evaluateDesktopGates(p,{...options,mode:'prepublish'}).allowed,true);
 assert.equal(evaluateDesktopGates(p,{...options,mode:'release'}).allowed,false);
 p.installerTransaction={state:'pending',evidence:null};
 assert.equal(evaluateDesktopGates(p,{...options,mode:'prepublish'}).allowed,false);
});
