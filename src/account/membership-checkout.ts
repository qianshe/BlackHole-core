/** Native-only checkout validation. Provider URLs never cross the local renderer boundary. */
export function parseMembershipCheckout(value: unknown, origin: string, now: number): { checkoutUrl: string; expiresAt: number } {
  const bad = (): never => { throw new Error('membership_checkout_invalid'); };
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'checkoutUrl,expiresAt') return bad();
  const v = value as Record<string, unknown>;
  if (typeof v.checkoutUrl !== 'string' || v.checkoutUrl.length > 2048 || /[\u0000-\u0020\u007f]/.test(v.checkoutUrl) || typeof v.expiresAt !== 'number' || !Number.isSafeInteger(v.expiresAt) || v.expiresAt <= now || v.expiresAt > now + 600) return bad();
  const u = new URL(v.checkoutUrl), p = new URLSearchParams(u.hash.slice(1));
  if (u.protocol !== 'https:' || u.origin !== origin || u.pathname !== '/api/billing/membership/checkout' || u.username || u.password || u.search || [...p.keys()].sort().join(',') !== 'checkout,flow' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(p.get('flow') ?? '') || !/^[A-Za-z0-9_-]{43}$/.test(p.get('checkout') ?? '')) return bad();
  return { checkoutUrl: v.checkoutUrl, expiresAt: v.expiresAt };
}
