import { randomUUID } from 'node:crypto';
import { MaintainCoreResultSchema, type MaintainCoreResult, UpgradeCoreResultSchema, type UpgradeCoreResult, AttachCoreResultSchema, type AttachCoreResult, type LeaseHandle, type ManagedReadyReceipt } from '../../contracts/src/manager-protocol';
import { ClientLeaseSchema } from '../../contracts/src/core-runtime';

export type ManagerTransport = <T>(request: Record<string, unknown>, timeoutMs?: number) => Promise<T>;
export type ManagedBindingState = 'attaching' | 'bound' | 'unbound' | 'renewal_unconfirmed' | 'maintenance_unknown' | 'lease_expired' | 'closed';
const LEASE_HEARTBEAT_MS = 15_000;
const LEASE_RETRY_MS = 5_000;
// Only definitive Manager rejections invalidate the binding immediately.
// A missing response/contended lock is not proof that the daemon or lease
// changed. Those retries are bounded by the original recorded lease expiry.
const DEFINITIVE_LEASE_ERRORS = new Set([
  'lease_missing', 'lease_expired', 'lease_target_mismatch', 'core_identity_conflict',
  'data_root_conflict', 'environment_mismatch',
  // daemon_state_unknown includes a temporarily missing health response.
  // It is not proof of replacement. Retry the ORIGINAL lease until expiry.
]);
export type SessionOptions = {
  invoke: ManagerTransport;
  client: { clientId: string; clientInstanceId: string; kind: 'vscode'; version: string; protocol: { min: number; max: number }; capabilities: ('web-ui')[] };
  seedArchive?: string;
  bootstrap?: (port: number) => Promise<import('../../contracts/src/manager-protocol').StartBundledCoreResult>;
  reconnectAfterUpgrade?: true;
  environment: 'test' | 'production';
  cloudOrigin: string;
  onLost: (reason?: string) => void;
  onRebound?: (receipt: ManagedReadyReceipt) => void;
  dataRootId?: string;
  resolvePort?: (fallback: number) => Promise<number>;
  onReady?: (receipt: ManagedReadyReceipt) => void;
};

/** One extension host owns one renewable Manager lease, never a daemon process.
 * Failure is sticky until explicit attach; neither polling nor timer failure
 * authorizes retrying an ambiguous mutation or spawning through a legacy path.
 */
export class ManagedCoreSession {
  private attachment?: AttachCoreResult;
  private port?: number;
  private timer?: ReturnType<typeof setTimeout>;
  private starting?: Promise<ManagedReadyReceipt>;
  private renewing?: Promise<void>;
  private closing?: Promise<void>;
  private disposed = false;
  private maintaining?: Promise<MaintainCoreResult>;
  private upgrading?: Promise<UpgradeCoreResult>;
  private renewalUnconfirmed = false;
  private rebindRetryUntil?: number;
  private awaitingUpgradeSince?: number;
  private maintenanceUnknown = false;
  private lastMaintenanceId?: string;
  private startupState?: import('../../contracts/src/manager-protocol').StartBundledCoreResult['state'];
  get startupUpdateState() { return this.startupState; }
  get maintenanceRequestId(): string | undefined { return this.lastMaintenanceId; }
  constructor(private readonly options: SessionOptions) {}

