// Plan 6.11 A3–A5/B1: daemon-owned account, migration, self-proved entitlement, Web stop.
// No real cloud, no real OS credential store, never port 7306 or the real ~/.blackhole.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { AccountService, AccountError } from '../dist/account/service.js';
import { memorySecretPort } from '../dist/account/secret-store.js';
import { EntitlementGate } from '../dist/cloud/entitlement-gate.js';
import { createIsolatedEnv } from './fixtures/isolated-env.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://cloud.blackhole-fixture.org';
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const SPKI = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const now = () => Math.floor(Date.now() / 1000);
const cred = (over = {}) => ({ token: 'bhp_' + 'a'.repeat(43), userId: 'user_1', clientId: 'vscode-client-id-000', sessionId: '11111111-2222-4333-8444-555555555555', expiresAt: now() + 3600, loginOrder: 5, ...over });

function fakeCloud(log) {
  return async (input, init = {}) => {
    const url = new URL(String(input));
    const body = init.body ? JSON.parse(init.body) : {};
    log.push(url.pathname);
    const json = (status, value) => new Response(value === undefined ? null : JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/api/auth/plugin/logout') return json(204);
    if (url.pathname === '/api/auth/plugin/entitlement') {
      const c = cred();
      const payload = Buffer.from(JSON.stringify({ schema: 1, issuer: ORIGIN, audience: 'blackhole-daemon', challenge: body.challenge, userId: c.userId, clientId: c.clientId, sessionId: c.sessionId, loginOrder: c.loginOrder, issuedAt: now(), expiresAt: now() + 1800 })).toString('base64url');
      return json(200, { ticket: { payload, signature: sign(null, Buffer.from(payload, 'base64url'), privateKey).toString('base64url') } });
    }
    return json(503, { error: 'unavailable' });
  };
}

function service({ secrets = { kind: 'memory', port: memorySecretPort() }, gate, cloudFetch } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-account-'));
  const state = new Map();
  const calls = [];
  const svc = new AccountService({ origin: ORIGIN, dataDir, machineState: { get: (k) => state.get(k), set: (k, v) => state.set(k, v) }, secrets, gate, openExternal: async () => true, fetch: cloudFetch ?? fakeCloud(calls), log: () => {} });
  return { svc, state, calls, cleanup: async () => { await svc.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}

test('migration adopts the VS Code login once and the daemon proves entitlement itself', async (t) => {
  const gate = new EntitlementGate(SPKI, ORIGIN);
  const { svc, state, calls, cleanup } = service({ gate });
  t.after(cleanup);
  const derived = svc.clientId();
  assert.equal(svc.clientId(), derived, 'stable without migration');
  await assert.rejects(gate.ensure(true), /entitlement_verification_required/, 'no login yet');

  assert.deepEqual(await svc.migrate(cred()), { migrated: true });
  assert.equal(state.get('account.client_id'), cred().clientId, 'clientId travels with the credential');
  const view = await svc.view();
  assert.equal(view.userId, 'user_1');
  assert.equal(view.storage, 'available');
  assert.ok(!JSON.stringify(view).includes('bhp_'));

  await gate.ensure(true); // answered by the daemon's own prover, no extension bridge
  assert.ok(calls.includes('/api/auth/plugin/entitlement'));

  assert.equal((await svc.migrate(cred())).reason, 'same_session', 'idempotent');
  assert.equal((await svc.migrate(cred({ sessionId: '99999999-2222-4333-8444-555555555555', loginOrder: 9 }))).reason, 'daemon_has_account');

  await svc.call('signOut', []);
  assert.equal((await svc.view()).state, 'logged_out');
  await assert.rejects(gate.ensure(true), /entitlement_verification_required/, 'logout reaches the gate');
});

test('concurrent migrations from several windows store one login', async (t) => {
  const { svc, cleanup } = service();
  t.after(cleanup);
  const results = await Promise.all([svc.migrate(cred()), svc.migrate(cred()), svc.migrate(cred())]);
  assert.equal(results.filter((r) => r.migrated).length, 1);
  assert.equal(results.filter((r) => r.reason === 'same_session').length, 2);
});

test('an expired daemon login does not block a fresh VS Code login', async (t) => {
  const { svc, cleanup } = service();
  t.after(cleanup);
  await svc.migrate(cred({ expiresAt: now() + 1 }));
  await new Promise((r) => setTimeout(r, 2100));
  const next = cred({ sessionId: '22222222-2222-4333-8444-555555555555', loginOrder: 6 });
  assert.deepEqual(await svc.migrate(next), { migrated: true });
  assert.equal((await svc.view()).userId, 'user_1');
});

test('without an OS credential store the daemon reports unavailable and refuses to hold secrets', async (t) => {
  const { svc, cleanup } = service({ secrets: { kind: 'unavailable', reason: 'test' } });
  t.after(cleanup);
  assert.equal(svc.storage, 'unavailable');
  const v = await svc.view();
  assert.equal(v.state, 'unavailable');
  assert.equal(v.storage, 'unavailable');
  await assert.rejects(svc.migrate(cred()), (e) => e instanceof AccountError && e.status === 503);
  await assert.rejects(svc.call('view', []), (e) => e instanceof AccountError && e.code === 'storage_unavailable');
  assert.throws(() => svc.beginSignIn(), (e) => e instanceof AccountError && e.status === 503);
});

test('only whitelisted methods with string arguments can be called', async (t) => {
  const { svc, cleanup } = service();
  t.after(cleanup);
  for (const [m, a] of [['migrationCredential', []], ['constructor', []], ['view', ['x']], ['billingPlans', [1]], ['redeemCard', 'x'], ['billingOrder', ['a', 'b', 'c']]]) {
    await assert.rejects(svc.call(m, a), (e) => e instanceof AccountError && e.status === 400, m);
  }
  await assert.rejects(svc.migrate({ token: 'x' }), (e) => e instanceof AccountError && e.code === 'invalid_input');
});

test('only a cloud-verified Core identity can open Web, and explicit failed verification revokes it', async t => {
  let cloudAvailable = false;
  const fixture = cred();
  const cloudFetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, ORIGIN, 'fixture must not contact real services');
    if (url.pathname === '/api/auth/plugin/session') {
      if (!cloudAvailable) return Response.json({error:'unavailable'}, {status:503});
      const {token, ...facts} = fixture;
      assert.equal(init.headers.Authorization, 'Bearer '+token);
      return Response.json(facts);
    }
    if (url.pathname === '/api/auth/plugin/logout') return new Response(null,{status:204});
    throw Error('unexpected_external_auth_call');
  };
  const {svc,cleanup} = service({cloudFetch});
  t.after(cleanup);
  assert.equal(svc.webAuthStatus(), 'checking');
  await svc.start();
  assert.equal(svc.webAuthStatus(), 'logged_out');
  assert.equal(svc.currentVerifiedUserId(),null);
  await svc.migrate(fixture);
  await svc.call('check',[]);
  assert.equal(svc.currentVerifiedUserId(),null,'saved/unavailable credential never authorizes Web');
  cloudAvailable = true;
  assert.equal((await svc.call('check',[])).state,'verified');
  assert.equal(svc.webAuthStatus(),'verified');
  assert.equal(svc.currentVerifiedUserId(),fixture.userId);
  cloudAvailable = false;
  assert.equal((await svc.call('check',[])).state,'unavailable');
  assert.equal(svc.currentVerifiedUserId(),null,'known verification failure must fail closed');
  cloudAvailable = true;
  assert.equal((await svc.call('check',[])).state,'verified');
  await svc.call('signOut',[]);
  assert.equal(svc.webAuthStatus(),'logged_out');
  assert.equal(svc.currentVerifiedUserId(),null,'logout revokes confirmed Web access');
});

test('native account call and GET view keep the same verified Core state across cache expiration',async t=>{
 const fixture=cred(),requests=[];
 let wall=Date.now(),revoked=false;
 const cloudFetch=async(input,init)=>{
  const url=new URL(String(input));assert.equal(url.origin,ORIGIN);
  requests.push(url.pathname);
  if(url.pathname==='/api/auth/plugin/session'){
   if(revoked)return Response.json({error:'revoked'},{status:401});
   const {token,...facts}=fixture;assert.equal(init.headers.Authorization,'Bearer '+token);
   return Response.json(facts);
  }
  throw Error('ONLY_READ_ONLY_AUTH_ALLOWED');
 };
 const {svc,cleanup}=service({cloudFetch});t.after(cleanup);
 await svc.migrate(fixture);await svc.call('check',[]);
 // Test-only clock injection into the actual client, never into the running daemon.
 const client=svc.need();client.now=()=>wall;
 let before=requests.length;
 for(let n=0;n<10;n++){
  wall+=61_000;
  assert.equal((await client.view()).state,'saved','this was the welcome guard regression');
  const views=await Promise.all([svc.call('view',[]),svc.view(),svc.call('view',[])]);
  assert.ok(views.every(v=>v.state==='verified'));
  assert.equal(svc.webAuthStatus(),'verified');
  assert.equal(requests.length,++before,'one Core request for all native clients');
 }
 revoked=true;wall+=61_000;
 assert.equal((await svc.call('view',[])).state,'logged_out');
 assert.equal(svc.currentVerifiedUserId(),null);assert.equal(svc.webAuthStatus(),'logged_out');
 assert.ok(requests.every(p=>p==='/api/auth/plugin/session'));
});

test('Core recovers account verification without any UI account polling', async t => {
 t.mock.timers.enable({apis:['setInterval']});
 const fixture=cred();let wall=Date.now(),available=true,reads=0;
 const cloudFetch=async input=>{
  assert.equal(new URL(String(input)).origin,ORIGIN);
  assert.equal(new URL(String(input)).pathname,'/api/auth/plugin/session');
  reads++;
  const {token,...facts}=fixture;
  return available?Response.json(facts):Response.json({error:'unavailable'},{status:503});
 };
 const {svc,cleanup}=service({cloudFetch});
 t.after(cleanup);
 await svc.start();await svc.migrate(fixture);
 const verified=await svc.call('check',[]);wall=verified.checkedAt;
 const client=svc.need();client.now=()=>wall;
 const initial=reads;
 for(let cycle=0;cycle<4;cycle++){
  wall+=45_000;t.mock.timers.tick(45_000);
  for(let n=0;n<10;n++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(svc.webAuthStatus(),'verified','healthy idle Core stays verified across multiple cache windows');
 }
 assert.equal(reads,initial+4);
 available=false;wall+=45_000;t.mock.timers.tick(45_000);
 for(let n=0;n<10;n++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(reads,initial+5,'Core must renew without api.account polling');
 assert.equal(svc.webAuthStatus(),'unavailable','failed checks must still close Web access');
 available=true;wall+=31_000;t.mock.timers.tick(15_000);
 for(let n=0;n<10;n++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(svc.webAuthStatus(),'verified','waiting Desktop can observe automatic recovery');
 assert.equal(svc.currentVerifiedUserId(),fixture.userId);
 await svc.stop();const stopped=reads;wall+=61_000;t.mock.timers.tick(60_000);
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(reads,stopped,'shutdown cancels account polling');
});

test('Core shutdown cancels an in-flight verification before a late 401 mutates credentials', async t => {
 const fixture=cred();let release,started;
 const waiting=new Promise(resolve=>{started=resolve;});
 let delay=false;
 const cloudFetch=async input=>{
  assert.equal(new URL(String(input)).origin,ORIGIN);
  if(delay){started();return new Promise(resolve=>{release=resolve;});}
  const {token,...facts}=fixture;return Response.json(facts);
 };
 const {svc,cleanup}=service({cloudFetch});t.after(cleanup);
 await svc.start();await svc.migrate(fixture);await svc.call('check',[]);
 const client=svc.need();client.now=()=>Date.now()+61_000;
 delay=true;const observing=svc.view();await waiting;
 const stopping=svc.stop();
 release(Response.json({error:'revoked'},{status:401}));
 await stopping;await observing;
 assert.equal((await client.migrationCredential()).sessionId,fixture.sessionId,
  'a response arriving after cancellation cannot delete the saved credential');
 assert.equal((await svc.view()).state,'unavailable','a stopped service cannot restart IO');
});

test('native Core login opens the validated cloud page without exposing PKCE or granting Web access', { timeout: 10_000 }, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-native-auth-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const state = new Map(), vault = memorySecretPort();
  const flowId = '11111111-2222-4333-8444-555555555555';
  const authorizationUrl = ORIGIN + '/api/auth/plugin/authorize#flow=' + flowId + '&launch=' + 'A'.repeat(43);
  let requestBody, receiveOpen;
  const opened = new Promise(resolve => { receiveOpen = resolve; });
  const svc = new AccountService({
    origin: ORIGIN, dataDir, machineState: { get: k => state.get(k), set: (k, v) => state.set(k, v) },
    secrets: { kind: 'memory', port: vault }, log() {},
    openExternal: async url => { receiveOpen(url); return true; },
    fetch: async (input, init) => {
      assert.equal(new URL(String(input)).origin, ORIGIN, 'cloud issuer is pinned');
      const name = new URL(String(input)).pathname;
      if (name !== '/api/auth/plugin/start') throw Error('unexpected_cloud_request:' + name);
      requestBody = JSON.parse(String(init.body));
      return Response.json({ flowId, authorizationUrl, expiresAt: Math.floor(Date.now() / 1000) + 600, pollInterval: 2 });
    },
  });
  const job = svc.beginSignIn({ sameAccount: true });
  assert.equal(job.state, 'running');
  const url = await Promise.race([opened, new Promise((_resolve, reject) => setTimeout(() => reject(Error('auth_url_not_opened')), 3000))]);
  assert.equal(url, authorizationUrl);
  assert.deepEqual(Object.keys(requestBody).sort(), ['challenge', 'clientId']);
  assert.match(requestBody.challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(!url.includes(requestBody.challenge));
  assert.equal(svc.webAuthStatus(), 'checking', 'an account not initialized must not report authenticated');
  assert.equal(svc.currentVerifiedUserId(), null, 'opening a link is not account verification');
  assert.doesNotMatch(JSON.stringify(await svc.view()), /authorizationUrl|verifier|bhp_/);
  svc.cancelSignIn();
  for (let i = 0; i < 30 && svc.signInState().state === 'running'; i++)
    await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(svc.signInState().state, 'failed');
  assert.equal(svc.signInState().error, 'cancelled');
  assert.equal(svc.currentVerifiedUserId(), null);
});

test('Web "stop background service" shuts the daemon down gracefully', { timeout: 60_000 }, async (t) => {
  const iso = await createIsolatedEnv({ name: 'web-stop' });
  const expiration = Math.floor(Date.now()/1000)+3600;
  const env = { ...iso.env, BLACKHOLE_WEB_DIR: path.join(ROOT, 'packages/web/dist'),
    BLACKHOLE_ACCOUNT_OFFLINE: '0', WEB_TEST_AUTH_EXPIRES_AT: String(expiration),
    NODE_OPTIONS: '--require ' + path.join(ROOT, 'scripts/fixtures/fake-cloud-auth.cjs') };
  const child = spawn(process.execPath, [path.join(ROOT, 'dist/cli.js'), 'serve', '--port', String(iso.port)], { env, stdio: 'ignore' });
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  t.after(async () => { if (child.exitCode === null) child.kill(); await exited; try { iso.cleanup(); } catch { /* windows locks */ } });
  const base = `http://127.0.0.1:${iso.port}`;
  for (let i = 0; i < 60; i++) {
    if (await fetch(base + '/api/health').then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  // The Web opens no business routes until this machine has a cloud account (plan 6.13 L2).
  const cred = { token: 'bhp_' + 'a'.repeat(43), userId: 'user_1', clientId: 'c'.repeat(22), sessionId: '11111111-2222-4333-8444-555555555555', expiresAt: expiration, loginOrder: 7 };
  assert.equal((await fetch(base + '/api/web/bootstrap', { method: 'POST' })).status, 401);
  assert.equal((await fetch(base + '/api/account/migrate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ credential: cred }) })).status, 200);
  const verified = await fetch(base + '/api/account/call', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method:'check',args:[] }) });
  assert.equal((await verified.json()).result.state,'verified');
  const { ticket } = await (await fetch(base + '/api/web/bootstrap', { method: 'POST' })).json();
  const headers = { 'x-blackhole-web': '1', 'content-type': 'application/json', origin: base };
  const ex = await fetch(base + '/web-api/v1/auth/exchange', { method: 'POST', headers, body: JSON.stringify({ ticket }) });
  assert.equal(ex.status, 200);
  const cookie = ex.headers.get('set-cookie').split(';')[0];
  const { csrf } = await ex.json();
  const stop = (body, extra = {}) => fetch(base + '/web-api/v1/daemon/stop', { method: 'POST', headers: { ...headers, cookie, 'x-blackhole-csrf': csrf, ...extra }, body: JSON.stringify(body) });
  assert.equal((await stop({ confirm: true }, { 'x-blackhole-csrf': 'bad' })).status, 403);
  assert.equal((await stop({})).status, 400);
  assert.equal((await stop({ confirm: true })).status, 200);
  assert.equal(await exited, 0, 'graceful exit');
  assert.equal(await fetch(base + '/api/health').then(() => 'up', () => 'down'), 'down');
});
