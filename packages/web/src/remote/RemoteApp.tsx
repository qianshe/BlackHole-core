// Phone page on the public address (plan 6.13 R5): pair from the QR code, then
// approvals, sessions and new sessions. Talks only to /remote-api/v1.
import { Component, useCallback, useEffect, useState, type ReactNode } from 'react';
import type { SessionView } from '../api';
import { argsPreview, relativeTime, sessionTitle, SESSION_STATUS_LABEL, sessionTone } from '../format';
import s from './remote.module.css';
import { call, RemoteError } from './call';
import { NewChat, SessionChat } from './RemoteChat';

interface Me { device: string; version: string; remaining_seconds: number | null }
interface Confirmation { id: string; session_id: string; tool: string; args: unknown; status: string; created_at: string; expires_at: string }
interface Project { id: string; label: string; path: string; sessions: number }

type Phase =
  | { k: 'loading' }
  | { k: 'unpaired'; failed?: boolean }
  | { k: 'waiting'; token: string; device: string }
  | { k: 'denied' }
  | { k: 'timeout' }
  | { k: 'account' }
  | { k: 'offline' }
  | { k: 'ready'; me: Me };

// survives a reload while the computer has not answered yet
const TOKEN_KEY = 'bh_pair_wait';

function takePairCode(): string | null {
  const m = /^#pair=([A-Za-z0-9_-]{22})$/.exec(window.location.hash);
  if (window.location.hash) history.replaceState(null, '', window.location.pathname);
  return m ? m[1]! : null;
}

let started: Promise<Phase> | null = null;
async function whoAmI(): Promise<Phase> {
  try {
    return { k: 'ready', me: await call<Me>('/session') };
  } catch (e) {
    if (e instanceof RemoteError && e.code === 'account_required') return { k: 'account' };
    if (e instanceof RemoteError && (e.status === 401 || e.status === 404)) return { k: 'unpaired' };
    return { k: 'offline' };
  }
}
function boot(): Promise<Phase> {
  started ??= (async () => {
    const code = takePairCode();
    if (code) {
      try {
        const r = await call<{ token: string; device: string }>('/pair', { code });
        sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ token: r.token, device: r.device }));
        return { k: 'waiting', token: r.token, device: r.device } as Phase;
      } catch (e) {
        if (e instanceof RemoteError && e.code === 'account_required') return { k: 'account' } as Phase;
        const me = await whoAmI();
        return me.k === 'unpaired' ? { k: 'unpaired', failed: true } : me;
      }
    }
    const me = await whoAmI();
    if (me.k !== 'unpaired') return me;
    try {
      const w = JSON.parse(sessionStorage.getItem(TOKEN_KEY) ?? 'null') as { token?: unknown; device?: unknown } | null;
      if (w && typeof w.token === 'string') return { k: 'waiting', token: w.token, device: String(w.device ?? '') } as Phase;
    } catch { /* ignore */ }
    return me;
  })();
  return started;
}

/**
 * A render error must never leave the phone on a blank page: show what broke and a way back.
 * The message is shown so a report from the phone names the actual failure.
 */
class Guard extends Component<{ children: ReactNode; onReset?: () => void }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: unknown) { return { error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }; }
  render() {
    if (this.state.error === null) return this.props.children;
    return (
      <main className={s.notice} role="alert">
        <div className={s.brand}>BlackHole</div>
        <h1>页面出错了</h1>
        <p>{this.state.error}</p>
        <div className={s.actions}>
          <button type="button" className={s.btnPrimary} onClick={() => { this.setState({ error: null }); this.props.onReset?.(); }}>返回</button>
          <button type="button" className={s.btn} onClick={() => window.location.reload()}>刷新</button>
        </div>
      </main>
    );
  }
}

function Notice({ title, text }: { title: string; text: string }) {
  return (
    <main className={s.notice}>
      <div className={s.brand}>BlackHole</div>
      <h1>{title}</h1>
      <p>{text}</p>
    </main>
  );
}

