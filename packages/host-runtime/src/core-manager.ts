import fs from 'node:fs';
import { RunningCoreRecordSchema, CoreMaintenanceRecordSchema, CoreUpgradeRecordSchema } from '../../contracts/src/manager-protocol.ts';
import path from 'node:path';
import os from 'node:os';
import { createPrivateKey, generateKeyPairSync, randomBytes, randomUUID, sign, verify } from 'node:crypto';
import {
  ClientInventorySchema, ClientLeaseSchema, CoreDescriptorSchema, LifecycleTokenClaimsSchema, ProvisionTransactionSchema,
  type ClientInventory, type ClientInventoryEntry, type ClientLease, type CoreDescriptor, type LifecycleTokenClaims,
  type ProvisionTransaction,
} from '../../contracts/src/core-runtime.ts';

export type VerifiedCore = { descriptor: CoreDescriptor; descriptorHash: string };
export type CoreVerifier = (archive: string, destination: string) => Promise<VerifiedCore>;
export type Clock = () => Date;
export type StoredIdentity = { runtimeId: string; runtimeVersion: string; buildId: string; descriptorHash: string; webBuildId: string; coreProtocol: { min: number; max: number }; environment: 'test' | 'production'; cloudOrigin: string };

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const safeSegment = (value: string) => {
  const result = value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  if (!result || result === '.' || result === '..') throw new Error('unsafe_store_segment');
  return result;
};

export const coreVersionName = (descriptor: Pick<CoreDescriptor, 'runtimeVersion' | 'buildId'>) => `${safeSegment(descriptor.runtimeVersion)}-${safeSegment(descriptor.buildId)}`;

export class StoreLockError extends Error {
  constructor(readonly code: 'lock_busy' | 'lock_state_unknown', message: string) { super(message); }
}

export class CoreManager {
  private lifecycleHeld = false;
  readonly versions: string;
  readonly staging: string;
  readonly state: string;
  readonly transactions: string;
  readonly leases: string;
  readonly locks: string;
  readonly alive: string;

  constructor(readonly root: string, readonly clock: Clock = () => new Date()) {
    this.versions = path.join(root, 'versions');
    this.staging = path.join(root, 'staging');
    this.state = path.join(root, 'state');
    this.transactions = path.join(this.state, 'transactions');
    this.leases = path.join(this.state, 'client-leases');
    this.locks = path.join(this.state, 'locks');
    this.alive = path.join(this.state, 'alive');
  }

  initialize(): void {
    for (const dir of [this.root, this.versions, this.staging, this.transactions, this.leases, this.locks, this.alive]) fs.mkdirSync(dir, { recursive: true });
  }

  private boot?: string;

  /** Identifier of the current operating-system boot.
   *
   * A recorded Core PID cannot be trusted as proof of life: Windows recycles
   * PIDs, so the number may now belong to an unrelated process. If a record was
   * written in an earlier boot, the process it names is provably gone.
   *
   * os.uptime() never decreases inside one boot, so a decrease is positive
   * evidence of a reboot. Wall-clock boot time is deliberately NOT used: some
   * platforms exclude suspend time and it would drift forward. */
  bootIdentity(): string {
    return (this.boot ??= this.loadBootIdentity());
  }

  private loadBootIdentity(): string {
    this.initialize();
    const file = path.join(this.state, 'boot.json');
    const uptimeMs = Math.round(os.uptime() * 1000);
    let stored: { bootId?: unknown; uptimeMs?: unknown } | undefined;
    try { stored = JSON.parse(fs.readFileSync(file, 'utf8')) as { bootId?: unknown; uptimeMs?: unknown }; } catch { stored = undefined; }
    const readable = typeof stored?.bootId === 'string' && /^[A-Za-z0-9-]{8,100}$/.test(stored.bootId);
    const prior = typeof stored?.uptimeMs === 'number' && Number.isFinite(stored.uptimeMs) && stored.uptimeMs >= 0 ? stored.uptimeMs : undefined;
    const next = !readable || (prior !== undefined && uptimeMs + 5_000 < prior) ? randomUUID() : stored!.bootId as string;
    try { this.atomicWrite(file, { schemaVersion: 1, bootId: next, uptimeMs, observedAt: this.clock().toISOString() }); } catch { /* advisory only */ }
    return next;
  }

