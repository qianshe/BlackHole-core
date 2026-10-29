import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { cleanModelAttribution, courierModelLabel } from '../dist/courier-model.js';
test('legacy Arena identity is invalidated, estimates never become verified',()=>{
 assert.equal(cleanModelAttribution(undefined,'arena','wrong-model').status,'unknown');
 assert.equal(cleanModelAttribution({status:'verified',label:'wrong-model',source:'page-label'},'arena').status,'unknown');
 const a=cleanModelAttribution({status:'estimated',label:'candidate',level:'family',score:.8,source:'reply-classifier'},'arena');
 assert.equal(a.status,'estimated');assert.match(courierModelLabel({site:'arena',modelAttribution:a}),/推测系列.*candidate.*判别分数 80%/);
});
test('explicit null and unknown clear old labels instead of falling back',()=>{
 for(const raw of [null,{status:'unknown'}]){
  const a=cleanModelAttribution(raw,'chatgpt','stale');assert.equal(a.label,null);
  assert.equal(courierModelLabel({site:'chatgpt',model:'stale',modelAttribution:a}),'型号未知');
 }
 assert.equal(courierModelLabel({site:'arena',model:'wrong-history'}),'型号未知');
});
test('ChatGPT page evidence is labelled as page evidence, not inference',()=>{
 const a=cleanModelAttribution(undefined,'chatgpt','gpt-page');
 assert.equal(a.status,'verified');assert.equal(courierModelLabel({site:'chatgpt',modelAttribution:a}),'页面标注：gpt-page');
});
test('invalid score and empty classifier label are unknown',()=>{
 for(const score of [-1,2,NaN,Infinity,'0.8'])assert.equal(cleanModelAttribution({status:'estimated',label:'x',level:'model',source:'reply-classifier',score},'arena').status,'unknown');
});
test('shared formatter runs serialized in VS Code without module dependencies',()=>{
 const f=vm.runInNewContext('('+courierModelLabel.toString()+')');
 assert.equal(f({site:'arena',model:'old'}),'型号未知');
});

test('ledger price estimate: a same-price group without a score, only for Arena, never verified',()=>{
 const raw={status:'estimated',label:'GPT 6 Sol / Claude Sonnet 5.5',level:'model',score:null,source:'ledger-price',candidates:['GPT 6 Sol','Claude Sonnet 5.5'],changedFrom:null};
 const a=cleanModelAttribution(raw,'arena');
 assert.deepEqual(a,{status:'estimated',label:'GPT 6 Sol / Claude Sonnet 5.5',level:'model',score:null,source:'ledger-price',candidates:['GPT 6 Sol','Claude Sonnet 5.5'],changedFrom:null});
 assert.equal(courierModelLabel({site:'arena',modelAttribution:a}),'按价格：GPT 6 Sol / Claude Sonnet 5.5（同价，分不开）');
 assert.equal(cleanModelAttribution(raw,'chatgpt').status,'unknown','ChatGPT has page evidence, not a ledger');
 assert.equal(cleanModelAttribution({...raw,status:'verified'},'arena').status,'unknown','a price is never verified');
 assert.equal(cleanModelAttribution({...raw,score:.9},'arena').status,'unknown','a price has no score');
 assert.equal(cleanModelAttribution({...raw,label:'  '},'arena').status,'unknown');
 assert.equal(cleanModelAttribution({...raw,level:'galaxy'},'arena').status,'unknown');
});
test('ledger price: one candidate reads plain; a switch is a warning that names both sides',()=>{
 const one=cleanModelAttribution({status:'estimated',label:'GPT 6 Luna',level:'model',score:null,source:'ledger-price',candidates:['GPT 6 Luna']},'arena');
 assert.equal(courierModelLabel({site:'arena',modelAttribution:one}),'按价格：GPT 6 Luna');
 assert.equal(one.changedFrom,null);
 const sw=cleanModelAttribution({status:'estimated',label:'Claude Opus 5.5',level:'model',score:null,source:'ledger-price',candidates:['Claude Opus 5.5'],changedFrom:['GPT 6 Luna']},'arena');
 assert.equal(courierModelLabel({site:'arena',modelAttribution:sw}),'⚠ 价格变化：GPT 6 Luna → Claude Opus 5.5');
 const many=cleanModelAttribution({status:'estimated',label:'a',level:'model',score:null,source:'ledger-price',candidates:['a','b','c','d','e'],changedFrom:['x','y','z','w']},'arena');
 assert.equal(courierModelLabel({site:'arena',modelAttribution:many}),'⚠ 价格变化：x / y / z 等 4 个 → a / b / c 等 5 个（同价，分不开）');
});
test('ledger price lists are bounded and cleaned; a missing candidate list falls back to the label',()=>{
 const raw={status:'estimated',label:'m',level:'model',source:'ledger-price',candidates:[' a ',3,'',...Array.from({length:20},(_,i)=>'n'+i)],changedFrom:'not a list'};
 const a=cleanModelAttribution(raw,'arena');
 assert.equal(a.candidates.length,8);assert.equal(a.candidates[0],'a');assert.equal(a.changedFrom,null);
 assert.deepEqual(cleanModelAttribution({status:'estimated',label:'m',level:'model',source:'ledger-price'},'arena').candidates,['m']);
 assert.equal(cleanModelAttribution({...raw,candidates:['x'.repeat(200)]},'arena').candidates[0].length,80);
});
test('the classifier and page-label shapes are unchanged: no ledger-price fields leak into them',()=>{
 const c=cleanModelAttribution({status:'estimated',label:'candidate',level:'model',score:.5,source:'reply-classifier',candidates:['x'],changedFrom:['y']},'arena');
 assert.deepEqual(c,{status:'estimated',label:'candidate',level:'model',score:.5,source:'reply-classifier'});
 assert.deepEqual(cleanModelAttribution(undefined,'chatgpt','gpt-page'),{status:'verified',label:'gpt-page',level:'model',score:null,source:'page-label'});
});
test('a group that hit the list cap says so instead of undercounting',()=>{
 const a=cleanModelAttribution({status:'estimated',label:'m0 / m1 / m2 等 12 个',level:'model',score:null,source:'ledger-price',candidates:Array.from({length:12},(_,i)=>'m'+i)},'arena');
 assert.equal(a.candidates.length,8);
 assert.equal(courierModelLabel({site:'arena',modelAttribution:a}),'按价格：m0 / m1 / m2 等 8+ 个（同价，分不开）');
});
test('the serialized formatter handles the ledger price shapes too',()=>{
 const f=vm.runInNewContext('('+courierModelLabel.toString()+')');
 assert.equal(f({site:'arena',modelAttribution:{status:'estimated',label:'GPT 6 Luna',level:'model',score:null,source:'ledger-price',candidates:['GPT 6 Luna'],changedFrom:null}}),'按价格：GPT 6 Luna');
 assert.equal(f({site:'arena',modelAttribution:{status:'estimated',label:'B',level:'model',score:null,source:'ledger-price',candidates:['B'],changedFrom:['A']}}),'⚠ 价格变化：A → B');
});
