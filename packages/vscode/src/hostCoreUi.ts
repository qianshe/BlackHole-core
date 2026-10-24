import { commands, window, ProgressLocation } from 'vscode';
import type { CoreDownloadInteraction } from './sharedCoreManager';

/** Trusted native host interaction. No browser or project supplies a URL/path. */
export const prepareCoreDownload: CoreDownloadInteraction = async (reference, download) => {
  const mb = (reference.archiveBytes / 1_000_000).toFixed(2);
  const answer = await window.showInformationMessage(
    `首次使用需要准备 BlackHole Core ${reference.runtimeVersion}（${mb} MB）。只下载已固定版本的签名核心代码；使用 VS Code 自带的 Node，不下载 Node，也不打开公网渠道。`,
    { modal: true }, '下载并验证');
  if (answer !== '下载并验证') throw Error('core_download_cancelled');
  return window.withProgress({ title: '准备 BlackHole Core', location: ProgressLocation.Notification, cancellable: true }, async (progress, token) => {
    const controller = new AbortController();
    const subscription = token.onCancellationRequested(() => controller.abort());
    if (token.isCancellationRequested) controller.abort();
    let percent = 0;
    try {
      return await download({ signal: controller.signal, onProgress(bytes, total) {
        const next = Math.floor(bytes * 100 / total);
        progress.report({ message: `${(bytes / 1_000_000).toFixed(2)} / ${(total / 1_000_000).toFixed(2)} MB`, increment: Math.max(0, next - percent) });
        percent = next;
      } });
    } finally { subscription.dispose(); }
  });
};

export function reportHostCoreFailure(error: unknown): void {
  const code = error instanceof Error ? error.message : '';
  if (code === 'daemon_state_unknown') {
    void window.showWarningMessage(
      'BlackHole：无法确认共享 Core 的运行状态，可能保留了旧运行记录，也可能暂时无法连接。可先重试连接；若持续失败，可检查并恢复启动记录。恢复须再次确认，且 Manager 只会在确认原进程已退出、端口已关闭且没有活租约或待恢复维护事务后执行，不会强制结束进程。',
      '重试连接', '检查并恢复启动记录',
    ).then(choice => {
      if (choice === '重试连接') void commands.executeCommand('blackhole.retrySharedCore');
      if (choice === '检查并恢复启动记录') void commands.executeCommand('blackhole.repairCoreStart');
    });
    return;
  }
  if (code === 'bundled_core_update_required') {
    void window.showWarningMessage(
      '已安装的旧 Core 缺少账号修复或仍会将 Web 资源误判为损坏，导致 MCP 工具调用失败；必须安全切换到本插件配套的 Core。旧 0.3.200 仍在运行时选择安全交接；确认旧服务已正常停止后可应用包内 Core。不会继续使用旧 Core 冒充升级成功。',
      '检查并安全切换', '已停止，应用包内 Core',
    ).then(choice => {
      if (choice === '检查并安全切换') void commands.executeCommand('blackhole.handoffLegacyCore');
      if (choice === '已停止，应用包内 Core') void commands.executeCommand('blackhole.activateBundledCoreCold');
    });
    return;
  }
  if (['managed_core_required', 'migration_pending', 'legacy_core_running'].includes(code)) {
    // No silent shutdown or second daemon on the same database. Give the
    // native operator an explicit checked handoff or a same-window retry.
    void window.showWarningMessage(
      '检测到仍在运行的旧版 BlackHole Core，新插件不会自动停止它或接管原数据库。请先完成正在执行的任务；可以检查并确认旧版交接，或在旧 Core 正常退出后重试连接（无需重启 VS Code）。',
      '检查并安全切换', '重试连接',
    ).then(choice => {
      if (choice === '检查并安全切换') void commands.executeCommand('blackhole.handoffLegacyCore');
      if (choice === '重试连接') void commands.executeCommand('blackhole.retrySharedCore');
    });
    return;
  }
  if (/^core_trust_root_missing/.test(code)) {
    // The Core was signed by a trust root this host does not carry yet — an
    // upgrade-order problem, not corruption. Say so instead of the generic
    // "core not ready" fallback.
    void window.showWarningMessage(
      'BlackHole：共享 Core 由本插件尚未携带的测试签名钥匙签发，验证被刻意拒绝（不会带病启动）。请把 BlackHole 插件升级到与 Core 同版本或更高；Desktop 需要一并升级。',
    );
    return;
  }
  const message = code === 'core_download_cancelled' ? 'Core 准备已取消，未启动或更换后台。'
    : /data_root_in_use/.test(code) ? '原数据库仍由其他端口的 Core 持有。请先在原宿主确认状态并正常停止，再执行“BlackHole: Retry Shared Core”；不会强行结束进程。'
    : /platform_unsupported/.test(code) ? '该插件中的 Core 发布配置尚未支持当前宿主系统/架构，不会退回旧后台。'
    : /node_|sqlite/.test(code) ? 'VS Code 的 Node 运行环境不满足此 Core 的要求。请升级 VS Code；BlackHole 不会静默下载 Node。'
    : /download/.test(code) ? 'Core 下载未完成。请检查网络后重载窗口重试；当前后台和数据未被替换。'
    : '共享 Core 尚未就绪。请查看 BlackHole 输出中的具体原因；不会启动另一套后台或数据目录。';
  void window.showWarningMessage(`BlackHole：${message}`);
}
