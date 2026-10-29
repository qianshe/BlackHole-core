import {parseSubscriptionOrder,type SubscriptionOrder} from '../../packages/contracts/dist/subscriptions.js';
export function parseSubscriptionCheckout(value:unknown,origin:string):{order:SubscriptionOrder;checkoutUrl:string}{
 const bad=():never=>{throw Error('subscription_checkout_invalid')};
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='checkoutUrl,order')return bad();
 const v=value as Record<string,unknown>,order=parseSubscriptionOrder(v.order);if(typeof v.checkoutUrl!=='string'||v.checkoutUrl.length>2048)return bad();let url:URL;try{url=new URL(v.checkoutUrl)}catch{return bad()}
 const p=new URLSearchParams(url.hash.slice(1));if(url.protocol!=='https:'||url.origin!==origin||url.username||url.password||url.search||url.pathname!=='/api/billing/subscriptions/checkout'||[...p.keys()].sort().join(',')!=='checkout,order'||p.get('order')!==order.id||!/^[A-Za-z0-9_-]{43}$/.test(p.get('checkout')??''))return bad();return {order,checkoutUrl:url.href};
}
