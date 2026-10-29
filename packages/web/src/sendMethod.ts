// New-session send methods: which web AI the first message opens (Courier supports Arena and
// ChatGPT, plus the sites added in Courier with 检测此页面), or a plain prompt copy for any other
// web AI. Shared by the Web console and the phone page.
/** 'chatgpt' | 'arena' | 'manual', or the id of a site added in Courier (c-…). */
export type SendMethod = string;
/** A site Courier can open a new chat on (GET courier status → sites). */
/** `template`: the prompt the daemon puts around the first message on this site (it decides, by site). */
export interface SiteChoice { id: string; name: string; custom?: boolean; template?: 'connector' | 'sandbox' }
const CUSTOM_SITE = /^c-[a-z0-9-]{1,30}$/;

export const SEND_METHODS: { id: SendMethod; label: string; hint: string; tag?: string }[] = [
  { id: 'chatgpt', label: 'ChatGPT', tag: '连接器', hint: '第一条消息会新开 ChatGPT 会话并配对，附上连接器提示词' },
  { id: 'arena', label: 'Arena', tag: '沙箱', hint: '第一条消息会新开 Arena 会话并配对，附上沙箱直连提示词' },
  { id: 'manual', label: '手动复制', hint: '发送时复制连接器提示词（含这条消息），粘贴给任意网页 AI' },
];

/** The built-in methods with the Courier sites inserted before 手动复制. */
/** 手动复制 stays a method (older saved choice, copy flows) but is no longer offered in the pickers. */
export function sendMethods(sites: readonly SiteChoice[] = []): { id: SendMethod; label: string; hint: string; tag?: string }[] {
  const custom = sites.filter((x) => x.custom && CUSTOM_SITE.test(x.id))
    .map((x) => ({ id: x.id, label: x.name, tag: x.template === 'connector' ? '连接器' : '沙箱', hint: `不绑定：新开 ${x.name} 并填入${x.template === 'connector' ? '连接器' : '沙箱直连'}提示词，由你在网页中手动发送，回复不同步` }));
  return [...SEND_METHODS.filter((m) => m.id !== 'manual'), ...custom];
}

/** A remembered method that is not offered (its site was deleted) falls back to ChatGPT. */
export function usableMethod(m: SendMethod, sites: readonly SiteChoice[]): SendMethod {
  return m === 'manual' || (CUSTOM_SITE.test(m) && !sites.some((x) => x.id === m)) ? 'chatgpt' : m;
}

/** Display name of a site id: built-in, a Courier site, or the id itself. */
export function siteLabel(site: string | null | undefined, sites: readonly SiteChoice[] = []): string {
  if (!site) return '网页会话';
  return sites.find((x) => x.id === site)?.name ?? (site === 'arena' ? 'Arena' : site === 'chatgpt' ? 'ChatGPT' : site);
}

/** Site and prompt template the daemon uses to open the chat; null for the manual copy. */
export function startPlan(m: SendMethod): { site: string; template: 'connector' | 'sandbox' } | null {
  if (m === 'chatgpt') return { site: 'chatgpt', template: 'connector' };
  if (m === 'arena') return { site: 'arena', template: 'sandbox' };
  if (CUSTOM_SITE.test(m)) return { site: m, template: 'sandbox' }; // informational: the daemon picks the template by site
  return null;
}

const KEY = 'bh.sendMethod';
export function loadMethod(): SendMethod {
  try {
    const v = localStorage.getItem(KEY);
    return v && (SEND_METHODS.some((x) => x.id === v) || CUSTOM_SITE.test(v)) ? v : 'chatgpt';
  } catch {
    return 'chatgpt';
  }
}
export function saveMethod(m: SendMethod): void {
  try { localStorage.setItem(KEY, m); } catch { /* private mode */ }
}
