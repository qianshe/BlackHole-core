import { commands, Disposable, env, ProgressLocation, Uri, window } from 'vscode';
import { randomUUID } from 'node:crypto';
import { authSleep, CloudAuthClient, CloudAuthError, type BillingOrder, type BillingPlan } from './cloudAuthClient';

const statusNames:Record<BillingOrder['status'],string>={payment_pending:'待付款 / 待确认',paid:'付款已确认，权益处理中',fulfilled:'已到账',expired:'支付窗口已结束',review:'超时付款，未交付权益',refunded:'已退款'};
const errorMessages:Record<string,string>={
 payment_not_available:'支付宝时长购买尚未开放或当前配置不可用；现有登录、订阅卡兑换不受影响。',
 payment_result_unknown:'购买结果暂时无法确认。请从“购买记录”核对原订单，不要重复付款。',
 payment_review_required:'这笔订单需要管理员人工核对。请保留订单 ID，不要再次付款。',
 refund_not_available:'退款服务或当前支付配置暂不可用。',
 refund_quote_changed:'退款报价或权益状态已变化，本次未提交退款。请重新选择订单、查看金额并确认。',
 refund_not_eligible:'这笔订单当前不符合退款条件：可能尚未完成结算、没有剩余付费时长，或不属于当前账号。',
 refund_result_unknown:'退款结果暂时无法确认。请稍后从设置页再次选择同一订单核对；服务端会复用原退款请求，不要另外创建退款。',
 rate_limited:'请求较多，请稍后从购买记录继续。',
 rejected:'当前登录已变化，请重新登录购买账号后再核对。',
 cancelled:'已停止本机等待。取消等待不会取消已经成功的支付宝交易。',
};
function days(seconds:number){return Math.max(1,Math.round(seconds/86400));}
function price(minor:number){return '¥'+(minor/100).toFixed(2);}
function durationLabel(seconds:number){const days=Math.floor(seconds/86400),hours=Math.floor(seconds%86400/3600),minutes=Math.ceil(seconds%3600/60);return [days?days+' 天':'',hours?hours+' 小时':'',minutes?minutes+' 分钟':''].filter(Boolean).join(' ')||'不足 1 分钟';}
function planLabel(plan:BillingPlan){return `${plan.amountMinor===1?'支付验收 · ':''}${days(plan.durationSeconds)} 天 · ${price(plan.amountMinor)}`;}
function orderLabel(order:BillingOrder){return `${days(order.durationSeconds)} 天 · ${price(order.amountMinor)} · ${statusNames[order.status]}`;}

