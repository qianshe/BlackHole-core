// Phone session page and new-chat page, same rules as VS Code and the Web console:
// a session paired with a web chat gets a composer (sent through the daemon to Courier);
// an unpaired / prompt-direct session only receives (tool calls and replies).
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CallView, SessionView } from '../api';
import { CALL_STATUS_LABEL, callDuration, callHeadline, callTone, formatFull, resultBody, resultDiff, sessionTitle } from '../format';
import { toolCallDisplay } from '../../../vscode/src/callDisplay';
import { displayToolName } from '../../../vscode/src/toolNames';
import { renderMarkdown } from '../../../vscode/src/markdown';
import { Markdown } from '../Markdown';
import { call, RemoteError } from './call';
import { FeedHttpError, useSessionFeed, type FeedState } from '../feed/useSessionFeed';
import { anchorShift, captureAnchor, type ScrollAnchor } from '../feed/scrollAnchor';
import { loadMethod, saveMethod, sendMethods, siteLabel, startPlan, usableMethod, type SendMethod, type SiteChoice } from '../sendMethod';

// The phone never holds the session credential, so it cannot copy a prompt: Courier methods only.
// The phone offers the built-in web agents only (no sites added in Courier: those are fill-only).
const phoneMethods = () => sendMethods([]).filter((m) => m.id !== 'manual');
import s from './remote.module.css';
import { FoldText } from '../FoldText';

interface Question { title: string; options: string[]; skip: boolean; input: boolean; answered?: boolean }
interface Msg { id: string; kind: 'user' | 'agent'; text: string; at: number; status: string; site?: string; model?: string; message?: string; question?: Question; images?: number }
interface Courier { connected: boolean; sites?: SiteChoice[] }
interface Result { ok: boolean; sent?: boolean; message?: string }
interface Project { id: string; label: string; path: string }

/** 手机 feed 首屏条数与往上翻的每页条数（计划 §3：手机 20）。 */
const PHONE_FEED_LIMIT = 20;

const hhmm = (t: number): string => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const failText = (e: unknown): string => (e instanceof RemoteError ? e.detail || e.code : '连不上电脑，请重试');

