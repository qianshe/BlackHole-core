/** Cloud-normalized NowPay duration membership contract. No credentials, buyer or payment facts. */
export const membershipPeriods = ['WEEK', 'MONTH', 'QUARTER', 'YEAR'] as const;
export type MembershipPeriod = typeof membershipPeriods[number];
export interface MembershipPlan { sku: string; displayName: string; amountMinor: number; currency: 'CNY'; durationPeriod: MembershipPeriod }
export interface MembershipCatalogue { enabled: boolean; salesEnabled: boolean; productId: string; productName: string; capabilityStatus: string; plans: MembershipPlan[]; checkedAt: number }
export interface MembershipStatus { decision: 'ALLOW' | 'PURCHASE_REQUIRED' | 'DENY'; validFrom: number | null; validUntil: number | null; legacyExpiresAt: number; canPurchase: boolean; checkedAt: number }
const bad = (): never => { throw new Error('membership_response_invalid'); };
function record(v: unknown, keys: string[]): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join(',') !== [...keys].sort().join(',')) return bad();
  return v as Record<string, unknown>;
}
const second = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const text = (v: unknown, max: number): v is string => typeof v === 'string' && !!v.trim() && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
export function parseMembershipCatalogue(value: unknown): MembershipCatalogue {
  const v = record(value, ['enabled', 'salesEnabled', 'productId', 'productName', 'capabilityStatus', 'plans', 'checkedAt']);
  if (typeof v.enabled !== 'boolean' || typeof v.salesEnabled !== 'boolean' || !text(v.productId, 128) || !text(v.productName, 128) || !text(v.capabilityStatus, 32) || !second(v.checkedAt) || !Array.isArray(v.plans) || v.plans.length > 32) return bad();
  const plans: MembershipPlan[] = v.plans.map(item => {
    const p = record(item, ['sku', 'displayName', 'amountMinor', 'currency', 'durationPeriod']);
    if (!text(p.sku, 32) || !text(p.displayName, 128) || !second(p.amountMinor) || p.amountMinor > 10_000_000_000 || p.currency !== 'CNY' || !membershipPeriods.includes(p.durationPeriod as MembershipPeriod)) return bad();
    return { sku: p.sku, displayName: p.displayName, amountMinor: p.amountMinor, currency: 'CNY', durationPeriod: p.durationPeriod as MembershipPeriod };
  });
  if (new Set(plans.map(p => p.sku)).size !== plans.length || (v.salesEnabled && (!v.enabled || !plans.length || v.capabilityStatus !== 'ENABLED')) || (!v.enabled && plans.length > 0)) return bad();
  return { enabled: v.enabled, salesEnabled: v.salesEnabled, productId: v.productId, productName: v.productName, capabilityStatus: v.capabilityStatus, checkedAt: v.checkedAt, plans };
}
export function parseMembershipStatus(value: unknown): MembershipStatus {
  const v = record(value, ['decision', 'validFrom', 'validUntil', 'legacyExpiresAt', 'canPurchase', 'checkedAt']);
  if (!['ALLOW', 'PURCHASE_REQUIRED', 'DENY'].includes(v.decision as string) || !second(v.legacyExpiresAt) || !second(v.checkedAt) || typeof v.canPurchase !== 'boolean') return bad();
  if (v.decision === 'ALLOW') {
    if (!second(v.validFrom) || !second(v.validUntil) || v.validFrom > v.checkedAt || v.validUntil <= v.checkedAt || v.canPurchase) return bad();
  } else if (v.validFrom !== null || v.validUntil !== null) return bad();
  if (v.canPurchase && (v.decision !== 'PURCHASE_REQUIRED' || v.legacyExpiresAt > v.checkedAt)) return bad();
  return v as unknown as MembershipStatus;
}
export function membershipPlanLabel(p: MembershipPlan): string {
  const period: Record<MembershipPeriod, string> = { WEEK: '一周', MONTH: '一个月', QUARTER: '三个月', YEAR: '一年' };
  return `${p.displayName} · ${period[p.durationPeriod]} · ¥${Math.floor(p.amountMinor / 100)}.${String(p.amountMinor % 100).padStart(2, '0')}`;
}
