// Public CI profile only; do not invent a signing key or alias Test to production.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBuildConfig } from '../packages/vscode/build-config.mjs';
import { assertServiceBuild } from './environment-config.mjs';
const origin=process.env.BLACKHOLE_TEST_CLOUD_ORIGIN;
const key=process.env.BLACKHOLE_TEST_CLOUD_PUBLIC_KEY;
if(!origin||!key)throw Error('ci_test_public_profile_required');
const build=assertServiceBuild(resolveBuildConfig('test',origin,key));
const file=fileURLToPath(new URL('../config/environments/test.json',import.meta.url));
const profile={schema:1,environment:'test',clientTarget:'test',origin:build.origin,entitlementPublicKey:build.entitlementPublicKey};
if(fs.existsSync(file)){
 const current=JSON.parse(fs.readFileSync(file,'utf8'));
 if(Object.keys(current).sort().join(',')!==Object.keys(profile).sort().join(',')||Object.entries(profile).some(([k,v])=>current[k]!==v))throw Error('ci_profile_conflict_do_not_overwrite');
}else{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(profile,null,2)+'\n',{flag:'wx'});}
console.log('Validated public Test client profile; no private signing material.');
