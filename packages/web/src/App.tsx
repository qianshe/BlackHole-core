import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';
import { takeTicket } from './format';
import { Console } from './console/Console';
import { RemoteApp } from './remote/RemoteApp';
import { Button, Logo, Skeleton } from './ui';
import s from './App.module.css';

type Auth = { state: 'checking' } | { state: 'ok'; version: string } | { state: 'login'; reason: string };

// One bootstrap per page load (StrictMode runs effects twice in development).
let bootstrap: Promise<Auth> | null = null;
async function currentAuth(): Promise<Auth> {
  try {
    const me = await api.session();
    return me.account_required ? { state: 'login', reason: 'account_required' } : { state: 'ok', version: me.version };
  } catch (e) {
    return { state: 'login', reason: e instanceof ApiError ? e.code : 'network' };
  }
}
function authenticate(): Promise<Auth> {
  bootstrap ??= (async (): Promise<Auth> => {
    const ticket = takeTicket(window.location.hash);
    // Drop the fragment before anything else so the ticket stays out of history.
    if (window.location.hash) history.replaceState(null, '', window.location.pathname + window.location.search);
    if (ticket) await api.exchange(ticket).catch(() => undefined); // a used ticket falls back to the cookie
    const first = await currentAuth();
    // No cookie yet: this machine's signed-in account lets a local browser straight in.
    if (first.state === 'login' && first.reason === 'unauthenticated' && (await api.localLogin().then(() => true, () => false))) return currentAuth();
    return first;
  })();
  return bootstrap;
}

const LOGIN_ERRORS: Record<string, string> = {
  account_mismatch: '请使用这台电脑上 BlackHole 已登录的账号。',
  cancelled: '登录已取消。',
  browser_failed: '无法打开浏览器，请重试。',
  network: '无法连接登录服务，请检查网络后重试。',
  not_available: '登录服务暂时不可用，请稍后重试。',
  rate_limited: '尝试太频繁，请稍后重试。',
  busy: '另一个登录正在进行，请先完成它。',
  expired: '登录超时，请重试。',
  account_unavailable: '这台电脑无法保存登录，请在 VS Code 中使用 BlackHole。',
};

