// Chat for the selected session: the thread itself lives in the session timeline (SessionPane);
// this is the composer that types into the paired web chat through the Courier browser extension. A new
// session's first message opens a ChatGPT chat and carries the connector prompt; cut or prompt-direct
// sessions only receive (no input).
// Self-contained: talks to /web-api/v1/courier directly and gets the CSRF token from /auth/session.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent as PasteEvent } from 'react';
import { createPortal } from 'react-dom';
import type { SessionView } from '../api';
import { renderMarkdown } from '../../../vscode/src/markdown';
import s from './ChatDock.module.css';
import { FoldText } from '../FoldText';
import { copyText } from '../codeCopy';
import { Icon } from '../ui';
import { loadMethod, startPlan, usableMethod, type SiteChoice } from '../sendMethod';

/** Sites added in Courier, from the last courier status (a deleted one is no longer offered). */
let knownSites: SiteChoice[] = [];
/** A draft opened outside the new-session page: the last picked Courier method (manual has no site). */
const draftPlan = () => startPlan(usableMethod(loadMethod(), knownSites)) ?? startPlan('chatgpt')!;
const siteName = (site: string): string => SITE[site] ?? site;

interface Target {
  targetId: string;
  site: string;
  label: string;
  conversationKey: string | null;
  open: boolean;
  ready: boolean | null;
  busy: boolean | null;
  draft: boolean | null;
  /** Title of an open Arena rating card, null when none. */
  card?: string | null;
  sessionId: string | null;
}
/** The question card the web agent forwards: a title plus 1-12 options. */
export interface Question {
  title: string;
  options: string[];
  skip: boolean;
  input: boolean;
  /** Answered already (e.g. on the web page): no card. */
  answered?: boolean;
  answer?: string;
}
export interface Message {
  id: string;
  sessionId?: string;
  kind: 'user' | 'agent';
  text: string;
  at: number;
  status: 'sent' | 'unconfirmed' | 'failed' | 'reply' | 'streaming';
  site: string | null;
  message?: string;
  model?: string;
  /** Images sent with this message (count only). */
  images?: number;
  question?: Question;
}
interface Result { ok: boolean; code?: string; message: string; sent: boolean }

const BASE = '/web-api/v1';
/** Site id → name; the sites added in Courier are filled in from the courier status. */
const SITE: Record<string, string> = { arena: 'Arena', chatgpt: 'ChatGPT' };
const HEAD = { 'x-blackhole-web': '1' };
const POLL_MS = 3000;

/** Fired after a send so the session timeline refreshes at once. */
export const CHAT_CHANGED = 'bh-chat-changed';
/** Drafts that already went to a web chat: leaving their page must not discard them. */
export const draftsInUse = new Set<string>();
/** Last known pairing state per session (new / paired / unpaired / direct), fed by ChatDock. */
export const pairLinks = new Map<string, string>();
/** Fired with { sessionId } when pairLinks changes (the session menu shows 解除配对 only when paired). */
export const PAIR_LINK = 'bh-pair-link';
/** Fired with { sessionId } after the pairing was cut from the menu. */
export const PAIR_CUT = 'bh-pair-cut';

/** Cut a session's pairing: it stays and only receives; Courier drops the binding. */
export async function unpairSession(sessionId: string): Promise<{ ok: boolean; message: string }> {
  let r: { ok: boolean; message: string };
  try { r = await postJson('/courier/unpair', { sessionId }); } catch { r = { ok: false, message: '连不上 BlackHole' }; }
  window.dispatchEvent(new CustomEvent(PAIR_CUT, { detail: { sessionId } }));
  return r;
}

/** Force-reload the paired web chat page (a closed one is reopened); the task goes on. */
export async function reloadChat(sessionId: string): Promise<{ ok: boolean; message: string }> {
  try { return await postJson('/courier/reload', { sessionId }); } catch { return { ok: false, message: '连不上 BlackHole' }; }
}

