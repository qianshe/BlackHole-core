import { z } from 'zod';
import { ClientKindSchema, ClientLeaseSchema, CoreEnvironmentSchema, ProtocolRangeSchema, Sha256Schema } from './core-runtime.js';
import { CapabilitySchema } from './capabilities.js';
import { ReadyReceiptSchema } from './host-protocol.js';

export const ManagedClientSchema = z.object({
  clientId: z.string().min(1).max(200),
  clientInstanceId: z.string().uuid(),
  kind: ClientKindSchema,
  version: z.string().min(1).max(100),
  protocol: ProtocolRangeSchema,
  capabilities: z.array(CapabilitySchema).max(32),
}).strict();
export const AttachCoreRequestSchema = z.object({
  client: ManagedClientSchema,
  port: z.number().int().min(1).max(65535),
  readyTimeoutMs: z.number().int().min(100).max(60_000).default(30_000),
  // A maintenance client may only acquire a lease on this already-ready incarnation.
  existingFingerprint: z.string().min(1).max(500).optional(),
  // Only hosts implementing verified transaction-based reattachment opt in.
  reconnectAfterUpgrade: z.literal(true).optional(),
}).strict();
export type AttachCoreRequest = z.input<typeof AttachCoreRequestSchema>;

// A lease handle is target binding, not an authentication credential. Manager
// commands are a local per-user boundary; possession never authorizes Stop.
export const LeaseHandleSchema = z.object({
  leaseId: z.string().uuid(),
  clientInstanceId: z.string().uuid(),
  daemonId: z.string().min(1).max(200),
  dataRootId: Sha256Schema,
  descriptorHash: Sha256Schema,
}).strict();
export type LeaseHandle = z.infer<typeof LeaseHandleSchema>;
export const HeartbeatCoreRequestSchema = z.object({
  handle: LeaseHandleSchema,
  port: z.number().int().min(1).max(65535),
}).strict();
export const ManagedReadyReceiptSchema = ReadyReceiptSchema.extend({
  runtimeId: z.string().min(1).max(200),
  runtimeVersion: z.string().min(1).max(100),
  buildId: z.string().min(1).max(200),
  descriptorHash: Sha256Schema,
  dataRootId: Sha256Schema,
  webBuildId: z.string().min(1).max(200),
  coreProtocol: ProtocolRangeSchema,
  environment: CoreEnvironmentSchema,
  cloudOrigin: z.string().url(),
  lifecycleState: z.literal('managed'),
  startFingerprint: z.string().min(1).max(500),
}).strict();
export type ManagedReadyReceipt = z.infer<typeof ManagedReadyReceiptSchema>;
export const AttachCoreResultSchema = z.object({
  receipt: ManagedReadyReceiptSchema,
  lease: ClientLeaseSchema,
  spawned: z.boolean(),
}).strict();
export type AttachCoreResult = z.infer<typeof AttachCoreResultSchema>;

/** Internal host bootstrap: the target was staged from the host's signed bundle.
 * No browser-supplied path, download URL or separate user confirmation. */
export const StartBundledCoreRequestSchema = AttachCoreRequestSchema.omit({ existingFingerprint: true }).extend({
  requestId: z.string().uuid(),
  versionName: z.string().min(1).max(250).regex(/^[A-Za-z0-9._-]+$/).refine(v => v !== '.' && v !== '..'),
  descriptorHash: Sha256Schema,
}).strict();
export const StartBundledCoreResultSchema = z.object({
  state: z.enum(['current', 'updated', 'deferred', 'rolled_back']),
  targetVersionName: z.string().min(1).max(250),
  attachment: AttachCoreResultSchema,
  reason: z.string().regex(/^[a-z][a-z0-9_]{0,119}$/).optional(),
}).strict();
export type StartBundledCoreResult = z.infer<typeof StartBundledCoreResultSchema>;

