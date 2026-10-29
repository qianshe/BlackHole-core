import {parseMembershipCatalogue,type MembershipCatalogue,type MembershipPeriod} from './membership.js';
export type SubscriptionSku='week'|'month'|'quarter'|'year';
export interface SubscriptionStatus {canPurchase:boolean;serviceExpiresAt:number;checkedAt:number}
export interface SubscriptionOrder {id:string;sku:SubscriptionSku;displayName:string;durationPeriod:MembershipPeriod;amountMinor:number;currency:'CNY';status:'payment_pending'|'paid'|'fulfilled'|'expired'|'review'|'refunded';createdAt:number;expiresAt:number;paidAt:number|null;fulfilledAt:number|null;serviceExpiresAt:number|null}
const periods:Record<SubscriptionSku,MembershipPeriod>={week:'WEEK',month:'MONTH',quarter:'QUARTER',year:'YEAR'};
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const bad=():never=>{throw Error('subscription_response_invalid')};
const second=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
function object(value:unknown,keys:string[]):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==keys.sort().join(','))return bad();return value as Record<string,unknown>}
export function parseSubscriptionCatalogue(value:unknown):MembershipCatalogue {const v=parseMembershipCatalogue(value);if(v.productId!=='blackhole-calendar-subscription-v1'||v.plans.some(p=>!Object.hasOwn(periods,p.sku)||periods[p.sku as SubscriptionSku]!==p.durationPeriod||p.amountMinor<1))return bad();return v;}
export function parseSubscriptionStatus(value:unknown):SubscriptionStatus {const v=object(value,['canPurchase','serviceExpiresAt','checkedAt']);if(typeof v.canPurchase!=='boolean'||!second(v.serviceExpiresAt)||!second(v.checkedAt))return bad();return v as unknown as SubscriptionStatus;}
export function parseSubscriptionOrder(value:unknown):SubscriptionOrder {
 const v=object(value,['id','sku','displayName','durationPeriod','amountMinor','currency','status','createdAt','expiresAt','paidAt','fulfilledAt','serviceExpiresAt']);
 if(typeof v.id!=='string'||!uuid.test(v.id)||typeof v.sku!=='string'||!Object.hasOwn(periods,v.sku)||periods[v.sku as SubscriptionSku]!==v.durationPeriod||typeof v.displayName!=='string'||!v.displayName.trim()||v.displayName.length>128||/[\u0000-\u001f\u007f]/.test(v.displayName)||!second(v.amountMinor)||v.amountMinor<1||v.amountMinor>10_000_000_000||v.currency!=='CNY'||!['payment_pending','paid','fulfilled','expired','review','refunded'].includes(String(v.status))||!second(v.createdAt)||!second(v.expiresAt)||v.expiresAt<=v.createdAt)return bad();
 for(const key of ['paidAt','fulfilledAt','serviceExpiresAt'])if(v[key]!==null&&!second(v[key]))return bad();
 if(['paid','fulfilled','review','refunded'].includes(String(v.status))&&!second(v.paidAt))return bad();
 if(['payment_pending','expired'].includes(String(v.status))&&(v.paidAt!==null||v.fulfilledAt!==null||v.serviceExpiresAt!==null))return bad();
 if(v.status==='fulfilled'&&(!second(v.fulfilledAt)||!second(v.serviceExpiresAt)||v.serviceExpiresAt<=v.fulfilledAt))return bad();
 if(v.status==='paid'&&(v.fulfilledAt!==null||v.serviceExpiresAt!==null))return bad();
 return v as unknown as SubscriptionOrder;
}
export function parseSubscriptionOrders(value:unknown):SubscriptionOrder[]{const v=object(value,['orders']);if(!Array.isArray(v.orders)||v.orders.length>20)return bad();const orders=v.orders.map(parseSubscriptionOrder);if(new Set(orders.map(o=>o.id)).size!==orders.length)return bad();return orders;}