function Login({ reason, onDone }: { reason: string; onDone: (a: Auth) => void }) {
  const [phase, setPhase] = useState<'idle' | 'waiting'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [setup, setSetup] = useState<'loading' | 'present' | 'absent' | 'unknown'>('loading');
  const [setupSkipped, setSetupSkipped] = useState(() => { try { return localStorage.getItem('blackhole.setupSkipped.v1') === '1'; } catch { return false; } });
  const run = useRef(0);
  useEffect(() => () => void run.current++, []);

  useEffect(() => {
    let alive = true;
    void api.setupSummary().then((v) => { if (alive) setSetup(v.configuration); }, () => { if (alive) setSetup('unknown'); });
    return () => { alive = false; };
  }, []);
  const start = useCallback(async () => {
    const mine = ++run.current;
    setError(null);
    setPhase('waiting');
    try {
      // Already signed in on this machine (e.g. after leaving the page): no browser round-trip.
      if (await api.localLogin().then(() => true, () => false)) {
        onDone(await currentAuth());
        return;
      }
      const { attempt } = await api.login();
      for (;;) {
        await new Promise((r) => setTimeout(r, 1500));
        if (run.current !== mine) return;
        const r = await api.loginPoll(attempt);
        if (r.state === 'running') continue;
        if (r.state === 'done') {
          onDone(await currentAuth());
          return;
        }
        throw new ApiError(400, r.error ?? 'failed');
      }
    } catch (e) {
      if (run.current !== mine) return;
      const code = e instanceof ApiError ? e.code : 'network';
      setError(LOGIN_ERRORS[code] ?? '登录未完成，请重试。');
      setPhase('idle');
    }
  }, [onDone]);

  const chooseSetup = (kind: 'direct' | 'cloudflare' | 'openai'): void => {
    try { sessionStorage.setItem('blackhole.pendingSetup.v1', kind); } catch { /* optional browser storage */ }
    history.replaceState(null, '', window.location.pathname + '?set=connections');
    void start();
  };
  const clearPendingSetup = (): void => {
    let hadPending = false;
    try { hadPending = sessionStorage.getItem('blackhole.pendingSetup.v1') !== null; sessionStorage.removeItem('blackhole.pendingSetup.v1'); } catch { /* optional browser storage */ }
    if (hadPending) history.replaceState(null, '', window.location.pathname);
  };
  const skipSetup = (): void => {
    clearPendingSetup();
    try { localStorage.setItem('blackhole.setupSkipped.v1', '1'); } catch { /* optional browser storage */ }
    setSetupSkipped(true);
  };

  return (
    <main className={s.center}>
      <div className={s.card}>
        <div className={s.brandRow}>
          <Logo size={28} />
          <h1 className={s.cardTitle}>{reason === 'signed_out' ? '已退出本地 Web' : '登录 BlackHole'}</h1>
        </div>
        {phase === 'idle' ? (
          <>
            <p className={s.cardText}>{reason === 'account_required' ? '这台电脑的 BlackHole 需要登录账号。' : '登录后使用。'}</p>
            <Button icon="login" onClick={() => { clearPendingSetup(); void start(); }}>
              {reason === 'signed_out' ? '进入' : '登录'}
            </Button>
            {reason !== 'signed_out' && <p className={s.cardHint}>将在浏览器中完成登录。</p>}
            {setup === 'absent' && !setupSkipped && (
              <section className={s.setupBlock} aria-label="连接渠道（可选）">
                <div className={s.setupTitle}>连接渠道（可选）</div>
                <p className={s.setupText}>也可以先跳过。选择后会先完成登录，再进入受保护的连接页继续准备。</p>
                <div className={s.setupGrid}>
                  <button type="button" onClick={() => chooseSetup('direct')}><strong>配置直连</strong><span>使用局域网、组网或自建 HTTPS。</span></button>
                  <button type="button" onClick={() => chooseSetup('cloudflare')}><strong>安装 Cloudflare</strong><span>登录后自动开始安装 runtime，不自动启动公网渠道。</span></button>
                  <button type="button" onClick={() => chooseSetup('openai')}><strong>安装 OpenAI</strong><span>登录后自动准备 tunnel-client，不依赖 Cloudflare。</span></button>
                </div>
                <button type="button" className={s.skipSetup} onClick={skipSetup}>跳过渠道安装</button>
              </section>
            )}
            {setup === 'present' && <p className={s.cardHint}>已检测到保存的连接配置；登录后直接进入工作区，不重复安装。</p>}
            {setup === 'unknown' && <p className={s.cardHint}>暂时无法确认连接配置；不会自动安装任何渠道。</p>}
          </>
        ) : (
          <>
            <p className={s.cardText} role="status">
              请在浏览器中完成登录，完成后这里会自动进入。
            </p>
            <Button onClick={() => { run.current++; clearPendingSetup(); setPhase('idle'); }}>取消</Button>
          </>
        )}
        {error && (
          <p className={s.cardHint} role="alert">
            {error}
          </p>
        )}
        {reason === 'network' && !error && <p className={s.cardHint}>暂时连不上 BlackHole，请确认它正在运行。</p>}
      </div>
    </main>
  );
}

function LocalApp() {
  const [auth, setAuth] = useState<Auth>({ state: 'checking' });
  useEffect(() => {
    let cancelled = false;
    void authenticate().then((a) => {
      if (!cancelled) setAuth(a);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const signedOut = useCallback((reason: string) => setAuth({ state: 'login', reason }), []);

  if (auth.state === 'checking')
    return (
      <div className={s.center} aria-busy="true">
        <div className={s.card}>
          <div className={s.brandRow}>
            <Logo size={28} />
            <span>正在连接 BlackHole…</span>
          </div>
          <Skeleton rows={2} height={12} />
        </div>
      </div>
    );

  if (auth.state === 'login') return <Login reason={auth.reason} onDone={setAuth} />;

  return <Console onSignedOut={signedOut} />;
}

/** The phone page is served on the public address; loopback is this computer. */
const IS_REMOTE = !/^(127\.0\.0\.1|localhost|\[::1\])$/.test(window.location.hostname);

export function App() {
  return IS_REMOTE ? <RemoteApp /> : <LocalApp />;
}

