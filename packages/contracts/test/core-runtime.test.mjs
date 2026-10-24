import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ClientInventorySchema,
  ClientLeaseSchema,
  CoreDescriptorSchema,
  CoreErrorSchema,
  LifecycleTokenClaimsSchema,
  MigrationRecordSchema,
  ProvisionTransactionSchema,
} from '../dist/index.js';

const hash = 'a'.repeat(64);
const now = '2026-10-11T20:00:00.000Z';
const later = '2026-10-11T20:01:00.000Z';
const uuid = '19367704-7943-4561-8498-708001217872';

const descriptor = {
  formatVersion: 1,
  runtimeId: 'blackhole-core', runtimeVersion: '0.4.0', buildId: 'build-1',
  platform: 'win32', arch: 'x64', environment: 'production', cloudOrigin: 'https://example.invalid',
  coreProtocol: { min: 1, max: 2 }, capabilities: ['web-ui'],
  nodeVersion: '22.20.0', nodeEntry: 'node/node.exe',
  daemonVersion: '0.4.0', daemonEntry: 'daemon/cli.js',
  webBuildId: 'web-1', webRoot: 'web', managerEntry: 'host/manager.js',
  dataSchema: { min: 1, max: 1 }, migrationPolicy: 'explicit',
  members: [{ path: 'daemon/cli.js', sha256: hash, size: 42 }],
  signingKeyId: 'release-2026', signatureAlgorithm: 'ed25519', signature: 'base64-signature', createdAt: now,
};

test('core descriptor accepts a bounded signed manifest shape', () => {
  assert.deepEqual(CoreDescriptorSchema.parse(descriptor), descriptor);
});

test('core descriptor rejects traversal, inverted ranges, unknown fields and malformed hashes', () => {
  assert.equal(CoreDescriptorSchema.safeParse({ ...descriptor, daemonEntry: '../cli.js' }).success, false);
  assert.equal(CoreDescriptorSchema.safeParse({ ...descriptor, coreProtocol: { min: 3, max: 2 } }).success, false);
  assert.equal(CoreDescriptorSchema.safeParse({ ...descriptor, members: [{ path: 'x', sha256: 'bad', size: 1 }] }).success, false);
  assert.equal(CoreDescriptorSchema.safeParse({ ...descriptor, privateKey: 'secret' }).success, false);
});

test('inventory is non-secret, versioned and supports multiple client entries', () => {
  const entry = { clientId: 'vscode:qianshe.blackhole', kind: 'vscode', version: '0.4.0', protocol: { min: 1, max: 2 }, capabilities: ['attach'], firstSeenAt: now, lastSeenAt: later };
  assert.equal(ClientInventorySchema.safeParse({ schemaVersion: 1, revision: 1, clients: [entry, { ...entry, clientId: 'desktop:stable', kind: 'desktop' }] }).success, true);
  assert.equal(ClientInventorySchema.safeParse({ schemaVersion: 1, revision: 1, clients: [entry], token: 'secret' }).success, false);
});

test('lease and lifecycle claims bind an instance and require forward expiry', () => {
  const lease = { schemaVersion: 1, leaseId: uuid, clientId: 'vscode:qianshe.blackhole', clientInstanceId: uuid, kind: 'vscode', runtimeId: 'blackhole-core', buildId: 'build-1', descriptorHash: hash, dataRootId: hash, daemonId: 'daemon-1', issuedAt: now, expiresAt: later };
  assert.equal(ClientLeaseSchema.safeParse(lease).success, true);
  assert.equal(ClientLeaseSchema.safeParse({ ...lease, expiresAt: now }).success, false);
  const claims = { schemaVersion: 1, operation: 'handover', daemonId: 'daemon-1', startFingerprint: 'fp', runtimeId: 'blackhole-core', buildId: 'build-1', dataRootId: hash, transactionId: uuid, nonce: '0123456789abcdef', issuedAt: now, expiresAt: later };
  assert.equal(LifecycleTokenClaimsSchema.safeParse(claims).success, true);
  assert.equal(LifecycleTokenClaimsSchema.safeParse({ ...claims, controlSecret: 'x' }).success, false);
});

test('provision, migration and structured error schemas reject unbounded additions', () => {
  assert.equal(ProvisionTransactionSchema.safeParse({ schemaVersion: 1, transactionId: uuid, state: 'verified', runtimeId: 'blackhole-core', buildId: 'build-1', descriptorHash: hash, source: 'seed', createdAt: now, updatedAt: later }).success, true);
  assert.equal(MigrationRecordSchema.safeParse({ schemaVersion: 1, migrationId: uuid, state: 'draining', sourceDaemonId: 'daemon-1', dataRootId: hash, recoveryTrustType: 'verified-core', recoveryTargetRef: 'versions/0.3.200-build', createdAt: now, updatedAt: later }).success, true);
  assert.equal(CoreErrorSchema.safeParse({ code: 'environment_mismatch', message: 'wrong environment', retryable: false, requiresUserAction: true, layer: 'manager' }).success, true);
  assert.equal(CoreErrorSchema.safeParse({ code: 'unknown', message: 'x', retryable: false, requiresUserAction: false, layer: 'manager' }).success, false);
});
