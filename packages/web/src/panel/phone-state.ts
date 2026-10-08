import type { PhoneEndpoint } from '../../../contracts/src/connections';
import type { RemoteView } from '../api';

/** Older daemons provide configuration only. Never turn that into a green check. */
export function phoneEndpoints(view: RemoteView | null): PhoneEndpoint[] {
  const rows = view?.endpoints ?? (view?.origin ? [{ origin: view.origin, kind: view.kind ?? 'fixed' }] : []);
  return rows.map((entry) => ({
    ...entry, scope: 'scope' in entry ? entry.scope : 'private',
    verification: 'verification' in entry && entry.verification ? entry.verification : { state: 'unverified', checked_at: null, reason: null },
  }));
}
export function phoneSelection(previous: string, entries: PhoneEndpoint[]): string {
  // Only choose an initial default; losing an explicit entry never switches to CF.
  return previous || entries[0]?.origin || '';
}
export function phoneStatus(entry: PhoneEndpoint | undefined): { cls: string; text: string; note: string } {
  if (!entry) return { cls: 'warn', text: '所选入口不可用', note: '请选择仍在配置中的公网入口；不会自动切换渠道。' };
  const prefix = entry.kind === 'quick' ? '临时渠道' : '固定入口';
  const state = entry.verification.state;
  const text = state === 'passed' ? '本机检测通过' : state === 'failed' ? '本机检测失败' : state === 'checking' ? '本机检测中…' : '已配置 · 未验证';
  const error = { timeout: '检测超时', tls: '证书或 TLS 校验失败', unreachable: '本机无法到达此入口', unexpected_response: '没有返回预期的手机接口' };
  const note = state === 'passed' ? '仅代表本机已验证手机接口；手机仍需能访问这个网络和对应的 HTTP(S) 地址。'
    : state === 'failed' ? (error[entry.verification.reason ?? 'unreachable'] + '。本机检测失败不代表所有设备不可达。')
      : '尚未确认该入口的证书、转发与手机接口；生成配对码不代表已连通。';
  return { cls: state === 'passed' ? 'ok' : 'warn', text: prefix + ' · ' + text, note };
}

/** Compact, neutral entry identity. Configuration is not proof that a phone can reach it. */
export function phoneEndpointLabel(entry: PhoneEndpoint): string {
  const kind = entry.kind === 'quick' ? '临时渠道'
    : entry.scope === 'private' ? '内网'
    : entry.scope === 'loopback' ? '本机' : '固定入口';
  let host: string;
  try { host = new URL(entry.origin).host; } catch { host = entry.origin; }
  return kind + ' · ' + host;
}
