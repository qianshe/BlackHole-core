import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import test from 'node:test';
import { createRequire } from 'node:module';
const { buildSync } = createRequire(new URL('../../vscode/package.json', import.meta.url))('esbuild');
import { fileURLToPath } from 'node:url';
import { CoreManager } from '../dist/core-manager.cjs';
import { CoreLifecycle } from '../dist/core-lifecycle.cjs';
import { UpgradeCoreResultSchema, LeaseHandleSchema } from '../../contracts/dist/index.js';
import { sha256, signDescriptor } from '../../../scripts/core-runtime-lib.mjs';

const nodeHash = sha256(fs.readFileSync(process.execPath));
const nodeSize = fs.statSync(process.execPath).size;
const controllerSource = buildSync({ entryPoints: [fileURLToPath(new URL('../../../src/lifecycle/managed-control.ts', import.meta.url))], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text;
const daemonTemplate = `
const fs=require('node:fs'),http=require('node:http'),path=require('node:path');
const identity=JSON.parse(process.env.BLACKHOLE_MANAGED_RUNTIME_IDENTITY);
const port=Number(process.env.BLACKHOLE_PORT), home=process.env.BLACKHOLE_HOME;
fs.mkdirSync(home,{recursive:true});
fs.appendFileSync(path.join(home,'fixture-spawns.jsonl'),JSON.stringify({pid:process.pid,port,version:identity.runtimeVersion})+'\\n');
const health={ok:true,version:identity.runtimeVersion,daemon_id:'fixture-'+process.pid,settings_revision:0,started_settings_revision:0,
 start_fingerprint:process.env.BLACKHOLE_START_FINGERPRINT,db_path:process.env.BLACKHOLE_DB,
 runtime_id:identity.runtimeId,runtime_version:identity.runtimeVersion,build_id:identity.buildId,
 descriptor_hash:identity.descriptorHash,data_root_id:identity.dataRootId,web_build_id:identity.webBuildId,
 core_protocol:identity.coreProtocol,core_environment:identity.environment,core_cloud_origin:identity.cloudOrigin,
 cloud_origin:identity.cloudOrigin,lifecycle_state:'managed',lifecycle_settings_version:1};
const {MaintenanceGate,ManagedControl}=require('./managed-control.cjs');
const gate=new MaintenanceGate();
const control=new ManagedControl({publicKeyPem:process.env.BLACKHOLE_MANAGER_PUBLIC_KEY,identity,daemonId:health.daemon_id,startFingerprint:health.start_fingerprint,gate,settingsRevision:()=>health.settings_revision,assertIdle(){}});
health.lifecycle_control_version=1;health.lifecycle_manager_key_hash=control.publicKeyHash;
const FAIL='__FAIL__';
if(FAIL==='exit')process.exit(17);
else if(FAIL==='hang')setTimeout(()=>{},60000);
else http.createServer((req,res)=>{
 if(req.url==='/api/health'){res.setHeader('content-type','application/json');res.end(JSON.stringify(health));}
 else if(req.url==='/ui/'){res.statusCode=200;res.end('<!doctype html>fixture');}
 else if(req.url==='/api/web/bootstrap'){res.setHeader('content-type','application/json');res.end(JSON.stringify({path:'/ui/',ticket:'a'.repeat(43)}));}
 else if(req.url==='/fixture-write'&&req.method==='POST'){let body='';req.on('data',b=>body+=b);req.on('end',()=>{fs.writeFileSync(path.join(home,'fixture-marker.txt'),body);res.end('ok');});}
 else if(req.url==='/fixture-read'){try{res.end(fs.readFileSync(path.join(home,'fixture-marker.txt'),'utf8'));}catch{res.statusCode=404;res.end();}}
 else if(req.url==='/api/core/stop'){
  let body='';req.on('data',b=>body+=b);req.on('end',()=>{
   try{const result=control.acceptStop(JSON.parse(body).token);res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,...result}));setTimeout(()=>process.exit(0),30);}
   catch(e){res.statusCode=409;res.end(JSON.stringify({error:e.message}));}
  });
 }
 else{res.statusCode=404;res.end();}
}).listen(port,'127.0.0.1');
`;
const client = (kind = 'desktop', instance = randomUUID()) => ({ clientId: kind, clientInstanceId: instance, kind, version: '1.0.0', protocol: { min: 1, max: 1 }, capabilities: ['web-ui'] });
const handle = (lease) => LeaseHandleSchema.parse(Object.fromEntries(['leaseId', 'clientInstanceId', 'daemonId', 'dataRootId', 'descriptorHash'].map((key) => [key, lease[key]])));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  assert.notEqual(port, 7306); return port;
}
async function fixture(t) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bh-upgrade-')));
  const home = path.join(temp, 'home'), store = path.join(temp, 'Core'), data = path.join(home, '.blackhole');
  fs.mkdirSync(data, { recursive: true });
  const port = await freePort();
  const env = { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: path.join(home, 'AppData', 'Local'), BLACKHOLE_HOME: data, BLACKHOLE_DB: path.join(data, 'blackhole.db'), BLACKHOLE_PORT: String(port), BLACKHOLE_TUNNEL: 'off' };
  const pair = generateKeyPairSync('ed25519');
  const trust = { environment: 'test', publicKeys: { 'test-upgrade': pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() } };
  const manager = new CoreManager(store);
  const lifecycle = new CoreLifecycle(manager, trust, env);
  const spawnsFile = path.join(data, 'fixture-spawns.jsonl');
  const spawns = () => fs.existsSync(spawnsFile) ? fs.readFileSync(spawnsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  t.after(async () => {
    for (const record of spawns()) { try { process.kill(record.pid); } catch {} }
    for (let i = 0; i < 50; i++) { if (spawns().every(({ pid }) => { try { process.kill(pid, 0); return false; } catch { return true; } })) break; await pause(50); }
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  });
  async function addCore({ runtimeVersion, buildId, fail = '', dataSchema = { min: 1, max: 1 }, migrationPolicy = 'none', signingKeyId = 'test-upgrade', signer = pair, oldStopRefuses = false, signedHandoff = false }) {
    let descriptor;
    const installed = await manager.provision('fixture.zip', 'seed', async (_archive, destination) => {
      const nodeEntry = process.platform === 'win32' ? 'node/node.exe' : 'node/node';
      const daemonSource = daemonTemplate.replace('__FAIL__', fail).replace('assertIdle(){}', oldStopRefuses ? "assertIdle(){throw Error('active_work')}" : 'assertIdle(){}');
      const files = { [nodeEntry]: null, 'daemon/cli.cjs': daemonSource, 'daemon/managed-control.cjs': controllerSource, 'host/manager.mjs': '// signed fixture manager\n', 'web/index.html': '<!doctype html>fixture' };
      if (signedHandoff) {
        const binary = path.join(temp, 'signed-test-handoff.exe');
        execFileSync('go', ['-C', fileURLToPath(new URL('../../desktop-launcher/', import.meta.url)), 'build', '-o', binary, './cmd/core-handoff'], { timeout: 60_000, windowsHide: true });
        files['host/core-handoff.exe'] = fs.readFileSync(binary);
      }
      const members = [];
      for (const [name, content] of Object.entries(files)) {
        const file = path.join(destination, name); fs.mkdirSync(path.dirname(file), { recursive: true });
        if (content === null) fs.copyFileSync(process.execPath, file); else fs.writeFileSync(file, content);
        members.push({ path: name, sha256: content === null ? nodeHash : sha256(Buffer.from(content)), size: content === null ? nodeSize : Buffer.byteLength(content) });
      }
      const unsigned = { formatVersion: 1, runtimeId: 'blackhole-core', runtimeVersion, buildId, platform: process.platform, arch: process.arch, environment: 'test', cloudOrigin: 'https://fixture.invalid', coreProtocol: { min: 1, max: 1 }, capabilities: ['web-ui'], nodeVersion: process.version, nodeEntry, daemonVersion: runtimeVersion, daemonEntry: 'daemon/cli.cjs', webBuildId: 'web-' + buildId, webRoot: 'web', managerEntry: 'host/manager.mjs', dataSchema, migrationPolicy, members, signingKeyId, signatureAlgorithm: 'ed25519', createdAt: new Date().toISOString() };
      descriptor = { ...unsigned, signature: signDescriptor(unsigned, signer.privateKey) };
      const bytes = Buffer.from(JSON.stringify(descriptor, null, 2) + '\n');
      fs.writeFileSync(path.join(destination, 'core-descriptor.json'), bytes);
      return { descriptor, descriptorHash: sha256(bytes) };
    });
    return { ...installed, versionName: `${runtimeVersion}-${buildId}` };
  }
  const request = { client: client(), port, readyTimeoutMs: 5_000 };
  return { temp, home, store, data, env, trust, manager, lifecycle, port, request, addCore, spawns };
}
const markerWrite = async (port, value) => { const response = await fetch(`http://127.0.0.1:${port}/fixture-write`, { method: 'POST', body: value }); assert.equal(response.status, 200); };
const markerRead = async (port) => { const response = await fetch(`http://127.0.0.1:${port}/fixture-read`); assert.equal(response.status, 200); return response.text(); };
const upgradeRequest = (f, attachment, targetVersionName, readyTimeoutMs) => ({ handle: handle(attachment.lease), client: f.request.client, port: f.port, confirmed: true, requestId: randomUUID(), targetVersionName, ...(readyTimeoutMs ? { readyTimeoutMs } : {}) });

const bundledStart = (f, target, client = f.request.client) => ({ client, port:f.port,
  versionName:target.versionName, descriptorHash:target.descriptorHash, requestId:randomUUID(), readyTimeoutMs:5000 });
test('installed signed bundle replaces a legacy Core that refuses idle-only Stop',async t=>{
 if (process.platform!=='win32') return t.skip('Windows native owned-listener helper');
 const f=await fixture(t);
 const old=await f.addCore({runtimeVersion:'1.0.0',buildId:'legacy-busy',oldStopRefuses:true});
 const next=await f.addCore({runtimeVersion:'1.1.0',buildId:'signed-handoff',signedHandoff:true});
 await f.manager.activate(old.versionName);
 const initial=await f.lifecycle.attachOrStart(f.request);
 await markerWrite(f.port,'durable-data');
 // A manual maintenance caller has no permission to terminate this Core.
 await assert.rejects(f.lifecycle.upgradeCore(upgradeRequest(f,initial,next.versionName)),/active_work/);
 assert.equal((await f.lifecycle.inspectStart()).receipt.daemonId,initial.receipt.daemonId);
 const outcome=await f.lifecycle.startBundledCore(bundledStart(f,next));
 assert.equal(outcome.state,'updated');
 assert.equal(outcome.attachment.receipt.runtimeVersion,'1.1.0');
 assert.notEqual(outcome.attachment.receipt.daemonId,initial.receipt.daemonId);
 assert.equal(await markerRead(f.port),'durable-data');
 assert.equal(f.spawns().length,2,'only one replacement daemon starts');
 assert.equal(f.manager.select().versionName,next.versionName);
});

test('a target without a signed native helper may not override the old daemon refusal',async t=>{
 if(process.platform!=='win32')return t.skip('Windows native owned-listener helper');
 const f=await fixture(t);
 const old=await f.addCore({runtimeVersion:'1.0.0',buildId:'legacy-guard',oldStopRefuses:true});
 const next=await f.addCore({runtimeVersion:'1.1.0',buildId:'helper-absent'});
 await f.manager.activate(old.versionName);
 const prior=await f.lifecycle.attachOrStart(f.request);
 await assert.rejects(f.lifecycle.startBundledCore(bundledStart(f,next)),/core_handoff_not_signed/);
 assert.equal((await f.lifecycle.inspectStart()).receipt.daemonId,prior.receipt.daemonId);
 assert.equal(f.manager.select().versionName,old.versionName);
 assert.equal(f.spawns().length,1);
});

test('legacy refused Stop then failed candidate rolls back using the original database and runtime',async t=>{
 if(process.platform!=='win32')return t.skip('Windows native owned-listener helper');
 const f=await fixture(t);
 const old=await f.addCore({runtimeVersion:'1.0.0',buildId:'legacy-rollback',oldStopRefuses:true});
 const next=await f.addCore({runtimeVersion:'1.1.0',buildId:'candidate-exit',signedHandoff:true,fail:'exit'});
 await f.manager.activate(old.versionName);
 const initial=await f.lifecycle.attachOrStart(f.request);
 await markerWrite(f.port,'durable-before-rollback');
 const result=await f.lifecycle.startBundledCore(bundledStart(f,next));
 assert.equal(result.state,'rolled_back');
 assert.equal(result.attachment.receipt.runtimeVersion,'1.0.0');
 assert.notEqual(result.attachment.receipt.daemonId,initial.receipt.daemonId);
 assert.equal(f.manager.select().versionName,old.versionName);
 assert.equal(await markerRead(f.port),'durable-before-rollback');
});

test('bundled startup selects and starts the new Core before returning a normal client attachment',async t=>{
 const f=await fixture(t);
 const old=await f.addCore({runtimeVersion:'1.0.0',buildId:'startup-old'});
 const next=await f.addCore({runtimeVersion:'1.1.0',buildId:'startup-new'});
 await f.manager.activate(old.versionName);
 const result=await f.lifecycle.startBundledCore(bundledStart(f,next));
 assert.equal(result.attachment.receipt.runtimeVersion,'1.1.0');
 assert.equal(f.manager.select().identity.descriptorHash,next.descriptorHash);
 assert.deepEqual(f.spawns().map(x=>x.version),['1.1.0'],'cold update must not start old Core then ask a second update');
});
test('install activation applies bundled Core to a live idle instance without a manual upgrade command',async t=>{
 const f=await fixture(t);
 const old=await f.addCore({runtimeVersion:'1.0.0',buildId:'live-old'});
 const next=await f.addCore({runtimeVersion:'1.1.0',buildId:'live-new'});
 await f.manager.activate(old.versionName);
 const first=await f.lifecycle.attachOrStart(f.request);
 await markerWrite(f.port,'original-data');
 const result=await f.lifecycle.startBundledCore(bundledStart(f,next));
 assert.equal(result.state,'updated');
 assert.equal(result.attachment.receipt.runtimeVersion,'1.1.0');
 assert.notEqual(result.attachment.receipt.daemonId,first.receipt.daemonId);
 assert.equal(await markerRead(f.port),'original-data');
});
test('bundled startup reports a legacy peer as deferred, preserves its Core, and never claims the target is running',async t=>{
 const f=await fixture(t);
 const old=await f.addCore({runtimeVersion:'1.0.0',buildId:'peer-old'});
 const next=await f.addCore({runtimeVersion:'1.1.0',buildId:'peer-new'});
 await f.manager.activate(old.versionName);
 const peer=await f.lifecycle.attachOrStart({...f.request,client:client('vscode')});
 const result=await f.lifecycle.startBundledCore(bundledStart(f,next));
 assert.equal(result.state,'deferred');assert.equal(result.reason,'active_clients');
 assert.equal(result.attachment.receipt.daemonId,peer.receipt.daemonId);
 assert.equal(result.attachment.receipt.runtimeVersion,'1.0.0');
 assert.equal(f.spawns().length,1);
});
test('bundled startup rejects an unpinned descriptor and reuses a newer compatible Core without downgrade',async t=>{
 const f=await fixture(t);
 const old=await f.addCore({runtimeVersion:'1.0.0',buildId:'old-package'});
 const next=await f.addCore({runtimeVersion:'1.1.0',buildId:'new-installed'});
 await f.manager.activate(next.versionName);
 await assert.rejects(f.lifecycle.startBundledCore({...bundledStart(f,old),descriptorHash:'f'.repeat(64)}),/core_identity_conflict/);
 const result=await f.lifecycle.startBundledCore(bundledStart(f,old));
 assert.equal(result.state,'current');
 assert.equal(result.attachment.receipt.runtimeVersion,'1.1.0');assert.equal(f.spawns().length,1);
});

test('two reconnect-capable hosts automatically share an upgrade and the peer rebinds only through its committed journal',async t=>{
 const f=await fixture(t),old=await f.addCore({runtimeVersion:'1.0.0',buildId:'cooperative-old'});
 await f.manager.activate(old.versionName);
 const peerClient=client('vscode');
 const peer=await f.lifecycle.attachOrStart({...f.request,client:peerClient,reconnectAfterUpgrade:true});
 const next=await f.addCore({runtimeVersion:'1.1.0',buildId:'cooperative-new'});
 const updated=await f.lifecycle.startBundledCore({...bundledStart(f,next),reconnectAfterUpgrade:true});
 assert.equal(updated.state,'updated');
 assert.notEqual(updated.attachment.receipt.daemonId,peer.receipt.daemonId);
 const rebased=await f.lifecycle.reconnectCore({handle:handle(peer.lease),client:peerClient,port:f.port});
 assert.equal(rebased.spawned,false);
 assert.equal(rebased.receipt.daemonId,updated.attachment.receipt.daemonId);
 assert.equal(rebased.receipt.runtimeVersion,'1.1.0');
 const repeated=await f.lifecycle.reconnectCore({handle:handle(peer.lease),client:peerClient,port:f.port});
 assert.equal(repeated.lease.leaseId,rebased.lease.leaseId,'lost reply retries must not allocate extra leases');
 assert.equal(f.spawns().length,2);
 await assert.rejects(f.lifecycle.reconnectCore({handle:{...handle(peer.lease),daemonId:'foreign'},client:peerClient,port:f.port}),/lease_target_mismatch/);
});
test('a peer supporting reconnection but not trusting the new signing key cannot be silently disconnected',async t=>{
 const f=await fixture(t),old=await f.addCore({runtimeVersion:'1.0.0',buildId:'trust-old'});
 await f.manager.activate(old.versionName);
 const peerLifecycle=new CoreLifecycle(f.manager,{environment:'test',publicKeys:{...f.trust.publicKeys}},f.env);
 const peer=await peerLifecycle.attachOrStart({...f.request,client:client('vscode'),reconnectAfterUpgrade:true});
 const signer=generateKeyPairSync('ed25519');
 f.trust.publicKeys['test-next']=signer.publicKey.export({format:'pem',type:'spki'}).toString();
 const next=await f.addCore({runtimeVersion:'1.1.0',buildId:'trust-new',signingKeyId:'test-next',signer});
 const result=await f.lifecycle.startBundledCore({...bundledStart(f,next),reconnectAfterUpgrade:true});
 assert.equal(result.state,'deferred');assert.equal(result.reason,'peer_core_update_required');
 assert.equal(result.attachment.receipt.daemonId,peer.receipt.daemonId);
 await assert.rejects(f.lifecycle.upgradeCore({confirmed:true,requestId:randomUUID(),client:f.request.client,
   handle:handle(result.attachment.lease),port:f.port,targetVersionName:next.versionName}),/peer_core_update_required/);
 assert.equal((await f.lifecycle.inspectStart()).receipt.daemonId,peer.receipt.daemonId);
 assert.equal(f.spawns().length,1);
});
test('simultaneous new host activations converge without a spurious recovery error or duplicate upgrade',async t=>{
 const f=await fixture(t),old=await f.addCore({runtimeVersion:'1.0.0',buildId:'parallel-old'});
 await f.manager.activate(old.versionName);
 const initial=await f.lifecycle.attachOrStart({...f.request,reconnectAfterUpgrade:true});
 await f.lifecycle.detach(handle(initial.lease));
 const next=await f.addCore({runtimeVersion:'1.1.0',buildId:'parallel-new'});
 const a={...bundledStart(f,next),client:client('vscode'),reconnectAfterUpgrade:true};
 const b={...bundledStart(f,next),client:client('desktop'),reconnectAfterUpgrade:true};
 const results=await Promise.all([f.lifecycle.startBundledCore(a),f.lifecycle.startBundledCore(b)]);
 for(const r of results){assert.equal(r.attachment.receipt.runtimeVersion,'1.1.0');assert.notEqual(r.state,'deferred')}
 assert.equal(results[0].attachment.receipt.daemonId,results[1].attachment.receipt.daemonId);
 assert.equal(f.spawns().length,2,'only old Core and its one replacement may spawn');
});

test('reconnect support alone cannot authorize a new daemon without a committed upgrade transition',async t=>{
 const f=await fixture(t),old=await f.addCore({runtimeVersion:'1.0.0',buildId:'unproven'});
 await f.manager.activate(old.versionName);
 const a=await f.lifecycle.attachOrStart({...f.request,reconnectAfterUpgrade:true});
 await assert.rejects(f.lifecycle.reconnectCore({handle:handle(a.lease),client:f.request.client,port:f.port}),/core_reconnect_unproven/);
 assert.equal(f.spawns().length,1);
});

test('cold bundled-core activation compares active pointer and rejects downgrade without touching the original', async t => {
  const f = await fixture(t);
  const old = await f.addCore({ runtimeVersion: '1.0.0', buildId: 'cold-a' });
  const newer = await f.addCore({ runtimeVersion: '1.1.0', buildId: 'cold-b' });
  await f.manager.activate(old.versionName);
  const before = f.manager.select();
  assert.equal(before.versionName, old.versionName);
  await assert.rejects(
    f.lifecycle.activateColdCore({versionName: newer.versionName, port: f.port, expectedVersionName: 'changed', expectedDescriptorHash: old.descriptorHash}),
    /core_selection_changed/
  );
  assert.equal(f.manager.select().versionName, old.versionName);
  await assert.rejects(
    f.lifecycle.activateColdCore({versionName: old.versionName, port: f.port, expectedVersionName: old.versionName, expectedDescriptorHash: newer.descriptorHash}),
    /core_selection_changed/
  );
  const done = await f.lifecycle.activateColdCore({
    versionName: newer.versionName, port: f.port, expectedVersionName: old.versionName, expectedDescriptorHash: old.descriptorHash,
  });
  assert.equal(done.versionName, newer.versionName);
  assert.equal(f.manager.select().identity.descriptorHash, newer.descriptorHash);
  assert.equal(f.manager.select('known-good.json').versionName, old.versionName);
  assert.equal(f.spawns().length, 0, 'cold activation must not spawn a daemon');
  await assert.rejects(
    f.lifecycle.activateColdCore({versionName: old.versionName, port: f.port, expectedVersionName: newer.versionName, expectedDescriptorHash: newer.descriptorHash}),
    /core_update_not_newer/
  );
  assert.equal(f.manager.select().versionName, newer.versionName);
});

test('cold updater refuses incompatible data schemas and explicit migrations without moving the active Core', async t => {
  const f = await fixture(t);
  const previous = await f.addCore({ runtimeVersion: '1.0.0', buildId: 'cold-old' });
  await f.manager.activate(previous.versionName);
  const expected = { expectedVersionName: previous.versionName, expectedDescriptorHash: previous.descriptorHash, port: f.port };
  const incompatible = await f.addCore({ runtimeVersion: '1.1.0', buildId: 'cold-schema', dataSchema: { min: 10, max: 11 } });
  await assert.rejects(f.lifecycle.activateColdCore({ ...expected, versionName: incompatible.versionName }), /data_schema_incompatible/);
  assert.equal(f.manager.select().versionName, previous.versionName);
  const migration = await f.addCore({ runtimeVersion: '1.1.0', buildId: 'cold-migration', migrationPolicy: 'explicit' });
  await assert.rejects(f.lifecycle.activateColdCore({ ...expected, versionName: migration.versionName }), /data_migration_explicit_required/);
  assert.equal(f.manager.select().versionName, previous.versionName);
  assert.equal(f.spawns().length, 0);
});


test('running upgrade cannot overwrite an already-changed Core active pointer', async t => {
  const f = await fixture(t);
  const old = await f.addCore({ runtimeVersion: '1.0.0', buildId: 'pointer-old' });
  await f.manager.activate(old.versionName);
  const attached = await f.lifecycle.attachOrStart(f.request);
  const proposed = await f.addCore({ runtimeVersion: '1.1.0', buildId: 'pointer-proposed' });
  const independentlySelected = await f.addCore({ runtimeVersion: '1.2.0', buildId: 'pointer-newer' });
  // An intentionally inconsistent *disposable fixture* models a stale
  // launcher observing a changed selected pointer. No real Core is touched.
  await f.manager.activate(independentlySelected.versionName);
  await assert.rejects(f.lifecycle.upgradeCore(upgradeRequest(f, attached, proposed.versionName)), /core_selection_changed/);
  assert.equal(f.manager.select().versionName, independentlySelected.versionName);
  assert.equal(f.spawns().length, 1, 'current Core must not be stopped/restarted on refusal');
  assert.deepEqual(await f.lifecycle.inspectUpgrades(), []);
});
test('upgrade commits only after the candidate is ready and preserves the data root', async (t) => {
  const f = await fixture(t);
  const a = await f.addCore({ runtimeVersion: '1.0.0', buildId: 'a' });
  await f.manager.activate(a.versionName);
  const first = await f.lifecycle.attachOrStart(f.request);
  await markerWrite(f.port, 'notes-from-a');
  const b = await f.addCore({ runtimeVersion: '1.1.0', buildId: 'b' });
  // Staging/provisioning never disturbs the running Core or the pointer.
  assert.equal(f.manager.select().versionName, a.versionName);
  assert.equal(await markerRead(f.port), 'notes-from-a');
  const result = UpgradeCoreResultSchema.parse(await f.lifecycle.upgradeCore(upgradeRequest(f, first, b.versionName)));
  assert.equal(result.state, 'committed');
  assert.equal(result.fromVersionName, a.versionName);
  assert.equal(result.attachment.receipt.runtimeVersion, '1.1.0');
  assert.notEqual(result.attachment.receipt.daemonId, first.receipt.daemonId);
  assert.equal(result.attachment.receipt.dataRootId, first.receipt.dataRootId);
  assert.equal(f.manager.select().versionName, b.versionName);
  assert.equal(f.manager.select('known-good.json').versionName, b.versionName);
  assert.equal(await markerRead(f.port), 'notes-from-a');
  await assert.rejects(f.lifecycle.heartbeat({ handle: handle(first.lease), port: f.port }), /lease_missing/);
  assert.deepEqual(await f.lifecycle.inspectUpgrades(), []);
  const journal = JSON.parse(fs.readFileSync(path.join(f.store, 'state', 'upgrade', result.requestId + '.json'), 'utf8'));
  assert.equal(journal.state, 'committed');
});

test('a positively failed candidate rolls back to the previous verified Core', async (t) => {
  const f = await fixture(t);
  const a = await f.addCore({ runtimeVersion: '1.0.0', buildId: 'a' });
  await f.manager.activate(a.versionName);
  const first = await f.lifecycle.attachOrStart(f.request);
  await markerWrite(f.port, 'keep-me');
  const bad = await f.addCore({ runtimeVersion: '1.1.0', buildId: 'bad', fail: 'exit' });
  const result = UpgradeCoreResultSchema.parse(await f.lifecycle.upgradeCore(upgradeRequest(f, first, bad.versionName)));
  assert.equal(result.state, 'rolled_back');
  assert.equal(result.attachment.receipt.runtimeVersion, '1.0.0');
  assert.notEqual(result.attachment.receipt.daemonId, first.receipt.daemonId);
  assert.equal(f.manager.select().versionName, a.versionName);
  assert.equal(await markerRead(f.port), 'keep-me');
  assert.ok(fs.readdirSync(path.join(f.store, 'state', 'recovered-starts')).length >= 1);
  const journal = JSON.parse(fs.readFileSync(path.join(f.store, 'state', 'upgrade', result.requestId + '.json'), 'utf8'));
  assert.equal(journal.state, 'rolled_back');
});

test('incompatible or non-newer candidates and busy Cores are refused before anything stops', async (t) => {
  const f = await fixture(t);
  const a = await f.addCore({ runtimeVersion: '1.0.0', buildId: 'a' });
  await f.manager.activate(a.versionName);
  const first = await f.lifecycle.attachOrStart(f.request);
  const same = await f.addCore({ runtimeVersion: '1.0.0', buildId: 'a2' });
  await assert.rejects(f.lifecycle.upgradeCore(upgradeRequest(f, first, same.versionName)), /core_update_not_newer/);
  const schema = await f.addCore({ runtimeVersion: '1.1.0', buildId: 'schema', dataSchema: { min: 5, max: 5 } });
  await assert.rejects(f.lifecycle.upgradeCore(upgradeRequest(f, first, schema.versionName)), /data_schema_incompatible/);
  const explicit = await f.addCore({ runtimeVersion: '1.1.0', buildId: 'explicit', migrationPolicy: 'explicit' });
  await assert.rejects(f.lifecycle.upgradeCore(upgradeRequest(f, first, explicit.versionName)), /data_migration_explicit_required/);
  const other = await f.lifecycle.attachOrStart({ ...f.request, client: client('vscode') });
  const good = await f.addCore({ runtimeVersion: '1.1.0', buildId: 'good' });
  await assert.rejects(f.lifecycle.upgradeCore(upgradeRequest(f, first, good.versionName)), /active_clients/);
  // Nothing stopped or switched: the original daemon still serves and owns data.
  const health = await (await fetch(`http://127.0.0.1:${f.port}/api/health`)).json();
  assert.equal(health.daemon_id, first.receipt.daemonId);
  assert.equal(f.manager.select().versionName, a.versionName);
  const upgradeDir = path.join(f.store, 'state', 'upgrade');
  const refused = fs.existsSync(upgradeDir) ? fs.readdirSync(upgradeDir).map((name) => JSON.parse(fs.readFileSync(path.join(upgradeDir, name), 'utf8'))) : [];
  assert.ok(refused.every((record) => record.state !== 'committed'));
  await f.lifecycle.detach(handle(other.lease));
});

test('an unresponsive candidate stays recovery_required and pins both versions', async (t) => {
  const f = await fixture(t);
  const a = await f.addCore({ runtimeVersion: '1.0.0', buildId: 'a' });
  await f.manager.activate(a.versionName);
  const first = await f.lifecycle.attachOrStart(f.request);
  const hang = await f.addCore({ runtimeVersion: '1.1.0', buildId: 'hang', fail: 'hang' });
  await assert.rejects(f.lifecycle.upgradeCore(upgradeRequest(f, first, hang.versionName, 1_000)), /upgrade_rollback_failed/);
  const pending = await f.lifecycle.inspectUpgrades();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].state, 'recovery_required');
  await assert.rejects(f.lifecycle.attachOrStart({ ...f.request, client: client('vscode') }), /upgrade_recovery_required/);
  const retained = f.manager.retentionSet();
  assert.ok(retained.has(a.versionName) && retained.has(hang.versionName));
});
