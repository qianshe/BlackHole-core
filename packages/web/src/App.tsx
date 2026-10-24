import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, ApiError } from './api';
import { takeTicket } from './format';
import { Console } from './console/Console';
import { RemoteApp } from './remote/RemoteApp';
import { Icon, Logo, Skeleton } from './ui';
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
    // Drop any intent saved by the old pre-login chooser. A channel installer
    // must run only after the user explicitly chooses it in the new signed-in step.
    try { sessionStorage.removeItem('blackhole.pendingSetup.v1'); sessionStorage.removeItem('blackhole.loginAttempt.v1'); } catch { /* optional storage */ }
    const ticket = takeTicket(window.location.hash);
    // One-time tickets must not remain in history. The Desktop has a separate
    // document path; it needs no capability hints or magic fragments.
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
  account_unavailable: '本机安全存储暂不可用，无法保存登录信息。请检查 Core 状态。',
  storage: '无法安全保存账号，请检查本机凭据存储。',
  invalid_response: '认证服务响应不符合协议，已停止本次登录。',
  rejected: '授权未完成或已失效，请重新发起登录。',
  attempt_unknown: '本次登录任务已失效，请重新开始。',
  superseded: '本次登录已被新的登录任务取代，请重新开始。',
  account_required: 'Core 尚未确认账号登录，请在授权页面完成登录。',
};

const SETUP_SKIPPED = 'blackhole.setupSkipped.v1';
const PENDING_SETUP = 'blackhole.pendingSetup.v1';
type ConnectionChoice = 'direct' | 'cloudflare' | 'openai';
type SetupStatus = 'loading' | 'absent' | 'unknown';

function WelcomeProgress({ step }: { step: 0 | 1 }) {
  return (
    <ol className={s.progress} aria-label="准备进度">
      {(['登录', '连接', '开始'] as const).map((label, index) => (
        <li key={label} className={index < step ? s.progressDone : index === step ? s.progressCurrent : s.progressUpcoming}
          aria-current={index === step ? 'step' : undefined}>
          <span className={s.progressNumber}>{index < step ? '✓' : String(index + 1).padStart(2, '0')}</span>
          <span>{label}</span>
        </li>
      ))}
    </ol>
  );
}

function WelcomeCard({ step, title, description, children }: {
  step?: 0 | 1; title: string; description: string; children: ReactNode;
}) {
  return (
    <main className={s.center}>
      <section className={s.card} aria-labelledby="welcome-title">
        <div className={s.brandRow}><span className={s.brandIcon}><Logo size={23} /></span><span>BLACKHOLE</span></div>
        {step !== undefined && <WelcomeProgress step={step} />}
        <div className={s.intro}>
          {step !== undefined && <span className={s.eyebrow}>步骤 {String(step + 1).padStart(2, '0')} / 03</span>}
          <h1 id="welcome-title" className={s.cardTitle}>{title}</h1>
          <p className={s.cardText}>{description}</p>
        </div>
        {children}
      </section>
    </main>
  );
}

type WelcomeState = {
  state: 'checking' | 'logged_out' | 'saved' | 'verified' | 'unavailable';
  signIn: { state: 'idle' | 'running' | 'done' | 'failed'; error?: string };
};

/** A single native adapter delegates to the existing Core account service.
 * The independent browser document has no host binding and cannot sign in. */
async function nativeWelcome(action: 'status' | 'sign-in' | 'verify' | 'cancel'): Promise<WelcomeState> {
  const bridge = window.blackholeDesktopWelcomeAction;
  if (typeof bridge !== 'function') throw new Error('native_welcome_unavailable');
  let timer: number | undefined;
  const response: unknown = await Promise.race([
    bridge(action),
    new Promise<never>((_, reject) => {
      timer = window.setTimeout(() => reject(new Error('native_welcome_timeout')), action === 'status' ? 5000 : 35_000);
    }),
  ]).finally(() => {
    if (timer !== undefined) window.clearTimeout(timer);
  });
  if (response === null || response === undefined) throw new Error('native_welcome_unbound');
  const value: unknown = typeof response === 'string' ? JSON.parse(response) : response;
  const result = value as WelcomeState | null;
  if (!result || !['checking', 'logged_out', 'saved', 'verified', 'unavailable'].includes(result.state)
    || !['idle', 'running', 'done', 'failed'].includes(result.signIn?.state)) throw new Error('welcome_response_invalid');
  return result;
}

