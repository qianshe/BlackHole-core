import { z } from 'zod';

/**
 * Capabilities a running daemon reports in its ready receipt. A client must
 * treat a missing capability as unavailable; UI readiness never implies that
 * command execution or background processes are available.
 */
export const CAPABILITIES = [
  'web-ui',
  'exec',
  'process',
  'tunnel',
  'account',
] as const;

export const CapabilitySchema = z.enum(CAPABILITIES);
export type Capability = z.infer<typeof CapabilitySchema>;
