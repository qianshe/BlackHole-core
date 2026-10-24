import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID, createHash, createPublicKey } from 'node:crypto';
import { z } from 'zod';
import { CoreManager, coreVersionName } from './core-manager.ts';
import { selectCoreNodeRuntime, coreNodeEnvironment } from './core-node-provider.ts';
import { dataRootIdentity, resolveDataPaths, resolveHostDataEnvironment } from '../../../src/data-paths.ts';
import { ClientLeaseSchema, type CoreDescriptor, type ClientLease } from '../../contracts/src/core-runtime.ts';
import { StartBundledCoreRequestSchema, StartBundledCoreResultSchema, type StartBundledCoreResult } from '../../contracts/src/manager-protocol.ts';
import {
  CoreEndpointSchema, ConfigureCoreEndpointSchema, MaintainCoreRequestSchema, CoreMaintenanceRecordSchema, AttachCoreRequestSchema, AttachCoreResultSchema, HeartbeatCoreRequestSchema, ManagedClientSchema,
  LeaseHandleSchema, ManagedReadyReceiptSchema, RunningCoreRecordSchema, UpgradeCoreRequestSchema, CoreUpgradeRecordSchema, UpgradeCoreResultSchema,
  type AttachCoreResult, type CoreUpgradeRecord, type ManagedReadyReceipt, type RunningCoreRecord, type UpgradeCoreResult,
} from '../../contracts/src/manager-protocol.ts';
// @ts-ignore JavaScript verifier is bundled with the Manager.
import { verifyInstalledCore, extractVerifiedCoreArchive } from '../../../scripts/core-runtime-lib.mjs';

export const LEASE_TTL_MS = 45_000;
/** A managed Core refreshes its heartbeat lease every 10 s; six missed beats
 *  mean the process is gone even though its PID may have been recycled. */
const HEARTBEAT_STALE_MS = 60_000;
const MAX_HTTP_BYTES = 256 * 1024;
const healthSchema = z.object({
  ok: z.literal(true), version: z.string().min(1), daemon_id: z.string().min(1).max(200),
  start_fingerprint: z.string().min(1).max(500), db_path: z.string().min(1),
  runtime_id: z.string().min(1), runtime_version: z.string().min(1), build_id: z.string().min(1),
  descriptor_hash: z.string(), data_root_id: z.string(), web_build_id: z.string(),
  core_protocol: z.object({ min: z.number().int(), max: z.number().int() }),
  core_environment: z.enum(['test', 'production']), core_cloud_origin: z.string(),
  lifecycle_settings_version: z.literal(1).optional(), started_settings_revision: z.number().int().nonnegative().optional(),
  lifecycle_control_version: z.literal(1).optional(), lifecycle_manager_key_hash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  maintenance_idle: z.boolean().optional(),
  lifecycle_upgrade_version: z.literal(1).optional(), upgrade_idle:z.boolean().optional(),
  cloud_origin: z.string(), lifecycle_state: z.literal('managed'),
  settings_revision: z.number().int().nonnegative(),
});
type Health = z.infer<typeof healthSchema>;
const UpgradeParticipantSchema = z.object({schemaVersion:z.literal(1),handle:LeaseHandleSchema,client:ManagedClientSchema,
  environment:z.enum(['test','production']),trustedKeyHashes:z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(32),
  updatedAt:z.string().datetime({offset:true})}).strict();
function signingKeyHash(pem:string):string {
  const key=createPublicKey(pem);
  if(key.asymmetricKeyType!=='ed25519') return error('trust_config_invalid');
  return createHash('sha256').update(key.export({type:'spki',format:'der'})).digest('hex');
}
export type CoreTrust = { publicKeys: Record<string, string>; environment: 'test' | 'production' };
const error = (code: string): never => { throw new Error(code); };

function compareRuntimeVersions(a: string, b: string): number {
  const parse = (value: string) => (/^\d+\.\d+\.\d+$/.test(value) ? value.split('.').map(Number) : undefined);
  const left = parse(a), right = parse(b);
  if (!left || !right) return a === b ? 0 : (a < b ? -1 : 1);
  for (let index = 0; index < 3; index++) { const diff = (left[index] ?? 0) - (right[index] ?? 0); if (diff !== 0) return diff; }
  return 0;
}
const samePath = (a: string, b: string) => {
  const normalize = (value: string) => process.platform === 'win32' || process.platform === 'darwin' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(a) === normalize(b);
};
// Resolve existing ancestors too, so a not-yet-created root under a junction
// cannot get a second data-root identity or escape the store/data separation.
function physicalPath(input: string): string {
  const absolute = path.resolve(input);
  if (fs.existsSync(absolute)) return fs.realpathSync(absolute);
  const parent = path.dirname(absolute);
  if (parent === absolute) return absolute;
  return path.join(physicalPath(parent), path.basename(absolute));
}
function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
}
function readJson(file: string): unknown {
  try {
    if (fs.statSync(file).size > 64 * 1024) return error('lifecycle_state_unknown');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return error('lifecycle_state_unknown'); }
}

// Only a positively refused loopback connection means "down". A timeout,
// malformed response, redirect or HTTP error never permits spawning.
export function getLocal(port: number, route: string, timeoutMs = 2_000): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: route, agent: false }, (res) => {
      const chunks: Buffer[] = []; let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_HTTP_BYTES) { res.destroy(new Error('daemon_response_too_large')); return; }
        chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    // A wall-clock deadline also bounds peers that drip bytes forever.
    const timer = setTimeout(() => req.destroy(new Error('daemon_probe_unknown')), timeoutMs);
    req.once('close', () => clearTimeout(timer));
    req.once('error', reject);
  });
}
async function postLocal(port: number, route: string, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const bytes = Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, path: route, method: 'POST', agent: false,
      headers: { 'content-type': 'application/json', 'content-length': bytes.length } }, res => {
      const chunks: Buffer[] = []; let size = 0;
      res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > MAX_HTTP_BYTES) { res.destroy(new Error('maintenance_response_too_large')); return; } chunks.push(chunk); });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    const timer = setTimeout(() => req.destroy(new Error('maintenance_outcome_unknown')), 5000);
    req.once('close', () => clearTimeout(timer)); req.once('error', () => reject(new Error('maintenance_outcome_unknown'))); req.end(bytes);
  });
}

async function probe(port: number, starting = false): Promise<Health | undefined> {
  let response;
  try { response = await getLocal(port, '/api/health'); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ECONNREFUSED') return undefined;
    // After our single recorded spawn, a slow first health read may be retried
    // inside that launch's readiness deadline. This never grants another spawn.
    if (starting && e instanceof Error && (e.message === 'daemon_probe_unknown' || (e as NodeJS.ErrnoException).code === 'ECONNRESET')) return undefined;
    return error('daemon_probe_unknown');
  }
  if (starting && (response.status === 404 || response.status === 503)) return undefined;
  if (response.status !== 200) return error('foreign_listener');
  let parsed;
  try { parsed = healthSchema.safeParse(JSON.parse(response.body)); } catch { return error('foreign_listener'); }
  if (!parsed.success) return error('managed_core_required');
  return parsed.data;
}

/** A v200 owner has no Manager journal. A different port is NOT proof that the
 * sole user database is available. The injected reader is for isolated tests. */
export async function assertNoLegacyDataOwner(db: string, port: number, read: typeof getLocal = getLocal): Promise<void> {
  if (port === 7306) return; // Normal target-port validation already checks it.
  let response: { status: number; body: string };
  try { response = await read(7306, '/api/health'); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ECONNREFUSED') return;
    return error('data_owner_state_unknown');
  }
  let health: { db_path?: unknown };
  try { health = JSON.parse(response.body); } catch { return error('data_owner_state_unknown'); }
  if (response.status !== 200 || typeof health?.db_path !== 'string' || !path.isAbsolute(health.db_path)) return error('data_owner_state_unknown');
  if (samePath(physicalPath(health.db_path), physicalPath(db))) return error('data_root_in_use');
}

/** Host-neutral lifecycle seam; mutations require explicit, bound maintenance. */
export class CoreLifecycle {
  readonly env: NodeJS.ProcessEnv;
  constructor(readonly manager: CoreManager, readonly trust: CoreTrust, env: NodeJS.ProcessEnv = process.env) {
    this.env = resolveHostDataEnvironment({ environment: trust.environment, env });
  }

  private paths() {
    const raw = resolveDataPaths({ env: this.env, coreStoreRoot: this.manager.root });
    const root = physicalPath(raw.root), db = physicalPath(raw.db), store = physicalPath(this.manager.root);
    const relativeDb = path.relative(store, db);
    if (!relativeDb.startsWith('..') && !path.isAbsolute(relativeDb)) return error('data_root_inside_core_store');
    for (const member of ['versions', 'staging']) {
      const relative = path.relative(path.join(store, member), root);
      if (!relative.startsWith('..') && !path.isAbsolute(relative)) return error('data_root_inside_core_store');
    }
    return { ...raw, root, db, dataRootId: dataRootIdentity(root) };
  }
  private endpointFile(): string { return path.join(this.manager.state, 'endpoints', this.paths().dataRootId + '.json'); }
  private endpointState(fallbackPort: number) {
    const data = this.paths(), file = this.endpointFile(), run = this.readRun(data.dataRootId);
    const saved = fs.existsSync(file) ? CoreEndpointSchema.parse(readJson(file)) : undefined;
    if (saved && (saved.dataRootId !== data.dataRootId || (run && saved.port !== run.port))) return error('endpoint_state_unknown');
    const result = CoreEndpointSchema.parse(saved ?? { schemaVersion: 1, dataRootId: data.dataRootId, port: run?.port ?? fallbackPort, revision: 0 });
    // Test and production share the same canonical local endpoint. Runtime
    // identity, signed origin and ownership are still verified before attach.
    return result;
  }
  async resolveEndpoint(input: unknown) {
    const request = z.object({ fallbackPort: z.number().int().min(1).max(65535) }).strict().parse(input);
    return this.locked(async () => this.endpointState(request.fallbackPort));
  }
  /** A cold CAS, never a shortcut around the protected Stop transaction. */
  async configureEndpoint(input: unknown) {
    const request = ConfigureCoreEndpointSchema.parse(input);
    return this.locked(async () => {
      const data = this.paths(), current = this.endpointState(request.expectedPort);
      if (current.revision !== request.expectedRevision || current.port !== request.expectedPort) return error('endpoint_revision_conflict');
      if (this.pendingMaintenance().length) return error('maintenance_recovery_required');
      // A stopped daemon does not mean an upgrade has finished: its journal
      // still binds recovery to the original endpoint. Unknown journals throw.
      if (this.pendingUpgrades().length) return error('upgrade_recovery_required');
      if (this.readRun(data.dataRootId)) return error('core_stop_required');
      if (this.manager.liveLeases().some(l => l.dataRootId === data.dataRootId)) return error('active_clients');
      // Both ports must be positively closed. No malformed/foreign listener fallback.
      if (await probe(current.port) || (request.port !== current.port && await probe(request.port))) return error('endpoint_in_use');
      if (current.port === request.port) return current;
      const next = CoreEndpointSchema.parse({ ...current, port: request.port, revision: current.revision + 1 });
      writeJson(this.endpointFile(), next);
      return next;
    });
  }
  async inspectMaintenances() {
    return this.locked(async () => this.pendingMaintenance().filter(m => m.target.dataRootId === this.paths().dataRootId));
  }

