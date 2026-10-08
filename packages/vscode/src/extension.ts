import { ProcessTerminalController } from './processTerminals';
import path from 'node:path';
import { registerCloudAccount } from './cloudAccount';
import { commands, ConfigurationTarget, ProgressLocation, workspace, window, type ExtensionContext } from 'vscode';
import { ApprovalsWatcher } from './approvals';
import { SharedConfigPanel as ConfigPanel } from './sharedConfigPanel';
import { getConfig } from './config';
import { ControlApi, type SessionInfo } from './controlApi';
import { DaemonManager } from './daemonManager';
import { Poller } from './poller';
import { copySessionUrl, copyTemplateSession, createSession, sessionAction } from './sessionActions';
import { chatSend, chatStop } from './courierChat';
import { SidebarProvider } from './sidebar';
import { StatusBarController } from './statusbar';
import { openWebAgent } from './webAgents';
import { openLocalWeb } from './localWeb';
import { SettingsSync } from './settingsSync';

export function activate(context: ExtensionContext): void {
  const log = window.createOutputChannel('BlackHole');
  const cfg = getConfig;
  const api = new ControlApi(cfg);
  const processTerminals = new ProcessTerminalController(api);
  const daemon = new DaemonManager(context, cfg, api, log);
  const poller = new Poller(() => cfg().pollIntervalMs);
  const sidebar = new SidebarProvider(api, daemon, poller, {
    // 首次引导的渠道卡片：用户点过「稍后」就不再弹出（所有窗口共用）。
    setupDismissed: () => context.globalState?.get<boolean>('blackhole.setupDismissed') === true,
    dismissSetup: (dismissed) => void context.globalState?.update('blackhole.setupDismissed', dismissed || undefined),
    installCloudflared: async () => {
      const c = workspace.getConfiguration('blackhole');
      const result = await api.installRuntime('cloudflared', c.get<string>('cloudflaredPath') ?? '');
      if ((c.get<string>('cloudflaredPath') ?? '') !== result.path) await c.update('cloudflaredPath', result.path, ConfigurationTarget.Global);
    },
    installOpenaiTunnel: async () => {
      const before = workspace.getConfiguration('blackhole').get<string>('openaiTunnelClientPath') ?? '';
      const result = await api.installRuntime('openai', before);
      if (!result.version) throw new Error('tunnel-client 安装结果缺少版本信息；未保存路径。');
      const current = workspace.getConfiguration('blackhole').get<string>('openaiTunnelClientPath') ?? '';
      if (current !== before && current !== result.path) throw new Error('tunnel-client 路径刚在别处发生变化；请重试。');
      if (current !== result.path) await workspace.getConfiguration('blackhole').update('openaiTunnelClientPath', result.path, ConfigurationTarget.Global);
      return { ...result, version: result.version };
    },
    create: () => void createSession(api, daemon, openCreated),
    act: (s, a) => void sessionAction(api, s, a, refresh),
    copyTemplate: (s, kind, message) => void copyTemplateSession(api, s, kind, message),
    chatSend: (s, targetId, text, site) => chatSend(api, s, targetId, text, site),
    chatStop: (s, targetId) => chatStop(api, s, targetId),
      chatCard: async (s, targetId) => {
        try { return await api.courierCard({ sessionId: s.id, ...(targetId ? { targetId } : {}) }); } catch (e) { return { ok: false, message: e instanceof Error ? e.message : String(e) }; }
      },
      chatReload: async (s) => {
        try {
          const r = await api.courierReload(s.id);
          if (r.ok) window.setStatusBarMessage(`BlackHole: ${r.message}`, 4000);
          else void window.showWarningMessage(`BlackHole: 刷新网页失败 — ${r.message}`);
        } catch (e) { void window.showErrorMessage(`BlackHole: 刷新网页失败 — ${e instanceof Error ? e.message : String(e)}`); }
      },
      unpair: async (s) => {
        try { await api.courierUnpair(s.id); } catch (e) { void window.showErrorMessage(`BlackHole: 解除配对失败 — ${e instanceof Error ? e.message : String(e)}`); }
      },
      rename: async (s) => {
        const name = await window.showInputBox({ title: '重命名会话', value: s.name ?? '', prompt: '留空则恢复默认名称', ignoreFocusOut: false });
        if (name === undefined) return;
        try { await api.renameSession(s.id, name); } catch (e) { void window.showErrorMessage(`BlackHole: 重命名失败 — ${e instanceof Error ? e.message : String(e)}`); }
      },
  });
  const refresh = (): void => void sidebar.refresh();
  // A new (draft) session opens straight into its chat page, where the prompts are offered.
  const openCreated = (s?: SessionInfo): void => { if (s) sidebar.showCalls(s); else refresh(); };

  // Channel watchdog feed is independent from the configurable UI poller:
  // it backs off while unfocused and users can raise its interval above the
  // daemon's stale window. Best-effort errors mean a restart; the next fixed
  // heartbeat retries without making channel liveness depend on UI cadence.
  const heartbeat = (): void => void api.heartbeat().catch(() => undefined);
  // This timer is the lease that keeps an explicitly-started public channel
  // alive while this Extension Host exists. Do NOT unref it: an unref'ed timer
  // is not a liveness guarantee when the host is otherwise idle, which allowed
  // the daemon watchdog to tear down a healthy Quick Tunnel after ~45 seconds.
  // VS Code owns the Extension Host lifetime and the subscription below clears
  // the timer on deactivation, so a referenced timer cannot keep VS Code open.
  const heartbeatTimer = setInterval(heartbeat, 10_000);
  const settingsSync = new SettingsSync(api, log);
  heartbeat();

  const statusBar = new StatusBarController(daemon, api, poller, (daemonId) => {
    // A real health identity also detects replacements made by other windows.
    // Repeated 'running' events must not repeatedly verify the Cloud account.
    void commands.executeCommand('blackhole.accountSnapshot', { daemonId }).then(undefined, () => {
      log.appendLine('warning: account recovery notification failed; use Refresh Subscription');
    });
  });
  context.subscriptions.push(
    registerCloudAccount(context, view => { statusBar.updateAccount(view); sidebar.updateAccount(view); }, api),
    log,
    daemon,
    poller,
    { dispose: () => clearInterval(heartbeatTimer) },
    sidebar,
    statusBar,
    new ApprovalsWatcher(api, poller, (id) => sidebar.projectName(id) ?? id, () => sidebar.visible),
    window.registerWebviewViewProvider(SidebarProvider.viewId, sidebar, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    commands.registerCommand('blackhole.createSession', () => void createSession(api, daemon, openCreated)),
    commands.registerCommand('blackhole.refreshSessions', refresh),
    processTerminals,
    commands.registerCommand('blackhole.showProcesses', () => processTerminals.show()),
    commands.registerCommand('blackhole.stopProcess', () => processTerminals.stopSelected()),
    commands.registerCommand('blackhole.stopAndCloseProcess', () => processTerminals.stopAndCloseSelected()),
    commands.registerCommand('blackhole.openSettings', (route?: unknown) => ConfigPanel.open(api, daemon, poller, settingsSync, context.globalState, route, context.extensionUri)),
    commands.registerCommand('blackhole.openSession', (s?: SessionInfo) => void withSession(api, s, (x) => sidebar.showCalls(x))),
    commands.registerCommand('blackhole.pauseSession', (s?: SessionInfo) =>
      void withSession(api, s, (x) => sessionAction(api, x, 'pause', refresh)),
    ),
    commands.registerCommand('blackhole.resumeSession', (s?: SessionInfo) =>
      void withSession(api, s, (x) => sessionAction(api, x, 'resume', refresh)),
    ),
    commands.registerCommand('blackhole.revokeSession', (s?: SessionInfo) =>
      void withSession(api, s, (x) => sessionAction(api, x, 'revoke', refresh)),
    ),
    commands.registerCommand('blackhole.rotateSession', (s?: SessionInfo) =>
      void withSession(api, s, (x) => sessionAction(api, x, 'rotate', refresh)),
    ),
    commands.registerCommand('blackhole.copySessionUrl', (s?: SessionInfo) =>
      void withSession(api, s, (x) => copySessionUrl(api, x)),
    ),
    commands.registerCommand('blackhole.stopDaemon', () => {
      void window
        .withProgress({ location: ProgressLocation.Notification, title: 'BlackHole: 正在停止 daemon' }, () => daemon.stop())
        .then((ok) => {
          refresh();
          if (!ok) void window.showErrorMessage('BlackHole: daemon 停止失败，详见输出面板');
        });
    }),
    commands.registerCommand('blackhole.restartDaemon', () => {
      void window
        .withProgress({ location: ProgressLocation.Notification, title: 'BlackHole: 正在重启 daemon' }, () => daemon.restart())
        .then((ok) => {
          refresh();
          if (!ok) void window.showErrorMessage('BlackHole: daemon 重启失败，详见输出面板');
        });
    }),
    commands.registerCommand('blackhole.openWebAgent', () => void openWebAgent()),
    commands.registerCommand('blackhole.openLocalWeb', () => void openLocalWeb(api, daemon, () => cfg().port)),
    settingsSync,
  );

  // The daemon is detached and outlives windows, so config edits and new
  // extension versions would otherwise never reach it until someone remembers
  // the restart button. Debounce bursts of setting writes, then let the
  // manager restart the daemon when its start fingerprint went stale.
  let cfgTimer: NodeJS.Timeout | undefined;
  context.subscriptions.push(
    workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('blackhole') && !e.affectsConfiguration('terminal.integrated.defaultProfile') && !e.affectsConfiguration('terminal.integrated.profiles')) return;
      if (cfgTimer) clearTimeout(cfgTimer);
      cfgTimer = setTimeout(() => void daemon.syncConfigRestart().then(refresh), 800);
    }),
  );

  // UI polling must survive an unsuccessful first startup: the daemon can
  // recover later (restart, config sync or another window). Readers already
  // tolerate an unavailable daemon; keep one poller for the extension lifetime.
  poller.start();
  processTerminals.start();
  void daemon.ensureRunning().then((ok) => {
    if (ok) {
      // Mirror daemon-owned settings first; a changed value then flows through the restart fingerprint.
      void settingsSync.sync().then(() => daemon.syncConfigRestart(true)).then(refresh);
    }
    refresh();
  });
}

async function withSession(
  api: ControlApi,
  s: SessionInfo | undefined,
  fn: (s: SessionInfo) => void | Promise<void>,
): Promise<void> {
  if (s) {
    await fn(s);
    return;
  }
  const picked = await pickSession(api);
  if (picked) await fn(picked);
}

/** Palette entry point without an argument: let the user pick a session. */
async function pickSession(api: ControlApi): Promise<SessionInfo | undefined> {
  try {
    const { sessions } = await api.listSessions();
    const live = sessions.filter((x) => x.status !== 'revoked' && x.status !== 'archived');
    if (live.length === 0) {
      window.setStatusBarMessage('BlackHole: 当前没有会话', 3000);
      return undefined;
    }
    const pick = await window.showQuickPick(
      live.map((x) => ({ label: x.name?.trim() || path.basename(x.workspace_path), description: `${x.status} · ${x.id}`, session: x })),
      { placeHolder: '选择会话' },
    );
    return pick?.session;
  } catch {
    return undefined;
  }
}

export function deactivate(): void {
  /* the daemon is detached on purpose — the daemon's heartbeat watchdog
     closes the public channel by itself once every window is gone */
}
