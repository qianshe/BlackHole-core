import { createHash, randomBytes } from 'node:crypto';
import { PRODUCTION_CLOUD_ORIGIN, cloudAuthPrefix, validateCloudOrigin } from './cloud-origin.js';
export const CLOUD_AUTH_ORIGIN=PRODUCTION_CLOUD_ORIGIN;
export const AUTH_PREFIX=cloudAuthPrefix(CLOUD_AUTH_ORIGIN);
const base='/api/auth/plugin';
export function retryDelay(value:string|null,now:number):number {
 const seconds=value&&/^\d+$/.test(value)?Number(value):NaN;
 const date=value?Date.parse(value):NaN;
 const ms=Number.isFinite(seconds)?seconds*1000:Number.isFinite(date)?date-now:60000;
 return Math.max(1000,Math.min(600000,Number.isFinite(ms)?ms:60000));
}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const id=/^[A-Za-z0-9_-]{1,128}$/;
export interface Credential {token:string;userId:string;clientId:string;sessionId:string;expiresAt:number;loginOrder:number}
export interface Receipt {version:1;origin:string;loginOrder:number;sessionId:string;kind:'login'|'logout'}
export interface SecretPort {get(key:string):PromiseLike<string|undefined>;store(key:string,value:string):PromiseLike<void>;delete(key:string):PromiseLike<void>}
export interface ReceiptPort {list():Promise<Receipt[]>;put(value:Receipt):Promise<void>;remove(value:Receipt):Promise<void>}
export interface AccountSnapshot {name:string;email:string;status:'active'|'suspended'|'pending';serviceExpiresAt:number;serverNow:number;salesEnabled:false;plans:[]}
export interface AuthView {state:'logged_out'|'saved'|'verified'|'unavailable';userId?:string;expiresAt?:number;account?:AccountSnapshot;checkedAt?:number;remainingSeconds?:number}
function accountSnapshot(input:unknown):AccountSnapshot|undefined {
 if(input===undefined)return undefined; // Older staging versions do not expose subscription facts.
 if(!input||typeof input!=='object')throw new CloudAuthError('invalid_response');const a=input as AccountSnapshot;
 if(typeof a.name!=='string'||a.name.length>256||typeof a.email!=='string'||a.email.length>320||!['active','suspended','pending'].includes(a.status)
  ||!Number.isSafeInteger(a.serviceExpiresAt)||a.serviceExpiresAt<0||!Number.isSafeInteger(a.serverNow)||a.serverNow<=0
  ||a.salesEnabled!==false||!Array.isArray(a.plans)||a.plans.length!==0)throw new CloudAuthError('invalid_response');
 return {name:a.name,email:a.email,status:a.status,serviceExpiresAt:a.serviceExpiresAt,serverNow:a.serverNow,salesEnabled:false,plans:[]};
}
export type AuthErrorCode='account_mismatch'|'cancelled'|'busy'|'not_available'|'rate_limited'|'rejected'|'network'|'invalid_response'|'storage'|'browser_failed'|'expired'|'card_unavailable'|'card_result_unknown'|'payment_not_available'|'payment_result_unknown'|'payment_card_unavailable'|'payment_review_required'|'refund_not_available'|'refund_not_eligible'|'refund_result_unknown'|'refund_quote_changed';
export interface CardRedemption {cardId:string;userId:string;grantId:string;expiresAt:number;duplicate:boolean}
export type BillingSku='pro_day'|'pro_week'|'pro_month';
export type BillingOrderStatus='payment_pending'|'paid'|'fulfilled'|'expired'|'review'|'refunded';
export interface BillingPlan {sku:BillingSku;amountMinor:number;currency:'CNY';durationSeconds:number}
export interface BillingOrder {id:string;sku:BillingSku;amountMinor:number;currency:'CNY';durationSeconds:number;status:BillingOrderStatus;provider:'alipay';environment:'sandbox'|'production';noAutoRenew:true;createdAt:number;expiresAt:number;paidAt:number|null;fulfilledAt:number|null}
export type BillingRefundStatus='requested'|'provider_succeeded'|'refunded'|'provider_failed'|'failed';
export interface BillingRefundQuote {orderId:string;amountMinor:number;currency:'CNY';unusedSeconds:number;refundableSeconds:number;quoteMode:'remaining_prorata';generatedAt:number;existingStatus:BillingRefundStatus|null;quoteToken:string}
export interface BillingRefund {refundId:string;orderId:string;amountMinor:number;currency:'CNY';status:BillingRefundStatus;requestedAt:number;providerConfirmedAt:number|null;finalizedAt:number|null;duplicate:boolean}
export class CloudAuthError extends Error {readonly code:AuthErrorCode;constructor(code:AuthErrorCode){super(code);this.code=code;}}
export function validReceipt(value:unknown,origin=CLOUD_AUTH_ORIGIN):value is Receipt {
 if(!value||typeof value!=='object')return false;const r=value as Receipt;
 return r.version===1&&r.origin===origin&&typeof r.sessionId==='string'&&r.sessionId.trim()===r.sessionId&&uuid.test(r.sessionId)&&Number.isSafeInteger(r.loginOrder)&&r.loginOrder>0&&['login','logout'].includes(r.kind);
}
export function receiptName(value:Receipt,origin=CLOUD_AUTH_ORIGIN) {if(!validReceipt(value,origin))throw new CloudAuthError('storage');return String(value.loginOrder).padStart(16,'0')+'_'+value.sessionId+'_'+value.kind+'.json';}
/** Validates a stored/migrated credential record (also used by the daemon's one-time migration). */
export function parseCredential(value:unknown):Credential {return credential(value);}
export function credentialKey(sessionId:string,origin=CLOUD_AUTH_ORIGIN) {if(!uuid.test(sessionId))throw new CloudAuthError('storage');return cloudAuthPrefix(origin)+'.session.'+sessionId;}
function credential(value:unknown):Credential {
 if(!value||typeof value!=='object')throw new CloudAuthError('invalid_response');const v=value as Credential;
 if([v.token,v.userId,v.clientId,v.sessionId].some(s=>typeof s!=='string'||s.trim()!==s))throw new CloudAuthError('invalid_response');
 if(typeof v.token!=='string'||!/^bhp_[A-Za-z0-9_-]{43}$/.test(v.token)||typeof v.userId!=='string'||!id.test(v.userId)
  ||typeof v.clientId!=='string'||!/^[A-Za-z0-9_-]{16,128}$/.test(v.clientId)||!uuid.test(v.sessionId)
  ||!Number.isSafeInteger(v.expiresAt)||v.expiresAt<=0||!Number.isSafeInteger(v.loginOrder)||v.loginOrder<1)throw new CloudAuthError('invalid_response');
 // Never preserve arbitrary server keys (roles, nested payloads, etc.) in secret storage.
 return {token:v.token,userId:v.userId,clientId:v.clientId,sessionId:v.sessionId,expiresAt:v.expiresAt,loginOrder:v.loginOrder};
}
const billingSkus:readonly BillingSku[]=['pro_day','pro_week','pro_month'];
const billingStatuses:readonly BillingOrderStatus[]=['payment_pending','paid','fulfilled','expired','review','refunded'];
function exactObject(value:unknown,required:string[],optional:string[]=[]):Record<string,unknown> {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new CloudAuthError('invalid_response');
 const row=value as Record<string,unknown>,keys=Object.keys(row);
 if(required.some(key=>!Object.hasOwn(row,key))||keys.some(key=>!required.includes(key)&&!optional.includes(key)))throw new CloudAuthError('invalid_response');
 return row;
}
function billingPlan(value:unknown):BillingPlan {
 const row=exactObject(value,['sku','amountMinor','currency','durationSeconds']);
 if(!billingSkus.includes(row.sku as BillingSku)||row.currency!=='CNY'||!Number.isSafeInteger(row.amountMinor)||Number(row.amountMinor)<1
  ||!Number.isSafeInteger(row.durationSeconds)||Number(row.durationSeconds)<1)throw new CloudAuthError('invalid_response');
 return {sku:row.sku as BillingSku,amountMinor:Number(row.amountMinor),currency:'CNY',durationSeconds:Number(row.durationSeconds)};
}
function nullableSecond(value:unknown):number|null {
 if(value===null)return null;if(!Number.isSafeInteger(value)||Number(value)<0)throw new CloudAuthError('invalid_response');return Number(value);
}
function billingOrder(value:unknown):BillingOrder {
 const row=exactObject(value,['id','sku','amountMinor','currency','durationSeconds','status','provider','environment','noAutoRenew','createdAt','expiresAt','paidAt','fulfilledAt']);
 const paidAt=nullableSecond(row.paidAt),fulfilledAt=nullableSecond(row.fulfilledAt);
 if(typeof row.id!=='string'||!uuid.test(row.id)||!billingSkus.includes(row.sku as BillingSku)||!billingStatuses.includes(row.status as BillingOrderStatus)
  ||row.currency!=='CNY'||row.provider!=='alipay'||!['sandbox','production'].includes(String(row.environment))||row.noAutoRenew!==true
  ||!Number.isSafeInteger(row.amountMinor)||Number(row.amountMinor)<1||!Number.isSafeInteger(row.durationSeconds)||Number(row.durationSeconds)<1
  ||!Number.isSafeInteger(row.createdAt)||Number(row.createdAt)<0||!Number.isSafeInteger(row.expiresAt)||Number(row.expiresAt)<=Number(row.createdAt)
  ||(row.status==='payment_pending'&&(paidAt!==null||fulfilledAt!==null))||(row.status==='paid'&&(paidAt===null||fulfilledAt!==null))
  ||(row.status==='fulfilled'&&(paidAt===null||fulfilledAt===null))||(row.status==='review'&&paidAt===null))throw new CloudAuthError('invalid_response');
 return {id:row.id,sku:row.sku as BillingSku,amountMinor:Number(row.amountMinor),currency:'CNY',durationSeconds:Number(row.durationSeconds),
  status:row.status as BillingOrderStatus,provider:'alipay',environment:row.environment as 'sandbox'|'production',noAutoRenew:true,
  createdAt:Number(row.createdAt),expiresAt:Number(row.expiresAt),paidAt,fulfilledAt};
}
const refundStatuses:readonly BillingRefundStatus[]=['requested','provider_succeeded','refunded','provider_failed','failed'];
function billingRefundQuote(value:unknown):BillingRefundQuote {
 const row=exactObject(value,['orderId','amountMinor','currency','unusedSeconds','refundableSeconds','quoteMode','generatedAt','existingStatus','quoteToken']);
 if(typeof row.quoteToken!=='string'||!/^[0-9]{1,16}\.[0-9]{1,16}\.[0-9]{1,16}\.[A-Za-z0-9_-]{43}$/.test(row.quoteToken)||typeof row.orderId!=='string'||!uuid.test(row.orderId)||row.currency!=='CNY'||row.quoteMode!=='remaining_prorata'
  ||!Number.isSafeInteger(row.amountMinor)||Number(row.amountMinor)<1||!Number.isSafeInteger(row.unusedSeconds)||Number(row.unusedSeconds)<1
  ||!Number.isSafeInteger(row.refundableSeconds)||Number(row.refundableSeconds)<Number(row.unusedSeconds)||Number(row.refundableSeconds)%3600!==0
  ||!Number.isSafeInteger(row.generatedAt)||Number(row.generatedAt)<0
  ||(row.existingStatus!==null&&!refundStatuses.includes(row.existingStatus as BillingRefundStatus)))throw new CloudAuthError('invalid_response');
 return {orderId:row.orderId,amountMinor:Number(row.amountMinor),currency:'CNY',unusedSeconds:Number(row.unusedSeconds),refundableSeconds:Number(row.refundableSeconds),
  quoteMode:'remaining_prorata',generatedAt:Number(row.generatedAt),existingStatus:row.existingStatus as BillingRefundStatus|null,quoteToken:row.quoteToken};
}
function billingRefund(value:unknown):BillingRefund {
 const row=exactObject(value,['refundId','orderId','amountMinor','currency','status','requestedAt','providerConfirmedAt','finalizedAt','duplicate']);
 const providerConfirmedAt=nullableSecond(row.providerConfirmedAt),finalizedAt=nullableSecond(row.finalizedAt);
 if(typeof row.refundId!=='string'||!uuid.test(row.refundId)||typeof row.orderId!=='string'||!uuid.test(row.orderId)||row.currency!=='CNY'
  ||!refundStatuses.includes(row.status as BillingRefundStatus)||!Number.isSafeInteger(row.amountMinor)||Number(row.amountMinor)<1
  ||!Number.isSafeInteger(row.requestedAt)||Number(row.requestedAt)<0||typeof row.duplicate!=='boolean'
  ||(providerConfirmedAt!==null&&providerConfirmedAt<Number(row.requestedAt))||(finalizedAt!==null&&finalizedAt<Number(row.requestedAt))
  ||(row.status==='requested'&&(providerConfirmedAt!==null||finalizedAt!==null))
  ||(row.status==='provider_succeeded'&&(providerConfirmedAt===null||finalizedAt!==null))
  ||(row.status==='provider_failed'&&(providerConfirmedAt!==null||finalizedAt!==null))
   ||(row.status==='failed'&&(providerConfirmedAt!==null||finalizedAt===null))
   ||(row.status==='refunded'&&(providerConfirmedAt===null||finalizedAt===null)))throw new CloudAuthError('invalid_response');
 return {refundId:row.refundId,orderId:row.orderId,amountMinor:Number(row.amountMinor),currency:'CNY',status:row.status as BillingRefundStatus,
  requestedAt:Number(row.requestedAt),providerConfirmedAt,finalizedAt,duplicate:row.duplicate};
}
function billingCheckoutUrl(value:unknown,orderId:string,origin:string):string {
 if(typeof value!=='string'||value.length>2048)throw new CloudAuthError('invalid_response');
 const url=new URL(value),fragment=new URLSearchParams(url.hash.slice(1));
 if(url.origin!==origin||url.pathname!=='/api/billing/checkout'||url.username||url.password||url.search
  ||fragment.getAll('order').length!==1||fragment.get('order')!==orderId||fragment.getAll('checkout').length!==1
  ||!/^[A-Za-z0-9_-]{43}$/.test(fragment.get('checkout')??'')||[...fragment.keys()].some(key=>!['order','checkout'].includes(key)))throw new CloudAuthError('invalid_response');
 return value;
}
function cancelled(signal?:AbortSignal) {if(signal?.aborted)throw new CloudAuthError('cancelled');}
export async function authSleep(ms:number,signal?:AbortSignal) {
 cancelled(signal);await new Promise<void>((resolve,reject)=>{
  const finish=()=>{signal?.removeEventListener('abort',abort);resolve();};
  const timer=setTimeout(finish,ms);const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(new CloudAuthError('cancelled'));};
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 });
}
async function openBrowser(pending:Promise<boolean>,signal?:AbortSignal):Promise<boolean> {
 cancelled(signal);return new Promise<boolean>((resolve,reject)=>{
  const cleanup=()=>signal?.removeEventListener('abort',abort);
  const abort=()=>{cleanup();reject(new CloudAuthError('cancelled'));};
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  pending.then(value=>{cleanup();resolve(value);},()=>{cleanup();reject(new CloudAuthError('browser_failed'));});
 });
}
interface Ports {secrets:SecretPort;receipts:ReceiptPort;clientId:string;fetch:typeof fetch;openExternal(url:string):Promise<boolean>;origin?:string;
 now?:()=>number;sleep?:(ms:number,signal?:AbortSignal)=>Promise<void>}
