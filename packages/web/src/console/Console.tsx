import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { api, ApiError, panel, remoteAdmin, type AccountView, type ConfirmationView, type ProjectView, type SessionView } from '../api';
import { readViewState, sessionTitle, underPath, writeViewState, type SettingsSection, type ViewState } from '../format';
import { NewChatPane } from './NewChatPane';
import { ProjectFolderDialog } from './ProjectFolderDialog';
import { SubscriptionBanner } from '../SubscriptionBanner';
import { POLL_MS, usePoll, useNow } from '../usePoll';
import { startPresence } from '../presence';
import { CopyButton, Icon } from '../ui';
import { ApprovalDialog } from './Approval';
import { ChannelsPane, channelSummary } from './ChannelsPane';
import { CHANNEL_SWITCH_HINT } from './ChannelSwitch';
import { ConfirmDialog, DialogHead, failText, Modal, PromptDialog, ToastProvider, useToast, type ConfirmSpec } from './common';
import { SearchPalette } from './SearchPalette';
import { SessionPane } from './SessionPane';
import { SettingsModal } from './SettingsModal';
import { Sidebar } from './Sidebar';
import c from './console.module.css';
import { useSessionActions } from './sessionActions';
import { draftsInUse } from './ChatDock';
import { PairPrompt } from './PairPrompt';

function useViewState(): [ViewState, (patch: Partial<ViewState>) => void] {
  const [view, setView] = useState<ViewState>(() => readViewState(window.location.search));
  const update = useCallback((patch: Partial<ViewState>) => {
    setView((v) => {
      const next = { ...v, ...patch };
      history.replaceState(null, '', window.location.pathname + writeViewState(next));
      return next;
    });
  }, []);
  return [view, update];
}

const narrow = (): boolean => window.matchMedia('(max-width: 760px)').matches;

const SIDE_LIMITS = { min: 150, max: 600, initial: 284, feedMin: 360, rightMin: 230, gutter: 5, padding: 12, key: 'bh.web.sidebarWidth' } as const;

function sidebarStoredWidth(): number {
  try {
    const value = Number(localStorage.getItem(SIDE_LIMITS.key));
    return value >= SIDE_LIMITS.min && value <= SIDE_LIMITS.max ? value : SIDE_LIMITS.initial;
  } catch {
    return SIDE_LIMITS.initial;
  }
}

/** Resize only the workbench shell. The sidebar's labels, menus and data stay untouched. */
function useSidebarResize(collapsed: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ pointerId: number; x: number; start: number; previous: number; latest: number } | null>(null);
  const [preferred, setPreferred] = useState(sidebarStoredWidth);
  const [available, setAvailable] = useState(() => typeof window === 'undefined' ? 1400 : window.innerWidth);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setAvailable(el.clientWidth);
    measure();
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(measure);
      observer.observe(el);
      return () => observer.disconnect();
    }
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);
  const wide = available > 1100;
  const max = Math.max(SIDE_LIMITS.min, Math.min(SIDE_LIMITS.max,
    available - SIDE_LIMITS.padding - SIDE_LIMITS.gutter - SIDE_LIMITS.feedMin - (wide ? SIDE_LIMITS.rightMin + SIDE_LIMITS.gutter : 0)));
  const visible = collapsed ? 48 : Math.min(max, Math.max(SIDE_LIMITS.min, preferred));
  const clamp = (value: number) => Math.round(Math.min(max, Math.max(SIDE_LIMITS.min, value)));
  const save = (width: number) => {
    const next = clamp(width);
    setPreferred(next);
    try { localStorage.setItem(SIDE_LIMITS.key, String(next)); } catch { /* optional */ }
  };
  const finish = (el: HTMLDivElement, pointerId: number, commit: boolean) => {
    const d = gesture.current;
    if (!d || d.pointerId !== pointerId) return;
    gesture.current = null;
    setDragging(false);
    if (commit) save(d.latest);
    else setPreferred(d.previous);
    if (el.hasPointerCapture(pointerId)) el.releasePointerCapture(pointerId);
  };
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (collapsed || e.button !== 0) return;
    e.preventDefault();
    gesture.current = { pointerId: e.pointerId, x: e.clientX, start: visible, previous: preferred, latest: visible };
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = gesture.current;
    if (!d || d.pointerId !== e.pointerId) return;
    d.latest = clamp(d.start + e.clientX - d.x);
    setPreferred(d.latest);
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (collapsed) return;
    const step = e.shiftKey ? 64 : 16;
    const next = e.key === 'ArrowLeft' ? visible - step : e.key === 'ArrowRight' ? visible + step
      : e.key === 'Home' ? SIDE_LIMITS.min : e.key === 'End' ? max : null;
    if (next === null) return;
    e.preventDefault();
    save(next);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !gesture.current) return;
      const d = gesture.current;
      const handle = ref.current?.querySelector<HTMLDivElement>('[role="separator"]');
      if (handle) {
        e.preventDefault();
        e.stopPropagation();
        finish(handle, d.pointerId, false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });
  return { ref, visible, max, dragging, onPointerDown, onPointerMove, onKeyDown, finish, reset: () => save(SIDE_LIMITS.initial) };
}


