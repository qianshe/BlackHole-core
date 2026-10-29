import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {readProfiles as readStoredProfiles,validateProfiles,clientTarget,validatePublicKey,PRODUCTION_ORIGIN,PRODUCTION_KEY} from './environment-config.mjs';
const readProfiles=()=>readStoredProfiles({loadTest:false});
const key=()=>generateKeyPairSync('ed25519').publicKey.export({format:'der',type:'spki'}).toString('base64');
test('public client profiles contain no deployment fields and need no private config files',()=>{
 const p=readProfiles();
 for(const value of Object.values(p))assert.deepEqual(Object.keys(value).sort(),['clientTarget','entitlementPublicKey','environment','origin','schema']);
 const source=readFileSync(new URL('./environment-config.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(source,/process\.env|from ['"]dotenv/); // no ambient configuration; test.json is explicit public data
 assert.equal(clientTarget('production').origin,PRODUCTION_ORIGIN);
 assert.equal(clientTarget('production').entitlementPublicKey,PRODUCTION_KEY);
});
test('default test profile is deterministic, synthetic and distinct from official trust',()=>{
 const p=readProfiles();assert.deepEqual(p,readProfiles());
 assert.match(p.test.origin,/\.example\.org$/);assert.notEqual(p.test.origin,PRODUCTION_ORIGIN);assert.notEqual(p.test.entitlementPublicKey,PRODUCTION_KEY);
 validatePublicKey(p.test.entitlementPublicKey);assert.equal(p.test.clientTarget,'test');
});
test('callers cannot mutate the next profile or the selected frozen target',()=>{
 const p=readProfiles();p.test.origin='https://changed.example.org';assert.notEqual(readProfiles().test.origin,p.test.origin);
 assert.ok(Object.isFrozen(clientTarget('test')));
});
test('private deployment fields and arbitrary profile keys are rejected',()=>{
 for(const field of ['accountId','databaseId','workerName','paymentControls','ownerEmail','secret']){
  const p=readProfiles();p.test[field]='synthetic-forbidden-value';assert.throws(()=>validateProfiles(p));
 }
 for(const change of [p=>delete p.test,p=>p.other={},p=>p.production.schema=2,p=>p.test.environment='production']){const p=readProfiles();change(p);assert.throws(()=>validateProfiles(p));}
});
test('official issuer and key cannot be replaced or mixed with independent test trust',()=>{
 for(const change of [p=>p.production.origin='https://other.example.org',p=>p.production.entitlementPublicKey=key(),p=>p.production.clientTarget='test',p=>p.test.origin=PRODUCTION_ORIGIN,p=>p.test.entitlementPublicKey=PRODUCTION_KEY]){const p=readProfiles();change(p);assert.throws(()=>validateProfiles(p));}
});
test('incomplete independent test profiles fail closed without blocking official selection',()=>{
 for(const field of ['origin','entitlementPublicKey']){const p=readProfiles();p.test[field]=null;assert.throws(()=>clientTarget('test',p),/incomplete/);assert.equal(clientTarget('production',p).origin,PRODUCTION_ORIGIN);}
 assert.throws(()=>clientTarget('unknown'));
});
test('test-to-production aliases are rejected rather than silently changing services',()=>{
 const p=readProfiles();p.test.clientTarget='production';assert.throws(()=>clientTarget('test',p));assert.equal(readProfiles().test.clientTarget,'test');
});
test('Ed25519 public trust rejects malformed and non-Ed25519 keys',()=>{
 const rsa=generateKeyPairSync('rsa',{modulusLength:2048}).publicKey.export({format:'der',type:'spki'}).toString('base64');
 for(const value of ['',null,'not-a-key',PRODUCTION_KEY+'\n',rsa])assert.throws(()=>validatePublicKey(value));
});
