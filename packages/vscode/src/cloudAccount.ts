import type { ControlApi } from './controlApi';
import { createHash, randomBytes } from 'node:crypto';
import { commands, Disposable, env, ProgressLocation, Uri, window, workspace, type ExtensionContext } from 'vscode';
import { CloudAuthClient, CloudAuthError, authSleep, receiptName, validReceipt, type AuthView, type Receipt, type ReceiptPort } from './cloudAuthClient';
import { cloudAuthPrefix, resolveCloudEndpoint } from './cloudEnvironment';
import { registerCloudBilling } from './cloudBilling';
import { DaemonAuthClient, type AccountApi } from './daemonAccount';
const messages:Record<string,string>={cancelled:'已停止本机登录流程。已被服务器接受的兑换无法保证撤回；必要时请重新登录。',busy:'此窗口已有登录流程，请先完成或取消。',
 not_available:'测试服务尚未开启登录，暂时不能完成授权。',rate_limited:'请求较多，请稍后再试。',rejected:'授权未完成或请求已失效，请重新登录。',
 network:'网络请求未完成。为避免重复兑换，不会自动重试；请重新发起。',invalid_response:'认证服务响应不符合协议，已停止操作。',storage:'安全存储暂不可用，请重试。',
 browser_failed:'未能打开系统浏览器，请检查 VS Code 的外部链接设置。',expired:'本次登录已超时，请重新发起。',
 card_unavailable:'订阅卡暂不可用，请核对卡密及所属账号；不会因此扣除其他订阅时长。',
 card_result_unknown:'兑换结果尚未确认。请保留原卡密，在原账号下核对或重试同一张卡；重复兑换不会重复加时。不要因此重新付款。'};
/** Only non-secret immutable receipts live in extension-managed globalStorageUri.
 * Tokens, Google credentials and PKCE verifiers are NEVER written through workspace.fs/globalState.
 */
