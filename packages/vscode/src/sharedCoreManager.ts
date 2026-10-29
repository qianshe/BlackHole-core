import { useManagedPort } from './managedEndpoint';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolveDataPaths, resolveHostDataEnvironment } from '../../../src/data-paths.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExtensionContext, OutputChannel } from 'vscode';
import { resolveCloudEndpoint } from './cloudEnvironment';
import { ManagedCoreSession, type SessionOptions } from './managedCoreSession';
import { loadHostCoreBuild, acquireHostCore, type CoreDownloadOptions } from './hostCoreBootstrap';
import type { CoreBootstrap } from '../../contracts/src/core-bootstrap';
export type CoreDownloadInteraction = (reference: CoreBootstrap, download: (options: CoreDownloadOptions) => ReturnType<typeof acquireHostCore>) => ReturnType<typeof acquireHostCore>;
import { CoreEndpointSchema, CoreMaintenanceRecordSchema, RunningCoreRecordSchema, StartBundledCoreResultSchema, type StartBundledCoreResult, type ManagedClientSchema } from '../../contracts/src/manager-protocol';

const MAX_OUTPUT = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 120_000;

type ManagerResponse<T> = { ok: true; result: T } | { ok: false; error: { code: string; message: string } };


/** A host package may carry a different Core version; compare versions only
 * for monotonic candidate selection, never as a substitute for signed identity. */
export function compareCoreVersions(candidate: string, installed: string): number {
  const parse = (value: string): number[] => {
    if (!/^(0|[1-9][0-9]*)[.](0|[1-9][0-9]*)[.](0|[1-9][0-9]*)$/.test(value))
      throw new Error('core_version_format_unsupported');
    const parts = value.split('.').map(Number);
    if (!parts.every(Number.isSafeInteger)) throw new Error('core_version_format_unsupported');
    return parts;
  };
  const a = parse(candidate), b = parse(installed);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i]! > b[i]! ? 1 : -1;
  }
  return 0;
}
export class SharedCoreManager {
  readonly clientInstanceId = randomUUID();
  get enabled(): boolean {
    const mode = this.context.extension.packageJSON.blackholeSharedCore?.mode;
    if (mode !== undefined && mode !== 'bridge' && mode !== 'host-node') throw new Error('shared_core_build_mode_invalid');
    // An unsupported managed build must fail explicitly, never enable legacy.
    return mode === 'host-node' || (mode === 'bridge' && process.platform === 'win32' && process.arch === 'x64');
  }
  get hostProvided(): boolean { return this.context.extension.packageJSON.blackholeSharedCore?.mode === 'host-node'; }
  readonly storeRoot: string;
  readonly dataRoot: string;
  readonly dataRootId: string;
  private readonly managerEnv: NodeJS.ProcessEnv;
  private readonly sessions = new Set<ManagedCoreSession>();
  private readonly managerEntry: string;
  private readonly trustConfig: string;
  private readonly seedArchive: string | undefined;

  constructor(private readonly context: ExtensionContext, private readonly log: OutputChannel, private readonly downloadInteraction?: CoreDownloadInteraction) {
    const test = resolveCloudEndpoint().environment === 'test';
    // Interactive Test VS Code may start a public channel only after an
    // explicit UI action. Tests/operators that set BLACKHOLE_TUNNEL=off
    // keep the hard prohibition; production policy is unchanged.
    const nativeEnv = test && this.hostProvided && process.env.BLACKHOLE_TUNNEL === undefined
      ? { ...process.env, BLACKHOLE_TUNNEL: 'manual' } : process.env;
    this.managerEnv = resolveHostDataEnvironment({ environment: test ? 'test' : 'production', env: nativeEnv });
    const data = resolveDataPaths({ env: this.managerEnv });
    this.storeRoot = data.coreStore;
    this.dataRoot = data.root; this.dataRootId = data.dataRootId;
    this.managerEntry = path.join(context.extensionPath, 'dist', 'manager', 'core-manager-cli.mjs');
    this.trustConfig = path.join(context.extensionPath, 'dist', this.hostProvided ? 'manager' : 'seed-core', 'trust.json');
    this.seedArchive = this.hostProvided ? undefined : path.join(context.extensionPath, 'dist', 'seed-core', 'core-win32-x64.zip');
  }

