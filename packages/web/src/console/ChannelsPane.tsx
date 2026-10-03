import { useState } from 'react';
import { api, panel, remoteAdmin, type ChannelSwitchView, type Health, type RemoteView, type SettingsValues } from '../api';
import { Icon } from '../ui';
import { ChannelSwitch } from './ChannelSwitch';
import { copyText, failText, useToast } from './common';
import c from './console.module.css';

type Tone = 'ok' | 'warn' | 'bad' | 'muted';

/** Channel state as the settings panel names it. */
export function channelState(h: Health | null, mode: SettingsValues['channelMode'] | undefined): { tone: Tone; text: string } {
  if (!h) return { tone: 'muted', text: '未连接' };
  if (mode === 'custom') return h.public_base_url ? { tone: 'ok', text: '自定义地址' } : { tone: 'muted', text: '未配置' };
  if (mode === 'openai') {
    const oa: Record<string, { tone: Tone; text: string }> = {
      ready: { tone: 'ok', text: '就绪' },
      recovering: { tone: 'warn', text: '恢复中' },
      starting: { tone: 'warn', text: '启动中…' },
      stopping: { tone: 'warn', text: '停止中…' },
      error: { tone: 'bad', text: '启动失败' },
      unavailable: { tone: 'bad', text: '不可用' },
    };
    return oa[h.openai_tunnel?.status ?? 'off'] ?? { tone: 'muted', text: '未启动' };
  }
  const map: Record<string, { tone: Tone; text: string }> = {
    online: { tone: 'ok', text: h.tunnel_mode === 'named' ? '持久在线' : '临时在线' },
    unverified: { tone: 'warn', text: '未验证' },
    starting: { tone: 'warn', text: '启动中…' },
    error: { tone: 'bad', text: '启动失败' },
    unavailable: { tone: 'bad', text: '不可用' },
  };
  return map[h.tunnel] ?? { tone: 'muted', text: '未启动' };
}

/**
 * Every running channel in one line, e.g. 「持久 · gpt」, 「临时」, 「自定义」; 「未启动」 when none.
 * Cloudflare and OpenAI run side by side, so this reads both whichever mode is selected.
 * The VS Code settings page and sidebar use the same wording (configPanel.ts / sidebar.ts).
 */
