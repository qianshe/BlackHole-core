import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type CallView, type ConfirmationView, type SessionView } from '../api';
import { toolCallDisplay } from '../../../vscode/src/callDisplay';
import { displayToolName } from '../../../vscode/src/toolNames';
import {
  callDuration,
  callHeadline,
  callTone,
  resultBody,
  resultDiff,
  CALL_STATUS_LABEL,
  formatFull,
  matchCall,
  pathCrumbs,
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

const PAGE = 50;

interface Props {
  session: SessionView;
  approvals: ConfirmationView[];
  now: number;
  actions: SessionActions;
  onApprove: (x: ConfirmationView) => void;
  onApprovalsChanged: () => void;
  onChanged: () => void;
}

/** Pending approval for an awaiting row: same tool and args, else the oldest of the session. */
function approvalFor(call: CallView, list: ConfirmationView[]): ConfirmationView | undefined {
  const same = JSON.stringify(call.args);
  return list.find((x) => x.tool === call.tool && JSON.stringify(x.args) === same) ?? list[0];
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
    <li className={`${c.call} ${open ? c.callOpen : ''} ${fresh ? c.fresh : ''}`}>
      <button type="button" className={c.callRow} aria-expanded={open} aria-controls={`call-${x.id}`} onClick={onToggle}>
        <span className={c.status}>
          <span className={c[`dot_${tone}`]} aria-hidden="true" />
          {CALL_STATUS_LABEL[x.status] ?? x.status}
        </span>
        <span className={c.callMain} title={`${head.label} · ${head.target}`}>
          <span className={c.tool}>{head.label}</span>
          <span className={c.desc}>{head.target}</span>
        </span>
        <span className={c.diff} aria-label={diff ? `新增 ${diff.added} 行，删除 ${diff.removed} 行` : undefined}>
          {diff && diff.added > 0 && <span className={c.diffAdd}>+{diff.added}</span>}
          {diff && diff.removed > 0 && <span className={c.diffDel}>−{diff.removed}</span>}
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
            <pre className={c.pre}>{argsText}</pre>
          </div>
          {body && (
            <div className={c.block}>
              <div className={c.blockHead}>
                <span>结果</span>
                <CopyButton text={body} />
              </div>
              <pre className={c.pre}>{body}</pre>
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

export function SessionPane({ session, approvals, now, actions, onApprove, onApprovalsChanged, onChanged }: Props) {

  const [page, setPage] = useState(1);
  const [tool, setTool] = useState('');
  const [status, setStatus] = useState('');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const seen = useRef<Set<string> | null>(null);

  useEffect(() => {
    setPage(1);
    setTool('');
    setStatus('');
    setQuery('');
    setOpen(new Set());
    seen.current = null;
  }, [session.id]);

  const ended = session.status === 'revoked' || session.status === 'archived';
  const calls = usePoll((signal) => api.calls(session.id, page, PAGE, signal), `calls:${session.id}:${page}`, POLL_MS, !ended || page === 1);
  const todos = usePoll((signal) => api.todos(session.id, signal), `todos:${session.id}`, POLL_MS * 2, !ended);

  const list = calls.data?.calls ?? [];
  const total = calls.data?.total ?? session.calls_total;
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const tools = useMemo(() => [...new Set(list.map((x) => x.tool))].sort(), [list]);
  const shown = useMemo(() => list.filter((x) => matchCall(x, tool, status, query)), [list, tool, status, query]);

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
  const crumbs = pathCrumbs(session.workspace_path);

  return (
    <section className={c.sessionView} aria-label={sessionTitle(session)}>
      <header className={c.sessionHead}>
        <div className={c.sessionTop}>
          <div className={c.sessionTitle}>
            <div className={c.eyebrow}>{crumbs.slice(0, -1).join(' / ') || '会话'}</div>
            <h1 className={c.title}>{sessionTitle(session)}</h1>
            <div className={c.path}>{session.workspace_path}</div>
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
      </header>

      <div className={c.workspace}>
        <section className={c.feed} aria-label="调用记录">
          <div className={c.feedHead}>
            <h2>调用记录</h2>
            <span className={c.count}>
              {shown.length === list.length ? total : `${shown.length} / ${list.length}`}
            </span>
            <div className={c.feedActions}>
              <input className={c.miniSearch} type="search" name="call-filter" placeholder="筛选命令或结果" aria-label="筛选调用" value={query} onChange={(e) => setQuery(e.target.value)} />
              <select className={c.mini} name="call-tool" aria-label="工具" value={tool} onChange={(e) => setTool(e.target.value)}>
                <option value="">全部工具</option>
                {tools.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <select className={c.mini} name="call-status" aria-label="状态" value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">全部状态</option>
                {Object.entries(CALL_STATUS_LABEL)
                  .filter(([k]) => k !== 'unknown')
                  .map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
              </select>
            </div>
          </div>
          {approvals.length > 0 && (
            <button type="button" className={c.narrowApprovals} onClick={() => onApprove(approvals[0]!)}>
              <span className={c.dot_warn} aria-hidden="true" />
              {approvals.length} 个待审批
              <span>审批 ›</span>
            </button>
          )}
          {calls.error && !calls.data ? (
            <p className={c.feedNote} role="alert">
              {failText(calls.error)}
            </p>
          ) : !calls.data ? (
            <p className={c.feedNote}>加载中…</p>
          ) : list.length === 0 ? (
            <p className={c.feedNote}>还没有调用。把提示词发给 AI 后，它的每次工具调用都会出现在这里。</p>
          ) : shown.length === 0 ? (
            <p className={c.feedNote}>没有符合筛选条件的调用。</p>
          ) : (
            <ul className={c.calls}>
              {shown.map((x) => {
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
          {pages > 1 && (
            <nav className={c.pager} aria-label="分页">
              <button type="button" className={c.mini} disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                较新
              </button>
              <span>
                第 {page} / {pages} 页
              </span>
              <button type="button" className={c.mini} disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
                较早
              </button>
            </nav>
          )}
        </section>

        <aside className={c.inspector} aria-label="会话详情">
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
    </section>
  );
}