function DesktopLogin({ onDone }: { onDone: (a: Auth) => void }) {
  const [status, setStatus] = useState<WelcomeState>({ state: 'checking', signIn: { state: 'idle' } });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lifecycle = useRef({ active: true, finished: false });
  const handoff = useRef<Promise<Auth | null> | null>(null);
  const complete = (auth: Auth) => {
    if (!lifecycle.current.active || lifecycle.current.finished || auth.state !== 'ok') return;
    lifecycle.current.finished = true;
    onDone(auth);
  };
  // Polling and an explicit native action may observe verification together.
  // Create one cookie/session pair, otherwise a late response can overwrite
  // the CSRF token with one belonging to an already-replaced cookie.
  const enterWorkspace = (): Promise<Auth | null> => {
    const owner = lifecycle.current;
    if (!owner.active || owner.finished) return Promise.resolve(null);
    if (handoff.current) return handoff.current;
    const pending = (async () => {
      await api.localLogin();
      if (lifecycle.current !== owner || !owner.active || owner.finished) return null;
      const auth = await currentAuth();
      if (lifecycle.current === owner) complete(auth);
      return auth;
    })().finally(() => {
      if (handoff.current === pending) handoff.current = null;
    });
    handoff.current = pending;
    return pending;
  };

  useEffect(() => {
    lifecycle.current = { active: true, finished: false };
    let alive = true;
    let fetching = false;
    const refresh = async () => {
      if (fetching) return;
      fetching = true;
      try {
        // Core is the source of truth for whether the account is verified.
        // This read-only, same-origin endpoint does not create a Web session or
        // start a sign-in. Crucially, it does not depend on the WebView2 RPC
        // script being injected, so a logged-out Desktop shows its login action.
        const core = await api.authStatus();
        if (!alive) return;
        setStatus(previous => ({ ...previous, state: core.state }));
        setError(null);
        if (core.state === 'verified') {
          const auth = await enterWorkspace();
          if (alive && auth?.state === 'login') setError('账号已验证，工作区连接暂未恢复；页面会自动重试。');
          return;
        }
        // Native RPC is still required for the actual sign-in/cancel actions,
        // and supplies the running/failed job state when it is available.
        // A failed native status read must not reset the confirmed Core state
        // back to "checking" or hide the login action.
        try {
          const native = await nativeWelcome('status');
          if (!alive) return;
          setStatus(previous => ({
            ...previous,
            state: core.state,
            signIn: native.signIn,
          }));
          setError(null);
        } catch (e) {
          if (alive) setError(e instanceof Error && e.message === 'native_welcome_unavailable'
            ? 'Desktop 登录通道尚未就绪；登录按钮仅在原生通道可用时才能完成操作。'
            : e instanceof Error && e.message === 'native_welcome_unbound'
              ? 'Desktop 原生登录处理器未注册，请重新启动客户端。'
              : e instanceof Error && e.message === 'native_welcome_timeout'
                ? 'Desktop 登录通道未响应，正在重试。'
                : 'Desktop 登录通道异常，请检查客户端或 Core 日志。');
        }
      } catch {
        if (alive) setError('无法读取 Core 账号状态，请确认本机服务正在运行。');
      } finally { fetching = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 1500);
    return () => { alive = false; lifecycle.current.active = false; clearInterval(timer); };
  }, [onDone]);

  const act = async (action: 'sign-in' | 'verify' | 'cancel') => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await nativeWelcome(action);
      if (!lifecycle.current.active || lifecycle.current.finished) return;
      setStatus(next);
      if (next.state === 'verified') {
        await enterWorkspace();
      }
    } catch (e) {
      if (!lifecycle.current.active || lifecycle.current.finished) return;
      const code = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
      setError(code.includes('409') ? (LOGIN_ERRORS.busy ?? '已有登录正在进行。')
        : code.includes('503') ? (LOGIN_ERRORS.account_unavailable ?? 'Core 认证不可用。')
        : action === 'verify' ? '无法验证已保存的账号，请检查网络或 Core 日志。'
          : 'Core 无法完成此操作，请检查认证服务和 Core 日志。');
    } finally { if (lifecycle.current.active && !lifecycle.current.finished) setBusy(false); }
  };

  const waiting = status.signIn.state === 'running';
  const checking = status.state === 'checking';
  const needsVerification = status.state === 'saved' || status.state === 'unavailable';
  const failure = status.signIn.state === 'failed' ? status.signIn.error : undefined;

  return (
    <WelcomeCard step={0} title="欢迎使用 BlackHole"
      description="先由 Shared Core 验证账号，之后才能选择连接渠道和进入工作区。">
      <div className={s.loginPanel}>
        {checking && !error ? <p className={s.status} role="status"><span className={s.spinner} aria-hidden="true"/>正在检查本机账号…</p> : null}
        {status.state === 'verified' && <p className={s.status} role="status"><span className={s.spinner} aria-hidden="true"/>账号已验证，正在恢复工作区…</p>}
        {waiting ? (
          <>
            <p className={s.status} role="status"><span className={s.spinner} aria-hidden="true" />请在系统浏览器中完成登录，Core 将自动确认结果。</p>
            <button className={s.secondaryAction} type="button" disabled={busy} onClick={() => void act('cancel')}>取消登录</button>
          </>
        ) : needsVerification ? (
          <>
            <p className={s.status} role="status">账号尚未验证完成；不会据此开放 Web 工作区。</p>
            <button className={s.primaryAction} type="button" disabled={busy} onClick={() => void act('verify')}>重新验证已保存的账号</button>
          </>
        ) : status.state === 'logged_out' ? (
          <button className={s.primaryAction} type="button" disabled={busy} onClick={() => void act('sign-in')}>
            在系统浏览器中登录 <Icon name="login" size={17} />
          </button>
        ) : null}
        {failure && !waiting && <p className={s.error} role="alert">{LOGIN_ERRORS[failure] ?? 'Core 登录未完成，请检查认证服务状态后重试。'}</p>}
        {error && <p className={s.error} role="alert">{error}</p>}
        <p className={s.helper}>登录信息仅保存在 Shared Core。此窗口不接收账号密码或授权密钥。</p>
      </div>
    </WelcomeCard>
  );
}