/** User-driven only: no background order polling and no automatic recurring payment. */
export function registerCloudBilling(ready:()=>PromiseLike<CloudAuthClient>):Disposable {
 let disposed=false,busy=false,abort:AbortController|undefined;
 // Passive notifications settle only when dismissed; never hold the purchase mutex for them.
 const info=(message:string)=>{if(!disposed)void window.showInformationMessage(message).then(undefined,()=>{});};
 const warn=(message:string)=>{if(!disposed)void window.showWarningMessage(message).then(undefined,()=>{});};
 const report=(error:unknown)=>{
  if(disposed)return;
  const code=error instanceof CloudAuthError?error.code:'';
  warn('BlackHole：'+(errorMessages[code]??'购买流程响应不符合预期，已停止。请从购买记录核对原订单，勿重复付款。'));
 };
 async function presentFulfilled(order:BillingOrder) {
  await commands.executeCommand('blackhole.accountRefresh');
  info(`BlackHole：支付成功，${days(order.durationSeconds)} 天订阅时长已自动叠加到当前账号。`);
 }
 async function waitForPayment(client:CloudAuthClient,userId:string,initial:BillingOrder) {
  const controller=new AbortController();abort=controller;let current=initial,userCancelled=false;
  try {
   await window.withProgress({location:ProgressLocation.Notification,title:'BlackHole：正在确认支付宝付款',cancellable:true},async(_progress,cancellation)=>{
    const registration=cancellation.onCancellationRequested(()=>{userCancelled=true;controller.abort();}),deadline=Date.now()+300000;
    try {
     for(let n=0;n<28&&!disposed&&Date.now()<deadline;n++){
      try{current=await client.reconcileBillingOrder(userId,current.id,controller.signal);}
      catch(error){if(!(error instanceof CloudAuthError)||error.code!=='payment_result_unknown')throw error;}
      if(current.status!=='payment_pending')break;
      await authSleep(n<12?5000:15000,controller.signal);
     }
    }finally{registration.dispose();}
   });
   if(disposed)return;
   if(current.status==='fulfilled')await presentFulfilled(current);
   else if(current.status==='paid')info(`BlackHole：订单 ${current.id} 已确认付款，订阅权益正在自动入账；可稍后从购买记录继续核对。`);
   else if(current.status==='review')warn(`BlackHole：订单 ${current.id} 付款超过订单有效期，尚未发放权益。可在购买记录中选择此订单申请退款，请勿重复付款。`);
   else info(`BlackHole：订单当前为“${statusNames[current.status]}”。可稍后从购买记录继续核对。`);
  }catch(error){
   if(userCancelled&&!disposed&&current.status==='payment_pending')info(`BlackHole：已停止等待订单 ${current.id}。订单不会被取消；可稍后从购买记录查看或核对支付结果。`);
   else if(!controller.signal.aborted)throw error;
  }
  finally{if(abort===controller)abort=undefined;}
 }
 async function buy(client:CloudAuthClient,userId:string,requestedSku?:string,confirmedBySettings=false) {
  const catalogue=await client.billingPlans(userId);
  if(!catalogue.enabled){info('支付宝时长购买尚未开放；现有订阅卡兑换不受影响。');return;}
  const requested=requestedSku?catalogue.plans.find(plan=>plan.sku===requestedSku):undefined;
  const picked=requested?{label:planLabel(requested),plan:requested}:await window.showQuickPick(catalogue.plans.map(plan=>({label:planLabel(plan),description:'单次付款，不自动续费',plan})),{title:'购买 BlackHole 使用时长',placeHolder:'选择 1 天、7 天或 30 天时长包',ignoreFocusOut:false});
  if(!picked||disposed)return;
  // Settings may show a cached standard price; a one-cent acceptance always needs a fresh server-price confirmation.
  if(!confirmedBySettings||picked.plan.amountMinor===1){
   const environment=catalogue.environment==='sandbox'?'沙箱测试，不使用真实资金。':'支付宝单次付款，不会自动续费。';
   if(await window.showInformationMessage(`确认购买 ${picked.label}？`,{modal:true,detail:`购买账号：${userId}\n${environment}\n支付宝确认付款后，对应订阅时长会自动增加到当前账号。`},'前往付款')!=='前往付款')return;
  }
  const created=await client.createBillingOrder(userId,picked.plan.sku,randomUUID());
  if(created.order.sku!==picked.plan.sku||created.order.amountMinor!==picked.plan.amountMinor||created.order.durationSeconds!==picked.plan.durationSeconds){warn('BlackHole：订单价格或时长已变化，未打开付款页。请重新查看方案，并在购买记录核对该待支付订单。');return;}
  if(!await env.openExternal(Uri.parse(created.checkoutUrl))){warn('未能打开系统浏览器。订单已经保留，请从购买记录继续付款。');return;}
  await waitForPayment(client,userId,created.order);
 }
 async function orders(client:CloudAuthClient,userId:string) {
  const rows=await client.billingOrders(userId);if(!rows.length){info('当前账号还没有支付宝购买订单。');return;}
  const now=Math.floor(Date.now()/1000),visible=rows.map(order=>order.status==='payment_pending'&&order.expiresAt<=now?{...order,status:'expired' as const}:order);
  const selected=await window.showQuickPick(visible.map(order=>({label:orderLabel(order),description:order.id,order})),{title:'最近 20 笔时长购买订单',ignoreFocusOut:false});
  if(!selected||disposed)return;const order=selected.order;
  const actions:string[]=[];
  if(order.status==='payment_pending')actions.push('继续付款','核对支付结果');
  if(order.status==='paid')actions.push('核对自动到账');
  if(order.status==='expired')actions.push('核对支付结果');
  if(order.status==='review')actions.push('申请退款');
  if(!actions.length){info(`订单 ${order.id}：${statusNames[order.status]}。如需退款，请使用设置页的“申请退款”；异常核对时请保留此订单 ID。`);return;}
  const action=await window.showQuickPick(actions,{title:`订单 ${order.id}`,ignoreFocusOut:false});if(!action||disposed)return;
  if(action==='申请退款'){await refund(client,userId,order);return;}
  if(action==='继续付款'){
   const checkout=await client.billingCheckoutLink(userId,order.id);
   if(!await env.openExternal(Uri.parse(checkout.checkoutUrl))){warn('未能打开系统浏览器。订单仍然保留。');return;}
   await waitForPayment(client,userId,checkout.order);return;
  }
  const updated=await client.reconcileBillingOrder(userId,order.id);
  if(updated.status==='fulfilled')await presentFulfilled(updated);
  else if(updated.status==='paid')info(`BlackHole：订单 ${updated.id} 已确认付款，订阅权益正在自动入账。`);
  else if(updated.status==='review')warn(`BlackHole：订单 ${updated.id} 付款超时且未交付权益，可在购买记录中申请退款，请勿重复付款。`);
  else info(`订单状态：${statusNames[updated.status]}。`);
 }
 async function refund(client:CloudAuthClient,userId:string,selectedOrder?:BillingOrder) {
  let order:BillingOrder|undefined=selectedOrder,cursor:string|undefined;
  const cursors=new Set<string>();
  while(!disposed&&!order){
   const page=await client.billingRefundableOrders(userId,cursor);
   if(!page.orders.length&&!page.nextCursor){info('当前账号没有已到账或待核对的支付宝订单。');return;}
   const choices:Array<{label:string;description?:string;order?:BillingOrder;more?:true}>=page.orders.map(order=>({label:orderLabel(order),description:order.id,order}));
   if(page.nextCursor)choices.push({label:'下一页订单',description:'继续查找较早购买的订单',more:true});
   const selected=await window.showQuickPick(choices,{title:'选择要退款的支付宝订单',placeHolder:'免费体验和赠送订阅卡优先消费，不参与现金退款',ignoreFocusOut:false});
   if(!selected||disposed)return;
   if(selected.more){if(!page.nextCursor||cursors.has(page.nextCursor))throw new CloudAuthError('invalid_response');cursor=page.nextCursor;cursors.add(cursor);continue;}
   order=selected.order;break;
  }
  if(!order||disposed)return;
  const quote=await client.billingRefundQuote(userId,order.id);
  const existing=quote.existingStatus?`\n已有退款请求状态：${order.status==='review'?({refunded:'已退款',provider_succeeded:'支付宝已确认，退款记录完成中',provider_failed:'支付方已拒绝，失败结果处理中',failed:'退款已明确失败',requested:'结果待核对'}[quote.existingStatus]):quote.existingStatus==='refunded'?'已退款':quote.existingStatus==='provider_succeeded'?'支付宝已确认，权益处理中':quote.existingStatus==='provider_failed'?'退款被拒绝，权益恢复中':quote.existingStatus==='failed'?'退款失败，权益已恢复':'结果待核对，待退时长已冻结'}。本次将核对同一笔退款，不会创建第二笔。`:'';
  const detail=order.status==='review'?`订单：${order.id}\n预计退款：${price(quote.amountMinor)}${existing}\n\n该订单付款超过有效期，尚未发放订阅权益；按未交付订单退款，不影响免费体验、赠送权益及其他订单。结果未知时请核对同一退款，不要再次付款。`:`订单：${order.id}\n预计退款：${price(quote.amountMinor)}\n本订单剩余付费时长：${durationLabel(quote.unusedSeconds)}\n计费退款时长：${durationLabel(quote.refundableSeconds)}${existing}\n\n只计算这笔支付宝订单尚未消耗的付费时长；免费体验、赠送/兑换订阅卡和其他订单均不计入。剩余不足整小时的部分按一小时计算，退款金额按分向上取整。确认提交后立即冻结这笔订单的待退时长；其余权益继续按免费优先的顺序消费。退款成功后撤回冻结部分，明确失败后恢复；结果未知时保持冻结。`;
  if(await window.showInformationMessage(`确认申请退款 ${price(quote.amountMinor)}？`,{modal:true,detail},'确认退款')!=='确认退款'||disposed)return;
  let result;
  try{result=await client.refundBillingOrder(userId,order.id,randomUUID(),quote.quoteToken);}
  finally{try{await commands.executeCommand('blackhole.accountRefresh');}catch{/* Server facts remain authoritative; do not replace the refund result. */}}
  if(result.status==='refunded'){
   info(order.status==='review'?`BlackHole：订单 ${order.id} 已退款 ${price(result.amountMinor)}；该订单未交付权益，免费体验和其他权益不受影响。`:`BlackHole：订单 ${order.id} 已退款 ${price(result.amountMinor)}；仅该订单尚未使用的付费时长已撤回，免费体验和订阅卡权益不受影响。`);
  }else if(result.status==='failed')warn(order.status==='review'?'BlackHole：支付方明确拒绝了本次退款；本订单未交付权益，请核对原因后再申请。':'BlackHole：支付方明确拒绝了本次退款，冻结的未用时长已恢复；请核对原因后再申请。');
  else if(result.status==='provider_failed')warn(order.status==='review'?'BlackHole：支付方已拒绝本次退款，失败结果正在处理，请稍后核对。':'BlackHole：支付方已拒绝本次退款，权益正在恢复，请稍后核对。');
  else warn(order.status==='review'?`BlackHole：订单 ${order.id} 的退款请求已保留，结果仍待核对。本订单尚未交付权益，请在购买记录中选择同一订单的“申请退款”继续核对，不要再次付款。`:`BlackHole：订单 ${order.id} 的退款请求已保留，待退时长已冻结，结果仍在核对。请稍后再次点击“申请退款”选择同一订单；不要创建另一笔退款。`);
 }
 async function act(mode:'buy'|'orders'|'refund',requestedSku?:string,confirmedBySettings=false) {
  if(disposed)return;if(busy){info('BlackHole：当前购买、订单核对或退款仍在进行，请稍候。');return;}busy=true;
  try {
   const client=await ready(),view=await client.view(),userId=view.userId;
   if(!userId||view.state==='logged_out'){warn('请先登录需要购买订阅时长的 BlackHole 账号。');return;}
   if(mode==='buy')await buy(client,userId,requestedSku,confirmedBySettings);else if(mode==='refund')await refund(client,userId);else await orders(client,userId);
  }catch(error){report(error);}finally{busy=false;}
 }
 return Disposable.from(
  commands.registerCommand('blackhole.accountBuyCard',(sku?:string,confirmedBySettings=false)=>act('buy',sku,confirmedBySettings===true)),
  commands.registerCommand('blackhole.accountOrders',()=>act('orders')),
  commands.registerCommand('blackhole.accountRefund',()=>act('refund')),
  new Disposable(()=>{disposed=true;abort?.abort();}),
 );
}
