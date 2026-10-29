import { createPublicKey, randomBytes, verify, type KeyObject } from 'node:crypto';
export const IDLE_MS=30*60_000;
export interface GateIdentity {userId:string;clientId:string;sessionId:string;loginOrder:number;expiresAt:number;kind:'login'|'logout'}
interface Ticket {payload:string;signature:string}
interface Pending {challenge:string;wall:number;mono:number;identity:GateIdentity;promise:Promise<void>;resolve:()=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>;claimed?:string}
const denied=()=>new Error('entitlement_verification_required: BlackHole 订阅已到期或账号需要重新登录，请打开 BlackHole 处理后重试；校验失败不会执行工具');
/** No bearer, private key, cloud polling or persisted authorization booleans. */
export class EntitlementGate {
 private readonly key:KeyObject;
 private identity?:GateIdentity; private pending?:Pending;
 private lease?:{wall:number;mono:number;duration:number};
 private lastCall?:number; private observed?:{wall:number;mono:number};
 private prover?:(challenge:string,sessionId:string)=>Promise<Ticket|null>;
 private readonly listeners=new Set<()=>void>(); private expiryTimer?:ReturnType<typeof setTimeout>;
 constructor(spki:string,private readonly origin:string,private readonly clock={wall:Date.now,mono:()=>performance.now()}) {
  this.key=createPublicKey({key:Buffer.from(spki,'base64'),format:'der',type:'spki'});
 }
 /** Called when the local ticket may have changed (login/logout, new ticket, invalidated, expired). */
 onChange(fn:()=>void):()=>void {this.listeners.add(fn);return ()=>{this.listeners.delete(fn);};}
 private notify():void {for(const fn of this.listeners){try{fn();}catch{/* listener errors never reach the gate */}}}
 /** Read-only: is there a verified, unexpired ticket right now? No network, no challenge. */
 valid():boolean {return this.fresh();}
 /**
  * For feature gates outside tool calls (Courier): a valid local ticket is enough; only without one
  * is a new ticket requested. Unlike beforeToolCall, idle time never forces a new challenge.
  */
 async access():Promise<boolean> {
  if(this.fresh())return true;
  try{await this.ensure(true);return true;}catch{return false;}
 }
 /** Public build identity; never a credential or authorization decision. */
 get cloudOrigin():string {return this.origin;}
 setIdentity(value:unknown):void {
  if(!value||typeof value!=='object')throw denied();
  const i=value as GateIdentity;
  if(!['login','logout'].includes(i.kind)||!Number.isSafeInteger(i.loginOrder)||i.loginOrder<0
   ||!Number.isSafeInteger(i.expiresAt)||['userId','clientId','sessionId'].some(k=>typeof (i as unknown as Record<string,unknown>)[k]!=='string')
   ||i.userId.length>128||i.clientId.length>128||i.sessionId.length>128)throw denied();
  if(this.identity&&(i.loginOrder<this.identity.loginOrder||(i.loginOrder===this.identity.loginOrder&&this.identity.kind==='logout'&&i.kind==='login')))return;
  const next={userId:i.userId,clientId:i.clientId,sessionId:i.sessionId,loginOrder:i.loginOrder,expiresAt:i.expiresAt,kind:i.kind};
  if(JSON.stringify(next)===JSON.stringify(this.identity))return;
  this.invalidate();this.identity=next;this.lastCall=undefined;this.notify();
  if(i.kind==='login')void this.ensure(true).catch(()=>undefined); // credential/startup event, never a timer
 }
 /** The daemon's own account answers challenges first; null leaves the challenge for the extension bridge. */
 setProver(fn:(challenge:string,sessionId:string)=>Promise<Ticket|null>):void {this.prover=fn;}
 invalidate():void {const had=!!this.lease;this.lease=undefined;const p=this.pending;this.pending=undefined;if(p){clearTimeout(p.timer);p.reject(denied());}if(had)this.notify();}
 private fresh():boolean {
  const wall=this.clock.wall(),mono=this.clock.mono(),old=this.observed;this.observed={wall,mono};
  if(old&&(mono<old.mono||Math.abs((wall-old.wall)-(mono-old.mono))>5000)){this.invalidate();return false;}
  const l=this.lease;return !!l&&!!this.identity&&this.identity.kind==='login'&&wall<this.identity.expiresAt*1000
   &&Math.max(wall-l.wall,mono-l.mono)<l.duration&&wall>=l.wall&&mono>=l.mono;
 }
 async beforeToolCall():Promise<void> {
  const now=this.clock.mono(),idle=this.lastCall===undefined||now-this.lastCall>IDLE_MS;this.lastCall=now;
  await this.ensure(idle);
 }
 async ensure(force=false):Promise<void> {
  const fresh=this.fresh();
  force ||= this.lastCall!==undefined && this.clock.mono()-this.lastCall>IDLE_MS;
  if(this.pending)return this.pending.promise; // one shared challenge for concurrent callers
  if(!force&&fresh)return;
  this.lease=undefined;
  if(!this.identity||this.identity.kind!=='login'||this.identity.expiresAt*1000<=this.clock.wall())throw denied();
  let resolve!:()=>void,reject!:(e:Error)=>void;
  const promise=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});
  const challenge=randomBytes(32).toString('base64url');
  const timer=setTimeout(()=>{if(this.pending?.challenge===challenge)this.invalidate();},30_000);timer.unref();
  this.pending={challenge,wall:this.clock.wall(),mono:this.clock.mono(),identity:{...this.identity},promise,resolve,reject,timer};
  const own=this.pending,prove=this.prover;
  if(prove){
   own.claimed='daemon-self';
   void prove(challenge,own.identity.sessionId).then(t=>{if(this.pending!==own)return;if(t===null){own.claimed=undefined;return;}try{this.complete(challenge,t);}catch{/* invalidated */}},()=>{if(this.pending===own)own.claimed=undefined;});
  }
  return promise;
 }
 claim(worker:string):{challenge:string;sessionId:string}|null {
  if(!/^[a-zA-Z0-9_-]{16,80}$/.test(worker))throw denied();
  const p=this.pending;if(!p||p.claimed)return null;
  p.claimed=worker;return {challenge:p.challenge,sessionId:p.identity.sessionId};
 }
 complete(challenge:string,ticket:unknown):void {
  const p=this.pending;if(!p||p.challenge!==challenge)throw denied();
  try {
   const t=ticket as Ticket;
   if(!t||typeof t.payload!=='string'||typeof t.signature!=='string'||t.payload.length>4096
    ||!/^[A-Za-z0-9_-]+$/.test(t.payload)||!/^[A-Za-z0-9_-]{86}$/.test(t.signature))throw denied();
   const payload=Buffer.from(t.payload,'base64url');
   if(!verify(null,payload,this.key,Buffer.from(t.signature,'base64url')))throw denied();
   const c=JSON.parse(payload.toString('utf8')) as Record<string,unknown>;
   if(c.schema!==1||c.issuer!==this.origin||c.audience!=='blackhole-daemon'||c.challenge!==p.challenge
    ||c.userId!==p.identity.userId||c.clientId!==p.identity.clientId||c.sessionId!==p.identity.sessionId||c.loginOrder!==p.identity.loginOrder
    ||!Number.isSafeInteger(c.issuedAt)||!Number.isSafeInteger(c.expiresAt))throw denied();
   const issuedAt=c.issuedAt as number,expiresAt=c.expiresAt as number;
   if(expiresAt<=issuedAt||expiresAt-issuedAt>72*3600||expiresAt>p.identity.expiresAt
    ||Math.abs(issuedAt*1000-p.wall)>120_000||expiresAt*1000<=this.clock.wall()
    ||Math.abs((this.clock.wall()-p.wall)-(this.clock.mono()-p.mono))>5000)throw denied();
   // Anchor duration at challenge creation, conservatively subtracting the entire round-trip.
   const duration=(expiresAt-issuedAt)*1000-1000;
   if(this.clock.mono()-p.mono>=duration)throw denied();
   this.lease={wall:p.wall,mono:p.mono,duration};this.pending=undefined;clearTimeout(p.timer);p.resolve();
   // A local timer only tells listeners the ticket ran out; it never contacts the cloud.
   clearTimeout(this.expiryTimer);this.expiryTimer=setTimeout(()=>this.notify(),Math.max(0,duration-(this.clock.mono()-p.mono))+50);this.expiryTimer.unref?.();
   this.notify();
  }catch{this.invalidate();throw denied();}
 }
 fail(challenge:string):void {if(this.pending?.challenge===challenge)this.invalidate();}
}