export function RemoteApp() {
  const [phase, setPhase] = useState<Phase>({ k: 'loading' });
  useEffect(() => { void boot().then(setPhase); }, []);
  const lost = useCallback((e: unknown) => {
    if (e instanceof RemoteError && e.code === 'account_required') setPhase({ k: 'account' });
    else if (e instanceof RemoteError && (e.status === 401 || e.status === 404)) setPhase({ k: 'unpaired' });
  }, []);
  if (phase.k === 'loading') return <main className={s.notice} aria-busy="true"><div className={s.brand}>BlackHole</div><p>正在连接…</p></main>;
  if (phase.k === 'waiting') return <Waiting token={phase.token} device={phase.device} onDone={setPhase} />;
  if (phase.k === 'denied') return <Notice title="电脑拒绝了访问" text="如需使用，请在电脑上重新生成二维码再扫码。" />;
  if (phase.k === 'timeout') return <Notice title="等待超时" text="电脑上没有点「允许」。请在电脑上重新生成二维码再扫码。" />;
  if (phase.k === 'unpaired') return <Notice title={phase.failed ? '二维码已失效' : '需要扫码'} text="请在电脑上打开 BlackHole 设置 → 手机访问，生成二维码后用手机扫码。" />;
  if (phase.k === 'account') return <Notice title="电脑端需要重新登录" text="请在电脑上登录 BlackHole，登录后这里会恢复。" />;
  if (phase.k === 'offline') return <Notice title="连不上电脑" text="请确认电脑上的 BlackHole 和公网渠道正在运行。" />;
  return <Guard><Ready me={phase.me} lost={lost} /></Guard>;
}

/** Scanned; the computer has to click 允许 before this phone gets in. */
function Waiting({ token, device, onDone }: { token: string; device: string; onDone: (p: Phase) => void }) {
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const end = (p: Phase): void => {
      sessionStorage.removeItem(TOKEN_KEY);
      onDone(p);
    };
    const poll = async (): Promise<void> => {
      try {
        const r = await call<{ state: string }>('/pair/claim', { token });
        if (!alive) return;
        if (r.state === 'approved') return end(await whoAmI());
      } catch (e) {
        if (!alive) return;
        if (e instanceof RemoteError && e.code === 'pair_denied') return end({ k: 'denied' });
        if (e instanceof RemoteError && e.code === 'pair_expired') return end({ k: 'timeout' });
        if (e instanceof RemoteError && e.code === 'account_required') return end({ k: 'account' });
      }
      timer = setTimeout(() => void poll(), 2000);
    };
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [token, onDone]);
  return (
    <main className={s.notice} aria-busy="true">
      <div className={s.brand}>BlackHole</div>
      <h1>请在电脑上点「允许」</h1>
      <p>电脑上会弹出「手机请求访问」{device ? `（${device}）` : ''}，点「允许」后这里会自动进入。</p>
    </main>
  );
}

type Tab = 'approvals' | 'sessions' | 'new';