/** The pairing state of one session as the composer last saw it. */
export function usePairLink(sessionId: string): string | undefined {
  const [link, setLink] = useState(() => pairLinks.get(sessionId));
  useEffect(() => {
    setLink(pairLinks.get(sessionId));
    const on = (e: Event): void => { if ((e as CustomEvent<{ sessionId: string }>).detail?.sessionId === sessionId) setLink(pairLinks.get(sessionId)); };
    window.addEventListener(PAIR_LINK, on);
    return () => window.removeEventListener(PAIR_LINK, on);
  }, [sessionId]);
  return link;
}
/** Fired by the session timeline: { sessionId, streaming } while a reply streams in. */
export const CHAT_STREAMING = 'bh-chat-streaming';

export async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(BASE + path, { credentials: 'same-origin', cache: 'no-store', headers: HEAD });
  if (!r.ok) throw new Error(`http_${r.status}`);
  return (await r.json()) as T;
}

/**
 * Live thread updates of one session (server-sent events over fetch, so the client header is
 * sent): every added or updated message, including reply text while it streams.
 */
export async function streamThread(sessionId: string, onMessage: (m: Message) => void, signal: AbortSignal): Promise<void> {
  const r = await fetch(`${BASE}/courier/stream?sessionId=${encodeURIComponent(sessionId)}`, { credentials: 'same-origin', cache: 'no-store', headers: { ...HEAD, accept: 'text/event-stream' }, signal });
  if (!r.ok || !r.body) throw new Error(`http_${r.status}`);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buf += dec.decode(value, { stream: true });
    for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
      const data = buf.slice(0, i).split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      buf = buf.slice(i + 2);
      if (!data) continue;
      try { onMessage(JSON.parse(data) as Message); } catch { /* malformed event: skip */ }
    }
  }
}

export async function postJson(path: string, body: unknown): Promise<Result> {
  const { csrf } = await getJson<{ csrf?: string }>('/auth/session');
  const r = await fetch(BASE + path, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { ...HEAD, 'content-type': 'application/json', ...(csrf ? { 'x-blackhole-csrf': csrf } : {}) },
    body: JSON.stringify(body),
  });
  const b = (await r.json().catch(() => ({}))) as Partial<Result> & { error?: string };
  if (!r.ok) return { ok: false, code: b.error, message: b.message || b.error || `发送失败（${r.status}）`, sent: false };
  return { ok: b.ok === true, code: b.code, message: b.message || (b.ok ? '已发送' : '发送失败'), sent: b.sent === true };
}

/** Pasted images: uploaded right before the send, then named by id in /courier/send. */
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
interface Pasted { key: string; file: File; url: string }
async function uploadImage(file: File): Promise<string> {
  const { csrf } = await getJson<{ csrf?: string }>('/auth/session');
  const r = await fetch(BASE + '/courier/attachments', {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { ...HEAD, 'content-type': file.type, ...(csrf ? { 'x-blackhole-csrf': csrf } : {}) },
    body: file,
  });
  const b = (await r.json().catch(() => ({}))) as { id?: string; message?: string };
  if (!r.ok || !b.id) throw new Error(b.message || `图片上传失败（${r.status}）`);
  return b.id;
}

function state(t: Target): [string, string] {
  if (!t.open) return ['muted', '未打开，发送时自动打开'];
  if (t.ready === false) return ['bad', '页面没有响应'];
  if (t.busy) return ['warn', '正在生成'];
  if (t.draft) return ['warn', '有草稿'];
  return ['ok', '可发送'];
}

const hhmm = (t: number): string => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
/** Where the message goes: Arena, ChatGPT, or whatever site the extension binds. */
const sourceOf = (t: Target): string => SITE[t.site] ?? t.site;
const targetName = (t: Target): string => `${sourceOf(t)} · ${t.label || t.conversationKey || '新会话'}`;

/**
 * One chat message in the session timeline: yours as a light block on the right, the agent's
 * reply full width as Markdown (escaped by renderMarkdown; links http(s)/mailto only).
 */