/** No Google secret, cookies, callbacks, workspace-configured hosts or licensing decisions in this client.
 * Every response is treated as untrusted. Credentials are exclusively SecretStorage records.
 */
export class CloudAuthClient {
 private readonly ports:Ports;private readonly now:()=>number;private readonly sleep:(ms:number,signal?:AbortSignal)=>Promise<void>;private readonly origin:string;
 private cooldownUntil=0;
 private running=false;private checked?:{sessionId:string;at:number;state:'verified'|'unavailable';account?:AccountSnapshot;failure?:AuthErrorCode};
 private readonly checks=new Map<string,Promise<AuthView>>();
 private restoration?:Promise<AuthView>;
 constructor(ports:Ports){this.ports=ports;this.origin=validateCloudOrigin(ports.origin??CLOUD_AUTH_ORIGIN,{allowProduction:true});this.now=ports.now??Date.now;this.sleep=ports.sleep??authSleep;}
 private async receipts() {
  try {return (await this.ports.receipts.list()).filter(value=>validReceipt(value,this.origin)).sort((a,b)=>b.loginOrder-a.loginOrder||(a.kind===b.kind?0:a.kind==='logout'?-1:1));}
  catch {throw new CloudAuthError('storage');}
 }
 private async current():Promise<Credential|null> {
  const latest=(await this.receipts())[0];if(!latest||latest.kind==='logout')return null;
  try {const text=await this.ports.secrets.get(credentialKey(latest.sessionId,this.origin));if(!text)throw new CloudAuthError('storage');
   const value=credential(JSON.parse(text));
   if(value.sessionId!==latest.sessionId||value.loginOrder!==latest.loginOrder)throw new CloudAuthError('storage');
   return value;
  }catch{throw new CloudAuthError('storage');}
 }
 /** The current login, for the one-time move into the daemon (plan 6.11). Stays in-process. */
 async migrationCredential():Promise<Credential|null> {return this.current();}
 async gateIdentity() {
  const latest=(await this.receipts())[0],value=await this.current();
  if(value)return {userId:value.userId,clientId:value.clientId,sessionId:value.sessionId,loginOrder:value.loginOrder,expiresAt:value.expiresAt,kind:'login' as const};
  if(latest?.kind==='login')throw new CloudAuthError('storage');
  return {userId:'',clientId:this.ports.clientId,sessionId:latest?.sessionId??'',loginOrder:latest?.loginOrder??0,expiresAt:0,kind:'logout' as const};
 }
 async entitlementProof(challenge:string,sessionId:string):Promise<{payload:string;signature:string}> {
  if(!/^[A-Za-z0-9_-]{43}$/.test(challenge))throw new CloudAuthError('invalid_response');
  const value=await this.current();if(!value||value.sessionId!==sessionId)throw new CloudAuthError('rejected');
  const result=await this.request(base+'/entitlement','POST',{challenge},value.token);
  if(result.status===401){await this.forget(value);throw new CloudAuthError('rejected');}
  if(result.status!==200)this.status(result.status);
  const now=await this.current();if(!now||now.sessionId!==value.sessionId||now.loginOrder!==value.loginOrder)throw new CloudAuthError('rejected');
  const ticket=(result.value as {ticket?:{payload?:unknown;signature?:unknown}})?.ticket;
  if(!ticket||typeof ticket.payload!=='string'||ticket.payload.length>4096||!/^[A-Za-z0-9_-]+$/.test(ticket.payload)
   ||typeof ticket.signature!=='string'||!/^[A-Za-z0-9_-]{86}$/.test(ticket.signature))throw new CloudAuthError('invalid_response');
  return {payload:ticket.payload,signature:ticket.signature};
 }
 /** Native buyer-only billing calls; never exports a bearer or changes subscription facts locally. */
 private async billingRequest(path:string,method:'GET'|'POST',expectedUserId:string,data?:Record<string,string>,idempotencyKey?:string,signal?:AbortSignal,kind:'general'|'reconcile'|'refundQuote'|'refund'='general'):Promise<unknown> {
  if(!/^\/api\/billing\/(?:plans|refundable-orders(?:\?cursor=\d{1,16}\.[0-9a-f-]{36})?|orders(?:\/[0-9a-f-]{36}(?:\/(?:reconcile|checkout-link|refund-quote|refund))?)?)$/.test(path))throw new CloudAuthError('invalid_response');
  const value=await this.current();if(!value||value.userId!==expectedUserId||value.expiresAt<=Math.floor(this.now()/1000))throw new CloudAuthError('rejected');
  let result:Awaited<ReturnType<CloudAuthClient['request']>>;
  try {result=await this.request(path,method,data,value.token,signal,idempotencyKey);}
  catch(error){
   if(error instanceof CloudAuthError&&['network','invalid_response'].includes(error.code)){
    if(kind==='refund')throw new CloudAuthError('refund_result_unknown');
    if(kind==='refundQuote')throw new CloudAuthError('refund_not_available');
    throw new CloudAuthError('payment_result_unknown');
   }
   throw error;
  }
  if(result.status===401){await this.forget(value);throw new CloudAuthError('rejected');}
  if(result.status===403)throw new CloudAuthError('rejected');
  if(result.status===429)throw new CloudAuthError('rate_limited');
  // A refund POST is always preceded by a server-signed quote. Any 409 means that confirmation is no longer current;
  // ask for a fresh quote instead of treating the ambiguous conflict as a provider result.
  if(kind==='refund'&&result.status===409)throw new CloudAuthError('refund_quote_changed');
  if(((kind==='refund'||kind==='refundQuote')&&result.status===404)||(kind==='refundQuote'&&result.status===409))throw new CloudAuthError('refund_not_eligible');
  if(result.status===503){
   if(kind==='refund')throw new CloudAuthError('refund_result_unknown');
   if(kind==='refundQuote')throw new CloudAuthError('refund_not_available');
   throw new CloudAuthError(kind==='reconcile'?'payment_result_unknown':'payment_not_available');
  }
  const accepted=result.status===200||(kind==='refund'&&result.status===202);
  if(!accepted){
   if(kind==='refund')throw new CloudAuthError('refund_result_unknown');
   if(kind==='refundQuote')throw new CloudAuthError('refund_not_eligible');
   throw new CloudAuthError(kind==='reconcile'?'payment_review_required':'payment_result_unknown');
  }
  const current=await this.current();if(!current||current.userId!==expectedUserId||current.sessionId!==value.sessionId)throw new CloudAuthError('rejected');
  return result.value;
 }
 async billingPlans(expectedUserId:string):Promise<{enabled:boolean;environment?:'sandbox'|'production';plans:BillingPlan[]}> {
  const row=exactObject(await this.billingRequest('/api/billing/plans','GET',expectedUserId),['enabled','plans'],['environment']);
  if(typeof row.enabled!=='boolean'||!Array.isArray(row.plans)||row.plans.length>10||new Set(row.plans.map(item=>(item as {sku?:unknown})?.sku)).size!==row.plans.length
   ||(row.environment!==undefined&&!['sandbox','production'].includes(String(row.environment))))throw new CloudAuthError('invalid_response');
  const plans=row.plans.map(billingPlan);if((row.enabled&&(!row.environment||plans.length===0))||(!row.enabled&&plans.length!==0))throw new CloudAuthError('invalid_response');
  return {enabled:row.enabled,...(row.environment?{environment:row.environment as 'sandbox'|'production'}:{}),plans};
 }
 async billingOrders(expectedUserId:string):Promise<BillingOrder[]> {
  const row=exactObject(await this.billingRequest('/api/billing/orders','GET',expectedUserId),['orders']);
  if(!Array.isArray(row.orders)||row.orders.length>20)throw new CloudAuthError('invalid_response');return row.orders.map(billingOrder);
 }
 async billingRefundableOrders(expectedUserId:string,cursor?:string):Promise<{orders:BillingOrder[];nextCursor:string|null}> {
  const valid=(value:unknown):value is string=>typeof value==='string'&&/^\d{1,16}\.[0-9a-f-]{36}$/.test(value)&&uuid.test(value.slice(value.indexOf('.')+1));
  if(cursor!==undefined&&!valid(cursor))throw new CloudAuthError('invalid_response');
  const row=exactObject(await this.billingRequest('/api/billing/refundable-orders'+(cursor?'?cursor='+cursor:''),'GET',expectedUserId),['orders','nextCursor']);
  if(!Array.isArray(row.orders)||row.orders.length>20||(row.nextCursor!==null&&(!valid(row.nextCursor)||row.nextCursor===cursor)))throw new CloudAuthError('invalid_response');
  const orders=row.orders.map(billingOrder);
  if(orders.some(order=>!['fulfilled','review'].includes(order.status))||new Set(orders.map(order=>order.id)).size!==orders.length)throw new CloudAuthError('invalid_response');
  return {orders,nextCursor:row.nextCursor as string|null};
 }
 async createBillingOrder(expectedUserId:string,sku:BillingSku,idempotencyKey:string,signal?:AbortSignal):Promise<{order:BillingOrder;checkoutUrl:string}> {
  if(!billingSkus.includes(sku))throw new CloudAuthError('invalid_response');
  const row=exactObject(await this.billingRequest('/api/billing/orders','POST',expectedUserId,{sku},idempotencyKey,signal),['order','checkoutUrl']);
  const order=billingOrder(row.order);if(order.sku!==sku)throw new CloudAuthError('invalid_response');return {order,checkoutUrl:billingCheckoutUrl(row.checkoutUrl,order.id,this.origin)};
 }
 async billingOrder(expectedUserId:string,orderId:string):Promise<BillingOrder> {
  if(!uuid.test(orderId))throw new CloudAuthError('invalid_response');const row=exactObject(await this.billingRequest('/api/billing/orders/'+orderId,'GET',expectedUserId),['order']);return billingOrder(row.order);
 }
 async reconcileBillingOrder(expectedUserId:string,orderId:string,signal?:AbortSignal):Promise<BillingOrder> {
  if(!uuid.test(orderId))throw new CloudAuthError('invalid_response');const row=exactObject(await this.billingRequest('/api/billing/orders/'+orderId+'/reconcile','POST',expectedUserId,{},undefined,signal,'reconcile'),['order']);return billingOrder(row.order);
 }
 async billingCheckoutLink(expectedUserId:string,orderId:string):Promise<{order:BillingOrder;checkoutUrl:string}> {
  if(!uuid.test(orderId))throw new CloudAuthError('invalid_response');const row=exactObject(await this.billingRequest('/api/billing/orders/'+orderId+'/checkout-link','POST',expectedUserId,{}),['order','checkoutUrl']);
  const order=billingOrder(row.order);return {order,checkoutUrl:billingCheckoutUrl(row.checkoutUrl,order.id,this.origin)};
 }
 async billingRefundQuote(expectedUserId:string,orderId:string):Promise<BillingRefundQuote> {
  if(!uuid.test(orderId))throw new CloudAuthError('invalid_response');
  const row=exactObject(await this.billingRequest('/api/billing/orders/'+orderId+'/refund-quote','GET',expectedUserId,undefined,undefined,undefined,'refundQuote'),['quote']);
  const quote=billingRefundQuote(row.quote);if(quote.orderId!==orderId)throw new CloudAuthError('invalid_response');return quote;
 }
 async refundBillingOrder(expectedUserId:string,orderId:string,idempotencyKey:string,quoteToken:string):Promise<BillingRefund> {
  if(!uuid.test(orderId)||typeof quoteToken!=='string'||!/^\d{1,16}\.\d{1,16}\.\d{1,16}\.[A-Za-z0-9_-]{43}$/.test(quoteToken))throw new CloudAuthError('invalid_response');
  const row=exactObject(await this.billingRequest('/api/billing/orders/'+orderId+'/refund','POST',expectedUserId,{confirmation:'refund',quoteToken},idempotencyKey,undefined,'refund'),['refund']);
  const refund=billingRefund(row.refund);if(refund.orderId!==orderId)throw new CloudAuthError('invalid_response');return refund;
 }
 async view():Promise<AuthView> {
  const value=await this.current();if(!value||value.expiresAt<=Math.floor(this.now()/1000))return {state:'logged_out'};
  const checked=this.checked?.sessionId===value.sessionId&&this.now()-this.checked.at>=0&&this.now()-this.checked.at<60000?this.checked.state:'saved';
  const snapshot=this.checked?.sessionId===value.sessionId?this.checked:undefined;
  const account=snapshot?.state==='verified'&&this.now()>=snapshot.at?snapshot.account:undefined;
  const elapsed=snapshot?Math.max(0,Math.floor((this.now()-snapshot.at)/1000)):0;
  return {state:checked,userId:value.userId,expiresAt:value.expiresAt,...(snapshot?{checkedAt:snapshot.at}:{}),
   ...(account?{account:{...account,plans:[]},remainingSeconds:account.status==='active'?Math.max(0,account.serviceExpiresAt-account.serverNow-elapsed):0}:{})};
 }
 private async json(response:Response):Promise<unknown> {
  if(!response.headers.get('Content-Type')?.toLowerCase().startsWith('application/json'))throw new CloudAuthError('invalid_response');
  const reader=response.body?.getReader();if(!reader)throw new CloudAuthError('invalid_response');
  const chunks:Uint8Array[]=[];let size=0;
  try {while(true){const p=await reader.read();if(p.done)break;size+=p.value.length;if(size>16384){await reader.cancel();throw 0;}chunks.push(p.value);}
   const bytes=new Uint8Array(size);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.length;}
   return JSON.parse(new TextDecoder().decode(bytes));
  }catch{throw new CloudAuthError('invalid_response');}finally{reader.releaseLock();}
 }
 private async request(path:string,method:string,data?:unknown,token?:string,signal?:AbortSignal,idempotencyKey?:string) {
  cancelled(signal);if(this.now()<this.cooldownUntil)throw new CloudAuthError('rate_limited');
  const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(abort,15000);
  try {
   const headers:Record<string,string>={Accept:'application/json','Cache-Control':'no-store'};if(data!==undefined)headers['Content-Type']='application/json';if(token)headers.Authorization='Bearer '+token;
   if(idempotencyKey){if(!/^[A-Za-z0-9_-]{16,128}$/.test(idempotencyKey))throw new CloudAuthError('invalid_response');headers['Idempotency-Key']=idempotencyKey;}
   const response=await this.ports.fetch(this.origin+path,{method,headers,redirect:'error',credentials:'omit',signal:controller.signal,
    body:data===undefined?undefined:JSON.stringify(data)});
   if(response.redirected||(response.url&&response.url!==this.origin+path))throw new CloudAuthError('invalid_response');
   // Read/limit the response body while timeout and cancellation remain active.
   let value:unknown;if([200,202].includes(response.status))value=await this.json(response);else await response.body?.cancel();
   const retryAfterMs=response.status===429?retryDelay(response.headers.get('Retry-After'),this.now()):0;
   if(retryAfterMs)this.cooldownUntil=Math.max(this.cooldownUntil,this.now()+retryAfterMs);
   cancelled(signal);return {status:response.status,value,retryAfterMs};
  }catch(error){if(signal?.aborted)throw new CloudAuthError('cancelled');if(error instanceof CloudAuthError)throw error;throw new CloudAuthError('network');}
  finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);}
 }
 private status(status:number):never {throw new CloudAuthError(status===503?'not_available':status===429?'rate_limited':'rejected');}
 private async prune() {
  // Immutable per-session slots and monotonic receipts avoid read-modify-write lost updates across windows.
  // Never remove a slot at/above the highest observed order; a newer concurrently published slot is safe.
  try {const rows=await this.receipts(),highest=rows[0]?.loginOrder;if(highest===undefined)return;
   for(const row of rows)if(row.loginOrder<highest){await this.ports.secrets.delete(credentialKey(row.sessionId,this.origin));await this.ports.receipts.remove(row);}
  }catch{/* Cleanup failure is not authentication success/failure; latest ordering still wins. */}
 }
 private async publish(value:Credential) {
  try {await this.ports.secrets.store(credentialKey(value.sessionId,this.origin),JSON.stringify(value));
   await this.ports.receipts.put({version:1,origin:this.origin,loginOrder:value.loginOrder,sessionId:value.sessionId,kind:'login'});
  }catch{throw new CloudAuthError('storage');}await this.prune();
 }
 private async forget(value:Credential) {
  // Durable tombstone FIRST. Deletion alone would incorrectly resurrect an older login after logout.
  try {await this.ports.receipts.put({version:1,origin:this.origin,loginOrder:value.loginOrder,sessionId:value.sessionId,kind:'logout'});
   await this.ports.secrets.delete(credentialKey(value.sessionId,this.origin));
  }catch{throw new CloudAuthError('storage');}await this.prune();
 }
 /** `expectUserId`: only accept that account; any other login is discarded (and ended on the server) instead of replacing it. */
 async signIn(signal?:AbortSignal,expectUserId?:string):Promise<AuthView> {

  if(this.running)throw new CloudAuthError('busy');this.running=true;
  try {
   cancelled(signal);const verifier=randomBytes(32).toString('base64url'),challenge=createHash('sha256').update(verifier).digest('base64url');
   const started=await this.request(base+'/start','POST',{clientId:this.ports.clientId,challenge},undefined,signal);
   if(started.status!==200)this.status(started.status);
   const start=started.value as {flowId?:unknown;authorizationUrl?:unknown;expiresAt?:unknown;pollInterval?:unknown}|undefined;
   if(!start||typeof start.flowId!=='string'||!uuid.test(start.flowId)||typeof start.authorizationUrl!=='string'
    ||typeof start.expiresAt!=='number'||!Number.isSafeInteger(start.expiresAt)||start.expiresAt*1000<=this.now()||start.expiresAt*1000>this.now()+610000
    ||start.pollInterval!==2)throw new CloudAuthError('invalid_response');
   const url=new URL(start.authorizationUrl),fragment=new URLSearchParams(url.hash.slice(1));
   if(url.origin!==this.origin||url.pathname!==base+'/authorize'||url.username||url.password||url.search
    ||fragment.getAll('flow').length!==1||fragment.get('flow')!==start.flowId||fragment.getAll('launch').length!==1
    ||!/^[A-Za-z0-9_-]{43}$/.test(fragment.get('launch')??'')||[...fragment.keys()].some(k=>!['flow','launch'].includes(k)))throw new CloudAuthError('invalid_response');
   cancelled(signal);if(!await openBrowser(this.ports.openExternal(url.href),signal))throw new CloudAuthError('browser_failed');
   const deadline=Math.min(start.expiresAt*1000,this.now()+600000);
   while(this.now()<deadline) {
    await this.sleep(2000,signal);if(this.now()>=deadline)break;
    const result=await this.request(base+'/exchange','POST',{flowId:start.flowId,verifier},undefined,signal);
    if(result.status===202){if((result.value as {status?:unknown})?.status!=='authorization_pending')throw new CloudAuthError('invalid_response');continue;}
    if(result.status===429){await this.sleep(Math.min(result.retryAfterMs,Math.max(0,deadline-this.now())),signal);continue;}
    if(result.status!==200)this.status(result.status);
    const value=credential(result.value),now=Math.floor(this.now()/1000);
    if(value.clientId!==this.ports.clientId||value.expiresAt<=now||value.expiresAt>now+604860)throw new CloudAuthError('invalid_response');
    if(expectUserId&&value.userId!==expectUserId){await this.request(base+'/logout','POST',{},value.token).catch(()=>undefined);throw new CloudAuthError('account_mismatch');}
    cancelled(signal);await this.publish(value);return this.check();
   }
   throw new CloudAuthError('expired');
  }catch(error){if(error instanceof CloudAuthError)throw error;throw new CloudAuthError('invalid_response');}
  finally{this.running=false;}
 }
 /** Startup/daemon-replacement recovery, not periodic cloud polling. Only the
  * read-only session GET is retried; login exchange and billing are never replayed. */
 restore(signal?:AbortSignal):Promise<AuthView> {
  if(this.restoration)return this.restoration;
  const pending=(async()=>{
   let view:AuthView={state:'unavailable'};
   for(let attempt=0;attempt<3;attempt++){
    cancelled(signal);let retry=false;
    try {
     view=await this.check(signal);
     retry=view.state==='unavailable'&&['network','not_available'].includes(this.checked?.failure??'');
    }catch(error){
     if(!(error instanceof CloudAuthError)||error.code!=='storage')throw error;
     retry=true;
    }
    if(!retry||attempt===2)return view;
    await this.sleep((attempt+1)*1000,signal);
   }
   return view;
  })().finally(()=>{if(this.restoration===pending)this.restoration=undefined;});
  this.restoration=pending;return pending;
 }
 async check(signal?:AbortSignal):Promise<AuthView> {
  cancelled(signal);
  const value=await this.current();if(!value)return {state:'logged_out'};
  const existing=this.checks.get(value.sessionId);if(existing)return existing;
  const pending=this.checkCredential(value,signal);this.checks.set(value.sessionId,pending);
  try{return await pending;}finally{if(this.checks.get(value.sessionId)===pending)this.checks.delete(value.sessionId);}
 }
 private async checkCredential(value:Credential,signal?:AbortSignal):Promise<AuthView> {
  if(value.expiresAt<=Math.floor(this.now()/1000)){await this.forget(value);return this.view();}
  try {
   const result=await this.request(base+'/session','GET',undefined,value.token,signal);
   if(result.status===401){await this.forget(value);return this.view();}
   if(result.status!==200)this.status(result.status);
   const facts=result.value as (Partial<Credential>&{account?:unknown})|undefined;
   if(!facts||facts.userId!==value.userId||facts.clientId!==value.clientId||facts.sessionId!==value.sessionId||facts.expiresAt!==value.expiresAt||facts.loginOrder!==value.loginOrder)throw new CloudAuthError('invalid_response');
   const account=accountSnapshot(facts.account),current=await this.current();
   if(current?.sessionId===value.sessionId&&current.loginOrder===value.loginOrder){
    this.checked={sessionId:value.sessionId,at:this.now(),state:'verified',account};
   }
  }catch(error){
   if(error instanceof CloudAuthError&&['storage','cancelled'].includes(error.code))throw error;
   const current=await this.current();
   if(current?.sessionId===value.sessionId&&current.loginOrder===value.loginOrder){
    this.checked={sessionId:value.sessionId,at:this.now(),state:'unavailable',failure:error instanceof CloudAuthError?error.code:'invalid_response'};
   }
  }
  return this.view();
 }
 /** Redemption is a separate idempotent business operation, not a new login.
  * The code never enters receipts, logs, persistent settings or the webview.
  * Return known accounting success even if a later check/daemon refresh is unavailable.
  */
 async redeemCard(code:string,expectedUserId:string):Promise<CardRedemption> {
  if(typeof code!=='string'||code.length>160||!/^BH1[0-9A-F]{48}$/.test(code.replace(/[\s-]/g,'').toUpperCase()))throw new CloudAuthError('card_unavailable');
  const value=await this.current();
  if(!value||value.userId!==expectedUserId||value.expiresAt<=Math.floor(this.now()/1000))throw new CloudAuthError('rejected');
  let result:Awaited<ReturnType<CloudAuthClient['request']>>;
  try {result=await this.request(base+'/cards/redeem','POST',{code},value.token);}
  catch(error){
   if(error instanceof CloudAuthError&&error.code==='rate_limited')throw error;
   throw new CloudAuthError('card_result_unknown');
  }
  if(result.status===401){await this.forget(value);throw new CloudAuthError('rejected');}
  if(result.status===409||result.status===400)throw new CloudAuthError('card_unavailable');
  // A 5xx can follow a committed write with a lost read-back, not necessarily an unused card.
  if(result.status>=500)throw new CloudAuthError('card_result_unknown');
  if(result.status!==200)this.status(result.status);
  const data=result.value as Partial<CardRedemption>|undefined;
  if(!data||typeof data.cardId!=='string'||!uuid.test(data.cardId)||typeof data.grantId!=='string'||!uuid.test(data.grantId)
   ||data.userId!==value.userId||typeof data.expiresAt!=='number'||!Number.isSafeInteger(data.expiresAt)||data.expiresAt<0||typeof data.duplicate!=='boolean')
   throw new CloudAuthError('card_result_unknown');
  this.checked=undefined;
  return {cardId:data.cardId,userId:data.userId,grantId:data.grantId,expiresAt:data.expiresAt,duplicate:data.duplicate};
 }
 async signOut():Promise<AuthView> {
  const value=await this.current();if(!value)return {state:'logged_out'};
  const result=await this.request(base+'/logout','POST',{},value.token);
  // Never pretend server logout succeeded on an unknown/network failure; preserve credential for retry.
  if(result.status!==204)this.status(result.status);
  await this.forget(value);return this.view();
 }
}
