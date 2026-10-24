import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  CORE_INPUTS, BUNDLE_OUTPUTS, RECEIPT_PATH,
  captureCoreBuildInputs, recordCoreBundleBuild, verifyCoreBundleFreshness,
} from './core-runtime-freshness.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-core-freshness-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const write = (relative, body='fixture') => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), {recursive:true});
    fs.writeFileSync(file, body);
  };
  for (const input of CORE_INPUTS) write(input.includes('.') ? input : input+'/fixture.ts');
  for (const directory of BUNDLE_OUTPUTS) write(directory+'/fixture.js');
  for (const base of ['packages/web/dist','packages/vscode/dist/daemon/web']) {
    write(base+'/index.html','<script src="/ui/assets/new.js"></script>');
    write(base+'/assets/new.js','new in-app project picker');
  }
  const seal = () => recordCoreBundleBuild(root, captureCoreBuildInputs(root));
  return {root,write,seal};
}

test('fresh byte-identical daemon and Web bundle has verifiable source and artifact hashes', t => {
  const {root,seal}=fixture(t);
  seal();
  const result=verifyCoreBundleFreshness(root);
  for(const hash of Object.values(result)) assert.match(hash,/^[0-9a-f]{64}$/);
});

test('a fresh Web build with an old VS Code copied Web tree is rejected', t => {
  const {root,write,seal}=fixture(t);
  seal();
  write('packages/web/dist/assets/new.js','changed to in-app picker; old copy must not ship');
  assert.throws(()=>verifyCoreBundleFreshness(root),/stale_web_assets/);
});

test('new daemon source is not accepted with an old bundled cli even if dates are preserved', t => {
  const {root,write,seal}=fixture(t);
  seal();
  const file=path.join(root,'src/fixture.ts');
  const before=fs.statSync(file);
  write('src/fixture.ts','new Windows picker implementation');
  fs.utimesSync(file,before.atime,before.mtime);
  assert.throws(()=>verifyCoreBundleFreshness(root),/stale_core_bundle:inputs changed/);
});

test('missing receipt and mutated bundle fail closed, rather than assigning a new buildId', t => {
  const {root,write,seal}=fixture(t);
  assert.throws(()=>verifyCoreBundleFreshness(root),/missing build receipt/);
  seal();
  write('packages/vscode/dist/daemon/fixture.js','old or overwritten bundle');
  assert.throws(()=>verifyCoreBundleFreshness(root),/bundled outputs changed/);
  fs.rmSync(path.join(root,RECEIPT_PATH));
  assert.throws(()=>verifyCoreBundleFreshness(root),/missing build receipt/);
});

test('inputs changed during a bundle cannot be certified afterwards', t => {
  const {root,write}=fixture(t);
  const inputs=captureCoreBuildInputs(root);
  write('src/fixture.ts','edited while bundling');
  assert.throws(()=>recordCoreBundleBuild(root,inputs),/build_inputs_changed_during_bundle/);
  assert.equal(fs.existsSync(path.join(root,RECEIPT_PATH)),false);
});

test('assembler rejects stale Web before creating output, and accepts a fully current layout', t => {
  const {root,write,seal}=fixture(t);
  for(const file of ['assemble-core-runtime.mjs','core-runtime-freshness.mjs']) {
    write('scripts/'+file,fs.readFileSync(path.join(ROOT,'scripts',file),'utf8'));
  }
  for(const name of ['cli.js','process-supervisor.cjs']) write('packages/vscode/dist/daemon/'+name);
  for(const name of ['bootstrap.cjs','core-manager-cli.mjs','cloud-build.json']) write('packages/host-runtime/dist/'+name);
  write('input-node.exe'); write('input-LICENSE');
  const output=path.join(root,'candidate');
  const run=()=>spawnSync(process.execPath,[path.join(root,'scripts/assemble-core-runtime.mjs'),
    '--output',output,'--node-exe',path.join(root,'input-node.exe'),'--node-license',path.join(root,'input-LICENSE')],
    {cwd:root,encoding:'utf8',timeout:15000,windowsHide:true});
  seal();
  write('packages/vscode/dist/daemon/web/assets/new.js','old copied system picker');
  const rejected=run();
  assert.notEqual(rejected.status,0,'assembler must not produce a signed-looking stale candidate');
  assert.match(rejected.stderr,/stale_web_assets/);
  assert.equal(fs.existsSync(output),false,'stale input is rejected before output creation');
  write('packages/vscode/dist/daemon/web/assets/new.js','new in-app project picker');
  seal();
  const accepted=run();
  assert.equal(accepted.status,0,accepted.stderr);
  assert.equal(fs.readFileSync(path.join(output,'web/assets/new.js'),'utf8'),'new in-app project picker');
  const manifest=JSON.parse(fs.readFileSync(path.join(output,'layout-build.json'),'utf8'));
  assert.match(manifest.buildInputs.webHash,/^[0-9a-f]{64}$/);
});