/** Standalone browser Web is intentionally passive. It cannot call a native
 * host bridge, begin cloud login or select/install a connection channel. */
function BrowserWaiting({ onDone }: { onDone: (a: Auth) => void }) {
  const [phase, setPhase] = useState<'checking' | 'logged_out' | 'saved' | 'unavailable'>('checking');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let fetching = false;
    const check = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const next = await api.authStatus();
        if (!alive) return;
        if (next.state === 'verified') {
          await api.localLogin();
          const auth = await currentAuth();
          if (alive && auth.state === 'ok') onDone(auth);
        } else {
          setPhase(next.state);
          setError(null);
        }
      } catch {
        if (alive) { setPhase('unavailable'); setError('暂时无法连接 Core；页面会自动重试。'); }
      } finally { fetching = false; }
    };
    void check();
    const timer = setInterval(() => void check(), 1600);
    return () => { alive = false; clearInterval(timer); };
  }, [onDone]);
  return (
    <WelcomeCard title="等待 BlackHole 认证"
      description="此页面仅用于查看工作区。请在 BlackHole Desktop 或 VS Code 欢迎页完成登录和首次配置。">
      <p className={s.status} role="status">
        <span className={s.spinner} aria-hidden="true"/>
        {phase === 'saved' ? 'Core 已保存账号，正在等待客户端验证…'
          : phase === 'unavailable' ? 'Core 账号状态暂不可用，正在等待恢复…'
            : phase === 'checking' ? '正在检查 Core 账号状态…' : 'Core 尚未登录，等待客户端完成认证…'}
      </p>
      {error && <p className={s.error} role="alert">{error}</p>}
      <p className={s.helper}>无需在 Web 中重复登录。认证完成后将自动进入工作区。</p>
    </WelcomeCard>
  );
}

