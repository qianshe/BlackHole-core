import { StatusBarAlignment, window, type Disposable, type OutputChannel, type StatusBarItem } from 'vscode';
import type { ControlApi } from './controlApi';
import type { DaemonManager } from './daemonManager';
import type { SharedCoreManager } from './sharedCoreManager';

type Candidate = NonNullable<Awaited<ReturnType<SharedCoreManager['bundledCoreUpdateStatus']>>>;
const SOFT = new Set(['active_clients','peer_core_update_required','active_work','active_requests','active_handlers','lock_busy']);

/** Normal application happens inside start-bundled-core, before business
 * attachment. This small continuation handles only a genuinely busy startup.
 * The installed, verified bundle is the update target: no extra consent UI,
 * mutable download source, independent service or second Core instance. */
export class BundledCoreUpdateCoordinator implements Disposable {
  private readonly item: StatusBarItem = window.createStatusBarItem(StatusBarAlignment.Right,85);
  private timer?: ReturnType<typeof setInterval>;
  private scan?: Promise<void>;
  private pending?: Candidate;
  private pinnedHash?: string;
  private halt = false;
  private disposed = false;
  private lastReason = '';

  constructor(private readonly manager:SharedCoreManager,private readonly daemon:DaemonManager,
    private readonly api:ControlApi,private readonly port:()=>number,private readonly log:OutputChannel,
    private readonly onCommitted:()=>Promise<void>) {
    this.item.name='BlackHole Core 更新状态';
    this.item.command='blackhole.applyBundledCoreUpdate';
  }
  start():void {
    if(this.disposed||this.timer)return;
    this.timer=setInterval(()=>{void this.refresh();},30_000);
    void this.refresh();
  }
  /** Compatibility command: recheck the same installed bundle, never prompt. */
  async request():Promise<boolean> { await this.refresh();return !this.pending&&!this.halt; }
  refresh():Promise<void> {
    if(this.disposed||this.halt)return Promise.resolve();
    if(this.scan)return this.scan;
    const task=this.reconcile();
    this.scan=task;
    void task.finally(()=>{if(this.scan===task)this.scan=undefined;}).catch(()=>{});
    return task;
  }
  private async reconcile():Promise<void> {
    let candidate:Candidate;
    const session=this.daemon.managedCoreSession;
    try {
      if(session?.startupUpdateState==='rolled_back'){this.fail('core_upgrade_rolled_back');return;}
      const value=await this.manager.bundledCoreUpdateStatus();
      if(this.disposed)return;
      if(!value){this.pending=undefined;this.item.hide();this.stopTimer();return;}
      candidate=value;this.pending=value;
      this.pinnedHash ??= value.descriptorHash;
      if(this.pinnedHash!==value.descriptorHash){this.fail('core_update_target_changed');return;}
      if(!session||session.bindingState!=='bound'){this.render('client_lease_unconfirmed');return;}
      const health=await this.api.health(3000,this.port());
      if(this.disposed)return;
      if(!session.matchesHealth(health as unknown as Record<string,unknown>)){
        // A peer may have just completed the same update. Lease renewal owns
        // journal-based reattachment; this advisory read authorizes no write.
        this.render('core_identity_unconfirmed');return;
      }
      const ready=health.lifecycle_upgrade_version===1 ? health.upgrade_idle : health.maintenance_idle;
      if(ready!==true){
        this.render(health.lifecycle_upgrade_version===1 ? (health.upgrade_blockers?.[0]??'active_work') : 'legacy_core_busy');
        return;
      }
    }catch(e){this.render('status_unavailable');return;} // reads may be retried; mutations may not
    try {
      if(this.disposed)return;
      this.render('updating');
      const result=await this.manager.applyBundledCoreUpdate(session!);
      if(result!=='committed'){this.fail('core_upgrade_rolled_back');return;}
      this.pending=undefined;this.item.hide();this.stopTimer();
      this.log.appendLine(`Bundled Core automatically updated and verified: ${candidate.bundledVersion}.`);
      try{await this.onCommitted();}catch{this.log.appendLine('Core update committed; UI refresh will retry separately.');}
    }catch(e){
      const raw=e instanceof Error?e.message:'';
      const code=/^[a-z][a-z0-9_]{0,119}$/.test(raw)?raw:'manager_outcome_unknown';
      if(SOFT.has(code))this.render(code);else this.fail(code);
    }
  }
  private fail(reason:string):void {
    this.halt=true;this.stopTimer();this.render(reason);
    if(!this.disposed)void window.showWarningMessage(`BlackHole Core 自动更新未完成（${reason}）。已停止重复执行；请检查 BlackHole 输出及维护记录。`);
  }
  private render(reason:string):void {
    if(this.disposed)return;
    const explanations:Record<string,string>={tools_running:'正在执行工具',background_processes:'后台任务尚未结束',
      agent_work:'Agent 仍在工作',pending_approvals:'有待审批操作',recent_agent_activity:'等待本轮工具活动结束',
      legacy_core_busy:'旧 Core 尚未允许停止（任务或旧版页面占用）',active_work:'仍有执行中的工作',
      active_clients:'另一入口尚不支持协调重连',peer_core_update_required:'另一入口不信任或不兼容新版 Core',
      status_unavailable:'暂时无法确认 Core 状态',client_lease_unconfirmed:'等待客户端连接确认',
      core_identity_unconfirmed:'等待签名实例与连接核验',lock_busy:'另一个启动或更新正在进行',updating:'正在应用随包更新'};
    const detail=explanations[reason]??reason;
    const versions=this.pending?`当前 Core ${this.pending.runningVersion}；随包 Core ${this.pending.bundledVersion}`:'Core 更新状态';
    this.item.text=this.halt?'$(warning) Core 更新异常':reason==='updating'?'$(sync~spin) Core 更新中':'$(clock) Core 更新等待';
    this.item.tooltip=versions+'\n'+detail+(this.halt?'\n请查看输出；不会盲目重试。':'\n无需再次确认或重新安装；条件满足后自动继续。');
    this.item.show();
    const key=versions+':'+reason;
    if(key!==this.lastReason){this.lastReason=key;this.log.appendLine('Bundled Core: '+key);}
  }
  private stopTimer():void {if(this.timer)clearInterval(this.timer);this.timer=undefined;}
  dispose():void {this.disposed=true;this.stopTimer();this.item.dispose();}
}