  private runFile(id: string) { return path.join(this.manager.state, 'running', `${id}.json`); }
  private readRun(id: string): RunningCoreRecord | undefined {
    const file = this.runFile(id);
    if (!fs.existsSync(file)) return undefined;
    const record = RunningCoreRecordSchema.parse(readJson(file));
    if (record.dataRootId !== id) return error('lifecycle_state_unknown');
    return record;
  }
  private saveRun(record: RunningCoreRecord) {
    // Stamp the boot that wrote this record so a later boot can prove the
    // recorded PID cannot be this incarnation, even if the number was reused.
    writeJson(this.runFile(record.dataRootId), RunningCoreRecordSchema.parse({ bootId: this.manager.bootIdentity(), ...record }));
  }
  private heartbeatFile(id: string) { return path.join(this.manager.alive, `${id}.json`); }
  private readHeartbeat(record: { dataRootId: string }) {
    try {
      const raw = JSON.parse(fs.readFileSync(this.heartbeatFile(record.dataRootId), 'utf8')) as { startFingerprint?: unknown; at?: unknown };
      if (typeof raw.startFingerprint !== 'string' || typeof raw.at !== 'number' || !Number.isFinite(raw.at)) return undefined;
      return { startFingerprint: raw.startFingerprint, at: raw.at };
    } catch { return undefined; }
  }
  /** Positive evidence that the recorded incarnation cannot still be running.
   *
   * `process.kill(pid, 0)` alone is NOT sufficient: Windows recycles PIDs, so a
   * stale record can name a live but unrelated process, and every recovery path
   * would then refuse forever. Two independent proofs are added and either one
   * is enough — the record was written in an earlier boot, or this release's
   * Core stopped refreshing its heartbeat lease. */
  private staleRunIsDead(record: RunningCoreRecord, now = this.manager.clock().getTime()): boolean {
    if (!record.pid) return false;
    try { process.kill(record.pid, 0); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') return true; }
    // The PID answers, but it is probably a recycled one. Only records written
    // by this release carry both a bootId and a heartbeat lease.
    if (!record.bootId) return false;
    if (record.bootId !== this.manager.bootIdentity()) return true;
    // A `starting` record may simply belong to a slow launch that has not
    // reached health yet, so the lease rule applies to `ready` records only.
    if (record.status !== 'ready') return false;
    // A lease written by a different incarnation says nothing about this one.
    const beat = this.readHeartbeat(record);
    if (beat && beat.startFingerprint === record.startFingerprint) return now - beat.at > HEARTBEAT_STALE_MS;
    // A ready record from this release implies a Core that heartbeats, so a
    // missing lease only expires together with the record itself.
    try { return now - fs.statSync(this.runFile(record.dataRootId)).mtimeMs > HEARTBEAT_STALE_MS; } catch { return false; }
  }
  /** Move a proven-dead guard out of the way. Never deletes: the record is the
   *  only audit trail of what this Manager once launched. */
  private archiveRun(id: string, name?: string): void {
    const audit = path.join(this.manager.state, 'recovered-starts');
    fs.mkdirSync(audit, { recursive: true });
    fs.renameSync(this.runFile(id), path.join(audit, `${id}-${name ?? randomUUID()}.json`));
    try { fs.rmSync(this.heartbeatFile(id), { force: true }); } catch { /* advisory */ }
    try { fs.rmSync(path.join(this.manager.state, 'idle', `${id}.json`), { force: true }); } catch { /* advisory */ }
  }
  private async locked<T>(action: () => Promise<T>): Promise<T> {
    // Global order: install -> lifecycle. GC cannot remove a candidate between
    // verification and the ready/lease record; activation cannot race spawn.
    return this.manager.withLock('install', () => this.manager.withLock('lifecycle', action));
  }
  private async checkLegacyDataOwner(port: number): Promise<void> {
    await assertNoLegacyDataOwner(this.paths().db, port);
  }

  private checkDatabaseBinding(dataRootId: string, db: string, port: number): void {
    const dir = path.join(this.manager.state, 'running');
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir).filter((name) => name.endsWith('.json'))) {
      const record = RunningCoreRecordSchema.parse(readJson(path.join(dir, name)));
      if ((record.dataRootId === dataRootId || samePath(record.dbPath, db)) && (record.dataRootId !== dataRootId || record.port !== port || !samePath(record.dbPath, db))) error('data_root_conflict');
    }
  }
  private validateHealth(health: Health, descriptor: CoreDescriptor, hash: string, dataRootId: string, db: string, fingerprint?: string): void {
    const expected: Array<[unknown, unknown]> = [
      [health.version, descriptor.daemonVersion], [health.runtime_id, descriptor.runtimeId],
      [health.runtime_version, descriptor.runtimeVersion], [health.build_id, descriptor.buildId],
      [health.descriptor_hash, hash], [health.data_root_id, dataRootId],
      [health.web_build_id, descriptor.webBuildId], [health.core_environment, descriptor.environment],
      [health.core_cloud_origin, descriptor.cloudOrigin], [health.cloud_origin, descriptor.cloudOrigin],
      [health.core_protocol.min, descriptor.coreProtocol.min], [health.core_protocol.max, descriptor.coreProtocol.max],
    ];
    if (expected.some(([actual, wanted]) => actual !== wanted) || !samePath(physicalPath(health.db_path), db) || (fingerprint && health.start_fingerprint !== fingerprint)) error('core_identity_conflict');
  }
  private receipt(health: Health, descriptor: CoreDescriptor, hash: string, port: number): ManagedReadyReceipt {
    return ManagedReadyReceiptSchema.parse({
      protocolVersion: Math.min(1, descriptor.coreProtocol.max), instanceKey: health.data_root_id,
      daemonId: health.daemon_id, daemonVersion: health.version, runtimeKind: 'standalone-node',
      uiVersion: descriptor.webBuildId, configRevision: health.settings_revision,
      localUrl: `http://127.0.0.1:${port}/ui/`, webApiBase: '../web-api/v1/', capabilities: descriptor.capabilities,
      runtimeId: descriptor.runtimeId, runtimeVersion: descriptor.runtimeVersion, buildId: descriptor.buildId,
      descriptorHash: hash, dataRootId: health.data_root_id, webBuildId: descriptor.webBuildId,
      coreProtocol: descriptor.coreProtocol, environment: descriptor.environment, cloudOrigin: descriptor.cloudOrigin,
      lifecycleState: 'managed', startFingerprint: health.start_fingerprint,
    });
  }


  /** One startup path for signed Desktop/VSIX bundles. Staging has no process
   * side effects; this operation selects/applies the candidate before handing
   * business code a ready lease. Only conclusive pre-stop busy refusals defer. */
  async startBundledCore(input: unknown): Promise<StartBundledCoreResult> {
    const request = StartBundledCoreRequestSchema.parse(input);
    const deadline = Date.now() + 45_000;
    for (;;) {
      try { return await this.startBundledAttempt(request); }
      catch (cause) {
        const code = (cause as {code?:string})?.code ?? (cause instanceof Error ? cause.message : 'unknown');
        // A competing host may be starting/updating the same Core. Re-enter
        // only after a positive lock/preflight refusal, and only when THIS
        // request has never created a signed upgrade journal. Never retry a
        // timeout, malformed response, failed start or own uncertain Stop.
        if (!['lock_busy','upgrade_recovery_required','maintenance_recovery_required'].includes(code)
          || fs.existsSync(this.upgradeFile(request.requestId)) || Date.now() >= deadline) throw cause;
        const upgrades = this.pendingUpgrades(), maintenances = this.pendingMaintenance();
        const stale = (record:{state:string;updatedAt:string}) => record.state==='recovery_required'
          || this.manager.clock().getTime()-Date.parse(record.updatedAt)>120_000;
        if (upgrades.some(stale) || maintenances.some(stale)) throw cause;
        await new Promise(resolve => setTimeout(resolve, 150));
      }
    }
  }
  private async startBundledAttempt(request:z.infer<typeof StartBundledCoreRequestSchema>): Promise<StartBundledCoreResult> {
    await this.checkLegacyDataOwner(request.port);
    const before = await this.locked(async () => {
      if (this.pendingMaintenance().length) return error('maintenance_recovery_required');
      if (this.pendingUpgrades().length) return error('upgrade_recovery_required');
      const target = this.manager.selectVersion(request.versionName);
      if (!target || target.identity.descriptorHash !== request.descriptorHash) return error('core_identity_conflict');
      const { descriptor } = verifyInstalledCore(target.root, request.descriptorHash, { ...this.trust, platform:process.platform, arch:process.arch }) as {descriptor:CoreDescriptor};
      if (descriptor.coreProtocol.min > request.client.protocol.max || request.client.protocol.min > descriptor.coreProtocol.max
        || request.client.capabilities.some(c => !descriptor.capabilities.includes(c))) return error('client_update_required');
      const active = this.manager.select();
      if (active && active.identity.runtimeVersion === descriptor.runtimeVersion && active.identity.descriptorHash !== request.descriptorHash)
        return error('core_identity_conflict');
      return { target, active, running:await this.reclaimDeadReadyRun(this.paths().dataRootId, request.client.clientInstanceId), descriptor };
    });
    if (!before.running && (!before.active || compareRuntimeVersions(before.descriptor.runtimeVersion,before.active.identity.runtimeVersion)>0)) {
      try {
        await this.activateColdCore({ versionName:request.versionName, port:request.port,
          expectedVersionName:before.active?.versionName ?? null, expectedDescriptorHash:before.active?.identity.descriptorHash ?? null });
      } catch (e) {
        // A concurrent startup or live peer may keep the prior selection. A
        // timeout/unknown outcome is NOT permission to start another Core.
        if (!(e instanceof Error) || !['active_clients','core_selection_changed'].includes(e.message)) throw e;
      }
    }
    const attachment = await this.attachOrStart({client:request.client,port:request.port,readyTimeoutMs:request.readyTimeoutMs,
      ...(request.reconnectAfterUpgrade ? {reconnectAfterUpgrade:true} : {})});
    if (compareRuntimeVersions(attachment.receipt.runtimeVersion,before.descriptor.runtimeVersion)>=0) {
      if (attachment.receipt.runtimeVersion===before.descriptor.runtimeVersion && attachment.receipt.descriptorHash!==request.descriptorHash)
        return error('core_identity_conflict');
      return StartBundledCoreResultSchema.parse({state:before.active && before.active.identity.runtimeVersion!==attachment.receipt.runtimeVersion ? 'updated':'current',
        targetVersionName:request.versionName,attachment});
    }
    const {leaseId,clientInstanceId,daemonId,dataRootId,descriptorHash}=attachment.lease;
    try {
      const result = await this.upgradeCore({confirmed:true,requestId:request.requestId,client:request.client,port:request.port,
        handle:{leaseId,clientInstanceId,daemonId,dataRootId,descriptorHash},targetVersionName:request.versionName,readyTimeoutMs:request.readyTimeoutMs}, true);
      if (result.state==='committed' && result.attachment.receipt.descriptorHash!==request.descriptorHash) return error('core_upgrade_outcome_requires_inspection');
      return StartBundledCoreResultSchema.parse({state:result.state==='committed'?'updated':'rolled_back',targetVersionName:request.versionName,attachment:result.attachment});
    } catch (e) {
      const code=(e as {code?:string})?.code ?? (e instanceof Error?e.message:'unknown');
      if (code==='lock_busy' && !fs.existsSync(this.upgradeFile(request.requestId))) throw e;
      if (!(e instanceof Error) || !['active_clients','peer_core_update_required','active_work','active_requests','active_handlers','lock_busy'].includes(code)) throw e;
      // Confirm the previous incarnation remains the active owner before a
      // deferred result is allowed to publish its lease as usable.
      const current=await this.inspectStart();
      if (!current?.receipt || current.receipt.daemonId!==attachment.receipt.daemonId || current.descriptorHash!==attachment.receipt.descriptorHash
        || this.manager.select()?.identity.descriptorHash!==attachment.receipt.descriptorHash) return error('core_upgrade_outcome_requires_inspection');
      return StartBundledCoreResultSchema.parse({state:'deferred',reason:code,targetVersionName:request.versionName,attachment});
    }
  }

  async ensureCore(input: unknown): Promise<{ versionName: string; reused: boolean }> {
    const request = z.object({ client: ManagedClientSchema, port: z.number().int().min(1).max(65535), seedArchive: z.string().min(1).optional(), seedArchiveHash: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict().parse(input);
    await this.checkLegacyDataOwner(request.port);
    const validate = (selection: NonNullable<ReturnType<CoreManager['select']>>) => {
      const { descriptor } = verifyInstalledCore(selection.root, selection.identity.descriptorHash, { ...this.trust, platform: process.platform, arch: process.arch }) as { descriptor: CoreDescriptor };
      if (descriptor.coreProtocol.min > 1 || descriptor.coreProtocol.max < 1 || request.client.protocol.min > 1 || request.client.protocol.max < 1 || request.client.capabilities.some(c => !descriptor.capabilities.includes(c))) error('core_update_required');
      return { versionName: selection.versionName, reused: true };
    };
    const existing = await this.manager.withLock('install', () => {
      const data = this.paths(), running = this.readRun(data.dataRootId);
      const selected = running ? this.manager.selectVersion(running.versionName) : this.manager.select() ?? this.manager.select('known-good.json');
      if (running && (!selected || selected.identity.descriptorHash !== running.descriptorHash)) error('core_identity_conflict');
      return selected ? validate(selected!) : undefined;
    });
    if (existing) return existing;
    // A light VSIX may reuse a verified Desktop/previously installed Core
    // without shipping a Seed. Absence never authorizes legacy spawn or an
    // unsigned download; provisioning requires a separate signed release.
    if (!request.seedArchive) return error('core_missing');
    if (request.seedArchiveHash && createHash('sha256').update(fs.readFileSync(request.seedArchive)).digest('hex') !== request.seedArchiveHash) error('core_seed_hash_invalid');
    const verified = await this.manager.provision(path.resolve(request.seedArchive), 'seed', (archive, destination) => extractVerifiedCoreArchive(archive, destination, { ...this.trust, platform: process.platform, arch: process.arch }));
    const versionName = coreVersionName(verified.descriptor);
    const candidate = this.manager.selectVersion(versionName);
    if (!candidate) return error('core_missing');
    validate(candidate);
    const selected = await this.manager.activateIfAbsent(versionName, async () => {
      const data = this.paths();
      if (this.pendingMaintenance().length) error('maintenance_recovery_required');
      if (this.readRun(data.dataRootId)) error('daemon_state_unknown');
      this.checkDatabaseBinding(data.dataRootId, data.db, request.port);
      if (this.endpointState(request.port).port !== request.port) return error('endpoint_changed');
      if (await probe(request.port)) error('migration_pending');
    });
    const result = validate(selected);
    return { ...result, reused: selected.versionName !== versionName };
  }

  async scheduleRedirectCleanup(input: unknown, file: string, ttlMs: number): Promise<void> {
    const handle = LeaseHandleSchema.parse(input);
    await this.locked(async () => {
      const record = this.readRun(handle.dataRootId);
      if (!record || record.descriptorHash !== handle.descriptorHash || record.receipt?.daemonId !== handle.daemonId) error('lease_target_mismatch');
      const data = this.paths();
      if (data.dataRootId !== handle.dataRootId || !samePath(physicalPath(path.dirname(file)), physicalPath(data.runtimeState)) || !/^local-web-[a-f0-9-]+\.html$/.test(path.basename(file))) error('redirect_path_invalid');
      const selection = this.manager.selectVersion(record!.versionName);
      if (!selection) return error('core_missing');
      const { descriptor } = verifyInstalledCore(selection.root, handle.descriptorHash, { ...this.trust, platform: process.platform, arch: process.arch }) as { descriptor: CoreDescriptor };
      const runtime = selectCoreNodeRuntime(descriptor, selection.root);
      const env = coreNodeEnvironment(this.env, runtime.electronRunAsNode);
      const script = `setTimeout(()=>{try{require('node:fs').rmSync(${JSON.stringify(file)},{force:true})}catch{}},${Math.max(1, Math.min(ttlMs, 60_000))})`;
      // Use verified Store Node, not bootstrap Node: a minute-long redirect
      // cleanup must not keep Desktop installation files open during uninstall.
      await new Promise<void>((resolve, reject) => {
        const child = spawn(runtime.executable, ['-e', script], { env, detached: true, windowsHide: true, stdio: 'ignore' });
        child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); });
      });
    });
  }

  async activateColdCore(input: unknown): Promise<{ versionName: string }> {
    const request = z.object({
      versionName: z.string().min(1).max(250), port: z.number().int().min(1).max(65535),
      // Updater supplies an exact observed active pointer (or null on first
      // install), turning cold activation into a guarded compare-and-swap.
      // Omitted for existing explicit maintenance/migration callers.
      expectedVersionName: z.string().min(1).max(250).nullable().optional(),
      expectedDescriptorHash: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
    }).strict().parse(input);
    await this.manager.activate(request.versionName, async () => {
      await this.checkLegacyDataOwner(request.port);
      const data = this.paths();
      // A paused/ambiguous product upgrade owns the version transition.
      // Never allow a separate cold activation to bypass its journal.
      if (this.pendingUpgrades().length) error('upgrade_recovery_required');
      if (request.expectedVersionName !== undefined) {
        const previous = this.manager.select();
        if ((previous?.versionName ?? null) !== request.expectedVersionName
          || (previous?.identity.descriptorHash ?? null) !== (request.expectedDescriptorHash ?? null)) error('core_selection_changed');
        const candidate = this.manager.selectVersion(request.versionName);
        if (!candidate) error('core_missing');
        // Even when the current Core is stopped, its data schema persists.
        // Check the old signed descriptor (or retained known-good) before
        // moving the pointer; cold updates cannot bypass the running-upgrade
        // compatibility and explicit-migration gates.
        const baseline = previous ?? this.manager.select('known-good.json');
        if (baseline) {
          if (compareRuntimeVersions(candidate!.identity.runtimeVersion, baseline.identity.runtimeVersion) <= 0) error('core_update_not_newer');
          const current = verifyInstalledCore(baseline.root, baseline.identity.descriptorHash, { ...this.trust, platform: process.platform, arch: process.arch }).descriptor;
          const next = verifyInstalledCore(candidate!.root, candidate!.identity.descriptorHash, { ...this.trust, platform: process.platform, arch: process.arch }).descriptor;
          if (next.coreProtocol.min > current.coreProtocol.max || current.coreProtocol.min > next.coreProtocol.max) error('core_protocol_incompatible');
          if (next.dataSchema.min > current.dataSchema.max || current.dataSchema.min > next.dataSchema.max) error('data_schema_incompatible');
          if (next.migrationPolicy === 'explicit') error('data_migration_explicit_required');
        }
      }
      if (this.pendingMaintenance().length) error('maintenance_recovery_required');
      if (this.readRun(data.dataRootId)) error('daemon_state_unknown');
      this.checkDatabaseBinding(data.dataRootId, data.db, request.port);
      if (this.endpointState(request.port).port !== request.port) return error('endpoint_changed');
      if (this.manager.liveLeases().some(lease => lease.dataRootId === data.dataRootId)) error('active_clients');
      // A malformed/legacy listener, timeout or redirect is NOT proof of closure.
      if (await probe(request.port)) error('migration_pending');
      const selection = this.manager.selectVersion(request.versionName);
      if (!selection) return error('core_missing');
      verifyInstalledCore(selection.root, selection.identity.descriptorHash, { ...this.trust, platform: process.platform, arch: process.arch });
    });
    return { versionName: request.versionName };
  }

  async inspectStart(): Promise<RunningCoreRecord | null> {
    return this.locked(async () => this.readRun(this.paths().dataRootId) ?? null);
  }

  async recoverStart(input: unknown): Promise<{ recovered: boolean }> {
    // `force` is an operator decision, not evidence: it is accepted only for a
    // record whose port is positively closed and whose leases have all expired.
    const request = z.object({ confirmed: z.literal(true), force: z.literal(true).optional(), dataRootId: z.string().regex(/^[a-f0-9]{64}$/), descriptorHash: z.string().regex(/^[a-f0-9]{64}$/), startFingerprint: z.string().min(1).max(500) }).strict().parse(input);
    return this.locked(async () => {
      const data = this.paths();
      if (data.dataRootId !== request.dataRootId) return error('data_root_conflict');
      const record = this.readRun(data.dataRootId);
      if (!record) return { recovered: false };
      if (this.pendingMaintenance().some(m => m.target.startFingerprint === record.startFingerprint)) return error('maintenance_recovery_required');
      if (record.descriptorHash !== request.descriptorHash || record.startFingerprint !== request.startFingerprint) return error('recovery_target_mismatch');
      if (await probe(record.port)) return error('daemon_still_running');
      if (!record.pid) return error('recovery_process_unknown');
      // Death must still be proven (exited, earlier boot, or expired heartbeat
      // lease) unless the operator explicitly forces a port-closed record.
      // EPERM, a live PID and unknown states never authorize deleting a guard,
      // and this operation never kills.
      if (!this.staleRunIsDead(record) && request.force !== true) return error('recovery_process_alive');
      if (this.manager.liveLeases().some(lease => lease.dataRootId === record.dataRootId)) return error('active_clients');
      this.archiveRun(data.dataRootId);
      return { recovered: true };
    });
  }

  async attachOrStart(input: unknown): Promise<AttachCoreResult> {
    const request = AttachCoreRequestSchema.parse(input);
    await this.checkLegacyDataOwner(request.port);
    if (this.pendingUpgrades().length) return error('upgrade_recovery_required');
    const { clientInstanceId, ...inventory } = request.client;
    // Installation inventory is non-authoritative, and may record an attempted
    // attach. It never grants permission to start, stop or collect a runtime.
    await this.manager.registerClient(inventory);
    return this.locked(() => this.attachLocked(request));
  }

  private async reclaimDeadReadyRun(dataRootId: string, clientInstanceId: string): Promise<RunningCoreRecord | undefined> {
    const record = this.readRun(dataRootId);
    if (!record || record.status !== 'ready' || !record.receipt || !record.pid) return record;
    if (this.pendingMaintenance().length || this.pendingUpgrades().length) return record;
    if (!this.staleRunIsDead(record)) return record;
    const leases = this.manager.liveLeases().filter(lease => lease.dataRootId === record.dataRootId);
    if (leases.some(lease => lease.clientInstanceId !== clientInstanceId)) return record;
    try { if (await probe(record.port)) return record; } catch { return record; }
    for (const lease of leases) {
      const file = path.join(this.manager.leases, `${lease.leaseId}.json`);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    this.archiveRun(dataRootId);
    return undefined;
  }

  private async attachLocked(request: z.infer<typeof AttachCoreRequestSchema>, preferredVersion?: string): Promise<AttachCoreResult> {
      if (!preferredVersion && this.pendingMaintenance().length) return error('maintenance_recovery_required');
      const { clientInstanceId, ...inventory } = request.client;
      const data = this.paths();
      this.checkDatabaseBinding(data.dataRootId, data.db, request.port);
      if (this.endpointState(request.port).port !== request.port) return error('endpoint_changed');
      const prior = request.existingFingerprint === undefined ? await this.reclaimDeadReadyRun(data.dataRootId, clientInstanceId) : this.readRun(data.dataRootId);
      if (request.existingFingerprint !== undefined && (!prior || prior.status !== 'ready' || prior.startFingerprint !== request.existingFingerprint)) return error('managed_running_core_required');
      const selection = prior ? this.manager.selectVersion(prior.versionName) : preferredVersion ? this.manager.selectVersion(preferredVersion) : (this.manager.select() ?? this.manager.select('known-good.json'));
      if (!selection) return error('core_missing');
      if (!samePath(physicalPath(selection.root), path.resolve(selection.root))) return error('core_store_link_rejected');
      const { descriptor } = verifyInstalledCore(selection.root, selection.identity.descriptorHash, { ...this.trust, platform: process.platform, arch: process.arch }) as { descriptor: CoreDescriptor };
      for (const key of ['runtimeId', 'runtimeVersion', 'buildId', 'webBuildId', 'environment', 'cloudOrigin'] as const) {
        if (descriptor[key] !== selection.identity[key]) error('core_identity_conflict');
      }
      if (prior && prior.descriptorHash !== selection.identity.descriptorHash) error('core_identity_conflict');
      if (descriptor.coreProtocol.min > 1 || descriptor.coreProtocol.max < 1 || request.client.protocol.min > 1 || request.client.protocol.max < 1 || request.client.capabilities.some((c) => !descriptor.capabilities.includes(c))) error('client_update_required');
      let health = await probe(request.port);
      let spawned = false;
      let fingerprint = prior?.startFingerprint;
      let ownedPid = prior?.pid;
      if (!health) {
        // A prior launch with no response is ambiguous. Never retry spawn on a
        // timeout or stale record: an explicit repair/recovery must resolve it.
        if (prior) return error('daemon_state_unknown');
        const runtime = selectCoreNodeRuntime(descriptor, selection.root);
        fingerprint = randomUUID();
        this.saveRun({ schemaVersion: 1, status: 'starting', versionName: selection.versionName, descriptorHash: selection.identity.descriptorHash, dataRootId: data.dataRootId, dbPath: data.db, port: request.port, startFingerprint: fingerprint });
        fs.mkdirSync(data.logs, { recursive: true });
        const log = fs.openSync(path.join(data.logs, 'managed-daemon.log'), 'a', 0o600);
        const childEnv = coreNodeEnvironment({ ...this.env, ...(this.env.BLACKHOLE_TUNNEL === 'manual' ? { BLACKHOLE_TUNNEL: 'auto' } : {}), BLACKHOLE_HOME: data.root, BLACKHOLE_DB: data.db, BLACKHOLE_PORT: String(request.port), BLACKHOLE_WEB_DIR: path.join(selection.root, descriptor.webRoot), BLACKHOLE_START_FINGERPRINT: fingerprint, BLACKHOLE_MANAGER_PUBLIC_KEY: this.manager.lifecyclePublicKey(),
          // Liveness lease: the Core refreshes this while it runs, so a later
          // start can tell a recycled PID from this very incarnation.
          BLACKHOLE_RUN_HEARTBEAT: this.heartbeatFile(data.dataRootId),
          BLACKHOLE_MANAGED_RUNTIME_IDENTITY: JSON.stringify({ ...selection.identity, dataRootId: data.dataRootId, lifecycleState: 'managed' }) }, runtime.electronRunAsNode);
        let failed = false;
        let child;
        try {
          child = spawn(runtime.executable, [path.join(selection.root, descriptor.daemonEntry), 'serve', '--port', String(request.port)], { cwd: selection.root, env: childEnv, detached: true, windowsHide: true, stdio: ['ignore', log, log] });
          child.once('error', () => { failed = true; });
          child.once('exit', () => { failed = true; });
          child.unref();
          ownedPid = child.pid;
          if (ownedPid) this.saveRun({ schemaVersion: 1, status: 'starting', pid: ownedPid, versionName: selection.versionName, descriptorHash: selection.identity.descriptorHash, dataRootId: data.dataRootId, dbPath: data.db, port: request.port, startFingerprint: fingerprint });
        } finally { fs.closeSync(log); }
        spawned = true;
        const deadline = Date.now() + request.readyTimeoutMs;
        while (Date.now() < deadline) {
          if (failed) return error('kernel_exited');
          health = await probe(request.port, true);
          if (health) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (!health) return error('ready_timeout');
      }
      this.validateHealth(health, descriptor, selection.identity.descriptorHash, data.dataRootId, data.db, fingerprint);
      if (prior?.receipt && health.daemon_id !== prior.receipt.daemonId) error('core_identity_conflict');
      const web = await getLocal(request.port, '/ui/');
      if (web.status !== 200 && web.status !== 302) return error('web_assets_missing');
      const receipt = this.receipt(health, descriptor, selection.identity.descriptorHash, request.port);
      this.saveRun({ schemaVersion: 1, status: 'ready', ...(ownedPid ? { pid: ownedPid } : {}), versionName: selection.versionName, descriptorHash: selection.identity.descriptorHash, dataRootId: data.dataRootId, dbPath: data.db, port: request.port, startFingerprint: health.start_fingerprint, receipt });
      writeJson(this.endpointFile(), this.endpointState(request.port));
      const previous = this.manager.liveLeases().find((lease) => lease.clientInstanceId === clientInstanceId);
      if (previous && (previous.clientId !== inventory.clientId || previous.kind !== inventory.kind || previous.daemonId !== receipt.daemonId || previous.descriptorHash !== receipt.descriptorHash || previous.dataRootId !== data.dataRootId)) error('lease_target_mismatch');
      const now = this.manager.clock();
      const lease = ClientLeaseSchema.parse({ schemaVersion: 1, leaseId: previous?.leaseId ?? randomUUID(), clientId: inventory.clientId, clientInstanceId, kind: inventory.kind, runtimeId: descriptor.runtimeId, buildId: descriptor.buildId, descriptorHash: receipt.descriptorHash, dataRootId: receipt.dataRootId, daemonId: receipt.daemonId, issuedAt: previous?.issuedAt ?? now.toISOString(), expiresAt: new Date(now.getTime() + LEASE_TTL_MS).toISOString() });
      this.manager.writeLease(lease);
      this.registerParticipant(lease,request);
      // A fresh host reopens the grace window even if the previous last host
      // exited only milliseconds ago. Protected by the same Manager locks.
      const idleMarker = path.join(this.manager.state, 'idle', data.dataRootId + '.json');
      if (fs.existsSync(idleMarker)) fs.unlinkSync(idleMarker);
      // Known-good means a verified daemon AND Web readiness, not merely a
      // newly written active pointer. Do not switch active here.
      writeJson(path.join(this.manager.root, 'known-good.json'), { schemaVersion: 1, versionName: selection.versionName, descriptorHash: receipt.descriptorHash, updatedAt: now.toISOString() });
      return AttachCoreResultSchema.parse({ receipt, lease, spawned });
  }

  private recordUpgradeResult(audit:CoreUpgradeRecord, attachment:AttachCoreResult):void {
    const transition=z.object({requestId:z.string().uuid(),from:ManagedReadyReceiptSchema,to:ManagedReadyReceiptSchema}).strict()
      .parse({requestId:audit.requestId,from:audit.from.receipt,to:attachment.receipt});
    writeJson(path.join(this.manager.state,'upgrade-results',audit.requestId+'.json'),transition);
  }
  /** Reattachment never starts a Core or trusts a changed HTTP endpoint. The
   * exact old lease must have opted in and a completed journal must bind both
   * daemon incarnations. Caller trust is verified again by attachLocked. */
  async reconnectCore(input:unknown):Promise<AttachCoreResult> {
    const request=z.object({handle:LeaseHandleSchema,client:ManagedClientSchema,port:z.number().int().min(1).max(65535)}).strict().parse(input);
    return this.locked(async()=>{
      const file=this.participantFile(request.handle.leaseId);
      if(!fs.existsSync(file))return error('core_reconnect_not_registered');
      const peer=UpgradeParticipantSchema.parse(readJson(file));
      if(JSON.stringify(peer.handle)!==JSON.stringify(request.handle) || JSON.stringify(peer.client)!==JSON.stringify(request.client)
        || peer.environment!==this.trust.environment || peer.handle.dataRootId!==this.paths().dataRootId)return error('lease_target_mismatch');
      const pending=this.pendingUpgrades();
      if(pending.length){
        if(pending.some(r=>r.state==='recovery_required'||this.manager.clock().getTime()-Date.parse(r.updatedAt)>120_000))return error('upgrade_recovery_required');
        return error('upgrade_in_progress');
      }
      if(this.pendingMaintenance().length)return error('maintenance_recovery_required');
      const run=this.readRun(this.paths().dataRootId);
      if(!run?.receipt || run.status!=='ready'||run.port!==request.port)return error('managed_running_core_required');
      const dir=path.join(this.manager.state,'upgrade-results');
      const names=fs.existsSync(dir)?fs.readdirSync(dir).filter(n=>n.endsWith('.json')):[];
      if(names.length>2048)return error('upgrade_history_requires_compaction');
      let proved=false;
      const receiptSchema=z.object({requestId:z.string().uuid(),from:ManagedReadyReceiptSchema,to:ManagedReadyReceiptSchema}).strict();
      for(const name of names){
        const transition=receiptSchema.parse(readJson(path.join(dir,name)));
        if(transition.from.daemonId!==peer.handle.daemonId||transition.from.descriptorHash!==peer.handle.descriptorHash
          ||transition.from.dataRootId!==peer.handle.dataRootId||transition.to.daemonId!==run.receipt.daemonId
          ||transition.to.startFingerprint!==run.startFingerprint||transition.to.descriptorHash!==run.descriptorHash)continue;
        const journal=CoreUpgradeRecordSchema.parse(readJson(this.upgradeFile(transition.requestId)));
        if(!['committed','rolled_back'].includes(journal.state)||journal.from.receipt?.daemonId!==transition.from.daemonId
          ||journal.from.startFingerprint!==transition.from.startFingerprint||journal.from.port!==request.port
          ||(journal.state==='committed'?journal.targetDescriptorHash:journal.from.descriptorHash)!==transition.to.descriptorHash)continue;
        proved=true;break;
      }
      if(!proved)return error('core_reconnect_unproven');
      const selected=this.manager.selectVersion(run.versionName);
      if(!selected||selected.identity.descriptorHash!==run.descriptorHash)return error('core_identity_conflict');
      const {descriptor}=verifyInstalledCore(selected.root,run.descriptorHash,{...this.trust,platform:process.platform,arch:process.arch}) as {descriptor:CoreDescriptor};
      if(!peer.trustedKeyHashes.includes(signingKeyHash(this.trust.publicKeys[descriptor.signingKeyId]!)))return error('peer_core_update_required');
      return this.attachLocked(AttachCoreRequestSchema.parse({client:request.client,port:request.port,
        existingFingerprint:run.startFingerprint,reconnectAfterUpgrade:true}));
    });
  }

  private participantFile(leaseId:string):string {
    return path.join(this.manager.state,'upgrade-participants',z.string().uuid().parse(leaseId)+'.json');
  }
  private registerParticipant(lease:ClientLease, request:z.infer<typeof AttachCoreRequestSchema>):void {
    if(!request.reconnectAfterUpgrade)return;
    const handle=LeaseHandleSchema.parse(Object.fromEntries(['leaseId','clientInstanceId','daemonId','dataRootId','descriptorHash'].map(k=>[k,lease[k as keyof ClientLease]])));
    writeJson(this.participantFile(lease.leaseId),UpgradeParticipantSchema.parse({schemaVersion:1,handle,client:request.client,
      environment:this.trust.environment,trustedKeyHashes:[...new Set(Object.values(this.trust.publicKeys).map(signingKeyHash))],updatedAt:this.manager.clock().toISOString()}));
  }
  /** A peer's presence is not work, but only a host that explicitly supports
   * reattachment AND already trusts the candidate may be coordinated away. */
  private compatibleUpgradePeers(record:RunningCoreRecord, issuerLeaseId:string, targetVersionName:string):ClientLease[] {
    const target=this.manager.selectVersion(targetVersionName);
    if(!target)return error('core_missing');
    const {descriptor}=verifyInstalledCore(target.root,target.identity.descriptorHash,{...this.trust,platform:process.platform,arch:process.arch}) as {descriptor:CoreDescriptor};
    const key=this.trust.publicKeys[descriptor.signingKeyId];
    if(!key)return error('trust_config_invalid');
    const hash=signingKeyHash(key);
    const peers=this.manager.liveLeases().filter(l=>l.dataRootId===record.dataRootId && l.leaseId!==issuerLeaseId);
    for(const lease of peers){
      const file=this.participantFile(lease.leaseId);
      if(!fs.existsSync(file))return error('active_clients');
      const peer=UpgradeParticipantSchema.parse(readJson(file));
      if(Object.entries(peer.handle).some(([k,v])=>lease[k as keyof ClientLease]!==v)
        || peer.client.clientInstanceId!==lease.clientInstanceId || peer.client.clientId!==lease.clientId || peer.client.kind!==lease.kind
        || lease.daemonId!==record.receipt?.daemonId || lease.descriptorHash!==record.descriptorHash)return error('active_clients');
      if(peer.environment!==descriptor.environment || !peer.trustedKeyHashes.includes(hash)
        || peer.client.protocol.min>descriptor.coreProtocol.max || descriptor.coreProtocol.min>peer.client.protocol.max
        || peer.client.capabilities.some(c=>!descriptor.capabilities.includes(c)))return error('peer_core_update_required');
    }
    return peers;
  }

  private pendingMaintenance() {
    const directory = path.join(this.manager.state, 'maintenance');
    return fs.existsSync(directory) ? fs.readdirSync(directory).filter(n => n.endsWith('.json'))
      .map(n => CoreMaintenanceRecordSchema.parse(readJson(path.join(directory, n))))
      .filter(record => !['completed', 'refused', 'recovered_stopped', 'recovered_running'].includes(record.state)) : [];
  }

  async recoverMaintenance(input: unknown) {
    const request = z.object({ requestId: z.string().uuid(), confirmed: z.literal(true), currentFingerprint: z.string().min(1).max(500).optional() }).strict().parse(input);
    return this.locked(async () => {
      const journal = this.maintenanceFile(request.requestId), data = this.paths();
      const audit = CoreMaintenanceRecordSchema.parse(readJson(journal)), target = audit.target;
      if (['completed', 'refused', 'recovered_stopped', 'recovered_running'].includes(audit.state)) return error('maintenance_recovery_not_required');
      if (target.dataRootId !== data.dataRootId || !samePath(target.dbPath, data.db)) return error('recovery_target_mismatch');
      const running = this.readRun(data.dataRootId);
      if (request.currentFingerprint !== undefined) {
        if (audit.operation !== 'restart' || !running || running.status !== 'ready' || !running.receipt
          || running.startFingerprint !== request.currentFingerprint || running.startFingerprint === target.startFingerprint
          || running.descriptorHash !== target.descriptorHash || running.versionName !== target.versionName
          || running.port !== target.port || !samePath(running.dbPath, target.dbPath)) return error('recovery_target_mismatch');
        if (!target.pid) return error('recovery_process_unknown');
        try { process.kill(target.pid, 0); return error('recovery_process_alive'); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
        if (!running.pid) return error('recovery_process_unknown');
        try { process.kill(running.pid, 0); } catch { return error('recovery_process_unknown'); }
        const selection = this.manager.selectVersion(running.versionName);
        if (!selection || selection.identity.descriptorHash !== running.descriptorHash) return error('core_identity_conflict');
        const { descriptor } = verifyInstalledCore(selection.root, running.descriptorHash, { ...this.trust, platform: process.platform, arch: process.arch }) as { descriptor: CoreDescriptor };
        const health = await probe(running.port);
        if (!health || health.daemon_id !== running.receipt.daemonId) return error('recovery_target_mismatch');
        this.validateHealth(health, descriptor, running.descriptorHash, data.dataRootId, data.db, running.startFingerprint);
        // Explicitly acknowledge the observed incarnation, NOT successful application
        // of the original configuration request. No settings, lease or process mutation.
        writeJson(journal, CoreMaintenanceRecordSchema.parse({ ...audit, state: 'recovered_running', updatedAt: this.manager.clock().toISOString() }));
        return { recovered: true, restarted: false, requestId: request.requestId, observed: 'running' };
      }
      // A failed replacement is a different incarnation; never remove its guard.
      if (running && (running.startFingerprint !== target.startFingerprint || running.descriptorHash !== target.descriptorHash || running.pid !== target.pid)) return error('recovery_target_mismatch');
      if (await probe(target.port)) return error('daemon_still_running');
      if (!target.pid) return error('recovery_process_unknown');
      try { process.kill(target.pid, 0); return error('recovery_process_alive'); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
      if (this.manager.liveLeases().some(l => l.dataRootId === target.dataRootId)) return error('active_clients');
      if (running) {
        const archive = path.join(this.manager.state, 'recovered-starts'); fs.mkdirSync(archive, { recursive: true });
        fs.renameSync(this.runFile(data.dataRootId), path.join(archive, request.requestId + '.json'));
      }
      writeJson(journal, CoreMaintenanceRecordSchema.parse({ ...audit, state: 'recovered_stopped', updatedAt: this.manager.clock().toISOString() }));
      return { recovered: true, restarted: false, requestId: request.requestId };
    });
  }

  private maintenanceFile(requestId: string): string {
    return path.join(this.manager.state, 'maintenance', z.string().uuid().parse(requestId) + '.json');
  }
  async inspectMaintenance(requestId: unknown) {
    const file = this.maintenanceFile(z.string().uuid().parse(requestId));
    return this.locked(async () => fs.existsSync(file) ? CoreMaintenanceRecordSchema.parse(readJson(file)) : null);
  }

  async maintainCore(input: unknown) {
    return this.maintainCoreInternal(input, false);
  }


  /**
   * Compatibility handoff for a signed installation whose old daemon can
   * verify Stop tokens but lacks the dedicated upgrade-purpose idle policy.
   * The caller holds the install+lifecycle lock and has already validated the
   * old running receipt, the new target signature, schema and every peer lease.
   *
   * This is deliberately unavailable to ordinary maintain-core/stop requests.
   * The helper is itself a verified MEMBER OF THE TARGET CORE, not a program
   * supplied by a Web request, environment variable or on-disk sidecar.
   */
  private stopBoundedLegacyCore(
    record: z.infer<typeof RunningCoreRecordSchema>, oldDescriptor: CoreDescriptor,
    targetVersionName: string,
  ): void {
    if (process.platform !== 'win32' || !record.pid || !record.receipt)
      return error('core_handoff_platform_unsupported');
    const next = this.manager.selectVersion(targetVersionName);
    if (!next) return error('core_handoff_target_missing');
    const verified = verifyInstalledCore(next.root, next.identity.descriptorHash,
      { ...this.trust, platform: process.platform, arch: process.arch }) as { descriptor: CoreDescriptor };
    // This native program is part of the immutable signed distribution.
    if (!verified.descriptor.members.some(member => member.path === 'host/core-handoff.exe'))
      return error('core_handoff_not_signed');
    const helper = path.join(next.root, 'host', 'core-handoff.exe');
    if (!fs.statSync(helper).isFile()) return error('core_handoff_not_signed');
    const oldRuntime = selectCoreNodeRuntime(oldDescriptor, this.manager.selectVersion(record.versionName)!.root);
    let output = '';
    try {
      output = execFileSync(helper, [
        '-pid', String(record.pid), '-port', String(record.port),
        '-exe', oldRuntime.executable,
        '-daemon', record.receipt.daemonId,
        '-fingerprint', record.startFingerprint,
        '-hash', record.descriptorHash,
        '-data-root', record.dataRootId,
      ], { encoding: 'utf8', windowsHide: true, timeout: 12_000, maxBuffer: 4096 });
    } catch {
      // An OS operation may have crossed its termination boundary before the
      // reply was lost. Preserve the journal; no speculative retry or spawn.
      return error('core_handoff_outcome_unknown');
    }
    let result: unknown;
    try { result = JSON.parse(output.trim()); } catch { return error('core_handoff_outcome_unknown'); }
    const accepted = z.object({ ok: z.literal(true), state: z.literal('stopped') }).strict().safeParse(result);
    if (!accepted.success) return error('core_handoff_outcome_unknown');
  }

  private async maintainCoreInternal(input: unknown, internalUpgrade: boolean, upgradeTargetVersionName?: string, allowSignedBundleReplace = false) {
    const request = MaintainCoreRequestSchema.parse(input);
    return this.locked(async () => {
      const journal = this.maintenanceFile(request.requestId);
      if (fs.existsSync(journal)) throw new Error('maintenance_outcome_requires_inspection');
      if (this.pendingMaintenance().length) return error('maintenance_recovery_required');
      if (!internalUpgrade && this.pendingUpgrades().length) return error('upgrade_recovery_required');
      const { lease, file: leaseFile } = this.boundLease(request.handle);
      if (!lease || Date.parse(lease.expiresAt) <= this.manager.clock().getTime()) return error('lease_expired');
      if (lease.clientInstanceId !== request.client.clientInstanceId || lease.clientId !== request.client.clientId || lease.kind !== request.client.kind) return error('lease_target_mismatch');
      const data = this.paths(), record = this.readRun(data.dataRootId);
      if (data.dataRootId !== lease.dataRootId || !record || record.status !== 'ready' || !record.pid || !record.receipt
        || record.port !== request.port || record.receipt.daemonId !== lease.daemonId || record.descriptorHash !== lease.descriptorHash) return error('maintenance_target_mismatch');
      const coordinatedPeers = internalUpgrade && upgradeTargetVersionName
        ? this.compatibleUpgradePeers(record,lease.leaseId,upgradeTargetVersionName) : [];
      if (!internalUpgrade && this.manager.liveLeases().some(l => l.dataRootId === data.dataRootId && l.leaseId !== lease.leaseId)) return error('active_clients');
      if (internalUpgrade && !upgradeTargetVersionName) return error('core_upgrade_target_invalid');
      const selection = this.manager.selectVersion(record.versionName);
      if (!selection || selection.identity.descriptorHash !== record.descriptorHash) return error('core_identity_conflict');
      const { descriptor } = verifyInstalledCore(selection.root, record.descriptorHash, { ...this.trust, platform: process.platform, arch: process.arch }) as { descriptor: CoreDescriptor };
      const health = await probe(request.port);
      if (!health || health.daemon_id !== record.receipt.daemonId) return error('maintenance_target_mismatch');
      this.validateHealth(health, descriptor, record.descriptorHash, data.dataRootId, data.db, record.startFingerprint);
      if (health.lifecycle_control_version !== 1) return error('core_update_required');
      if (descriptor.coreProtocol.min > 1 || descriptor.coreProtocol.max < 1 || request.client.protocol.min > 1 || request.client.protocol.max < 1 || request.client.capabilities.some(c => !descriptor.capabilities.includes(c))) return error('client_update_required');
      if (request.settingsRevision !== undefined) {
        if (health.lifecycle_settings_version !== 1) return error('core_update_required');
        if (health.settings_revision !== request.settingsRevision) return error('settings_revision_conflict');
      }
      const publicKeyPem = this.manager.lifecyclePublicKey();
      if (health.lifecycle_manager_key_hash !== createHash('sha256').update(publicKeyPem).digest('hex')) return error('manager_key_mismatch');
      let audit = CoreMaintenanceRecordSchema.parse({ schemaVersion: 1, requestId: request.requestId, operation: request.operation,
        requestHash: createHash('sha256').update(JSON.stringify(request)).digest('hex'), state: 'stopping', target: record,
        updatedAt: this.manager.clock().toISOString() });
      const save = (state: typeof audit.state) => { audit = { ...audit, state, updatedAt: this.manager.clock().toISOString() }; writeJson(journal, CoreMaintenanceRecordSchema.parse(audit)); };
      save('stopping');
      try {
        const grant = this.manager.signLifecycleGrant({ operation: internalUpgrade && health.lifecycle_upgrade_version===1 ? 'upgrade' : request.operation, daemonId: lease.daemonId,
          startFingerprint: record.startFingerprint, runtimeId: descriptor.runtimeId, buildId: descriptor.buildId,
          descriptorHash: record.descriptorHash, dataRootId: data.dataRootId, transactionId: request.requestId, ...(request.settingsRevision !== undefined ? { settingsRevision: request.settingsRevision } : {}) }, 30_000);
        const reply = await postLocal(request.port, '/api/core/stop', { token: grant.token });
        let stoppedBySignedHandoff = false;
        if (reply.status === 409) {
          const body = z.object({ error: z.string().regex(/^[a-z][a-z0-9_]{0,100}$/) }).strict()
            .safeParse(JSON.parse(reply.body));
          if (body.success && ['active_work', 'active_requests', 'active_handlers'].includes(body.data.error) &&
            allowSignedBundleReplace && (upgradeTargetVersionName || (!internalUpgrade && request.operation === 'stop'))) {
            // Only an installed, verified Core or lease-free idle shutdown may
            // override the daemon's activity refusal. Its signed native helper
            // separately anchors the exact listener PID and executable before exit.
            try {
              this.stopBoundedLegacyCore(record, descriptor, upgradeTargetVersionName ?? record.versionName);
            } catch (error) {
              // A missing signed helper or unsupported platform proves that
              // no replacement was attempted. Other failures may be post-exit
              // ambiguities and must retain the recovery journal.
              if (error instanceof Error && ['core_handoff_not_signed', 'core_handoff_platform_unsupported',
                'core_handoff_target_missing'].includes(error.message)) save('refused');
              throw error;
            }
            stoppedBySignedHandoff = true;
          } else if (body.success) {
            save('refused'); return error(body.data.error);
          }
        }
        if (!stoppedBySignedHandoff) {
          if (reply.status !== 200) return error('maintenance_outcome_unknown');
          const accepted = z.object({ ok: z.literal(true), transactionId: z.literal(request.requestId),
            daemonId: z.literal(lease.daemonId), state: z.literal('stopping') }).strict().safeParse(JSON.parse(reply.body));
          if (!accepted.success) return error('maintenance_outcome_unknown');
        }
        const deadline = Date.now() + 15_000;
        let stopped = false;
        while (Date.now() < deadline) {
          let closed = false, dead = false;
          try {
            const r = await getLocal(record.port, '/api/health', 1000);
            const h = JSON.parse(r.body);
            if (r.status !== 200 || h.daemon_id !== lease.daemonId || h.start_fingerprint !== record.startFingerprint
              || h.descriptor_hash !== record.descriptorHash || h.data_root_id !== record.dataRootId) return error('maintenance_outcome_unknown');
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ECONNREFUSED') closed = true;
            else return error('maintenance_outcome_unknown');
          }
          try { process.kill(record.pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') dead = true; else return error('recovery_process_unknown'); }
          if (closed && dead) { stopped = true; break; }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (!stopped) return error('maintenance_outcome_unknown');
        // Participating hosts consented to verified reattachment and trust the
        // target. Retire ONLY those exact old leases after positive Core exit;
        // their registration remains as the journal-bound reattachment proof.
        for (const peer of coordinatedPeers) {
          const peerHandle=LeaseHandleSchema.parse(Object.fromEntries(['leaseId','clientInstanceId','daemonId','dataRootId','descriptorHash'].map(k=>[k,peer[k as keyof ClientLease]])));
          const bound=this.boundLease(peerHandle);
          if(bound.lease)fs.unlinkSync(bound.file);
        }
        // Both positive exit proofs precede any guard removal. Never kill by PID.
        const archive = path.join(this.manager.state, 'stopped-runs'); fs.mkdirSync(archive, { recursive: true });
        fs.renameSync(this.runFile(data.dataRootId), path.join(archive, request.requestId + '.json'));
        if (fs.existsSync(leaseFile)) fs.unlinkSync(leaseFile);
        save('stopped');
        if (request.operation === 'stop') { save('completed'); return { operation: 'stop' as const, stopped: true as const, requestId: request.requestId }; }
        save('restarting');
        // The same verified version, not an advanced active pointer. Locks remain held.
        const attachment = await this.attachLocked(AttachCoreRequestSchema.parse({ client: request.client, port: request.port,
          ...(fs.existsSync(this.participantFile(request.handle.leaseId)) ? {reconnectAfterUpgrade:true}: {}) }), record.versionName);
        if (request.settingsRevision !== undefined) {
          const applied = await probe(request.port);
          if (!applied || applied.daemon_id !== attachment.receipt.daemonId || applied.started_settings_revision !== request.settingsRevision || applied.settings_revision !== request.settingsRevision) return error('settings_application_unconfirmed');
        }
        save('completed');
        return { operation: 'restart' as const, stopped: true as const, requestId: request.requestId, attachment };
      } catch (e) {
        if (audit.state !== 'refused' && audit.state !== 'completed') save('recovery_required');
        throw e;
      }
    });
  }

  private upgradeFile(requestId: string): string {
    return path.join(this.manager.state, 'upgrade', z.string().uuid().parse(requestId) + '.json');
  }
  private pendingUpgrades(): CoreUpgradeRecord[] {
    const directory = path.join(this.manager.state, 'upgrade');
    return fs.existsSync(directory) ? fs.readdirSync(directory).filter(n => n.endsWith('.json'))
      .map(n => CoreUpgradeRecordSchema.parse(readJson(path.join(directory, n))))
      .filter(record => !['committed', 'rolled_back', 'refused'].includes(record.state)) : [];
  }
  async inspectUpgrades() {
    const dataRootId = this.paths().dataRootId;
    return this.pendingUpgrades().filter(record => record.from.dataRootId === dataRootId);
  }

  /**
   * Explicit product upgrade transaction. The candidate must already be
   * provisioned (stage first, while the old Core keeps running). The old Core
   * is stopped only through the guarded maintenance path, the active pointer
   * switches under Manager locks, and the candidate must become ready before
   * the transaction commits. A positively failed candidate restores the
   * previous pointer and restarts the previous Core; anything ambiguous is
   * journalled as recovery_required instead of spawning a second daemon.
   */
  async upgradeCore(input: unknown, fromVerifiedBundle = false): Promise<UpgradeCoreResult> {
    const request = UpgradeCoreRequestSchema.parse(input);
    const file = this.upgradeFile(request.requestId);
    const prepared = await this.locked(async () => {
      if (fs.existsSync(file)) throw new Error('maintenance_outcome_requires_inspection');
      if (this.pendingMaintenance().length) return error('maintenance_recovery_required');
      if (this.pendingUpgrades().length) return error('upgrade_recovery_required');
      const { lease } = this.boundLease(request.handle);
      if (!lease || Date.parse(lease.expiresAt) <= this.manager.clock().getTime()) return error('lease_expired');
      if (lease.clientInstanceId !== request.client.clientInstanceId || lease.clientId !== request.client.clientId || lease.kind !== request.client.kind) return error('lease_target_mismatch');
      const data = this.paths(), record = this.readRun(data.dataRootId);
      if (data.dataRootId !== lease.dataRootId || !record || record.status !== 'ready' || !record.pid || !record.receipt
        || record.port !== request.port || record.receipt.daemonId !== lease.daemonId || record.descriptorHash !== lease.descriptorHash) return error('maintenance_target_mismatch');
      this.compatibleUpgradePeers(record,lease.leaseId,request.targetVersionName);
      if (record.versionName === request.targetVersionName) return error('core_update_not_newer');
      // A separately changed active pointer (for example from an incomplete
      // cold operation) must not be overwritten by a live upgrade targeting
      // an older candidate than that selected version.
      const selectedActive = this.manager.select();
      if (selectedActive && (selectedActive.versionName !== record.versionName || selectedActive.identity.descriptorHash !== record.descriptorHash)) return error('core_selection_changed');
      const currentSelection = this.manager.selectVersion(record.versionName);
      if (!currentSelection || currentSelection.identity.descriptorHash !== record.descriptorHash) return error('core_identity_conflict');
      const target = this.manager.selectVersion(request.targetVersionName);
      if (!target) return error('core_missing');
      const { descriptor: currentDescriptor } = verifyInstalledCore(currentSelection.root, record.descriptorHash, { ...this.trust, platform: process.platform, arch: process.arch });
      const { descriptor: targetDescriptor } = verifyInstalledCore(target.root, target.identity.descriptorHash, { ...this.trust, platform: process.platform, arch: process.arch });
      for (const key of ['runtimeId', 'runtimeVersion', 'buildId', 'webBuildId', 'environment', 'cloudOrigin'] as const) {
        if (targetDescriptor[key] !== target.identity[key]) error('core_identity_conflict');
      }
      if (targetDescriptor.coreProtocol.min > request.client.protocol.max || request.client.protocol.min > targetDescriptor.coreProtocol.max
        || request.client.capabilities.some(c => !targetDescriptor.capabilities.includes(c))) return error('client_update_required');
      if (compareRuntimeVersions(targetDescriptor.runtimeVersion, currentDescriptor.runtimeVersion) <= 0) return error('core_update_not_newer');
      // Automatic upgrade requires a readable data schema. A candidate whose
      // schema range cannot read data written under the current range, or one
      // demanding an explicit migration, is refused before anything stops.
      if (targetDescriptor.dataSchema.min > currentDescriptor.dataSchema.max || currentDescriptor.dataSchema.min > targetDescriptor.dataSchema.max) return error('data_schema_incompatible');
      if (targetDescriptor.migrationPolicy === 'explicit') return error('data_migration_explicit_required');
      if (this.endpointState(request.port).port !== request.port) return error('endpoint_changed');
      const health = await probe(request.port);
      if (!health || health.daemon_id !== record.receipt.daemonId) return error('maintenance_target_mismatch');
      this.validateHealth(health, currentDescriptor, record.descriptorHash, data.dataRootId, data.db, record.startFingerprint);
      // Avoid producing a refused signed transaction on every automatic
      // recheck while real work is known to be active. The final signed Stop
      // still rechecks admission atomically; this is only a negative hint.
      if (!fromVerifiedBundle && (health.lifecycle_upgrade_version === 1 ? health.upgrade_idle : health.maintenance_idle) === false)
        return error('active_work');
      const audit = CoreUpgradeRecordSchema.parse({ schemaVersion: 1, requestId: request.requestId,
        requestHash: createHash('sha256').update(JSON.stringify(request)).digest('hex'),
        from: record, targetVersionName: request.targetVersionName, targetDescriptorHash: target.identity.descriptorHash,
        state: 'staged', updatedAt: this.manager.clock().toISOString() });
      writeJson(file, audit);
      return audit;
    });
    let audit = prepared;
    const save = (state: CoreUpgradeRecord['state']) => { audit = CoreUpgradeRecordSchema.parse({ ...audit, state, updatedAt: this.manager.clock().toISOString() }); writeJson(file, audit); };
    const maintenanceRequestId = randomUUID();
    audit = CoreUpgradeRecordSchema.parse({ ...audit, maintenanceRequestId });
    writeJson(file, audit);
    save('stopping');
    try {
      await this.maintainCoreInternal({ operation: 'stop', confirmed: true, requestId: maintenanceRequestId, client: request.client, handle: request.handle, port: request.port }, true, request.targetVersionName, fromVerifiedBundle);
    } catch (e) {
      const sub = await this.inspectMaintenance(maintenanceRequestId).catch(() => undefined);
      if (!sub || sub.state === 'refused') { save('refused'); throw e; }
      save('recovery_required');
      throw new Error('maintenance_outcome_requires_inspection');
    }
    save('switching');
    try {
      await this.manager.activate(request.targetVersionName, async () => {
        const data = this.paths();
        if (this.pendingMaintenance().length) error('maintenance_recovery_required');
        if (this.readRun(data.dataRootId)) error('daemon_state_unknown');
        if (this.manager.liveLeases().some(l => l.dataRootId === data.dataRootId)) error('active_clients');
        if (this.endpointState(request.port).port !== request.port) error('endpoint_changed');
        const selection = this.manager.selectVersion(request.targetVersionName);
        if (!selection) return error('core_missing');
        verifyInstalledCore(selection.root, selection.identity.descriptorHash, { ...this.trust, platform: process.platform, arch: process.arch });
      });
    } catch (e) {
      return this.rollbackUpgrade(request, audit, save, e);
    }
    save('starting');
    let attachment: AttachCoreResult;
    try {
      attachment = await this.locked(() => this.attachLocked(AttachCoreRequestSchema.parse({ client: request.client, port: request.port, readyTimeoutMs: request.readyTimeoutMs,
        ...(fs.existsSync(this.participantFile(request.handle.leaseId)) ? {reconnectAfterUpgrade:true}: {}) }), request.targetVersionName));
      save('verifying');
      if (attachment.receipt.descriptorHash !== audit.targetDescriptorHash || attachment.receipt.daemonId === audit.from.receipt?.daemonId
        || attachment.receipt.startFingerprint === audit.from.startFingerprint || this.manager.select()?.versionName !== request.targetVersionName) return error('core_identity_conflict');
    } catch (e) {
      return this.rollbackUpgrade(request, audit, save, e);
    }
    this.recordUpgradeResult(audit,attachment);
    save('committed');
    return UpgradeCoreResultSchema.parse({ operation: 'upgrade', requestId: request.requestId, state: 'committed', fromVersionName: audit.from.versionName, targetVersionName: request.targetVersionName, attachment });
  }

  private async rollbackUpgrade(request: z.infer<typeof UpgradeCoreRequestSchema>, audit: CoreUpgradeRecord, save: (state: CoreUpgradeRecord['state']) => void, cause?: unknown): Promise<UpgradeCoreResult> {
    save('rolling_back');
    try {
      const data = this.paths();
      const record = await this.locked(async () => this.readRun(data.dataRootId));
      if (record) {
        if (record.versionName !== audit.targetVersionName) return error('upgrade_rollback_blocked');
        // Rollback is authorized only by positive candidate death. A live or
        // answering candidate is never killed or replaced implicitly.
        if (record.status === 'ready' || await probe(request.port)) return error('upgrade_rollback_blocked');
        if (!record.pid) return error('upgrade_rollback_blocked');
        try { process.kill(record.pid, 0); return error('upgrade_rollback_blocked'); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
        await this.locked(async () => {
          const current = this.readRun(data.dataRootId);
          if (!current || current.startFingerprint !== record.startFingerprint) return error('upgrade_rollback_blocked');
          const archive = path.join(this.manager.state, 'recovered-starts'); fs.mkdirSync(archive, { recursive: true });
          fs.renameSync(this.runFile(data.dataRootId), path.join(archive, audit.requestId + '.json'));
        });
      }
      const active = this.manager.select();
      if (active && active.versionName === audit.targetVersionName) {
        await this.manager.activate(audit.from.versionName, async () => {
          const current = this.paths();
          if (this.readRun(current.dataRootId)) error('daemon_state_unknown');
          if (this.manager.liveLeases().some(l => l.dataRootId === current.dataRootId)) error('active_clients');
        });
      } else if (active && active.versionName !== audit.from.versionName) return error('upgrade_rollback_blocked');
      const attachment = await this.locked(() => this.attachLocked(AttachCoreRequestSchema.parse({ client: request.client, port: request.port, readyTimeoutMs: request.readyTimeoutMs,
        ...(fs.existsSync(this.participantFile(request.handle.leaseId)) ? {reconnectAfterUpgrade:true}: {}) }), audit.from.versionName));
      if (attachment.receipt.descriptorHash !== audit.from.descriptorHash || attachment.receipt.daemonId === audit.from.receipt?.daemonId) return error('upgrade_rollback_blocked');
      this.recordUpgradeResult(audit,attachment);
      save('rolled_back');
      return UpgradeCoreResultSchema.parse({ operation: 'upgrade', requestId: audit.requestId, state: 'rolled_back', fromVersionName: audit.from.versionName, targetVersionName: audit.targetVersionName, attachment });
    } catch (e) {
      save('recovery_required');
      throw new Error('upgrade_rollback_failed:cause=' + (cause instanceof Error ? cause.message : String(cause)) + ';rollback=' + (e instanceof Error ? e.message : String(e)));
    }
  }

  private boundLease(input: unknown): { handle: z.infer<typeof LeaseHandleSchema>; file: string; lease?: ClientLease } {
    const handle = LeaseHandleSchema.parse(input);
    const file = path.join(this.manager.leases, `${handle.leaseId}.json`);
    if (!fs.existsSync(file)) return { handle, file };
    const lease = ClientLeaseSchema.parse(readJson(file));
    if (Object.entries(handle).some(([key, value]) => lease[key as keyof ClientLease] !== value)) error('lease_target_mismatch');
    return { handle, file, lease };
  }
  async heartbeat(input: unknown): Promise<ClientLease> {
    const request = HeartbeatCoreRequestSchema.parse(input);
    return this.locked(async () => {
      const { lease } = this.boundLease(request.handle);
      if (!lease) return error('lease_missing');
      if (Date.parse(lease.expiresAt) <= this.manager.clock().getTime()) return error('lease_expired');
      const data = this.paths();
      if (data.dataRootId !== lease.dataRootId) return error('data_root_conflict');
      const record = this.readRun(lease.dataRootId);
      if (!record || record.status !== 'ready' || record.port !== request.port || !record.receipt) return error('daemon_state_unknown');
      const r = record.receipt;
      if (r.environment !== this.trust.environment) return error('environment_mismatch');
      const h = await probe(request.port);
      // A timed-out/unavailable HTTP probe is NOT positive evidence that a
      // signed running Core was replaced. The VS Code host may retry the same
      // lease while its recorded expiry is still valid; mismatched returned
      // identity fields are still definitive, fail-closed conflicts.
      if (!h) return error('daemon_state_unknown');
      if (h.daemon_id !== lease.daemonId || h.start_fingerprint !== r.startFingerprint || h.descriptor_hash !== lease.descriptorHash || h.data_root_id !== lease.dataRootId || h.runtime_id !== r.runtimeId || h.build_id !== r.buildId || h.runtime_version !== r.runtimeVersion || h.version !== r.daemonVersion || h.web_build_id !== r.webBuildId || h.core_environment !== r.environment || h.core_cloud_origin !== r.cloudOrigin || h.cloud_origin !== r.cloudOrigin || h.core_protocol.min !== r.coreProtocol.min || h.core_protocol.max !== r.coreProtocol.max || !samePath(physicalPath(h.db_path), data.db)) return error('core_identity_conflict');
      const renewed = ClientLeaseSchema.parse({ ...lease, expiresAt: new Date(this.manager.clock().getTime() + LEASE_TTL_MS).toISOString() });
      this.manager.writeLease(renewed);
      return renewed;
    });
  }
  /**
   * Internal, opt-out idle shutdown. The daemon proposes only its own exact
   * incarnation; the Manager owns the grace clock, client leases, locks, signed
   * Stop transaction and audit. Never treats "no VS Code window" as "no work".
   *
   * A short-lived Manager command is polled by the detached Core; there is no
   * second resident supervisor or implicit permission to stop another Core.
   */
  async stopIdleCore(input: unknown): Promise<{ state: 'disabled' | 'clients' | 'grace' | 'work' | 'maintenance' | 'superseded' | 'stopped' }> {
    const request = z.object({
      port: z.number().int().min(1).max(65535),
      daemonId: z.string().min(1).max(200),
      dataRootId: z.string().regex(/^[a-f0-9]{64}$/),
      descriptorHash: z.string().regex(/^[a-f0-9]{64}$/),
      startFingerprint: z.string().min(1).max(500),
    }).strict().parse(input);
    if (this.env.BLACKHOLE_CORE_IDLE_SHUTDOWN === 'off') return { state: 'disabled' };
    const idleFile = path.join(this.manager.state, 'idle', request.dataRootId + '.json');
    const step = await this.locked(async () => {
      const data = this.paths();
      if (data.dataRootId !== request.dataRootId) return { state: 'superseded' as const };
      if (this.pendingMaintenance().length || this.pendingUpgrades().length) return { state: 'maintenance' as const };
      const record = this.readRun(data.dataRootId);
      if (!record || record.status !== 'ready' || !record.pid || !record.receipt
        || record.port !== request.port || record.receipt.daemonId !== request.daemonId
        || record.descriptorHash !== request.descriptorHash || record.startFingerprint !== request.startFingerprint)
        return { state: 'superseded' as const };
      if (this.manager.liveLeases().some(lease => lease.dataRootId === data.dataRootId)) return { state: 'clients' as const };

      const identity = { schemaVersion: 1, daemonId: request.daemonId, descriptorHash: request.descriptorHash,
        dataRootId: data.dataRootId, startFingerprint: request.startFingerprint };
      const marker = fs.existsSync(idleFile) ? z.object({
        schemaVersion: z.literal(1), daemonId: z.string(), descriptorHash: z.string(), dataRootId: z.string(),
        startFingerprint: z.string(), since: z.number().int().nonnegative(),
      }).strict().parse(readJson(idleFile)) : undefined;
      const now = this.manager.clock().getTime();
      if (!marker || Object.entries(identity).some(([key, value]) => marker[key as keyof typeof marker] !== value)) {
        writeJson(idleFile, { ...identity, since: now });
        return { state: 'grace' as const };
      }
      if (now < marker.since || now - marker.since < 30_000) return { state: 'grace' as const };

      const selected = this.manager.selectVersion(record.versionName);
      if (!selected || selected.identity.descriptorHash !== record.descriptorHash) return error('core_identity_conflict');
      const { descriptor } = verifyInstalledCore(selected.root, record.descriptorHash,
        { ...this.trust, platform: process.platform, arch: process.arch }) as { descriptor: CoreDescriptor };
      const health = await probe(record.port);
      if (!health) return error('daemon_state_unknown');
      this.validateHealth(health, descriptor, record.descriptorHash, data.dataRootId, data.db, record.startFingerprint);
      if (health.daemon_id !== request.daemonId || health.lifecycle_state !== 'managed')
        return error('core_identity_conflict');

      // This short-lived lease exists only inside Manager authority, not in a
      // VS Code/Web account. Racing attaches get a new lease and the standard
      // maintainCore guard refuses our Stop. No restart or force-kill is possible.
      const client = ManagedClientSchema.parse({
        clientId: 'manager:idle-stop', clientInstanceId: randomUUID(), kind: 'desktop',
        version: descriptor.runtimeVersion, protocol: { min: 1, max: 1 }, capabilities: ['web-ui'],
      });
      const clock = this.manager.clock();
      const lease = ClientLeaseSchema.parse({
        schemaVersion: 1, leaseId: randomUUID(), clientId: client.clientId, clientInstanceId: client.clientInstanceId,
        kind: client.kind, runtimeId: descriptor.runtimeId, buildId: descriptor.buildId,
        descriptorHash: record.descriptorHash, dataRootId: data.dataRootId, daemonId: request.daemonId,
        issuedAt: clock.toISOString(), expiresAt: new Date(clock.getTime() + LEASE_TTL_MS).toISOString(),
      });
      this.manager.writeLease(lease);
      return { state: 'attempt' as const, client, lease };
    });
    if (step.state !== 'attempt') return step;
    const handle = LeaseHandleSchema.parse(Object.fromEntries(
      ['leaseId', 'clientInstanceId', 'daemonId', 'dataRootId', 'descriptorHash']
        .map(key => [key, step.lease[key as keyof ClientLease]])));
    try {
      await this.maintainCoreInternal({
        client: step.client, handle, port: request.port, confirmed: true, operation: 'stop', requestId: randomUUID(),
      }, false, undefined, true);
      return { state: 'stopped' };
    } catch (e) {
      const code = e instanceof Error ? e.message : '';
      if (code === 'active_clients') return { state: 'clients' };
      if (['active_work', 'active_requests', 'active_handlers'].includes(code)) return { state: 'work' };
      // Unknown signed-stop outcomes are journalled and block future auto
      // attempts until explicit inspection. Never retry or clear that journal.
      throw e;
    } finally {
      await this.locked(async () => {
        const { file, lease } = this.boundLease(handle);
        if (lease) fs.unlinkSync(file);
        // Do not discard the marker or a recovery journal after an ambiguous
        // outcome. A subsequent attach always resets the grace marker.
        if (!this.readRun(request.dataRootId) && fs.existsSync(idleFile)) fs.unlinkSync(idleFile);
      });
    }
  }

  async detach(input: unknown): Promise<{ detached: boolean }> {
    return this.locked(async () => {
      const { file, lease } = this.boundLease(input);
      if (lease) fs.unlinkSync(file);
      // No network, shutdown, pointer change or GC. Running Core remains pinned.
      return { detached: true };
    });
  }
}