/** Images sent with a message, served by the local daemon; after a restart they are gone: a count. */
function SentImages({ id, count }: { id: string; count: number }) {
  const [gone, setGone] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => {
    if (open === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(null);
      else if (e.key === 'ArrowRight') setOpen((n) => (n === null ? n : (n + 1) % count));
      else if (e.key === 'ArrowLeft') setOpen((n) => (n === null ? n : (n + count - 1) % count));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, count]);
  if (gone) return <span className={s.st}>附 {count} 张图片</span>;
  const src = (i: number) => `${BASE}/courier/images/${encodeURIComponent(id)}/${i}`;
  return (
    <div className={s.sentImgs}>
      {Array.from({ length: count }, (_, i) => (
        <button key={i} type="button" className={s.sentImgBtn} onClick={() => setOpen(i)} aria-label={`查看图片 ${i + 1}`}>
          <img src={src(i)} alt={`图片 ${i + 1}`} loading="lazy" onError={() => setGone(true)} />
        </button>
      ))}
      {open !== null && createPortal(
        <div className={s.imgView} role="dialog" aria-modal="true" onClick={() => setOpen(null)}>
          <img src={src(open)} alt={`图片 ${open + 1}`} onClick={(e) => e.stopPropagation()} />
          {count > 1 && <span className={s.imgViewNo}>{open + 1} / {count}　← → 切换，Esc 关闭</span>}
        </div>,
        document.body,
      )}
    </div>
  );
}

/** Icon-only copy of a whole message (your text, or the agent's final reply as Markdown source). */
function MsgCopy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => { if (!done) return; const t = setTimeout(() => setDone(false), 1500); return () => clearTimeout(t); }, [done]);
  const label = done ? '已复制' : '复制';
  return (
    <button type="button" className={`${s.msgCopy} ${done ? s.copied : ''}`} aria-label={label} title={label}
      onClick={() => void copyText(text).then((ok) => { if (ok) setDone(true); })}>
      <Icon name={done ? 'check' : 'copy'} size={13} />
    </button>
  );
}

/** `copy`: this agent message is the final reply of its turn (only those get a copy button). */
export function Bubble({ m, copy = false }: { m: Message; copy?: boolean }) {
  const html = useMemo(() => (m.kind === 'agent' ? renderMarkdown(m.text) : ''), [m.kind, m.text]);
  const site = SITE[m.site ?? ''] ?? '网页会话';
  if (m.kind === 'agent') {
    return (
      <li className={`${s.msg} ${s.agent} ${m.status === 'streaming' ? s.streaming : ''}`}>
        <div className={s.msgHead}>
          <span className={s.who}>{site}</span>
          <span className={s.when}>{hhmm(m.at)}</span>
        </div>
        <div className={s.md} dangerouslySetInnerHTML={{ __html: html }} />
        {copy && m.status !== 'streaming' && <div className={s.msgActs}><MsgCopy text={m.text} /></div>}
      </li>
    );
  }
  // A sent message with a note: the prompt was only filled into a user-added site (the user sends it).
  const st = m.status === 'sent' ? (m.message ? ['warn', m.message] : null) : m.status === 'unconfirmed' ? ['warn', '未确认是否送达'] : ['bad', `未发送${m.message ? `：${m.message}` : ''}`];
  return (
    <li className={`${s.msg} ${s.user}`} title={hhmm(m.at)}>
      {m.images ? <SentImages id={m.id} count={m.images} /> : null}
      <FoldText className={s.body} text={m.text} />
      {st && <span className={`${s.st} ${s[st[0]!]}`}>{st[1]}</span>}
      <div className={`${s.msgActs} ${s.userActs}`}><MsgCopy text={m.text} /></div>
    </li>
  );
}

/**
 * `models` maps a site (arena/chatgpt) to the model of its newest reply: the model
 * is composer metadata, so it is shown on the composer and never in the thread.
 */
