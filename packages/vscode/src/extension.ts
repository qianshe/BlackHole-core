import { ProcessTerminalController } from './processTerminals';
import path from 'node:path';
import { registerCloudAccount } from './cloudAccount';
import { commands, ProgressLocation, workspace, window, type ExtensionContext } from 'vscode';
import { ApprovalsWatcher } from './approvals';
import { ConfigPanel } from './configPanel';
import { getConfig } from './config';
import { ControlApi, type SessionInfo } from './controlApi';
import { DaemonManager } from './daemonManager';
import { Poller } from './poller';
import { copySessionUrl, copyTemplateSession, createSession, sessionAction } from './sessionActions';
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
    create: () => void createSession(api, daemon, refresh),
    act: (s, a) => void sessionAction(api, s, a, refresh),
    copyTemplate: (s, kind) => void copyTemplateSession(api, s, kind),
  });
  const refresh = (): void => void sidebar.refresh();

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
    registerCloudAccount(context, view => statusBar.updateAccount(view), api),
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
    commands.registerCommand('blackhole.createSession', () => void createSession(api, daemon, refresh)),
    commands.registerCommand('blackhole.refreshSessions', refresh),
    processTerminals,
    commands.registerCommand('blackhole.showProcesses', () => processTerminals.show()),
    commands.registerCommand('blackhole.stopProcess', () => processTerminals.stopSelected()),
    commands.registerCommand('blackhole.stopAndCloseProcess', () => processTerminals.stopAndCloseSelected()),
    commands.registerCommand('blackhole.openSettings', () => ConfigPanel.open(api, daemon, poller)),
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
