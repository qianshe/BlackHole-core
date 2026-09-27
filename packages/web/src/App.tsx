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
  const run = useRef(0);
  useEffect(() => () => void run.current++, []);

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
            <Button icon="login" onClick={() => void start()}>
              {reason === 'signed_out' ? '进入' : '登录'}
            </Button>
            {reason !== 'signed_out' && <p className={s.cardHint}>将在浏览器中完成登录。</p>}
          </>
        ) : (
          <>
            <p className={s.cardText} role="status">
              请在浏览器中完成登录，完成后这里会自动进入。
            </p>
            <Button onClick={() => { run.current++; setPhase('idle'); }}>取消</Button>
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

