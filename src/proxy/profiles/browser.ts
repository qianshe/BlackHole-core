import { registerProfile, type ProxyProfile } from './registry.js';

/**
 * M3 browser profile（plan §10，v2.5 壳化后）：只提供两件事——
 *  1. opt-in 导航白名单：`browser.allowedDomains` 配置了才生效（域内 allow、域外
 *     confirm）；未配置 = 完全透传（不再恒定确认 evaluate_script/fill，那由
 *     config risk: 自行收紧）。
 *
 * allowedDomains 是 per-server 配置（YAML 的 `browser.allowedDomains`），经
 * decideRisk 的 catalogMeta 注入——profile 实例本身无状态。
 * Generic Core 不认识 uid/DOM/page（plan §2.1）；全部浏览器语义收在本文件。
 */

function browserDomains(catalogMeta: unknown): readonly string[] {
  const meta = (catalogMeta ?? {}) as { browser?: { allowedDomains?: readonly string[] } };
  return meta.browser?.allowedDomains ?? [];
}

/** 从 args.url 提取 host（非法/缺省 → null）。 */
function hostOf(url: unknown): string | null {
  if (typeof url !== 'string' || url.trim() === '') return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function domainAllowed(host: string, allowedDomains: readonly string[]): boolean {
  return allowedDomains.some((pattern) => {
    const p = pattern.toLowerCase().replace(/^www\./, '');
    const h = host.replace(/^www\./, '');
    // "*.example.com" 形态：后缀匹配；其余精确匹配
    if (p.startsWith('*.')) return h === p.slice(2) || h.endsWith(`.${p.slice(2)}`);
    return h === p;
  });
}

const BROWSER_PROFILE: ProxyProfile = {
  name: 'browser',
  ownedTools: [],
  policy: {
    decide(req) {
      const args = (req.canonicalArgs ?? {}) as Record<string, unknown>;
      if (req.tool === 'navigate_page') {
        const domains = browserDomains(req.catalogMeta);
        if (domains.length === 0) return null; // 未配置白名单：壳语义，透传
        const host = hostOf(args.url);
        // 配了白名单 = 显式收紧；URL 解析不了按域外处理（交给 confirm）
        return host !== null && domainAllowed(host, domains)
          ? { decision: 'allow', reason: `browser profile: ${host} is in allowedDomains` }
          : { decision: 'confirm', reason: `browser profile: ${host ?? '(unparseable url)'} is not in allowedDomains` };
      }
      return null; // evaluate_script / fill：默认放行；要收紧走 config risk:
    },
  },
  redaction: {
    redact(req) {
      if (req.tool !== 'fill') return null;
      const args = (req.args ?? {}) as Record<string, unknown>;
      if (typeof args.value !== 'string' || args.value === '') return null;
      // 密码字段判定：fill 的目标带 password 语义（真实 chrome-devtools-mcp 接线后
      // 以 snapshot 字段类型为准；fixture 以 uid/label 的 password 标记约定）
      const uid = String(args.uid ?? '');
      const label = String((args as { label?: unknown }).label ?? '');
      if (/pass/i.test(uid) || /pass/i.test(label) || args.type === 'password') {
        return { args: { ...args, value: '***' }, maskedPaths: ['value'] };
      }
      return null;
    },
  },
};

export function registerBrowserProfile(): void {
  registerProfile(BROWSER_PROFILE);
}