function Composer({ busy, disabled, placeholder, onSend, generating = false, onStop }: { busy: boolean; disabled: boolean; placeholder: string; onSend: (text: string) => Promise<boolean>; generating?: boolean; onStop?: () => void }) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(160, el.scrollHeight + 2)}px`;
  }, [text]);
  const go = async (): Promise<void> => {
    const t = text.trim();
    if (!t || busy || disabled) return;
    if (await onSend(t)) setText('');
  };
  // Phones have no Shift+Enter: Enter inserts a newline, the button sends.
  return (
    <div className={s.composer}>
      <textarea ref={ref} className={s.composerInput} rows={1} value={text} placeholder={placeholder} aria-label="消息" onChange={(e) => setText(e.target.value)} />
      {/* While the web AI is generating the send button becomes the stop button, in the same slot. */}
      {generating && onStop ? (
        <button type="button" className={s.stop} onClick={onStop} aria-label="停止生成" title="让网页 AI 停止生成">■</button>
      ) : (
        <button type="button" className={s.send} disabled={busy || disabled || !text.trim()} onClick={() => void go()} aria-label="发送">{busy ? '…' : '↑'}</button>
      )}
    </div>
  );
}

export function SessionChat({ session, onBack, onApprovals, lost }: { session: SessionView; onBack: () => void; onApprovals: () => void; lost: (e: unknown) => void }) {
  const id = session.id;
  const [sites, setSites] = useState<SiteChoice[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ cls: string; text: string } | null>(null);
  const [menu, setMenu] = useState(false);

  // 时间线、状态（名称、配对、绑定的网页聊天、busy）都来自会话 feed：服务端按渠道决定等待与间隔，
  // 手机不再自己轮询 /courier。401/403/404 交给上层的 lost()。
  const { snap, loadOlder, kick } = useSessionFeed<CallView, Msg, FeedState>({
    scope: 'remote',
    sessionId: id,
    limit: PHONE_FEED_LIMIT,
    onFatal: (e) => lost(e instanceof FeedHttpError ? new RemoteError(e.status, e.code) : e),
  });
  const loaded = snap.loaded;
  const msgs = snap.messages;
  const st = snap.state;
  // 站点名字（在 Courier 里添加的站点）只在 /courier 里，进入会话页时读一次。
  useEffect(() => { void call<Courier>('/courier?cached=1').then((c) => setSites(Array.isArray(c.sites) ? c.sites : []), () => undefined); }, []);

  const target = st?.target ?? null;
  const link = st?.link ?? (session.draft ? 'new' : 'direct');
  const paired = link === 'paired';
  const generating = !!target?.busy || msgs.some((m) => m.status === 'streaming');
  // 待审批的调用：手机在会话页时不再轮询审批列表，用 feed 里的 awaiting 调用提示，点了跳到审批页
  const awaiting = useMemo(() => snap.calls.filter((c) => c.status === 'awaiting').length, [snap.calls]);
  const title = sessionTitle({ ...session, name: st ? st.name : session.name });

  // The last unanswered question (nothing of yours sent after it) becomes the card above the composer.
  const question = useMemo(() => {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]!;
      if (m.kind === 'user' && m.status === 'sent') return null;
      if (m.kind === 'agent' && m.question) return m.question.answered ? null : m.question;
    }
    return null;
  }, [msgs]);

  type Entry = { k: 'call'; at: number; c: CallView } | { k: 'msg'; at: number; m: Msg };
  // feed 已按时间线键排好序（调用在同一时刻的回复之前），这里不再排。
  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = [];
    for (const e of snap.entries) {
      if (e.call) out.push({ k: 'call', at: e.t, c: e.call });
      // Questions live in the card while the session can answer; receive-only keeps them in the thread.
      else if (e.message && (!paired || !e.message.question)) out.push({ k: 'msg', at: e.t, m: e.message });
    }
    return out;
  }, [snap.entries, paired]);

  // Follow new entries while the page is at the bottom; scrolling to the top loads older ones
  // (/history) and keeps the view where it was.
  const atBottom = useRef(true);
  // 离开底部后显示「回到底部」按钮，滚回底部自动消失
  const [away, setAway] = useState(false);
  // 翻页后保持视图不动：翻页前记下视口里第一个条目和它离吸顶标题的距离（锚点），数据到了把同一个条目挨回原位。
  // 比「记高度补差值」稳：不依赖高度什么时候变、重复执行不叠加、浏览器自己的滚动锚定和晚到的折叠都不会算错。
  const headRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLUListElement>(null);
  const anchor = useRef<ScrollAnchor | null>(null);
  const headBottom = (): number => headRef.current?.getBoundingClientRect().bottom ?? 0;
  const keepAnchor = (): void => {
    const a = anchor.current, root = threadRef.current;
    if (!a || !root) return;
    const shift = anchorShift(root, a, headBottom());
    if (shift) window.scrollBy(0, shift);
  };
  // 在途守卫：惯性滚动会连发 scroll 事件，第一次调用发出请求后组件还没重渲染，snap.loadingOlder 还是旧值；
  // 第二次调用不能再来一次（否则会覆盖锚点或清掉第一次的补偿）。
  const olderBusy = useRef(false);
  const older = (): void => {
    if (olderBusy.current || !snap.hasOlder || snap.loadingOlder) return;
    olderBusy.current = true;
    anchor.current = threadRef.current ? captureAnchor(threadRef.current, headBottom()) : null;
    void loadOlder().finally(() => {
      // 渲染提交之后再最后对一次位置，然后放开
      requestAnimationFrame(() => { keepAnchor(); anchor.current = null; olderBusy.current = false; });
    });
  };
  const olderRef = useRef(older);
  olderRef.current = older;
  useEffect(() => {
    const on = (): void => {
      const near = window.innerHeight + window.scrollY >= document.body.scrollHeight - 80;
      atBottom.current = near;
      setAway((v) => (v === !near ? v : !near));
      if (window.scrollY < 80) olderRef.current();
    };
    window.addEventListener('scroll', on, { passive: true });
    // 浏览器自己的滚动锚定（Android Chrome）会和上面的手动对位叠加成忽有忽无的偏差：本页关掉它
    const root = document.documentElement;
    const prevAnchoring = root.style.overflowAnchor;
    root.style.overflowAnchor = 'none';
    return () => { window.removeEventListener('scroll', on); root.style.overflowAnchor = prevAnchoring; };
  }, []);
  useLayoutEffect(keepAnchor, [entries]);
  const jumpBottom = (): void => {
    atBottom.current = true;
    setAway(false);
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  };
  const last = entries.length ? entries[entries.length - 1]! : null;
  const lastSig = last ? (last.k === 'msg' ? last.m.id + (last.m.text ?? '').length : last.c.id + last.c.status) : '';
  useLayoutEffect(() => { if (atBottom.current) window.scrollTo(0, document.body.scrollHeight); }, [lastSig]);

  /** Asks the bound chat to press its own stop control (the daemon relays it to Courier). */
  const stopGenerating = async (): Promise<void> => {
    if (!target) return;
    setNote(null);
    try {
      const r = await call<Result>('/courier/stop', { targetId: target.targetId, sessionId: id });
      if (!r.ok) setNote({ cls: 'warn', text: r.message || '没有可点的停止按钮' });
    } catch (e) {
      setNote({ cls: 'bad', text: failText(e) });
    } finally {
      kick();
    }
  };

  const send = async (text: string): Promise<boolean> => {
    if (!target) { setNote({ cls: 'warn', text: '配对的网页会话不在浏览器 Courier 里，暂时无法发送' }); return false; }
    if (generating) { setNote({ cls: 'warn', text: '网页 AI 正在生成，完成后才能发送' }); return false; }
    setBusy(true);
    setNote(null);
    try {
      const r = await call<Result>('/courier/send', { targetId: target.targetId, sessionId: id, text });
      if (!r.ok) setNote({ cls: r.sent ? 'warn' : 'bad', text: r.message || '发送失败' });
      return r.ok;
    } catch (e) {
      setNote({ cls: 'bad', text: failText(e) });
      return false;
    } finally {
      setBusy(false);
      kick();
    }
  };

  const rename = async (): Promise<void> => {
    setMenu(false);
    const name = window.prompt('会话名称（留空恢复默认）', session.name ?? '');
    if (name === null) return;
    try { await call(`/sessions/${encodeURIComponent(id)}/rename`, { name }); setNote({ cls: 'ok', text: '已重命名' }); } catch (e) { setNote({ cls: 'bad', text: failText(e) }); }
  };
  /** 处理评价卡: the auto-rate rule applied to the open Arena rating card. */
  const rateCard = async (): Promise<void> => {
    if (!target) return;
    setNote({ cls: 'ok', text: '正在处理评价卡…' });
    try {
      const r = await call<Result>('/courier/card', { targetId: target.targetId, sessionId: id });
      setNote({ cls: r.ok ? 'ok' : 'warn', text: r.message || (r.ok ? '评价卡已处理' : '处理失败') });
    } catch (e) { setNote({ cls: 'bad', text: failText(e) }); } finally { kick(); }
  };
  const reloadPage = async (): Promise<void> => {
    setMenu(false);
    setNote(null);
    try {
      const r = await call<Result>('/courier/reload', { sessionId: id });
      setNote(r.ok ? { cls: 'ok', text: r.message || '已刷新' } : { cls: 'bad', text: r.message || '刷新失败' });
    } catch (e) { setNote({ cls: 'bad', text: failText(e) }); } finally { kick(); }
  };
  const unpair = async (): Promise<void> => {
    setMenu(false);
    if (!window.confirm('解除和网页会话的配对？之后这个会话只接收，可在浏览器 Courier 里重新配对。')) return;
    try {
      const r = await call<Result>('/courier/unpair', { sessionId: id });
      setNote(r.ok ? { cls: 'ok', text: '已解除配对，之后只接收' } : { cls: 'bad', text: r.message || '解除失败' });
      kick();
    } catch (e) { setNote({ cls: 'bad', text: failText(e) }); }
  };

  // Same as the Web console: the web AI's model is composer metadata (newest reply of the bound
  // site), shown next to the status line, never in the thread. 'chatgpt' is only a placeholder.
  let model: string | null = null;
  for (let i = msgs.length - 1; i >= 0 && !model; i--) {
    const m = msgs[i]!;
    if (m.kind === 'agent' && m.model && m.model !== 'chatgpt' && (!target || m.site === target.site)) model = m.model;
  }

  const head = link === 'unpaired' ? '已解除配对 · 只接收；可在浏览器 Courier 里重新配对'
    : link === 'direct' ? '提示词直连 · 只接收，对话在网页 AI 里进行'
    : target ? `${siteLabel(target.site, sites)}${generating ? ' · 正在生成' : ''}` : '配对的网页会话不在浏览器 Courier 里';

  return (
    <div className={s.chatPage}>
      <div ref={headRef} className={s.chatHead}>
        <button type="button" className={s.back} onClick={onBack} aria-label="返回">‹ 返回</button>
        <span className={s.chatTitle}>{title}</span>
        <button type="button" className={s.more} aria-haspopup="menu" aria-expanded={menu} aria-label="更多" onClick={() => setMenu((x) => !x)}>⋯</button>
        {menu && (
          <div className={s.menu} role="menu">
            <button type="button" role="menuitem" onClick={() => void rename()}>重命名</button>
            {/* Same groups as the VS Code / web console menus: 会话 · 网页会话 */}
            {paired && <div className={s.menuSep} role="separator" />}
            {paired && <button type="button" role="menuitem" onClick={() => void reloadPage()}>刷新网页</button>}
            {paired && <button type="button" role="menuitem" onClick={() => void unpair()}>解除配对</button>}
          </div>
        )}
      </div>
      <main className={s.chatBody}>
        {awaiting > 0 && (
          <button type="button" className={s.bannerWarn} onClick={onApprovals}>{awaiting} 个待审批 · 去处理</button>
        )}
        {snap.hasOlder && (
          <button type="button" className={s.older} disabled={snap.loadingOlder} onClick={older}>
            {snap.loadingOlder ? '正在加载…' : snap.olderError ? '加载失败，点此重试' : '加载更早的记录'}
          </button>
        )}
        {!loaded && (
          <div className={s.skeleton} aria-busy="true" aria-label="正在加载">
            <span /><span /><span />
          </div>
        )}
        {loaded && entries.length === 0 && (
          <div className={s.emptyBox}>
            <div className={s.emptyTitle}>还没有动态</div>
            <div className={s.emptyText}>{paired || link === 'new' ? '在下方输入消息，网页 AI 的回复和工具调用会显示在这里。' : '网页 AI 调用 BlackHole 后，回复和工具调用会显示在这里。'}</div>
          </div>
        )}
        <ul ref={threadRef} className={s.thread}>
          {entries.map((e) => e.k === 'msg' ? (
            e.m.kind === 'user' ? (
              <li key={e.m.id} data-feed-key={e.m.id} className={s.msgUser}>
                {e.m.images ? <span className={s.imgNote}>[图片 ×{e.m.images}]</span> : null}
                <FoldText className={s.msgText} text={e.m.text ?? ''} />
                {e.m.status === 'sent' && e.m.message && <span className={s.warn}>{e.m.message}</span>}
                {e.m.status !== 'sent' && <span className={e.m.status === 'unconfirmed' ? s.warn : s.bad}>{e.m.status === 'unconfirmed' ? '未确认是否送达' : `未发送${e.m.message ? '：' + e.m.message : ''}`}</span>}
              </li>
            ) : (
              <li key={e.m.id} data-feed-key={e.m.id} className={s.msgAgent}>
                <div className={s.msgHead}>{siteLabel(e.m.site, sites)} · {hhmm(e.m.at)}</div>
                <Markdown className={s.md} html={renderMarkdown(e.m.text ?? '')} />
              </li>
            )
          ) : (
            <CallLine key={e.c.id} c={e.c} open={expanded === e.c.id} onToggle={() => setExpanded(expanded === e.c.id ? null : e.c.id)} />
          ))}
        </ul>
      </main>
      <footer className={s.dock}>
        {away && <button type="button" className={s.jump} onClick={jumpBottom} aria-label="回到底部" title="回到底部">↓</button>}
        {question && paired && (
          <div className={s.qcard} role="group" aria-label={question.title}>
            <div className={s.qTitle}>{question.title}</div>
            {question.options.map((o, i) => (
              <button key={o} type="button" className={s.qOpt} disabled={busy} onClick={() => void send(o)}><span className={s.qN}>{i + 1}</span>{o}</button>
            ))}
            {question.skip && <button type="button" className={s.qOpt} disabled={busy} onClick={() => void send('跳过')}>跳过</button>}
          </div>
        )}
        {note && <p className={`${s.note} ${s[note.cls] ?? ''}`} role="status">{note.text}</p>}
        <div className={s.dockHead}><span className={`${s.dot} ${paired && target ? (generating ? `${s.run} ${s.pulse}` : s.ok) : s.muted}`} aria-hidden="true" /><span className={s.dockText}>{head}</span>{model && <span className={s.model} title={`网页 AI 模型：${model}`}>{model}</span>}</div>
        {paired && target?.card && (
          <div className={s.dockHead}>评价卡未处理 <button type="button" className={s.cardBtn} onClick={() => void rateCard()}>处理评价卡</button></div>
        )}
        {paired && <Composer busy={busy} disabled={generating || !target} placeholder={generating ? '网页 AI 正在生成…' : '输入消息'} onSend={send} generating={generating} onStop={() => void stopGenerating()} />}
      </footer>
    </div>
  );
}

/** Same state glyphs as the Web console and VS Code: the word is the accessible name. */
const STATUS_GLYPH: Record<string, string> = { ok: '\u2713', run: '\u25CF', warn: '\u25B2', bad: '\u2715', muted: '\u00B7' };

/**
 * One tool call, same wording as the Web console / VS Code (display name, target, diff, duration);
 * a tap shows 参数 and 结果 (the parsed result body, not the raw JSON envelope).
 */
function CallLine({ c, open, onToggle }: { c: CallView; open: boolean; onToggle: () => void }) {
  const shown = toolCallDisplay(c.tool, JSON.stringify(c.args ?? {}));
  const head = callHeadline(displayToolName(c.tool), c.args, shown.summary);
  const summary = typeof c.result_summary === 'string' ? c.result_summary : c.result_summary == null ? null : JSON.stringify(c.result_summary);
  const diff = resultDiff(summary);
  const body = resultBody(summary);
  const tone = callTone(c.status);
  const dur = callDuration(c);
  const label = CALL_STATUS_LABEL[c.status] ?? c.status;
  return (
    <li data-feed-key={c.id} className={s.callLine}>
      <button type="button" className={s.callBtn} aria-expanded={open} onClick={onToggle}>
        <span className={`${s.glyph} ${s[tone] ?? ''}`} role="img" aria-label={label} title={label}>{STATUS_GLYPH[tone] ?? '\u00B7'}</span>
        <span className={s.tool}>{head.label}</span>
        <span className={s.callArgs}>{head.target}</span>
        {diff && diff.added > 0 && <span className={s.ok}>+{diff.added}</span>}
        {diff && diff.removed > 0 && <span className={s.bad}>{'\u2212'}{diff.removed}</span>}
        <span className={s.callWhen}>{dur ?? (c.status === 'started' ? '执行中' : '')}</span>
      </button>
      {open && (
        <div className={s.callBody}>
          <div className={s.blockHead}>参数</div>
          <pre className={s.args}>{shown.details}</pre>
          {body && <div className={s.blockHead}>结果</div>}
          {body && <pre className={s.args}>{body}</pre>}
          <div className={s.callFoot}>{label} · {formatFull(c.created_at)}{dur ? ` · 耗时 ${dur}` : ''}</div>
        </div>
      )}
    </li>
  );
}

/** New session: pick a project, send the first message; the session is listed once it went out. */
export function NewChat({ lost, onOpen }: { lost: (e: unknown) => void; onOpen: (id: string) => void }) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [project, setProject] = useState('');
  const [picked, setMethodState] = useState<SendMethod>(() => (loadMethod() === 'manual' ? 'chatgpt' : loadMethod()));
  // Sites added in Courier (检测此页面) are offered too; a deleted one falls back to ChatGPT.
  const [sites, setSites] = useState<SiteChoice[]>([]);
  // Same as the Web new-session page: watch Courier (online state + sites) while this page is open.
  const [connected, setConnected] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    const load = (): void => void call<Courier>('/courier?cached=1').then((c) => {
      if (!alive) return;
      setConnected(c.connected);
      const next = Array.isArray(c.sites) ? c.sites : [];
      setSites((cur) => (JSON.stringify(cur) === JSON.stringify(next) ? cur : next));
    }, () => alive && setConnected(false));
    load();
    const t = setInterval(load, 5000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  const methods = phoneMethods();
  const method = usableMethod(picked, []); // a saved Courier site falls back to ChatGPT here
  const plan = startPlan(method) ?? startPlan('chatgpt')!;
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ cls: string; text: string } | null>(null);
  useEffect(() => { call<{ projects: Project[] }>('/projects').then((r) => { setProjects(r.projects); setProject((p) => p || r.projects[0]?.id || ''); }, lost); }, [lost]);

  const send = async (text: string): Promise<boolean> => {
    if (!project || connected === false) return false;
    setBusy(true);
    setNote({ cls: 'muted', text: `正在新开 ${siteLabel(plan.site, sites)} 会话并发送…` });
    let draft: string | null = null;
    try {
      const c = await call<{ session: SessionView }>('/sessions', { project_id: project, permission_mode: 'workspace-write', draft: true });
      draft = c.session.id;
      // The daemon wraps the text in the prompt template; the phone never holds the session credential.
      const r = await call<Result>('/courier/start', { sessionId: draft, text, ...plan });
      if (r.ok || r.sent) { onOpen(draft); return true; }
      setNote({ cls: 'bad', text: r.message || '发送失败' });
    } catch (e) {
      setNote({ cls: 'bad', text: failText(e) });
    } finally {
      setBusy(false);
    }
    if (draft) void call(`/sessions/${encodeURIComponent(draft)}/discard`, {}).catch(() => undefined);
    return false;
  };

  if (projects === null) return <p className={s.empty}>正在读取项目…</p>;
  if (!projects.length) return <p className={s.empty}>还没有项目。请先在电脑上添加项目。</p>;
  return (
    <div className={s.newPage}>
      <div className={s.newTitle}>新会话</div>
      <div className={s.group}>
      <label className={s.field}>
        <span className={s.fieldLabel}>项目</span>
      <select id="rm-project" className={s.fieldSelect} value={project} disabled={busy} onChange={(e) => setProject(e.target.value)}>
        {projects.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
      </select>
      </label>
      <label className={s.field}>
        <span className={s.fieldLabel}>发送到</span>
      <select id="rm-method" className={s.fieldSelect} value={method} disabled={busy} onChange={(e) => { const m = e.target.value as SendMethod; setMethodState(m); saveMethod(m); }}>
        {methods.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
      </select>
      </label>
      </div>
      {note && <p className={`${s.note} ${s[note.cls] ?? ''}`} role="status">{note.text}</p>}
      <div className={s.newComposer}><Composer busy={busy} disabled={!project || connected === false} placeholder="输入第一条消息，发出后会话才会出现在列表里" onSend={send} /></div>
      <div className={connected === false ? `${s.rowMeta} ${s.warn}` : s.rowMeta}>{connected === false ? '电脑浏览器里的 Courier 未连接，打开浏览器后会自动连上' : methods.find((m) => m.id === method)?.hint}</div>
    </div>
  );
}
