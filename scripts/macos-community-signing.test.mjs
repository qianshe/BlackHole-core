import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { signCommunityMacBundle } from './macos-community-signing.mjs';
function fixture(t) {
 const root = fs.mkdtempSync(path.join(os.tmpdir(),'bh-mac-sign-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const app = path.join(root,'BlackHole.app');
 for(const file of ['bootstrap/node.exe','bootstrap/node-LICENSE','bootstrap/core-manager-cli.mjs','bootstrap/trust.json','seed/core.zip']) {
  const at=path.join(app,'Contents/MacOS',file); fs.mkdirSync(path.dirname(at),{recursive:true});fs.writeFileSync(at,'pinned');
 }
 return app;
}
test('ad-hoc signing verifies the bundle without recursively re-signing pinned payload',t=>{
 const app=fixture(t),calls=[];
 const report=signCommunityMacBundle(app,{run:(cmd,args)=>{calls.push([cmd,...args]);return {status:0}}});
 assert.deepEqual(calls,[['codesign','--force','--sign','-','--timestamp=none',app],['codesign','--verify','--deep','--strict',app]]);
 assert.deepEqual(report,{identity:'ad-hoc',developerId:false,notarized:false,verified:true,pinnedPayloadUnchanged:true});
});
test('failed signature verification stops packaging',t=>{
 let count=0;
 assert.throws(()=>signCommunityMacBundle(fixture(t),{run:()=>({status:++count===2?1:0,stderr:'invalid'})}),/macos_adhoc_signing_failed/);
});
test('rewriting embedded Node is rejected even when codesign reports success',t=>{
 const app=fixture(t);
 assert.throws(()=>signCommunityMacBundle(app,{run:()=>{fs.writeFileSync(path.join(app,'Contents/MacOS/bootstrap/node.exe'),'changed');return {status:0}}}),/macos_pinned_payload_changed/);
});
