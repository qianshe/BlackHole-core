import { useState } from 'react';
import { panel, remoteAdmin, type Health, type RemoteView, type SettingsValues } from '../api';
import { Icon } from '../ui';
import { copyText, failText, useToast } from './common';
import c from './console.module.css';

type Tone = 'ok' | 'warn' | 'bad' | 'muted';

/** Channel state as the settings panel names it. */
export function channelState(h: Health | null, mode: SettingsValues['channelMode'] | undefined): { tone: Tone; text: string } {
  if (!h) return { tone: 'muted', text: '未连接' };
  if (mode === 'custom') return h.public_base_url ? { tone: 'ok', text: '自定义地址' } : { tone: 'muted', text: '未配置' };
  const map: Record<string, { tone: Tone; text: string }> = {
    online: { tone: 'ok', text: h.tunnel_mode === 'named' ? '持久在线' : '临时在线' },
    unverified: { tone: 'warn', text: '未验证' },
    starting: { tone: 'warn', text: '启动中…' },
    error: { tone: 'bad', text: '启动失败' },
    unavailable: { tone: 'bad', text: '不可用' },
  };
  return map[h.tunnel] ?? { tone: 'muted', text: '未启动' };
}

const MODE_LABEL: Record<SettingsValues['channelMode'], [string, string]> = {
  cloudflare: ['Cloudflare', '通过 Cloudflare 隧道让网页版 AI 连到这台电脑'],
  openai: ['OpenAI', '通过 OpenAI 隧道连接 ChatGPT'],
  custom: ['自定义 HTTPS', '使用你自己的公网 HTTPS 地址'],
};

export function ChannelsPane({
  health,
  values,
  remote,
  onRefresh,
  onSettings,
}: {
  health: Health | null;
  values: SettingsValues | null;
  remote: RemoteView | null;
  onRefresh: () => void;
  onSettings: (section: string) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const mode = values?.channelMode ?? 'cloudflare';
  const st = channelState(health, mode);
  const url = health?.tunnel_url ?? health?.public_base_url ?? null;
  const hasNamed = !!values?.namedTunnelName && !!values?.publicBaseUrl;
  const running = health ? ['online', 'unverified', 'starting'].includes(health.tunnel) : false;

  const run = (fn: () => Promise<unknown>, done: string): void => {
    setBusy(true);
    fn().then(
      () => {
        toast(done);
        onRefresh();
      },
      (e: unknown) => toast(failText(e), 'bad'),
    ).finally(() => setBusy(false));
  };
  const needCf = mode === 'cloudflare' && !values?.cloudflaredPath;

  return (
    <section className={c.channels} aria-label="公网渠道">
      <div className={c.channelsWrap}>
        <header className={c.channelsHead}>
          <div>
            <h1>公网渠道</h1>
            <p>网页版 AI 通过公网渠道连到这台电脑。同一时间使用一个渠道。</p>
          </div>
          <button type="button" className={c.btnPrimary} onClick={() => onSettings('channel')}>
            <Icon name="plus" size={14} /> 添加渠道
          </button>
        </header>
        <div className={c.channelSummary}>
          <span>
            状态 <b className={c[`stateText_${st.tone}`]}>{st.text}</b>
          </span>
          <span>
            方式 <b>{MODE_LABEL[mode][0]}</b>
          </span>
          <span>
            手机访问 <b>{remote?.enabled ? `已开启 · ${remote.devices.length} 台设备` : '未开启'}</b>
          </span>
        </div>

        <ul className={c.channelList}>
          <li className={c.channelRow}>
            <div style={{ minWidth: 0 }}>
              <div className={c.channelTitle}>
                <span className={c[`dot_${st.tone}`]} aria-hidden="true" />
                {mode === 'cloudflare' ? (health?.tunnel_mode === 'named' ? 'Cloudflare 持久渠道' : 'Cloudflare 临时渠道') : MODE_LABEL[mode][0]}
                <span className={c.provider}>{MODE_LABEL[mode][0]}</span>
              </div>
              <div className={c.channelDesc}>{MODE_LABEL[mode][1]}</div>
              <div className={c.channelUrl} title={url ?? ''}>
                {url ?? (needCf ? '需要先安装 cloudflared' : '启动后显示公网地址')}
              </div>
              {health?.tunnel_reason && st.tone !== 'ok' && <div className={c.channelDesc} style={{ color: 'var(--bad)' }}>{health.tunnel_reason}</div>}
            </div>
            <div className={c.channelMeta}>
              <span>
                状态 <b className={c[`stateText_${st.tone}`]}>{st.text}</b>
              </span>
              <span>
                地址类型 <b>{health?.tunnel_mode === 'named' || mode === 'custom' ? '固定' : '每次启动会变化'}</b>
              </span>
            </div>
            <div className={c.rowActions}>
              {url && (
                <button type="button" className={c.btn} onClick={() => void copyText(url).then((ok) => toast(ok ? '地址已复制' : '复制失败', ok ? 'ok' : 'bad'))}>
                  复制地址
                </button>
              )}
              {mode === 'cloudflare' && !running && (
                <>
                  <button type="button" className={c.btn} disabled={busy || needCf} onClick={() => run(() => panel.tunnelStart('quick'), '正在启动临时渠道')}>
                    启动临时
                  </button>
                  <button type="button" className={c.btn} disabled={busy || needCf || !hasNamed} title={hasNamed ? undefined : '持久渠道需先在设置里配置固定公网地址'} onClick={() => run(() => panel.tunnelStart('named'), '正在启动持久渠道')}>
                    启动持久
                  </button>
                </>
              )}
              {mode !== 'custom' && running && (
                <button type="button" className={c.btnDanger} disabled={busy} onClick={() => run(() => panel.tunnelStop(), '渠道已停止')}>
                  停止
                </button>
              )}
              <button type="button" className={c.btnGhost} onClick={() => onSettings('channel')}>
                设置
              </button>
            </div>
          </li>
        </ul>

        {remote?.enabled && (
          <ul className={c.channelList}>
            <li className={c.channelRow}>
              <div>
                <div className={c.channelTitle}>
                  <span className={remote.available ? c.dot_ok : c.dot_muted} aria-hidden="true" />
                  手机访问
                </div>
                <div className={c.channelDesc}>{remote.available ? '用手机扫码后可查看会话、处理审批。' : remote.reason ?? '需要先启动公网渠道。'}</div>
              </div>
              <div className={c.channelMeta}>
                <span>
                  已配对 <b>{remote.devices.length} 台</b>
                </span>
              </div>
              <div className={c.rowActions}>
                <button type="button" className={c.btn} onClick={() => onSettings('remote')}>
                  管理
                </button>
                {remote.devices.length > 0 && (
                  <button type="button" className={c.btnGhost} disabled={busy} onClick={() => run(() => remoteAdmin.revokeAll(), '已移除全部手机')}>
                    全部移除
                  </button>
                )}
              </div>
            </li>
          </ul>
        )}

        {needCf && (
          <div className={c.channelEmpty}>
            <span>使用 Cloudflare 渠道需要先安装 cloudflared。</span>
            <button type="button" className={c.btn} onClick={() => onSettings('channel')}>
              去安装
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
