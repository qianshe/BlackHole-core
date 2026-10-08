// Public CLIENT build profiles only. No dotenv, ambient environment, deployment identity or secrets.
// Production identity is versioned JSON shared with standalone runtime defaults.
// Optional ignored test.json holds ONLY the public test origin/key.
// The fallback fixture is for offline source-build tests, never an installable/release artifact.
import { createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
const productionProfile = Object.freeze(JSON.parse(readFileSync(new URL('../src/environments/production.json', import.meta.url), 'utf8')));
const testFixture = Object.freeze(JSON.parse(readFileSync(new URL('./fixtures/cloud-test-profile.json', import.meta.url), 'utf8')));
export const PRODUCTION_ORIGIN = productionProfile.origin;
export const PRODUCTION_KEY = productionProfile.entitlementPublicKey;
const TEST_KEY = testFixture.entitlementPublicKey;
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
    if (!p || typeof p !== 'object' || Object.keys(p).sort().join(',') !== fields.join(',') || p.schema !== 1 || p.environment !== name || p.clientTarget !== name) fail();
    if (p.origin !== null) validateOrigin(p.origin);
    if (p.entitlementPublicKey !== null) validatePublicKey(p.entitlementPublicKey);
  }
  const p = profiles.production, t = profiles.test;
  if (p.clientTarget !== 'production' || p.origin !== PRODUCTION_ORIGIN || p.entitlementPublicKey !== PRODUCTION_KEY) fail();
  if (t.origin === PRODUCTION_ORIGIN || t.entitlementPublicKey === PRODUCTION_KEY) fail();
  return profiles;
}
export function readProfiles({loadTest = true, testProfilePath = new URL('../config/environments/test.json', import.meta.url)} = {}) {
  const profiles = {
    production: { ...productionProfile },
    test: { ...testFixture },
  };
  if (loadTest) {
    let text;
    try { text = readFileSync(testProfilePath, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') fail(); }
    if (text !== undefined) {
      try { if (Buffer.byteLength(text) > 8192) fail(); profiles.test = JSON.parse(text); }
      catch { fail(); }
    }
  }
  return validateProfiles(profiles);
}
/** Distribution gate, separate from offline fixture validation. Never infer service readiness from a filename. */
export function assertServiceBuild(build) {
  if (!build || !['production', 'test'].includes(build.environment)) fail();
  const origin = validateOrigin(build.origin), host = new URL(origin).hostname;
  validatePublicKey(build.entitlementPublicKey);
  if (/(?:^|\.)example\.(?:com|net|org)$|(?:^|\.)(?:example|invalid|test|localhost)$/i.test(host)
      || /(?:^|[.-])(?:ci-fixture|build-fixture)(?:[.-]|$)/i.test(host)
      || build.entitlementPublicKey === TEST_KEY) {
    throw new Error('Fixture/example configuration cannot be packaged or installed. Set config/environments/test.json or pass --cloud-origin AND --cloud-public-key; use --environment production for the official service.');
  }
  if (build.environment === 'production' && (origin !== PRODUCTION_ORIGIN || build.entitlementPublicKey !== PRODUCTION_KEY)) fail();
  if (build.environment === 'test' && (origin === PRODUCTION_ORIGIN || build.entitlementPublicKey === PRODUCTION_KEY)) {
    throw new Error('A test package must use independent test origin and signing trust, never production.');
  }
  return build;
}
export function requireComplete(target) {
  if (!target || target.origin === null || target.entitlementPublicKey === null) throw new Error('Client environment target is incomplete; configure an independent test origin and public key.');
  return target;
}
export function clientTarget(environment, profiles = readProfiles()) {
  validateProfiles(profiles);
  if (!['production', 'test'].includes(environment)) fail();
  // No test-to-production alias. Environment names select independent client trust.
  return Object.freeze({ ...requireComplete(profiles[environment]) });
}

// Reject malformed, secret-bearing, or fixture-valued checked-in production configuration.
validateProfiles({ production: { ...productionProfile }, test: { ...testFixture } });
assertServiceBuild(productionProfile);