/** The channel choice is not mounted until LocalApp has confirmed authentication. */
function ConnectionSetup({ onDone, onAuthChanged }: { onDone: () => void; onAuthChanged: (a: Auth) => void }) {
  const [status, setStatus] = useState<SetupStatus>('loading');
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    try {
      if (localStorage.getItem(SETUP_SKIPPED) === '1') { onDone(); return; }
    } catch { /* browser storage may be unavailable */ }
    void api.setupSummary().then(
      ({ configuration }) => {
        if (!alive) return;
        if (configuration === 'present') onDone();
        else setStatus(configuration === 'absent' ? 'absent' : 'unknown');
      },
      () => { if (alive) setStatus('unknown'); },
    );
    return () => { alive = false; };
  }, [retry, onDone]);

  const proceed = async (choice?: ConnectionChoice): Promise<void> => {
    if (busy || (choice && status !== 'absent')) return;
    setBusy(true);
    setError(null);
    const auth = await currentAuth();
    if (auth.state !== 'ok') { onAuthChanged(auth); return; }

    if (choice) {
      // Console consumes this one-shot action after its authenticated mount.
      // A failed storage write must not silently pretend installation started.
      try {
        if (choice === 'direct') sessionStorage.removeItem(PENDING_SETUP);
        else sessionStorage.setItem(PENDING_SETUP, choice);
      } catch {
        setError('无法保存连接准备状态。请允许当前窗口的会话存储，或稍后从设置中配置。');
        setBusy(false);
        return;
      }
      history.replaceState(null, '', window.location.pathname + '?set=connections');
    } else {
      try {
        sessionStorage.removeItem(PENDING_SETUP);
        localStorage.setItem(SETUP_SKIPPED, '1');
      } catch { /* skipping is still allowed without persistence */ }
    }
    onDone();
  };

  return (
    <WelcomeCard step={1} title="选择连接方式"
      description="账号已登录。接下来选择一种连接方式，或稍后在「设置 → 连接与渠道」中完成。">
      <div className={s.signedIn}><Icon name="check" size={15} /> 登录已完成</div>
      {status === 'loading' ? (
        <p className={s.status} role="status"><span className={s.spinner} aria-hidden="true" />正在检查已保存的连接配置…</p>
      ) : status === 'unknown' ? (
        <div className={s.unknownBlock}>
          <p role="status">暂时无法确认是否已有连接配置。为避免重复安装，暂不提供自动安装选项。</p>
          <button type="button" className={s.secondaryAction} disabled={busy} onClick={() => { setStatus('loading'); setRetry((v) => v + 1); }}>重新检测</button>
        </div>
      ) : (
        <div className={s.setupGrid} role="group" aria-label="选择连接渠道">
          <button type="button" className={s.channelOption} disabled={busy} onClick={() => void proceed('cloudflare')}>
            <span className={s.optionIcon}><Icon name="globe" size={19} /></span>
            <span className={s.optionCopy}><strong>临时公网连接 · Cloudflare</strong><span>准备 cloudflared；由你决定何时启动公网渠道。</span></span>
            <Icon name="chevron" size={17} />
          </button>
          <button type="button" className={s.channelOption} disabled={busy} onClick={() => void proceed('openai')}>
            <span className={s.optionIcon}><Icon name="shield" size={19} /></span>
            <span className={s.optionCopy}><strong>OpenAI Tunnel</strong><span>准备官方 tunnel-client，之后设置 Tunnel ID 和密钥。</span></span>
            <Icon name="chevron" size={17} />
          </button>
          <button type="button" className={s.channelOption} disabled={busy} onClick={() => void proceed('direct')}>
            <span className={s.optionIcon}><Icon name="link" size={19} /></span>
            <span className={s.optionCopy}><strong>直连或自建 HTTPS</strong><span>使用局域网、组网或自己的固定连接入口。</span></span>
            <Icon name="chevron" size={17} />
          </button>
        </div>
      )}
      {error && <p className={s.error} role="alert">{error}</p>}
      <div className={s.setupFooter}>
        <button type="button" className={s.skipSetup} disabled={busy} onClick={() => void proceed()}>
          {busy ? '正在确认…' : '稍后设置，进入工作区'} <Icon name="chevron" size={15} />
        </button>
        <p className={s.helper}>连接渠道是可选步骤，不会影响本地会话和工作区使用。</p>
      </div>
    </WelcomeCard>
  );
}

function LocalApp() {
  const [auth, setAuth] = useState<Auth>({ state: 'checking' });
  const [welcomeDone, setWelcomeDone] = useState(false);
  const finishWelcome = useCallback(() => setWelcomeDone(true), []);
  useEffect(() => {
    let cancelled = false;
    void authenticate().then((a) => {
      if (!cancelled) setAuth(a);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const signedOut = useCallback((reason: string) => {
    setWelcomeDone(false);
    setAuth({ state: 'login', reason });
  }, []);

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

  if (auth.state === 'login') return IS_DESKTOP ? <DesktopLogin onDone={setAuth} /> : <BrowserWaiting onDone={setAuth} />;
  if (IS_DESKTOP && !welcomeDone) return <ConnectionSetup onDone={finishWelcome} onAuthChanged={setAuth} />;

  return <Console onSignedOut={signedOut} />;
}

/** The phone page is served on the public address; loopback is this computer. */
const IS_REMOTE = !/^(127\.0\.0\.1|localhost|\[::1\])$/.test(window.location.hostname);
// Separate entry documents, one shared UI. The path selects presentation,
// never permission: only the native host can invoke Core sign-in.
const IS_DESKTOP = !IS_REMOTE && /^\/desktop\/?$/.test(window.location.pathname);

export function App() {
  return IS_REMOTE ? <RemoteApp /> : <LocalApp />;
}

