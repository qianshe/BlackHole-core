import { useEffect, useRef, useState } from 'react';
import { api, ApiError, type AccountView } from './api';
import { errorText } from './format';
import { settingsHost } from './settings/host';
import { runManagedCoreAction } from './settings/managedCoreActions';
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
    : view.state === 'saved' ? { tone: f.hint, text: '等待验证', hint: '请使用 Desktop 或 VS Code 欢迎页完成账号验证。' }
    : view.state === 'unavailable' ? { tone: f.fieldError, text: '暂时无法确认', hint: '稍后会自动重试。' }
    : { tone: f.hint, text: '未登录', hint: '登录后才能开始新会话。' };
  const signedIn = view?.state === 'verified';
  const job = view?.signIn;

  return (
    <section className={f.card} aria-labelledby="s-account">
      <h2 id="s-account" className={f.cardTitle}>账号</h2>
      {!view && !error && <p className={f.hint}>正在读取…</p>}
      {status && (
        <p className={status.tone} role="status">
          <strong>{status.text}</strong>
          {signedIn && view.account && <> {view.account.name || view.account.email}</>}
          {signedIn && remaining(view.remainingSeconds) && <> {remaining(view.remainingSeconds)}</>}
        </p>
      )}
      {status?.hint && <p className={f.hint}>{status.hint}</p>}
      {running && <p className={f.hint}>请在打开的浏览器页面里完成登录。</p>}
      {job?.state === 'failed' && !signedIn && <p className={f.fieldError}>{SIGN_IN_ERROR[job.error] ?? errorText(job.error)}</p>}
      {error && <p className={f.fieldError}>{error}</p>}
      {view && view.storage === 'available' && (
        <div className={f.inline}>
          {signedIn ? (
            <button type="button" className={f.secondary} disabled={busy} onClick={() => { if (window.confirm('确定退出登录？')) act(api.accountSignOut()); }}>退出登录</button>
          ) : (
            <p className={f.hint}>请在 BlackHole Desktop 或 VS Code 欢迎页完成账号登录或验证。</p>
          )}
        </div>
      )}
    </section>
  );
}

export function ServiceCard({ managed = false, nativeMaintenance = false }: { managed?: boolean; nativeMaintenance?: boolean } = {}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stopped, setStopped] = useState(false);

  const stop = (): void => {
    if (managed && !nativeMaintenance) return;
    setBusy(true);
    setError(null);
    // Desktop-hosted pages hand the stop to the native host, which confirms
    // and runs the Manager transaction; the daemon's own stop route stays
    // rejected for managed Core. Other hosts keep their existing route.
    const request = managed && settingsHost().kind === 'desktop'
      ? runManagedCoreAction('stop').then(result => { if (!result.completed) throw new ApiError(409, 'native_maintenance_incomplete'); })
      : api.stopDaemon();
    request.then(
      () => setStopped(true),
      (e: unknown) => { setError(e instanceof ApiError ? errorText(e.code, e.detail) : errorText('network')); setBusy(false); },
    );
  };

  if (managed && !nativeMaintenance) {
    return <section className={f.card} aria-labelledby="s-service">
      <div className="bhp-danger-row">
        <div><b id="s-service">停止后台服务</b><small>请在 VS Code 或 BlackHole Desktop 中停止后台服务，浏览器中无法执行此操作。关闭此页面不会停止 BlackHole。</small></div>
        <button type="button" className={f.secondary} disabled>请在应用中停止</button>
      </div>
    </section>;
  }
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
      <div className="bhp-danger-row">
        <div>
          <b id="s-service">停止后台服务</b>
          <small>{managed ? '点击后会弹出确认窗口，确认后停止后台服务，AI 将无法连接本机。若其他窗口或 AI 仍在使用，请先结束任务并断开连接。' : 'BlackHole 会在后台一直运行。停止后，AI 将无法连接本机，正在进行的会话会中断。'}</small>
          {error && <p className={f.fieldError}>{error}</p>}
        </div>
        {confirming ? (
          <>
            <button type="button" className={f.danger} disabled={busy} onClick={stop}>{busy ? '正在停止…' : '确认停止'}</button>
            <button type="button" className={f.secondary} disabled={busy} onClick={() => setConfirming(false)}>取消</button>
          </>
        ) : (
          <button type="button" className={f.secondary} disabled={busy} onClick={() => managed ? stop() : setConfirming(true)}>{busy ? '等待确认或停止完成…' : '停止 BlackHole'}</button>
        )}
      </div>
    </section>
  );
}
