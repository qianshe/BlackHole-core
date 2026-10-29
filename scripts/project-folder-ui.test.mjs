// Browser acceptance of the shared, Core-scoped in-app folder picker.
// Real Core, real Edge, synthetic cloud; neither fixed ports nor user files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { fork, spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIsolatedEnv } from './fixtures/isolated-env.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('New session and Add project share the in-app Core folder browser; no native terminal picker', { timeout: 85_000 }, async t => {
  const iso = await createIsolatedEnv({ name: 'project-folder-ui' });
  const first = path.join(iso.home, 'first-project');
  const second = path.join(iso.home, 'second-project');
  mkdirSync(path.join(first, 'src'), {recursive: true});
  mkdirSync(second, {recursive: true});
  const expiration = Math.floor(Date.now() / 1000) + 3600;
  const layout = process.env.BH_PROJECT_TEST_LAYOUT ? path.resolve(process.env.BH_PROJECT_TEST_LAYOUT) : null;
  const base = 'http://127.0.0.1:'+iso.port;
  const env = {
    ...iso.env, BLACKHOLE_ACCOUNT_OFFLINE: '0',
    WEB_TEST_AUTH_EXPIRES_AT: String(expiration),
    // Packaged mode MUST serve the actual layout, not silently substitute the
    // freshly built development Web tree (which concealed the original bug).
    BLACKHOLE_WEB_DIR: layout ? path.join(layout,'web') : path.join(ROOT,'packages/web/dist'),
    NODE_OPTIONS: '--require ' + path.join(ROOT, 'scripts/fixtures/fake-cloud-auth.cjs'),
  };
  const child = layout
    ? spawn(path.join(layout,'node','node.exe'),[path.join(layout,'daemon','cli.js'),'serve','--port',String(iso.port)],{
      cwd:layout,env,stdio:['ignore','ignore','inherit'],windowsHide:true,
    })
    : fork(path.join(ROOT,'scripts/web-login-handoff.test.mjs'), ['--auth-fixture-daemon'], {
      env, stdio: ['ignore','ignore','inherit','ipc'],
    });
  const exited = new Promise(resolve => child.once('exit', resolve));
  let browser;
  t.after(async () => {
    await browser?.close();
    if (child.connected) child.send('stop');
    else if (layout && child.exitCode === null) {
      try {
        const health=await fetch(base+'/api/health',{signal:AbortSignal.timeout(1500)}).then(r=>r.json());
        assert.equal(path.resolve(health.db_path),path.resolve(env.BLACKHOLE_DB));
        await fetch(base+'/api/shutdown',{method:'POST',headers:{'content-type':'application/json'},
          body:JSON.stringify({daemon_id:health.daemon_id,start_fingerprint:health.start_fingerprint??null}),
          signal:AbortSignal.timeout(2000)});
      } catch { /* the isolated child fallback below handles startup failure */ }
    }
    let timer;
    await Promise.race([exited,new Promise(resolve => { timer=setTimeout(()=>{child.kill();resolve();},4000); })]);
    clearTimeout(timer);
    iso.cleanup();
  });

  if (layout) {
    let ready=false;
    for(let attempt=0;attempt<100;attempt++) {
      if(child.exitCode!==null) throw Error('packaged_core_exit_'+child.exitCode);
      try {
        const health=await fetch(base+'/api/health',{signal:AbortSignal.timeout(500)}).then(r=>r.json());
        assert.equal(path.resolve(health.db_path),path.resolve(env.BLACKHOLE_DB));
        ready=true;break;
      } catch { await new Promise(resolve=>setTimeout(resolve,100)); }
    }
    assert.ok(ready,'packaged Core must boot in the isolated test directory');
    const expected=readFileSync(path.join(ROOT,'packages/web/dist/index.html'),'utf8');
    const response=await fetch(base+'/desktop/',{headers:{accept:'text/html'}});
    assert.equal(response.status,200);
    const html=await response.text();
    const js=expected.match(/\/ui\/assets\/index-[A-Za-z0-9_-]+\.js/)?.[0];
    assert.ok(js && html.includes(js),'packaged runtime is serving stale Web assets');
    const delivered=Buffer.from(await (await fetch(base+js)).arrayBuffer());
    const compiled=readFileSync(path.join(ROOT,'packages/web/dist',js.slice('/ui/'.length)));
    const hash=value=>createHash('sha256').update(value).digest('hex');
    assert.equal(hash(delivered),hash(compiled),'served packaged JS bytes match the tested build');
  } else {
    await new Promise((resolve,reject) => {
      const timer=setTimeout(()=>reject(Error('isolated_core_timeout')),15000);
      child.once('message',m=>{clearTimeout(timer);m.ready?resolve():reject(Error('isolated_core_not_ready'));});
      child.once('exit',code=>{clearTimeout(timer);reject(Error('isolated_core_exit_'+code));});
    });
  }
  const corePost = (endpoint, body) => fetch(base+'/api'+endpoint,{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),
    signal:AbortSignal.timeout(5000),
  });
  const credential = {
    token: 'bhp_' + 'a'.repeat(43), userId:'user_1',clientId:'c'.repeat(22),
    sessionId:'11111111-2222-4333-8444-555555555555',expiresAt:expiration,loginOrder:7,
  };
  assert.equal((await corePost('/account/migrate',{credential})).status,200);
  const verified = await (await corePost('/account/call',{method:'check',args:[]})).json();
  assert.equal(verified.result.state,'verified');

  browser = await chromium.launch({channel:'msedge',headless:true});
  const page = await browser.newPage({viewport:{width:1440,height:920},locale:'zh-CN'});
  const pageErrors = [];
  const nativeCalls = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  page.on('request', request => {
    if (request.url().endsWith('/projects/pick')) nativeCalls.push(request.url());
  });
  await page.goto(base+'/',{waitUntil:'domcontentloaded',timeout:15000});
  await page.getByRole('heading',{name:'新会话'}).waitFor({timeout:15000});
  assert.equal(await page.getByRole('dialog',{name:'添加项目'}).count(),0);

  // Empty project list: the action row must still be clickable.
  await page.getByRole('button',{name:'项目',exact:true}).click();
  const initialSwitch=page.getByRole('dialog',{name:'选择项目'});
  await initialSwitch.getByRole('button',{name:/添加新项目/}).click();
  const sessionDialog = page.getByRole('dialog',{name:'选择工作目录'});
  await sessionDialog.waitFor({timeout:7000});
  const compactDialog=await sessionDialog.locator('> div').boundingBox();
  assert.ok(compactDialog && compactDialog.width<=561 && compactDialog.width>=490
    && Math.abs(compactDialog.x+(compactDialog.width/2)-720)<3,
    'folder picker must be BlackHole original centered, compact dialog, not right drawer');
  assert.equal(await sessionDialog.getByRole('button',{name:'使用此目录'}).isDisabled(),true);
  await sessionDialog.getByRole('textbox',{name:'目录路径'}).fill(first);
  assert.equal(await sessionDialog.getByRole('button',{name:'使用此目录'}).isDisabled(),true,
    'a typed path is not selected until Core verifies it');
  await sessionDialog.getByRole('button',{name:'转到'}).click();
  await sessionDialog.getByRole('button',{name:'使用此目录'}).waitFor({state:'visible'});
  await page.waitForFunction(() => {
    const dialog = document.querySelector('dialog[open]');
    const button = [...(dialog?.querySelectorAll('button') ?? [])].find(el=>el.textContent?.includes('使用此目录'));
    return !!button && !button.disabled;
  },{timeout:10000});
  assert.equal(await sessionDialog.getByRole('button',{name:'进入 src'}).count(),1);
  const originalFolder = sessionDialog.getByRole('button',{name:'进入 src'})
    .locator('svg path[d^="M3 7a2 2 0 0 1"]');
  assert.equal(await originalFolder.count(),1,'folder icon should reuse BlackHole original 24px outline SVG, not text glyph');
  // Entering the already selected location is an explicit refresh, not a
  // dead-end with a permanently disabled confirm action.
  await sessionDialog.getByRole('button',{name:'转到'}).click();
  await page.waitForFunction(() => {
    const dialog = document.querySelector('dialog[open]');
    const confirm = [...(dialog?.querySelectorAll('button') ?? [])].find(el=>el.textContent?.includes('使用此目录'));
    return !!confirm && !confirm.disabled;
  },{timeout:10000});
  await page.screenshot({path:path.join(ROOT,'.tmp','project-picker-wide-preview.png')});
  await page.emulateMedia({colorScheme:'dark'});
  await page.screenshot({path:path.join(ROOT,'.tmp','project-picker-dark-preview.png')});
  await page.emulateMedia({colorScheme:'light'});
  await page.setViewportSize({width:430,height:720});
  const bounds=await sessionDialog.boundingBox();
  assert.ok(bounds && bounds.x>=0 && bounds.y>=0 && bounds.x+bounds.width<=430 && bounds.y+bounds.height<=720,
    'shared folder picker must fit a narrow Desktop/Web window without clipping');
  assert.equal(await sessionDialog.getByRole('button',{name:'使用此目录'}).isVisible(),true);
  await page.screenshot({path:path.join(ROOT,'.tmp','project-picker-narrow-preview.png')});
  await page.setViewportSize({width:1440,height:920});
  await sessionDialog.getByRole('button',{name:'使用此目录'}).click();
  await sessionDialog.waitFor({state:'detached',timeout:10000});
  assert.equal(await page.getByRole('textbox',{name:'第一条消息'}).evaluate(el=>document.activeElement===el),true,
    'after adding a directory from new session, typing resumes in the composer');

  // A project is saved once, and its path is remembered for the next session.
  const readProjects = () => page.evaluate(async () => {
    const res = await fetch('/web-api/v1/projects',{headers:{'x-blackhole-web':'1'}});
    if (!res.ok) throw Error('projects_http_'+res.status);
    return (await res.json()).projects;
  });
  await page.waitForFunction(async () => (await fetch('/web-api/v1/projects',{headers:{'x-blackhole-web':'1'}}).then(r=>r.json())).projects.some(p=>p.path.includes('first-project')));
  assert.equal((await readProjects()).filter(p=>p.path===first).length,1);
  await page.reload({waitUntil:'domcontentloaded'});
  await page.getByRole('heading',{name:'新会话'}).waitFor({timeout:12000});
  assert.equal(await page.getByRole('button',{name:'项目',exact:true}).innerText(),'first-project');
  await page.setViewportSize({width:430,height:720});
  await page.getByRole('button',{name:'项目',exact:true}).click();
  const switcher=page.getByRole('dialog',{name:'选择项目'});
  const smallSwitcher=await switcher.boundingBox();
  await page.screenshot({path:path.join(ROOT,'.tmp','project-switcher-narrow-preview.png')});
  assert.ok(smallSwitcher && smallSwitcher.x>=0 && smallSwitcher.x+smallSwitcher.width<=430,
    'searchable project switcher must not overflow a narrow screen: '+JSON.stringify(smallSwitcher));
  await page.setViewportSize({width:1440,height:920});
  await switcher.getByRole('searchbox',{name:'搜索项目'}).fill('not-a-project');
  assert.equal(await switcher.getByRole('option').count(),0);
  await switcher.getByRole('searchbox',{name:'搜索项目'}).fill('first');
  assert.equal(await switcher.getByRole('option').count(),1);
  await page.screenshot({path:path.join(ROOT,'.tmp','project-switcher-v2-preview.png')});
  await switcher.getByRole('option').click();
  assert.equal(await page.getByRole('dialog',{name:'选择项目'}).count(),0);
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '第一条消息',
    null, {timeout:3500});

  // Sidebar uses the SAME browser and does not start PowerShell.
  await page.getByRole('button',{name:'添加项目',exact:true}).click();
  const addDialog=page.getByRole('dialog',{name:'添加项目'});
  await addDialog.waitFor({timeout:7000});
  assert.match(await addDialog.innerText(),/选择 Shared Core 所在电脑上的工作目录/);
  assert.equal(await addDialog.locator('> div').count(),1);
  await addDialog.getByRole('textbox',{name:'目录路径'}).fill(path.join(iso.home,'does-not-exist'));
  await addDialog.getByRole('button',{name:'转到'}).click();
  await addDialog.getByRole('alert').waitFor({timeout:10000});
  assert.equal(await addDialog.getByRole('button',{name:'添加项目'}).isDisabled(),true);
  await addDialog.getByRole('textbox',{name:'目录路径'}).fill(second);
  assert.equal(await addDialog.getByRole('button',{name:'添加项目'}).isDisabled(),true,
    'changing the typed directory invalidates the previous verified location');
  await addDialog.getByRole('button',{name:'转到'}).click();
  await page.waitForFunction(() => {
    const dialog=document.querySelector('dialog[open]');
    const button=[...(dialog?.querySelectorAll('button')??[])].find(b=>b.textContent?.trim()==='添加项目');
    return !!button && !button.disabled;
  });
  await addDialog.getByRole('button',{name:'添加项目'}).click();
  await addDialog.waitFor({state:'detached',timeout:10000});
  const saved=await readProjects();
  assert.equal(saved.filter(p=>p.saved).length,2);
  assert.equal(saved.find(p=>p.path===second)?.saved,true);
  await page.getByRole('heading',{name:'新会话'}).waitFor();
  assert.equal(await page.getByRole('button',{name:'项目',exact:true}).innerText(),'second-project');
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '第一条消息',
    null, {timeout:3500});
  // Existing projects are switched inline without a folder browser or a
  // duplicate API write. Keyboard arrows/Enter select the searched project.
  await page.getByRole('button',{name:'项目',exact:true}).click();
  const secondSwitch=page.getByRole('dialog',{name:'选择项目'});
  await secondSwitch.getByRole('searchbox',{name:'搜索项目'}).fill('first');
  await secondSwitch.getByRole('searchbox',{name:'搜索项目'}).press('ArrowDown');
  await secondSwitch.getByRole('searchbox',{name:'搜索项目'}).press('ArrowUp');
  await secondSwitch.getByRole('searchbox',{name:'搜索项目'}).press('Enter');
  assert.equal(await page.getByRole('button',{name:'项目',exact:true}).innerText(),'first-project');

  // Cancel never changes project count, session or on-disk data.
  await page.getByRole('button',{name:'添加项目',exact:true}).click();
  const cancelDialog=page.getByRole('dialog',{name:'添加项目'});
  await cancelDialog.waitFor();
  await page.keyboard.press('Escape');
  await cancelDialog.waitFor({state:'detached',timeout:7000});
  assert.equal((await readProjects()).filter(p=>p.saved).length,2);
  assert.equal(nativeCalls.length,0,'the deprecated Core native picker endpoint must never be called');
  assert.deepEqual(pageErrors,[]);
  console.log(JSON.stringify({ok:true,isolatedPort:iso.port,projectsSaved:2,sharedPicker:true,nativePickerCalls:0}));
});
