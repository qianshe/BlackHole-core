import { useEffect, useState } from 'react';
import { accountSummary, formatRemaining } from '../../../contracts/src/account-summary';
import type { AccountView, ChannelSwitchView, ProjectView, SessionView } from '../api';
import { ChannelSwitch } from './ChannelSwitch';
import { groupSessions, sessionTitle, SESSION_STATUS_LABEL } from '../format';
import { Icon } from '../ui';
import { useMenu } from './common';
import { subscribeCourier } from './courierFeed';
import { SessionMenuItems, type SessionActions } from './sessionActions';
import c from './console.module.css';

export interface ChannelSummary {
  text: string;
  ok: boolean;
}

interface Props {
  sessions: SessionView[];
  projects: ProjectView[];
  /** session id → pending approvals */
  pending: Map<string, number>;
  current: string | null;
  view: 'session' | 'channels';
  channel: ChannelSummary;
  /** 渠道总开关；旧版 daemon 没有 /channel 时为 null（不显示）。 */
  channelSwitch?: ChannelSwitchView | null;
  channelBusy?: boolean;
  onChannelToggle?: (on: boolean) => void;
  account: AccountView | null;
  now: number;
  collapsed: boolean;
  actions: SessionActions;
  onToggle: () => void;
  onSelect: (id: string) => void;
  onNew: (path?: string) => void;
  onSearch: () => void;
  onChannels: () => void;
  onAddProject: () => void;
  onRenameProject: (p: ProjectView) => void;
  onPinProject: (p: ProjectView) => void;
  onRemoveProject: (p: ProjectView) => void;
  onAccount: (action: 'buy' | 'orders' | 'settings' | 'signout') => void;
}

/** Web agent state per session (Courier's last pushed list, cached: cheap to poll). */
interface WebFlags { busy: Set<string>; asking: Set<string> }
const NO_FLAGS: WebFlags = { busy: new Set(), asking: new Set() };
function useWebFlags(): WebFlags {
  const [f, setF] = useState<WebFlags>(NO_FLAGS);
  useEffect(() => {
    // Shared Courier poll; daemon away (null): keep the last flags.
    return subscribeCourier((j) => {
      if (!j) return;
      const busy = new Set((j.targets ?? []).filter((t) => t.busy && t.sessionId).map((t) => t.sessionId!));
      const asking = new Set(j.asking ?? []);
      setF((o) => (same(o.busy, busy) && same(o.asking, asking) ? o : { busy, asking }));
    });
  }, []);
  return f;
}
const same = (a: Set<string>, b: Set<string>): boolean => a.size === b.size && [...a].every((x) => b.has(x));

/**
 * One status at the end of the row, most urgent first (color + text); idle shows nothing.
 * 待审批 / 待回答 need you; 生成中 / 运行中 are working; the rest is quiet progress.
 */
function rowState(x: SessionView, pending: number, web: WebFlags): { text: string; tone: 'warn' | 'run' | 'muted'; title?: string } | null {
  if (pending) return { text: `${pending} 待审批`, tone: 'warn' };
  if (web.asking.has(x.id)) return { text: '待回答', tone: 'warn', title: '网页 AI 发来了提问' };
  if (web.busy.has(x.id)) return { text: '生成中', tone: 'run', title: '网页 AI 正在回复' };
  if (x.status === 'active' && x.activity === 'running') return { text: '运行中', tone: 'run', title: '正在调用工具' };
  if (x.todos_total > 0 && x.todos_done < x.todos_total) return { text: `${x.todos_done}/${x.todos_total}`, tone: 'muted', title: 'Todo 进度' };
  if (x.pending_handoff) return { text: 'Handoff', tone: 'muted', title: '有待接手的 Handoff' };
  if (x.status === 'paused') return { text: SESSION_STATUS_LABEL.paused ?? '已暂停', tone: 'muted' };
  return null;
}

function SessionItem({ x, current, pending, web, onSelect, actions }: { x: SessionView; current: boolean; pending: number; web: WebFlags; onSelect: () => void; actions: SessionActions }) {
  const st = rowState(x, pending, web);
  const state = st?.text ?? SESSION_STATUS_LABEL[x.status] ?? x.status;
  const m = useMenu();
  const [up, setUp] = useState(false);
  const pick = (fn: () => void) => () => {
    m.close();
    fn();
  };
  const toggle = (e: React.MouseEvent<HTMLButtonElement>): void => {
    // open upward near the bottom so the menu is not cut off by the scroll area
    setUp(e.currentTarget.getBoundingClientRect().bottom + 360 > window.innerHeight);
    m.toggle();
  };
  return (
    <li className={c.sessionItem}>
      <button type="button" className={c.sessionRow} aria-current={current ? 'true' : undefined} onClick={onSelect} title={`${sessionTitle(x)} · ${state}`}>
        <span className={c.rowLabel}>{sessionTitle(x)}</span>
        {st && <span className={st.tone === 'warn' ? c.rowMetaWarn : st.tone === 'run' ? c.rowMetaRun : c.rowMeta} title={st.title}>{st.text}</span>}
      </button>
      {/* sibling of the row button: a button inside a button is invalid */}
      <div ref={m.wrapRef} onKeyDown={m.onKeyDown}>
        <button type="button" className={c.sessionMore} aria-label={`${sessionTitle(x)} 更多操作`} aria-haspopup="menu" aria-expanded={m.open} onClick={toggle}>
          <Icon name="more" size={14} />
        </button>
        {m.open && (
          <div className={c.rowMenu} role="menu" style={up ? { top: 'auto', bottom: 36 } : undefined}>
            <SessionMenuItems s={x} actions={actions} pick={pick} withPause />
          </div>
        )}
      </div>
    </li>
  );
}

