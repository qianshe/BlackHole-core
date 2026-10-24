// Real Windows native login through production showWindow, existing Go
// account adapter and AccountService. Only cloud IO/browser opener are fake.
// CDP is enabled solely on an isolated loopback port for this test process.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import net from 'node:net';
import {spawn,fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {createIsolatedEnv} from './fixtures/isolated-env.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function freePort(){const s=net.createServer();await new Promise((r,j)=>{s.once('error',j);s.listen(0,'127.0.0.1',r)});const p=s.address().port;await new Promise(r=>s.close(r));return p;}
function run(file,args,options){return new Promise((resolve,reject)=>{const p=spawn(file,args,{...options,stdio:['ignore','pipe','pipe']});let out='',err='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);p.once('error',reject);p.once('close',code=>resolve({code,out,err}));});}

test('real native login completes and recovers from verification outage in the same window; Web remains passive',{timeout:120000},async t=>{
 if(process.platform!=='win32')return t.skip('Windows only');
 const iso=await createIsolatedEnv({name:'native-login-e2e'});
 const exe=path.join(iso.home,'native-login.test.exe');
 const built=await run('go',['-C','packages/desktop-launcher','test','-c','-o',exe,'./cmd/blackhole'],{cwd:ROOT,env:process.env});
 assert.equal(built.code,0,built.out+' '+built.err);
 let core,host,browser,ordinary;
 t.after(async()=>{
  if(host&&host.exitCode===null){host.stdin.write('close\n');for(let i=0;i<30&&host.exitCode===null;i++)await sleep(100);}
  await browser?.close().catch(()=>{});
  await ordinary?.close().catch(()=>{});
  if(core?.connected)core.send('stop');
  for(let i=0;i<40&&core?.exitCode===null;i++)await sleep(100);
  assert.ok(!host||host.exitCode!==null,'owned native window did not close normally');
  assert.ok(!core||core.exitCode!==null,'isolated Core did not stop');
  // WebView2 metrics can retain a file briefly; preserve only this isolated
  // profile if cleanup is delayed instead of touching the installed profile.
  try{iso.cleanup()}catch(e){console.log('isolated_profile_cleanup_delayed='+e.code)}
 });
 core=fork(path.join(ROOT,'scripts/fixtures/native-login-daemon.mjs'),[],{env:{...iso.env,BLACKHOLE_HOME:iso.dataDir,BH_CORE_STORE:path.join(iso.dataDir,'core'),LOCALAPPDATA:path.join(iso.home,'AppData','Local'),APPDATA:path.join(iso.home,'AppData','Roaming'),BLACKHOLE_WEB_DIR:path.join(ROOT,'packages/web/dist'),BLACKHOLE_ACCOUNT_OFFLINE:'1'},stdio:['ignore','ignore','inherit','ipc']});
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('fixture_start_timeout')),15000);core.once('message',m=>{clearTimeout(timer);m.ready?resolve():reject(Error('fixture_not_ready'))});core.once('exit',c=>{clearTimeout(timer);reject(Error('fixture_exit_'+c))})});
 let sequence=0;
 const control=(command,value)=>new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>{core.off('message',listen);reject(Error('fixture_control_timeout'))},4000);const listen=m=>{if(m.ack===id){clearTimeout(timer);core.off('message',listen);if(m.error)reject(Error(m.error));else resolve(m)}};core.on('message',listen);core.send({command,value,id})});
 const base='http://127.0.0.1:'+iso.port;
 const browserPageResponse=await fetch(base+'/',{headers:{Accept:'text/html'}});
 assert.equal(browserPageResponse.headers.get('cross-origin-opener-policy'),'same-origin');
 const nativePageResponse=await fetch(base+'/desktop/');
 assert.equal(nativePageResponse.status,200);
 assert.equal(nativePageResponse.headers.get('cross-origin-opener-policy'),null);
 assert.match(nativePageResponse.headers.get('content-security-policy'),/script-src 'self'/);
 const cdpPort=await freePort();
 host=spawn(exe,['-test.run=TestNativeLoginWindow','-test.v','-test.timeout=115s'],{cwd:ROOT,env:{...process.env,BH_NATIVE_LOGIN_URL:base+'/desktop/',BH_NATIVE_LOGIN_PROFILE:path.join(iso.home,'desktop'),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-address=127.0.0.1 --remote-debugging-port='+cdpPort},stdio:['pipe','pipe','pipe']});
 let hostOutput='';host.stdout.on('data',b=>hostOutput+=b);host.stderr.on('data',b=>hostOutput+=b);
 const endpoint='http://127.0.0.1:'+cdpPort;
 let ready=false;for(let i=0;i<55;i++){if(host.exitCode!==null)throw Error('native_exit:'+hostOutput);try{if((await fetch(endpoint+'/json/version',{signal:AbortSignal.timeout(250)})).ok){ready=true;break}}catch{}await sleep(150)}
 assert.ok(ready,'native CDP not ready: '+hostOutput);
 browser=await chromium.connectOverCDP(endpoint,{timeout:5000});
 const page=browser.contexts()[0].pages()[0];assert.ok(page);
 const pageErrors=[],authRequests=[],authReplies=[];
 page.on('pageerror',error=>pageErrors.push(error.message));
 page.on('request',request=>{if(request.url().includes('/web-api/v1/auth/'))authRequests.push({path:new URL(request.url()).pathname,at:Date.now()});});
 page.on('response',async response=>{if(response.url().includes('/web-api/v1/auth/'))authReplies.push({path:new URL(response.url()).pathname,status:response.status(),body:await response.json().catch(()=>null),at:Date.now()});});
 await page.waitForFunction(()=>location.pathname==='/desktop/'&&document.readyState==='complete',null,{timeout:10000});
 const capabilities=await page.evaluate(()=>({welcome:typeof window.blackholeDesktopWelcomeAction,webview:typeof window.chrome?.webview?.postMessage}));
 assert.deepEqual(capabilities,{welcome:'function',webview:'function'});
 await page.getByRole('button',{name:'在系统浏览器中登录',exact:true}).waitFor({timeout:10000});
 assert.equal(await page.getByRole('heading',{name:'等待 BlackHole 认证',exact:true}).count(),0);
 ordinary=await chromium.launch({channel:'msedge',headless:true});
 const web=await ordinary.newPage();await web.goto(base+'/');
 await web.getByRole('heading',{name:'等待 BlackHole 认证',exact:true}).waitFor();
 assert.equal(await web.getByRole('button',{name:/登录/}).count(),0);
 assert.equal((await control('state')).job.state,'idle','rendering must not start OAuth');
 // User click -> production native host -> Core -> synthetic system browser.
 await page.getByRole('button',{name:'在系统浏览器中登录',exact:true}).click();
 await page.getByRole('button',{name:'取消登录',exact:true}).waitFor();
 let state=await control('state');assert.equal(state.job.state,'running');assert.equal(state.opens,1);
 await page.getByRole('button',{name:'取消登录',exact:true}).click();
 await page.getByRole('button',{name:'在系统浏览器中登录',exact:true}).waitFor();
 for(let i=0;i<30;i++){state=await control('state');if(state.job.state==='failed')break;await sleep(100)}
 assert.equal(state.job.error,'cancelled');
 await control('mode','failure');
 await page.getByRole('button',{name:'在系统浏览器中登录',exact:true}).click();
 await page.getByText('登录服务暂时不可用，请稍后重试。',{exact:true}).waitFor({timeout:8000});
 assert.equal((await control('state')).opens,1,'failed start must not open a browser');
 await control('mode','authorized');
 await page.getByRole('button',{name:'在系统浏览器中登录',exact:true}).click();
 await page.getByRole('heading',{name:'选择连接方式',exact:true}).waitFor({timeout:13000});
 state=await control('state');assert.equal(state.state,'verified');assert.equal(state.opens,2);
 await web.getByRole('heading',{name:'等待 BlackHole 认证',exact:true}).waitFor({state:'detached',timeout:10000});
 await page.getByRole('button',{name:/稍后设置/}).click();
 await page.getByRole('heading',{name:'选择连接方式',exact:true}).waitFor({state:'detached'});
 const workspace=page.getByRole('complementary',{name:'导航',exact:true});
 await workspace.waitFor({timeout:10000});
 // The ordinary browser also polls /account from Console. Close it before the
 // outage, otherwise its observer could hide a missing Core-owned renewal loop.
 await ordinary.close();ordinary=undefined;
 const originalDocument=await page.evaluate(()=>performance.timeOrigin);
 let navigations=0;
 const onNavigation=frame=>{if(frame===page.mainFrame())navigations++;};
 page.on('framenavigated',onNavigation);
 t.after(()=>page.off('framenavigated',onNavigation));
 const beforeOutage=await control('state');
 await control('mode','session-unavailable');
 // Use the public native check once to fail verification, then let normal
 // sessions/confirmations polling move this same document back to welcome.
 const outage=await control('check');
 assert.equal(outage.state,'unavailable');
 assert.ok(outage.requests.sessions>beforeOutage.requests.sessions,'outage must execute a real Core session check');
 await page.getByRole('button',{name:'重新验证已保存的账号',exact:true}).waitFor({timeout:15000});
 await workspace.waitFor({state:'detached',timeout:5000});
 const waiting=await control('state');
 assert.equal(waiting.state,'unavailable');
 assert.equal(waiting.opens,beforeOutage.opens);
 assert.equal(waiting.requests.starts,beforeOutage.requests.starts);
 assert.equal(waiting.requests.exchanges,beforeOutage.requests.exchanges);
 // Restore only the synthetic cloud response. No native action, account view,
 // reload, second window or VS Code observer may help the waiting Desktop.
 await control('mode','authorized');
 // Explicit checks can invalidate the snapshot while the old successful
 // observer still has up to 45s left; allow the next 15s tick + UI handoff.
 try { await workspace.waitFor({timeout:65000}); }
 catch(error) {
  console.error(JSON.stringify({recoveryDiagnostic:await control('state'),pageErrors,authRequests:authRequests.slice(-20),authReplies:authReplies.slice(-20),hostOutput,
   page:await page.locator('body').innerText(),navigations,
   auth:await page.evaluate(async()=>{
    const response=await fetch('/web-api/v1/auth/status',{headers:{'x-blackhole-web':'1'}});
    return {status:response.status,body:await response.json()};
   })}));
  throw error;
 }
 const recovered=await control('state');
 assert.equal(recovered.state,'verified');
 assert.ok(recovered.requests.sessions>waiting.requests.sessions,'Core must renew the saved session without a welcome action');
 assert.equal(recovered.opens,beforeOutage.opens,'recovery must not open another authorization page');
 assert.equal(recovered.requests.starts,beforeOutage.requests.starts,'recovery must not start another login');
 assert.equal(recovered.requests.exchanges,beforeOutage.requests.exchanges,'recovery must not replay login exchange');
 assert.equal(navigations,0,'recovery must not navigate or reload the native document');
 assert.equal(await page.evaluate(()=>performance.timeOrigin),originalDocument,'the same native document must recover');
 assert.equal(browser.contexts()[0].pages().length,1,'recovery must not open another native page');
 assert.equal(browser.contexts()[0].pages()[0],page,'recovery must use the existing native window');
 assert.equal((await fetch(base+'/web-api/v1/auth/login',{method:'POST',headers:{'x-blackhole-web':'1',Origin:base}})).status,410);
 console.log(JSON.stringify({native:true,callback:capabilities.welcome,opened:recovered.opens,cancel:true,error:true,verified:true,webPassive:true,outageRecovery:true,sameDocument:true,sessionReads:recovered.requests.sessions}));
});
