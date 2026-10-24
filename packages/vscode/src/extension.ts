import { registerManagedMaintenance } from './managedMaintenanceUi';
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
import { BundledCoreUpdateCoordinator } from './bundledCoreUpdateCoordinator';
import { openWebAgent } from './webAgents';
import { openLocalWeb } from './localWeb';
import { SettingsSync } from './settingsSync';
import { SharedCoreManager } from './sharedCoreManager';
import { prepareCoreDownload, reportHostCoreFailure } from './hostCoreUi';
import { stopLegacyForHandoff } from './legacyCoreHandoff';
import { prepareManagedCloudflared } from './prepareManagedCloudflared';
import { maintenanceRefusalMessage } from './managedMaintenanceMessage';

let activeSharedCore: SharedCoreManager | undefined;
const BRIDGE_STATE_KEY = 'blackhole.sharedCoreBridge.v1';
type BridgeState = { status: 'staged' | 'ready_to_activate' | 'active'; versionName: string };

export function activate(context: ExtensionContext): void {
  const log = window.createOutputChannel('BlackHole');
  const cfg = getConfig;
  const api = new ControlApi(cfg);
  const processTerminals = new ProcessTerminalController(api);
  const daemon = new DaemonManager(context, cfg, api, log);
  const sharedCore = new SharedCoreManager(context, log, prepareCoreDownload);
  activeSharedCore = sharedCore;
  if (sharedCore.enabled) daemon.pauseForBridge();
  const poller = new Poller(() => cfg().pollIntervalMs);
  const sidebar = new SidebarProvider(api, daemon, poller, {
    // 首次引导的渠道卡片：用户点过「稍后」就不再弹出（所有窗口共用）。
    setupDismissed: () => context.globalState?.get<boolean>('blackhole.setupDismissed') === true,
    dismissSetup: (dismissed) => void context.globalState?.update('blackhole.setupDismissed', dismissed || undefined),
    installCloudflared: async () => {
      if (daemon.isManagedCore) return prepareManagedCloudflared(api);
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
  // Private continuation of a native confirmation. It is deliberately NOT a
  // command accepting `confirmed: true` from a Web page or another caller.
  const finishBundledCoreSwitch = async (approvedPort: number): Promise<boolean> => {
    try {
      if (cfg().port !== approvedPort) throw Error('endpoint_changed');
      const previous = await sharedCore.inspectStart();
      if (previous) {
        const answer = await window.showWarningMessage(
          '旧共享 Core 保留了运行记录。只有 Manager 确认原进程已退出、端口已关闭、没有活租约和未解决事务时才允许恢复；不会删除会话或强杀仍在运行的 Core。',
          { modal: true }, '确认检查并恢复旧运行记录');
        if (answer !== '确认检查并恢复旧运行记录') return false;
        if (cfg().port !== approvedPort) throw Error('endpoint_changed');
        await sharedCore.recoverStart(previous);
      }
      const versionName = await sharedCore.activateBundledCoreCold(approvedPort);
      log.appendLine('Verified bundled Core selected for cold startup: ' + versionName);
      // The initial extension activation may still be finishing an attempt
      // against the old selected Core. Joining it once and issuing a fresh
      // attach avoids reusing its stale failure without creating a second Core.
      const ok = await daemon.attachAfterVerifiedColdSelection();
      if (ok) {
        await settingsSync.sync(); refresh();
        void window.showInformationMessage('BlackHole：已启动新的共享 Core，当前窗口无需重载。');
      }
      return ok;
    } catch (error) {
      const raw = error instanceof Error ? error.message : '';
      const code = /^[a-z][a-z0-9_]*$/.test(raw) ? raw : 'outcome_unknown';
      log.appendLine('Bundled Core cold selection refused: ' + code);
      const next = code === 'daemon_state_unknown' ? '检测到旧 Core 运行记录；请先在原生宿主检查并恢复旧记录，确认端口已经关闭。'
        : code === 'migration_pending' ? '端口仍由另一个 Core 占用；先从原宿主正常退出再切换。'
        : 'Core 冷切换未完成（' + code + '）。未强制停止旧进程或清除数据。';
      void window.showWarningMessage('BlackHole：' + next);
      return false;
    }
  };
  // Normal bundled updates finish in the startup handshake. Only a busy
  // startup needs this automatic continuation; it never asks the user to
  // approve installing the same Core a second time.
  const bundledUpdate = new BundledCoreUpdateCoordinator(
    sharedCore, daemon, api, () => cfg().port, log,
    async () => { daemon.managedLeaseRebound(); await settingsSync.sync(); refresh(); },
  );

  context.subscriptions.push(...registerManagedMaintenance(sharedCore, daemon, api, settingsSync));
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
    sharedCore,
    poller,
    { dispose: () => clearInterval(heartbeatTimer) },
    sidebar,
    statusBar,
    bundledUpdate,
    new ApprovalsWatcher(api, poller, (id) => sidebar.projectName(id) ?? id, () => sidebar.visible),
    window.registerWebviewViewProvider(SidebarProvider.viewId, sidebar, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    commands.registerCommand('blackhole.createSession', () => void createSession(api, daemon, openCreated)),
    commands.registerCommand('blackhole.refreshSessions', refresh),
    commands.registerCommand('blackhole.retrySharedCore', async () => {
      if (!sharedCore.hostProvided) return false;
      const ok = await daemon.ensureRunning();
      if (ok) {
        heartbeat();
        await settingsSync.sync();
        refresh();
        void window.showInformationMessage('BlackHole：已验证并连接共享 Core，无需重启 VS Code。');
      }
      return ok;
    }),
    commands.registerCommand('blackhole.applyBundledCoreUpdate', () => bundledUpdate.request()),
    commands.registerCommand('blackhole.handoffLegacyCore', async () => {
      if (!sharedCore.hostProvided) return false;
      try {
        const port = cfg().port;
        const stopped = await stopLegacyForHandoff(api, port, path.join(sharedCore.dataRoot, 'blackhole.db'), async () =>
          (await window.showWarningMessage(
            '确认停止旧版 0.3.200，并验签选择、启动本插件配套的共享 Core？程序会重新检查原数据库、旧实例身份、运行任务和待审批事项。只有空闲且旧实例确认停止后才继续；不会强杀、另建数据库或重试不明确的结果。正常切换只确认这一次；异常历史记录需要另行确认恢复。',
            { modal: true }, '确认安全切换')) === '确认安全切换');
        if (!stopped) return false;
        // The common continuation handles any stale signed running record,
        // with a separate native recovery consent only for that abnormal case.
        // The first native dialog explicitly covered stop + verified cold
        // selection + startup. Continue privately, without a third dialog.
        // All Manager validation/locks/CAS checks still execute normally.
        return finishBundledCoreSwitch(port);
      } catch (error) {
        const code = error instanceof Error ? error.message : 'legacy_handoff_failed';
        log.appendLine(`Legacy Core handoff refused: ${/^[a-z][a-z0-9_]*$/.test(code) ? code : 'unknown'}`);
        const message = code === 'active_work'
          ? '仍有任务或待审批工作，已保留原 0.3.200 Core。请完成工作后手动重试。'
          : code === 'legacy_core_identity_changed' ? '确认期间旧 Core 身份变化，已取消切换。'
          : code === 'legacy_stop_unconfirmed' ? '旧 Core 退出结果未获确认，请先检查服务状态，不要重复执行停止。'
          : '旧版安全交接未完成（' + (/^[a-z][a-z0-9_]*$/.test(code) ? code : '状态不明') + '）。未强制停止、清理数据库或启动第二套后台。';
        void window.showWarningMessage('BlackHole：' + message);
        return false;
      }
    }),
    commands.registerCommand('blackhole.activateBundledCoreCold', async () => {
      if (!sharedCore.hostProvided) return false;
      const approvedPort = cfg().port;
      const accepted = await window.showWarningMessage(
        '将切换到本 VSIX 内已签名的 Core 业务代码。仅允许在目标端口没有监听、旧 Core 已确认退出、没有活租约或未解决事务时继续。Manager 会重新验签并检查版本、数据协议兼容性；失败时不会强杀或自动回退启动。',
        { modal: true }, '确认冷切换');
      if (accepted !== '确认冷切换') return false;
      return finishBundledCoreSwitch(approvedPort);
    }),
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
    commands.registerCommand('blackhole.stopDaemon', async () => {
      const managed = daemon.isManagedCore, target = daemon.managedCoreTarget;
      if (managed) {
        const answer = await window.showWarningMessage('确认停止共享 Core？其他窗口、Desktop、Web/Courier 连接、运行任务或待审批工作会阻止此操作。不会强制结束进程；停止后数据和 Core 文件保留，可再次启动。', { modal: true }, '确认停止');
        if (answer !== '确认停止') return false;
      }
      const ok = await window.withProgress({ location: ProgressLocation.Notification, title: 'BlackHole: 正在停止 Core' },
        () => managed ? daemon.maintainSharedCore('stop', true, target) : daemon.stop());
      refresh();
      if (!ok) { const refusal = managed ? maintenanceRefusalMessage(daemon.maintenanceRefusal) : undefined;
        if (refusal) void window.showWarningMessage('BlackHole：' + refusal);
        else void window.showErrorMessage(managed ? 'BlackHole: 停止未获确认，请查看输出。结果不明时不要重复操作；保留运行记录并按事务 ID 检查恢复。' : 'BlackHole: daemon 停止失败，详见输出面板');
      }
      return ok;
    }),
    commands.registerCommand('blackhole.restartDaemon', async () => {
      const managed = daemon.isManagedCore, target = daemon.managedCoreTarget;
      let settingsRevision: number | undefined;
      if (managed) {
        try { await settingsSync.flush(); settingsRevision = (await api.settings()).revision; } catch { void window.showErrorMessage('BlackHole: 无法核对共享配置版本，未发起重启。'); return false; }
        const answer = await window.showWarningMessage('确认重启共享 Core？其他窗口、Desktop、Web/Courier 连接、运行任务或待审批工作会阻止此操作。不会强制结束进程；重启不会切换 Core 版本或应用当前窗口的启动参数。', { modal: true }, '确认重启');
        if (answer !== '确认重启') return false;
      }
      const ok = await window.withProgress({ location: ProgressLocation.Notification, title: 'BlackHole: 正在重启 Core' },
        () => managed ? daemon.maintainSharedCore('restart', true, target, settingsRevision) : daemon.restart());
      refresh();
      if (!ok) { const refusal = managed ? maintenanceRefusalMessage(daemon.maintenanceRefusal) : undefined;
        if (refusal) void window.showWarningMessage('BlackHole：' + refusal);
        else void window.showErrorMessage(managed ? 'BlackHole: 重启未获确认，请查看输出。结果不明时不要重复操作；保留运行记录并按事务 ID 检查恢复。' : 'BlackHole: daemon 重启失败，详见输出面板');
      }
      return ok;
    }),
    commands.registerCommand('blackhole.repairCoreStart', async () => {
      try {
        const record = await sharedCore.inspectStart();
        if (!record) { void window.showInformationMessage('BlackHole: 没有待恢复的 Shared Core 启动记录。'); return; }
        const answer = await window.showWarningMessage('仅在确认没有正在进行的工作时恢复 Shared Core。Manager 会拒绝活进程、活租约或不明确的状态，不会强制结束进程。', { modal: true }, '检查并恢复');
        if (answer !== '检查并恢复') return;
        await daemon.releaseManagedClientForRecovery();
        try {
          await sharedCore.recoverStart(record);
        } finally {
          if (sharedCore.enabled) {
            daemon.useCoreManager(sharedCore.createSession((reason) => daemon.managedLeaseLost(reason), () => daemon.managedLeaseRebound()));
          }
        }
        if (sharedCore.enabled && await daemon.ensureRunning()) {
          await settingsSync.sync();
          refresh();
          void window.showInformationMessage('BlackHole: 启动记录已恢复并已重新连接共享 Core。');
          return;
        }
        refresh();
        void window.showInformationMessage('BlackHole: 启动记录已恢复，未启动 Core。需要使用时请手动重载窗口。');
      } catch { void window.showErrorMessage('BlackHole: Shared Core 恢复未获确认。未强制结束任何进程，请查看隔离验收步骤。'); }
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
      if (!e.affectsConfiguration('blackhole') && (daemon.isManagedCore || (!e.affectsConfiguration('terminal.integrated.defaultProfile') && !e.affectsConfiguration('terminal.integrated.profiles')))) return;
      if (cfgTimer) clearTimeout(cfgTimer);
      cfgTimer = setTimeout(() => void daemon.syncConfigRestart().then(refresh), 800);
    }),
  );

  // UI polling must survive an unsuccessful first startup: the daemon can
  // recover later (restart, config sync or another window). Readers already
  // tolerate an unavailable daemon; keep one poller for the extension lifetime.
  poller.start();
  processTerminals.start();
  // The bridge stages first, then requires an explicit cold cutover. The old
  // daemon is confirmed stopped before a reload records permission to activate.
  void (async () => {
    if (!sharedCore.enabled) {
      if (await daemon.ensureRunning()) { await settingsSync.sync(); await daemon.syncConfigRestart(true); }
      refresh();
      return;
    }
    if (sharedCore.hostProvided) {
      // Runtime-neutral packages never execute extension-local daemon assets or
      // stop the old 200 process as an implicit side effect of activation.
      daemon.useCoreManager(sharedCore.createSession((reason) => daemon.managedLeaseLost(reason), () => daemon.managedLeaseRebound()));
      if (await daemon.ensureRunning()) { heartbeat(); await settingsSync.sync(); }
      bundledUpdate.start();
      refresh();
      return;
    }
    let state = context.globalState.get<BridgeState>(BRIDGE_STATE_KEY);
    // Desktop-first and persisted managed clients must never enter legacy Stop.
    const running = await sharedCore.inspectStart();
    if (state?.status === 'active' || running) {
      daemon.useCoreManager(sharedCore.createSession((reason) => daemon.managedLeaseLost(reason), () => daemon.managedLeaseRebound()));
      if (await daemon.ensureRunning()) await settingsSync.sync();
      refresh();
      return;
    }
    const listener = await api.health().catch(() => undefined);
    if (state?.status !== 'ready_to_activate' && (!listener || listener.lifecycle_state === 'managed')) {
      daemon.useCoreManager(sharedCore.createSession((reason) => daemon.managedLeaseLost(reason), () => daemon.managedLeaseRebound()));
      if (await daemon.ensureRunning()) await settingsSync.sync();
      refresh();
      return;
    }
    const staged = await sharedCore.prepareBridge();
    const versionName = `${staged.runtimeVersion.replace(/[^A-Za-z0-9._-]/g, '_')}-${staged.buildId.replace(/[^A-Za-z0-9._-]/g, '_')}`;
    if (!state || state.versionName !== versionName) {
      state = { status: 'staged', versionName }; await context.globalState.update(BRIDGE_STATE_KEY, state);
    }
    if (state.status === 'staged') {
      const action = await window.showInformationMessage('BlackHole Shared Core 已验证并准备就绪。切换会先停止旧 daemon，然后重新加载窗口。', '切换并重新加载', '稍后');
      if (action === '切换并重新加载') {
        daemon.allowLegacyStartup();
        const stopped = await daemon.stop();
        daemon.pauseForBridge();
        if (!stopped) throw new Error('legacy_daemon_stop_unconfirmed');
        await context.globalState.update(BRIDGE_STATE_KEY, { status: 'ready_to_activate', versionName } satisfies BridgeState);
        await commands.executeCommand('workbench.action.reloadWindow');
        return;
      }
    }
    state = context.globalState.get<BridgeState>(BRIDGE_STATE_KEY);
    if (state?.status === 'ready_to_activate') {
      await sharedCore.activate(state.versionName, cfg().port);
      await context.globalState.update(BRIDGE_STATE_KEY, { status: 'active', versionName: state.versionName } satisfies BridgeState);
      state = { status: 'active', versionName: state.versionName };
    }
    if (state?.status === 'active') {
      daemon.useCoreManager(sharedCore.createSession((reason) => daemon.managedLeaseLost(reason), () => daemon.managedLeaseRebound()));
    } else {
      // Explicit deferral keeps only the old chain; managed listeners are guarded.
      daemon.allowLegacyStartup();
    }
    const ok = await daemon.ensureRunning();
    if (ok) { await settingsSync.sync(); await daemon.syncConfigRestart(true); }
    refresh();
  })().catch((error: unknown) => {
    log.appendLine(`Shared Core bridge failed closed: ${error instanceof Error ? error.message : String(error)}`);
    if (sharedCore.hostProvided) reportHostCoreFailure(error);
    // An unreadable Manager state is unknown, not permission for legacy spawn.
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

export async function deactivate(): Promise<void> {
  const shared = activeSharedCore;
  activeSharedCore = undefined;
  await shared?.close().catch(() => {}); // bounded transport; expiry handles forced host termination
}