function ProjectMenu({ p, onNew, onRename, onPin, onRemove }: { p: ProjectView; onNew: () => void; onRename: () => void; onPin: () => void; onRemove: () => void }) {
  const m = useMenu();
  const pick = (fn: () => void) => () => {
    m.close();
    fn();
  };
  return (
    <div ref={m.wrapRef} onKeyDown={m.onKeyDown}>
      <button type="button" className={c.more} aria-label={`${p.label} 更多操作`} aria-haspopup="menu" aria-expanded={m.open} onClick={m.toggle}>
        <Icon name="more" size={14} />
      </button>
      {m.open && (
        <div className={c.menu} role="menu" style={{ right: 4, top: 36 }}>
          <button type="button" role="menuitem" className={c.menuItem} onClick={pick(onNew)}>
            在此新建会话
          </button>
          <button type="button" role="menuitem" className={c.menuItem} onClick={pick(onRename)} disabled={!p.saved}>
            重命名
          </button>
          <button type="button" role="menuitem" className={c.menuItem} onClick={pick(onPin)}>
            {p.pinned ? '取消置顶' : '置顶'}
          </button>
          <div className={c.menuSep} />
          <button type="button" role="menuitem" className={c.menuDanger} onClick={pick(onRemove)} disabled={!p.saved}>
            从列表移除
          </button>
        </div>
      )}
    </div>
  );
}

function accountLine(a: AccountView | null): { name: string; sub: string; tone: '' | 'warn' | 'bad' } {
  const summary = accountSummary(a);
  if (summary.authState === 'logged_out') return { name: '未登录', sub: '登录后使用', tone: 'warn' };
  if (summary.accountStatus === 'suspended') return { name: summary.displayName, sub: '账号已停用', tone: 'bad' };
  if (summary.accountStatus === 'pending') return { name: summary.displayName, sub: '订阅准备中', tone: 'warn' };
  const sub = formatRemaining(summary.remainingSeconds);
  if (summary.remainingSeconds === 0) return { name: summary.displayName, sub, tone: 'bad' };
  if (summary.remainingSeconds === null) return { name: summary.displayName, sub, tone: 'warn' };
  return { name: summary.displayName, sub, tone: summary.remainingSeconds < 3 * 86400 ? 'warn' : '' };
}

