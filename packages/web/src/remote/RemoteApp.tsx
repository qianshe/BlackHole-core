// Phone page on the public address (plan 6.13 R5): pair from the QR code, then
// approvals, sessions and new sessions. Talks only to /remote-api/v1.
import { useCallback, useEffect, useState } from 'react';
import type { CallView, PermissionMode, SessionView } from '../api';
import { argsPreview, CALL_STATUS_LABEL, callTone, PERMISSION_LABEL, relativeTime, sessionTitle, SESSION_STATUS_LABEL, sessionTone } from '../format';
import s from './remote.module.css';

class RemoteError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch('/remote-api/v1' + path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'x-blackhole-web': '1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new RemoteError(res.status, data.error ?? `http_${res.status}`);
  return data as T;
}

interface Me { device: string; version: string; remaining_seconds: number | null }
interface Confirmation { id: string; session_id: string; tool: string; args: unknown; status: string; created_at: string; expires_at: string }
interface Project { id: string; label: string; path: string; sessions: number }
interface Created { session: SessionView; session_id: string; mcp_url: string }

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
  return <Ready me={phase.me} lost={lost} />;
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
  const [tab, setTab] = useState<Tab>('approvals');
  const [sessions, setSessions] = useState<SessionView[]>([]);
  const [pending, setPending] = useState<Confirmation[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      const [a, b] = await Promise.all([call<{ sessions: SessionView[] }>('/sessions'), call<{ confirmations: Confirmation[] }>('/confirmations')]);
      setSessions(a.sessions);
      setPending(b.confirmations.filter((c) => c.status === 'pending'));
    } catch (e) { lost(e); }
  }, [lost]);
  useEffect(() => { void refresh(); const t = setInterval(() => void refresh(), 3000); return () => clearInterval(t); }, [refresh]);

  const days = me.remaining_seconds === null ? null : me.remaining_seconds / 86400;
  const current = open ? sessions.find((x) => x.id === open) ?? null : null;
  return (
    <div className={s.app}>
      <header className={s.header}>
        <span className={s.brand}>BlackHole</span>
        <span className={s.device}>{me.device}</span>
      </header>
      {days !== null && days <= 0 && <div className={s.bannerBad} role="alert">订阅已到期，AI 工具调用已暂停。请在电脑上续费。</div>}
      {days !== null && days > 0 && days <= 3 && <div className={s.bannerWarn} role="status">订阅将在 {Math.ceil(days)} 天内到期，请在电脑上续费。</div>}
      {current ? (
        <SessionDetail session={current} onBack={() => setOpen(null)} lost={lost} />
      ) : (
        <>
          <nav className={s.tabs} aria-label="页面">
            {([['approvals', '待审批' + (pending.length ? ` ${pending.length}` : '')], ['sessions', '会话'], ['new', '新建']] as [Tab, string][]).map(([k, label]) => (
              <button key={k} type="button" className={tab === k ? s.tabOn : s.tab} aria-current={tab === k ? 'page' : undefined} onClick={() => setTab(k)}>{label}</button>
            ))}
          </nav>
          <main className={s.body}>
            {tab === 'approvals' && <Approvals list={pending} sessions={sessions} onDone={refresh} lost={lost} />}
            {tab === 'sessions' && (
              <ul className={s.list}>
                {sessions.length === 0 && <li className={s.empty}>还没有会话。</li>}
                {sessions.map((x) => {
                  const tone = sessionTone(x.status, x.activity === 'running');
                  return (
                    <li key={x.id}>
                      <button type="button" className={s.row} onClick={() => setOpen(x.id)}>
                        <span className={s.rowTitle}>{sessionTitle(x)}</span>
                        <span className={s.rowMeta}>
                          <span className={s[tone]}>● {SESSION_STATUS_LABEL[x.status] ?? x.status}</span> · {x.calls_total} 次调用 · {relativeTime(x.last_active_at)}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {tab === 'new' && <NewSession lost={lost} onCreated={refresh} />}
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
            <div className={s.cardHead}><span className={s.tool}>{c.tool}</span><span className={s.rowMeta}>{session ? sessionTitle(session) : c.session_id}</span></div>
            <pre className={s.args}>{argsPreview(c.args, 600)}</pre>
            <div className={s.rowMeta}>{relativeTime(c.created_at)} 发起</div>
            <div className={s.actions}>
              <button type="button" className={s.btnDanger} disabled={busy === c.id} onClick={() => void act(c, 'deny')}>拒绝</button>
              <button type="button" className={s.btn} disabled={busy === c.id} onClick={() => void act(c, 'approve', 'session')}>本会话内允许</button>
              <button type="button" className={s.btnPrimary} disabled={busy === c.id} onClick={() => void act(c, 'approve', 'once')}>允许本次</button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function SessionDetail({ session, onBack, lost }: { session: SessionView; onBack: () => void; lost: (e: unknown) => void }) {
  const [calls, setCalls] = useState<CallView[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  useEffect(() => {
    let stop = false;
    const load = () => call<{ calls: CallView[] }>(`/sessions/${encodeURIComponent(session.id)}/calls?limit=50`).then((r) => { if (!stop) setCalls(r.calls); }, lost);
    void load();
    const t = setInterval(() => void load(), 3000);
    return () => { stop = true; clearInterval(t); };
  }, [session.id, lost]);
  return (
    <main className={s.body}>
      <button type="button" className={s.back} onClick={onBack}>‹ 返回</button>
      <h2 className={s.title}>{sessionTitle(session)}</h2>
      <div className={s.rowMeta}>{session.workspace_path} · {PERMISSION_LABEL[session.permission_mode] ?? session.permission_mode}</div>
      <ul className={s.list}>
        {calls.length === 0 && <li className={s.empty}>还没有工具调用。</li>}
        {calls.map((c) => (
          <li key={c.id} className={s.callItem}>
            <button type="button" className={s.row} aria-expanded={expanded === c.id} onClick={() => setExpanded(expanded === c.id ? null : c.id)}>
              <span className={s.rowTitle}><span className={s.tool}>{c.tool}</span> <span className={s[callTone(c.status)]}>● {CALL_STATUS_LABEL[c.status] ?? c.status}</span></span>
              <span className={s.rowMeta}>{argsPreview(c.args, 90)} · {relativeTime(c.created_at)}</span>
            </button>
            {expanded === c.id && (
              <div className={s.callBody}>
                <pre className={s.args}>{argsPreview(c.args, 4000)}</pre>
                {c.result_summary && <pre className={s.args}>{c.result_summary}</pre>}
              </div>
            )}
          </li>
        ))}
      </ul>
    </main>
  );
}

const MODES: [PermissionMode, string][] = [
  ['workspace-write', '只能改这个文件夹里的文件'],
  ['read-only', '只能查看，不能修改'],
  ['danger-full-access', '可以改电脑上的任何文件'],
];

function NewSession({ lost, onCreated }: { lost: (e: unknown) => void; onCreated: () => Promise<void> }) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [project, setProject] = useState('');
  const [mode, setMode] = useState<PermissionMode>('workspace-write');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => { call<{ projects: Project[] }>('/projects').then((r) => { setProjects(r.projects); setProject((p) => p || r.projects[0]?.id || ''); }, lost); }, [lost]);
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      setCreated(await call<Created>('/sessions', { project_id: project, permission_mode: mode, ...(name.trim() ? { name: name.trim() } : {}) }));
      await onCreated();
    } catch (e) { lost(e); setError('创建失败，请重试。'); } finally { setBusy(false); }
  };
  const copy = async (text: string, what: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(what); } catch { setCopied(null); }
  };
  if (created) {
    return (
      <div className={s.card}>
        <h2 className={s.title}>会话已创建</h2>
        <p className={s.rowMeta}>把会话 ID 和连接地址交给 AI 使用。会话 ID 只显示这一次。</p>
        <div className={s.secret}>{created.session_id}</div>
        <div className={s.actions}>
          <button type="button" className={s.btnPrimary} onClick={() => void copy(created.session_id, 'id')}>{copied === 'id' ? '已复制' : '复制会话 ID'}</button>
          <button type="button" className={s.btn} onClick={() => void copy(created.mcp_url, 'url')}>{copied === 'url' ? '已复制' : '复制连接地址'}</button>
        </div>
        <button type="button" className={s.back} onClick={() => { setCreated(null); setName(''); setCopied(null); }}>再建一个</button>
      </div>
    );
  }
  if (projects === null) return <p className={s.empty}>正在读取项目…</p>;
  if (!projects.length) return <p className={s.empty}>还没有项目。请先在电脑上添加项目。</p>;
  return (
    <form className={s.card} onSubmit={(e) => { e.preventDefault(); void create(); }}>
      <label className={s.label} htmlFor="rm-project">项目</label>
      <select id="rm-project" className={s.input} value={project} onChange={(e) => setProject(e.target.value)}>
        {projects.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
      </select>
      <div className={s.rowMeta}>{projects.find((p) => p.id === project)?.path}</div>
      <fieldset className={s.fieldset}>
        <legend className={s.label}>AI 可以做什么</legend>
        {MODES.map(([m, label]) => (
          <label key={m} className={s.radio}><input type="radio" name="rm-mode" checked={mode === m} onChange={() => setMode(m)} /> {label}</label>
        ))}
      </fieldset>
      <label className={s.label} htmlFor="rm-name">名称（可选）</label>
      <input id="rm-name" className={s.input} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
      {error && <p className={s.error} role="alert">{error}</p>}
      <div className={s.actions}><button type="submit" className={s.btnPrimary} disabled={busy || !project}>{busy ? '创建中…' : '创建会话'}</button></div>
    </form>
  );
}
