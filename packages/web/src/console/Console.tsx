import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, panel, remoteAdmin, type AccountView, type ConfirmationView, type ProjectView, type SessionView } from '../api';
import { readViewState, sessionTitle, underPath, writeViewState, type SettingsSection, type ViewState } from '../format';
import { NewChatPane } from './NewChatPane';
import { FolderPicker } from '../FolderPicker';
import { SubscriptionBanner } from '../SubscriptionBanner';
import { POLL_MS, usePoll, useNow } from '../usePoll';
import { startPresence } from '../presence';
import { CopyButton, Icon } from '../ui';
import { ApprovalDialog } from './Approval';
import { ChannelsPane, channelSummary } from './ChannelsPane';
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

function AddProjectDialog({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal label="添加项目" onClose={onClose}>
      <DialogHead title="添加项目" onClose={onClose} />
      <div className={c.dialogBody}>
        <p>选择一个文件夹，之后可以在它下面新建会话。</p>
        <FolderPicker
          start=""
          onPick={(path) =>
            void api.addProject(path).then(
              () => {
                toast('项目已添加');
                onAdded();
                onClose();
              },
              (e: unknown) => setError(failText(e)),
            )
          }
        />
        {error && (
          <p role="alert" style={{ color: 'var(--bad)', marginTop: 8 }}>
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
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
  // 添加项目 opens the computer's own folder dialog; the in-page folder browser is the fallback
  // when the system has no dialog to offer (or the daemon is older).
  const [pickingFolder, setPickingFolder] = useState(false);
  const addProjectNative = async (): Promise<void> => {
    if (pickingFolder) return;
    setPickingFolder(true);
    toast('已在电脑上打开选择文件夹窗口');
    try {
      const r = await api.pickProjectFolder();
      if (r.path) {
        await api.addProject(r.path);
        toast('项目已添加');
        projects.refresh();
      } else if (!r.cancelled) setAddingProject(true);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'picker_busy') toast('电脑上已经打开了一个选择文件夹窗口', 'warn');
      else if (code === 'project_exists' || code === 'too_many_projects') toast(failText(e), 'bad');
      else setAddingProject(true);
    } finally {
      setPickingFolder(false);
    }
  };
  const confirmations = usePoll((s) => api.confirmations(undefined, s), 'confirmations', POLL_MS, true);
  const health = usePoll(() => panel.health(), 'health', POLL_MS * 2, true);
  const settings = usePoll((s) => api.settings(s), 'settings', POLL_MS * 10, true);
  const remote = usePoll(() => remoteAdmin.view(), 'remote', POLL_MS * 5, view.view === 'channels');
  // An open console keeps channels alive like a VS Code window (hidden tabs too).
  useEffect(() => startPresence(), []);
  const [account, setAccount] = useState<AccountView | null>(null);
  const loadAccount = useCallback(() => void api.account().then(setAccount, () => undefined), []);
  useEffect(() => {
    loadAccount();
    const t = setInterval(loadAccount, 60_000);
    window.addEventListener('focus', loadAccount);
    return () => {
      clearInterval(t);
      window.removeEventListener('focus', loadAccount);
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

  const openSettings = (section: string = 'overview'): void => setView({ settings: section });
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
    if (k !== 'signout') return openSettings(k === 'settings' ? 'overview' : 'account');
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
    <div className={`${c.app} ${collapsed ? c.collapsed : ''}`}>
      <Sidebar
        sessions={listed}
        projects={projectList}
        pending={pending}
        current={view.session}
        view={view.view}
        channel={{ text: st.text, ok: st.tone === 'ok' }}
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
        onAddProject={() => void addProjectNative()}
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

      <button type="button" className={c.scrim} aria-label="收起侧栏" tabIndex={-1} onClick={() => setCollapsed(true)} />
      <main className={c.main}>
        {!reachable && (
          <div className={c.connection} role="alert">
            <Icon name="alert" size={14} /> 连不上 BlackHole，正在重试…
            <button type="button" className={c.btn} onClick={refreshAll}>
              立即重试
            </button>
          </div>
        )}
        <SubscriptionBanner onRenew={() => openSettings('account')} />
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
              mcpUrl={health.data?.mcp_url ?? null}
            />
          ) : sessions.data ? (
            <NewChatPane
              key={newChat.key}
              initialPath={newChat.path}
              projects={projectList}
              sessions={list}
              actions={actions}
              connectorName={settings.data?.values.connectorName ?? 'BlackHole'}
              mcpUrl={health.data?.mcp_url ?? null}
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
      {addingProject && <AddProjectDialog onClose={() => setAddingProject(false)} onAdded={projects.refresh} />}
      {rotated && <RotatedDialog id={rotated} onClose={() => setRotated(null)} />}
      {view.settings && (
        <SettingsModal
          section={view.settings}
          onSection={(s: SettingsSection) => setView({ settings: s })}
          onClose={() => {
            setView({ settings: null });
            health.refresh();
            settings.refresh();
            loadAccount();
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
