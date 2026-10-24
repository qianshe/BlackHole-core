// Parse workflow YAML and verify delivery-specific safety assertions. This is
// local static validation, not a claim that a remote workflow has executed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseDocument } from 'yaml';
const read=name=>fs.readFileSync(new URL('../'+name,import.meta.url),'utf8');
function workflow(name){const document=parseDocument(read('.github/workflows/'+name));assert.deepEqual(document.errors,[]);return document.toJS()}
test('native CI includes new source boundaries, policies and syntax-only installer compilation',()=>{
 const w=workflow('launcher-native.yml');assert.equal(w.permissions.contents,'read');
 assert.ok(w.on.pull_request.paths.includes('installers/**'));
 assert.ok(w.on.pull_request.paths.includes('src/data-paths.ts'));
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
 assert.doesNotMatch(all,/gh release create|wrangler deploy|npm publish|Set-MpPreference|Add-MpPreference/i);
 const paths=steps.find(s=>s.uses?.startsWith('actions/upload-artifact@'))?.with?.path??'';
 assert.doesNotMatch(paths,/private\.pem|ci-keys|\.exe/);
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
