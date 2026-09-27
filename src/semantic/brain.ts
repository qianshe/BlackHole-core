/**
 * The search "brain": the Windsurf/Devin Devstral stream endpoint, spoken over
 * hand-rolled Connect-RPC + protobuf.
 *
 * Ported from dsh-assistant-optimization `lib/fast-context/windsurf.js`
 * (itself from fast-context-mcp `src/core.mjs`, MIT). Changes:
 *  - the key is always supplied by the caller (./key.ts resolution chain);
 *    the reference's "no key → read the local editor" default is gone, since
 *    that policy now lives behind an explicit opt-in;
 *  - device telemetry is a fixed stub unless the operator opts in (below);
 *    the reference sends the real hostname, CPU model and memory size, which
 *    is fine for a plugin on your own box and not obviously fine for a
 *    service driven by whoever is on the other end of a tunnel;
 *  - one extra timeout knob path: the caller's AbortSignal is authoritative,
 *    so a disconnected agent stops the loop instead of leaving it burning
 *    quota (MCP clients time out well before a 5-turn search finishes).
 *
 * NON-OFFICIAL PROTOCOL: this is a reverse-engineered client for a proprietary
 * endpoint. It can break without notice, and its terms of service are the
 * operator's responsibility.
 */
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { gzipSync } from 'node:zlib';

import {
  ProtobufEncoder,
  connectFrameDecode,
  connectFrameEncode,
  extractStrings,
} from './protocol.js';
import { parseJsonWithRepair, salvageRestrictedExecArgs } from './repair.js';
import { buildToolSchemas } from './shared.js';

/** Unicode replacement character, spelled by code point (regex literals are lossy in some editors). */
const FFFD = String.fromCharCode(0xfffd);

const API_BASE = 'https://server.self-serve.windsurf.com/exa.api_server_pb.ApiServerService';
const AUTH_BASE = 'https://server.self-serve.windsurf.com/exa.auth_pb.AuthService';
const APP_NAME = 'windsurf';
const APP_VERSION = process.env.WS_APP_VER ?? '1.48.2';
const LS_VERSION = process.env.WS_LS_VER ?? '1.9544.35';
/** FAST is available to the same free-tier accounts as the legacy package. */
const MODEL = process.env.WS_MODEL ?? 'MODEL_SWE_1_6_FAST';

/** Model id recorded in cache keys and diagnostics. */
export const BRAIN_MODEL = MODEL;

export type FastContextErrorCode =
  | 'TIMEOUT'
  | 'PAYLOAD_TOO_LARGE'
  | 'RATE_LIMITED'
  | 'AUTH_ERROR'
  | 'SERVER_ERROR'
  | 'NETWORK_ERROR';

export class FastContextError extends Error {
  readonly code: FastContextErrorCode;
  readonly details: Record<string, unknown>;

  constructor(message: string, code: FastContextErrorCode, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'FastContextError';
    this.code = code;
    this.details = details;
  }
}

interface HttpShapedError extends Error {
  status?: number;
}

/** Map raw fetch/HTTP failures onto the codes the loop reports to the agent. */
export function classifyError(err: unknown): FastContextError {
  if (err instanceof FastContextError) return err;
  const e = err as HttpShapedError;
  const status = e.status;
  if (typeof status === 'number') {
    if (status === 413) return new FastContextError(e.message, 'PAYLOAD_TOO_LARGE', { status });
    if (status === 429) return new FastContextError(e.message, 'RATE_LIMITED', { status });
    if (status === 401 || status === 403) return new FastContextError(e.message, 'AUTH_ERROR', { status });
    return new FastContextError(e.message, 'SERVER_ERROR', { status });
  }
  if (e.name === 'AbortError' || e.name === 'TimeoutError' || /timeout/i.test(e.message ?? '')) {
    return new FastContextError(e.message, 'TIMEOUT');
  }
  return new FastContextError(e.message ?? String(err), 'NETWORK_ERROR');
}

// ─── Device telemetry ──────────────────────────────────────

