import test from 'node:test';
import assert from 'node:assert/strict';
import { CourierHub } from '../dist/courier/hub.js';
import { CourierPairs } from '../dist/courier/pairs.js';
import { courierModelLabel } from '../packages/contracts/dist/courier-model.js';

test('target snapshots replace old Arena identity with estimate then explicit unknown', async t => {
 const hub=new CourierHub({sessions:()=>[{id:'s',name:'test',status:'active'}],pairs:new CourierPairs(null)});
 t.after(()=>hub.close());
 let deliver;
 hub.attach({on:(ev,fn)=>{if(ev==='message')deliver=fn},send:()=>true,close:()=>{}});
 const send=m=>deliver(JSON.stringify(m));
 send({type:'hello',client:'blackhole-courier',protocol:1,version:'test'});
 const target={targetId:'t',site:'arena',label:'test',conversationKey:'c',sessionId:'s',open:true,busy:false,model:'wrong-old'};
 const publish=extra=>send({type:'targets',targets:[{...target,...extra}]});
 const current=async()=>(await hub.status(false)).targets[0];
 publish({});assert.equal((await current()).model,null);assert.equal(courierModelLabel(await current()),'型号未知');
 publish({modelAttribution:{status:'estimated',label:'candidate',level:'model',score:.81,source:'reply-classifier'}});
 assert.equal((await current()).model,null);assert.match(courierModelLabel(await current()),/推测型号：candidate/);
 publish({modelAttribution:null});assert.equal((await current()).model,null);assert.equal(courierModelLabel(await current()),'型号未知');
 publish({modelAttribution:{status:'verified',label:'spoofed',source:'page-label'}});
 assert.equal((await current()).modelAttribution.status,'unknown');
});


test('target snapshots carry the Courier ledger price check as a price group, and refuse a scored one', async t => {
 const hub=new CourierHub({sessions:()=>[{id:'s',name:'test',status:'active'}],pairs:new CourierPairs(null)});
 t.after(()=>hub.close());
 let deliver;
 hub.attach({on:(ev,fn)=>{if(ev==='message')deliver=fn},send:()=>true,close:()=>{}});
 const send=m=>deliver(JSON.stringify(m));
 send({type:'hello',client:'blackhole-courier',protocol:1,version:'test'});
 const target={targetId:'t',site:'arena',label:'test',conversationKey:'c',sessionId:'s',open:true,busy:false,model:'wrong-old'};
 const publish=extra=>send({type:'targets',targets:[{...target,...extra}]});
 const current=async()=>(await hub.status(false)).targets[0];
 publish({modelAttribution:{status:'estimated',label:'GPT 6 Sol / Claude Sonnet 5.5',level:'model',score:null,source:'ledger-price',candidates:['GPT 6 Sol','Claude Sonnet 5.5'],changedFrom:null}});
 const a=(await current()).modelAttribution;
 assert.equal(a.source,'ledger-price');assert.deepEqual(a.candidates,['GPT 6 Sol','Claude Sonnet 5.5']);
 assert.equal((await current()).model,null,'a price group is never written into the verified model');
 assert.equal(courierModelLabel(await current()),'按价格：GPT 6 Sol / Claude Sonnet 5.5（同价，分不开）');
 publish({modelAttribution:{status:'estimated',label:'B',level:'model',score:null,source:'ledger-price',candidates:['B'],changedFrom:['A']}});
 assert.equal(courierModelLabel(await current()),'⚠ 价格变化：A → B');
 publish({modelAttribution:{status:'estimated',label:'x',level:'model',score:.5,source:'ledger-price'}});
 assert.equal((await current()).modelAttribution.status,'unknown','a price estimate never carries a score');
 publish({});
 assert.equal(courierModelLabel(await current()),'型号未知','the next turn clears it again');
});