  private atomicWrite(file: string, value: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(temp, json(value), { encoding: 'utf8', flag: 'wx' });
    const handle = fs.openSync(temp, 'r+');
    try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
    fs.renameSync(temp, file);
  }

  private readJson(file: string): unknown {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { throw new StoreLockError('lock_state_unknown', `Cannot read trusted store state: ${file}: ${String(error)}`); }
  }

  async withLock<T>(name: 'install' | 'lifecycle', action: () => Promise<T> | T, staleAfterMs = 120_000): Promise<T> {
    this.initialize();
    const lock = path.join(this.locks, `${name}.lock`);
    const claim = { schemaVersion: 1, lockId: randomUUID(), pid: process.pid, createdAt: this.clock().toISOString() };
    try { fs.mkdirSync(lock); this.atomicWrite(path.join(lock, 'owner.json'), claim); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const ownerFile = path.join(lock, 'owner.json');
      if (!fs.existsSync(ownerFile)) {
        let mtimeMs = this.clock().getTime();
        try { mtimeMs = fs.statSync(lock).mtimeMs; }
        catch (statError) {
          if ((statError as NodeJS.ErrnoException).code === 'ENOENT') throw new StoreLockError('lock_busy', `${name} lock is in transition`);
          throw statError;
        }
        if (this.clock().getTime() - mtimeMs <= staleAfterMs) throw new StoreLockError('lock_busy', `${name} lock is held`);
        const quarantine = `${lock}.stale.${randomUUID()}`;
        try { fs.renameSync(lock, quarantine); fs.rmSync(quarantine, { recursive: true, force: true }); fs.mkdirSync(lock); this.atomicWrite(ownerFile, claim); }
        catch (replaceError) { throw new StoreLockError('lock_busy', `${name} stale lock could not be replaced: ${String(replaceError)}`); }
      } else {
        const owner = this.readJson(ownerFile) as { createdAt?: string };
        const created = typeof owner.createdAt === 'string' ? Date.parse(owner.createdAt) : Number.NaN;
        if (!Number.isFinite(created)) throw new StoreLockError('lock_state_unknown', `${name} lock owner is invalid`);
        if (this.clock().getTime() - created <= staleAfterMs) throw new StoreLockError('lock_busy', `${name} lock is held`);
        const pid = (owner as { pid?: unknown }).pid;
        if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); throw new StoreLockError('lock_busy', `${name} lock owner is still alive`); }
          catch (probe) { if (probe instanceof StoreLockError || (probe as NodeJS.ErrnoException).code === 'EPERM') throw probe; }
        }
        const quarantine = `${lock}.stale.${randomUUID()}`;
        try { fs.renameSync(lock, quarantine); fs.rmSync(quarantine, { recursive: true, force: true }); fs.mkdirSync(lock); this.atomicWrite(ownerFile, claim); }
        catch (replaceError) { throw new StoreLockError('lock_busy', `${name} stale lock could not be replaced: ${String(replaceError)}`); }
      }
    }
    if (name === 'lifecycle') this.lifecycleHeld = true;
    try { return await action(); }
    finally {
      if (name === 'lifecycle') this.lifecycleHeld = false;
      try {
        const owner = this.readJson(path.join(lock, 'owner.json')) as { lockId?: string };
        if (owner.lockId === claim.lockId) {
          const releasing = `${lock}.releasing.${claim.lockId}`;
          try { fs.renameSync(lock, releasing); fs.rmSync(releasing, { recursive: true, force: true }); }
          catch { fs.rmSync(lock, { recursive: true, force: true }); }
        }
      } catch { /* Never delete a lock whose ownership cannot be proven. */ }
    }
  }

  private transaction(record: ProvisionTransaction): void {
    ProvisionTransactionSchema.parse(record);
    this.atomicWrite(path.join(this.transactions, `${record.transactionId}.json`), record);
  }

  async provision(archive: string, source: 'seed' | 'download', verifyAndExtract: CoreVerifier, waitForLockMs = 0): Promise<VerifiedCore> {
    const deadline=Date.now()+Math.max(0,Math.min(waitForLockMs,30_000));
    for (;;) {
      let entered=false;
      try { return await this.provisionAttempt(archive,source,verifyAndExtract,()=>{entered=true;}); }
      catch (cause) {
        // Host bootstrap may wait for another window to stage the same seed.
        // Once THIS attempt enters the lock, its outcome is never retried.
        if (entered || !(cause instanceof StoreLockError) || cause.code!=='lock_busy' || Date.now()>=deadline) throw cause;
        await new Promise(resolve=>setTimeout(resolve,150));
      }
    }
  }
  private async provisionAttempt(archive:string,source:'seed'|'download',verifyAndExtract:CoreVerifier,onEntered:()=>void):Promise<VerifiedCore> {
    return this.withLock('install', async () => {
      onEntered();
      const transactionId = randomUUID();
      const now = this.clock().toISOString();
      const destination = path.join(this.staging, transactionId);
      fs.mkdirSync(destination, { recursive: false });
      let record: ProvisionTransaction | undefined;
      try {
        const verified = await verifyAndExtract(archive, destination);
        const descriptor = CoreDescriptorSchema.parse(verified.descriptor);
        record = { schemaVersion: 1, transactionId, state: 'verified', runtimeId: descriptor.runtimeId, buildId: descriptor.buildId, descriptorHash: verified.descriptorHash, source, createdAt: now, updatedAt: this.clock().toISOString() };
        this.transaction(record);
        const versionName = coreVersionName(descriptor);
        const committed = path.join(this.versions, versionName);
        const identityFile = path.join(committed, 'core-identity.json');
        if (fs.existsSync(committed)) {
          const identity = this.readJson(identityFile) as { descriptorHash?: string };
          if (identity.descriptorHash !== verified.descriptorHash) throw new Error('core_identity_conflict');
          fs.rmSync(destination, { recursive: true, force: true });
        } else {
          this.atomicWrite(path.join(destination, 'core-identity.json'), { runtimeId: descriptor.runtimeId, runtimeVersion: descriptor.runtimeVersion, buildId: descriptor.buildId, descriptorHash: verified.descriptorHash, webBuildId: descriptor.webBuildId, coreProtocol: descriptor.coreProtocol, environment: descriptor.environment, cloudOrigin: descriptor.cloudOrigin });
          fs.renameSync(destination, committed);
        }
        record = { ...record, state: 'committed', updatedAt: this.clock().toISOString() };
        this.transaction(record);
        return verified;
      } catch (error) {
        fs.rmSync(destination, { recursive: true, force: true });
        if (record) this.transaction({ ...record, state: 'failed', updatedAt: this.clock().toISOString(), errorCode: error instanceof Error ? error.message.slice(0, 200) : 'unknown' });
        throw error;
      }
    });
  }

  private signingKey(): { privateKey: ReturnType<typeof createPrivateKey>; publicKeyPem: string } {
    const privateFile = path.join(this.state, 'manager-signing-private.pem');
    const publicFile = path.join(this.state, 'manager-signing-public.pem');
    if (!fs.existsSync(privateFile) || !fs.existsSync(publicFile)) {
      if (fs.existsSync(privateFile) || fs.existsSync(publicFile)) throw new Error('manager_signing_key_incomplete');
      const pair = generateKeyPairSync('ed25519');
      const privatePem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
      const publicPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
      this.atomicWrite(path.join(this.state, 'manager-signing-key.json'), { schemaVersion: 1, algorithm: 'ed25519' });
      fs.writeFileSync(privateFile, privatePem, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      fs.writeFileSync(publicFile, publicPem, { encoding: 'utf8', flag: 'wx', mode: 0o644 });
    }
    return { privateKey: createPrivateKey(fs.readFileSync(privateFile)), publicKeyPem: fs.readFileSync(publicFile, 'utf8') };
  }

  lifecyclePublicKey(): string {
    if (!this.lifecycleHeld) throw new Error('lifecycle_lock_required');
    return this.signingKey().publicKeyPem;
  }

  signLifecycleGrant(input: Omit<LifecycleTokenClaims, 'schemaVersion' | 'nonce' | 'issuedAt' | 'expiresAt'>, ttlMs = 30_000) {
    if (!this.lifecycleHeld) throw new Error('lifecycle_lock_required');
    if (!Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > 60_000) throw new Error('lifecycle_token_ttl_invalid');
    const issued = this.clock();
    const claims = LifecycleTokenClaimsSchema.parse({ ...input, schemaVersion: 1, nonce: randomBytes(24).toString('base64url'), issuedAt: issued.toISOString(), expiresAt: new Date(issued.getTime() + ttlMs).toISOString() });
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const key = this.signingKey();
    return { token: `${payload}.${sign(null, Buffer.from(payload), key.privateKey).toString('base64url')}`, publicKeyPem: key.publicKeyPem, claims };
  }
  async issueLifecycleToken(input: Omit<LifecycleTokenClaims, 'schemaVersion' | 'nonce' | 'issuedAt' | 'expiresAt'>, ttlMs = 30_000) {
    return this.withLock('lifecycle', () => this.signLifecycleGrant(input, ttlMs));
  }

  async consumeLifecycleToken(token: string, expected: Pick<LifecycleTokenClaims, 'operation' | 'daemonId' | 'startFingerprint' | 'runtimeId' | 'buildId' | 'dataRootId' | 'transactionId'>): Promise<LifecycleTokenClaims> {
    return this.withLock('lifecycle', () => {
      const [payload, signature, extra] = token.split('.');
      if (!payload || !signature || extra) throw new Error('lifecycle_token_invalid');
      const key = this.signingKey();
      if (!verify(null, Buffer.from(payload), key.publicKeyPem, Buffer.from(signature, 'base64url'))) throw new Error('lifecycle_token_signature_invalid');
      let raw: unknown; try { raw = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { throw new Error('lifecycle_token_invalid'); }
      const claims = LifecycleTokenClaimsSchema.parse(raw);
      if (Date.parse(claims.expiresAt) <= this.clock().getTime()) throw new Error('lifecycle_token_expired');
      for (const field of ['operation', 'daemonId', 'startFingerprint', 'runtimeId', 'buildId', 'dataRootId', 'transactionId'] as const) if (claims[field] !== expected[field]) throw new Error(`lifecycle_token_target_mismatch:${field}`);
      const nonceDir = path.join(this.state, 'used-nonces'); fs.mkdirSync(nonceDir, { recursive: true });
      fs.writeFileSync(path.join(nonceDir, `${claims.nonce}.used`), claims.expiresAt, { encoding: 'utf8', flag: 'wx' });
      return claims;
    });
  }

  queryTransaction(transactionId: string): ProvisionTransaction | undefined {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(transactionId)) throw new Error('transaction_id_invalid');
    const file = path.join(this.transactions, `${transactionId}.json`);
    return fs.existsSync(file) ? ProvisionTransactionSchema.parse(this.readJson(file)) : undefined;
  }

  async registerClient(input: Omit<ClientInventoryEntry, 'firstSeenAt' | 'lastSeenAt'>): Promise<ClientInventory> {
    return this.withLock('install', () => {
      const file = path.join(this.root, 'clients.json');
      const now = this.clock().toISOString();
      const current = fs.existsSync(file) ? ClientInventorySchema.parse(this.readJson(file)) : { schemaVersion: 1 as const, revision: 0, clients: [] };
      const found = current.clients.find((entry) => entry.clientId === input.clientId);
      const entry = ClientInventorySchema.shape.clients.element.parse({ ...input, firstSeenAt: found?.firstSeenAt ?? now, lastSeenAt: now });
      const next = { schemaVersion: 1 as const, revision: current.revision + 1, clients: [...current.clients.filter((item) => item.clientId !== input.clientId), entry] };
      this.atomicWrite(file, ClientInventorySchema.parse(next));
      return next;
    });
  }

  writeLease(lease: ClientLease): void {
    this.atomicWrite(path.join(this.leases, `${lease.leaseId}.json`), ClientLeaseSchema.parse(lease));
  }

  liveLeases(): ClientLease[] {
    this.initialize();
    const now = this.clock().getTime();
    const result: ClientLease[] = [];
    for (const name of fs.readdirSync(this.leases)) {
      if (!name.endsWith('.json')) continue;
      const lease = ClientLeaseSchema.parse(this.readJson(path.join(this.leases, name)));
      if (Date.parse(lease.expiresAt) > now) result.push(lease);
    }
    return result;
  }

  private installed(): Map<string, StoredIdentity> {
    this.initialize();
    const result = new Map<string, StoredIdentity>();
    for (const versionName of fs.readdirSync(this.versions)) {
      const directory = path.join(this.versions, versionName);
      if (!fs.statSync(directory).isDirectory()) throw new Error('unknown_versions_entry');
      const identity = this.readJson(path.join(directory, 'core-identity.json')) as Record<string, unknown>;
      if (typeof identity.runtimeId !== 'string' || typeof identity.runtimeVersion !== 'string' || typeof identity.buildId !== 'string' || typeof identity.descriptorHash !== 'string' || typeof identity.webBuildId !== 'string' || typeof identity.cloudOrigin !== 'string' || (identity.environment !== 'test' && identity.environment !== 'production') || typeof identity.coreProtocol !== 'object' || identity.coreProtocol === null) throw new Error(`invalid_core_identity:${versionName}`);
      const protocol = identity.coreProtocol as { min?: unknown; max?: unknown }; if (!Number.isInteger(protocol.min) || !Number.isInteger(protocol.max)) throw new Error(`invalid_core_identity:${versionName}`);
      result.set(versionName, identity as StoredIdentity);
    }
    return result;
  }

  selectVersion(versionName: string): { versionName: string; root: string; identity: StoredIdentity } | undefined {
    const identity = this.installed().get(versionName);
    return identity ? { versionName, root: path.join(this.versions, versionName), identity } : undefined;
  }

  select(pointer = 'active.json'): { versionName: string; root: string; identity: StoredIdentity } | undefined {
    if (pointer !== 'active.json' && pointer !== 'known-good.json') throw new Error('invalid_pointer_name');
    const file = path.join(this.root, pointer);
    if (!fs.existsSync(file)) return undefined;
    const value = this.readJson(file) as { schemaVersion?: number; versionName?: string; descriptorHash?: string };
    if (value.schemaVersion !== 1 || typeof value.versionName !== 'string' || typeof value.descriptorHash !== 'string') throw new Error(`invalid_pointer:${pointer}`);
    const identity = this.installed().get(value.versionName);
    if (!identity || identity.descriptorHash !== value.descriptorHash) throw new Error(`broken_pointer:${pointer}`);
    return { versionName: value.versionName, root: path.join(this.versions, value.versionName), identity };
  }

  async activateIfAbsent(versionName: string, guard: () => Promise<void>) {
    return this.withLock('install', () => this.withLock('lifecycle', async () => {
      const current = this.select() ?? this.select('known-good.json');
      if (current) return current;
      const selected = this.selectVersion(versionName);
      if (!selected) throw new Error('core_missing');
      await guard();
      this.atomicWrite(path.join(this.root, 'active.json'), { schemaVersion: 1, versionName, descriptorHash: selected.identity.descriptorHash, updatedAt: this.clock().toISOString() });
      return selected;
    }));
  }

  async activate(versionName: string, guard?: () => Promise<void>): Promise<void> {
    await this.withLock('install', () => this.withLock('lifecycle', async () => {
      await guard?.();
      const identity = this.installed().get(versionName);
      if (!identity) throw new Error('core_missing');
      const previous = this.select();
      if (previous && previous.versionName !== versionName) this.atomicWrite(path.join(this.root, 'known-good.json'), { schemaVersion: 1, versionName: previous.versionName, descriptorHash: previous.identity.descriptorHash, updatedAt: this.clock().toISOString() });
      this.atomicWrite(path.join(this.root, 'active.json'), { schemaVersion: 1, versionName, descriptorHash: identity.descriptorHash, updatedAt: this.clock().toISOString() });
    }));
  }

  async recoverTransactions(): Promise<{ committed: string[]; rolledBack: string[] }> {
    return this.withLock('install', () => {
      const installed = this.installed();
      const committed: string[] = [], rolledBack: string[] = [];
      const byIdentity = new Map([...installed].map(([name, identity]) => [`${identity.runtimeId}:${identity.buildId}:${identity.descriptorHash}`, name]));
      const referencedStaging = new Set<string>();
      for (const name of fs.readdirSync(this.transactions)) {
        if (!name.endsWith('.json')) continue;
        const file = path.join(this.transactions, name);
        const tx = ProvisionTransactionSchema.parse(this.readJson(file));
        referencedStaging.add(tx.transactionId);
        if (tx.state !== 'prepared' && tx.state !== 'staged' && tx.state !== 'verified') continue;
        const key = `${tx.runtimeId}:${tx.buildId}:${tx.descriptorHash}`;
        if (byIdentity.has(key)) {
          this.transaction({ ...tx, state: 'committed', updatedAt: this.clock().toISOString() });
          committed.push(tx.transactionId);
        } else {
          fs.rmSync(path.join(this.staging, tx.transactionId), { recursive: true, force: true });
          this.transaction({ ...tx, state: 'rolled_back', updatedAt: this.clock().toISOString(), errorCode: 'recovered_incomplete_transaction' });
          rolledBack.push(tx.transactionId);
        }
      }
      for (const name of fs.readdirSync(this.staging)) if (!referencedStaging.has(name)) fs.rmSync(path.join(this.staging, name), { recursive: true, force: true });
      return { committed, rolledBack };
    });
  }

  retentionSet(extra: Iterable<string> = []): Set<string> {
    const retained = new Set(extra);
    const installed = this.installed();
    for (const pointer of ['active.json', 'known-good.json']) {
      const selected = this.select(pointer);
      if (selected) retained.add(selected.versionName);
    }
    const retainIdentity = (runtimeId: string, buildId: string) => {
      for (const [name, identity] of installed) if (identity.runtimeId === runtimeId && identity.buildId === buildId) retained.add(name);
    };
    for (const lease of this.liveLeases()) retainIdentity(lease.runtimeId, lease.buildId);
    const running = path.join(this.state, 'running');
    if (fs.existsSync(running)) for (const name of fs.readdirSync(running).filter((name) => name.endsWith('.json'))) {
      const record = RunningCoreRecordSchema.parse(this.readJson(path.join(running, name)));
      if (installed.get(record.versionName)?.descriptorHash !== record.descriptorHash) throw new Error('running_core_state_unknown');
      retained.add(record.versionName); // Ready AND ambiguous starting records pin code, even after Quit.
    }
    const maintenance = path.join(this.state, 'maintenance');
    if (fs.existsSync(maintenance)) for (const name of fs.readdirSync(maintenance).filter(n => n.endsWith('.json'))) {
      const record = CoreMaintenanceRecordSchema.parse(this.readJson(path.join(maintenance, name)));
      if (!['completed', 'refused', 'recovered_stopped', 'recovered_running'].includes(record.state)) {
        if (installed.get(record.target.versionName)?.descriptorHash !== record.target.descriptorHash) throw new Error('maintenance_state_unknown');
        retained.add(record.target.versionName);
      }
    }
    const upgrades = path.join(this.state, 'upgrade');
    if (fs.existsSync(upgrades)) for (const name of fs.readdirSync(upgrades).filter(n => n.endsWith('.json'))) {
      const record = CoreUpgradeRecordSchema.parse(this.readJson(path.join(upgrades, name)));
      if (!['committed', 'rolled_back', 'refused'].includes(record.state)) {
        // An unresolved upgrade pins both sides: the previous Core may be
        // the rollback target and the candidate may be the running target.
        if (installed.get(record.from.versionName)?.descriptorHash !== record.from.descriptorHash) throw new Error('upgrade_state_unknown');
        if (installed.get(record.targetVersionName)?.descriptorHash !== record.targetDescriptorHash) throw new Error('upgrade_state_unknown');
        retained.add(record.from.versionName);
        retained.add(record.targetVersionName);
      }
    }
    for (const name of fs.readdirSync(this.transactions)) {
      if (!name.endsWith('.json')) continue;
      const tx = ProvisionTransactionSchema.parse(this.readJson(path.join(this.transactions, name)));
      if (!['committed', 'rolled_back', 'failed'].includes(tx.state)) retainIdentity(tx.runtimeId, tx.buildId);
    }
    return retained;
  }

  async garbageCollect(extra: Iterable<string> = []): Promise<string[]> {
    return this.withLock('install', () => {
      const retained = this.retentionSet(extra);
      const removed: string[] = [];
      for (const versionName of this.installed().keys()) {
        if (retained.has(versionName)) continue;
        const source = path.join(this.versions, versionName);
        const quarantine = path.join(this.root, 'quarantine', `${versionName}.${randomUUID()}`);
        fs.mkdirSync(path.dirname(quarantine), { recursive: true });
        fs.renameSync(source, quarantine);
        fs.rmSync(quarantine, { recursive: true, force: true });
        removed.push(versionName);
      }
      return removed;
    });
  }
}
