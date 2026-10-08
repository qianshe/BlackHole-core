import { useEffect, useRef, useState } from 'react';
import { api, ApiError, type AccountView } from './api';
import { errorText } from './format';
import f from './Forms.module.css';

const SIGN_IN_ERROR: Record<string, string> = {
  cancelled: '已取消登录。',
  expired: '登录链接已过期，请重新登录。',
  rejected: '登录被拒绝，请重试。',
  network: '连不上 BlackHole 云端，请检查网络后重试。',
  browser_failed: '没能打开浏览器，请重试。',
  rate_limited: '操作太频繁，请稍后再试。',
  storage: '保存登录信息失败，请重试。',
};

function remaining(sec?: number): string | null {
  if (sec === undefined) return null;
  if (sec <= 0) return '已过期';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  return d > 0 ? `剩余 ${d} 天 ${h} 小时` : `剩余 ${Math.max(1, h)} 小时`;
}

export function AccountCard() {
  const [view, setView] = useState<AccountView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  const fail = (e: unknown): void => setError(e instanceof ApiError ? errorText(e.code, e.detail) : errorText('network'));
  const load = (): void => { api.account().then((v) => { setView(v); setError(null); }, fail); };
  useEffect(() => { load(); return () => window.clearTimeout(timer.current); }, []);

  const running = view?.signIn.state === 'running';
  useEffect(() => {
    if (!running) return;
    timer.current = window.setTimeout(load, 2000);
    return () => window.clearTimeout(timer.current);
  }, [running, view]);

  const act = (p: Promise<unknown>): void => {
    setBusy(true);
    setError(null);
    p.then(load, fail).finally(() => setBusy(false));
  };

  const status = !view ? null
    : view.storage === 'unavailable' ? { tone: f.fieldError, text: '无法使用', hint: '这台电脑无法保存登录信息，请检查用户目录是否可写。' }
    : view.state === 'verified' ? { tone: f.okText, text: '已登录', hint: null }
    : view.state === 'saved' ? { tone: f.okText, text: '已登录', hint: null }
    : view.state === 'unavailable' ? { tone: f.fieldError, text: '暂时无法确认', hint: '稍后会自动重试。' }
    : { tone: f.hint, text: '未登录', hint: '登录后才能开始新会话。' };
  const signedIn = view && (view.state === 'verified' || view.state === 'saved');
  const job = view?.signIn;

  return (
    <section className={f.card} aria-labelledby="s-account">
      <h2 id="s-account" className={f.cardTitle}>账号</h2>
      {!view && !error && <p className={f.hint}>正在读取…</p>}
      {status && (
        <p className={status.tone} role="status">
          <strong>{status.text}</strong>
          {signedIn && view.account && <> · {view.account.name || view.account.email}</>}
          {signedIn && remaining(view.remainingSeconds) && <> · {remaining(view.remainingSeconds)}</>}
        </p>
      )}
      {status?.hint && <p className={f.hint}>{status.hint}</p>}
      {running && <p className={f.hint}>请在打开的浏览器页面里完成登录。</p>}
      {job?.state === 'failed' && !signedIn && <p className={f.fieldError}>{SIGN_IN_ERROR[job.error] ?? errorText(job.error)}</p>}
      {error && <p className={f.fieldError}>{error}</p>}
      {view && view.storage === 'available' && (
        <div className={f.inline}>
          {running ? (
            <button type="button" className={f.secondary} disabled={busy} onClick={() => act(api.accountCancelSignIn())}>取消登录</button>
          ) : signedIn ? (
            <button type="button" className={f.secondary} disabled={busy} onClick={() => { if (window.confirm('确定退出登录？')) act(api.accountSignOut()); }}>退出登录</button>
          ) : (
            <button type="button" className={f.primary} disabled={busy} onClick={() => act(api.accountSignIn())}>登录</button>
          )}
        </div>
      )}
    </section>
  );
}

export function ServiceCard() {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stopped, setStopped] = useState(false);

  const stop = (): void => {
    setBusy(true);
    setError(null);
    api.stopDaemon().then(
      () => setStopped(true),
      (e: unknown) => { setError(e instanceof ApiError ? errorText(e.code, e.detail) : errorText('network')); setBusy(false); },
    );
  };

  if (stopped) {
    return (
      <div className={f.stopped} role="alertdialog" aria-labelledby="s-stopped">
        <div className={f.card}>
          <h2 id="s-stopped" className={f.cardTitle}>BlackHole 已停止</h2>
          <p className={f.hint}>可以关闭这个页面。要再次使用，打开 BlackHole 应用。</p>
        </div>
      </div>
    );
  }

  return (
    <section className={f.card} aria-labelledby="s-service">
      <h2 id="s-service" className={f.cardTitle}>后台服务</h2>
      <p className={f.hint}>BlackHole 会在后台一直运行。停止后，AI 将无法连接本机，正在进行的会话会中断。</p>
      {error && <p className={f.fieldError}>{error}</p>}
      <div className={f.inline}>
        {confirming ? (
          <>
            <button type="button" className={f.danger} disabled={busy} onClick={stop}>{busy ? '正在停止…' : '确认停止'}</button>
            <button type="button" className={f.secondary} disabled={busy} onClick={() => setConfirming(false)}>取消</button>
          </>
        ) : (
          <button type="button" className={f.secondary} onClick={() => setConfirming(true)}>停止 BlackHole</button>
        )}
      </div>
    </section>
  );
}