  get receipt(): ManagedReadyReceipt | undefined { return this.maintenanceUnknown ? undefined : this.attachment?.receipt; }
  /** A missing lease is not a daemon identity mismatch. Never infer one from HTTP health alone. */
  get bindingState(): ManagedBindingState {
    if (this.disposed) return 'closed';
    if (this.starting || this.maintaining || this.upgrading || this.awaitingUpgradeSince !== undefined) return 'attaching';
    if (this.maintenanceUnknown) return 'maintenance_unknown';
    const a = this.attachment;
    if (!a) return 'unbound';
    if (Date.parse(a.lease.expiresAt) <= Date.now()) return 'lease_expired';
    return this.renewalUnconfirmed ? 'renewal_unconfirmed' : 'bound';
  }
  private handle(value: AttachCoreResult): LeaseHandle {
    const { leaseId, clientInstanceId, daemonId, dataRootId, descriptorHash } = value.lease;
    return { leaseId, clientInstanceId, daemonId, dataRootId, descriptorHash };
  }
  private clearTimer(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
  private async detach(value: AttachCoreResult): Promise<void> {
    await this.options.invoke({ command: 'detach', handle: this.handle(value) }, 5_000);
  }
  private schedule(): void {
    this.clearTimer();
    if (this.disposed || this.maintaining || this.upgrading || this.maintenanceUnknown || !this.attachment) return;
    const remaining = Date.parse(this.attachment.lease.expiresAt) - Date.now();
    // When Manager is slow, check no later than the trusted expiry. This
    // avoids a falsely "connected" window after the actual lease has lapsed.
    const delay = this.awaitingUpgradeSince !== undefined || this.rebindRetryUntil !== undefined ? LEASE_RETRY_MS
      : Math.max(1, Math.min(this.renewalUnconfirmed ? LEASE_RETRY_MS : LEASE_HEARTBEAT_MS, remaining));
    this.timer = setTimeout(() => { void this.renew(); }, delay);
  }

  attach(port: number): Promise<ManagedReadyReceipt> {
    if (this.maintaining || this.upgrading) return Promise.reject(new Error('maintenance_in_progress'));
    if (this.maintenanceUnknown) return Promise.reject(new Error('maintenance_outcome_requires_inspection'));
    if (this.disposed) return Promise.reject(new Error('managed_client_disposed'));
    if (!Number.isInteger(port) || port < 1 || port > 65535) return Promise.reject(new Error('port_invalid'));
    if (this.attachment && this.port !== undefined && this.port !== port) return Promise.reject(new Error('managed_port_change_requires_coordinated_restart'));
    if (this.starting) return this.starting;
    if (this.attachment && Date.parse(this.attachment.lease.expiresAt) > Date.now()) return Promise.resolve(this.attachment.receipt);
    if (this.attachment) return Promise.reject(new Error('lease_expired'));
    this.port = port;
    const task = (async () => {
      const { invoke, client, seedArchive } = this.options;
      if (this.options.resolvePort) port = await this.options.resolvePort(port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port_invalid');
      this.port = port;
      if (this.disposed) throw new Error('managed_client_disposed');
      let result: AttachCoreResult;
      if (this.options.bootstrap) {
        const startup = await this.options.bootstrap(port);
        this.startupState = startup.state;
        result = AttachCoreResultSchema.parse(startup.attachment);
      } else {
        await invoke({ command: 'ensure-core', request: { client, port, ...(seedArchive ? { seedArchive } : {}) } });
        if (this.disposed) throw new Error('managed_client_disposed');
        result = AttachCoreResultSchema.parse(await invoke({ command: 'attach-or-start', request: { client, port } }));
      }
      this.validateAttachment(result, port);
      const { receipt } = result;
      if (this.disposed) { await this.detach(result); throw new Error('managed_client_disposed'); }
      this.attachment = result;
      this.rebindRetryUntil = undefined;
      this.renewalUnconfirmed = false;
      this.options.onReady?.(receipt);
      this.schedule();
      return receipt;
    })();
    this.starting = task;
    void task.finally(() => { if (this.starting === task) this.starting = undefined; }).catch(() => {});
    return task;
  }

  private validateAttachment(result: AttachCoreResult, port: number): void {
    const { client } = this.options;
      const { receipt, lease } = result;
      if ((this.options.dataRootId !== undefined && receipt.dataRootId !== this.options.dataRootId) || receipt.environment !== this.options.environment || receipt.cloudOrigin !== this.options.cloudOrigin
        || receipt.localUrl !== `http://127.0.0.1:${port}/ui/` || lease.clientId !== client.clientId
        || lease.clientInstanceId !== client.clientInstanceId || lease.kind !== client.kind
        || lease.daemonId !== receipt.daemonId || lease.descriptorHash !== receipt.descriptorHash
        || lease.dataRootId !== receipt.dataRootId || lease.runtimeId !== receipt.runtimeId
        || lease.buildId !== receipt.buildId || Date.parse(lease.expiresAt) <= Date.now()) throw new Error('managed_receipt_mismatch');
  }

  /** Explicit native maintenance only. Unknown outcomes are sticky until inspection. */
  maintain(operation: 'stop' | 'restart', confirmed: boolean, settingsRevision?: number): Promise<MaintainCoreResult> {
    if (settingsRevision !== undefined && (operation !== 'restart' || !Number.isInteger(settingsRevision) || settingsRevision < 0)) return Promise.reject(new Error('settings_revision_invalid'));
    if (!confirmed) return Promise.reject(new Error('maintenance_confirmation_required'));
    if (this.disposed) return Promise.reject(new Error('managed_client_disposed'));
    if (this.maintaining || this.upgrading || this.starting) return Promise.reject(new Error('maintenance_in_progress'));
    if (this.maintenanceUnknown) return Promise.reject(new Error('maintenance_outcome_requires_inspection'));
    if (!this.attachment || !this.port) return Promise.reject(new Error('lease_missing'));
    this.clearTimer();
    const requestId = randomUUID();
    let sent = false;
    const task = (async () => {
      await this.renewing;
      const current = this.attachment;
      if (this.disposed) throw new Error('managed_client_disposed');
      if (!current || Date.parse(current.lease.expiresAt) <= Date.now()) throw new Error('lease_expired');
      try {
        sent = true; this.lastMaintenanceId = requestId;
        const result = MaintainCoreResultSchema.parse(await this.options.invoke({ command: 'maintain-core', request: {
          operation, confirmed: true, requestId, client: this.options.client, handle: this.handle(current), port: this.port, ...(settingsRevision !== undefined ? { settingsRevision } : {}),
        } }, 90_000));
        if (result.requestId !== requestId || result.operation !== operation) throw new Error('maintenance_receipt_mismatch');
        if (result.operation === 'restart') {
          this.validateAttachment(result.attachment, this.port!);
          const next = result.attachment.receipt, prior = current.receipt;
          if (next.daemonId === prior.daemonId || next.startFingerprint === prior.startFingerprint
            || next.descriptorHash !== prior.descriptorHash || next.dataRootId !== prior.dataRootId
            || next.runtimeId !== prior.runtimeId || next.buildId !== prior.buildId
            || result.attachment.lease.leaseId === current.lease.leaseId) throw new Error('maintenance_receipt_mismatch');
          this.attachment = result.attachment;
        } else this.attachment = undefined;
        return result;
      } catch (e) {
        const code = e instanceof Error ? e.message : '';
        const refused = ['settings_revision_conflict', 'active_clients', 'active_work', 'active_requests', 'active_handlers', 'core_update_required', 'manager_key_mismatch', 'lock_busy'].includes(code);
        if (sent && !refused) {
          this.maintenanceUnknown = true;
          if (!this.disposed) this.options.onLost('maintenance_outcome_requires_inspection');
          throw new Error(`maintenance_outcome_requires_inspection:${requestId}`);
        }
        throw e;
      }
    })();
    this.maintaining = task;
    void task.finally(() => { if (this.maintaining === task) this.maintaining = undefined; this.schedule(); }).catch(() => {});
    return task;
  }


  /**
   * Explicit, native-confirmed update to a previously staged signed Core.
   * Manager owns the only Stop/Start/rollback transaction. This host owns only
   * its renewable lease. Never infer success from provisioning a Core archive.
   */
  upgradeCore(targetVersionName: string, targetDescriptorHash: string): Promise<UpgradeCoreResult> {
    if (!/^[A-Za-z0-9._-]{1,250}$/.test(targetVersionName) || !/^[a-f0-9]{64}$/.test(targetDescriptorHash))
      return Promise.reject(new Error('core_upgrade_target_invalid'));
    if (this.disposed) return Promise.reject(new Error('managed_client_disposed'));
    if (this.upgrading || this.maintaining || this.starting) return Promise.reject(new Error('maintenance_in_progress'));
    if (this.maintenanceUnknown) return Promise.reject(new Error('maintenance_outcome_requires_inspection'));
    if (!this.attachment || !this.port) return Promise.reject(new Error('lease_missing'));
    this.clearTimer();
    const requestId = randomUUID();
    const task = (async () => {
      await this.renewing;
      const current = this.attachment, port = this.port;
      if (this.disposed) throw new Error('managed_client_disposed');
      if (!current || !port || Date.parse(current.lease.expiresAt) <= Date.now()) throw new Error('lease_expired');
      let sent = false;
      try {
        sent = true;
        this.lastMaintenanceId = requestId;
        const result = UpgradeCoreResultSchema.parse(await this.options.invoke({
          command: 'upgrade-core',
          request: { confirmed: true, requestId, client: this.options.client,
            handle: this.handle(current), port, targetVersionName },
        }, 120_000));
        if (result.requestId !== requestId || result.targetVersionName !== targetVersionName)
          throw new Error('core_upgrade_receipt_mismatch');
        this.validateAttachment(result.attachment, port);
        const next = result.attachment.receipt, old = current.receipt;
        if (this.attachment !== current || next.daemonId === old.daemonId
          || next.startFingerprint === old.startFingerprint
          || next.dataRootId !== old.dataRootId || next.runtimeId !== old.runtimeId
          || result.attachment.lease.leaseId === current.lease.leaseId)
          throw new Error('core_upgrade_receipt_mismatch');
        if (result.state === 'committed') {
          if (next.descriptorHash !== targetDescriptorHash
            || next.runtimeVersion === old.runtimeVersion
            || next.buildId === old.buildId)
            throw new Error('core_upgrade_receipt_mismatch');
        } else if (next.descriptorHash !== old.descriptorHash
          || next.runtimeVersion !== old.runtimeVersion || next.buildId !== old.buildId)
          throw new Error('core_upgrade_rollback_mismatch');
        if (this.disposed) {
          await this.detach(result.attachment).catch(() => {});
          throw new Error('managed_client_disposed');
        }
        this.attachment = result.attachment;
        this.renewalUnconfirmed = false;
        try { this.options.onReady?.(next); } catch { /* UI refresh is best effort. */ }
        return result;
      } catch (error) {
        const code = error instanceof Error ? error.message : '';
        // Before signing Stop, Manager positively refuses competing leases and
        // incompatible candidates. All other sent outcomes require inspection:
        // they may have crossed the signed Stop boundary already.
        const knownRefusal = ['active_clients', 'peer_core_update_required', 'active_work', 'active_requests',
          'active_handlers', 'lease_expired', 'lease_target_mismatch',
          'core_update_not_newer', 'core_selection_changed',
          'client_update_required', 'data_schema_incompatible',
          'data_migration_explicit_required', 'core_protocol_incompatible',
          'maintenance_recovery_required', 'upgrade_recovery_required',
          'manager_key_mismatch', 'lock_busy'].includes(code);
        if (sent && !knownRefusal) {
          this.maintenanceUnknown = true;
          if (!this.disposed) this.options.onLost('maintenance_outcome_requires_inspection');
          throw new Error(`maintenance_outcome_requires_inspection:${requestId}`);
        }
        throw error;
      }
    })();
    this.upgrading = task;
    void task.finally(() => {
      if (this.upgrading === task) this.upgrading = undefined;
      this.schedule();
    }).catch(() => {});
    return task;
  }

  /**
   * A paused laptop or stalled Extension Host can miss the entire lease TTL
   * without replacing the daemon. Rebind only to the SAME signed incarnation:
   * existingFingerprint makes the Manager refuse a cold start or a replacement,
   * and the receipt/lease checks below reject any unexpected identity change.
   * Never run ensure-core, provision, maintenance or a generic attach retry here.
   */
  private async rebindExpiredToSameCore(current: AttachCoreResult): Promise<boolean | 'retry'> {
    const port = this.port;
    if (!port || this.disposed || this.maintaining || this.upgrading || this.maintenanceUnknown || this.attachment !== current) return false;
    let candidate: AttachCoreResult;
    try {
      candidate = AttachCoreResultSchema.parse(await this.options.invoke({ command: 'attach-or-start',
        request: { client: this.options.client, port, existingFingerprint: current.receipt.startFingerprint,
          ...(this.options.reconnectAfterUpgrade ? {reconnectAfterUpgrade:true} : {}) } }, 10_000));
    } catch (error) {
      const code = error instanceof Error ? error.message.split(':')[0] ?? '' : ''; 
      // A bounded retry is safe ONLY for a fingerprint-pinned attach; that
      // request cannot start a new Core, and the Manager reuses an existing
      // lease for this clientInstanceId if its previous reply was lost.
      if (code === 'lock_busy') {
        this.rebindRetryUntil ??= Date.now() + 30_000;
        if (Date.now() < this.rebindRetryUntil) return 'retry';
      }
      this.rebindRetryUntil = undefined;
      return false;
    }
    const a = current.receipt, b = candidate.receipt;
    const sameCore = !candidate.spawned &&
      (['daemonId', 'startFingerprint', 'descriptorHash', 'dataRootId', 'runtimeId',
        'runtimeVersion', 'buildId', 'webBuildId', 'environment', 'cloudOrigin'] as const)
        .every(key => a[key] === b[key]) &&
      a.coreProtocol.min === b.coreProtocol.min && a.coreProtocol.max === b.coreProtocol.max;
    let valid = false;
    try { this.validateAttachment(candidate, port); valid = true; } catch { /* reject unverified receipt */ }
    if (!sameCore || !valid || this.disposed || this.attachment !== current) {
      // Release only a lease the Manager gave to this client; never stop Core.
      if (candidate.lease.clientInstanceId === this.options.client.clientInstanceId)
        await this.detach(candidate).catch(() => {});
      return false;
    }
    this.attachment = candidate;
    this.rebindRetryUntil = undefined;
    this.renewalUnconfirmed = false;
    try { this.options.onReady?.(candidate.receipt); } catch { /* UI callbacks cannot revoke a verified lease. */ }
    try { this.options.onRebound?.(candidate.receipt); } catch { /* Status refresh is best effort. */ }
    return true;
  }
  private async reconnectAfterCommittedUpgrade(current:AttachCoreResult):Promise<boolean> {
    if(!this.options.reconnectAfterUpgrade || !this.port || this.disposed || this.attachment!==current)return false;
    try {
      const result=AttachCoreResultSchema.parse(await this.options.invoke({command:'reconnect-core',request:{
        handle:this.handle(current),client:this.options.client,port:this.port}},10_000));
      this.validateAttachment(result,this.port);
      if(result.spawned || result.receipt.dataRootId!==current.receipt.dataRootId || result.receipt.runtimeId!==current.receipt.runtimeId
        || result.receipt.daemonId===current.receipt.daemonId || result.receipt.startFingerprint===current.receipt.startFingerprint)
        throw Error('managed_receipt_mismatch');
      if(this.disposed || this.attachment!==current){await this.detach(result).catch(()=>{});return false;}
      this.attachment=result;this.awaitingUpgradeSince=undefined;this.renewalUnconfirmed=false;
      try{this.options.onReady?.(result.receipt);this.options.onRebound?.(result.receipt);}catch{/* presentation only */}
      return true;
    }catch(e){
      const code=e instanceof Error?e.message:'';
      if(code==='upgrade_in_progress'||(code==='lock_busy'&&this.awaitingUpgradeSince!==undefined)){
        this.awaitingUpgradeSince ??= Date.now();
        if(Date.now()-this.awaitingUpgradeSince<120_000)return true;
      }
      this.awaitingUpgradeSince=undefined;
      if(['upgrade_recovery_required','maintenance_recovery_required'].includes(code)){
        this.maintenanceUnknown=true;this.options.onLost('maintenance_outcome_requires_inspection');return true;
      }
      return false;
    }
  }

  renew(): Promise<void> {
    if (this.renewing) return this.renewing;
    const current = this.attachment;
    if (!current || this.disposed || this.maintaining || this.upgrading || this.maintenanceUnknown) return Promise.resolve();
    this.clearTimer();
    const lost = async (reason: string): Promise<void> => {
      if (this.attachment !== current) return; // A late timeout cannot revoke a replacement.
      this.attachment = undefined;
      this.awaitingUpgradeSince=undefined;
      this.rebindRetryUntil = undefined;
      this.renewalUnconfirmed = false;
      // Detach only the original binding; a new daemon/lease must never be
      // adopted through a heartbeat retry, even after an unknown outcome.
      try { await this.detach(current); } catch { /* expiry is the conservative fallback */ }
      if (!this.disposed) this.options.onLost(reason);
    };
    const task = (async () => {
      if(this.awaitingUpgradeSince!==undefined){
        if(await this.reconnectAfterCommittedUpgrade(current))return;
        await lost('upgrade_reconnect_unconfirmed');return;
      }
      if (Date.parse(current.lease.expiresAt) <= Date.now()) {
        const recovery = await this.rebindExpiredToSameCore(current);
        if (recovery === true) return;
        if (recovery === 'retry') { this.renewalUnconfirmed = true; return; }
        if (await this.reconnectAfterCommittedUpgrade(current)) return;
        await lost('lease_expired_rebind_unconfirmed');
        return;
      }
      try {
        const lease = ClientLeaseSchema.parse(await this.options.invoke({ command: 'heartbeat', request: { handle: this.handle(current), port: this.port } }, 5_000));
        if (Object.entries(this.handle(current)).some(([key, value]) => lease[key as keyof typeof lease] !== value)
          || lease.clientId !== current.lease.clientId || lease.kind !== 'vscode'
          || lease.runtimeId !== current.lease.runtimeId || lease.buildId !== current.lease.buildId
          || Date.parse(lease.expiresAt) <= Date.now()) throw new Error('lease_target_mismatch');
        if (!this.disposed && this.attachment === current) {
          this.attachment = { ...current, lease };
          this.renewalUnconfirmed = false;
        }
      } catch (error) {
        const code = error instanceof Error ? error.message : '';
        if (['lease_missing','core_identity_conflict','daemon_state_unknown'].includes(code)
          && await this.reconnectAfterCommittedUpgrade(current)) return;
        if (code === 'lease_expired' ||
          (!DEFINITIVE_LEASE_ERRORS.has(code) && Date.parse(current.lease.expiresAt) <= Date.now())) {
          const recovery = await this.rebindExpiredToSameCore(current);
          if (recovery === true) return;
          if (recovery === 'retry') { this.renewalUnconfirmed = true; return; }
          await lost(code === 'lease_expired' ? 'lease_expired_rebind_unconfirmed' : 'lease_expired_after_unconfirmed');
        } else if (DEFINITIVE_LEASE_ERRORS.has(code)) {
          // Revocation or positive identity mismatch is never auto-rebound.
          await lost(code);
        } else if (this.attachment === current && !this.disposed) {
          // Reuse the SAME original lease, never silently call attach-or-start,
          // and never report its unconfirmed health as a successful renewal.
          this.renewalUnconfirmed = true;
        }
      }
    })();
    this.renewing = task;
    // Expired-lease recovery returns before the heartbeat try/catch. Schedule
    // here so every successful renewal/rebind retains a future heartbeat.
    void task.finally(() => {
      if (this.renewing === task) this.renewing = undefined;
      if (!this.disposed) this.schedule();
    }).catch(() => {});
    return task;
  }

  matchesHealth(health: Record<string, unknown>): boolean {
    const a = this.attachment;
    if (!a || this.bindingState !== 'bound') return false;
    const r = a.receipt;
    const fields: Record<string, unknown> = { ok: true, lifecycle_state: 'managed', daemon_id: r.daemonId,
      version: r.daemonVersion, runtime_id: r.runtimeId, runtime_version: r.runtimeVersion,
      build_id: r.buildId, descriptor_hash: r.descriptorHash, data_root_id: r.dataRootId,
      web_build_id: r.webBuildId, core_environment: r.environment, core_cloud_origin: r.cloudOrigin,
      cloud_origin: r.cloudOrigin, start_fingerprint: r.startFingerprint };
    const protocol = health.core_protocol as { min?: unknown; max?: unknown } | undefined;
    return Object.entries(fields).every(([key, value]) => health[key] === value)
      && protocol?.min === r.coreProtocol.min && protocol?.max === r.coreProtocol.max;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.disposed = true;
    this.clearTimer();
    this.closing = (async () => {
      await this.starting?.catch(() => {});
      await this.renewing?.catch(() => {});
      await this.maintaining?.catch(() => {});
      await this.upgrading?.catch(() => {});
      const current = this.attachment;
      this.attachment = undefined;
      if (current) await this.detach(current);
    })();
    return this.closing;
  }
}
