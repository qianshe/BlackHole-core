// Parse workflow YAML and verify delivery-specific safety assertions. This is
// local static validation, not a claim that a remote workflow has executed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parseDocument } from 'yaml';
const read=name=>fs.readFileSync(new URL('../'+name,import.meta.url),'utf8');
function workflow(name){const document=parseDocument(read('.github/workflows/'+name));assert.deepEqual(document.errors,[]);return document.toJS()}
test('native CI includes new source boundaries, policies and syntax-only installer compilation',()=>{
 const w=workflow('launcher-native.yml');assert.equal(w.permissions.contents,'read');
 assert.ok(w.on.pull_request.paths.includes('installers/**'));
 assert.ok(w.on.pull_request.paths.includes('src/data-paths.ts'));
 assert.ok(w.on.pull_request.paths.includes('.github/workflows/desktop-release.yml'));
 assert.ok(w.jobs.test.steps.some(s=>String(s.run).includes('desktop-node-info.test.mjs')));
 const steps=w.jobs.test.steps.map(step=>step.run??'').join('\n');
 for(const file of ['desktop-release-gate.test.mjs','installer-preflight.test.mjs','desktop-update-client.test.mjs','check-installer-syntax.mjs'])assert.ok(steps.includes(file));
 assert.ok(w.jobs.build.steps.some(step=>step.run==='node scripts/desktop-release-gate.mjs --mode candidate'));
});
test('candidate workflow has a security gate before runtime artifacts and uses matched installer builds',()=>{
 const w=workflow('shared-core-prepare.yml');assert.equal(w.permissions.contents,'read');assert.ok(w.on.workflow_dispatch);assert.equal(w.on.pull_request,undefined);
 const steps=w.jobs.prepare.steps,gate=steps.findIndex(s=>s.run==='node scripts/desktop-release-gate.mjs --mode candidate');
 const pack=steps.findIndex(s=>String(s.run).includes('scripts/package-desktop.mjs'));
 assert.ok(gate>=0 && gate<pack);assert.match(steps[pack].run,/--iscc/);
 const all=steps.map(s=>s.run??'').join('\n');assert.match(all,/New-Item -ItemType Directory -Path .tmp\/ci-artifacts/);
 assert.match(all,/go-winres@v0.3.3/);assert.match(all,/desktop-update-auto-verify\.mjs/);
 assert.match(all,/release-metadata\.mjs --write-manifest/);
 assert.match(all,/shared-core-acceptance-preflight\.mjs --manifest \.tmp\/ci-artifacts\/artifact-manifest\.json --environment test/);
 assert.match(all,/sign-artifacts\.mjs sign/);assert.match(all,/sign-artifacts\.mjs verify/);
 assert.match(all,/candidate-review-status\.json/);
 assert.doesNotMatch(all,/gh release create|wrangler deploy|npm publish|Set-MpPreference|Add-MpPreference/i);
 const uploads=steps.filter(s=>s.uses?.startsWith('actions/upload-artifact@'));
 assert.equal(uploads.length,2);
 const paths=uploads[0]?.with?.path??'';
 assert.doesNotMatch(paths,/private\.pem|ci-keys|\.exe/);
 assert.match(paths,/distribution-audit\.json/);assert.match(paths,/candidate-review-status\.json/);
 assert.equal(uploads[1]?.if,'inputs.archive_candidate_binaries');
 assert.doesNotMatch(uploads[1]?.with?.path??'',/private\.pem|ci-keys/);
 assert.match(uploads[1]?.with?.path??'',/BlackHole-Desktop-\*-test-unsigned-setup\.exe/);
});
test('native pre-copy helper stays separate from Manager mutation commands',()=>{
 const source=read('packages/host-runtime/src/installer-preflight.ts');
 assert.doesNotMatch(source,/new CoreManager|\.withLock\(|\.maintainCore\(|\.upgradeCore\(|writeFileSync|rmSync|DatabaseSync|spawn\(/);
 assert.match(source,/core\/state\/upgrade/);assert.match(source,/install\.lock/);
 const bridge=read('packages/desktop-launcher/cmd/blackhole/update_checks.go');
 assert.doesNotMatch(bridge,/handoffUpdate\(|feed\.Stage\(/);
});

test('matched release preparation separates Node from Core and audits both lightweight VSIX modes',()=>{
 const w=workflow('shared-core-prepare.yml');
 const all=w.jobs.prepare.steps.map(s=>s.run??'').join('\n');
 for(const flag of ['--without-node','--runtime-provider host-node','--node-min-version','--core-package thin','--core-package offline-code','--node-sha256','--node-license-sha256'])assert.ok(all.includes(flag),flag);
 assert.ok(all.includes('host-vsix-manager-smoke.mjs'));
 assert.ok(all.includes('prepare-ci-test-profile.mjs'));
 const core=workflow('vscode-extension.yml').jobs['vsix-artifact'];
 assert.ok(core.steps.some(s=>String(s.run).includes('host-node-packaging.test.mjs')));
 assert.ok(!core.steps.some(s=>String(s.run).includes('package-vsix.mjs --environment production --out')),'never silently package old private daemon to pass the CI artifact step');
});

test('multi-platform Desktop release workflow enforces release gate, builds all five targets and generates Cloud catalog',()=>{
 const w=workflow('desktop-release.yml');
 assert.equal(w.permissions.contents,'read');
 assert.ok(w.on.workflow_dispatch);
 assert.equal(w.on.pull_request,undefined);
 assert.equal(w.jobs.package.needs,'gate');
 assert.equal(w.jobs.publish.needs,'package');
 const gateSteps=w.jobs.gate.steps.map(s=>s.run??'').join('\n');
 assert.doesNotMatch(gateSteps,/--mode (release|prepublish)/);
 assert.match(w.jobs.publish.steps.find(s=>String(s.run).includes('gh release upload')).run,/review-desktop-community-release\.mjs .*--mode prepublish/);
 assert.match(gateSteps,/desktop-release-gate\.mjs --mode candidate/);
 const targets=w.jobs.package.strategy.matrix.include.map(m=>m.target).sort();
 assert.deepEqual(targets,['linux-arm64','linux-x64','macos-arm64','macos-x64','windows-x64']);
 const pkgUpload=w.jobs.package.steps.find(s=>s.uses?.startsWith('actions/upload-artifact@'))?.with?.path??'';
 assert.doesNotMatch(pkgUpload,/private\.pem|key_dir/);
 const pubSteps=w.jobs.publish.steps;
 const catalogStep=pubSteps.find(s=>String(s.run).includes('generate-cloud-desktop-catalog.mjs'));
 assert.ok(catalogStep);
 const ghStep=pubSteps.find(s=>String(s.run).includes('gh release upload'));
 assert.equal(ghStep?.if,'inputs.publish_github_release');
});

function runBash(script, extraEnv = {}) {
 return spawnSync('bash', ['-c', script], {
  encoding: 'utf8', timeout: 15000,
  env: {...process.env, ...extraEnv},
 });
}
test('release signing selects a secret name before resolving its value and rejects missing keys',()=>{
 const steps=workflow('desktop-release.yml').jobs.package.steps;
 const signing=steps.find(s=>s.env?.CORE_PRIVATE_KEY_SECRET);
 assert.equal(signing.env.CORE_PRIVATE_KEY_SECRET,"${{ secrets[inputs.environment == 'production' && 'BH_PROD_CORE_SIGNING_KEY' || 'BH_CROSSPLATFORM_TEST_KEY'] }}");
 assert.equal(signing.env.UPDATE_PRIVATE_KEY_SECRET,"${{ secrets[inputs.environment == 'production' && 'BH_PROD_UPDATE_SIGNING_KEY' || 'BH_TEST_UPDATE_SIGNING_KEY'] }}");
 const prefix=signing.run.slice(0,signing.run.indexOf('mkdir -p .tmp/ci-desktop'));
 assert.ok(prefix.includes('CORE_PRIVATE_KEY_SECRET:?'));
 assert.ok(prefix.includes('UPDATE_PRIVATE_KEY_SECRET:?'));
 for(const [core,update,environment,allowed] of [
  ['', 'fixture', 'production', false],
  ['fixture', '', 'production', false],
  ['', '', 'test', false],
  ['fixture', 'fixture', 'invalid', false],
  ['fixture', 'fixture', 'production', true],
  ['fixture', 'fixture', 'test', true],
 ]) {
  const result=runBash(prefix+"\nprintf '%s' validated",{
   RELEASE_ENV:environment,CORE_PRIVATE_KEY_SECRET:core,UPDATE_PRIVATE_KEY_SECRET:update,
   BH_CROSSPLATFORM_TEST_KEY:'available-test-key',BH_TEST_UPDATE_SIGNING_KEY:'available-test-key',
  });
  assert.equal(result.status===0,allowed,result.error?.message??result.stderr);
  assert.equal(result.stdout.includes('validated'),allowed);
 }
 assert.match(signing.run,/desktop-node-info\.mjs --output/);
 assert.doesNotMatch(signing.run,/JSON\.parse\(process\.argv\[1\]\)|copyFileSync\('LICENSE'/);
});
test('pre-build checks use candidate policy; post-build publication has its separate prepublish gate',()=>{
 const run=workflow('desktop-release.yml').jobs.gate.steps.find(s=>s.env?.BLACKHOLE_APPROVED_SOURCE_SHA).run;
 for(const [environment,publish,expected] of [
  ['production','false','candidate'],['production','true','candidate'],
  ['test','false','candidate'],['test','true','candidate'],
 ]) {
  const script=run.replaceAll('${{ inputs.environment }}',environment)
   .replaceAll('${{ inputs.publish_github_release }}',publish)
   .replaceAll('node scripts/desktop-release-gate.mjs --mode release',"printf '%s' release")
   .replaceAll('node scripts/desktop-release-gate.mjs --mode candidate',"printf '%s' candidate");
  const result=runBash(script);
  assert.equal(result.status,0,result.error?.message??result.stderr);
  assert.equal(result.stdout,expected);
 }
});
test('production publication never overwrites a version and only exposes a fully uploaded draft',()=>{
 const step=workflow('desktop-release.yml').jobs.publish.steps.find(s=>String(s.run).includes('gh release upload'));
 const script=step.run.replaceAll('${{ inputs.environment }}','production')
  .replace(/version=\$\(node -p [^\n]+/, 'version=9.9.9')
  .replace(/BLACKHOLE_APPROVED_SOURCE_SHA=[^\n]+node scripts\/review-desktop-community-release\.mjs[^\n]+/g, 'printf gate-approved')
  .replace(/node scripts\/verify-desktop-release-discovery\.mjs[^\n]+/, 'printf discovery-verified')
  .replace(/[^\n]*sha256sum[^\n]*/, 'true'); // filesystem bundle assembly is outside the gh publication transaction
 const mock=`gh() {
  printf 'gh:%s\\n' "$*"
  if [ "$1 $2" = "release create" ] && [ "$SIMULATE_CREATE_FAILURE" = 1 ]; then return 1; fi
  if [ "$1 $2" = "release upload" ] && [ "$SIMULATE_UPLOAD_FAILURE" = 1 ]; then return 1; fi
 }`;
 for(const [createFail,uploadFail] of [['1','0'],['0','1'],['0','0']]) {
  const result=runBash(mock+'\n'+script,{
   GITHUB_SHA:'a'.repeat(40),SIMULATE_CREATE_FAILURE:createFail,SIMULATE_UPLOAD_FAILURE:uploadFail,
  });
  assert.match(result.stdout,/release create v9\.9\.9 --target a{40} --draft/);
  assert.doesNotMatch(result.stdout,/--clobber/);
  assert.equal(result.stdout.includes('release upload'),createFail==='0');
  const success=createFail==='0'&&uploadFail==='0';
  assert.equal(result.stdout.includes('release edit v9.9.9 --draft=false'),success);
  assert.equal(result.stdout.includes('discovery-verified'),success);
  if(success){assert.ok(result.stdout.indexOf('discovery-verified')>result.stdout.indexOf('release edit'));assert.match(result.stdout,/desktop-release\.json/);}
  assert.equal(result.status===0,success,result.error?.message??result.stderr);
 }
});

test('original Bash JSON variable expansion preserves Windows paths on this host',()=>{
 const exe=String.raw`C:\Program Files\nodejs\node.exe`;
 const result=runBash(`node_info=$(node -p 'process.env.NODE_INFO_FIXTURE')
node -p 'JSON.parse(process.argv[1]).exe' "$node_info"`,{
  NODE_INFO_FIXTURE:JSON.stringify({exe}),
 });
 assert.equal(result.status,0,result.error?.message??result.stderr);
 assert.equal(result.stdout.trim(),exe);
});
