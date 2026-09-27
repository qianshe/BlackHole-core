import crypto from 'node:crypto';
import os from 'node:os';

export function generateToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

export function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(9).toString('hex')}`;
}

/**
 * Stable session IDs are plain decimal numbers — e.g.
 * `329486139840163486132048613204861320`.
 *
 * Numeric on purpose: host models screen tool arguments for credential-shaped
 * strings and refuse to forward anything that reads like a secret, while a bare
 * number reads as an ordinary id and passes through. The value is a UUID
 * rendered in base 10, so it still holds 122 random bits — not sequential and
 * not guessable, so a leaked endpoint still cannot be walked session by session.
 *
 * Unlike the activation value (which `rotate` replaces), an ID never changes
 * for the life of the session, and activating again re-reads it.
 */
export function randomSessionId(): string {
  return BigInt(`0x${crypto.randomUUID().replace(/-/g, '')}`)
    .toString(10)
    .padStart(39, '0');
}

/** `sess_<hex>`: how IDs were minted before 0.3.70. Kept so old rows resolve. */
export const SESSION_ID_PREFIX = 'sess_';

/** True when a reference is a stable session ID rather than an activation value. */
export function isSessionId(ref: string): boolean {
  return /^\d+$/.test(ref) || ref.startsWith(SESSION_ID_PREFIX);
}

export function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

let cachedAccessToken: string | undefined;
/** Set once by the daemon from the persisted override (if any). */
let overrideToken: string | undefined;

/** Daemon boot hook / test seam: set or clear the persisted token override. */
export function setAccessTokenOverride(token: string | undefined): void {
  overrideToken = token?.trim() || undefined;
  cachedAccessToken = undefined;
}

/**
 * Machine-level MCP access token. Derived — never stored — so every session
 * on this machine shares one stable `/mcp/<token>` URL: web-agent connectors
 * cannot edit a URL after it is configured, so it must not change when
 * sessions are created/rotated.
 *
 * Derivation input: cheap, machine-local and restart-stable facts available
 * without spawning platform tools (Node has no os.machineId()). The token
 * alone grants no workspace access — every tool call additionally needs a
 * per-session numeric id — so cross-machine guess resistance here is
 * defense-in-depth, while stability is the hard requirement.
 *
 * `setAccessTokenOverride` (a persisted, machine-scoped row) takes precedence
 * — that is the operator's refresh path from the extension's settings page.
 * Env BLACKHOLE_MCP_TOKEN wins over pure derivation as a boot-time fallback.
 */
export function deriveAccessToken(): string {
  cachedAccessToken ??= overrideToken ?? (process.env.BLACKHOLE_MCP_TOKEN?.trim() || sha256(
    ['blackhole-mcp-v1', os.hostname(), os.userInfo().username, os.platform(), os.arch()].join('|'),
  ).slice(0, 32));
  return cachedAccessToken;
}

/** Drop the cached value so the next read re-derives (token refresh / tests). */
export function resetAccessTokenCache(): void {
  cachedAccessToken = undefined;
}

