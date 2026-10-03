import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { api, type CallView, type ConfirmationView, type SessionView } from '../api';
import { toolCallDisplay } from '../../../vscode/src/callDisplay';
import { displayToolName } from '../../../vscode/src/toolNames';
import { useSessionFeed, WEB_FEED_LIMIT, type FeedState } from '../feed/useSessionFeed';
import { anchorShift, captureAnchor, type ScrollAnchor } from '../feed/scrollAnchor';
import { Bubble, ChatDock, usePairLink, type Message } from './ChatDock';
import {
  callDuration,
  callHeadline,
  callTone,
  resultBody,
  resultDiff,
  CALL_STATUS_LABEL,
  formatFull,
  percent,
  PERMISSION_LABEL,
  relativeTime,
  sessionTitle,
  SESSION_STATUS_LABEL,
  TODO_STATUS_LABEL,
} from '../format';
import { POLL_MS, usePoll } from '../usePoll';
import { CopyButton, Icon } from '../ui';
import { ApprovalCard } from './Approval';
import { failText, useMenu } from './common';
import { SessionMenuItems, type SessionActions } from './sessionActions';
import c from './console.module.css';
import { HandoffBar } from './HandoffBar';

/** Inspector width limits; the feed always keeps at least FEED_MIN pixels. */
const INSPECTOR = { min: 240, max: 640, initial: 300, feedMin: 360, key: 'bh.web.inspectorWidth' } as const;

function savedWidth(): number {
  try {
    const v = Number(localStorage.getItem(INSPECTOR.key));
    return v >= INSPECTOR.min && v <= INSPECTOR.max ? v : INSPECTOR.initial;
  } catch {
    return INSPECTOR.initial;
  }
}

/**
 * Draggable divider between the call feed and the session inspector
 * (pointer drag, arrow keys, double-click to reset). The width persists per browser.
 */
function useInspectorResize() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(savedWidth);
  const [dragging, setDragging] = useState(false);
  const clamp = (w: number): number => {
    const box = ref.current?.getBoundingClientRect().width ?? 0;
    const max = box ? Math.max(INSPECTOR.min, Math.min(INSPECTOR.max, box - INSPECTOR.feedMin)) : INSPECTOR.max;
    return Math.round(Math.max(INSPECTOR.min, Math.min(max, w)));
  };
  const commit = (w: number): void => {
    const v = clamp(w);
    setWidth(v);
    try {
      localStorage.setItem(INSPECTOR.key, String(v));
    } catch {
      /* storage unavailable: keep it for this page only */
    }
  };
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    const startX = e.clientX;
    const startW = width;
    let last = startW;
    el.setPointerCapture(e.pointerId);
    setDragging(true);
    const move = (ev: PointerEvent): void => {
      last = clamp(startW + (startX - ev.clientX));
      setWidth(last);
    };
    const up = (): void => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      setDragging(false);
      commit(last);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const step = e.shiftKey ? 64 : 16;
    const next =
      e.key === 'ArrowLeft' ? width + step : e.key === 'ArrowRight' ? width - step : e.key === 'Home' ? INSPECTOR.max : e.key === 'End' ? INSPECTOR.min : null;
    if (next === null) return;
    e.preventDefault();
    commit(next);
  };
  return { ref, width, dragging, onPointerDown, onKeyDown, reset: () => commit(INSPECTOR.initial) };
}

interface Props {
  session: SessionView;
  approvals: ConfirmationView[];
  now: number;
  actions: SessionActions;
  onApprove: (x: ConfirmationView) => void;
  onApprovalsChanged: () => void;
  onChanged: () => void;
  /** Composer inputs; the composer lives in the feed column of this pane. */
  connectorName: string;
  mcpUrl: string | null;
}

/** Pending approval for an awaiting row: same tool and args, else the oldest of the session. */
function approvalFor(call: CallView, list: ConfirmationView[]): ConfirmationView | undefined {
  const same = JSON.stringify(call.args);
  return list.find((x) => x.tool === call.tool && JSON.stringify(x.args) === same) ?? list[0];
}

/** Codex-style: the state is one glyph; the words are only its accessible name. */
const STATUS_GLYPH: Record<string, string> = { ok: '✓', run: '●', warn: '▲', bad: '✕', muted: '·' };

/** Output lines shown before a call's body collapses behind "… 还有 N 行". */
const BODY_LINES = 14;

