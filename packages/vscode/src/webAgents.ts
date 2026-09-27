import { ConfigurationTarget, commands, window, workspace, type QuickPickItem } from 'vscode';

/**
 * Predefined web AI agents — public websites the user can open inside VS Code's
 * Simple Browser to work alongside a BlackHole session.
 */
export interface WebAgent {
  name: string;
  url: string;
  description: string;
}

export const AGENTS: WebAgent[] = [
  { name: 'ChatGPT',   url: 'https://chatgpt.com',        description: 'OpenAI ChatGPT' },
  { name: 'WorkBuddy', url: 'https://www.workbuddy.cn',   description: 'WorkBuddy 工作助手' },
  { name: 'Manus',     url: 'https://manus.im',           description: 'Manus AI agent' },
  { name: 'Trae CN',   url: 'https://work.trae.cn',       description: 'Trae (国内版)' },
  { name: 'Trae AI',   url: 'https://work.trae.ai',       description: 'Trae (国际版)' },
  { name: 'Arena',     url: 'https://arena.ai',           description: 'LMArena AI' },
];

/**
 * Agents shown in the picker = AGENTS filtered by the blackhole.webAgents
 * setting (the settings page renders these names as checkboxes), plus the
 * manually added custom agents (blackhole.customWebAgents, always shown).
 * The setting is undefined until the user customizes it; an explicitly empty
 * list hides every predefined agent (the URL entry remains available).
 */
export function customAgents(): WebAgent[] {
  const raw = workspace.getConfiguration('blackhole').get<{ name?: string; url?: string }[]>('customWebAgents');
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((a): a is { name: string; url: string } => typeof a?.name === 'string' && a.name.trim() !== '' && typeof a?.url === 'string')
    .map((a) => ({ name: a.name.trim(), url: a.url, description: '自定义站点' }));
}

export function enabledAgents(): WebAgent[] {
  const enabled = workspace.getConfiguration('blackhole').get<string[]>('webAgents');
  const presets = !Array.isArray(enabled) ? AGENTS : AGENTS.filter((a) => new Set(enabled).has(a.name));
  return [...presets, ...customAgents()];
}

/**
 * Persist one manually added agent (settings page). Returns an error message
 * in Chinese for the UI, or null on success.
 */
export async function addCustomAgent(name: string, rawUrl: string): Promise<string | null> {
  const trimmed = name.trim();
  if (!trimmed) return '名称不能为空';
  const url = normalizeUrl(rawUrl);
  if (!url) return `无法识别的网址「${rawUrl}」，示例：example.com 或 https://example.com`;
  const known = new Set([...AGENTS, ...customAgents()].map((a) => a.name.toLowerCase()));
  if (known.has(trimmed.toLowerCase())) return `名称「${trimmed}」已存在`;
  const c = workspace.getConfiguration('blackhole');
  const next = [...(c.get<{ name: string; url: string }[]>('customWebAgents') ?? []), { name: trimmed, url }];
  await c.update('customWebAgents', next, ConfigurationTarget.Global);
  return null;
}

/** Drop the manually added agent with this name; no-op when absent. */
export async function removeCustomAgent(name: string): Promise<void> {
  const c = workspace.getConfiguration('blackhole');
  const current = c.get<{ name: string; url: string }[]>('customWebAgents') ?? [];
  const next = current.filter((a) => a.name !== name);
  if (next.length === current.length) return;
  await c.update('customWebAgents', next, ConfigurationTarget.Global);
}

/** Accept bare domains like "example.com" by defaulting the scheme to https://. */
export function normalizeUrl(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`;
  try {
    const u = new URL(candidate);
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** Open a configured site or ask for a URL using VS Code's native dialogs. */
export async function openWebAgent(): Promise<void> {
  type Item = QuickPickItem & { url?: string };
  const items: Item[] = enabledAgents().map((a) => ({
    label: a.name,
    description: a.url,
    detail: a.description,
    url: a.url,
  }));
  items.push({ label: '$(link-external) 输入网址…', detail: '打开任意 HTTP/HTTPS 站点（支持 example.com）' });
  // Same native, titled Quick Input interaction as session creation. Let VS
  // Code own accept/cancel/hide/disposal instead of a custom picker lifecycle.
  const picked = await window.showQuickPick(items, {
    title: '打开 Web AI Agent',
    placeHolder: '选择站点，或选择「输入网址…」打开其他站点',
    matchOnDescription: true,
    matchOnDetail: true,
    ignoreFocusOut: false,
  });
  if (!picked) return;
  let url = picked.url;
  if (!url) {
    // Presentation follows askTask in sessionActions; URL business rules remain
    // here. Invalid text stays in the native input for correction.
    const typed = await window.showInputBox({
      title: '打开 Web AI Agent：输入网址',
      prompt: '输入要在 VS Code 中打开的网址；未填写协议时默认使用 HTTPS',
      placeHolder: '例：example.com 或 https://example.com',
      ignoreFocusOut: false,
      validateInput: value => normalizeUrl(value) ? undefined : '请输入有效的 HTTP/HTTPS 网址，例如 example.com',
    });
    if (typed === undefined) return;
    url = normalizeUrl(typed) ?? undefined;
  }
  if (!url) return;
  await commands.executeCommand('simpleBrowser.api.open', url);
}
