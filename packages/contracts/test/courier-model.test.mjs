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
