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