function RotatedDialog({ id, onClose }: { id: string; onClose: () => void }) {
  return (
    <Modal label="新的会话 ID" onClose={onClose}>
      <DialogHead title="新的会话 ID" onClose={onClose} />
      <div className={c.dialogBody}>
        <p>旧 ID 已失效。把新 ID 发给 AI，或在「···」菜单里重新复制提示词。</p>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <code className={c.cmd} style={{ margin: 0, flex: 1 }}>
            {id}
          </code>
          <CopyButton text={id} label="复制 ID" />
        </div>
      </div>
      <div className={c.dialogActions}>
        <button type="button" className={c.btnPrimary} onClick={onClose}>
          完成
        </button>
      </div>
    </Modal>
  );
}

function ConsoleInner({ onSignedOut }: { onSignedOut: (reason: string) => void }) {
  const toast = useToast();
  const [view, setView] = useViewState();
  const now = useNow(5000);
  const [collapsed, setCollapsed] = useState(narrow);
  const sidebarResize = useSidebarResize(collapsed);
  // crossing into the narrow layout closes the drawer; widening restores the sidebar
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 760px)');
    const on = (): void => setCollapsed(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  // New session page (no session selected): the folder to start in; the key resets the page.
  const [newChat, setNewChat] = useState({ path: '', key: 0 });
  const [renamingSession, setRenamingSession] = useState<SessionView | null>(null);
  const [search, setSearch] = useState(false);
  const [approving, setApproving] = useState<ConfirmationView | null>(null);
  const [confirmSpec, setConfirmSpec] = useState<ConfirmSpec | null>(null);
  const [renaming, setRenaming] = useState<ProjectView | null>(null);
  const [addingProject, setAddingProject] = useState(false);
  const [rotated, setRotated] = useState<string | null>(null);

  const sessions = usePoll((s) => api.sessions(s), 'sessions', POLL_MS, true);
  const projects = usePoll((s) => api.projects(s), 'projects', POLL_MS * 5, true);
  // One Core-hosted folder dialog is shared by add-project and new session.
  // Keep the native system picker backend only for an explicit future fallback.
  const confirmations = usePoll((s) => api.confirmations(undefined, s), 'confirmations', POLL_MS, true);
  const health = usePoll(() => panel.health(), 'health', POLL_MS * 2, true);
  const settings = usePoll((s) => api.settings(s), 'settings', POLL_MS * 10, true);
  // 渠道总开关：旧版 daemon 没有 /channel 时为 null（不显示开关）。
  const channelSwitch = usePoll(() => panel.channel().catch(() => null), 'channel', POLL_MS * 2, true);
  const [channelBusy, setChannelBusy] = useState(false);
  const toggleChannel = (on: boolean): void => {
    if (channelBusy) return;
    setChannelBusy(true);
    panel.channelSwitch(on).then(
      () => toast(on ? '正在启动渠道' : '渠道已关闭'),
      (e: unknown) => {
        const code = (e as { code?: string }).code ?? '';
        toast(CHANNEL_SWITCH_HINT[code] ?? failText(e), code in CHANNEL_SWITCH_HINT ? 'warn' : 'bad');
        // 缺前提：直接带用户去设置的「公网渠道」补上。
        if (code === 'cloudflared' || code === 'named_url' || code === 'openai_setup') openSettings('connections');
      },
    ).finally(() => {
      setChannelBusy(false);
      channelSwitch.refresh();
      health.refresh();
    });
  };
  const remote = usePoll(() => remoteAdmin.view(), 'remote', POLL_MS * 5, view.view === 'channels');
  // An open console keeps channels alive like a VS Code window (hidden tabs too).
  useEffect(() => startPresence(), []);
  useEffect(() => {
    let pending: string | null = null;
    try {
      pending = sessionStorage.getItem('blackhole.pendingSetup.v1');
      if (pending) sessionStorage.removeItem('blackhole.pendingSetup.v1');
    } catch { /* optional browser storage */ }
    if (pending === 'cloudflare') {
      void panel.cloudflaredStart().then(
        () => toast('Cloudflare 安装任务已开始；安装完成后由你决定是否启动渠道。'),
        (e: unknown) => toast('Cloudflare 安装未开始：' + failText(e), 'bad'),
      );
    } else if (pending === 'openai') {
      void panel.openaiInstallStart().then(
        () => toast('OpenAI tunnel-client 安装任务已开始；安装完成后继续配置 Tunnel ID。'),
        (e: unknown) => toast('OpenAI runtime 安装未开始：' + failText(e), 'bad'),
      );
    }
  }, [toast]);
  const [account, setAccount] = useState<AccountView | null>(null);
  const loadAccount = useCallback(async (): Promise<AccountView | null> => {
    try {
      const next = await api.account();
      setAccount(next);
      return next;
    } catch {
      return null;
    }
  }, []);
  useEffect(() => {
    void loadAccount();
    const t = setInterval(() => { if (!document.hidden) void loadAccount(); }, 60_000);
    const onFocus = () => { void loadAccount(); };
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(t);
      window.removeEventListener('focus', onFocus);
    };
  }, [loadAccount]);

  const unauthorized = [sessions.error, confirmations.error].some((e) => e instanceof ApiError && e.status === 401);
  useEffect(() => {
    if (unauthorized) onSignedOut('unauthenticated');
  }, [unauthorized, onSignedOut]);

  const list = sessions.data?.sessions ?? [];
  const projectList = projects.data?.projects ?? [];
  const pendingList = useMemo(() => (confirmations.data?.confirmations ?? []).filter((x) => x.status === 'pending'), [confirmations.data]);
  const pending = useMemo(() => {
    const m = new Map<string, number>();
    for (const x of pendingList) m.set(x.session_id, (m.get(x.session_id) ?? 0) + 1);
    return m;
  }, [pendingList]);

  // No selection = the new session page (a lone composer). A selected session that vanished
  // goes back to it, except one just opened from that page and not in the polled list yet.
  const opening = useRef<string | null>(null);
  useEffect(() => {
    if (!sessions.data || !view.session) return;
    if (list.some((x) => x.id === view.session)) {
      if (opening.current === view.session) opening.current = null;
      return;
    }
    if (opening.current === view.session) return;
    setView({ session: null });
  }, [sessions.data, list, view.session, setView]);
  // Drafts are not listed: a session shows up once it really started.
  const listed = useMemo(() => list.filter((x) => !x.draft), [list]);
  const current = list.find((x) => x.id === view.session) ?? null;

  // Leaving a draft that never reached a web AI (no call, nothing sent) discards it.
  const [lastDraft, setLastDraft] = useState<string | null>(null);
  useEffect(() => {
    if (lastDraft && lastDraft !== view.session) {
      const d = list.find((x) => x.id === lastDraft);
      if (d?.draft && !draftsInUse.has(d.id)) void api.sessionAction(d.id, 'revoke').catch(() => undefined).then(() => sessions.refresh());
    }
    setLastDraft(current?.draft ? current.id : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.session, current?.draft]);

  // Ctrl/Cmd+K opens search anywhere; Esc closes the narrow-screen drawer
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && narrow() && !document.querySelector('dialog[open]')) setCollapsed(true);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearch(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const openSettings = (section: SettingsSection = 'home'): void => setView({ settings: section });
  const select = (id: string): void => {
    setView({ session: id, view: 'session' });
    if (narrow()) setCollapsed(true);
  };
  const openNew = (path?: string): void => {
    setNewChat((x) => ({ path: path ?? '', key: x.key + 1 }));
    setView({ session: null, view: 'session' });
    if (narrow()) setCollapsed(true);
  };
  const st = channelSummary(health.data, settings.data?.values.channelMode);
  const refreshAll = (): void => {
    sessions.refresh();
    confirmations.refresh();
  };  // one implementation shared by the sidebar row menu and the session header menu
  const actions = useSessionActions({
    toast,
    confirm: setConfirmSpec,
    onChanged: refreshAll,
    onRotated: setRotated,
    onRename: setRenamingSession,
    connectorName: settings.data?.values.connectorName ?? 'BlackHole',
    mcpUrl: health.data?.mcp_url ?? null,
  });


  const onAccount = (k: 'buy' | 'orders' | 'settings' | 'signout'): void => {
    if (k !== 'signout') return openSettings(k === 'settings' ? 'home' : 'account');
    setConfirmSpec({
      title: '退出登录',
      body: '退出后，这台电脑上的网页和已配对的手机都需要重新登录，AI 暂时无法调用工具。',
      action: '退出登录',
      danger: true,
      run: async () => {
        await api.accountSignOut();
        onSignedOut('account_required');
      },
    });
  };

  const reachable = !sessions.error || !!sessions.data;

  return (
    <div ref={sidebarResize.ref} className={`${c.app} ${collapsed ? c.collapsed : ''} ${sidebarResize.dragging ? c.sidebarResizing : ''}`} style={{ '--sidebar-w': `${sidebarResize.visible}px` } as CSSProperties}>
      <Sidebar
        sessions={listed}
        projects={projectList}
        pending={pending}
        current={view.session}
        view={view.view}
        channel={{ text: st.text, ok: st.tone === 'ok' }}
        channelSwitch={channelSwitch.data ?? null}
        channelBusy={channelBusy}
        onChannelToggle={toggleChannel}
        account={account}
        now={now}
        collapsed={collapsed}
        actions={actions}
        onToggle={() => setCollapsed((x) => !x)}
        onSelect={select}
        onNew={openNew}
        onSearch={() => setSearch(true)}
        onChannels={() => {
          setView({ view: 'channels' });
          if (narrow()) setCollapsed(true);
        }}
        onAddProject={() => setAddingProject(true)}
        onRenameProject={setRenaming}
        onPinProject={(p) =>
          void api.updateProject(p.id, { pinned: !p.pinned }).then(
            () => {
              toast(p.pinned ? '已取消置顶' : '已置顶');
              projects.refresh();
            },
            (e: unknown) => toast(failText(e), 'bad'),
          )
        }
        onRemoveProject={(p) =>
          setConfirmSpec({
            title: '移除项目',
            body: `从列表移除「${p.label}」。文件夹和其中的会话不受影响。`,
            action: '移除',
            danger: true,
            run: async () => {
              await api.removeProject(p.id);
              toast('项目已移除');
              projects.refresh();
            },
          })
        }
        onAccount={onAccount}
      />

      <div role="separator" aria-orientation="vertical" aria-label="调整导航栏宽度" aria-valuenow={sidebarResize.visible} aria-valuemin={collapsed ? 48 : SIDE_LIMITS.min} aria-valuemax={collapsed ? 48 : sidebarResize.max} tabIndex={collapsed ? -1 : 0} title="拖动面板间距调整导航宽度，双击恢复默认" className={c.sidebarSplitter} onPointerDown={sidebarResize.onPointerDown} onPointerMove={sidebarResize.onPointerMove} onPointerUp={(event) => sidebarResize.finish(event.currentTarget, event.pointerId, true)} onPointerCancel={(event) => sidebarResize.finish(event.currentTarget, event.pointerId, false)} onLostPointerCapture={(event) => sidebarResize.finish(event.currentTarget, event.pointerId, false)} onKeyDown={sidebarResize.onKeyDown} onDoubleClick={sidebarResize.reset} />
      <button type="button" className={c.scrim} aria-label="收起侧栏" tabIndex={-1} onClick={() => setCollapsed(true)} />
      <main className={`${c.main} ${current ? c.mainSession : ''}`}>
        {!reachable && (
          <div className={c.connection} role="alert">
            <Icon name="alert" size={14} /> 连不上 BlackHole，正在重试…
            <button type="button" className={c.btn} onClick={refreshAll}>
              立即重试
            </button>
          </div>
        )}
        <SubscriptionBanner account={account} onRenew={() => openSettings('account')} />
        <div className={c.mainBody}>
          {view.view === 'channels' ? (
            <ChannelsPane
              health={health.data}
              values={settings.data?.values ?? null}
              remote={remote.data}
              onRefresh={() => {
                health.refresh();
                remote.refresh();
              }}
              onSettings={openSettings}
              channelSwitch={channelSwitch.data ?? null}
              channelBusy={channelBusy}
              onChannelToggle={toggleChannel}
            />
          ) : current ? (
            <SessionPane
              session={current}
              approvals={pendingList.filter((x) => x.session_id === current.id)}
              now={now}
              actions={actions}
              onApprove={setApproving}
              onApprovalsChanged={refreshAll}
              onChanged={refreshAll}
              connectorName={settings.data?.values.connectorName ?? 'BlackHole'}
            />
          ) : sessions.data ? (
            <NewChatPane
              key={newChat.key}
              initialPath={newChat.path}
              projects={projectList}
              sessions={list}
              actions={actions}
              onProjectsChange={projects.refresh}
              onOpen={(id) => {
                opening.current = id;
                refreshAll();
                projects.refresh();
                setView({ session: id, view: 'session' });
              }}
            />
          ) : (
            <div className={c.center}>
              <p>加载中…</p>
            </div>
          )}
        </div>
      </main>

      {search && (
        <SearchPalette
          sessions={listed}
          projects={projectList}
          onClose={() => setSearch(false)}
          onPick={(kind, id) => {
            setSearch(false);
            if (kind === 'session') return select(id);
            const p = projectList.find((x) => x.id === id);
            const inside = p && list.find((x) => underPath(x.workspace_path, p.path) && x.status !== 'revoked' && x.status !== 'archived');
            if (inside) select(inside.id);
            else if (p) openNew(p.path);
          }}
        />
      )}
      {approving && (
        <ApprovalDialog
          x={approving}
          sessionLabel={(() => {
            const s = list.find((x) => x.id === approving.session_id);
            return s ? sessionTitle(s) : approving.session_id;
          })()}
          onClose={() => setApproving(null)}
          onDone={refreshAll}
        />
      )}
      {confirmSpec && <ConfirmDialog spec={confirmSpec} onClose={() => setConfirmSpec(null)} />}
      <PairPrompt toast={toast} />
      {renaming && (
        <PromptDialog
          title="重命名项目"
          label="名称"
          initial={renaming.label}
          action="保存"
          onClose={() => setRenaming(null)}
          onSubmit={async (label) => {
            await api.updateProject(renaming.id, { label });
            projects.refresh();
          }}
        />
      )}
      {renamingSession && (
        <PromptDialog
          title="重命名会话"
          label="名称"
          initial={renamingSession.name ?? sessionTitle(renamingSession)}
          action="保存"
          onClose={() => setRenamingSession(null)}
          onSubmit={async (name) => {
            await api.renameSession(renamingSession.id, name);
            toast('已重命名');
            refreshAll();
          }}
        />
      )}
      {addingProject && (
        <ProjectFolderDialog mode="add" start=""
          onClose={() => setAddingProject(false)}
          onSelect={async (path) => {
            let existing = false;
            try { await api.addProject(path); }
            catch (e) {
              if (!(e instanceof ApiError && e.code === 'project_exists')) throw e;
              existing = true;
            }
            projects.refresh();
            openNew(path);
            toast(existing ? '已切换到已有项目' : '项目已添加');
          }}
        />
      )}
      {rotated && <RotatedDialog id={rotated} onClose={() => setRotated(null)} />}
      {view.settings && (
        <SettingsModal
          section={view.settings}
          account={account}
          onAccountChange={setAccount}
          refreshAccount={loadAccount}
          onSignOut={() => onAccount('signout')}
          onSection={(s: SettingsSection) => setView({ settings: s })}
          onClose={() => {
            setView({ settings: null });
            health.refresh();
            settings.refresh();
            void loadAccount();
          }}
        />
      )}
    </div>
  );
}

export function Console({ onSignedOut }: { onSignedOut: (reason: string) => void }) {
  return (
    <ToastProvider>
      <ConsoleInner onSignedOut={onSignedOut} />
    </ToastProvider>
  );
}