export function channelSummary(h: Health | null, mode: SettingsValues['channelMode'] | undefined, customOnline?: boolean): { tone: Tone; text: string } {
  if (!h) return { tone: 'muted', text: '未连接' };
  const parts: Array<[Tone, string]> = [];
  const kind = h.tunnel_mode === 'named' ? '持久' : '临时';
  const cf: Record<string, [Tone, string]> = { online: ['ok', kind], unverified: ['warn', kind + '未验证'], starting: ['warn', 'Cloudflare 启动中…'], error: ['bad', 'Cloudflare 失败'], unavailable: ['bad', 'Cloudflare 不可用'] };
  const oa: Record<string, [Tone, string]> = { ready: ['ok', 'gpt'], recovering: ['warn', 'gpt 恢复中'], starting: ['warn', 'gpt 启动中…'], stopping: ['warn', 'gpt 停止中…'], error: ['bad', 'gpt 失败'], unavailable: ['bad', 'gpt 不可用'] };
  if (mode === 'custom' && (customOnline ?? !!h.public_base_url)) parts.push(['ok', '自定义']);
  if (cf[h.tunnel]) parts.push(cf[h.tunnel]!);
  const o = h.openai_tunnel?.status;
  if (o && oa[o]) parts.push(oa[o]!);
  if (!parts.length) return { tone: 'muted', text: '未启动' };
  const tones = new Set(parts.map((p) => p[0]));
  const tone: Tone = tones.size === 1 ? parts[0]![0] : 'warn';
  return { tone, text: parts.map((p) => p[1]).join(' · ') };
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
  channelSwitch = null,
  channelBusy = false,
  onChannelToggle,
}: {
  health: Health | null;
  values: SettingsValues | null;
  remote: RemoteView | null;
  onRefresh: () => void;
  onSettings: (section: string) => void;
  /** 渠道总开关（与侧栏同一个）；旧版 daemon 没有 /channel 时为 null。 */
  channelSwitch?: ChannelSwitchView | null;
  channelBusy?: boolean;
  onChannelToggle?: (on: boolean) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const mode = values?.channelMode ?? 'cloudflare';
  const st = channelSummary(health, mode);
  const hasNamed = !!values?.namedTunnelName && !!values?.publicBaseUrl;
  const running = health ? ['online', 'unverified', 'starting'].includes(health.tunnel) : false;
  // OpenAI channel start/stop, same calls as the settings panel (daemon id + revisions guard races).
  const oaLive = ['starting', 'ready', 'recovering'].includes(health?.openai_tunnel?.status ?? '');
  const openaiStart = async (): Promise<unknown> => {
    const h = await panel.health();
    if (!h.openai_tunnel || !h.daemon_id) throw new Error('openai_tunnel_unsupported');
    const s = await api.settings();
    return panel.openaiStart(h.daemon_id, s.revision, h.openai_tunnel.credential_revision);
  };
  const openaiStop = async (): Promise<unknown> => {
    const h = await panel.health();
    if (!h.openai_tunnel || !h.daemon_id) throw new Error('openai_tunnel_unsupported');
    return panel.openaiStop(h.daemon_id, h.openai_tunnel.run_id);
  };
  // Every channel is listed with its own state (Cloudflare and OpenAI can run together); the
  // saved channel mode is only marked as the default one.
  const rows = (['cloudflare', 'openai', 'custom'] as const).map((m) => {
    // The custom address is shared with the named Cloudflare tunnel: only "online" when it is the default.
    const rs = m === 'custom' && m !== mode ? { tone: 'muted' as Tone, text: values?.publicBaseUrl ? '已填写地址' : '未配置' } : channelState(health, m);
    const url = m === 'openai' ? null : m === 'custom' ? (health?.public_base_url ?? values?.publicBaseUrl ?? null) : (running ? health?.tunnel_url ?? null : null);
    const reason = m === 'openai' ? (health?.openai_tunnel?.reason ?? null) : m === 'cloudflare' ? (health?.tunnel_reason ?? null) : null;
    return { m, rs, url, reason };
  });
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
  const needCf = !values?.cloudflaredPath;

  return (
    <section className={c.channels} aria-label="公网渠道">
      <div className={c.channelsWrap}>
        <header className={c.channelsHead}>
          <div>
            <h1>公网渠道</h1>
            <p>网页版 AI 通过连接渠道连到这台电脑。Cloudflare / 自定义提供公网地址；OpenAI 渠道经 OpenAI 隧道只连 ChatGPT，可与 Cloudflare 同时运行。</p>
          </div>
          <button type="button" className={c.btnPrimary} onClick={() => onSettings('channel')}>
            <Icon name="plus" size={14} /> 添加渠道
          </button>
        </header>
        <div className={c.channelSummary}>
          <span className={c.channelSummarySwitch}>
            状态 <ChannelSwitch view={channelSwitch} busy={channelBusy} onToggle={(on) => onChannelToggle?.(on)} />
            <b className={c[`stateText_${st.tone}`]}>{st.text}</b>
          </span>
          <span>
            默认 <b>{MODE_LABEL[mode][0]}</b>
          </span>
          <span>
            手机访问 <b>{remote?.enabled ? `已开启 · ${remote.devices.length} 台设备` : '未开启'}</b>
          </span>
        </div>

        <ul className={c.channelList}>
          {rows.map(({ m, rs, url, reason }) => (
          <li key={m} className={c.channelRow}>
            <div style={{ minWidth: 0 }}>
              <div className={c.channelTitle}>
                <span className={c[`dot_${rs.tone}`]} aria-hidden="true" />
                {m === 'cloudflare' ? (health?.tunnel_mode === 'named' ? 'Cloudflare 持久渠道' : 'Cloudflare 临时渠道') : MODE_LABEL[m][0]}
                {m === mode && <span className={c.provider}>默认</span>}
              </div>
              <div className={c.channelDesc}>{MODE_LABEL[m][1]}</div>
              <div className={c.channelUrl} title={url ?? ''}>
                {m === 'openai'
                  ? (values?.openaiTunnelId ? `Tunnel ID ${values.openaiTunnelId}` : '尚未配置 Tunnel ID')
                  : m === 'custom'
                    ? (url ?? '尚未填写公网地址')
                    : (url ?? (needCf ? '需要先安装 cloudflared' : '启动后显示公网地址'))}
              </div>
              {reason && rs.tone !== 'ok' && rs.tone !== 'muted' && <div className={c.channelDesc} style={{ color: 'var(--bad)' }}>{reason}</div>}
            </div>
            <div className={c.channelMeta}>
              <span>
                状态 <b className={c[`stateText_${rs.tone}`]}>{rs.text}</b>
              </span>
              <span>
                地址类型 <b>{m === 'openai' ? '无公网地址（仅连接器）' : m === 'custom' || health?.tunnel_mode === 'named' ? '固定' : '每次启动会变化'}</b>
              </span>
            </div>
            <div className={c.rowActions}>
              {url && (
                <button type="button" className={c.btn} onClick={() => void copyText(url).then((ok) => toast(ok ? '地址已复制' : '复制失败', ok ? 'ok' : 'bad'))}>
                  复制地址
                </button>
              )}
              {m === 'cloudflare' && !running && (
                <>
                  <button type="button" className={c.btn} disabled={busy || needCf} onClick={() => run(() => panel.tunnelStart('quick'), '正在启动临时渠道')}>
                    启动临时
                  </button>
                  <button type="button" className={c.btn} disabled={busy || needCf || !hasNamed} title={hasNamed ? undefined : '持久渠道需先在设置里配置固定公网地址'} onClick={() => run(() => panel.tunnelStart('named'), '正在启动持久渠道')}>
                    启动持久
                  </button>
                </>
              )}
              {m === 'openai' && (oaLive || health?.openai_tunnel?.status === 'stopping' ? (
                <button type="button" className={c.btnDanger} disabled={busy || !health?.openai_tunnel} onClick={() => run(openaiStop, 'OpenAI 渠道已停止')}>
                  停止
                </button>
              ) : (
                <button type="button" className={c.btn} disabled={busy || !health?.openai_tunnel} title={values?.openaiTunnelId ? undefined : '先在设置里填写 Tunnel ID 和 Runtime API Key'} onClick={() => run(openaiStart, '正在启动 OpenAI 渠道')}>
                  启动
                </button>
              ))}
              {/* 停止只作用于 Cloudflare 这一行，绝不能误停 OpenAI 渠道 */}
              {m === 'cloudflare' && running && (
                <button type="button" className={c.btnDanger} disabled={busy} onClick={() => run(() => panel.tunnelStop(), '渠道已停止')}>
                  停止
                </button>
              )}
              <button type="button" className={c.btnGhost} onClick={() => onSettings('channel')}>
                设置
              </button>
            </div>
          </li>
          ))}
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
                <button type="button" className={c.btn} onClick={() => onSettings('channel')}>
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

