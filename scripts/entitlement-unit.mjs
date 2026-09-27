import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {EntitlementGate,IDLE_MS} from '../dist/cloud/entitlement-gate.js';
import {SessionRuntime} from '../dist/runtime.js';
const origin='https://test.invalid',keys=generateKeyPairSync('ed25519'),spki=keys.publicKey.export({format:'der',type:'spki'}).toString('base64');
const worker='worker_for_unit_tests';let count=0;
function fixture(){let wall=1_800_000_000_000,mono=0;const clock={wall:()=>wall,mono:()=>mono};const gate=new EntitlementGate(spki,origin,clock);
 const identity={userId:'user',clientId:'client',sessionId:'session',loginOrder:1,expiresAt:wall/1000+7*86400,kind:'login'};
 const move=(ms,wallOnly=false)=>{wall+=ms;if(!wallOnly)mono+=ms;};
 const grant=(changes={},key=keys.privateKey)=>{const job=gate.claim(worker);assert.ok(job);const c={schema:1,issuer:origin,audience:'blackhole-daemon',challenge:job.challenge,...identity,issuedAt:Math.floor(wall/1000),expiresAt:Math.floor(wall/1000)+72*3600,...changes};delete c.kind;
  const bytes=Buffer.from(JSON.stringify(c));gate.complete(job.challenge,{payload:bytes.toString('base64url'),signature:sign(null,bytes,key).toString('base64url')});};
 return {gate,identity,move,grant};}
async function test(name,fn){await fn();console.log('PASS '+name);count++;}
await test('no credentials fails closed',async()=>{const f=fixture();await assert.rejects(f.gate.beforeToolCall());});
await test('startup, first call and concurrent requests use one challenge',async()=>{const f=fixture();f.gate.setIdentity(f.identity);const a=f.gate.beforeToolCall(),b=f.gate.beforeToolCall();f.grant();await Promise.all([a,b]);assert.equal(f.gate.claim(worker),null);await f.gate.beforeToolCall();});
await test('continuous calls beyond thirty minutes do not schedule periodic cloud checks',async()=>{const f=fixture();f.gate.setIdentity(f.identity);const p=f.gate.beforeToolCall();f.grant();await p;
 for(let n=0;n<10;n++){f.move(29*60_000);await f.gate.beforeToolCall();assert.equal(f.gate.claim(worker),null);}f.gate.invalidate();});
await test('exactly thirty minutes is cached; greater idle gap refreshes only on next call',async()=>{const f=fixture();f.gate.setIdentity(f.identity);let p=f.gate.beforeToolCall();f.grant();await p;f.move(IDLE_MS);await f.gate.beforeToolCall();f.move(IDLE_MS+1);assert.equal(f.gate.claim(worker),null);p=f.gate.beforeToolCall();f.grant();await p;});
await test('expired signed ticket refreshes even during continuous activity',async()=>{const f=fixture();f.gate.setIdentity(f.identity);let p=f.gate.beforeToolCall();f.grant({expiresAt:1_800_000_060});await p;f.move(61_000);p=f.gate.beforeToolCall();f.grant();await p;});
for(const [name,changes] of Object.entries({challenge:{challenge:'wrong'},audience:{audience:'plugin'},issuer:{issuer:'https://evil.invalid'},account:{userId:'other'},session:{sessionId:'other'},client:{clientId:'other'},order:{loginOrder:2},expired:{expiresAt:1_799_999_999},lifetime:{expiresAt:1_800_000_000+73*3600}})){
 await test('reject '+name,async()=>{const f=fixture();f.gate.setIdentity(f.identity);const p=f.gate.beforeToolCall();const rejected=assert.rejects(p);assert.throws(()=>f.grant(changes));await rejected;});}
await test('wrong signing key cannot grant',async()=>{const f=fixture();f.gate.setIdentity(f.identity);const p=f.gate.beforeToolCall(),rejected=assert.rejects(p);assert.throws(()=>f.grant({},generateKeyPairSync('ed25519').privateKey));await rejected;});
await test('credential changes reject in-flight proof and stale logout cannot resurrect session',async()=>{const f=fixture();f.gate.setIdentity(f.identity);const p=f.gate.beforeToolCall(),rejected=assert.rejects(p);f.gate.setIdentity({...f.identity,kind:'logout'});await rejected;f.gate.setIdentity(f.identity);await assert.rejects(f.gate.beforeToolCall());});
await test('clock rollback forces online verification rather than extending lease',async()=>{const f=fixture();f.gate.setIdentity(f.identity);let p=f.gate.beforeToolCall();f.grant();await p;f.move(-10_000,true);p=f.gate.beforeToolCall();const rejected=assert.rejects(p);const job=f.gate.claim(worker);assert.ok(job);f.gate.fail(job.challenge);await rejected;});
await test('failed check never reaches queued tool body',async()=>{const f=fixture();f.gate.setIdentity(f.identity);const rt=new SessionRuntime({workspace_path:'.',cwd:'.'},{});rt.beforeExecute=()=>f.gate.ensure();let executed=0;const p=rt.serialize(async()=>{executed++;});const rejected=assert.rejects(p);await Promise.resolve();const job=f.gate.claim(worker);f.gate.fail(job.challenge);await rejected;assert.equal(executed,0);});
console.log(`Entitlement gate: ${count} tests passed; no cloud requests or real credentials used.`);
