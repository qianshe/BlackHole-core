import { window, type Disposable } from 'vscode';
import type { ApprovalScope, ControlApi, ConfirmationInfo } from './controlApi';
import type { Poller } from './poller';

const preview = (c: ConfirmationInfo): string => {
  try {
    const a = JSON.parse(c.args_json) as { command?: string };
    if (typeof a.command === 'string') {
      return a.command.length > 300 ? a.command.slice(0, 300) + '…' : a.command;
    }
  } catch {
    /* fall through */
  }
  return c.args_json.slice(0, 300);
};

/** The IRREVERSIBLE patterns that may never earn an 'always' grant. */
const CRITICAL_RE =
  /\b(rm|rmdir|del|rd|erase|shred|dd|mkfs|format|drop\s+(table|database)|sudo|runas|remove-item|clear-content)\b/i;

/** True when the command hits a critical (irreversible) risk pattern. */
const isCritical = (c: ConfirmationInfo): boolean => CRITICAL_RE.test(preview(c));

/** Buttons in decision order; labels spell out exactly what each one remembers. */
const CHOICES: { label: string; scope?: ApprovalScope }[] = [
  { label: '批准一次', scope: 'once' },
  { label: '本会话批准', scope: 'session' },
  { label: '始终批准', scope: 'always' },
  { label: '拒绝' },
];

/**
 * Same as CHOICES minus the 'always' option, for critical-pattern commands:
 * an irreversible operation's no-ask window must not outlive the daemon
 * process (a stray "always" on rm/sudo would be a standing hazard).
 */
const CHOICES_NO_ALWAYS: { label: string; scope?: ApprovalScope }[] = [
  { label: '批准一次', scope: 'once' },
  { label: '本会话批准', scope: 'session' },
  { label: '拒绝' },
];

/**
 * Polls pending confirmations. The sidebar renders every pending approval as
 * an in-product banner styled like the inline approval box — under the call
 * card when that session's feed is open, as a bottom strip otherwise. The
 * native notification here is only the fallback for when the sidebar webview
 * is not visible (including a retained but hidden view).
 */
export class ApprovalsWatcher implements Disposable {
  private readonly seen = new Set<string>();
  private pollSub: Disposable | undefined;
  private n = 0;
  private disposed = false;
  private polling = false;

  constructor(
    private readonly api: ControlApi,
    poller: Poller,
    private readonly projectName: (sessionId: string) => string,
    private readonly canSurfaceInline: () => boolean,
  ) {
    // 原生通知只是兜底（侧边栏不可见时）：降频到 ~5s 一查，审批的首选提示
    // 是侧边栏内联横幅（变更门控即时刷新）
    this.pollSub = poller.onTick(() => {
      if (++this.n % 5 !== 0) return;
      void this.tick();
    });
  }

  private async tick(): Promise<void> {
    if (this.disposed || this.polling) return;
    this.polling = true;
    try {
      const pending = (await this.api.confirmations()).confirmations.filter((c) => c.status === 'pending');
      if (this.disposed || this.canSurfaceInline()) return;
      for (const c of pending) {
        if (this.seen.has(c.id)) continue;
        // Only consume the fallback notification when it is actually attempted.
        // An inline-only request remains eligible if the sidebar is later hidden.
        this.seen.add(c.id);
        void this.notify(c).catch(() => this.seen.delete(c.id));
      }
    } catch {
      // Transient polling failures must not consume any notification.
    } finally {
      this.polling = false;
    }
  }

  private async notify(c: ConfirmationInfo): Promise<void> {
    if (this.disposed) return;
    const project = this.projectName(c.session_id);
    // Plain multi-line text: showInformationMessage takes plain strings only
    // (MarkdownString is not an accepted message type), and the command stays
    // readable on its own line with the scope semantics spelled out.
    // critical commands lose the 'always' option entirely — the daemon would
    // downgrade it anyway; hiding it upfront keeps the choice honest.
    const critical = isCritical(c);
    const choices = critical ? CHOICES_NO_ALWAYS : CHOICES;
    const message =
      `BlackHole 审批请求${project ? `（${project}）` : ''}\n${preview(c)}\n`
      + (critical
        ? '批准范围 — 批准一次：仅本次；本会话批准：该会话同类操作不再询问（不可逆操作不提供“始终”）'
        : '批准范围 — 批准一次：仅本次；本会话批准：该会话同类操作不再询问；始终批准：所有会话不再询问（持久保存，可在状态栏一键清除）');
    const choice = await window.showInformationMessage(message, { modal: false }, ...choices.map((x) => x.label));
    const picked = choices.find((x) => x.label === choice);
    if (!picked || this.disposed) return; // dismissed — open the sidebar to resolve it
    try {
      await this.api.resolveConfirmation(c.id, picked.scope ? 'approve' : 'deny', picked.scope);
    } catch (e) {
      void window.showErrorMessage(`BlackHole: 审批操作失败 — ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.pollSub?.dispose();
  }
}