// Persisted before spawn; unresolved starts conservatively pin the Core and
// block another spawn until explicit recovery. Never contains login tickets.
export const RunningCoreRecordSchema = z.object({
  schemaVersion: z.literal(1),
  status: z.enum(['starting', 'ready']),
  pid: z.number().int().positive().optional(),
  versionName: z.string().min(1).max(250).regex(/^[A-Za-z0-9._-]+$/).refine((value) => value !== '.' && value !== '..'),
  descriptorHash: Sha256Schema,
  dataRootId: Sha256Schema,
  dbPath: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  startFingerprint: z.string().min(1).max(500),
  receipt: ManagedReadyReceiptSchema.optional(),
  // Operating-system boot that wrote this record, and therefore whether a
  // recorded PID can belong to this incarnation at all. Absent on records
  // written before this field existed; recovery then keeps the older rules.
  bootId: z.string().min(8).max(100).regex(/^[A-Za-z0-9-]+$/).optional(),
}).strict().refine((record) => record.status === 'starting' || (!!record.receipt &&
  record.receipt.dataRootId === record.dataRootId && record.receipt.descriptorHash === record.descriptorHash &&
  record.receipt.startFingerprint === record.startFingerprint && record.receipt.localUrl === `http://127.0.0.1:${record.port}/ui/`), { message: 'ready record must have a matching receipt' });
export type RunningCoreRecord = z.infer<typeof RunningCoreRecordSchema>;

export const MaintainCoreRequestSchema = z.object({
  handle: LeaseHandleSchema, client: ManagedClientSchema,
  port: z.number().int().min(1).max(65535), confirmed: z.literal(true),
  requestId: z.string().uuid(), operation: z.enum(['stop', 'restart']),
  settingsRevision: z.number().int().nonnegative().optional(),
}).strict().refine(r => r.settingsRevision === undefined || r.operation === 'restart', { message: 'settings application requires restart' });
export const CoreMaintenanceRecordSchema = z.object({
  schemaVersion: z.literal(1), requestId: z.string().uuid(), operation: z.enum(['stop', 'restart']),
  requestHash: Sha256Schema, target: RunningCoreRecordSchema,
  state: z.enum(['stopping', 'refused', 'stopped', 'restarting', 'completed', 'recovery_required', 'recovered_stopped', 'recovered_running']),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();
export const MaintainCoreResultSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('stop'), stopped: z.literal(true), requestId: z.string().uuid() }).strict(),
  z.object({ operation: z.literal('restart'), stopped: z.literal(true), requestId: z.string().uuid(), attachment: AttachCoreResultSchema }).strict(),
]);
export type MaintainCoreResult = z.infer<typeof MaintainCoreResultSchema>;

// An upgrade is an explicit, journalled transaction: stage/verify the target
// while the old Core keeps running, stop the old Core through the guarded
// maintenance path, switch the active pointer, then start and verify the
// target. Committed only after the target is ready; a positively failed
// candidate rolls back to the previous version. Ambiguous states stay
// recovery_required and are never retried blindly.
export const UpgradeCoreRequestSchema = z.object({
  handle: LeaseHandleSchema, client: ManagedClientSchema,
  port: z.number().int().min(1).max(65535), confirmed: z.literal(true),
  requestId: z.string().uuid(),
  targetVersionName: z.string().min(1).max(250).regex(/^[A-Za-z0-9._-]+$/).refine((value) => value !== '.' && value !== '..'),
  readyTimeoutMs: z.number().int().min(100).max(60_000).default(30_000),
}).strict();
export type UpgradeCoreRequest = z.input<typeof UpgradeCoreRequestSchema>;
export const CoreUpgradeRecordSchema = z.object({
  schemaVersion: z.literal(1), requestId: z.string().uuid(), requestHash: Sha256Schema,
  from: RunningCoreRecordSchema, targetVersionName: z.string().min(1).max(250),
  targetDescriptorHash: Sha256Schema, maintenanceRequestId: z.string().uuid().optional(),
  state: z.enum(['staged', 'stopping', 'switching', 'starting', 'verifying', 'committed', 'rolling_back', 'rolled_back', 'refused', 'recovery_required']),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();
export type CoreUpgradeRecord = z.infer<typeof CoreUpgradeRecordSchema>;
export const UpgradeCoreResultSchema = z.object({
  operation: z.literal('upgrade'), requestId: z.string().uuid(),
  state: z.enum(['committed', 'rolled_back']),
  fromVersionName: z.string().min(1).max(250), targetVersionName: z.string().min(1).max(250),
  attachment: AttachCoreResultSchema,
}).strict();
export type UpgradeCoreResult = z.infer<typeof UpgradeCoreResultSchema>;

export const CoreEndpointSchema = z.object({
  schemaVersion: z.literal(1), dataRootId: Sha256Schema,
  port: z.number().int().min(1).max(65535), revision: z.number().int().nonnegative(),
}).strict();
export const ConfigureCoreEndpointSchema = z.object({
  confirmed: z.literal(true), expectedPort: z.number().int().min(1).max(65535),
  expectedRevision: z.number().int().nonnegative(), port: z.number().int().min(1).max(65535),
}).strict();



