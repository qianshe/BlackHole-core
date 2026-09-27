import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { EventEmitter, env, window, workspace, type Disposable, type Terminal } from 'vscode';
import type { ProcessTerminalApi, ProcessViewItem, TerminalAcknowledgement } from './processTypes';

interface View {
  key: string; item: ProcessViewItem; write: EventEmitter<string>; terminal?: Terminal;
  opened: boolean; disposed: boolean; buffered: string; lastState: string; stopBusy: boolean;
}
/** A projection only: never spawns a shell, executes sendText or owns the daemon/channel lifetime. */
export class ProcessTerminalController implements Disposable {
  private readonly clientId = randomUUID();
  private daemonId: string | undefined;
  private disposed = false;
  private busy = false;
  private disconnected = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly views = new Map<string, View>();
  private readonly dismissed = new Set<string>();
  private readonly acknowledgements = new Map<string, TerminalAcknowledgement>();
  private cursors: Record<string, number> = {};
  private items: ProcessViewItem[] = [];
  private reopen: string | undefined;
  private readonly roots: () => string[];
  private readonly enabled: boolean;
  constructor(private readonly api: ProcessTerminalApi, options: { roots?: () => string[]; enabled?: boolean } = {}) {
    this.roots = options.roots ?? (() => (workspace.workspaceFolders ?? []).flatMap(folder => {
      if (folder.uri.scheme !== 'file') return [];
      try { return [fs.realpathSync.native(folder.uri.fsPath)]; } catch { return []; }
    }));
    this.enabled = options.enabled ?? (['win32', 'darwin', 'linux'].includes(process.platform) && !env.remoteName);
  }
  start(): void {
    if (!this.enabled || this.disposed || this.timer) return;
    void this.poll();
    this.timer = setInterval(() => { void this.poll(); }, 1000); this.timer.unref();
  }
  private key(item: ProcessViewItem): string { return `${item.daemonId}:${item.sessionId}:${item.processId}`; }
  private send(view: View, text: string): void {
    if (view.disposed) return;
    const normalized = text.replace(/\r\n?/g, '\n').replace(/\n/g, '\r\n');
    if (view.opened) view.write.fire(normalized);
    else view.buffered = (view.buffered + normalized).slice(-64 * 1024);
  }
  private ack(item: ProcessViewItem, state: TerminalAcknowledgement['state']): void {
    if (!this.disposed && item.daemonId === this.daemonId) this.acknowledgements.set(item.processId, { processId: item.processId, state });
  }
  private create(item: ProcessViewItem): View | undefined {
    const key = this.key(item);
    if (this.dismissed.has(key)) return undefined;
    const view: View = { key, item, write: new EventEmitter<string>(), opened: false, disposed: false, buffered: '', lastState: '', stopBusy: false };
    this.views.set(key, view);
    this.send(view, `BlackHole · ${item.name}\nprocessId: ${item.processId}\ncwd: ${item.cwd}\n只读后台进程输出；Ctrl+C 或关闭终端都会停止此任务。\n\n`);
    try {
      view.terminal = window.createTerminal({ name: `BlackHole · ${item.name} · ${item.processId.slice(-8)}`, isTransient: true, pty: {
        onDidWrite: view.write.event,
        open: () => {
          if (this.disposed || view.disposed || item.daemonId !== this.daemonId) return;
          view.opened = true;
          if (view.buffered) { view.write.fire(view.buffered); view.buffered = ''; }
          this.ack(item, 'open');
        },
        close: () => {
          if (view.disposed) return;
          view.disposed = true; view.write.dispose(); this.views.delete(key);
          if (!this.disposed && item.daemonId === this.daemonId) {
            this.dismissed.add(key); this.ack(item, 'closed');
            if (!['exited', 'failed'].includes(view.item.state)) void this.api.processStop({ clientId: this.clientId, daemonId: item.daemonId, workspaces: this.roots(), processId: item.processId }).catch(() => {});
          }
        },
        handleInput: (data: string) => { if (data === '\u0003') void this.stopView(view, false); },
      } });
      view.terminal.show(true); // show once; logs and status polls never steal focus
      return view;
    } catch {
      view.disposed = true; view.write.dispose(); this.views.delete(key); this.dismissed.add(key);
      this.ack(item, 'unavailable');
      void window.showWarningMessage('BlackHole：无法创建后台任务终端。进程仍由 daemon 管理，可按 processId 查询或停止。');
      return undefined;
    }
  }
  private closeViews(message: string): void {
    for (const view of this.views.values()) {
      this.send(view, '\n' + message + '\n');
      view.disposed = true; view.terminal?.dispose(); view.write.dispose();
    }
    this.views.clear();
  }
  private reset(): void {
    this.closeViews('daemon 已变化，旧进程 ID 不再可查证；未自动重新执行任何脚本。');
    this.daemonId = undefined; this.cursors = {}; this.items = []; this.acknowledgements.clear(); this.dismissed.clear();
  }
  async poll(): Promise<void> {
    if (this.disposed || this.busy || !this.enabled) return;
    this.busy = true;
    const roots = this.roots(), sent = [...this.acknowledgements.values()], reopen = this.reopen;
    try {
      const reply = await this.api.processSync({ clientId: this.clientId, daemonId: this.daemonId, workspaces: roots,
        cursors: { ...this.cursors }, acknowledgements: sent, ...(reopen ? { reopen } : {}) });
      if (this.disposed) return;
      if (this.daemonId && reply.daemonId !== this.daemonId) this.reset();
      this.daemonId = reply.daemonId; this.disconnected = false;
      for (const ack of sent) if (this.acknowledgements.get(ack.processId) === ack) this.acknowledgements.delete(ack.processId);
      if (this.reopen === reopen) this.reopen = undefined;
      this.items = reply.supported ? reply.items : [];
      const owned = new Set(this.items.filter(item => item.owned).map(item => this.key(item)));
      for (const [key, view] of this.views) if (!owned.has(key)) {
        this.send(view, '\n此视图不再拥有显示租约；进程没有被重新启动。\n');
        view.disposed = true; view.terminal?.dispose(); view.write.dispose(); this.views.delete(key);
      }
      for (const item of this.items) {
        if (!item.owned || item.daemonId !== this.daemonId) continue;
        const key = this.key(item);
        if (item.closeTerminal) {
          const closing = this.views.get(key);
          if (closing && !closing.disposed) closing.terminal?.dispose();
          else { this.dismissed.add(key); this.ack(item, 'closed'); }
          continue;
        }
        const view = this.views.get(key) ?? this.create(item);
        if (!view) continue;
        view.item = item;
        if (item.output.gap) this.send(view, '\n[较早输出已截断，以下为近期输出]\n');
        for (const event of item.output.events) if (event.seq > (this.cursors[item.processId] ?? 0)) this.send(view, event.text);
        this.cursors[item.processId] = item.output.next;
        const stateKey = `${item.state}:${item.exitCode}:${item.reason}`;
        if (stateKey !== view.lastState && ['exited', 'failed', 'unknown'].includes(item.state)) {
          this.send(view, `\n[${item.state} · exit ${item.exitCode ?? 'unknown'}${item.reason ? ' · ' + item.reason : ''}]\n`);
        }
        view.lastState = stateKey;
      }
    } catch (error) {
      if (this.disposed) return;
      if ((error as { status?: number }).status === 409) this.reset();
      else if (!this.disconnected) {
        this.disconnected = true;
        for (const view of this.views.values()) this.send(view, '\n[BlackHole 连接中断，进程状态暂不可查证；恢复后继续读取，不重复启动]\n');
      }
    } finally { this.busy = false; }
  }
  private async select(activeOnly = false): Promise<ProcessViewItem | undefined> {
    if (!this.enabled) { void window.showInformationMessage('BlackHole 后台终端仅用于本地桌面工作区；远程工作区尚未启用。'); return undefined; }
    await this.poll();
    const items = this.items.filter(item => !activeOnly || !['exited', 'failed'].includes(item.state));
    if (!items.length) { void window.showInformationMessage('BlackHole：当前工作区没有可用的后台进程。'); return undefined; }
    const choice = await window.showQuickPick(items.map(item => ({ label: item.name, description: `${item.state} · ${item.processId}`, item })), { placeHolder: activeOnly ? '选择要停止的后台进程' : '选择要显示的后台进程' });
    return choice?.item;
  }
  async show(): Promise<void> {
    const item = await this.select(); if (!item || this.disposed) return;
    const view = this.views.get(this.key(item));
    if (view) { view.terminal?.show(true); return; }
    this.dismissed.delete(this.key(item)); delete this.cursors[item.processId]; this.reopen = item.processId;
    await this.poll();
    if (!this.views.has(this.key(item))) void window.showInformationMessage('BlackHole：该进程暂不可显示，可能由另一个工作区窗口持有。');
  }
  private async selectedViewForStop(): Promise<View | undefined> {
    const item = await this.select(true); if (!item || this.disposed) return undefined;
    let view = this.views.get(this.key(item));
    if (!view) {
      this.dismissed.delete(this.key(item)); this.reopen = item.processId; await this.poll(); view = this.views.get(this.key(item));
    }
    if (!view) void window.showInformationMessage('BlackHole：此窗口没有该进程的有效显示租约。可由 Agent 使用 processId 停止。');
    return view;
  }
  async stopSelected(): Promise<void> {
    const view = await this.selectedViewForStop(); if (view) await this.stopView(view, false);
  }
  async stopAndCloseSelected(): Promise<void> {
    const view = await this.selectedViewForStop(); if (view) await this.stopView(view, true);
  }
  private async stopView(view: View, closeAfter: boolean): Promise<void> {
    if (this.disposed || view.disposed || view.stopBusy || view.item.daemonId !== this.daemonId) return;
    view.stopBusy = true;
    try {
      const reply = await this.api.processStop({ clientId: this.clientId, daemonId: view.item.daemonId, workspaces: this.roots(), processId: view.item.processId });
      const confirmed = reply.state === 'exited' || reply.state === 'failed';
      if (!this.disposed) this.send(view, `\n[停止请求结果：${reply.state}${reply.reason ? ' · ' + reply.reason : ''}]\n`);
      await this.poll();
      if (closeAfter && confirmed && !this.disposed && !view.disposed) view.terminal?.dispose();
      else if (closeAfter && !confirmed && !this.disposed && !view.disposed) this.send(view, '\n[停止未确认，已保留终端供查证]\n');
    } catch { if (!this.disposed) this.send(view, '\n[停止未确认，请按 processId 查证；未停止其他任务]\n'); }
    finally { view.stopBusy = false; }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; if (this.timer) clearInterval(this.timer);
    this.closeViews('VS Code 视图已断开；daemon 会清理失去终端租约的后台任务。'); this.acknowledgements.clear();
  }
}
