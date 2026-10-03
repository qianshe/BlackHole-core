import type { ChannelSwitchView } from '../api';

const NAMES: Record<string, string> = { quick: '临时渠道', named: '持久渠道', openai: 'OpenAI 渠道' };

/** 打开渠道总开关缺前提时的提示（与 VS Code 侧边栏同一套码）。 */
export const CHANNEL_SWITCH_HINT: Record<string, string> = {
  cloudflared: '还没有 cloudflared：在设置的「公网渠道」里一键安装。',
  named_url: '持久渠道还没有填公网地址：在设置的「公网渠道」里填写。',
  openai_setup: 'OpenAI 渠道还没配置完：在设置的「公网渠道」里补上 Tunnel ID、tunnel-client 和密钥。',
  openai_unavailable: '当前 daemon 不支持 OpenAI 渠道。',
  start_failed: '渠道没有启动，原因见公网渠道页。',
};

/** 悬停说明：开了会启动哪个渠道、还缺什么、上次为什么失败。 */
export function switchTitle(v: ChannelSwitchView): string {
  if (v.on) return '关闭：停止' + v.running.map((x) => NAMES[x] ?? x).join('、');
  return '开启：' + (NAMES[v.next] ?? v.next) + (v.last ? '（上次使用）' : '')
    + (v.missing === 'cloudflared' ? ' · 需要先安装 cloudflared' : '')
    + (v.state === 'error' && v.reason ? ' · 上次失败：' + v.reason : '');
}
