// New session page: no session is selected, so the page is just a composer (like the web agent
// platforms). Nothing is added to the session list until the session really starts: the draft is
// reserved on the first send (or prompt copy) and only listed once it is stored.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, type ProjectView, type SessionView } from '../api';
import { FolderPicker } from '../FolderPicker';
import { Icon } from '../ui';
import { draftsInUse, getJson, postJson } from './ChatDock';
import { subscribeCourier } from './courierFeed';
import { failText } from './common';
import type { SessionActions } from './sessionActions';
import s from './ChatDock.module.css';
import n from './NewChat.module.css';
import { Picker } from '../Picker';
import { loadMethod, saveMethod, sendMethods, siteLabel, startPlan, usableMethod, type SendMethod, type SiteChoice } from '../sendMethod';

const LAST_PATH = 'bh.newSessionPath';
const baseName = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

const BROWSE = '\u0000browse';
/** The parent folder, last two parts only: enough to tell same-named projects apart in the menu. */
const shortDir = (p: string): string => {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
  parts.pop();
  return (parts.length > 2 ? '…/' : '') + parts.slice(-2).join('/');
};

export function NewChatPane({ initialPath, projects, sessions, actions, connectorName, mcpUrl, onOpen }: {
  initialPath: string;
  projects: ProjectView[];
  sessions: SessionView[];
  actions: SessionActions;
  connectorName: string;
  mcpUrl: string | null;
  /** The session exists now (first message sent, or the web AI made its first call): show it. */
  onOpen: (id: string) => void;
}) {
  const [path, setPath] = useState(() => initialPath || localStorage.getItem(LAST_PATH) || '');
  const [browsing, setBrowsing] = useState(false);
  // Project menu: every project (not only the first few), the current folder if it is not one, and
  // a last entry that opens the computer's folder dialog (the in-page browser is the fallback).
  const [picking, setPicking] = useState(false);
  const projectItems = [
    ...(path && !projects.some((p) => p.path === path) ? [{ id: path, label: baseName(path), tag: shortDir(path) }] : []),
    ...projects.map((p) => ({ id: p.path, label: p.label, tag: shortDir(p.path) })),
    { id: BROWSE, sep: projects.length > 0 || !!path, label: projects.length || path ? '选择其他文件夹…' : '选择文件夹…' },
  ];
  const browse = async (): Promise<void> => {
    setPicking(true);
    try {
      const r = await api.pickProjectFolder();
      if (r.path) {
        setPath(r.path);
        setBrowsing(false);
        await api.addProject(r.path).catch(() => null); // kept as a project for next time; an existing one is fine
      } else if (!r.cancelled) setBrowsing(true);
    } catch {
      setBrowsing(true);
    } finally {
      setPicking(false);
    }
  };
  const [picked, setMethodState] = useState<SendMethod>(loadMethod);
  const setMethod = (m: SendMethod): void => { setMethodState(m); saveMethod(m); };
  // Sites added in Courier (检测此页面) are offered next to ChatGPT / Arena.
  const [sites, setSites] = useState<SiteChoice[]>([]);
  const methods = sendMethods(sites);
  const method = usableMethod(picked, sites);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ cls: string; text: string } | null>(null);
  const [connected, setConnected] = useState<boolean | null>(null);
  // The reserved draft (after a send or a prompt copy), with the folder it was made for.
  const draft = useRef<{ id: string; path: string; view: SessionView } | null>(null);
  const [waiting, setWaiting] = useState(false);
  const opened = useRef(false);
  const latest = useRef(sessions);
  latest.current = sessions;
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // No folder yet: the first project.
  useEffect(() => {
    if (!path && projects[0]) setPath(projects[0].path);
  }, [path, projects]);

  useEffect(() => {
    return subscribeCourier((st) => {
      if (!st) return setConnected(false);
      setConnected(st.connected);
      const next = st.sites as SiteChoice[] | undefined;
      if (Array.isArray(next)) setSites((cur) => (JSON.stringify(cur) === JSON.stringify(next) ? cur : next));
    });
  }, []);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(240, el.scrollHeight + 2)}px`;
  }, [text]);

  // A copied prompt: open the session once the web AI's first call stores it.
  useEffect(() => {
    const d = draft.current;
    if (!d || opened.current) return;
    const row = sessions.find((x) => x.id === d.id);
    if (row && !row.draft) { opened.current = true; onOpen(d.id); }
  }, [sessions, onOpen]);

  // Leaving with a draft nobody used (nothing sent, no call yet) discards it.
  useEffect(() => () => {
    const d = draft.current;
    if (!d || opened.current || draftsInUse.has(d.id)) return;
    if (latest.current.find((x) => x.id === d.id)?.draft !== false) void api.sessionAction(d.id, 'revoke').catch(() => undefined);
  }, []);

  const ensureDraft = async (): Promise<SessionView> => {
    const p = path.trim();
    const d = draft.current;
    if (d && d.path === p) return d.view;
    if (d && !draftsInUse.has(d.id)) void api.sessionAction(d.id, 'revoke').catch(() => undefined);
    const r = await api.createSession({ workspace_path: p, permission_mode: 'workspace-write', draft: true });
    draft.current = { id: r.session.id, path: p, view: r.session };
    localStorage.setItem(LAST_PATH, p);
    return r.session;
  };

  const copy = async (kind: 'connector' | 'sandbox', task?: string): Promise<void> => {
    if (!path.trim() || busy) return;
    setBusy(true);
    setNote(null);
    try {
      const sv = await ensureDraft();
      await actions.copyPrompt(sv, kind, task);
      setWaiting(true);
    } catch (e) {
      setNote({ cls: 'bad', text: failText(e) });
    } finally {
      setBusy(false);
    }
  };

  const send = async (): Promise<void> => {
    const body = text.trim();
    const plan = startPlan(method);
    if (!body || !path.trim() || busy || (plan && !connected)) return;
    if (!plan) return copy('connector', body);
    setBusy(true);
    setNote({ cls: 'muted', text: `正在新开 ${siteLabel(plan.site, sites)} 会话并发送…` });
    try {
      const sv = await ensureDraft();
      // The daemon wraps the typed text in the prompt template; the thread shows only the typed text.
      const r = await postJson('/courier/start', { sessionId: sv.id, text: body, ...plan });
      if (r.ok || r.sent) {
        draftsInUse.add(sv.id);
        opened.current = true;
        onOpen(sv.id);
        return;
      }
      setNote({ cls: 'bad', text: r.message });
    } catch (e) {
      setNote({ cls: 'bad', text: failText(e) });
    } finally {
      setBusy(false);
    }
  };

  const hint = !path.trim() ? '先选择一个文件夹'
    : method !== 'manual' && connected === false ? '浏览器里的 Courier 未连接，打开浏览器后会自动连上'
    : methods.find((x) => x.id === method)?.hint ?? '';

  return (
    <div className={n.wrap}>
      <div className={n.center}>
        <h2 className={n.title}>新会话</h2>
        <div className={n.folderRow}>
          <Icon name="folder" size={14} />
          <Picker className={n.project} menuClassName={n.projectMenu} align="start" items={projectItems} value={path || BROWSE} disabled={busy || picking} label="项目"
            onChange={(v) => { if (v === BROWSE) void browse(); else { setPath(v); setBrowsing(false); } }} />
          <Picker className={n.method} items={methods} value={method} disabled={busy} onChange={(v) => setMethod(v as SendMethod)} label="发送方式" />
        </div>
        {browsing && (
          <div className={n.picker}>
            <FolderPicker start={path} onPick={(p) => { setPath(p); setBrowsing(false); }} />
          </div>
        )}
        {note && <p className={`${s.note} ${s[note.cls] ?? ''}`} role="status">{note.text}</p>}
        {waiting && !note && <p className={`${s.note}`} role="status">提示词已复制，发给网页 AI；它第一次调用 BlackHole 时这里会自动打开会话。</p>}
        <div className={s.field}>
          <textarea
            ref={inputRef}
            className={`${s.input} ${n.input}`}
            rows={3}
            value={text}
            disabled={!path.trim()}
            name="message"
            placeholder="输入第一条消息，Enter 发送，Shift+Enter 换行"
            aria-label="第一条消息"
            autoFocus
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); void send(); }
            }}
          />
          <button type="button" className={s.send} disabled={busy || !text.trim() || !path.trim() || (method !== 'manual' && !connected)} onClick={() => void send()} aria-label="发送" title="发送（Enter）">{busy ? '…' : '↑'}</button>
        </div>
        <div className={n.foot}>
          <span className={s.hint}>{hint}</span>
          <button type="button" className={n.link} disabled={busy || !path.trim()} onClick={() => void copy('connector')}>复制提示词 · 连接器</button>
          <button type="button" className={n.link} disabled={busy || !path.trim()} onClick={() => void copy('sandbox')}>复制提示词 · 沙箱直连</button>
        </div>
      </div>
    </div>
  );
}