/**
 * The endpoint expects a system-info blob (the real client sends its own). The
 * values are not identity-bearing by default: `BH_SEMANTIC_DEVICE_INFO=1`
 * restores the real hostname/CPU/memory if the service ever starts validating
 * them, and the startup log says which mode is active.
 */
function systemInfoJson(): string {
  if (process.env.BH_SEMANTIC_DEVICE_INFO === '1') {
    const plat = os.platform();
    return JSON.stringify({
      Os: plat,
      Arch: os.arch(),
      Release: os.release(),
      Version: os.version(),
      Machine: os.arch(),
      Nodename: os.hostname(),
      Sysname: plat === 'darwin' ? 'Darwin' : plat === 'win32' ? 'Windows_NT' : 'Linux',
      ProductVersion: '',
    });
  }
  return JSON.stringify({
    Os: os.platform(),
    Arch: os.arch(),
    Release: '',
    Version: '',
    Machine: os.arch(),
    Nodename: 'blackhole',
    Sysname: '',
    ProductVersion: '',
  });
}

function cpuInfoJson(): string {
  const cores = os.cpus().length || 4;
  if (process.env.BH_SEMANTIC_DEVICE_INFO === '1') {
    return JSON.stringify({
      NumSockets: 1,
      NumCores: cores,
      NumThreads: cores,
      VendorID: '',
      Family: '0',
      Model: '0',
      ModelName: os.cpus()[0]?.model ?? 'Unknown',
      Memory: os.totalmem(),
    });
  }
  return JSON.stringify({
    NumSockets: 1,
    NumCores: cores,
    NumThreads: cores,
    VendorID: '',
    Family: '0',
    Model: '0',
    ModelName: 'generic',
    Memory: 0,
  });
}

// ─── JWT ───────────────────────────────────────────────────

interface JwtEntry {
  token: string;
  expiresAt: number;
}

const jwtCache = new Map<string, JwtEntry>();

function jwtExpiry(jwt: string): number {
  try {
    const payload = jwt.split('.')[1];
    if (!payload) return 0;
    return (JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')) as { exp?: number }).exp ?? 0;
  } catch {
    return 0;
  }
}

/** Exchange the API key for a JWT, cached until 60s before it expires. */
async function getCachedJwt(apiKey: string, signal?: AbortSignal | null): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const cached = jwtCache.get(apiKey);
  if (cached && cached.expiresAt > now + 60) return cached.token;
  const token = await fetchJwt(apiKey, signal);
  jwtCache.set(apiKey, { token, expiresAt: jwtExpiry(token) || now + 3600 });
  return token;
}

async function fetchJwt(apiKey: string, signal?: AbortSignal | null): Promise<string> {
  const meta = new ProtobufEncoder();
  meta.writeString(1, APP_NAME);
  meta.writeString(2, APP_VERSION);
  meta.writeString(3, apiKey);
  meta.writeString(4, 'en');
  meta.writeString(7, LS_VERSION);
  meta.writeString(12, APP_NAME);
  meta.writeBytes(30, Buffer.from([0x00, 0x01]));
  const outer = new ProtobufEncoder();
  outer.writeMessage(1, meta);

  const resp = await unaryRequest(`${AUTH_BASE}/GetUserJwt`, outer.toBuffer(), false, signal);
  for (const candidate of extractStrings(resp)) {
    if (candidate.startsWith('eyJ') && candidate.includes('.')) return candidate;
  }
  throw new FastContextError('Failed to extract JWT from GetUserJwt response', 'AUTH_ERROR');
}

// ─── HTTP ──────────────────────────────────────────────────

/** TLS verification is on unless the operator explicitly allows an intercepting proxy. */
let tlsFallbackApplied = false;
function applyTlsFallback(): void {
  if (tlsFallbackApplied) return;
  if (process.env.BH_SEMANTIC_INSECURE_TLS === '1' && !process.env.NODE_TLS_REJECT_UNAUTHORIZED) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    tlsFallbackApplied = true;
    process.stderr.write(
      '[semantic] WARNING: TLS certificate verification disabled (BH_SEMANTIC_INSECURE_TLS=1). Unset it to restore the secure default.\n',
    );
  }
}

