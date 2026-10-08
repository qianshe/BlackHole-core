/** Shared catalogue; hosts decide how to open a website, not which settings UI to render. */
export interface WebAgentPreset { name: string; url: string; description: string }
export const WEB_AGENT_PRESETS: readonly WebAgentPreset[] = [
  { name: 'ChatGPT', url: 'https://chatgpt.com', description: 'OpenAI ChatGPT' },
  { name: 'WorkBuddy', url: 'https://www.workbuddy.cn', description: 'WorkBuddy 工作助手' },
  { name: 'Manus', url: 'https://manus.im', description: 'Manus AI agent' },
  { name: 'Trae CN', url: 'https://work.trae.cn', description: 'Trae (国内版)' },
  { name: 'Trae AI', url: 'https://work.trae.ai', description: 'Trae (国际版)' },
  { name: 'Arena', url: 'https://arena.ai', description: 'LMArena AI' },
];