/** Long output is a tree branch under its call: preview first, the rest on demand. */
function Clip({ text }: { text: string }) {
  const [full, setFull] = useState(false);
  const lines = useMemo(() => text.split('\n'), [text]);
  const hidden = Math.max(0, lines.length - BODY_LINES);
  const shown = full || hidden === 0 ? text : lines.slice(0, BODY_LINES).join('\n');
  if (hidden === 0) return <pre className={c.pre}>{text}</pre>;
  return (
    <div className={c.clipWrap}>
      <pre className={c.pre}>{shown}</pre>
      <button type="button" className={c.clipMore} aria-expanded={full} onClick={() => setFull((v) => !v)}>
        {full ? '收起' : `… 还有 ${hidden} 行`}
      </button>
    </div>
  );
}

function CallItem({ x, open, fresh, onToggle, onApprove }: { x: CallView; open: boolean; fresh: boolean; onToggle: () => void; onApprove?: () => void }) {
  // same wording as the VS Code sidebar card (tool name, summary, details)
  const shown = toolCallDisplay(x.tool, JSON.stringify(x.args ?? {}));
  const head = callHeadline(displayToolName(x.tool), x.args, shown.summary);
  const argsText = shown.details;
  const diff = resultDiff(x.result_summary);
  const body = resultBody(x.result_summary);
  const tone = callTone(x.status);
  const dur = callDuration(x);
  return (
    <li data-feed-key={x.id} className={`${c.call} ${open ? c.callOpen : ''} ${fresh ? c.fresh : ''}`}>
      <button type="button" className={c.callRow} aria-expanded={open} aria-controls={`call-${x.id}`} onClick={onToggle}>
        <span className={c.bullet} data-tone={tone} role="img" aria-label={CALL_STATUS_LABEL[x.status] ?? x.status} title={CALL_STATUS_LABEL[x.status] ?? x.status}>
          {STATUS_GLYPH[tone] ?? '·'}
        </span>
        <span className={c.callMain} title={`${head.label} · ${head.target}`}>
          <span className={c.tool}>{head.label}</span>
          <span className={c.desc}>{head.target}</span>
          {/* diff stats ride with the file they belong to, not in a far column */}
          <span className={c.diff} aria-label={diff ? `新增 ${diff.added} 行，删除 ${diff.removed} 行` : undefined}>
            {diff && diff.added > 0 && <span className={c.diffAdd}>+{diff.added}</span>}
            {diff && diff.removed > 0 && <span className={c.diffDel}>−{diff.removed}</span>}
          </span>
        </span>
        <span className={c.duration} title={formatFull(x.created_at)}>
          {onApprove ? '' : dur ?? (x.status === 'started' ? '执行中' : '')}
        </span>
      </button>
      {/* sibling, not nested: a button inside the row button is invalid */}
      {onApprove && (
        <button type="button" className={c.approveLink} onClick={onApprove}>
          审批 ›
        </button>
      )}
      {open && (
        <div className={c.callBody} id={`call-${x.id}`}>
          <div className={c.block}>
            <div className={c.blockHead}>
              <span>参数</span>
              <CopyButton text={argsText} />
            </div>
            <Clip text={argsText} />
          </div>
          {body && (
            <div className={c.block}>
              <div className={c.blockHead}>
                <span>结果</span>
                <CopyButton text={body} />
              </div>
              <Clip text={body} />
            </div>
          )}
          <div className={c.callFoot}>
            <span>#{x.seq}</span>
            <span>开始 {formatFull(x.created_at)}</span>
            {dur && <span>耗时 {dur}</span>}
            {x.approval_scope && <span>批准范围 {x.approval_scope}</span>}
          </div>
        </div>
      )}
    </li>
  );
}

function SessionMenu({ session, actions, goal }: { session: SessionView; actions: SessionActions; goal: string | null }) {
  const m = useMenu();
  const pick = (fn: () => void) => () => {
    m.close();
    fn();
  };
  return (
    <div className={c.menuWrap} ref={m.wrapRef} onKeyDown={m.onKeyDown}>
      <button type="button" className={c.btn} aria-label="更多会话操作" aria-haspopup="menu" aria-expanded={m.open} onClick={m.toggle}>
        <Icon name="more" />
      </button>
      {m.open && (
        <div className={c.sessionMenu} role="menu">
          <SessionMenuItems s={session} actions={actions} pick={pick} goal={goal} />
        </div>
      )}
    </div>
  );
}