function combineSignal(timeoutMs: number, signal?: AbortSignal | null): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (signal) {
    if (typeof AbortSignal.any === 'function') return AbortSignal.any([timeout, signal]);
    if (signal.aborted) return signal;
  }
  return timeout;
}

async function unaryRequest(url: string, protoBytes: Buffer, compress: boolean, signal?: AbortSignal | null): Promise<Buffer> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/proto',
    'Connect-Protocol-Version': '1',
    'User-Agent': 'connect-go/1.18.1 (go1.25.5)',
    'Accept-Encoding': 'gzip',
  };
  let body: Buffer = protoBytes;
  if (compress) {
    body = gzipSync(protoBytes);
    headers['Content-Encoding'] = 'gzip';
  }
  const doFetch = (): Promise<Response> => fetch(url, { method: 'POST', headers, body: asBody(body), signal: combineSignal(30_000, signal) });

  let resp: Response;
  try {
    resp = await doFetch();
  } catch (e) {
    if (signal?.aborted) throw new FastContextError('aborted', 'TIMEOUT');
    applyTlsFallback();
    try {
      resp = await doFetch();
    } catch (e2) {
      throw classifyError(e2);
    }
  }
  if (!resp.ok) {
    const err = new Error(`HTTP ${resp.status}`) as HttpShapedError;
    err.status = resp.status;
    throw classifyError(err);
  }
  return Buffer.from(await resp.arrayBuffer());
}

/**
 * Node fetch accepts a Buffer as the request body, but the DOM-flavoured
 * BodyInit type in this tsconfig does not name it. Copy into a fresh
 * ArrayBuffer view so the value is exactly what fetch will read.
 */
function asBody(buf: Buffer): BodyInit {
  return new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)) as unknown as BodyInit;
}

/** Streaming POST with the reference's retry/backoff (4xx except 429 never retries). */
async function streamingRequest(
  protoBytes: Buffer,
  timeoutMs: number,
  maxRetries: number,
  signal?: AbortSignal | null,
): Promise<Buffer> {
  const frame = connectFrameEncode(protoBytes);
  const url = `${API_BASE}/GetDevstralStream`;
  const traceId = randomUUID().replace(/-/g, '');
  const spanId = randomUUID().replace(/-/g, '').slice(0, 16);
  const baseTimeoutMs = Number.isFinite(timeoutMs) ? timeoutMs : 30_000;

  const headers: Record<string, string> = {
    'Content-Type': 'application/connect+proto',
    'Connect-Protocol-Version': '1',
    'Connect-Accept-Encoding': 'gzip',
    'Connect-Content-Encoding': 'gzip',
    'Connect-Timeout-Ms': String(baseTimeoutMs),
    'User-Agent': 'connect-go/1.18.1 (go1.25.5)',
    'Accept-Encoding': 'identity',
    Baggage:
      `sentry-release=language-server-windsurf@${LS_VERSION},` +
      'sentry-environment=stable,sentry-sampled=false,' +
      `sentry-trace_id=${traceId},` +
      'sentry-public_key=b813f73488da69eedec534dba1029111',
    'Sentry-Trace': `${traceId}-${spanId}-0`,
  };
  const doFetch = (): Promise<Response> =>
    fetch(url, { method: 'POST', headers, body: asBody(frame), signal: combineSignal(baseTimeoutMs + 5000, signal) });

  let lastErr: unknown = new Error('stream request failed');
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      if (signal?.aborted) throw new FastContextError('aborted', 'TIMEOUT');
      let resp: Response;
      try {
        resp = await doFetch();
      } catch (e) {
        if (signal?.aborted) throw new FastContextError('aborted', 'TIMEOUT');
        if (attempt === 0) {
          applyTlsFallback();
          resp = await doFetch();
        } else {
          throw e;
        }
      }
      if (!resp.ok) {
        const err = new Error(`HTTP ${resp.status}`) as HttpShapedError;
        err.status = resp.status;
        if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) throw err;
        lastErr = err;
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        throw err;
      }
      return Buffer.from(await resp.arrayBuffer());
    } catch (e) {
      if (e instanceof FastContextError && e.code === 'TIMEOUT' && e.message === 'aborted') throw e;
      lastErr = e;
      const status = (e as HttpShapedError).status;
      if (typeof status === 'number' && status >= 400 && status < 500 && status !== 429) throw classifyError(e);
      if (attempt < maxRetries) await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw classifyError(lastErr);
}

