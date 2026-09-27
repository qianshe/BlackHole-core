// Public CLIENT build profiles only. No filesystem, dotenv, deployment identity or credentials.
// Official trust is unchanged. The test default is deliberately a non-service example domain.
import { createPublicKey } from 'node:crypto';
export const PRODUCTION_ORIGIN = 'https://blackhole.stellarbridge.dpdns.org';
export const PRODUCTION_KEY = 'MCowBQYDK2VwAyEAhdJo6ndymroW5cuo/tsGYqB+Ge0GQos0gkUmjHo7Jk0=';
const TEST_ORIGIN = 'https://blackhole-build-fixture.example.org';
// Throwaway verification key only; no private counterpart is distributed or used by a service.
const TEST_KEY = 'MCowBQYDK2VwAyEALlwA8WacXutuxBJ7hA4ISMQ6hDPw1QoI0ydHBKFuHYA=';
const fields = ['schema', 'environment', 'clientTarget', 'origin', 'entitlementPublicKey'].sort();
const fail = () => { throw new Error('Invalid public client profile; values omitted. Deployment configuration is not supported.'); };
export function validateOrigin(origin) {
  let u; try { u = new URL(origin); } catch { fail(); }
  if (typeof origin !== 'string' || origin.length > 512 || u.origin !== origin || u.protocol !== 'https:' || u.username || u.password || u.port || u.pathname !== '/' || u.search || u.hash || !u.hostname.includes('.') || /^\d+(?:\.\d+){3}$/.test(u.hostname) || /(?:^|\.)(?:localhost|invalid|example|test)$/.test(u.hostname)) fail();
  return origin;
}
export function validatePublicKey(value) {
  try {
    if (typeof value !== 'string' || value.length > 256 || !/^[-A-Za-z0-9+/]+={0,2}$/.test(value)) fail();
    const bytes = Buffer.from(value, 'base64');
    const key = createPublicKey({ key: bytes, format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519' || key.export({ format: 'der', type: 'spki' }).toString('base64') !== value) fail();
    return value;
  } catch { fail(); }
}
export function validateProfiles(profiles) {
  if (!profiles || typeof profiles !== 'object' || Object.keys(profiles).sort().join(',') !== 'production,test') fail();
  for (const name of ['production', 'test']) {
    const p = profiles[name];
    if (!p || typeof p !== 'object' || Object.keys(p).sort().join(',') !== fields.join(',') || p.schema !== 1 || p.environment !== name || !['production', 'test'].includes(p.clientTarget)) fail();
    if (p.origin !== null) validateOrigin(p.origin);
    if (p.entitlementPublicKey !== null) validatePublicKey(p.entitlementPublicKey);
  }
  const p = profiles.production, t = profiles.test;
  if (p.clientTarget !== 'production' || p.origin !== PRODUCTION_ORIGIN || p.entitlementPublicKey !== PRODUCTION_KEY) fail();
  if (t.origin === PRODUCTION_ORIGIN || t.entitlementPublicKey === PRODUCTION_KEY) fail();
  return profiles;
}
export function readProfiles() {
  // New values on every call. No developer-specific config/environments directory is required.
  return validateProfiles({
    production: { schema: 1, environment: 'production', clientTarget: 'production', origin: PRODUCTION_ORIGIN, entitlementPublicKey: PRODUCTION_KEY },
    test: { schema: 1, environment: 'test', clientTarget: 'test', origin: TEST_ORIGIN, entitlementPublicKey: TEST_KEY },
  });
}
export function requireComplete(target) {
  if (!target || target.origin === null || target.entitlementPublicKey === null) throw new Error('Client environment target is incomplete; configure an independent test origin and public key.');
  return target;
}
export function clientTarget(environment, profiles = readProfiles()) {
  validateProfiles(profiles);
  if (!['production', 'test'].includes(environment)) fail();
  // Explicit test fixtures may select the official client target; deployment routing is absent.
  return Object.freeze({ ...requireComplete(profiles[profiles[environment].clientTarget]) });
}
