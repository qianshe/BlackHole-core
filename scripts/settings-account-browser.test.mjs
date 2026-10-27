// Regression coverage uses real shared renderers and synthetic services only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {chromium} from 'playwright';
const root=fileURLToPath(new URL('../',import.meta.url));
const fixtures=path.join(root,'.tmp/shared-settings-preview');
const executablePath=[chromium.executablePath(),'C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(p=>fs.existsSync(p));
test('account layouts, purchase guards and confirmation focus in both production renderers',{timeout:90000},async t=>{
 const browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{})});
 try{
  for(const host of ['web','native'])for(const width of [1280,390,320])await t.test(`${host} ${width}px`,async()=>{
   const context=await browser.newContext({viewport:{width,height:900},colorScheme:'dark'});
   try{
    const page=await context.newPage(),errors=[],requests=[];
    page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(!r.url().startsWith('file:'))requests.push(r.url())});
    await page.goto(pathToFileURL(path.join(fixtures,host+'.html')).href);
    await page.locator('#phonePair').waitFor({state:'visible'});
    await page.evaluate(()=>window.__model.setMembershipScenario('purchase'));
    await page.locator('[data-settings-target="account"]').evaluate(el=>el.click());
    const radios=page.locator('#cloudPlan input[type=radio]');await radios.nth(3).waitFor();
    await page.waitForFunction(()=>document.querySelector('#cloudPlan')?.disabled===false);
    const geometry=await page.evaluate(()=>{
     const card=document.querySelector('.account-card'),plans=document.querySelector('#cloudPlan');
     const r=plans.getBoundingClientRect();
     return {horizontalOverflow:document.documentElement.scrollWidth>innerWidth+1,plansFit:[...plans.querySelectorAll('label')].every(el=>{const q=el.getBoundingClientRect();return q.left>=r.left-1&&q.right<=r.right+1&&q.top>=r.top-1&&q.bottom<=r.bottom+1}),emailOwnRow:document.querySelector('.account-email').getBoundingClientRect().top>=document.querySelector('.account-identity').getBoundingClientRect().bottom-1,minFont:Math.min(...[...card.querySelectorAll('*')].filter(el=>el.textContent.trim()).map(el=>parseFloat(getComputedStyle(el).fontSize)))};
    });
    assert.equal(geometry.horizontalOverflow,false);assert.equal(geometry.plansFit,true,'all plans must fit their container');assert.equal(geometry.emailOwnRow,true);assert.ok(geometry.minFont>=12);
    assert.equal(await page.locator('#cloudBuyCard').isDisabled(),true,'no implicit plan selection');
    await radios.nth(0).focus();await page.keyboard.press('Space');await page.keyboard.press('ArrowRight');
    assert.equal(await radios.nth(1).isChecked(),true,'native radio keyboard navigation');
    assert.equal(await page.locator('#cloudBuyCard').isEnabled(),true);
    await page.screenshot({path:path.join(fixtures,`account-${host}-${width}.png`)});
    await page.locator('#cloudBuyCard').click();await page.locator('.membership-confirm').waitFor();
    assert.match(await page.locator('.membership-confirm').innerText(),/一个月/);
    assert.deepEqual(await page.evaluate(()=>window.__model.calls),[],'selecting/opening confirmation must not create checkout');
    const focusContained=await page.evaluate(()=>document.querySelector('.membership-confirm').contains(document.activeElement));assert.equal(focusContained,true);
    await page.keyboard.press('Escape');await page.locator('.membership-confirm').waitFor({state:'detached'});
    assert.equal(await page.locator('dialog[open]').count(),1,'Esc must keep settings open');assert.equal(await page.evaluate(()=>document.activeElement.id),'cloudBuyCard');
    await page.evaluate(()=>window.__model.setMembershipScenario('active'));await page.getByRole('button',{name:'刷新订阅',exact:true}).click();
    await page.getByText('现有权益尚未到期，无需重复购买。',{exact:true}).waitFor();assert.equal(await page.locator('#cloudBuyCard').isDisabled(),true);
    await page.evaluate(()=>window.__model.setMembershipScenario('closed'));await page.getByRole('button',{name:'刷新订阅',exact:true}).click();
    await page.getByText('暂未开放购买，仍可查看套餐价格。',{exact:true}).waitFor();assert.equal(await page.locator('#cloudBuyCard').isDisabled(),true);
    await page.evaluate(()=>window.__model.setMembershipScenario('error'));await page.getByRole('button',{name:'刷新订阅',exact:true}).click();
    await page.getByText('套餐或权益读取失败，请刷新后重试。',{exact:true}).waitFor();assert.equal(await page.locator('#cloudBuyCard').isDisabled(),true);
    await page.evaluate(()=>window.__model.setMembershipScenario('loading'));await page.getByRole('button',{name:'刷新订阅',exact:true}).click();
    assert.equal(await page.getByRole('button',{name:'刷新中…',exact:true}).isDisabled(),true);assert.equal(await page.locator('#cloudBuyCard').isDisabled(),true);
    await page.getByRole('button',{name:'刷新订阅',exact:true}).waitFor();
    await page.evaluate(()=>window.__model.setAccountView({state:'verified',userId:'fixture-user',account:{name:'A very long account display name that must wrap safely',email:'a-very-long-email-address-for-narrow-layout@example.invalid',status:'active'},remainingSeconds:0}));
    await page.getByRole('button',{name:'刷新订阅',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.account-email')?.textContent.includes('a-very-long'));
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'long identity must not cause horizontal overflow');
    await page.getByRole('button',{name:'刷新订阅',exact:true}).waitFor();
    await page.waitForFunction(()=>document.querySelector('.account-entitlement button')?.disabled===false);
    await page.evaluate(()=>window.__model.setAccountView({state:'logged_out'}));
    await page.getByRole('button',{name:'刷新订阅',exact:true}).click();
    await page.getByText('登录后查看套餐与价格。',{exact:true}).waitFor();
    assert.equal(await page.locator('#cloudBuyCard').isDisabled(),true);
    assert.equal(await page.locator('.account-plan').count(),0,'sign-out must clear the previous account catalogue');
    assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);assert.deepEqual(await page.evaluate(()=>window.__model.blocked),[]);
   }finally{await context.close()}
  });
 }finally{await browser.close()}
});