/**
 * 一个会话的聊天式时间线：调用与网页聊天消息都来自会话 feed（长轮询，见 vscode/src/sessionFeed.ts）。
 * 头部由 feed 维护，往上翻的更早内容走 /history；输入框（ChatDock）共用同一条 feed。
 */
function useTimeline(sessionId: string, ended: boolean) {
  const { snap, loadOlder } = useSessionFeed<CallView, Message, FeedState>({ scope: 'web', sessionId, limit: WEB_FEED_LIMIT, once: ended });
  return { entries: snap.entries, calls: snap.calls, messages: snap.messages, loaded: snap.loaded, error: snap.error, hasOlder: snap.hasOlder, olderBusy: snap.loadingOlder, loadOlder };
}

type Entry = { kind: 'call'; x: CallView; at: number } | { kind: 'msg'; m: Message; at: number };

export function SessionPane({ session, approvals, now, actions, onApprove, onApprovalsChanged, onChanged, connectorName, mcpUrl }: Props) {
  const split = useInspectorResize();
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const seen = useRef<Set<string> | null>(null);

  useEffect(() => {
    setOpen(new Set());
    seen.current = null;
  }, [session.id]);

  const ended = session.status === 'revoked' || session.status === 'archived';
  const tl = useTimeline(session.id, ended);
  const todos = usePoll((signal) => api.todos(session.id, signal), `todos:${session.id}`, POLL_MS * 2, !ended);

  const list = tl.calls;
  const total = session.calls_total;
  const more = tl.hasOlder;
  // Questions live in the composer's question card, not in the thread. Receive-only sessions have
  // no card (no composer), so there the question stays in the thread as the only trace of it.
  const pairLink = usePairLink(session.id);
  const questionsInThread = pairLink === 'unpaired' || pairLink === 'direct';
  // 最旧的在上、最新的在下，调用和聊天消息交错；feed 已按时间线键排好序，这里不再排。
  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = [];
    for (const e of tl.entries) {
      if (e.call) out.push({ kind: 'call', x: e.call, at: e.t });
      else if (e.message && (questionsInThread || !e.message.question)) out.push({ kind: 'msg', m: e.message, at: e.t });
    }
    return out;
  }, [tl.entries, questionsInThread]);
  // The final reply of each turn: the last agent message before your next message (calls between
  // don't count). Only these get a copy button; the segments between tool calls do not.
  const finalReplies = useMemo(() => {
    const out = new Set<string>();
    let last: string | null = null;
    for (const e of entries) {
      if (e.kind !== 'msg') continue;
      if (e.m.kind === 'agent') last = e.m.id;
      else { if (last) out.add(last); last = null; }
    }
    if (last) out.add(last);
    return out;
  }, [entries]);

  // The model of the web AI is composer metadata: it stays on the composer and is
  // keyed by site, so switching the bound chat switches the model with it.
  const models = useMemo(() => {
    const out: Record<string, string> = {};
    for (const m of tl.messages) if (m.kind === 'agent' && m.model && m.site) out[m.site] = m.model;
    return out;
  }, [tl.messages]);

  // The last unanswered question from the web agent (nothing of yours sent after it):
  // the composer shows it as a card so one click answers it.
  const question = useMemo(() => {
    for (let i = tl.messages.length - 1; i >= 0; i--) {
      const m = tl.messages[i]!;
      if (m.kind === 'user' && m.status === 'sent') return null;
      // Answered on the web page (Courier reports it): no card here either.
      if (m.kind === 'agent' && m.question) return m.question.answered ? null : { id: m.id, ...m.question };
    }
    return null;
  }, [tl.messages]);

  // Scroll: follow new entries while at the bottom; loading older ones keeps the view in place.
  const feedRef = useRef<HTMLElement>(null);
  const stick = useRef(true);
  // 翻页后保持视图不动：翻页前记下视口里第一个条目和它离容器顶部的距离（锚点），数据到了把同一个条目挨回原位
  // （见 feed/scrollAnchor.ts）。不再记高度补差值：那样依赖高度什么时候变，重复触发或浏览器滚动锚定会算错。
  const anchor = useRef<ScrollAnchor | null>(null);
  const olderBusy = useRef(false);
  // 回到底部按钮：只在滚离底部时出现（滚回底部自动消失）
  const [atBottom, setAtBottom] = useState(true);
  useEffect(() => { stick.current = true; setAtBottom(true); }, [session.id]);
  /** 把锚点条目挨回翻页前的位置（重复执行结果相同，所以每次渲染提交后、请求结束后都可以执行）。 */
  const keepAnchor = (): void => {
    const el = feedRef.current, a = anchor.current;
    if (!el || !a) return;
    const shift = anchorShift(el, a, el.getBoundingClientRect().top);
    if (shift) el.scrollTop += shift;
  };
  useLayoutEffect(() => {
    const el = feedRef.current;
    if (!el) return;
    if (anchor.current) keepAnchor();
    else if (stick.current) el.scrollTop = el.scrollHeight;
  }, [entries]);
  // Content keeps growing after that first layout (long messages fold after measuring, Markdown
  // and images settle, the chat dock below changes height), which left a freshly opened session a
  // little above the bottom. While following, stay pinned whenever the feed or its rows resize.
  useEffect(() => {
    const el = feedRef.current;
    if (!el || typeof ResizeObserver !== 'function') return;
    const pin = (): void => { if (stick.current && anchor.current === null) el.scrollTop = el.scrollHeight; };
    const ro = new ResizeObserver(pin);
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    return () => ro.disconnect();
  }, [entries, session.id]);
  // 在途守卫：scroll 事件连发时组件还没重渲染，tl.olderBusy 是旧值；第二次调用不能再来一次（否则会覆盖锚点）。
  const older = (): void => {
    const el = feedRef.current;
    if (!el || olderBusy.current || !more || tl.olderBusy) return;
    olderBusy.current = true;
    anchor.current = captureAnchor(el, el.getBoundingClientRect().top);
    void tl.loadOlder().finally(() => {
      // 渲染提交之后再最后对一次位置，然后放开
      requestAnimationFrame(() => { keepAnchor(); anchor.current = null; olderBusy.current = false; });
    });
  };
  const onFeedScroll = (): void => {
    const el = feedRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    stick.current = near;
    setAtBottom((v) => (v === near ? v : near));
    if (el.scrollTop < 80) older();
  };
  const jumpBottom = (): void => {
    const el = feedRef.current;
    if (!el) return;
    stick.current = true;
    setAtBottom(true);
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  // rows that appeared since the previous poll get a short highlight
  const fresh = useMemo(() => {
    const prev = seen.current;
    const ids = new Set(list.map((x) => x.id));
    seen.current = ids;
    if (!prev) return new Set<string>();
    return new Set([...ids].filter((id) => !prev.has(id)));
  }, [list]);

  const running = session.status === 'active' && session.activity === 'running';
  const live =
    session.status === 'paused'
      ? { cls: c.live_warn, dot: c.dot_warn, text: '已暂停' }
      : ended
        ? { cls: c.live_muted, dot: c.dot_muted, text: SESSION_STATUS_LABEL[session.status] ?? session.status }
        : running
          ? { cls: c.live_run, dot: c.dot_run, text: '运行中' }
          : { cls: c.live_ok, dot: c.dot_ok, text: '空闲' };

  const act = (action: 'pause' | 'resume'): void => {
    setBusy(true);
    void actions.pauseResume(session, action).finally(() => setBusy(false));
  };

  const board = todos.data;
  const items = board?.items ?? [];
  const done = items.filter((t) => t.status === 'completed').length;

  return (
    <section className={c.sessionView} aria-label={sessionTitle(session)}>
      <header className={c.sessionHead}>
        <div className={c.sessionTop}>
          <div className={c.sessionTitle}>
            <h1 className={c.title}>{sessionTitle(session)}</h1>
          </div>
          <div className={c.controls}>
            <span className={live.cls} aria-live="polite">
              <span className={live.dot} aria-hidden="true" />
              {live.text}
            </span>
            {!ended &&
              (session.status === 'paused' ? (
                <button type="button" className={c.btn} disabled={busy} onClick={() => act('resume')}>
                  <Icon name="play" size={14} /> 恢复
                </button>
              ) : (
                <button type="button" className={c.btn} disabled={busy} onClick={() => act('pause')}>
                  <Icon name="pause" size={14} /> 暂停
                </button>
              ))}
            <button type="button" className={c.btn} disabled={ended} onClick={() => void actions.copyConnection()}>
              <Icon name="link" size={14} /> 复制连接
            </button>
            <SessionMenu session={session} actions={actions} goal={todos.data?.contract?.goal ?? null} />
          </div>
        </div>
        <div className={c.facts}>
          <span className={c.path} title={session.workspace_path}>
            {session.workspace_path}
          </span>
          <span aria-hidden="true">·</span>
          <span>
            权限 <b>{PERMISSION_LABEL[session.permission_mode] ?? session.permission_mode}</b>
          </span>
          <span aria-hidden="true">·</span>
          <span>
            最近活动 <b>{relativeTime(session.last_active_at, now)}</b>
          </span>
          <span aria-hidden="true">·</span>
          <span>
            自动批准 <b>{session.auto_approve ? '开' : '关'}</b>
          </span>
          <span aria-hidden="true">·</span>
          <span>
            调用 <b>{total}</b>
          </span>
        </div>
        <HandoffBar session={session} connectorName={connectorName} now={now} />
      </header>

      <div ref={split.ref} className={`${c.workspace} ${split.dragging ? c.resizing : ''}`} style={{ '--inspector-w': `${split.width}px` } as CSSProperties}>
        <section className={c.feed} aria-label="调用记录" ref={feedRef} onScroll={onFeedScroll}>
          {approvals.length > 0 && (
            <button type="button" className={c.narrowApprovals} onClick={() => onApprove(approvals[0]!)}>
              <span className={c.dot_warn} aria-hidden="true" />
              {approvals.length} 个待审批
              <span>审批 ›</span>
            </button>
          )}
          {tl.error && !tl.loaded ? (
            <p className={c.feedNote} role="alert">
              {failText(tl.error)}
            </p>
          ) : !tl.loaded ? (
            <p className={c.feedNote}>加载中…</p>
          ) : entries.length === 0 && !more && session.draft ? (
            <div className={c.feedNote}>
              <p><b>新会话还没有连上网页 AI</b></p>
              <p className={c.draftRow}>
                <button type="button" className={c.btn} onClick={() => void actions.copyPrompt(session, 'connector')}>复制提示词 · 连接器</button>
                <button type="button" className={c.btn} onClick={() => void actions.copyPrompt(session, 'sandbox')}>复制提示词 · 沙箱直连</button>
              </p>
              <p>复制提示词交给网页 AI 自行使用；或在下方输入并发送，新开网页 AI 会话并配对。都没做就离开，会话会被丢弃。</p>
            </div>
          ) : entries.length === 0 && !more ? (
            <p className={c.feedNote}>{'还没有消息和工具调用。在下方输入框发送第一条消息，或把提示词发给网页 AI。'}</p>
          ) : (
            <ul className={c.calls}>
              <li className={c.older}>
                {more ? (
                  tl.olderBusy ? <span>正在加载…</span> : <button type="button" className={c.mini} onClick={older}>加载更早的记录</button>
                ) : (
                  <span>会话开始 · 共 {total} 次调用</span>
                )}
              </li>
              {entries.map((e) => {
                if (e.kind === 'msg') return <Bubble key={e.m.id} m={e.m} copy={finalReplies.has(e.m.id)} />;
                const x = e.x;
                const a = x.status === 'awaiting' ? approvalFor(x, approvals) : undefined;
                return (
                  <CallItem
                    key={x.id}
                    x={x}
                    fresh={fresh.has(x.id)}
                    open={open.has(x.id)}
                    onToggle={() =>
                      setOpen((s) => {
                        const n = new Set(s);
                        if (n.has(x.id)) n.delete(x.id);
                        else n.add(x.id);
                        return n;
                      })
                    }
                    onApprove={a ? () => onApprove(a) : undefined}
                  />
                );
              })}
            </ul>
          )}
          {!atBottom && (
            <div className={c.jumpWrap}>
              <button type="button" className={c.jump} onClick={jumpBottom} aria-label="回到底部" title="回到底部">
                ↓
              </button>
            </div>
          )}
        </section>

        {/* The composer shares the feed column: pinned under the timeline, never
            crossing onto the session-detail inspector. */}
        <div className={c.dockCell}>
          <ChatDock key={session.id} session={session} connectorName={connectorName} mcpUrl={mcpUrl} models={models} question={question} />
        </div>

        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="调整会话详情宽度"
          aria-controls="session-inspector"
          aria-valuenow={split.width}
          aria-valuemin={INSPECTOR.min}
          aria-valuemax={INSPECTOR.max}
          tabIndex={0}
          title="拖动调整宽度，双击恢复默认"
          className={c.splitter}
          onPointerDown={split.onPointerDown}
          onKeyDown={split.onKeyDown}
          onDoubleClick={split.reset}
        />

        {/* Wide: the dock is display:contents, so the inspector stays grid column 3.
            Narrow (≤1100px): it becomes a top-right icon; the panel opens on hover or
            focus and closes when the pointer/focus leaves. Approvals keep their
            click-to-open bar in the feed. */}
        <div className={c.inspectorDock}>
        <button type="button" className={c.inspectorToggle} aria-label="会话详情" title="会话详情" aria-controls="session-inspector">
          <Icon name="list" size={14} />
          {approvals.length > 0 && <span className={c.inspectorBadge} aria-hidden="true" />}
        </button>
        <aside id="session-inspector" className={c.inspector} aria-label="会话详情">
          <h2 className={c.inspectorTitle}>会话详情</h2>
          {approvals.length > 0 && (
            <div className={c.group}>
              <h3 className={c.groupTitle}>
                待审批 <span>{approvals.length}</span>
              </h3>
              <div style={{ display: 'grid', gap: 8 }}>
                {approvals.slice(0, 3).map((x) => (
                  <ApprovalCard key={x.id} x={x} onOpen={() => onApprove(x)} onDone={onApprovalsChanged} />
                ))}
              </div>
              {approvals.length > 3 && (
                <button type="button" className={c.moreApprovals} onClick={() => onApprove(approvals[3]!)}>
                  还有 {approvals.length - 3} 个待审批
                </button>
              )}
            </div>
          )}
          <div className={c.group}>
            <h3 className={c.groupTitle}>任务</h3>
            {board?.contract ? (
              <dl className={c.kv}>
                <dt>目标</dt>
                <dd>{board.contract.goal}</dd>
                {!!board.contract.successCriteria?.length && (
                  <>
                    <dt>完成标准</dt>
                    <dd>
                      <ul>
                        {board.contract.successCriteria.map((t, i) => (
                          <li key={i}>{t}</li>
                        ))}
                      </ul>
                    </dd>
                  </>
                )}
                {!!board.contract.nonGoals?.length && (
                  <>
                    <dt>不做</dt>
                    <dd>
                      <ul>
                        {board.contract.nonGoals.map((t, i) => (
                          <li key={i}>{t}</li>
                        ))}
                      </ul>
                    </dd>
                  </>
                )}
              </dl>
            ) : (
              <p className={c.muted}>AI 开始工作后会在这里写下目标。</p>
            )}
          </div>
          <div className={c.group}>
            <h3 className={c.groupTitle}>
              待办 <span>{items.length ? `${done}/${items.length}` : ''}</span>
            </h3>
            {items.length ? (
              <>
                <div className={c.progress} role="progressbar" aria-label="待办进度" aria-valuenow={percent(done, items.length)} aria-valuemin={0} aria-valuemax={100}>
                  <i style={{ width: `${percent(done, items.length)}%` }} />
                </div>
                <ul className={c.todos}>
                  {items.map((t, i) => (
                    <li key={i} className={t.status === 'completed' ? c.todoDone : t.status === 'in_progress' ? c.todoRun : c.todo}>
                      <span className={c.check} aria-hidden="true">
                        {t.status === 'completed' ? <Icon name="check" size={10} /> : t.status === 'in_progress' ? <Icon name="dot" size={10} /> : null}
                      </span>
                      <span>{t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content}</span>
                      <span className={c.todoState}>{TODO_STATUS_LABEL[t.status]}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className={c.muted}>暂无待办。</p>
            )}
          </div>
          <div className={c.group}>
            <h3 className={c.groupTitle}>会话</h3>
            <dl className={c.kv}>
              <dt>状态</dt>
              <dd>{SESSION_STATUS_LABEL[session.status] ?? session.status}</dd>
              <dt>创建</dt>
              <dd>{formatFull(session.created_at)}</dd>
            </dl>
          </div>
        </aside>
        </div>
      </div>
    </section>
  );
}