  private invoke<T>(request: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    if (!fs.existsSync(this.managerEntry)) throw new Error('shared_core_manager_missing');
    if (this.hostProvided) this.hostCoreReference();
    if (request.command !== 'detach') {
      if (fs.statSync(this.trustConfig).size > 1024 * 1024) throw new Error('trust_config_invalid');
      const trust = JSON.parse(fs.readFileSync(this.trustConfig, 'utf8'));
      if (trust.environment !== resolveCloudEndpoint().environment || !trust.publicKeys || !Object.keys(trust.publicKeys).length
        || (trust.environment === 'production' && Object.keys(trust.publicKeys).some(key => /^test[-_]/i.test(key)))) throw new Error('trust_config_invalid');
    }
    const payload = JSON.stringify(request);
    if (Buffer.byteLength(payload) > 1024 * 1024) throw new Error('shared_core_manager_request_too_large');
    const env = { ...this.managerEnv };
    for (const key of Object.keys(env)) if (['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE', 'BH_CORE_STORE', 'BH_CORE_TRUST_CONFIG'].includes(key.toUpperCase())) delete env[key];
    Object.assign(env, { ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}), BH_CORE_STORE: this.storeRoot, BH_CORE_TRUST_CONFIG: this.trustConfig });
    return new Promise<T>((resolve, reject) => {
      const child = spawn(process.execPath, [this.managerEntry], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
      });
      let stdout = '', stderr = '', settled = false;
      const finish = (error?: Error, value?: T) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value as T); };
      const timer = setTimeout(() => { child.kill(); finish(new Error('shared_core_manager_timeout')); }, timeoutMs);
      child.stdout.on('data', (chunk) => { stdout += chunk; if (Buffer.byteLength(stdout) > MAX_OUTPUT) { child.kill(); finish(new Error('shared_core_manager_output_too_large')); } });
      child.stderr.on('data', (chunk) => { stderr += chunk; if (Buffer.byteLength(stderr) > MAX_OUTPUT) { child.kill(); finish(new Error('shared_core_manager_error_too_large')); } });
      child.on('error', (error) => finish(error));
      child.on('close', (code) => {
        if (settled) return;
        let response: ManagerResponse<T>;
        try { response = JSON.parse(stdout.trim()) as ManagerResponse<T>; if (!response || typeof response !== 'object' || typeof response.ok !== 'boolean' || (!response.ok && (!response.error || typeof response.error.code !== 'string' || !/^[a-z][a-z0-9_]{0,199}$/.test(response.error.code)))) throw new Error('invalid_response'); } catch { finish(new Error('shared_core_manager_invalid_response')); return; }
        if (code !== 0 || !response.ok) { const detail = response.ok ? `exit_${code}` : response.error.code; finish(new Error(detail)); return; }
        finish(undefined, response.result);
      });
      child.stdin.on('error', () => finish(new Error('shared_core_manager_input_failed')));
      child.stdin.end(payload);
    });
  }

  private hostCoreReference(): CoreBootstrap {
    return loadHostCoreBuild(this.context.extensionPath, this.context.extension.packageJSON.blackholeSharedCore, resolveCloudEndpoint());
  }

  /** Stage the immutable Core carried by this VSIX into the single shared
   * store. Staging never changes the active pointer or a running daemon. */
  private async stageBundledCore(reference: CoreBootstrap): Promise<string> {
    if (reference.source.kind !== 'embedded') throw Error('bundled_core_required');
    const file = await acquireHostCore(reference, this.context.extensionPath, path.join(this.dataRoot, 'updates', 'core'));
    try {
      const prepared = await this.invoke<{ descriptorHash: string; descriptor: { runtimeVersion: string; buildId: string } }>({
        command: 'provision', source: 'seed', archive: file.archive,
      });
      if (prepared.descriptorHash !== reference.descriptorHash || prepared.descriptor.runtimeVersion !== reference.runtimeVersion
        || prepared.descriptor.buildId !== reference.buildId) throw Error('bundled_core_identity_conflict');
      const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
      return `${safe(reference.runtimeVersion)}-${safe(reference.buildId)}`;
    } finally { file.cleanup(); }
  }

  /** A newer VSIX can ship a newer signed Core without overriding other
   * clients. A live Core always wins; a definitively stopped Core may be
   * promoted only via Manager's version/schema/lease-guarded cold CAS. */
  private async considerBundledCore(port: number): Promise<void> {
    const reference = this.hostCoreReference();
    if (reference.source.kind !== 'embedded') return;
    const selected = await this.selectActive();
    if (!selected || compareCoreVersions(reference.runtimeVersion, selected.identity.runtimeVersion) <= 0) return;
    const running = await this.inspectStart();
    if (running) {
      const staged = await this.stageBundledCore(reference);
      this.log.appendLine(`Shared Core ${staged} verified and staged; active Core ${running.versionName} stays running until guarded maintenance.`);
      return;
    }
    try {
      const selectedVersion = await this.activateBundledCoreCold(port);
      this.log.appendLine(`Verified newer bundled Core selected for safe cold startup: ${selectedVersion}`);
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      // Positive cold-activation refusals leave the active pointer unchanged.
      // Unknown results may have switched it: never blindly retry or attach.
      if (['active_clients', 'data_migration_explicit_required', 'data_schema_incompatible',
        'core_protocol_incompatible', 'migration_pending', 'daemon_state_unknown',
        'endpoint_changed', 'core_update_not_newer', 'lock_busy',
        'maintenance_recovery_required', 'upgrade_recovery_required'].includes(code)) {
        this.log.appendLine(`Bundled Core ${reference.runtimeVersion} cold update deferred: ${code}; current signed Core retained.`);
        return;
      }
      throw error;
    }
  }

  private async requireFixedMcpCore(): Promise<void> {
    const selected = await this.selectActive();
    // 0.4.0/0.4.1 lack the account read-through fix, and 0.4.2's signed
    // Core fails its Web integrity check after installing with a sibling web/
    // directory, rejecting guide/exec with 503. No older managed Core may be
    // mistaken for the fixed 0.4.3 bundle, including concurrent provisioning.
    const version = selected?.identity.runtimeVersion;
    const parts = typeof version === 'string' && /^\d+[.]\d+[.]\d+$/.test(version) ? version.split('.').map(Number) : null;
    if (!parts || parts[0]! === 0 && (parts[1]! < 4 || parts[1] === 4 && parts[2]! < 3))
      throw Error('bundled_core_update_required');
    // Semver alone is not enough: two local Test builds can share a version
    // while signing different Core bytes. Never report "0.4.3 installed" if
    // the active descriptor is not the one pinned in this VSIX. A future,
    // protocol-compatible release can still be reused across thin clients.
    const bundled = this.hostCoreReference();
    if (version === bundled.runtimeVersion && selected?.identity.descriptorHash !== bundled.descriptorHash)
      throw Error('bundled_core_update_required');
  }

  private async ensureHostCore(input: unknown): Promise<unknown> {
    const port = (input as { port?: unknown } | null)?.port;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)
      throw Error('port_invalid');
    // Package upgrades may add a newer verified Core without taking down the
    // already running one. Cold activation remains a Manager-guarded transaction.
    await this.considerBundledCore(port);
    // Only a conclusive core_missing response permits first-time acquisition.
    // Busy/legacy/corrupt/unknown states never download or start an alternate.
    try {
      const result = await this.invoke({ command: 'ensure-core', request: input });
      await this.requireFixedMcpCore();
      return result;
    } catch (error) { if (!(error instanceof Error) || error.message !== 'core_missing') throw error; }
    const reference = this.hostCoreReference();
    const download = (options: CoreDownloadOptions) => acquireHostCore(reference, this.context.extensionPath, path.join(this.dataRoot, 'updates', 'core'), options);
    const acquired = reference.source.kind === 'embedded' ? await download({})
      : this.downloadInteraction ? await this.downloadInteraction(reference, download)
      : (() => { throw Error('core_download_confirmation_required'); })();
    try {
      const request = input as Record<string, unknown>;
      const result = await this.invoke({ command: 'ensure-core', request: { ...request, seedArchive: acquired.archive, seedArchiveHash: reference.archiveHash } });
      await this.requireFixedMcpCore();
      return result;
    } finally { acquired.cleanup(); }
  }

  /** Version discovery comes from the signed VSIX and the Manager's current
   * running receipt; it never reads a remote update feed or uses Web input. */
  async bundledCoreUpdateStatus(): Promise<{
    runningVersion: string; bundledVersion: string; targetVersionName: string; descriptorHash: string;
  } | null> {
    if (!this.hostProvided) return null;
    const reference = this.hostCoreReference();
    if (reference.source.kind !== 'embedded') return null;
    const current = await this.inspectStart();
    const selected = current?.receipt ?? (await this.selectActive())?.identity;
    if (!selected || compareCoreVersions(reference.runtimeVersion, selected.runtimeVersion) <= 0)
      return null;
    return { runningVersion: selected.runtimeVersion, bundledVersion: reference.runtimeVersion,
      targetVersionName: `${reference.runtimeVersion}-${reference.buildId}`, descriptorHash: reference.descriptorHash };
  }

  /** A native host confirmation is required before touching a live Core.
   * Staging is harmless. The existing Manager handles the journalled upgrade,
   * task/peer refusal, signed Stop and verified restart/rollback. */
  async applyBundledCoreUpdate(session: ManagedCoreSession): Promise<'committed' | 'rolled_back'> {
    const reference = this.hostCoreReference();
    if (reference.source.kind !== 'embedded') throw Error('bundled_core_required');
    const status = await this.bundledCoreUpdateStatus();
    if (!status) throw Error('core_update_not_newer');
    const old = session.receipt;
    if (!old || session.bindingState !== 'bound') throw Error('managed_core_lease_required');
    if (old.runtimeVersion !== status.runningVersion) throw Error('core_update_target_changed');
    const running = await this.inspectStart();
    const selected = await this.selectActive();
    if (!running || running.status !== 'ready' || !running.receipt
      || running.receipt.daemonId !== old.daemonId
      || running.receipt.startFingerprint !== old.startFingerprint
      || running.descriptorHash !== old.descriptorHash
      || selected?.identity.descriptorHash !== old.descriptorHash)
      throw Error('core_update_target_changed');
    const versionName = await this.stageBundledCore(reference);
    const result = await session.upgradeCore(versionName, reference.descriptorHash);
    if (result.state === 'rolled_back') return 'rolled_back';
    const after = await this.inspectStart();
    const selectedAfter = await this.selectActive();
    if (!after || after.status !== 'ready' || !after.receipt
      || after.receipt.daemonId !== result.attachment.receipt.daemonId
      || after.receipt.descriptorHash !== reference.descriptorHash
      || selectedAfter?.identity.descriptorHash !== reference.descriptorHash)
      throw Error('core_upgrade_outcome_requires_inspection');
    return 'committed';
  }

  private async startFromBundle(client: SessionOptions['client'], port: number): Promise<StartBundledCoreResult> {
    const reference=this.hostCoreReference();
    const versionName=await this.stageBundledCore(reference);
    const invokeStart = () => this.invoke({command:'start-bundled-core',request:{
      client,port,versionName,descriptorHash:reference.descriptorHash,requestId:randomUUID(),reconnectAfterUpgrade:true,
    }});
    let raw: unknown;
    try {
      raw = await invokeStart();
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'daemon_state_unknown') throw error;
      const running = await this.inspectStart().catch(() => null);
      if (!running || running.status !== 'ready' || !running.receipt) throw error;
      try { await this.recoverStart(running); } catch { throw error; }
      this.log.appendLine(`Recovered stale Shared Core start record (${running.startFingerprint}) after verified process exit.`);
      raw = await invokeStart();
    }
    const startup=StartBundledCoreResultSchema.parse(raw);
    const receipt=startup.attachment.receipt;
    if (startup.targetVersionName!==versionName || (receipt.runtimeVersion===reference.runtimeVersion && receipt.descriptorHash!==reference.descriptorHash)
      || (compareCoreVersions(receipt.runtimeVersion,reference.runtimeVersion)<0 && !['deferred','rolled_back'].includes(startup.state)))
      throw Error('core_bootstrap_receipt_mismatch');
    this.log.appendLine(`Bundled Core startup ${startup.state}: running ${receipt.runtimeVersion}, bundled ${reference.runtimeVersion}${startup.reason ? '; '+startup.reason : ''}.`);
    return startup;
  }

  createSession(onLost: (reason?: string) => void, onRebound?: () => void): ManagedCoreSession {
    const endpoint = resolveCloudEndpoint();
    const client: SessionOptions['client']={clientId:`vscode:${this.context.extension.id}`,clientInstanceId:this.clientInstanceId,
      kind:'vscode',version:this.context.extension.packageJSON.version,protocol:{min:1,max:1},capabilities:['web-ui']};
    const session = new ManagedCoreSession({ invoke: <T>(request: Record<string, unknown>, timeout?: number): Promise<T> =>
      this.hostProvided && request.command === 'ensure-core'
        ? this.ensureHostCore(request.request).then(result => result as T)
        : this.invoke<T>(request, timeout),
      client,
      ...(this.hostProvided && this.hostCoreReference().source.kind==='embedded' ? {bootstrap:(port:number)=>this.startFromBundle(client,port),reconnectAfterUpgrade:true as const} : {}),
      dataRootId: this.dataRootId, resolvePort: async fallback => (await this.resolveEndpoint(fallback)).port, onReady: r => useManagedPort(Number(new URL(r.localUrl).port)),
      seedArchive: this.seedArchive, environment: endpoint.environment, cloudOrigin: endpoint.origin, onLost, onRebound });
    this.sessions.add(session);
    return session;
  }

  async resolveEndpoint(fallbackPort: number) {
    const endpoint = CoreEndpointSchema.parse(await this.invoke({ command: 'resolve-endpoint', request: { fallbackPort } }));
    if (endpoint.dataRootId !== this.dataRootId) throw new Error('data_root_conflict');
    return endpoint;
  }
  async configureEndpoint(expected: { port: number; revision: number }, port: number) {
    const endpoint = CoreEndpointSchema.parse(await this.invoke({ command: 'configure-endpoint', request: { confirmed: true, expectedPort: expected.port, expectedRevision: expected.revision, port } }));
    if (endpoint.dataRootId !== this.dataRootId || endpoint.port !== port || endpoint.revision !== expected.revision + (expected.port === port ? 0 : 1)) throw new Error('endpoint_outcome_unknown');
    return endpoint;
  }
  async inspectMaintenances() {
    const records = CoreMaintenanceRecordSchema.array().parse(await this.invoke({ command: 'inspect-maintenances' }));
    if (records.some(r => r.target.dataRootId !== this.dataRootId)) throw new Error('data_root_conflict');
    return records;
  }
  async recoverMaintenance(requestId: string, currentFingerprint?: string): Promise<void> {
    const result = await this.invoke<{ recovered?: boolean; restarted?: boolean; requestId?: string; observed?: string }>({ command: 'recover-maintenance', request: { confirmed: true, requestId, ...(currentFingerprint ? { currentFingerprint } : {}) } });
    if (result.recovered !== true || result.restarted !== false || result.requestId !== requestId || (currentFingerprint ? result.observed !== 'running' : result.observed !== undefined)) throw new Error('maintenance_outcome_unknown');
  }
  async inspectStart() {
    const record = await this.invoke({ command: 'inspect-start' });
    return record === null ? null : RunningCoreRecordSchema.parse(record);
  }

  async recoverStart(record: { dataRootId: string; descriptorHash: string; startFingerprint: string }): Promise<void> {
    await this.invoke({ command: 'recover-start', request: { confirmed: true, dataRootId: record.dataRootId, descriptorHash: record.descriptorHash, startFingerprint: record.startFingerprint } });
  }

  async close(): Promise<void> { await Promise.all([...this.sessions].map(session => session.close())); }
  dispose(): void { void this.close().catch(() => this.log.appendLine('Shared Core detach was not confirmed; lease will expire. Core was not stopped.')); }

  async provisionSeed(): Promise<{ descriptorHash: string; descriptor: { runtimeId: string; runtimeVersion: string; buildId: string } }> {
    if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('shared_core_seed_platform_unsupported');
    if (!this.seedArchive || !fs.existsSync(this.seedArchive) || !fs.existsSync(this.trustConfig)) throw new Error('shared_core_seed_missing');
    return this.invoke({ command: 'provision', archive: this.seedArchive, source: 'seed' });
  }

  async registerClient(): Promise<void> {
    await this.invoke({ command: 'register-client', client: { clientId: `vscode:${this.context.extension.id}`, kind: 'vscode', version: this.context.extension.packageJSON.version, protocol: { min: 1, max: 1 }, capabilities: ['bridge-v1'] } });
  }

  async writeLease(identity: { runtimeId: string; buildId: string; descriptorHash: string }, daemonId: string, dataRoot: string, ttlMs = 45_000): Promise<string> {
    const now = Date.now(), leaseId = randomUUID();
    await this.invoke({ command: 'write-lease', lease: { schemaVersion: 1, leaseId, clientId: `vscode:${this.context.extension.id}`, clientInstanceId: this.clientInstanceId, kind: 'vscode', ...identity, dataRootId: resolveDataPaths({ env: { BLACKHOLE_HOME: dataRoot } }).dataRootId, daemonId, issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + ttlMs).toISOString() } });
    return leaseId;
  }

  /** Explicit native cold upgrade of an embedded, signed Core code package.
   * Cannot stop a daemon, bypass a stale running guard, or accept a Web path. */
  async activateBundledCoreCold(port: number): Promise<string> {
    if (!this.hostProvided || !Number.isInteger(port) || port < 1024 || port > 65535) throw Error('bundled_core_action_unavailable');
    const reference = this.hostCoreReference();
    if (reference.source.kind !== 'embedded') throw Error('bundled_core_required');
    const existing = await this.selectActive();
    const running = await this.inspectStart();
    if (running) throw Error('daemon_state_unknown');
    const versionName = await this.stageBundledCore(reference);
    if (existing?.versionName === versionName && existing.identity.descriptorHash === reference.descriptorHash) return versionName;
    const selection = await this.invoke<{ versionName: string }>({
      command: 'activate-cold-core',
      request: { versionName, port, expectedVersionName: existing?.versionName ?? null,
        expectedDescriptorHash: existing?.identity.descriptorHash ?? null },
    });
    if (selection.versionName !== versionName) throw Error('core_selection_outcome_unknown');
    return versionName;
  }

  async selectActive(): Promise<{ versionName: string; root: string; identity: { runtimeId: string; runtimeVersion: string; buildId: string; descriptorHash: string; webBuildId: string; coreProtocol: { min: number; max: number }; environment: 'test' | 'production'; cloudOrigin: string } } | null> {
    return this.invoke({ command: 'select' });
  }

  async activate(versionName: string, port: number): Promise<void> {
    await this.invoke({ command: 'activate-cold-core', request: { versionName, port } });
  }

  async prepareBridge(): Promise<{ runtimeId: string; runtimeVersion: string; buildId: string; descriptorHash: string }> {
    await this.registerClient();
    const provisioned = await this.provisionSeed();
    this.log.appendLine(`Shared Core staged: ${provisioned.descriptor.runtimeVersion}/${provisioned.descriptor.buildId}`);
    return { ...provisioned.descriptor, descriptorHash: provisioned.descriptorHash };
  }
}
