export type AccountAuthState = 'logged_out' | 'saved' | 'verified' | 'unavailable';

export interface AccountSourceLike {
  state: AccountAuthState;
  userId?: string;
  checkedAt?: number;
  remainingSeconds?: number;
  account?: {
    name?: string;
    email?: string;
    status?: string;
    serviceExpiresAt?: number;
  };
}

export interface AccountSummary {
  authState: AccountAuthState;
  userId: string | null;
  displayName: string;
  email: string | null;
  accountStatus: string | null;
  remainingSeconds: number | null;
  serviceExpiresAt: number | null;
  checkedAt: number | null;
  freshness: 'fresh' | 'saved' | 'unknown';
  canSignOut: boolean;
}

export function accountSummary(input: AccountSourceLike | null | undefined): AccountSummary {
  const state = input?.state ?? 'unavailable';
  const userId = state !== 'logged_out' && typeof input?.userId === 'string' && input.userId.trim() ? input.userId.trim() : null;
  const a = userId ? input?.account : undefined;
  const name = typeof a?.name === 'string' && a.name.trim() ? a.name.trim() : '';
  const email = typeof a?.email === 'string' && a.email.trim() ? a.email.trim() : null;
  const displayName = name || email || (userId ? (userId.length > 14 ? userId.slice(0, 8) + '…' + userId.slice(-4) : userId) : state === 'logged_out' ? '未登录' : '账号状态待确认');
  const remaining = userId && typeof input?.remainingSeconds === 'number' && Number.isFinite(input.remainingSeconds)
    ? Math.max(0, Math.floor(input.remainingSeconds))
    : null;
  const status = typeof a?.status === 'string' ? a.status : null;
  return {
    authState: state,
    userId,
    displayName,
    email,
    accountStatus: status,
    remainingSeconds: remaining,
    serviceExpiresAt: typeof a?.serviceExpiresAt === 'number' && Number.isFinite(a.serviceExpiresAt) ? Math.max(0, Math.floor(a.serviceExpiresAt)) : null,
    checkedAt: userId && typeof input?.checkedAt === 'number' && Number.isFinite(input.checkedAt) ? input.checkedAt : null,
    freshness: !userId ? 'unknown' : state === 'verified' ? 'fresh' : state === 'saved' ? 'saved' : 'unknown',
    canSignOut: userId !== null,
  };
}

export function formatRemaining(seconds: number | null): string {
  if (seconds === null) return '时长待确认';
  if (seconds <= 0) return '订阅已到期';
  if (seconds < 60) return '剩余不足 1 分钟';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `剩余 ${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  if (hours < 24) return `剩余 ${hours} 小时${remMin ? ` ${remMin} 分钟` : ''}`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return `剩余 ${days} 天${remHours ? ` ${remHours} 小时` : ''}`;
}

export function accountSummaryKey(summary: AccountSummary): string {
  return JSON.stringify([
    summary.authState, summary.userId, summary.displayName, summary.email, summary.accountStatus,
    summary.remainingSeconds, summary.serviceExpiresAt, summary.checkedAt, summary.freshness,
  ]);
}
