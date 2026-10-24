// Real Edge UI test: passive browser Web + native-host welcome share one Core.
// Synthetic cloud fixture runs on a random loopback port and isolated data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createIsolatedEnv } from './fixtures/isolated-env.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Edge Web waits passively while Desktop native welcome drives Core-first onboarding', { timeout: 65000 }, async t => {
  const iso = await createIsolatedEnv({ name: 'web-wait-browser' });
  const expiration = Math.floor(Date.now()/1000)+3600;
  const env = { ...iso.env, BLACKHOLE_ACCOUNT_OFFLINE: '0',
    WEB_TEST_AUTH_EXPIRES_AT: String(expiration),
    BLACKHOLE_WEB_DIR: path.join(ROOT, 'packages/web/dist'),
    NODE_OPTIONS: '--require ' + path.join(ROOT, 'scripts/fixtures/fake-cloud-auth.cjs'),
  };
  const child = fork(path.join(ROOT, 'scripts/web-login-handoff.test.mjs'), ['--auth-fixture-daemon'],
    {env,stdio:['ignore','ignore','inherit','ipc']});
  const exited = new Promise(resolve => child.once('exit',resolve));
  let browser;
  t.after(async () => {
    await browser?.close();
    if(child.connected)child.send('stop');
    let timer;
    await Promise.race([exited,new Promise(resolve=>{timer=setTimeout(()=>{child.kill();resolve();},4000);})]);
    clearTimeout(timer);
    iso.cleanup();
  });
  await new Promise((resolve,reject) => {
    const timer=setTimeout(()=>reject(Error('fixture_ready_timeout')),15000);
    child.once('message',message=>{clearTimeout(timer);message.ready?resolve():reject(Error('fixture_failed'));});
    child.once('exit',code=>{clearTimeout(timer);reject(Error('fixture_died_'+code));});
  });
  browser=await chromium.launch({channel:'msedge',headless:true});
  const ordinary=await browser.newContext({viewport:{width:1200,height:800},colorScheme:'dark',locale:'zh-CN'});
  const browserPage=await ordinary.newPage();
  const base='http://127.0.0.1:'+iso.port;
  await browserPage.goto(base+'/',{waitUntil:'domcontentloaded'});
  await browserPage.getByRole('heading',{name:/等待 BlackHole 认证/}).waitFor({timeout:15000});
  assert.equal(await browserPage.getByRole('button',{name:/登录|Cloudflare|OpenAI/}).count(),0);
  assert.match(await browserPage.getByRole('status').innerText(),/等待|检查/);

  // The native document grants no account rights to an ordinary browser.
  const copied=await ordinary.newPage();
  await copied.goto(base+'/desktop/',{waitUntil:'domcontentloaded'});
  await copied.getByRole('button',{name:/在系统浏览器中登录/}).waitFor({timeout:15000});
  await copied.getByRole('button',{name:/在系统浏览器中登录/}).click();
  assert.match(await copied.getByRole('alert').first().innerText(),/Core 无法完成此操作|Desktop 登录通道/);
  assert.equal((await fetch(base+'/api/account/welcome').then(r=>r.json())).signIn.state,'idle');
  await copied.close();

  const nativeContext=await browser.newContext({viewport:{width:1200,height:800},colorScheme:'dark',locale:'zh-CN'});
  await nativeContext.addInitScript(()=>{
    window.__actions=[];
    window.__phase='logged_out';
    window.__job='idle';
    window.blackholeDesktopWelcomeAction=async action=>{
      window.__actions.push(action);
      if(action==='sign-in') window.__job='running';
      if(action==='cancel') window.__job='failed';
      return JSON.stringify({state:window.__phase,signIn:{state:window.__job}});
    };
  });
  const nativePage=await nativeContext.newPage();
  await nativePage.goto(base+'/desktop/',{waitUntil:'domcontentloaded'});
  await nativePage.getByRole('button',{name:/系统浏览器中登录/}).waitFor({timeout:15000});
  assert.equal(await nativePage.getByText('OpenAI Tunnel').count(),0);
  await nativePage.getByRole('button',{name:/系统浏览器中登录/}).click();
  await nativePage.getByRole('button',{name:'取消登录'}).waitFor({timeout:10000});
  const actions=await nativePage.evaluate(()=>window.__actions);
  assert.ok(actions.includes('sign-in'));
  assert.equal(await browserPage.getByRole('heading',{name:/等待 BlackHole 认证/}).count(),1);

  const post=(route,body)=>fetch(base+'/api'+route,{method:'POST',
    headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const cred={token:'bhp_'+'a'.repeat(43),userId:'user_1',clientId:'c'.repeat(22),
    sessionId:'11111111-2222-4333-8444-555555555555',expiresAt:expiration,loginOrder:7};
  assert.equal((await post('/account/migrate',{credential:cred})).status,200);
  const validated=await (await post('/account/call',{method:'check',args:[]})).json();
  assert.equal(validated.result.state,'verified');
  await nativePage.evaluate(()=>{window.__phase='verified';window.__job='done';});
  await nativePage.getByRole('heading',{name:/选择连接方式/}).waitFor({timeout:15000});
  assert.equal(await nativePage.getByRole('button',{name:/Cloudflare/}).count(),1);
  await nativePage.getByRole('button',{name:/稍后设置/}).click();
  await nativePage.waitForFunction(()=>!document.body.textContent.includes('选择连接方式'),{timeout:15000});
  await browserPage.getByRole('heading',{name:/等待 BlackHole 认证/}).waitFor({state:'detached',timeout:15000});
  const cookieStatus=await browserPage.evaluate(async()=>(
    await fetch('/web-api/v1/auth/session',{credentials:'include',headers:{'x-blackhole-web':'1'}})).status);
  assert.equal(cookieStatus,200);
  assert.equal(await browserPage.getByRole('button',{name:/在浏览器中登录/}).count(),0);
  console.log(JSON.stringify({ok:true,flow:'client-auth-then-web',nativeActions:actions.length,webSession:200,port:iso.port}));
});

