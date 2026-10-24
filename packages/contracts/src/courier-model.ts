export interface ModelAttribution {
  status: 'unknown' | 'estimated' | 'verified';
  label: string | null;
  level: 'model' | 'family' | 'vendor' | null;
  score: number | null;
  source: 'reply-classifier' | 'page-label' | 'ledger-price' | null;
  /** ledger-price only: the same-price candidate group (display names, at most 8). A price fits a group, not one model. */
  candidates?: string[];
  /** ledger-price only: the group this chat was priced as before the latest turn, when the price stopped fitting (a possible model switch). */
  changedFrom?: string[] | null;
}
/** Display names from an untrusted list: trimmed, bounded, no empties. */
const nameList = (raw: unknown): string[] => (Array.isArray(raw) ? raw : []).filter((x): x is string => typeof x === 'string').map(x => x.trim().slice(0, 80)).filter(Boolean).slice(0, 8);
/** Boundary normalization. Legacy Arena model strings are not trustworthy evidence. */
export function cleanModelAttribution(raw: unknown, site: string, legacy?: unknown): ModelAttribution {
  const unknown: ModelAttribution = { status: 'unknown', label: null, level: null, score: null, source: null };
  if (raw === undefined && site === 'chatgpt' && typeof legacy === 'string' && legacy.trim())
    return { status: 'verified', label: legacy.trim().slice(0, 80), level: 'model', score: null, source: 'page-label' };
  if (!raw || typeof raw !== 'object') return unknown;
  const v = raw as Record<string, unknown>;
  const label = typeof v.label === 'string' ? v.label.trim().slice(0, 80) : '';
  if (!label) return unknown;
  if (site === 'arena' && v.status === 'estimated' && v.source === 'reply-classifier'
    && ['model', 'family', 'vendor'].includes(String(v.level))
    && typeof v.score === 'number' && Number.isFinite(v.score) && v.score >= 0 && v.score <= 1)
    return { status: 'estimated', label, level: v.level as ModelAttribution['level'], score: v.score, source: 'reply-classifier' };
  // Courier's ledger price check (Arena /cost): a price fits a same-price group, never one verified model, and it has no score.
  if (site === 'arena' && v.status === 'estimated' && v.source === 'ledger-price'
    && ['model', 'family', 'vendor'].includes(String(v.level))
    && (v.score === null || v.score === undefined)) {
    const candidates = nameList(v.candidates), changedFrom = nameList(v.changedFrom);
    return { status: 'estimated', label, level: v.level as ModelAttribution['level'], score: null, source: 'ledger-price',
      candidates: candidates.length ? candidates : [label], changedFrom: changedFrom.length ? changedFrom : null };
  }
  if (site === 'chatgpt' && v.status === 'verified' && v.source === 'page-label')
    return { status: 'verified', label, level: 'model', score: null, source: 'page-label' };
  return unknown;
}
/** Standalone: serialized into the VS Code webview as well as imported by React. Never falls back to history. */
export function courierModelLabel(target: { site?: string; model?: string | null; modelAttribution?: ModelAttribution | null } | null | undefined): string {
  if (!target) return '';
  const a = target.modelAttribution;
  if (a?.status === 'estimated' && a.label) {
    // The ledger price check: a same-price group, or a warning when the price stopped fitting the earlier turns.
    if (a.source === 'ledger-price') {
      // The lists are capped at 8 on the way in: a list that reached the cap may have been longer, hence "8+".
      const some = (xs: string[]) => `${xs.slice(0, 3).join(' / ')}${xs.length > 3 ? ` 等 ${xs.length}${xs.length >= 8 ? '+' : ''} 个` : ''}`;
      const now = (a.candidates?.length ?? 0) > 1 ? `${some(a.candidates ?? [])}（同价，分不开）` : a.label;
      return a.changedFrom?.length ? `⚠ 价格变化：${some(a.changedFrom)} → ${now}` : `按价格：${now}`;
    }
    const level = a.level === 'family' ? '系列' : a.level === 'vendor' ? '厂商' : '型号';
    const score = typeof a.score === 'number' ? ` · 判别分数 ${Math.round(a.score * 100)}%` : '';
    return `推测${level}：${a.label}${score}`;
  }
  if (a?.status === 'verified' && a.label) return `页面标注：${a.label}`;
  if (a !== undefined || target.site === 'arena') return '型号未知';
  return target.model ? `页面标注：${target.model}` : '型号未知';
}
