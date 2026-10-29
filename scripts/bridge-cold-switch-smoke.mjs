import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { resolveDataPaths } from '../dist/data-paths.js';
import { spawn, spawnSync } from 'node:child_process';

const [archive, publicKey, managerEntry] = process.argv.slice(2).map((value) => path.resolve(value));
for (const file of [archive, publicKey, managerEntry]) if (!file || !fs.existsSync(file)) throw new Error(`fixture_missing:${file}`);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'blackhole-bridge-smoke-'));
const home = path.join(temp, 'home'), store = path.join(home, '.blackhole', 'core'), trust = path.join(temp, 'trust.json');
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(trust, JSON.stringify({ environment: 'test', publicKeys: { 'test-local': fs.readFileSync(publicKey, 'utf8') } }));
let manager;
const port = await new Promise((resolve, reject) => { const s=net.createServer(); s.once('error',reject); s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close((e)=>e?reject(e):resolve(p));}); });
if (port === 7306) throw new Error('isolated_port_required');
const dataRoot = path.join(home, '.blackhole'), db = path.join(dataRoot, 'blackhole.db');
const baseEnv = { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: path.join(home,'AppData','Local'), BLACKHOLE_HOME: dataRoot, BLACKHOLE_DB: db, BLACKHOLE_PORT: String(port), BLACKHOLE_TUNNEL: 'off' };
manager = (request) => {
  const result = spawnSync(process.execPath, [managerEntry], { input: JSON.stringify(request), encoding: 'utf8', env: { ...baseEnv, BH_CORE_STORE: store, BH_CORE_TRUST_CONFIG: trust }, maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`manager_failed:${result.stdout}:${result.stderr}`);
  const parsed = JSON.parse(result.stdout); if (!parsed.ok) throw new Error(`manager_failed:${result.stdout}`); return parsed.result;
};
const provisioned = manager({ command: 'provision', archive, source: 'seed' });
const versionName = `${provisioned.descriptor.runtimeVersion}-${provisioned.descriptor.buildId}`;
const selectedRoot = path.join(store, 'versions', versionName);
const node = path.join(selectedRoot, 'node', 'node.exe'), daemon = path.join(selectedRoot, 'daemon', 'cli.js');
const waitHealth = async () => { for(let i=0;i<150;i++){try{const r=await fetch(`http://127.0.0.1:${port}/api/health`,{signal:AbortSignal.timeout(400)});if(r.ok)return r.json();}catch{}await new Promise(r=>setTimeout(r,100));} throw new Error('health_timeout'); };
const stop = async (health) => { try { await fetch(`http://127.0.0.1:${port}/api/shutdown`, { method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({daemon_id:health.daemon_id,start_fingerprint:health.start_fingerprint??null}),signal:AbortSignal.timeout(2000)}); } catch {} };
const launch = (env) => spawn(node,[daemon,'serve','--port',String(port)],{cwd:selectedRoot,env,stdio:['ignore','pipe','pipe'],windowsHide:true});
let legacy, managed;
try {
  legacy = launch(baseEnv); const legacyHealth = await waitHealth();
  if (legacyHealth.runtime_id) throw new Error('legacy_unexpectedly_managed');
  await stop(legacyHealth); await new Promise((resolve)=>{const t=setTimeout(resolve,5000);legacy.once('exit',()=>{clearTimeout(t);resolve();});});
  if (legacy.exitCode === null) throw new Error('legacy_stop_unconfirmed');
  manager({ command:'activate', versionName }); const active = manager({ command:'select' });
  const dataRootId = resolveDataPaths({ env: baseEnv }).dataRootId;
  // The managed daemon only accepts the Manager's signed stop grant, so the
  // cold switch is driven through the Manager itself: attach (which spawns
  // the managed Core on the same port/data root), verify identity, then a
  // confirmed maintain-core stop with the returned lease handle.
  const client = { clientId: 'vscode', clientInstanceId: crypto.randomUUID(), kind: 'vscode', version: '0.3.201', protocol: { min: 1, max: 1 }, capabilities: ['web-ui'] };
  const attached = manager({ command: 'attach-or-start', request: { client, port } });
  const health = await waitHealth();
  for (const [field,expected] of [['runtime_id',active.identity.runtimeId],['runtime_version',active.identity.runtimeVersion],['build_id',active.identity.buildId],['descriptor_hash',active.identity.descriptorHash],['data_root_id',dataRootId]]) if (health[field] !== expected) throw new Error(`managed_identity_mismatch:${field}`);
  if (attached.receipt.daemonId !== health.daemon_id) throw new Error('managed_receipt_mismatch');
  const lease = attached.lease;
  const handle = { leaseId: lease.leaseId, clientInstanceId: lease.clientInstanceId, daemonId: lease.daemonId, dataRootId: lease.dataRootId, descriptorHash: lease.descriptorHash };
  const stopped = manager({ command: 'maintain-core', request: { handle, client, port, confirmed: true, requestId: crypto.randomUUID(), operation: 'stop' } });
  if (!stopped.stopped) throw new Error('managed_stop_unconfirmed');
  console.log(JSON.stringify({ok:true,port,legacyStopped:true,managedStarted:true,managedStoppedViaManager:true,samePort:true,versionName,descriptorHash:active.identity.descriptorHash}));
} finally {
  if (legacy?.exitCode === null) legacy.kill(); if (managed?.exitCode === null) managed.kill(); fs.rmSync(temp,{recursive:true,force:true});
}
