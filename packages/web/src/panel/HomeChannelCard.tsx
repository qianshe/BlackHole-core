// The settings home uses the same channel operation as the main console.
import { useEffect, useRef, useState } from 'react';
import { ApiError, panel, type ChannelSwitchView, type Health } from '../api';
import { ChannelSwitch, CHANNEL_SWITCH_HINT } from '../console/ChannelSwitch';
import { channelSummary } from '../console/ChannelsPane';

type Props = {
  health: Health | null;
  mode: 'cloudflare' | 'openai' | 'custom';
  toast: (text: string, tone?: 'info' | 'warn' | 'bad') => void;
  onRefresh: () => void;
};

export function HomeChannelCard({ health, mode, toast, onRefresh }: Props) {
  const [view, setView] = useState<ChannelSwitchView | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);
  const lock = useRef(false);
  const sequence = useRef(0);
  useEffect(() => {
    mounted.current = true;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (!lock.current) {
        const seq = sequence.current;
        try { const next = await panel.channel(); if (mounted.current && seq === sequence.current) setView(next); }
        catch { if (mounted.current && seq === sequence.current) setView(null); }
      }
      if (!stopped && mounted.current) timer = setTimeout(() => void poll(), 2000);
    };
    void poll();
    return () => { stopped = true; mounted.current = false; sequence.current++; clearTimeout(timer); };
  }, []);
  const toggle = async (on: boolean) => {
    if (lock.current) return;
    lock.current = true; sequence.current++; setBusy(true);
    try {
      const result = await panel.channelSwitch(on);
      if (!mounted.current) return;
      setView(result.view);
      toast(on ? '渠道启动请求已提交。' : '公网渠道已停止。');
      onRefresh();
    } catch (error) {
      if (!mounted.current) return;
      const code = error instanceof ApiError ? error.code : '';
      toast(CHANNEL_SWITCH_HINT[code] ?? '渠道操作未完成，请到「连接与渠道」检查配置。', 'warn');
      try { const next = await panel.channel(); if (mounted.current) setView(next); } catch { /* next poll reports disconnection */ }
    } finally { lock.current = false; if (mounted.current) setBusy(false); }
  };
  const summary = channelSummary(health, mode, false);
  return (
    <div className="cell home-channel">
      <div className="ck-head"><div className="ck-k">渠道</div></div>
      <div className="chrow"><div className="ck-v"><span className={'status-dot ' + (summary.tone === 'muted' ? '' : summary.tone)} aria-hidden="true" /><span className="status-label">{summary.text}</span></div>
        <span className="sp" /><ChannelSwitch view={view} busy={busy} onToggle={(on) => void toggle(on)} />
      </div>
    </div>
  );
}
