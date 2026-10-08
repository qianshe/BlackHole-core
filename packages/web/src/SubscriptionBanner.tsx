import type { AccountView } from './api';
import s from './SubscriptionBanner.module.css';

const SOON_S = 3 * 24 * 3600;

/** Subscription state for the header: expired pauses AI tool calls; the page itself stays usable. */
export function subscriptionNotice(view: AccountView | null, now = Date.now()): { tone: 'bad' | 'warn'; text: string } | null {
  if (!view || (view.state !== 'verified' && view.state !== 'saved') || typeof view.remainingSeconds !== 'number') return null;
  if (view.remainingSeconds <= 0) return { tone: 'bad', text: '订阅已到期，AI 工具调用已暂停。' };
  if (view.remainingSeconds <= SOON_S) {
    const d = new Date(now + view.remainingSeconds * 1000);
    return { tone: 'warn', text: `订阅将于 ${d.getMonth() + 1} 月 ${d.getDate()} 日到期。` };
  }
  return null;
}

export function SubscriptionBanner({ account, onRenew }: { account: AccountView | null; onRenew: () => void }) {
  const notice = subscriptionNotice(account);
  if (!notice) return null;
  return (
    <div className={notice.tone === 'bad' ? s.bad : s.warn} role="status">
      <span className={s.label}>{notice.tone === 'bad' ? '已到期' : '即将到期'}</span>
      <span>{notice.text}</span>
      <button type="button" className={s.action} onClick={onRenew}>
        续费
      </button>
    </div>
  );
}
