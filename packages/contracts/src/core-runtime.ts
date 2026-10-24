import { z } from 'zod';
import { CapabilitySchema } from './capabilities.js';

const SHA256_HEX = /^[a-f0-9]{64}$/;
const SAFE_RELATIVE_PATH = /^(?![A-Za-z]:)(?![\\/])(?!.*(?:^|[\\/])\.\.(?:[\\/]|$)).+$/;

export const Sha256Schema = z.string().regex(SHA256_HEX, { message: 'must be a lowercase SHA-256 hex digest' });
export const SafeRelativePathSchema = z.string().min(1).regex(SAFE_RELATIVE_PATH, { message: 'must be a safe relative path' });
export const RuntimePlatformSchema = z.enum(['win32', 'darwin', 'linux']);
export const RuntimeArchSchema = z.enum(['x64', 'arm64']);
export const CoreEnvironmentSchema = z.enum(['test', 'production']);

export const ProtocolRangeSchema = z.object({
  min: z.number().int().positive(),
  max: z.number().int().positive(),
}).strict().refine(({ min, max }) => min <= max, { message: 'min must not exceed max' });

export const CoreMemberSchema = z.object({
  path: SafeRelativePathSchema,
  sha256: Sha256Schema,
  size: z.number().int().nonnegative(),
}).strict();

// Format v1 signs a self-contained Node executable inside each Core version.
// Format v2 signs Core *code and assets only*. Its manager supplies the already
// running, capability-checked Node host (VS Code or Desktop). No arbitrary Node
// path from a web request, environment variable or project may select a runner.
const CoreDescriptorBaseSchema = z.object({
  runtimeId: z.string().min(1).max(200),
  runtimeVersion: z.string().min(1).max(100),
  buildId: z.string().min(1).max(200),
  platform: RuntimePlatformSchema,
  arch: RuntimeArchSchema,
  environment: CoreEnvironmentSchema,
  cloudOrigin: z.string().url(),
  coreProtocol: ProtocolRangeSchema,
  capabilities: z.array(CapabilitySchema),
  daemonVersion: z.string().min(1).max(100),
  daemonEntry: SafeRelativePathSchema,
  webBuildId: z.string().min(1).max(200),
  webRoot: SafeRelativePathSchema,
  managerEntry: SafeRelativePathSchema,
  dataSchema: ProtocolRangeSchema,
  migrationPolicy: z.enum(['none', 'compatible', 'explicit']),
  members: z.array(CoreMemberSchema).min(1),
  signingKeyId: z.string().min(1).max(200),
  signatureAlgorithm: z.literal('ed25519'),
  signature: z.string().min(1),
  createdAt: z.string().datetime({ offset: true }),
}).strict();
export const CoreDescriptorV1Schema = CoreDescriptorBaseSchema.extend({
  formatVersion: z.literal(1),
  nodeVersion: z.string().min(1).max(100),
  nodeEntry: SafeRelativePathSchema,
}).strict();
export const CoreDescriptorV2Schema = CoreDescriptorBaseSchema.extend({
  formatVersion: z.literal(2),
  runtimeProvider: z.literal('host-node'),
  nodeMinVersion: z.string().regex(/^[0-9]+[.][0-9]+[.][0-9]+$/),
}).strict();
export const CoreDescriptorSchema = z.discriminatedUnion('formatVersion', [CoreDescriptorV1Schema, CoreDescriptorV2Schema]);
export type CoreDescriptor = z.infer<typeof CoreDescriptorSchema>;

export const ClientKindSchema = z.enum(['vscode', 'desktop']);
export const ClientInventoryEntrySchema = z.object({
  clientId: z.string().min(1).max(200),
  kind: ClientKindSchema,
  version: z.string().min(1).max(100),
  protocol: ProtocolRangeSchema,
  capabilities: z.array(z.string().min(1).max(100)),
  firstSeenAt: z.string().datetime({ offset: true }),
  lastSeenAt: z.string().datetime({ offset: true }),
}).strict();
export type ClientInventoryEntry = z.infer<typeof ClientInventoryEntrySchema>;

export const ClientInventorySchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  clients: z.array(ClientInventoryEntrySchema),
}).strict();
export type ClientInventory = z.infer<typeof ClientInventorySchema>;