export function ChatDock({ session, connectorName, mcpUrl, models, question }: { session: SessionView; connectorName: string; mcpUrl: string | null; models: Record<string, string>; question: (Question & { id: string }) | null }) {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [targets, setTargets] = useState<Target[]>([]);
  const [pick, setPick] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ cls: string; text: string } | null>(null);
  // Send state rides the head pill (可发送 → 发送中 → 已发送): nothing about a send
  // belongs on a line under the input.
  const [flash, setFlash] = useState<{ cls: string; text: string } | null>(null);
  const alive = useRef(true);
  const busyRef = useRef(false);
  const [streaming, setStreaming] = useState(false);
  const [stopping, setStopping] = useState(false);
  useEffect(() => {
    const on = (e: Event) => { const d = (e as CustomEvent<{ sessionId: string; streaming: boolean }>).detail; if (d?.sessionId === session.id) setStreaming(d.streaming); };
    window.addEventListener(CHAT_STREAMING, on);
    return () => window.removeEventListener(CHAT_STREAMING, on);
  }, [session.id]);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 1800);
    return () => clearTimeout(t);
  }, [flash]);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // new: composer opens a ChatGPT chat; paired: sends to it; unpaired / direct: receive only.
  const [link, setLink] = useState<string>(session.draft ? 'new' : 'direct');
  const load = useCallback(async (fresh = false) => {
    const st = await getJson<{ connected: boolean; targets: Target[]; links?: Record<string, string>; sites?: SiteChoice[] }>(fresh ? '/courier' : '/courier?cached=1').catch(() => null);
    if (!alive.current) return;
    if (Array.isArray(st?.sites)) { knownSites = st.sites; for (const x of st.sites) SITE[x.id] = x.name; }
    const mine = st?.connected ? st.targets.filter((t) => t.sessionId === session.id) : [];
    setConnected(st ? st.connected : false);
    setTargets(mine);
    if (st) {
      const l = st.links?.[session.id] ?? (session.draft ? 'new' : mine.length ? 'paired' : 'direct');
      setLink(l);
      if (pairLinks.get(session.id) !== l) { pairLinks.set(session.id, l); window.dispatchEvent(new CustomEvent(PAIR_LINK, { detail: { sessionId: session.id } })); }
    }
  }, [session.id, session.draft]);

  useEffect(() => {
    alive.current = true;
    void load(true);
    // Safety net: while the composer shows "generating", every 3rd poll asks Courier for a fresh
    // list instead of the pushed one, so a busy flip Courier failed to push cannot stick.
    let n = 0;
    const t = setInterval(() => { if (!document.hidden) void load(busyRef.current && ++n % 3 === 0); }, POLL_MS);
    return () => { alive.current = false; clearInterval(t); };
  }, [load]);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(200, el.scrollHeight + 2)}px`;
  }, [text]);

  const target = targets.find((t) => t.targetId === pick) ?? targets[0] ?? null;
  // The web AI is still answering: no new message until it is done.
  const generating = streaming || !!target?.busy;
  busyRef.current = !!target?.busy;

  /** Asks the bound chat to press its own stop control (the daemon relays it to Courier). */
  const stopGenerating = async (): Promise<void> => {
    if (!target || stopping) return;
    setStopping(true);
    setFlash(null);
    try {
      const r = await postJson('/courier/stop', { targetId: target.targetId, sessionId: session.id });
      if (r.ok) setFlash({ cls: 'warn', text: '已停止' });
      else setNote({ cls: 'warn', text: r.message });
    } catch {
      setNote({ cls: 'bad', text: '连不上 BlackHole' });
    } finally {
      setStopping(false);
      void load(true);
    }
  };

  /** Sends the composer text, or `input` when a question option was clicked. */
  const [images, setImages] = useState<Pasted[]>([]);
  const dropImages = (): void => setImages((list) => { for (const x of list) URL.revokeObjectURL(x.url); return []; });
  const onPaste = (e: PasteEvent<HTMLTextAreaElement>): void => {
    const files = [...(e.clipboardData?.files ?? [])].filter((f) => IMAGE_TYPES.includes(f.type));
    if (!files.length) return;
    e.preventDefault();
    if (!target) { setNote({ cls: 'warn', text: '新会话的第一条消息暂不支持图片，配对后再发' }); return; }
    const big = files.find((f) => f.size > MAX_IMAGE_BYTES);
    if (big) { setNote({ cls: 'warn', text: '图片不能超过 10 MB' }); return; }
    setImages((list) => {
      const room = MAX_IMAGES - list.length;
      if (files.length > room) setNote({ cls: 'warn', text: `最多 ${MAX_IMAGES} 张图片` });
      return [...list, ...files.slice(0, Math.max(0, room)).map((file) => ({ key: Math.random().toString(36).slice(2), file, url: URL.createObjectURL(file) }))];
    });
  };
  const send = async (input?: string): Promise<void> => {
    const body = (input ?? text).trim();
    if (!body && input === undefined && images.length) { setNote({ cls: 'warn', text: '请再写一句话和图片一起发送' }); return; }
    if (!body || busy || !connected) return;
    if (input === undefined && generating) { setNote({ cls: 'warn', text: '网页 AI 正在生成，完成后才能发送' }); return; }
    if (!target && link !== 'new') { setNote({ cls: 'warn', text: '配对的网页会话不在 Courier 里，无法发送' }); return; }
    setBusy(true);
    setFlash(null);
    // 发送中 lives in the pill; only opening a fresh chat still needs words.
    if (!target) setNote({ cls: 'muted', text: `正在新开 ${siteName(draftPlan().site)} 会话并发送…` });
    try {
      let r: Result;
      // Images go only with the typed message (never with an option click from a question card).
      const withImages = input === undefined && images.length > 0;
      if (target) {
        const ids = withImages ? await Promise.all(images.map((x) => uploadImage(x.file))) : [];
        r = await postJson('/courier/send', { targetId: target.targetId, sessionId: session.id, text: body, ...(ids.length ? { images: ids } : {}) });
        if (r.ok && withImages) dropImages();
      }
      else {
        // The daemon wraps the typed text in the prompt template; the thread shows only the typed text.
        r = await postJson('/courier/start', { sessionId: session.id, text: body, ...draftPlan() });
        if (r.ok || r.sent) draftsInUse.add(session.id);
      }
      // An option click must not eat a draft that was not sent.
      if (r.ok) { if (input === undefined) setText(''); setNote(null); setFlash({ cls: 'ok', text: '已发送' }); }
      else setNote({ cls: r.sent ? 'warn' : 'bad', text: r.message });
    } catch (e) {
      setNote({ cls: 'bad', text: e instanceof Error && e.message.startsWith('图片') ? e.message : '连不上 BlackHole' });
    } finally {
      setBusy(false);
      void load(true);
      window.dispatchEvent(new Event(CHAT_CHANGED));
    }
  };

  // 解除配对 lives in the session menu (away from the send button): reload when it happens.
  useEffect(() => {
    const on = (e: Event): void => { if ((e as CustomEvent<{ sessionId: string }>).detail?.sessionId === session.id) void load(true); };
    window.addEventListener(PAIR_CUT, on);
    return () => window.removeEventListener(PAIR_CUT, on);
  }, [session.id, load]);
  const receiveOnly = link === 'unpaired' || link === 'direct';
  /** 处理评价卡: the auto-rate rule applied to the open Arena rating card. */
  const rateCard = async (): Promise<void> => {
    if (!target) return;
    setNote({ cls: 'ok', text: '正在处理评价卡…' });
    try {
      const r = await postJson('/courier/card', { targetId: target.targetId, sessionId: session.id });
      setNote({ cls: r.ok ? 'ok' : 'warn', text: r.message || (r.ok ? '评价卡已处理' : '处理失败') });
    } catch { setNote({ cls: 'bad', text: '连不上 BlackHole' }); }
  };

  const [cls, label] = target ? state(target) : ['muted', ''];
  // 发送中 is a send state, not a channel state: it outranks 可发送 while a send is in flight.
  const pill: [string, string] | null = busy ? ['warn', '发送中'] : flash ? [flash.cls, flash.text] : label ? [cls, label] : null;
  const model = (target && models[target.site]) || null;
  // Same site twice: two Arena chats can only be told apart by their titles.
  const uniqueSources = new Set(targets.map((t) => t.site)).size === targets.length;
  const head = link === 'unpaired' ? '已解除配对 · 只接收；可在浏览器 Courier 里重新配对'
    : link === 'direct' ? '提示词直连 · 只接收，对话在网页 AI 里进行'
    : connected === false ? '浏览器里的 Courier 未连接，打开浏览器后会自动连上'
    : !target && link === 'new' ? '第一条消息会新开 ChatGPT 会话并配对，附上连接器提示词'
    : !target ? '配对的网页会话不在 Courier 里' : null;

  return (
    <section className={s.dock} aria-label="网页会话">
      {/* 输入条之外的东西都排在分隔线之上：提问 → 提示 → 来源/模型/发送状态 */}
      <div className={s.extras}>
        {question && !receiveOnly && (
          <div className={s.qcard} role="group" aria-label={question.title}>
            <div className={s.qHead}>
              <span className={s.qTitle}>{question.title}</span>
              {question.skip && (
                <button type="button" className={s.qSkip} disabled={busy} onClick={() => void send('跳过')}>跳过</button>
              )}
            </div>
            {question.options.map((o, i) => (
              <button key={`${i}-${o}`} type="button" className={s.qOpt} disabled={busy} onClick={() => void send(o)}>
                <span className={s.qN} aria-hidden="true">{i + 1}</span>
                <span className={s.qLabel}>{o}</span>
              </button>
            ))}
            <p className={s.qHint}>{question.input ? '点选项回答，也可以在下面输入框里写回答' : '点选项回答，或在下面输入框里写回答'}</p>
          </div>
        )}
        {note && <p className={`${s.note} ${s[note.cls]}`} role="status">{note.text}</p>}
        {target?.card && link === 'paired' && (
          <div className={s.head}>
            <span className={s.hint} title={target.card}>评价卡未处理</span>
            <button type="button" className={s.qSkip} onClick={() => void rateCard()} title="按自动评价规则：模型在保留列表选「是」，不在选「否」，没读到模型就关闭">处理评价卡</button>
          </div>
        )}
        <div className={s.head}>
          {head ? <span className={s.hint}>{head}</span> : targets.length > 1 ? (
            <select className={s.select} value={target!.targetId} onChange={(e) => setPick(e.target.value)} aria-label="选择网页会话">
              {targets.map((t) => <option key={t.targetId} value={t.targetId}>{uniqueSources ? sourceOf(t) : targetName(t)}</option>)}
            </select>
          ) : (
            /* 会话标题在每条回复里重复，这里只留来源 */
            <span className={s.name} title={targetName(target!)}>{sourceOf(target!)}</span>
          )}
          {model && <span className={s.model} title={`网页 AI 模型：${model}`}>{model}</span>}
          {pill && !receiveOnly && <span className={`${s.pill} ${s[pill[0]]}`}><i className={s.dot} />{pill[1]}</span>}
        </div>
      </div>
      {!receiveOnly && <div className={s.box}>
        <div className={s.composer}>
        {images.length > 0 && (
          <ul className={s.thumbs} aria-label="待发送的图片">
            {images.map((x) => (
              <li key={x.key} className={s.thumb}>
                <img src={x.url} alt={x.file.name || '图片'} />
                <button type="button" aria-label="移除图片" title="移除" disabled={busy}
                  onClick={() => setImages((list) => list.filter((y) => { if (y.key === x.key) URL.revokeObjectURL(y.url); return y.key !== x.key; }))}>×</button>
              </li>
            ))}
          </ul>
        )}
        <div className={s.field}>
          <textarea
            ref={inputRef}
            className={s.input}
            rows={2}
            value={text}
            disabled={connected === false}
            placeholder="输入消息，可粘贴图片；Enter 发送，Shift+Enter 换行"
            aria-label="发送到网页会话"
            onChange={(e) => setText(e.target.value)}
            onPaste={onPaste}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); void send(); }
            }}
          />
          {/* While the web AI is generating the send button becomes the stop button, in the same
              slot: nothing moves, and one target means no misclicks. */}
          {generating && target ? (
            <button type="button" className={s.stop} disabled={stopping || busy} onClick={() => void stopGenerating()} aria-label="停止生成" title="让网页 AI 停止生成（点它页面上的停止按钮）">{stopping ? '…' : '■'}</button>
          ) : (
            <button type="button" className={s.send} disabled={busy || generating || !text.trim() || !connected} onClick={() => void send()} aria-label={generating ? '生成中，暂不能发送' : '发送'} title={generating ? '网页 AI 正在生成，完成后才能发送' : '发送（Enter）'}>{busy ? '…' : '↑'}</button>
          )}
          </div>
        </div>
      </div>}
    </section>
  );
}