/**
 * Pre-flight rate check. A network hiccup here must not block the search, so
 * only an explicit rate-limit response counts as "limited".
 */
async function checkRateLimit(apiKey: string, jwt: string, signal?: AbortSignal | null): Promise<boolean> {
  const req = new ProtobufEncoder();
  req.writeMessage(1, buildMetadata(apiKey, jwt));
  req.writeString(3, MODEL);
  try {
    await unaryRequest(`${API_BASE}/CheckUserMessageRateLimit`, req.toBuffer(), true, signal);
    return true;
  } catch (e) {
    const status = (e as HttpShapedError).status;
    if (status === 429) return false;
    if (e instanceof FastContextError && e.code === 'RATE_LIMITED') return false;
    return true;
  }
}

// ─── Request / response shapes ─────────────────────────────

function buildMetadata(apiKey: string, jwt: string): ProtobufEncoder {
  const meta = new ProtobufEncoder();
  meta.writeString(1, APP_NAME);
  meta.writeString(2, APP_VERSION);
  meta.writeString(3, apiKey);
  meta.writeString(4, 'en');
  meta.writeString(5, systemInfoJson());
  meta.writeString(7, LS_VERSION);
  meta.writeString(8, cpuInfoJson());
  meta.writeString(12, APP_NAME);
  meta.writeString(21, jwt);
  meta.writeBytes(30, Buffer.from([0x00, 0x01]));
  return meta;
}

/** The wire message roles: 1 user, 2 assistant, 4 tool result, 5 system. */
export interface ChatMessage {
  role: number;
  content: string;
  tool_call_id?: string;
  tool_name?: string;
  tool_args_json?: string;
  ref_call_id?: string;
}

function buildChatMessage(m: ChatMessage): ProtobufEncoder {
  const msg = new ProtobufEncoder();
  msg.writeVarint(2, m.role);
  msg.writeString(3, m.content);
  if (m.tool_call_id && m.tool_name && m.tool_args_json) {
    const tc = new ProtobufEncoder();
    tc.writeString(1, m.tool_call_id);
    tc.writeString(2, m.tool_name);
    tc.writeString(3, m.tool_args_json);
    msg.writeMessage(6, tc);
  }
  if (m.ref_call_id) msg.writeString(7, m.ref_call_id);
  return msg;
}

function buildRequest(apiKey: string, jwt: string, messages: ChatMessage[], toolDefs: string): Buffer {
  const req = new ProtobufEncoder();
  req.writeMessage(1, buildMetadata(apiKey, jwt));
  for (const m of messages) req.writeMessage(2, buildChatMessage(m));
  req.writeString(3, toolDefs);
  return req.toBuffer();
}

/**
 * Parse the model's `[TOOL_CALLS]name[ARGS]{json}` reply. Returns
 * [thinking, name, args] or null when the text carries no call (i.e. it is a
 * plain answer or a failure).
 */
