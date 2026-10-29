import type { ChannelSwitchView } from '../api';
import { switchTitle } from './channelSwitchText';
import c from './console.module.css';

export { CHANNEL_SWITCH_HINT } from './channelSwitchText';

/**
 * 渠道总开关（用户 2026-10-03）：开 = 启动上次使用的渠道，关 = 停止所有渠道。
 * 与 VS Code 侧边栏同一套状态；旧版 daemon 没有 /channel 时不显示。
 */
export function ChannelSwitch({ view, busy, onToggle, className }: { view: ChannelSwitchView | null; busy: boolean; onToggle: (on: boolean) => void; className?: string }) {
  if (!view) return null;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={view.on}
      aria-label="公网渠道开关"
      className={className ? `${c.chSwitch} ${className}` : c.chSwitch}
      data-state={busy ? 'starting' : view.state}
      disabled={busy || view.state === 'starting'}
      title={switchTitle(view)}
      onClick={(e) => {
        e.stopPropagation();
        onToggle(!view.on);
      }}
    />
  );
}
