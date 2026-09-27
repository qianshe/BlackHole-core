// Public trust only. Signing private keys never ship. Standalone source builds retain production defaults.
declare const __BLACKHOLE_ENTITLEMENT_TRUST__: { origin: string; publicKey: string };
const trust = typeof __BLACKHOLE_ENTITLEMENT_TRUST__ === 'undefined'
 ? { origin: 'https://blackhole.stellarbridge.dpdns.org', publicKey: 'MCowBQYDK2VwAyEAhdJo6ndymroW5cuo/tsGYqB+Ge0GQos0gkUmjHo7Jk0=' }
 : __BLACKHOLE_ENTITLEMENT_TRUST__;
export const ENTITLEMENT_SPKI = trust.publicKey;
export const ENTITLEMENT_ORIGIN = trust.origin;