function AccountButton({ account, onAction }: { account: AccountView | null; onAction: Props['onAccount'] }) {
  const m = useMenu();
  const summary = accountSummary(account);
  const a = accountLine(account);
  const pick = (k: Parameters<Props['onAccount']>[0]) => () => {
    m.close();
    onAction(k);
  };
  const signedIn = summary.canSignOut;
  return (
    <div className={c.sideBottom} ref={m.wrapRef} onKeyDown={m.onKeyDown}>
      <button type="button" className={c.accountBtn} aria-haspopup="menu" aria-expanded={m.open} onClick={m.toggle} title={`${a.name} · ${a.sub}`}>
        <span className={c.avatar} aria-hidden="true">
          {a.name.slice(0, 1).toUpperCase()}
        </span>
        <span className={c.accountMain}>
          <span className={c.accountName}>{a.name}</span>
          <span className={a.tone === 'bad' ? c.accountSubBad : a.tone === 'warn' ? c.accountSubWarn : c.accountSub}>{a.sub}</span>
        </span>
        <span className={c.accountMore}>
          <Icon name="more" size={14} />
        </span>
      </button>
      {m.open && (
        <div className={c.accountMenu} role="menu">
          <div className={c.menuHead}>
            <div className={c.menuTitle}>{a.name}</div>
            <div className={c.menuMeta}>
              {summary.email ? `${summary.email} · ` : ''}
              {a.sub}
            </div>
          </div>
          <button type="button" role="menuitem" className={c.menuItem} onClick={pick('buy')} disabled={!signedIn}>
            购买时长 <Icon name="card" size={14} />
          </button>
          <button type="button" role="menuitem" className={c.menuItem} onClick={pick('orders')} disabled={!signedIn}>
            购买记录 <Icon name="receipt" size={14} />
          </button>
          <button type="button" role="menuitem" className={c.menuItem} onClick={pick('settings')}>
            设置 <Icon name="gear" size={14} />
          </button>
          <div className={c.menuSep} />
          <button type="button" role="menuitem" className={c.menuDanger} onClick={pick('signout')} disabled={!signedIn}>
            退出登录 <Icon name="logout" size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

export function Sidebar(p: Props) {
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  // ended sessions are not listed: they are cheap and get deleted, not archived
  const { groups, loose } = groupSessions(p.projects, p.sessions);
  const toggleGroup = (id: string): void =>
    setClosed((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const web = useWebFlags();
  const item = (x: SessionView) => <SessionItem key={x.id} x={x} current={p.view === 'session' && p.current === x.id} pending={p.pending.get(x.id) ?? 0} web={web} onSelect={() => p.onSelect(x.id)} actions={p.actions} />;

  return (
    <aside className={c.sidebar} aria-label="导航">
      <div className={c.sideTop}>
        {/* The brand icon keeps its size and place in both states. Collapsed, it is the expand
            button (hover shows the sidebar icon in the same 32px box); expanded, the toggle sits right. */}
        {p.collapsed ? (
          <button type="button" className={`${c.brand} ${c.brandBtn}`} aria-label="展开侧栏" aria-expanded={false} title="展开侧栏" onClick={p.onToggle}>
            <span className={c.brandText}>BH</span>
            <span className={c.brandHover}>
              <Icon name="sidebar" />
            </span>
          </button>
        ) : (
          <>
            <span className={c.brand} aria-hidden="true">
              BH
            </span>
            <span className={c.brandName}>BlackHole</span>
            <button type="button" className={c.collapse} aria-label="收起侧栏" aria-expanded title="收起侧栏" onClick={p.onToggle}>
              <Icon name="sidebar" />
            </button>
          </>
        )}
      </div>

      <button type="button" className={c.primaryNav} onClick={() => p.onNew()} title="新建会话">
        <span className={c.navIcon}>
          <Icon name="plus" />
        </span>
        <span className={c.navLabel}>新建会话</span>
      </button>
      <button type="button" className={c.navBtn} onClick={p.onSearch} title="搜索 (Ctrl+K)">
        <span className={c.navIcon}>
          <Icon name="search" />
        </span>
        <span className={c.navLabel}>搜索</span>
        <span className={c.kbd}>Ctrl K</span>
      </button>
      <div className={c.navRow}>
        <button type="button" className={p.channelSwitch ? `${c.navBtn} ${c.navBtnWithSwitch}` : c.navBtn} aria-current={p.view === 'channels' ? 'page' : undefined} onClick={p.onChannels} title={`公网渠道 · ${p.channel.text}`}>
          <span className={c.navIcon}>
            <Icon name="globe" />
          </span>
          <span className={c.navLabel}>公网渠道</span>
          <span className={p.channel.ok ? c.navSummaryOk : c.navSummary}>{p.channel.text}</span>
        </button>
        <ChannelSwitch view={p.channelSwitch ?? null} busy={!!p.channelBusy} onToggle={(on) => p.onChannelToggle?.(on)} className={c.navRowSwitch} />
      </div>

      <nav className={c.sideScroll} aria-label="项目与会话">
        <div className={c.sectionLabel}>
          项目
          <button type="button" className={c.sectionAction} aria-label="添加项目" title="添加项目" onClick={p.onAddProject}>
            <Icon name="plus" size={14} />
          </button>
        </div>
        {groups.length === 0 && loose.length === 0 && <div className={c.sideEmpty}>还没有项目。新建会话时选择的文件夹会出现在这里。</div>}
        {groups.map(({ project, sessions }) => {
          const open = !closed.has(project.id);
          const waiting = sessions.reduce((n, x) => n + (p.pending.get(x.id) ?? 0), 0);
          return (
            <div key={project.id} className={c.project}>
              <button type="button" className={c.projectHead} aria-expanded={open} onClick={() => toggleGroup(project.id)} title={project.path}>
                <span className={open ? c.chevOpen : c.chev} aria-hidden="true">
                  <Icon name="chevron" size={12} />
                </span>
                <span className={c.projectName}>{project.label}</span>
                {project.pinned && (
                  <span className={c.pinMark} aria-label="已置顶">
                    <Icon name="pin" size={12} />
                  </span>
                )}
                {waiting > 0 ? <span className={c.dot_warn} aria-label={`${waiting} 个待审批`} /> : <span className={c.projectCount}>{sessions.length || ''}</span>}
              </button>
              <ProjectMenu p={project} onNew={() => p.onNew(project.path)} onRename={() => p.onRenameProject(project)} onPin={() => p.onPinProject(project)} onRemove={() => p.onRemoveProject(project)} />
              {open && sessions.length > 0 && <ul className={c.projectSessions}>{sessions.map(item)}</ul>}
            </div>
          );
        })}
        {loose.length > 0 && (
          <>
            <div className={c.sectionLabel}>其他会话</div>
            <ul className={c.recentList}>{loose.map(item)}</ul>
          </>
        )}
      </nav>

      <AccountButton account={p.account} onAction={p.onAccount} />
    </aside>
  );
}
