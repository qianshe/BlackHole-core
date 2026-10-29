// Public trust only. Signing private keys never ship. Standalone source builds retain production defaults.
import { productionProfile } from '../environments/production.cjs';
declare const __BLACKHOLE_ENTITLEMENT_TRUST__: { origin: string; publicKey: string };
const trust = typeof __BLACKHOLE_ENTITLEMENT_TRUST__ === 'undefined'
 ? { origin: productionProfile.origin, publicKey: productionProfile.entitlementPublicKey }
 : __BLACKHOLE_ENTITLEMENT_TRUST__;
export const ENTITLEMENT_SPKI = trust.publicKey;
export const ENTITLEMENT_ORIGIN = trust.origin;