export function parseToolCall(text: string): [string, string, Record<string, unknown>] | null {
  const cleaned = text.replace(/<\/s>/g, '');
  const match = cleaned.match(/\[TOOL_CALLS\](\w+)\[ARGS\](\{.+)/s);
  if (!match) return null;
  const name = match[1] as string;
  const raw = (match[2] as string).trim();

  let depth = 0;
  let end = 0;
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] === '{') depth += 1;
    else if (raw[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  const jsonText = raw.slice(0, end === 0 ? raw.length : end);
  let args = parseJsonWithRepair(jsonText);
  if (!args && name === 'restricted_exec') args = salvageRestrictedExecArgs(jsonText);
  if (!args) return null;
  return [cleaned.slice(0, match.index).trim(), name, args];
}

  /** Drop the replacement characters that a partial UTF-8 sequence decodes to. */
function stripInvalidUtf8(buf: Buffer): string {
  return buf.toString('utf-8').split(FFFD).join('');
}

export interface TurnResult {
  text: string;
  toolCalls: { name: string; args: Record<string, unknown> }[];
}

/**
 * Decode a streamed reply into one assistant turn.
 *
 * The response schema is not published, so text is recovered structurally
 * (every length-delimited string over 5 chars, concatenated) until a frame
 * containing [TOOL_CALLS] shows up — then that frame wins outright. A frame
 * that parses as JSON with an `error` key is returned as the reference does,
 * as "[Error] code: message" text, which the loop recognises as a failure.
 */
export function parseResponse(data: Buffer): TurnResult {
  const frames = connectFrameDecode(data);
  let allText = '';

  for (const frame of frames) {
    try {
      const candidate = frame.toString('utf-8');
      if (candidate.startsWith('{')) {
        const parsed = JSON.parse(candidate) as { error?: { code?: string; message?: string } };
        if (parsed.error) {
          const code = parsed.error.code ?? 'unknown';
          const message = parsed.error.message ?? '';
          return { text: `[Error] ${code}: ${message}`, toolCalls: [] };
        }
      }
    } catch {
      /* not a JSON error frame; keep decoding as text */
    }

    const rawText = stripInvalidUtf8(frame);
    if (rawText.includes('[TOOL_CALLS]')) {
      allText = rawText;
      break;
    }
    for (const s2 of extractStrings(frame)) {
      if (s2.length > 10) allText += s2;
    }
  }

  const parsed = parseToolCall(allText);
  if (parsed) {
    const [thinking, name, args] = parsed;
    return { text: thinking, toolCalls: [{ name, args }] };
  }
  return { text: allText, toolCalls: [] };
}
// ─── Brain interface ─────────────────────────────────────

export interface BrainState {
  apiKey: string;
  jwt: string;
}

export interface TurnOptions {
  maxCommands?: number;
  timeoutMs?: number;
  signal?: AbortSignal | null;
}

/** The one brain blackhole has: the Windsurf/Devin Devstral endpoint. */
export interface Brain {
  readonly kind: 'windsurf';
  prepare(opts: { apiKey: string }, signal?: AbortSignal | null): Promise<BrainState>;
  stream(state: BrainState, messages: ChatMessage[], turnOpts: TurnOptions): Promise<TurnResult>;
}

/**
 * Resolve credentials for one search: key -> JWT (cached) -> rate-limit
 * pre-flight. Throws FastContextError with a code the tool reports.
 */
async function prepare(opts: { apiKey: string }, signal?: AbortSignal | null): Promise<BrainState> {
  const apiKey = (opts.apiKey ?? '').trim();
  if (apiKey === '') throw new FastContextError('no search credential resolved', 'AUTH_ERROR');
  const jwt = await getCachedJwt(apiKey, signal);
  if (!(await checkRateLimit(apiKey, jwt, signal))) {
    throw new FastContextError('Rate limited, please try again later', 'RATE_LIMITED');
  }
  return { apiKey, jwt };
}

/** Run one Devstral turn: send the conversation, get back text + tool call. */
async function stream(state: BrainState, messages: ChatMessage[], turnOpts: TurnOptions = {}): Promise<TurnResult> {
  const { maxCommands = 8, timeoutMs = 30_000, signal } = turnOpts;
  const toolSchemas = buildToolSchemas(maxCommands);
  // Wire format: OpenAI-style function definitions, JSON-encoded (reference).
  const toolDefs = JSON.stringify(
    toolSchemas.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
  );
  const proto = buildRequest(state.apiKey, state.jwt, messages, toolDefs);
  return parseResponse(await streamingRequest(proto, timeoutMs, 2, signal));
}

export const windsurfBrain: Brain = { kind: 'windsurf', prepare, stream };
