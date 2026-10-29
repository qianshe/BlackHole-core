import { z } from 'zod';
import { CoreEnvironmentSchema, RuntimeArchSchema, RuntimePlatformSchema, Sha256Schema } from './core-runtime.js';

const version = z.string().regex(/^(0|[1-9][0-9]{0,5})[.](0|[1-9][0-9]{0,5})[.](0|[1-9][0-9]{0,5})$/);
/** Immutable VSIX build input, never a project setting or Web request. A pinned
 * archive still requires independent Core descriptor/member signature checks. */
export const CoreBootstrapSchema = z.object({
  schemaVersion: z.literal(1),
  environment: CoreEnvironmentSchema,
  cloudOrigin: z.string().url(),
  platform: RuntimePlatformSchema,
  arch: RuntimeArchSchema,
  runtimeVersion: version,
  buildId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/),
  descriptorHash: Sha256Schema,
  archiveHash: Sha256Schema,
  archiveBytes: z.number().int().min(1).max(64 * 1024 * 1024),
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('embedded') }).strict(),
    z.object({ kind: z.literal('download'), url: z.string().max(2048).url() }).strict(),
  ]),
}).strict().superRefine((value, ctx) => {
  if (value.source.kind !== 'download') return;
  const prefix = `https://github.com/qianshe/BlackHole-core/releases/download/v${value.runtimeVersion}/`;
  const name = value.source.url.slice(prefix.length);
  if (!value.source.url.startsWith(prefix) || !/^BlackHole-Core-[A-Za-z0-9._-]+[.]zip$/.test(name)
    || /%|\//.test(name)
    || (value.environment === 'production' && /unsigned|test|candidate|review/i.test(name))) {
    ctx.addIssue({ code: 'custom', message: 'core_download_url_invalid' });
  }
});
export type CoreBootstrap = z.infer<typeof CoreBootstrapSchema>;

export const HostCoreBuildSchema = z.object({
  mode: z.literal('host-node'),
  platform: RuntimePlatformSchema,
  arch: RuntimeArchSchema,
  bootstrapSha256: Sha256Schema,
  managerSha256: Sha256Schema,
  trustSha256: Sha256Schema,
}).strict();
export type HostCoreBuild = z.infer<typeof HostCoreBuildSchema>;
