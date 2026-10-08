import { z } from 'zod';

// Wire contracts for the deployed /health.connection_routes and /auth/setup
// responses. Do not add a parallel, speculative request/response protocol here.
export const NETWORK_SCOPES = ['loopback', 'private', 'public'] as const;
export const NetworkScopeSchema = z.enum(NETWORK_SCOPES);
export type NetworkScope = z.infer<typeof NetworkScopeSchema>;
export const ConnectionKindSchema = z.enum(['direct', 'custom', 'cloudflare', 'loopback', 'openai']);
export type ConnectionKind = z.infer<typeof ConnectionKindSchema>;
export const RouteKindSchema = ConnectionKindSchema.exclude(['openai']);
export type RouteKind = z.infer<typeof RouteKindSchema>;
export const SelectedRouteSchema = ConnectionKindSchema.exclude(['loopback']);
export type SelectedRoute = z.infer<typeof SelectedRouteSchema>;

export const SetupSummarySchema = z.object({
  configuration: z.enum(['present', 'absent', 'unknown']),
}).strict();
export type SetupSummary = z.infer<typeof SetupSummarySchema>;
// Skipping onboarding is a host-local UI preference, not part of this response.

export const McpRouteCandidateSchema = z.object({
  id: z.string().min(1),
  kind: RouteKindSchema,
  scope: NetworkScopeSchema,
  url: z.string().url(),
  label: z.string().min(1),
}).strict();
export type McpRouteCandidate = z.infer<typeof McpRouteCandidateSchema>;

export const ConnectionRoutesSchema = z.object({
  selected_route: SelectedRouteSchema,
  // The saved daemon value, not the ID of a possibly stale running process.
  saved_tunnel_id: z.string().regex(/^tunnel_[0-9a-f]{32}$/).nullable(),
  preferred_mcp_url: z.string().url().nullable(),
  preferred_mcp_kind: RouteKindSchema.nullable(),
  preferred_mcp_scope: NetworkScopeSchema.nullable(),
  mcp_candidates: z.array(McpRouteCandidateSchema),
  needs_choice: z.boolean(),
  reason: z.enum(['direct_multiple', 'direct_unavailable', 'custom_unavailable', 'cloudflare_unavailable', 'openai_selected']).nullable(),
  sandbox_mcp_url: z.string().url().nullable(),
  sandbox_kind: z.enum(['direct', 'custom', 'cloudflare']).nullable(),
  connector_ready: z.boolean(),
  connector_kind: SelectedRouteSchema.nullable(),
  openai: z.enum(['ready', 'starting', 'off']),
}).strict();
export type ConnectionRoutesView = z.infer<typeof ConnectionRoutesSchema>;

/** Compatibility input shared by Core, VS Code and Web; old daemons omit routes. */
export interface ConnectionHealth {
  mcp_url?: string | null;
  tunnel?: string | null;
  tunnel_url?: string | null;
  public_base_url?: string | null;
  openai_tunnel?: { status?: string | null; active_tunnel_id?: string | null } | null;
  connection_routes?: Partial<ConnectionRoutesView> | null;
}

export const PhoneVerificationSchema = z.object({
  state: z.enum(['unverified', 'checking', 'passed', 'failed']),
  checked_at: z.number().int().nonnegative().nullable(),
  reason: z.enum(['timeout', 'tls', 'unreachable', 'unexpected_response']).nullable(),
}).strict();
export type PhoneVerification = z.infer<typeof PhoneVerificationSchema>;
export const PhoneEndpointSchema = z.object({
  origin: z.string().url(),
  kind: z.enum(['quick', 'fixed']),
  scope: NetworkScopeSchema,
  verification: PhoneVerificationSchema,
}).strict();
export type PhoneEndpoint = z.infer<typeof PhoneEndpointSchema>;


export const DEFAULT_DIRECT_PORT = 7307;
/** Live state of the one direct/custom-ingress data-plane listener. */
export const DirectAccessViewSchema = z.object({
  enabled: z.boolean(),
  port: z.number().int().min(1024).max(65535),
  state: z.enum(['off', 'applying', 'listening', 'error']),
  listening: z.boolean(),
  mode: z.enum(['off', 'direct', 'proxy']),
  bind_host: z.enum(['0.0.0.0', '127.0.0.1']),
  target: z.string().url(),
  origin: z.string().url().nullable(),
  proxy_origin: z.string().url().nullable(),
  addresses: z.array(z.string()),
  error: z.string().nullable(),
}).strict();
export type DirectAccessView = z.infer<typeof DirectAccessViewSchema>;
