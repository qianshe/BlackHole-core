import test from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionRoutesSchema, ConnectionKindSchema, McpRouteCandidateSchema, SetupSummarySchema, PhoneEndpointSchema } from '../dist/index.js';

const off = {
  selected_route: 'openai', saved_tunnel_id: 'tunnel_' + 'a'.repeat(32),
  preferred_mcp_url: null, preferred_mcp_kind: null, preferred_mcp_scope: null,
  mcp_candidates: [], needs_choice: false, reason: 'openai_selected',
  sandbox_mcp_url: null, sandbox_kind: null, connector_ready: false, connector_kind: null, openai: 'off',
};

test('the wire model accepts actual kinds and offline saved identifiers', () => {
  assert.deepEqual(ConnectionRoutesSchema.parse(off), off);
  for (const kind of ['direct', 'custom', 'cloudflare', 'loopback']) {
    assert.equal(ConnectionKindSchema.safeParse(kind).success, true);
    assert.equal(McpRouteCandidateSchema.safeParse({ id: kind, kind, scope: 'private', url: 'https://fixture.test/mcp/token', label: kind }).success, true);
  }
  assert.equal(ConnectionKindSchema.safeParse('cf-quick').success, false, 'obsolete planning-only kind');
});

test('wire responses reject unknown fields, identifiers and reasons', () => {
  assert.equal(ConnectionRoutesSchema.safeParse({ ...off, api_key: 'secret' }).success, false);
  assert.equal(ConnectionRoutesSchema.safeParse({ ...off, saved_tunnel_id: 'not-a-tunnel' }).success, false);
  assert.equal(ConnectionRoutesSchema.safeParse({ ...off, reason: 'invented' }).success, false);
  assert.equal(ConnectionRoutesSchema.safeParse({ ...off, selected_route: 'magic' }).success, false);
});

test('setup summary matches the actual unauthenticated setup response without host UI state', () => {
  for (const configuration of ['present', 'absent', 'unknown']) {
    assert.deepEqual(SetupSummarySchema.parse({ configuration }), { configuration });
  }
  assert.equal(SetupSummarySchema.safeParse({ configuration: 'online' }).success, false);
  assert.equal(SetupSummarySchema.safeParse({ configuration: 'present', setupSkipped: true }).success, false);
});

test('phone verification is per endpoint, bounded and separate from configuration', () => {
  const endpoint = { origin: 'https://phone.test', kind: 'fixed', scope: 'private', verification: { state: 'unverified', checked_at: null, reason: null } };
  assert.deepEqual(PhoneEndpointSchema.parse(endpoint), endpoint);
  assert.equal(PhoneEndpointSchema.safeParse({ ...endpoint, verification: { state: 'online' } }).success, false);
});