function receiptPort(directory:Uri,origin:string):ReceiptPort {
 return {
  list:async()=>{
   const entries=await workspace.fs.readDirectory(directory),rows:Receipt[]=[];
   for(const [name,type] of entries){
    if(type!==1||!/^\d{16}_[0-9a-f-]{36}_(login|logout)\.json$/.test(name))continue;
    try {const data=await workspace.fs.readFile(Uri.joinPath(directory,name));if(data.length>2048)throw new CloudAuthError('storage');
     const value:unknown=JSON.parse(Buffer.from(data).toString('utf8'));if(!validReceipt(value,origin)||receiptName(value,origin)!==name)throw new CloudAuthError('storage');rows.push(value);
    }catch(error){if((error as {code?:string})?.code!=='FileNotFound')throw new CloudAuthError('storage');}
   }
   return rows;
  },
  put:async value=>{await workspace.fs.writeFile(Uri.joinPath(directory,receiptName(value,origin)),Buffer.from(JSON.stringify(value),'utf8'));},
  remove:async value=>{try {await workspace.fs.delete(Uri.joinPath(directory,receiptName(value,origin)));}catch(error){if((error as {code?:string})?.code!=='FileNotFound')throw error;}},
 };
}
export function registerCloudAccount(context:ExtensionContext,onView:(view:AuthView)=>void=()=>{},bridge?:Pick<ControlApi,'entitlement'>&Partial<AccountApi&Pick<ControlApi,'health'>>):Disposable {
 const endpoint = resolveCloudEndpoint(); // Locked by the build, not VS Code settings.
 const origin=endpoint?.origin??'',prefix=origin?cloudAuthPrefix(origin):'blackhole.cloud-auth.v1.invalid.';
 const directory=Uri.joinPath(context.globalStorageUri,'cloud-auth-v1',createHash('sha256').update(origin||'invalid-cloud-environment').digest('hex'));
 const clientId=origin?createHash('sha256').update('blackhole-installation-v1\0'+origin+'\0'+env.machineId).digest('base64url'):'';
 let clientReady:Promise<CloudAuthClient>|undefined,initializationFailed=false;
 let disposed=false,revision=0,checking=false,controller:AbortController|undefined;
 const recoveryAbort=new AbortController();let lastDaemonId:string|undefined,recoveryPending:Promise<AuthView|undefined>|undefined;
 // Share initialization, but never permanently cache a rejected directory IO.
 // Passive polls do not retry a failed initialization; startup/new-daemon/user
 // actions may request another bounded attempt after the filesystem recovers.
 const getLocal=(explicitRetry=false):Promise<CloudAuthClient>=>{
  if(disposed)return Promise.reject(new CloudAuthError('cancelled'));
  if(clientReady)return clientReady;
  if(initializationFailed&&!explicitRetry)return Promise.reject(new CloudAuthError('storage'));
  initializationFailed=false;
  const pending=(async()=>{
   if(!endpoint)throw new CloudAuthError('not_available');
   for(let attempt=0;attempt<3;attempt++){
    if(disposed)throw new CloudAuthError('cancelled');
    try {await workspace.fs.createDirectory(directory);break;}
    catch {if(attempt===2)throw new CloudAuthError('storage');await authSleep((attempt+1)*250,recoveryAbort.signal);}
   }
   if(disposed)throw new CloudAuthError('cancelled');
   return new CloudAuthClient({origin,secrets:context.secrets,receipts:receiptPort(directory,origin),clientId,
    fetch:(input,init)=>globalThis.fetch(input,init),openExternal:async url=>env.openExternal(Uri.parse(url))});
  })().catch(error=>{if(clientReady===pending){clientReady=undefined;initializationFailed=true;}throw error;});
  clientReady=pending;return pending;
 };
 // Plan 6.11: a daemon with its own OS credential store owns the account. The UI below
 // only sees CloudAuthClient-shaped objects, so what the user sees stays the same.
 const accountApi=bridge?.account&&bridge.health?bridge as AccountApi&Pick<ControlApi,'health'>:undefined;
 const migratedKey='blackhole.account.migrated.'+createHash('sha256').update(origin||'invalid').digest('hex').slice(0,16);
 let backend:{client:CloudAuthClient;daemon:boolean}|undefined,choosing:Promise<CloudAuthClient>|undefined;
 const getClient=(explicitRetry=false):Promise<CloudAuthClient>=>{
  if(!accountApi)return getLocal(explicitRetry);
  if(backend)return Promise.resolve(backend.client);
  if(choosing)return choosing;
  const pending=(async()=>{
   let health:Awaited<ReturnType<ControlApi['health']>>|undefined;
   try{health=await accountApi.health(3000);}catch{health=undefined;}
   if(!health||!(Number(health.account_api_version)>=1)||health.account_storage!=='available'||health.cloud_origin!==origin){
    const local=await getLocal(explicitRetry);if(health)backend={client:local,daemon:false};return local;
   }
   const daemon=new DaemonAuthClient(accountApi) as unknown as CloudAuthClient;
   if(!context.globalState.get(migratedKey)){
    // One-time move of this window's existing login; the local copy stays as a backup.
    let credential;
    try{credential=await (await getLocal(explicitRetry)).migrationCredential();}catch{credential=undefined;}
    try{
     if(credential)await accountApi.accountMigrate(credential);
     if(credential!==undefined)await context.globalState.update(migratedKey,Date.now());
    }catch{return getLocal(explicitRetry);} // daemon unreachable mid-way: keep using the local login, retry later
   }
   backend={client:daemon,daemon:true};return daemon;
  })().finally(()=>{if(choosing===pending)choosing=undefined;});
  choosing=pending;return pending;
 };
 const worker=randomBytes(18).toString('base64url');let bridgePending:Promise<void>|undefined,forceGate=true,forceRevision=0;
 let clockSample={wall:Date.now(),mono:performance.now()};
 const syncGate=(force=false):Promise<void>=>{
  const now={wall:Date.now(),mono:performance.now()};
  force ||= Math.abs((now.wall-clockSample.wall)-(now.mono-clockSample.mono))>5000;clockSample=now;
  if(force){forceGate=true;forceRevision++;}
  if(!bridge||disposed||backend?.daemon)return Promise.resolve();
  if(bridgePending)return bridgePending;
  const pending=(async()=>{
   for(let pass=0;pass<3&&!disposed;pass++){
    const requested=forceRevision;let challenge:string|undefined;
    let target:{cloud_origin:string;daemon_id?:string}={cloud_origin:origin};
    try {
     const client=await getClient(),identity=await client.gateIdentity();if(disposed)return;
     const bound=await bridge.entitlement('identity',{identity,...target});if(disposed)return;
     target={...target,daemon_id:bound.daemon_id};
     if(forceGate){
      await bridge.entitlement('refresh',target);
      // Consume only acknowledged requests; retain a newer explicit refresh.
      if(forceRevision===requested)forceGate=false;
     }
     if(disposed)return;
     const job=(await bridge.entitlement('claim',{worker,...target})).pending;
     if(job){
      challenge=job.challenge;
      const ticket=await client.entitlementProof(job.challenge,job.sessionId);
      if(disposed)throw new Error('disposed');
      await bridge.entitlement('complete',{challenge,ticket,...target});
     }
    }catch{if(challenge)await bridge.entitlement('fail',{challenge,...target}).catch(()=>undefined);return;}
    if(requested===forceRevision)return;
   }
  })().finally(()=>{if(bridgePending===pending)bridgePending=undefined;});
  bridgePending=pending;return pending;
 };
 const render=(view:AuthView)=>onView(view);
 const refresh=async(verify=false,recover=false):Promise<AuthView|undefined>=>{
  const stamp=++revision;
  try {
   const client=await getClient(verify);if(disposed)return undefined;
   if(verify){
    if(recover)await client.restore(recoveryAbort.signal);else await client.check(recoveryAbort.signal);
    if(disposed)return undefined;
    await syncGate(true);
    // Read the selected credential again: polling must not suppress completed
    // verification, and an old response must not restore a logged-out account.
    return refresh();
   }
   void syncGate();
   const value=await client.view();if(!disposed&&stamp===revision)render(value);return value;
  }catch{if(!disposed&&stamp===revision)render({state:'unavailable'});return undefined;}
 };
 const restoreView=():Promise<AuthView|undefined>=>{
  if(recoveryPending)return recoveryPending;
  const pending=refresh(true,true).finally(()=>{if(recoveryPending===pending)recoveryPending=undefined;});
  recoveryPending=pending;return pending;
 };
 const report=(error:unknown)=>{if(!disposed)void window.showWarningMessage('BlackHole：'+(error instanceof CloudAuthError?messages[error.code]:messages.storage));};
 const signIn=async()=>{
  if(controller){void window.showInformationMessage('BlackHole：此窗口已有登录流程。');return;}
  const abort=new AbortController();controller=abort;
  try {
   const client=await getClient(true);
   await window.withProgress({location:ProgressLocation.Notification,title:'BlackHole：登录，请在系统浏览器中选择登录方式',cancellable:true},async(_progress,cancellation)=>{
    const subscription=cancellation.onCancellationRequested(()=>abort.abort());if(cancellation.isCancellationRequested)abort.abort();
    try {return await client.signIn(abort.signal);}finally{subscription.dispose();}
   });
   const view=await refresh();if(!disposed)void window.showInformationMessage(view?.state==='verified'?'BlackHole：登录已验证，并同步至共享此存储的窗口。':'BlackHole：账号状态已更新，请点击账号状态检查。');
  }catch(error){report(error);}finally{if(controller===abort)controller=undefined;await refresh();}
 };
 let redeemBusy=false;
 const registrations=[
  commands.registerCommand('blackhole.accountSignIn',()=>signIn()),

  commands.registerCommand('blackhole.accountRedeemCard',async()=>{
   if(redeemBusy||controller){void window.showInformationMessage('BlackHole：请先完成当前登录或兑换。');return;}
   redeemBusy=true;
   try {
    const client=await getClient(true),view=await client.view();
    if(!view.userId||view.state==='logged_out'){void window.showWarningMessage('BlackHole：请先登录要接收订阅时长的账号。');return;}
    const code=await window.showInputBox({title:'兑换 BlackHole 订阅卡',prompt:'兑换后绑定当前账号，不可转移。请勿在聊天或工作区保存卡密。',password:true,ignoreFocusOut:false,
     validateInput:value=>value.length<=160&&/^BH1[0-9A-F]{48}$/.test(value.replace(/[\s-]/g,'').toUpperCase())?undefined:'请输入完整 BH1 订阅卡密。'});
    if(!code||disposed)return;
    if(await window.showWarningMessage(`确认将订阅卡绑定到账号 ${view.userId}？时长会叠加到该账号现有权益之后。`,{modal:true},'确认兑换')!=='确认兑换'||disposed)return;
    const result=await client.redeemCard(code,view.userId);
    // Accounting has succeeded. Neither a later network failure nor another window's login can undo it.
    await refresh(true);
    if(!disposed)void window.showInformationMessage(`BlackHole：${result.duplicate?'此卡已为该账号兑换，本次未重复加时':'订阅卡兑换已到账'}。账号 ${result.userId}；已请求更新本机权益，暂不可验证时请稍后点击“刷新订阅”。`);
   }catch(error){report(error);}finally{redeemBusy=false;}
  }),
  commands.registerCommand('blackhole.accountSignOut',async()=>{
   try {
    if(await window.showWarningMessage('退出当前 BlackHole 插件账号？',{modal:true},'退出')!=='退出')return;
    controller?.abort();const client=await getClient(true);await client.signOut();await refresh();
    if(!disposed)void window.showInformationMessage('BlackHole：所选插件会话已退出。若另一窗口完成了新登录，将以最新登录为准。');
   }catch(error){report(error);await refresh();}
  }),
  commands.registerCommand('blackhole.accountStatus',async()=>{
   const view=await refresh(true);if(!view||disposed)return;
   if(view.state==='logged_out'){
    if(await window.showInformationMessage('BlackHole：尚未登录。','登录')==='登录')await commands.executeCommand('blackhole.accountSignIn');
   }else void window.showInformationMessage(view.state==='verified'?'BlackHole：当前插件会话已通过服务端验证。':'BlackHole：当前暂不能确认会话有效，不会据此延长服务权限。');
  }),
  context.secrets.onDidChange(event=>{if(event.key.startsWith(prefix))void refresh();}),
  window.onDidChangeWindowState(state=>{if(state.focused)void refresh();}),
  commands.registerCommand('blackhole.accountSnapshot',(event?:{daemonId?:unknown})=>{
   const daemonId=event?.daemonId;
   if(typeof daemonId==='string'&&daemonId.length>0&&daemonId.length<=128&&daemonId!==lastDaemonId){
    lastDaemonId=daemonId;backend=undefined;
    // One recovery per observed daemon incarnation, not one per UI poll.
    void syncGate(true);
    return restoreView();
   }
   return refresh();
  }),
  commands.registerCommand('blackhole.accountRefresh',async()=>{
   const view=await refresh(true);if(!view||disposed)return;
   if(view.state==='verified')void window.showInformationMessage('BlackHole：订阅状态已刷新。');
   else if(view.state==='logged_out')void window.showWarningMessage('BlackHole：尚未登录，无法刷新订阅。');
   else void window.showWarningMessage('BlackHole：订阅状态暂时无法验证，请稍后重试。');
  }),
 ];
 // Local receipts/UI sync ONLY; never schedule cloud requests from this timer.
 const timer=setInterval(()=>{
  if(disposed||checking)return;
  checking=true;void refresh().finally(()=>{checking=false;});
 },2000);timer.unref();
 void restoreView(); // Startup/reload gets bounded read-only recovery, never a new login.
 return Disposable.from(registerCloudBilling(()=>getClient(true)),...registrations,new Disposable(()=>{disposed=true;revision++;recoveryAbort.abort();controller?.abort();clearInterval(timer);}));
}
