// Isolated browser test of the real built React workbench, not the standalone HTML mockup.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'packages/web/dist');
const browserPath = [chromium.executablePath(), 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);

test('production workbench: sizing, composer, inspector file tabs and responsive shell', { timeout: 120_000 }, async (t) => {
  const server = http.createServer((req, res) => {
    let url = new URL(req.url || '/ui/', 'http://localhost');
    let file = path.resolve(dist, decodeURIComponent(url.pathname.replace(/^\/ui\/?/, '')) || 'index.html');
    if (!file.startsWith(dist + path.sep)) { res.writeHead(403).end(); return; }
    if (url.pathname === '/ui/' || url.pathname === '/ui') file = path.join(dist, 'index.html');
    try {
      const bytes = fs.readFileSync(file);
      res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' }).end(bytes);
    } catch { res.writeHead(404).end('not found'); }
  }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const port = server.address().port;
  t.after(() => server.close());
  const browser = await chromium.launch({ headless:true, ...(browserPath?{executablePath:browserPath}:{}) });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport:{width:1400,height:850}, colorScheme:'dark' });
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const session={id:'session-ui-test',name:'重构导出逻辑',workspace_path:'C:\\demo\\project',status:'active',activity:'running',permission_mode:'workspace-write',auto_approve:false,created_at:'2026-10-26T08:00:00.000Z',last_active_at:'2026-10-26T08:10:00.000Z',calls_total:0,todos_total:1,todos_done:0};
  await page.route('**/web-api/v1/**', async route=>{
    const url=new URL(route.request().url()), p=url.pathname.replace('/web-api/v1','');
    let response={};
    if(p==='/auth/session') response={authenticated:true,version:'0.4.26',account_required:false,expires_at:'2099-01-01'};
    else if(p==='/sessions')response={sessions:[session],version:'0.4.26'};
    else if(p==='/projects')response={projects:[]};
    else if(p==='/confirmations')response={confirmations:[{id:'approval-ui',session_id:session.id,tool:'editor',args:{path:'src/index.ts'},status:'pending',scope:null,command:'Create src/index.ts',categories:['write'],risk_matches:[],created_at:null,expires_at:null}]};
    else if(p==='/settings')response={values:{channelMode:'cloudflare',webAgents:[],customWebAgents:[],courierSites:[]},revision:1};
    else if(p==='/account')response={display_name:'Test User',status:'active'};
    else if(p==='/auth/setup')response={configuration:'present'};
    else if(p==='/auth/status')response={state:'verified'};
    else if(p==='/settings/channel' || p==='/channel')response={on:false,state:'off',running:[],next:'quick',last:null,missing:null,reason:null};
    else if(p==='/sessions/session-ui-test/todos')response={items:[{content:'等待任务',status:'pending'}],contract:{goal:'测试工作区'},updated_at:null};
    else if(p==='/sessions/session-ui-test/current-turn-diff')response={files:[],pending:0,uncertain:0,incomplete:false,turnAt:null};
    else if(p==='/sessions/session-ui-test/workspace/entries')response={path:url.searchParams.get('path')||'',entries:url.searchParams.get('path')?[{name:'index.ts',path:'src/index.ts',type:'file'}]:[{name:'src',path:'src',type:'dir'}],truncated:false};
    else if(p==='/sessions/session-ui-test/workspace/file')response={path:url.searchParams.get('path'),content:'export const value = 1;\n'};
    else if(p.includes('/feed') || p.includes('/history'))response={entries:[],calls:[],messages:[],hasOlder:false,more:false,total:0,link:'direct',state:{link:'direct'}};
    else if(p==='/sessions/session-ui-test')response=session;
    await route.fulfill({status:200,json:response});
  });
  await page.goto('http://127.0.0.1:'+port+'/ui/');
  await page.getByRole('button',{name:/重构导出逻辑/}).first().click();
  const main=page.getByRole('main');
  await page.getByRole('heading',{name:'重构导出逻辑'}).waitFor({timeout:15000});
  const pane=page.getByRole('complementary',{name:'会话详情'});
  const metrics=await page.evaluate(()=>{
    const q=s=>document.querySelector(s),r=e=>e.getBoundingClientRect();
    const sidebar=q('aside[aria-label="导航"]'),inspector=q('aside[aria-label="会话详情"]');
    const feed=q('section[aria-label="调用记录"]'),composer=q('section[aria-label="网页会话"]');
    const header=q('h1'),leftGap=r(feed).left-r(sidebar).right;
    return {sidebar:r(sidebar).width,inspector:r(inspector).width,feed:r(feed).width,
      mainTitle:r(header).height, composer:!!composer,composerVisible:r(composer).width>200,
      gutter:leftGap, panelRadius:getComputedStyle(sidebar).borderRadius,
      copyConnection:!![...document.querySelectorAll('button')].find(b=>b.textContent.includes('复制连接')),
      sash:[...document.querySelectorAll('[role=separator]')].map(e=>({width:r(e).width,line:getComputedStyle(e,'::after').width})),
      overflow:document.documentElement.scrollWidth>innerWidth };
  });
  assert.equal(metrics.composer,true);
  assert.equal(metrics.composerVisible,true);
  assert.equal(metrics.copyConnection,false);
  assert.equal(metrics.panelRadius,'6px');
  assert.ok(metrics.sash.every(x=>x.line==='1px'),JSON.stringify(metrics));
  assert.equal(metrics.overflow,false);
  assert.ok(metrics.feed>=360,JSON.stringify(metrics));

  const navSplitter=page.getByRole('separator',{name:'调整导航栏宽度'});
  await navSplitter.hover();
  assert.equal(await navSplitter.evaluate(e=>getComputedStyle(e,'::after').width),'1px');
  const before=await navSplitter.getAttribute('aria-valuenow');
  await navSplitter.focus();
  await page.keyboard.press('Shift+ArrowRight');
  assert.ok(Number(await navSplitter.getAttribute('aria-valuenow'))>Number(before),'sidebar should resize with keyboard');
  // Real pointer drag must move the layout, not just the aria label.
  const startBox = await navSplitter.boundingBox();
  assert.ok(startBox);
  await page.mouse.move(startBox.x + startBox.width / 2, startBox.y + 50);
  await page.mouse.down();
  await page.mouse.move(startBox.x + startBox.width / 2 + 90, startBox.y + 50, { steps: 6 });
  await page.mouse.up();
  const pointerWidth=Number(await navSplitter.getAttribute('aria-valuenow'));
  assert.ok(pointerWidth>Number(before)+65,'sidebar mouse drag should increase width');
  // Persist the preference without changing the original navigation component.
  assert.ok(Number(await page.evaluate(()=>localStorage.getItem('bh.web.sidebarWidth')))>Number(before));
  await navSplitter.dblclick();

  assert.equal(await page.getByText('等待审批').first().isVisible(),true,'approval shown in overview');
  await page.getByRole('tab',{name:'工作区文件'}).click();
  assert.equal(await page.getByText('等待审批').first().isVisible(),false,'approval hidden outside overview');
  await page.getByRole('button',{name:'src',exact:true}).click();
  await page.getByRole('button',{name:'index.ts'}).click();
  await page.getByRole('tab',{name:'src/index.ts'}).waitFor();
  await page.getByText('export const value = 1;').waitFor();
  await page.getByRole('button',{name:'关闭 src/index.ts'}).click();
  await page.getByRole('tab',{name:'工作区文件'}).click();

  for (const width of [980,620,380]) {
    await page.setViewportSize({width,height:750});
    await page.waitForTimeout(120);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'no page-wide overflow at '+width);
  }
  await page.setViewportSize({width:1400,height:850});
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.deepEqual(errors,[]);
  console.log('Production workbench geometry:',metrics);
});
