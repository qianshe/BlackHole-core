import {test} from 'node:test';import assert from 'node:assert/strict';
import {parseSubscriptionCatalogue,parseSubscriptionStatus,parseSubscriptionOrder,parseSubscriptionOrders} from '../dist/subscriptions.js';
import {validSettingsRequest} from '../dist/settings-host.js';
const now=1790000000,id='12345678-1234-4234-8234-123456789012';
const order={id,sku:'month',displayName:'一个月',durationPeriod:'MONTH',amountMinor:1500,currency:'CNY',status:'payment_pending',createdAt:now,expiresAt:now+900,paidAt:null,fulfilledAt:null,serviceExpiresAt:null};
test('a current subscription does not prohibit an independently authorized renewal',()=>{const state={canPurchase:true,serviceExpiresAt:now+86400,checkedAt:now};assert.deepEqual(parseSubscriptionStatus(state),state);assert.throws(()=>parseSubscriptionStatus({...state,paid:true}));assert.throws(()=>parseSubscriptionStatus({...state,serviceExpiresAt:'tomorrow'}));});
test('calendar catalogue accepts the server price, checks period/SKU identity and never substitutes old duration products',()=>{
 const v={productId:'blackhole-calendar-subscription-v1',productName:'BlackHole',enabled:true,salesEnabled:true,capabilityStatus:'ENABLED',checkedAt:now,plans:[{sku:'month',displayName:'一个月',durationPeriod:'MONTH',amountMinor:1500,currency:'CNY'}]};
 assert.deepEqual(parseSubscriptionCatalogue(v),v);assert.throws(()=>parseSubscriptionCatalogue({...v,productId:'DIRECT_previous'}));assert.throws(()=>parseSubscriptionCatalogue({...v,plans:[{...v.plans[0],durationPeriod:'YEAR'}]}));
});
test('unpaid and fulfilled orders remain distinct; only confirmed fulfillment has an expiry',()=>{
 assert.deepEqual(parseSubscriptionOrder(order),order);const paid={...order,status:'paid',paidAt:now+20};assert.deepEqual(parseSubscriptionOrder(paid),paid);
 assert.throws(()=>parseSubscriptionOrder({...paid,status:'fulfilled'}));assert.throws(()=>parseSubscriptionOrder({...order,serviceExpiresAt:now+86400}));
 const complete={...paid,status:'fulfilled',fulfilledAt:now+21,serviceExpiresAt:now+86400};assert.deepEqual(parseSubscriptionOrder(complete),complete);assert.throws(()=>parseSubscriptionOrders({orders:[complete,complete]}));
});
test('settings bridge exposes named subscription routes without arbitrary financial callbacks',()=>{
 for(const [method,path]of [['GET','/account/subscriptions'],['GET','/account/subscriptions/status'],['GET','/account/subscriptions/orders'],['POST','/account/subscriptions/orders'],['POST',`/account/subscriptions/orders/${id}/checkout`],['POST',`/account/subscriptions/orders/${id}/reconcile`]])assert.equal(validSettingsRequest({id:'s',method,path,...(method==='POST'?{body:{}}:{})}),true);
 for(const path of ['/account/subscriptions/notify','/account/subscriptions/orders?userId=other','/account/subscriptions/orders/../checkout','/account/subscriptions/orders/invalid/reconcile'])assert.equal(validSettingsRequest({id:'s',method:'POST',path,body:{}}),false);
});
