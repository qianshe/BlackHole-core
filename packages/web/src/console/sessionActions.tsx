// Session actions shared by the session header menu and the sidebar row menu,
// so both places behave (and confirm) the same way.
import { useMemo } from 'react';
import { api, panel, type PermissionMode, type SessionView } from '../api';
import { renderPrompt } from '../../../vscode/src/templates';
import { PERMISSION_LABEL, sessionTitle } from '../format';
import { copyText, failText, type ConfirmSpec, type ToastFn } from './common';
import c from './console.module.css';

export interface SessionActions {
  pauseResume: (s: SessionView, action: 'pause' | 'resume') => Promise<void>;
  copyConnection: () => Promise<void>;
  copyPrompt: (s: SessionView, kind: 'connector' | 'sandbox', goal?: string | null) => Promise<void>;
  rotate: (s: SessionView) => void;
  setMode: (s: SessionView, mode: PermissionMode) => void;
  revoke: (s: SessionView) => void;
}

interface Deps {
  toast: ToastFn;
  confirm: (spec: ConfirmSpec) => void;
  onChanged: () => void;
  onRotated: (sessionId: string) => void;
  connectorName: string;
  mcpUrl: string | null;
}

export const MODES: ReadonlyArray<readonly [PermissionMode, string]> = [
  ['read-only', '只读'],
  ['workspace-write', '可写工作区'],
  ['danger-full-access', '完全访问'],
];

export function useSessionActions({ toast, confirm, onChanged, onRotated, connectorName, mcpUrl }: Deps): SessionActions {
  return useMemo<SessionActions>(() => {
    const url = async (): Promise<string | null> => mcpUrl ?? (await panel.health().then((h) => h.mcp_url, () => null));
    return {
      pauseResume: (s, action) =>
        api.sessionAction(s.id, action).then(
          () => {
            toast(action === 'pause' ? '会话已暂停，AI 暂时无法调用工具' : '会话已恢复');
            onChanged();
          },
          (e: unknown) => toast(failText(e), 'bad'),
        ),
      copyConnection: async () => {
        const u = await url();
        if (!u) return toast('还没有可用的连接地址', 'warn');
        const ok = await copyText(u);
        toast(ok ? '连接地址已复制' : '复制失败，请手动复制', ok ? 'ok' : 'bad');
      },
      copyPrompt: async (s, kind, goal) => {
        try {
          const [cred, u, g] = await Promise.all([
            api.sessionCredential(s.id),
            url(),
            goal !== undefined ? Promise.resolve(goal) : api.todos(s.id).then((t) => t.contract?.goal ?? null, () => null),
          ]);
          if (!u) return toast('还没有可用的连接地址', 'warn');
          const ok = await copyText(renderPrompt(kind, u, cred.session_id, g, connectorName));
          toast(ok ? (kind === 'connector' ? '连接器提示词已复制，发给 AI 即可开始' : '沙箱提示词已复制，发给 AI 即可开始') : '复制失败', ok ? 'ok' : 'bad');
        } catch (e) {
          toast(failText(e), 'bad');
        }
      },
      rotate: (s) =>
        confirm({
          title: '重置会话 ID',
          body: '旧 ID 会立即失效，会话内容保留。之后需要把新的提示词发给 AI。',
          action: '重置',
          run: async () => {
            const r = (await api.sessionAction(s.id, 'rotate')) as { session_id?: string };
            onChanged();
            if (r.session_id) onRotated(r.session_id);
          },
        }),
      setMode: (s, mode) => {
        if (s.permission_mode === mode) return;
        const run = async (): Promise<void> => {
          await api.setSessionMode(s.id, mode);
          toast(`已切换为${PERMISSION_LABEL[mode]}`);
          onChanged();
        };
        if (mode !== 'danger-full-access') {
          void run().catch((e) => toast(failText(e), 'bad'));
          return;
        }
        confirm({
          title: '启用完全访问',
          body: '完全访问会允许该会话在本机工作区外写入并执行高风险命令，且不再进行常规命令审批。仅对完全信任的 Agent 使用。',
          action: '启用完全访问',
          danger: true,
          run,
        });
      },
      revoke: (s) =>
        confirm({
          title: '终止会话',
          body: `终止「${sessionTitle(s)}」后，AI 无法再用它调用工具，正在运行的命令会被停止。此操作不能撤销。`,
          action: '终止会话',
          danger: true,
          run: async () => {
            await api.sessionAction(s.id, 'revoke');
            toast('会话已终止');
            onChanged();
          },
        }),
    };
  }, [toast, confirm, onChanged, onRotated, connectorName, mcpUrl]);
}

/** Menu body for one session. `withPause` adds pause/resume (the header already has a button for it). */
export function SessionMenuItems({ s, actions, pick, withPause, goal }: { s: SessionView; actions: SessionActions; pick: (fn: () => void) => () => void; withPause?: boolean; goal?: string | null }) {
  const ended = s.status === 'revoked' || s.status === 'archived';
  return (
    <>
      {withPause && !ended && (
        <button type="button" role="menuitem" className={c.menuItem} onClick={pick(() => void actions.pauseResume(s, s.status === 'paused' ? 'resume' : 'pause'))}>
          {s.status === 'paused' ? '恢复会话' : '暂停会话'}
        </button>
      )}
      <button type="button" role="menuitem" className={c.menuItem} disabled={ended} onClick={pick(() => void actions.copyPrompt(s, 'connector', goal))}>
        复制连接器提示词
      </button>
      <button type="button" role="menuitem" className={c.menuItem} disabled={ended} onClick={pick(() => void actions.copyPrompt(s, 'sandbox', goal))}>
        复制沙箱提示词
      </button>
      <button type="button" role="menuitem" className={c.menuItem} disabled={ended} onClick={pick(() => actions.rotate(s))}>
        重置会话 ID
      </button>
      <div className={c.menuSep} role="separator" />
      <div className={c.menuGroupLabel} aria-hidden="true">
        权限
      </div>
      {MODES.map(([mode, label]) => (
        <button key={mode} type="button" role="menuitemradio" aria-checked={s.permission_mode === mode} className={c.menuItem} disabled={ended} onClick={pick(() => actions.setMode(s, mode))}>
          <span>{label}</span>
          {s.permission_mode === mode && <span aria-hidden="true">✓</span>}
        </button>
      ))}
      <div className={c.menuSep} role="separator" />
      <button type="button" role="menuitem" className={c.menuDanger} disabled={ended} onClick={pick(() => actions.revoke(s))}>
        终止会话
      </button>
    </>
  );
}
