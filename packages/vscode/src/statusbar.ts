import { MarkdownString, StatusBarAlignment, ThemeColor, window, type Disposable, type StatusBarItem } from 'vscode';
import type { AuthView } from './cloudAuthClient';
import type { ControlApi } from './controlApi';
import type { DaemonManager } from './daemonManager';
import type { Poller } from './poller';

/**
 * Bottom-right status icon. The channel is the operator-facing state, so the
 * icon tracks it (daemon errors still take over); clicking opens the settings
 * page, where the channel is started and stopped.
 */
export class StatusBarController implements Disposable {
  private readonly item: StatusBarItem = window.createStatusBarItem(StatusBarAlignment.Right, 90);
  private readonly tick: Disposable;
  private readonly stateSubscription: Disposable;
  private disposed = false;
  /** OpenAI Secure MCP Tunnel summary appended to the Cloudflare text (plan §5): both channels are independent. */
  private channelExtra: { text: string; tip: string } | null = null;
  private healthRevision = 0;
  private healthPending?: Promise<void>;
  private observedDaemonId?: string;
  private health: Awaited<ReturnType<ControlApi['health']>> | null = null;
  private healthFailures = 0;
  /** Last tooltip value written — the write-through gate for flicker-free polling. */
  private lastTooltip?: string;
  private account: AuthView = { state: 'logged_out' };

  updateAccount(view: AuthView): void { this.account = view; this.render(); }

  private accountLabel(): string {
    if (this.account.state === 'logged_out') return '未登录';
    if (this.account.state === 'unavailable') return '校验不可用';
    if (!this.account.account) return '待验证';
    if (this.account.account.status !== 'active') return '权益不可用';
    return Math.max(0, this.account.remainingSeconds ?? 0) > 0 ? '' : '已到期';
  }

  private remainingLabel(): string | null {
    if (!['verified', 'saved'].includes(this.account.state) || !this.account.account || this.account.account.status !== 'active') return null;
    const seconds = Math.max(0, this.account.remainingSeconds ?? 0);
    if (seconds <= 0) return '已到期';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 1) return '剩余不足1分钟';
    if (minutes < 10) return `剩余${minutes}分钟`;
    if (minutes < 120) {
      const bucket = Math.floor(minutes / 10) * 10;
      return bucket < 60 ? `剩余${bucket}分钟` : `剩余${Math.floor(bucket / 60)}小时${bucket % 60 ? `${bucket % 60}分` : ''}`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `剩余${hours}小时`;
    return `剩余${Math.floor(hours / 24)}天`;
  }

  constructor(
    private readonly daemon: DaemonManager,
    private readonly api: ControlApi,
    poller: Poller,
    private readonly onDaemonReady: (daemonId: string) => void = () => {},
  ) {
    this.item.name = 'BlackHole';
    this.item.command = 'blackhole.openSettings';
    this.stateSubscription = daemon.onDidChangeState((state) => {
      this.healthRevision++;
      this.healthPending = undefined;
      this.health = null;
      this.healthFailures = 0;
      this.render();
      if (state === 'running') void this.refreshHealth(true);
    });
    this.tick = poller.onTick(() => void this.refreshHealth(false));
    this.render();
    this.item.show();
  }

  private grantPollN = 0;
  private alwaysGrants: string[] = [];

  private async refreshGrants(): Promise<void> {
    const daemonId = this.health?.daemon_id;
    try {
      const r = await this.api.alwaysGrants();
      if (this.disposed || daemonId !== this.health?.daemon_id) return;
      const next = r.always ?? [];
      if (next.join('\n') !== this.alwaysGrants.join('\n')) {
        this.alwaysGrants = next;
        this.render();
      }
    } catch {
      /* daemon down: keep the last known list */
    }
  }