export const ClientLeaseSchema = z.object({
  schemaVersion: z.literal(1),
  leaseId: z.string().uuid(),
  clientId: z.string().min(1).max(200),
  clientInstanceId: z.string().uuid(),
  kind: ClientKindSchema,
  runtimeId: z.string().min(1).max(200),
  buildId: z.string().min(1).max(200),
  descriptorHash: Sha256Schema,
  dataRootId: Sha256Schema,
  daemonId: z.string().min(1).max(200),
  issuedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
}).strict().refine(({ issuedAt, expiresAt }) => Date.parse(expiresAt) > Date.parse(issuedAt), {
  message: 'expiresAt must be after issuedAt',
});
export type ClientLease = z.infer<typeof ClientLeaseSchema>;

export const LifecycleOperationSchema = z.enum(['stop', 'restart', 'handover', 'upgrade']);
export const LifecycleTokenClaimsSchema = z.object({
  schemaVersion: z.literal(1),
  operation: LifecycleOperationSchema,
  descriptorHash: Sha256Schema.optional(),
  settingsRevision: z.number().int().nonnegative().optional(),
  daemonId: z.string().min(1).max(200),
  startFingerprint: z.string().min(1).max(500),
  runtimeId: z.string().min(1).max(200),
  buildId: z.string().min(1).max(200),
  dataRootId: Sha256Schema,
  transactionId: z.string().uuid(),
  nonce: z.string().min(16).max(500),
  issuedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
}).strict().refine(({ issuedAt, expiresAt }) => Date.parse(expiresAt) > Date.parse(issuedAt), {
  message: 'expiresAt must be after issuedAt',
});
export type LifecycleTokenClaims = z.infer<typeof LifecycleTokenClaimsSchema>;

export const TransactionStateSchema = z.enum(['prepared', 'staged', 'verified', 'committed', 'rolled_back', 'failed']);
export const ProvisionTransactionSchema = z.object({
  schemaVersion: z.literal(1),
  transactionId: z.string().uuid(),
  state: TransactionStateSchema,
  runtimeId: z.string().min(1).max(200),
  buildId: z.string().min(1).max(200),
  descriptorHash: Sha256Schema,
  source: z.enum(['installed', 'seed', 'download']),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  errorCode: z.string().min(1).max(200).optional(),
}).strict();
export type ProvisionTransaction = z.infer<typeof ProvisionTransactionSchema>;

export const RecoveryTrustTypeSchema = z.enum(['verified-core', 'migration-only-legacy']);
export const MigrationStateSchema = z.enum([
  'pending_confirmation', 'quiescing', 'draining', 'backing_up', 'stopping_legacy',
  'starting_core', 'verifying_core', 'committed', 'recovering', 'recovery_required', 'cancelled',
]);
export const MigrationRecordSchema = z.object({
  schemaVersion: z.literal(1),
  migrationId: z.string().uuid(),
  state: MigrationStateSchema,
  sourceDaemonId: z.string().min(1).max(200),
  dataRootId: Sha256Schema,
  recoveryTrustType: RecoveryTrustTypeSchema,
  recoveryTargetRef: z.string().min(1).max(1000),
  backupManifestHash: Sha256Schema.optional(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();
export type MigrationRecord = z.infer<typeof MigrationRecordSchema>;

export const CoreErrorCodeSchema = z.enum([
  'core_missing', 'core_download_failed', 'core_archive_signature_invalid', 'installer_signature_invalid',
  'core_repair_required', 'core_update_required', 'client_update_required', 'legacy_migration_required',
  'legacy_client_uncoordinated', 'managed_core_required', 'foreign_listener', 'data_root_conflict',
  'environment_mismatch', 'active_clients', 'update_blocked', 'migration_pending',
  'migration_recovery_required', 'core_identity_conflict',
]);
export type CoreErrorCode = z.infer<typeof CoreErrorCodeSchema>;
export const CoreErrorSchema = z.object({
  code: CoreErrorCodeSchema,
  message: z.string().min(1).max(2000),
  retryable: z.boolean(),
  requiresUserAction: z.boolean(),
  layer: z.enum(['client', 'manager', 'archive', 'installer', 'daemon', 'migration']),
}).strict();
export type CoreError = z.infer<typeof CoreErrorSchema>;
