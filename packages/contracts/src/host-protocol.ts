import { z } from 'zod';
import { CapabilitySchema } from './capabilities.js';

/**
 * Host protocol between the entry points (desktop launcher, VS Code extension)
 * and the daemon. Bump on any incompatible change; clients attach to a daemon
 * whose protocol they support instead of restarting it.
 */
export const HOST_PROTOCOL_VERSION = 1;

/** How the running daemon was provisioned. */
export const RuntimeKindSchema = z.enum(['standalone-node', 'vscode-electron']);
export type RuntimeKind = z.infer<typeof RuntimeKindSchema>;

/**
 * http(s) URL whose host is a loopback address; never a tunnel or LAN URL.
 * Matched textually so this package needs no DOM or Node `URL` global.
 */
const LOOPBACK_URL = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?(?:[/?#]|$)/i;
export const LoopbackUrlSchema = z.string().url().regex(LOOPBACK_URL, { message: 'must be a loopback http(s) URL' });

/**
 * Ready receipt returned after the daemon has authenticated the local caller
 * and finished DB initialisation, routes and static assets. It must never
 * carry account, MCP, pairing or control secrets; `.strict()` rejects any
 * extra field so a secret cannot be smuggled in by accident.
 */
export const ReadyReceiptSchema = z.object({
  protocolVersion: z.number().int().positive(),
  instanceKey: z.string().min(1),
  daemonId: z.string().min(1),
  daemonVersion: z.string().min(1),
  runtimeKind: RuntimeKindSchema,
  uiVersion: z.string().min(1),
  configRevision: z.number().int().nonnegative(),
  localUrl: LoopbackUrlSchema,
  /** Relative to the UI base, e.g. '../web-api/v1/'; never an absolute host. */
  webApiBase: z.string().min(1).refine((value) => !/^[a-z][a-z0-9+.-]*:/i.test(value) && !value.startsWith('//'), {
    message: 'must be relative to the UI base',
  }),
  capabilities: z.array(CapabilitySchema),
}).strict();
export type ReadyReceipt = z.infer<typeof ReadyReceiptSchema>;

/** Failure classes a launch attempt can report (plan §5.4). */
export const LaunchErrorCodeSchema = z.enum([
  'instance_conflict',
  'port_conflict',
  'runtime_asset_missing',
  'kernel_exited',
  'ready_timeout',
  'browser_unavailable',
  'protocol_incompatible',
]);
export type LaunchErrorCode = z.infer<typeof LaunchErrorCodeSchema>;

/**
 * Bounded, structured result the short-lived bootstrap writes to stdout.
 * `browser_unavailable` still carries the receipt: the daemon stays ready and
 * the user gets the local address instead of a dead end.
 */
export const LaunchResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    receipt: ReadyReceiptSchema,
    browserOpened: z.boolean(),
  }).strict(),
  z.object({
    ok: z.literal(false),
    code: LaunchErrorCodeSchema,
    message: z.string().min(1).max(2000),
    logPath: z.string().min(1).optional(),
    receipt: ReadyReceiptSchema.optional(),
  }).strict(),
]);
export type LaunchResult = z.infer<typeof LaunchResultSchema>;

/** Hard upper bound for the serialized launch result on stdout. */
export const LAUNCH_RESULT_MAX_BYTES = 16 * 1024;