function Ready({ me, lost }: { me: Me; lost: (e: unknown) => void }) {
  const [tab, setTab] = useState<Tab>('sessions');
  const [sessions, setSessions] = useState<SessionView[]>([]);
  const [pending, setPending] = useState<Confirmation[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      const [a, b] = await Promise.all([call<{ sessions: SessionView[] }>('/sessions'), call<{ confirmations: Confirmation[] }>('/confirmations')]);
      setSessions(Array.isArray(a.sessions) ? a.sessions : []);
      setPending((Array.isArray(b.confirmations) ? b.confirmations : []).filter((c) => c.status === 'pending'));
    } catch (e) { lost(e); }
  }, [lost]);
  // Hidden tabs stop polling: every request counts against the phone's shared rate limit.
  const current = open ? sessions.find((x) => x.id === open) ?? null : null;
  // 会话页已显示时不轮询列表和审批（会话页有自己的 feed），返回列表或跳到审批页时立即刷新一次；
  // 刚新建的会话还不在列表里（current 为空）时照常轮询，直到它出现。
  const inSession = current !== null;
  useEffect(() => {
    if (inSession) return;
    void refresh();
    const t = setInterval(() => { if (!document.hidden) void refresh(); }, 3000);
    return () => clearInterval(t);
  }, [refresh, inSession]);

  const days = me.remaining_seconds === null ? null : me.remaining_seconds / 86400;
  // Drafts (a new chat whose first message has not gone out) are not listed.
  const listed = sessions.filter((x) => !x.draft);
  return (
    <div className={s.app}>
      {!current && <header className={s.header}>
        <span className={s.brand} title={me.device}>BlackHole</span>
        <nav className={s.tabs} aria-label="页面">
          {([['sessions', '会话'], ['approvals', '审批' + (pending.length ? ` ${pending.length}` : '')], ['new', '新建']] as [Tab, string][]).map(([k, label]) => (
            <button key={k} type="button" className={tab === k ? s.tabOn : s.tab} aria-current={tab === k ? 'page' : undefined} onClick={() => setTab(k)}>{label}</button>
          ))}
        </nav>
      </header>}
      {days !== null && days <= 0 && <div className={s.bannerBad} role="alert">订阅已到期，AI 工具调用已暂停。请在电脑上续费。</div>}
      {!current && days !== null && days > 0 && days <= 3 && <div className={s.bannerWarn} role="status">订阅将在 {Math.ceil(days)} 天内到期，请在电脑上续费。</div>}
      {current ? (
        <Guard key={current.id} onReset={() => setOpen(null)}><SessionChat session={current} onBack={() => setOpen(null)} onApprovals={() => { setOpen(null); setTab('approvals'); }} lost={lost} /></Guard>
      ) : (
        <>
          <main className={s.body}>
            {tab === 'approvals' && <Approvals list={pending} sessions={sessions} onDone={refresh} lost={lost} />}
            {tab === 'sessions' && pending.length > 0 && (
              <button type="button" className={s.bannerWarn} onClick={() => setTab('approvals')}>{pending.length} 个待审批 · 去处理</button>
            )}
            {tab === 'sessions' && (
              listed.length === 0 ? (
                <div className={s.emptyBox}>
                  <div className={s.emptyTitle}>还没有会话</div>
                  <div className={s.emptyText}>新建一个会话，或在电脑上把提示词发给网页 AI。</div>
                  <button type="button" className={s.btnPrimary} onClick={() => setTab('new')}>新建会话</button>
                </div>
              ) : (
                <ul className={s.group}>
                  {listed.map((x) => {
                    const running = x.status === 'active' && x.activity === 'running';
                    const tone = sessionTone(x.status, x.activity === 'running');
                    const project = x.workspace_path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || x.workspace_path;
                    return (
                      <li key={x.id}>
                        <button type="button" className={s.item} onClick={() => setOpen(x.id)}>
                          <span className={`${s.dot} ${s[tone] ?? ''} ${running ? s.pulse : ''}`} aria-hidden="true" />
                          <span className={s.itemMain}>
                            <span className={s.rowTitle}>{sessionTitle(x)}</span>
                            <span className={s.rowMeta}>
                              <span className={s[tone]}>{running ? '运行中' : SESSION_STATUS_LABEL[x.status] ?? x.status}</span> · {project} · {relativeTime(x.last_active_at)}
                            </span>
                          </span>
                          <span className={s.chev} aria-hidden="true">{'\u203A'}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )
            )}
            {tab === 'new' && <NewChat lost={lost} onOpen={(id) => { void refresh().then(() => { setOpen(id); setTab('sessions'); }); }} />}
          </main>
        </>
      )}
    </div>
  );
}

function Approvals({ list, sessions, onDone, lost }: { list: Confirmation[]; sessions: SessionView[]; onDone: () => Promise<void>; lost: (e: unknown) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const act = async (c: Confirmation, action: 'approve' | 'deny', scope?: 'once' | 'session') => {
    setBusy(c.id);
    setError(null);
    try { await call(`/confirmations/${encodeURIComponent(c.id)}/${action}`, action === 'approve' ? { scope } : {}); }
    catch (e) { lost(e); setError(e instanceof RemoteError && e.code === 'confirmation_closed' ? '这条审批已处理或已过期。' : '操作失败，请重试。'); }
    finally { setBusy(null); await onDone(); }
  };
  if (!list.length) return <p className={s.empty}>没有待审批的操作。</p>;
  return (
    <ul className={s.list}>
      {error && <li className={s.error} role="alert">{error}</li>}
      {list.map((c) => {
        const session = sessions.find((x) => x.id === c.session_id);
        return (
          <li key={c.id} className={s.card}>
            <div className={s.cardHead}><span className={s.tool}>{c.tool}</span><span className={s.rowMeta}>{session ? sessionTitle(session) : c.session_id} · {relativeTime(c.created_at)}</span></div>
            <pre className={s.args}>{argsPreview(c.args, 300)}</pre>
            <div className={s.actions}>
              <button type="button" className={s.btnDanger} disabled={busy === c.id} onClick={() => void act(c, 'deny')}>拒绝</button>
              <button type="button" className={s.btn} disabled={busy === c.id} onClick={() => void act(c, 'approve', 'session')}>本会话允许</button>
              <button type="button" className={s.btnPrimary} disabled={busy === c.id} onClick={() => void act(c, 'approve', 'once')}>允许本次</button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