  private refreshHealth(immediate: boolean): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (!immediate && this.healthPending) return this.healthPending;
    const stamp = ++this.healthRevision;
    const observation = this.daemon.captureHealthObservation();
    const pending = (async () => {
      try {
        const h = await this.api.health(immediate ? 1_000 : 8_000, observation.port);
        if (this.disposed || stamp !== this.healthRevision) return;
        if (!this.daemon.observeHealth(h, observation)) return;
        // Recovery may emit a running transition and start a newer health read.
        if (this.disposed || stamp !== this.healthRevision) return;
        this.healthFailures = 0;
        this.health = h;
        if (h.daemon_id && h.daemon_id !== this.observedDaemonId) {
          this.observedDaemonId = h.daemon_id;
          this.onDaemonReady(h.daemon_id);
        }
        if (++this.grantPollN % 10 === 0) void this.refreshGrants();
        this.render();
      } catch {
        if (this.disposed || stamp !== this.healthRevision) return;
        this.healthFailures += 1;
        if (this.healthFailures >= 3) { this.health = null; this.render(); }
      }
    })().finally(() => { if (this.healthPending === pending) this.healthPending = undefined; });
    this.healthPending = pending;
    return pending;
  }

  private render(): void {
    if (this.disposed) return;
    // Compute everything first, then write only what CHANGED: re-assigning
    // text/tooltip restarts the hover popup, so a poll that produces the
    // same values must not touch the item — that was the flicker.
    const before = { text: this.item.text, tooltip: this.lastTooltip };
    const daemonIcons: Record<string, string> = {
      running: '$(broadcast)',
      starting: '$(sync~spin)',
      stopped: '$(circle-slash)',
      error: '$(error)',
    };
    // daemon problems outrank channel state: without the daemon nothing works
    this.channelExtra = null;
    if (this.daemon.currentState !== 'running') {
      this.set(
        `${daemonIcons[this.daemon.currentState] ?? '$(question)'} BlackHole`,
        this.daemon.currentState === 'error'
          ? `BlackHole daemon：${this.daemon.error}`
          : `BlackHole daemon：${this.daemon.currentState}（点击打开设置）`,
        before,
      );
      this.item.backgroundColor =
        this.daemon.currentState === 'error' ? new ThemeColor('statusBarItem.errorBackground') : undefined;
      return;
    }

    const t = this.health?.tunnel ?? 'unreachable';
    const oa = this.openaiSummary();
    const cloudflareOff = !['online', 'starting', 'unverified', 'error', 'unavailable', 'unreachable'].includes(t);
    this.channelExtra = cloudflareOff ? null : oa;
    if (cloudflareOff && oa) {
      this.set(`${oa.icon} ${oa.text}`, `BlackHole 渠道：Cloudflare 未启动\n${oa.tip}\n点击打开设置`, before);
      this.item.backgroundColor = undefined;
      return;
    }
    if (t === 'online') {
      this.set('$(link) BlackHole', this.onlineTooltip(), before);
    } else if (t === 'starting') {
      this.set('$(sync~spin) 渠道启动中', `BlackHole 渠道：启动中…${this.health?.tunnel_reason ? `\n${this.health.tunnel_reason}` : ''}\n点击打开设置`, before);
    } else if (t === 'unverified') {
      this.set(
        '$(link) 渠道未验证',
        `BlackHole 渠道：连接器已注册、URL 已生效，但本机探测不可达${this.health?.tunnel_reason ? `\n${this.health.tunnel_reason}` : ''}\n${this.health?.tunnel_url ?? ''}\nURL 可照常分发给外部使用（外部访问不经本机网络）；点击打开设置`,
        before,
      );
    } else if (t === 'error') {
      this.set('$(error) 渠道失败', `BlackHole 渠道：启动失败${this.health?.tunnel_reason ? `\n${this.health.tunnel_reason}` : ''}\n点击打开设置`, before);
    } else if (t === 'unavailable') {
      this.set('$(warning) 渠道不可用', `BlackHole 渠道：不可用${this.health?.tunnel_reason ? `\n${this.health.tunnel_reason}` : ''}\n点击打开设置`, before);
      this.item.backgroundColor = undefined;
    } else if (t === 'unreachable') {
      this.set('$(broadcast) BlackHole', 'BlackHole daemon：运行中（渠道状态未知，点击打开设置）', before);
    } else {
      this.set('$(circle-slash) 渠道未启动', 'BlackHole 渠道：未启动。创建会话前需先启动（点击打开设置）', before);
    }
    this.item.backgroundColor = t === 'error' ? new ThemeColor('statusBarItem.errorBackground') : undefined;
  }

  private openaiSummary(): { icon: string; text: string; tip: string } | null {
    const v = this.health?.openai_tunnel;
    if (!v || v.status === 'off') return null;
    const map: Record<string, [string, string]> = {
      starting: ['$(sync~spin)', 'OpenAI 启动中'], ready: ['$(plug)', 'OpenAI 就绪'], recovering: ['$(sync~spin)', 'OpenAI 恢复中'],
      stopping: ['$(sync~spin)', 'OpenAI 停止中'], error: ['$(error)', 'OpenAI 失败'], unavailable: ['$(warning)', 'OpenAI 不可用'],
    };
    const [icon, text] = map[v.status] ?? ['$(plug)', `OpenAI ${v.status}`];
    return { icon, text, tip: `OpenAI 渠道：${text.replace(/^OpenAI /, '')}${v.reason ? `（${v.reason}）` : ''}` };
  }

  /** Write-through gate: only touches the item when a value really changed. */
  private set(text: string, tooltip: string | MarkdownString, before: { text: string; tooltip: string | MarkdownString | undefined }): void {
    const extra = this.channelExtra;
    if (extra) {
      text += ` · ${extra.text}`;
      if (typeof tooltip === 'string') tooltip = `${tooltip}\n${extra.tip}`;
      else tooltip.appendMarkdown('\n\n' + extra.tip.replace(/[\\`*_[\]()#|<>]/g, (c) => '\\' + c));
    }
    const label = this.accountLabel();
    if (label) text += ` · ${label}`;
    const remaining = this.remainingLabel();
    const executionWarning = this.executionWarning();
    if (typeof tooltip === 'string') {
      tooltip = `${tooltip}${remaining || label ? `\n${remaining ?? label}` : ''}${executionWarning ? `\n${executionWarning}` : ''}`;
    } else {
      const accountSummary = new MarkdownString('', true);
      const lines = tooltip.value.split('\n');
      accountSummary.appendMarkdown(lines.shift() ?? '');
      if (remaining || label) accountSummary.appendMarkdown(`\n\n$(clock) **${remaining ?? label}**`);
      if (executionWarning) accountSummary.appendMarkdown(`\n\n$(warning) **命令执行需要处理**\n\n${executionWarning}`);
      if (lines.length) accountSummary.appendMarkdown(`\n${lines.join('\n')}`);

      tooltip = accountSummary;
    }
    if (before.text !== text) this.item.text = text;
    const asString = typeof tooltip === 'string' ? tooltip : tooltip.value;
    if (before.tooltip !== asString) {
      this.lastTooltip = asString;
      this.item.tooltip = tooltip;
    }
  }


  private executionWarning(): string | null {
    if (this.daemon.currentState !== 'running') return null;
    const runtime = this.health?.execution_runtime;
    if (!runtime) return null;
    if (!runtime.process_available) {
      if (runtime.process_unavailable_reason === 'runtime_asset_missing') return '后台任务组件缺失，process 未注册。请重新安装完整的 BlackHole 插件并重启本地服务；exec 不受该组件影响。';
      if (runtime.process_unavailable_reason === 'shell_unavailable') return '没有找到可运行的后台任务 shell，process 未注册。请检查 VS Code 默认终端或系统 zsh/bash/sh，并重启本地服务。';
      return `后台任务当前不可用（${runtime.process_unavailable_reason ?? 'backend_unavailable'}），process 未注册；exec 仍按单次命令能力工作。`;
    }
    const sandbox = runtime.sandbox;
    if (sandbox.status !== 'unavailable' && sandbox.status !== 'unsupported') return null;
    if (sandbox.reason === 'sandbox_runner_nested') {
      return '受限命令沙箱不可用：BlackHole 本地服务可能运行在另一层 macOS 沙箱中。exec/process 仍会显示，但只读或工作区写入会拒绝执行；请从正常 VS Code 环境重启本地服务。';
    }
    if (sandbox.reason === 'sandbox_runner_missing') {
      return `受限命令沙箱不可用：系统缺少或阻止了 ${sandbox.backend === 'seatbelt' ? 'macOS sandbox-exec' : sandbox.backend === 'bubblewrap' ? 'Bubblewrap' : '所需运行器'}。不会自动改为无沙箱执行。`;
    }
    return `受限命令沙箱不可用（${sandbox.reason ?? sandbox.status}）。exec/process 仍可发现，但受限调用会安全拒绝；请查看 BlackHole 输出日志。`;
  }
  /**
   * Stable hover content. High-frequency counters and process telemetry live in
   * the settings page; putting them here would replace VS Code's hover on every
   * poll. Only operator-relevant state changes are allowed to rewrite it.
   */
  private onlineTooltip(): MarkdownString {
    const pending = this.health?.approvals_pending ?? 0;
    const denied = this.health?.approvals_denied ?? 0;
    const running = this.health?.sessions_running;
    const active = typeof running === 'number' && Number.isSafeInteger(running) && running >= 0 ? running : '—';
    const lines = [
      `### $(radio-tower) BlackHole v${this.health?.version ?? ''}`,
      pending > 0 || denied > 0 ? `#### $(bell-dot) 需要处理` : null,
      pending > 0 ? `- $(bell) **待审批 ${pending} 条高危命令** — 点击打开设置处理` : null,
      denied > 0 ? `- $(shield) 今日已拦截 ${denied} 条高危命令` : null,
      `#### $(workspace) 状态`,
      `- $(link) 渠道在线`,
      `- $(layers) 进行中会话 **${active}**`,
      ...(this.alwaysGrants.length > 0
        ? [
            '',
            `#### $(unlock) 已始终授权 ${this.alwaysGrants.length} 项`,
            ...this.alwaysGrants.slice(0, 5).map((k) => `- $(check) \`${k}\``),
            this.alwaysGrants.length > 5 ? `- … 共 ${this.alwaysGrants.length} 项` : null,
          ]
        : []),
      '',
      `*$(settings-gear) 点击打开设置页查看活动与配置*`,
    ];
    return new MarkdownString(lines.filter((l) => l !== null).join('\n'), true);
  }

  dispose(): void {
    this.disposed = true;
    this.healthRevision++;
    this.stateSubscription.dispose();
    this.tick.dispose();
    this.item.dispose();
  }
}
