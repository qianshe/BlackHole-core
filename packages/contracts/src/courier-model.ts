export interface ModelAttribution {
  status: 'unknown' | 'estimated' | 'verified';
  label: string | null;
  level: 'model' | 'family' | 'vendor' | null;
  score: number | null;
  source: 'reply-classifier' | 'page-label' | null;
}
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
  if (site === 'chatgpt' && v.status === 'verified' && v.source === 'page-label')
    return { status: 'verified', label, level: 'model', score: null, source: 'page-label' };
  return unknown;
}
/** Standalone: serialized into the VS Code webview as well as imported by React. Never falls back to history. */
export function courierModelLabel(target: { site?: string; model?: string | null; modelAttribution?: ModelAttribution | null } | null | undefined): string {
  if (!target) return '';
  const a = target.modelAttribution;
  if (a?.status === 'estimated' && a.label) {
    const level = a.level === 'family' ? '系列' : a.level === 'vendor' ? '厂商' : '型号';
    const score = typeof a.score === 'number' ? ` · 判别分数 ${Math.round(a.score * 100)}%` : '';
    return `推测${level}：${a.label}${score}`;
  }
  if (a?.status === 'verified' && a.label) return `页面标注：${a.label}`;
  if (a !== undefined || target.site === 'arena') return '型号未知';
  return target.model ? `页面标注：${target.model}` : '型号未知';
}
