// Real loopback passive-Web gate with an isolated Core and synthetic cloud.
// Nothing reaches a real cloud service, user credential store or fixed port.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createIsolatedEnv } from './fixtures/isolated-env.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (process.argv.includes('--auth-fixture-daemon')) {
  const { startDaemon } = await import('../dist/daemon.js');
  const daemon = await startDaemon({
    port: Number(process.env.BLACKHOLE_PORT),
    dbPath: process.env.BLACKHOLE_DB,
    tunnel: 'off',
  }, () => {});
  process.on('message', msg => {
    if (msg === 'stop') void daemon.stop().then(() => process.exit(0), () => process.exit(1));
  });
  process.send({ ready: true });
} else {
  test('browser Web cannot initiate login; only verified Core grants a bound Web session', { timeout: 50_000 }, async t => {
    const iso = await createIsolatedEnv({ name: 'web-passive-gate' });
    const expiration = Math.floor(Date.now()/1000)+3600;
    const env = { ...iso.env, BLACKHOLE_ACCOUNT_OFFLINE: '0',
      WEB_TEST_AUTH_EXPIRES_AT: String(expiration),
      BLACKHOLE_WEB_DIR: path.join(ROOT, 'packages/web/dist'),
      NODE_OPTIONS: '--require ' + path.join(ROOT, 'scripts/fixtures/fake-cloud-auth.cjs'),
    };
    const child = fork(fileURLToPath(import.meta.url), ['--auth-fixture-daemon'], {
      env, stdio: ['ignore','ignore','inherit','ipc'],
    });
    const exited = new Promise(resolve => child.once('exit', resolve));
    t.after(async () => {
      if (child.connected) child.send('stop');
      let timer;
      await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => { child.kill(); resolve(); }, 4000); })]);
      clearTimeout(timer);
      iso.cleanup();
    });
    await new Promise((resolve,reject) => {
      const timer = setTimeout(() => reject(Error('daemon_fixture_timeout')), 15000);
      child.once('message', m => { clearTimeout(timer); m.ready ? resolve() : reject(Error('not_ready')); });
      child.once('exit', code => { clearTimeout(timer); reject(Error('unexpected_exit_'+code)); });
    });
    const base = 'http://127.0.0.1:' + iso.port;
    const web = (path, init={}) => fetch(base + '/web-api/v1' + path,
      { ...init, headers: { 'x-blackhole-web': '1', 'content-type': 'application/json', origin: base, ...init.headers } });
    const core = (route, body) => fetch(base + '/api' + route, {method:body?'POST':'GET',
      headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined});
    assert.deepEqual(await (await web('/auth/status')).json(), {state:'logged_out'});
    assert.equal((await fetch(base+'/web-api/v1/auth/status')).status, 403);
    assert.equal((await web('/auth/status',{headers:{origin:'http://evil.test'}})).status,403);
    assert.equal((await web('/auth/login',{method:'POST',body:'{}'})).status,410);
    assert.equal((await web('/auth/login/'+'A'.repeat(43))).status,410);
    for (const route of ['/account/sign-in','/account/sign-in/cancel','/account/call','/account/migrate']) {
      for (const headers of [{ origin:base }, { 'sec-fetch-site':'same-origin' }, { cookie:'bh_web=dummy' }]) {
        assert.equal((await fetch(base+'/api'+route,{method:'POST',headers:{'content-type':'application/json',...headers},body:'{}'})).status,403,
          'native login/account action rejects browser provenance: '+route);
      }
    }
    assert.equal((await core('/web/bootstrap',{})).status,401);
    assert.equal((await web('/auth/local',{method:'POST',body:'{}'})).status,401);
    assert.equal((await web('/sessions')).status,401);

    const credential = { token:'bhp_'+'a'.repeat(43),userId:'user_1',clientId:'c'.repeat(22),
      sessionId:'11111111-2222-4333-8444-555555555555',expiresAt:expiration,loginOrder:7 };
    assert.equal((await core('/account/migrate',{credential})).status,200);
    const verify = await (await core('/account/call',{method:'check',args:[]})).json();
    assert.equal(verify.result.state,'verified');
    assert.deepEqual(await (await web('/auth/status')).json(), {state:'verified'});
    assert.equal((await core('/account/welcome').then(r=>r.json())).state,'verified');
    const local = await web('/auth/local',{method:'POST',body:'{}'});
    assert.equal(local.status,200);
    const cookie = local.headers.get('set-cookie').split(';')[0];
    const { csrf } = await local.json();
    assert.equal((await web('/sessions',{headers:{cookie}})).status,200);
    // Authenticated Web Console must not secretly retain a second OAuth entry.
    for (const route of ['/account/sign-in', '/account/sign-in/cancel']) {
      const response = await web(route, {method:'POST',body:'{}',headers:{cookie,'x-blackhole-csrf':csrf}});
      assert.equal(response.status,410,route+' must be disabled even with a valid Web cookie');
      assert.deepEqual(await response.json(), {error:'native_login_required'});
    }
    assert.equal((await core('/account/welcome').then(r=>r.json())).signIn.state, 'idle', 'Web did not start a login');

    assert.equal((await core('/account/call',{method:'signOut',args:[]})).status,200);
    assert.deepEqual(await (await web('/auth/status')).json(), {state:'logged_out'});
    assert.equal((await web('/sessions',{headers:{cookie}})).status,401);
  });
}

