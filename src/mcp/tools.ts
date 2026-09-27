import { processManagementCapability, type ExecutionEnvironment } from '../execution.js';
import { VERSION } from '../version.js';
import type { ProcessManager } from '../process/manager.js';
import { registerProcessTool } from './process-tools.js';
import { processHelp } from '../process/guidance.js';
import type { EntitlementGate } from '../cloud/entitlement-gate.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { GUIDE_INPUT, guardGuideInput } from './guide-input.js';
import { normalizePermissionMode, type Config } from '../config.js';
import { createApprovalSeam } from '../approval/seam.js';
import type { SessionRuntime } from '../runtime.js';
import type { ConfirmationsRepo } from '../storage/confirmations.js';
import type { EventsRepo } from '../storage/events.js';
import type { SessionsRepo } from '../storage/sessions.js';
import { TODO_LIMITS, type TaskContract, type TodoItem, type TodosRepo } from '../storage/todos.js';
import { HANDOFF_MAX_BYTES, type HandoffsRepo } from '../storage/handoffs.js';
import type { ToolCallsRepo } from '../storage/toolCalls.js';
import { WorkspaceEditor, type EditorResult } from '../workspace/editor.js';
import { runContextSearch, type SemanticProbe } from '../semantic/index.js';
import type { PanelRegistry } from '../panel/keys.js';
import { PANEL_APP_TOKEN_META } from '../panel/keys.js';
import { approvalUnits, assessCommand, riskCategories, riskMatches } from '../workspace/risk.js';
import { runShell } from '../workspace/shell.js';
import { SkillAccessError } from '../workspace/skills.js';
import { skillLocations, listContextSkills, readContextSkill, readProjectInstructions } from '../workspace/skill-context.js';
import { skillReadStateFor } from '../workspace/skill-read-state.js';
import { fullGenericManual } from '../workspace/rules.js';
import { getWorkflow, WORKFLOW_NAMES } from '../workspace/workflows.js';
import { WORKSPACE_FILE_TOOL } from '../tool-routing.js';
import { isSessionId, sha256 } from '../util/token.js';
import { PANEL_RESOURCE_URI, RESOURCE_MIME_TYPE } from '../panel/appHtml.js';
import type { StartupMode } from '../prompt.js';
import { registerProxyTool, type ProxyRuntime } from '../proxy/tool.js';
import { activityToolRegistrar } from './activity-tools.js';
import type { SessionActivity } from '../session-activity.js';
import { executionErrorDiagnostic, withExecutionDiagnostic } from '../workspace/execution-diagnostic.js';

export interface ToolDeps {
  execution?: ExecutionEnvironment;
  processes?: ProcessManager;
  runtimes?: Map<string, SessionRuntime>;
  sessionActivity?: SessionActivity;
  entitlement?: EntitlementGate;
  cfg: Config;
  sessions: SessionsRepo;
  events: EventsRepo;
  toolCalls: ToolCallsRepo;
  confirmations: ConfirmationsRepo;
  /** Per-session task boards (the `todo` tool). */
  todos: TodosRepo;
  /** Optional only for older/minimal test dependency subsets. */
  handoffs?: HandoffsRepo;
  /** Daemon log sink; optional so tests can pass the repo subset. */
  log?: (line: string) => void;
  /**
   * Semantic-search probe, resolved once at startup. `available` decides
   * whether context_search is registered at all — the model is never
   * told about a capability that would fail. See ../semantic/index.ts.
   */
  semantic?: SemanticProbe;
  /**
   * 通用 MCP proxy 运行时（plan M1）：daemon 按配置文件装配；缺省 = 不注册
   * `proxy` 工具（工具面与 context_search 一样在 boot 定死）。
   */
  proxy?: ProxyRuntime;
  /**
   * MCP-Apps panel card registry (session → capability key). Absent in unit
   * tests: the show result then carries no `_meta`, exactly like before.
   */
  panels?: PanelRegistry;
  /**
   * Reachable daemon base for the panel card's polling (tunnel > public base
   * > loopback). Injected by the MCP router; absent in unit-test subsets.
   */
  panelBase?: () => string;
  /** Resource URI versioned with the same public-base snapshot as its CSP. */
  panelResourceUri?: string;
}

/**
 * Resolves the numeric session credential a work tool was handed to its
 * runtime (see router.ts: single-layer model — the argument is the only
 * routing surface).
 */
export interface SessionResolver {
  (ref: string): SessionRuntime | { error: string };
}

const text = (payload: unknown, isError = false, meta?: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  isError,
  // MCP outputSchema 契约：非 error 结果必须附带 structuredContent
  ...(!isError && typeof payload === 'object' && payload !== null
    ? { structuredContent: payload as Record<string, unknown> }
    : {}),
  // 顶层 _meta（schema 校验为 zod $loose，自定义键原样保留）：MCP-Apps 面板卡
  // 经 {ui:{resourceUri}} 挂到工具结果上；非 Apps 宿主忽略该字段
  ...(meta ? { _meta: meta } : {}),
});

// The storage boundary caps audit summaries after capturing numeric editor deltas.

/**
 * What persistence sees: the full arguments minus the `sessionId`, whose
 * plaintext must live only in the create/rotate responses (the DB stores its
 * hash). Hashing the sanitized form keeps confirmation retries matching,
 * since both the stored hash and the retry hash drop the same field.
 */
const recordedArgs = (args: unknown): Record<string, unknown> => {
  if (args === null || typeof args !== 'object') return {};
  const { sessionId: _sessionId, ...rest } = args as Record<string, unknown>;
  return rest;
};

/**
 * The numeric session id, required on every workspace tool call.
 * It identifies the workspace session that the tool should operate on.
 */
/**
 * Tools that do not require a session id. Shared with router.ts, whose
 * call-rejection pre-check must not flag attribution-only calls as malformed.
 */
export const KEYLESS_TOOLS = new Set(['guide', 'skill']);

const SESSION_ID_SCHEMA = z
  .string()
  .min(1)
  .describe('The session id provided by the operator. Pass it unchanged — it selects the workspace this call touches.');

/**
 * Attribution-only variant for the keyless reference tools (guide/skill):
 * an explicit operator library retains keyless compatibility. Project and
 * automatically discovered user files require a valid session, not attribution alone.
 */
const ATTRIBUTION_SCHEMA = z
  .string()
  .min(1)
  .optional()
  .describe('Pass the supplied session id to select project and default user skills and attach the lookup to its timeline. Only an explicit operator library supports keyless reads.');

const SKILL_SUMMARY_SCHEMA = z.object({
  name: z.string(), title: z.string().optional(), description: z.string(),
  source: z.enum(['project', 'user', 'custom']).optional(),
});

export function execDescription(hasPwsh: boolean, shellName: string, processes = false): string {
  const approval = 'High-risk or out-of-workspace commands pause for operator approval.'
    + (processes ? ' For background servers/watch tasks use process start; this tool waits for exit.' : '');
  const routing = `Use ${WORKSPACE_FILE_TOOL} for file inspection/editing; use this tool for command execution.`;
  if (hasPwsh) {
    return `${routing} You already start in the workspace root, so do NOT cd into it — run commands directly and reference files by relative path. Runs in a persistent PowerShell session — cwd, env and functions carry over between calls. ${approval}`;
  }
  const shellNote = shellName === 'cmd' ? 'The shell is cmd.exe.' : 'The shell is bash.';
  return `${routing} You already start in the workspace root, so do NOT cd into it — run commands directly and reference files by relative path. ${shellNote} The working directory persists across calls. ${approval}`;
}

const EDITOR_DESCRIPTION = [
  'Workspace file tool for reading and modifying files and directories — use it for all ordinary file inspection and editing, not the command tool.',
  'Pass shared `sessionId` and `path` at the top level, then put the command and its command-specific fields inside the strict `operation` object. Commands: `view`, `create`, `str_replace`, `insert`, `delete`. View before editing; all paths stay inside the workspace.',
].join(' ');

const WORKSPACE_EDITOR_PATH_SCHEMA = z.string().describe('Path relative to the workspace root (absolute paths must stay inside it).');
const WORKSPACE_EDITOR_OPERATION_SCHEMA = z.discriminatedUnion('command', [
  z.object({
    command: z.literal('view'),
    // Plain array, NOT z.tuple: a tuple serializes to draft-07 `items: [...]`,
    // which is invalid in JSON Schema 2020-12 and makes GPT's connector reject
    // the whole tool ("Invalid MCP tool schema"). Shape rules ([start, end],
    // start >= 1, end >= 1 or -1) are enforced at runtime by the refine instead.
    view_range: z.array(z.number().int()).refine(
      (r): boolean => {
        const [start, end] = r;
        return r.length === 2 && start !== undefined && start >= 1
          && (end === -1 || (end !== undefined && end >= 1));
      },
      { message: 'view_range must be [start, end]: one-based inclusive, start >= 1, end >= 1 or -1 for EOF' },
    ).optional().describe('[start, end], one-based inclusive; end=-1 means EOF. If end exceeds EOF it is clamped; start beyond EOF is an error.'),
  }).strict(),
  z.object({
    command: z.literal('create'),
    content: z.string().describe('Full UTF-8 content of the new file.'),
  }).strict(),
  z.object({
    command: z.literal('str_replace'),
    old_text: z.string().describe('Exact text to find; it must match exactly one location.'),
    new_text: z.string().describe('Replacement text.'),
  }).strict(),
  z.object({
    command: z.literal('insert'),
    line: z.number().int().min(0).describe('Insert after this one-based line number; use 0 to insert before the first line.'),
    content: z.string().describe('Text to insert.'),
  }).strict(),
  z.object({
    command: z.literal('delete'),
  }).strict(),
]);
const WORKSPACE_EDITOR_INPUT_SCHEMA = z.object({
  sessionId: SESSION_ID_SCHEMA,
  path: WORKSPACE_EDITOR_PATH_SCHEMA,
  operation: WORKSPACE_EDITOR_OPERATION_SCHEMA.describe('Command-specific operation payload.'),
}).strict();
type WorkspaceEditorInput = z.infer<typeof WORKSPACE_EDITOR_INPUT_SCHEMA>;


/**
 * `context_search` description. It has to do three jobs in one paragraph:
 * teach a weak model when to reach for it (before grep, when the target is
 * vague), when NOT to (an exact string or path is a grep job), and what it
 * costs — 30-120 s of third-party quota, with file excerpts leaving the
 * machine. The cost warning is not decoration: an agent that does not
 * expect a slow tool abandons it and retries.
 */
const SEARCH_DESCRIPTION = [
  'Semantic code search: describe a behaviour in natural language and get back the files that implement it —',
  `workspace-relative paths, 1-based line ranges and code, ready for ${WORKSPACE_FILE_TOOL} view.`,
  'Use BEFORE grep when you know what the code does but not where it lives; use grep/glob when you already',
  'know an exact string, symbol or path.',
  'SLOW: 30-120s multi-round search — do not retry mid-search. Sends workspace paths and code excerpts to',
  'the configured search service.',
].join('\n');

/** Clamp an optional model-supplied integer into the documented range. */
function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export function registerTools(
  server: McpServer,
  resolveWork: SessionResolver,
  deps: ToolDeps,
  machine: { execDescription: string },
): void {
  const { cfg, sessions, events, toolCalls, confirmations, todos, semantic } = deps;
  guardGuideInput(server);
  const registerTool = activityToolRegistrar(server, deps);
  registerProcessTool(registerTool, deps);
  // M0 审批执行 seam：exec 的确认等待状态机抽到这里，proxy（M1）复用同一接口
  const seam = createApprovalSeam({ confirmations, events, beforeGrant: () => deps.entitlement?.ensure() ?? Promise.resolve() });
  // one editor per session runtime; the runtime (and its workspace) can change
  // from call to call on the shared connection
  const editors = new Map<string, WorkspaceEditor>();
  const editorFor = (rt: SessionRuntime): WorkspaceEditor => {
    let e = editors.get(rt.session.id);
    if (!e) {
      e = new WorkspaceEditor(rt.workspace);
      editors.set(rt.session.id, e);
    }
    return e;
  };
  const execTool = 'exec';

  const withCallTracking = async <T extends { isError?: boolean; content: { text: string }[] }>(
    // proxy host 只要求 session 主键；SessionRuntime 结构上满足即可
    rt: { session: { id: string } },
    tool: string,
    args: unknown,
    fn: (callId: string) => Promise<T>,
    finishMetadata?: () => { navigationJson?: string },
  ): Promise<T> => {
    const rec = recordedArgs(args);
    const argsJson = JSON.stringify(rec);
    const argsHash = sha256(argsJson);
    const call = toolCalls.start(rt.session.id, tool, argsJson, argsHash);
    events.append(rt.session.id, 'tool_call_started', { call_id: call.id, tool, args: rec });
    try {
      const result = await fn(call.id);
      const failed = result.isError === true;
      // fn may already have driven the row to a terminal status (a denied
      // approval finishes it as 'denied'); only close rows still in flight.
      const cur = toolCalls.get(call.id);
      if (!cur || cur.status === 'started' || cur.status === 'awaiting') {
        toolCalls.finish(
          call.id,
          failed ? 'failed' : 'completed',
          result.content[0]?.text ?? '',
          finishMetadata?.().navigationJson,
        );
        events.append(rt.session.id, failed ? 'tool_call_failed' : 'tool_call_completed', {
          call_id: call.id,
          tool,
          result: JSON.parse(result.content[0]?.text ?? '{}'),
        });
      }
      return result;
    } catch (e) {
      const privateSubmit = tool === 'guide' && (args as { action?: string })?.action === 'submit';
      const message = privateSubmit ? 'Handoff tracking failed; save state requires confirmation.' : e instanceof Error ? e.message : String(e);
      toolCalls.finish(call.id, 'failed', message);
      events.append(rt.session.id, 'tool_call_failed', { call_id: call.id, tool, error: message });
      // text 形状恒满足 T 的结构约束（isError/content[0].text 都在）
      return text({ error: message }, true) as unknown as T;
    }
  };

  // Single-layer model: every work-tool call names its session by the numeric
  // credential argument. No per-connection binding, no activation step — the
  // argument is the only routing surface, which is exactly what hosts that
  // open a fresh MCP connection per turn can still carry.

  /**
   * Rejected calls used to vanish from the session feed, which made "the agent
   * called but nothing happened" impossible to diagnose. The credential rides
   * on every call now, so a rejection is attributable whenever the id resolves
   * to a live session row (an unknown id has no row to attach the record to).
   */
  const recordRejected = (tool: string, args: unknown, reason: string): void => {
    const ref = (args as { sessionId?: string } | undefined)?.sessionId;
    if (typeof ref !== 'string' || !isSessionId(ref)) return;
    // attach to the stable primary key (not the credential): records from
    // before and after a rotation land on the same session row
    const row = sessions.byCredential(ref);
    // terminated sessions stay clean: revoke purges their audit rows, and
    // calls arriving after termination must not start accumulating again
    if (!row || row.status === 'revoked' || row.status === 'archived') return;
    try {
      // recordedArgs strips sessionId like every other stored payload: the id
      // IS the credential in the single-layer model, plaintext never persists
      const json = JSON.stringify(recordedArgs(args));
      const call = toolCalls.start(row.id, tool, json, sha256(json));
      toolCalls.finish(call.id, 'failed', `rejected: ${reason}`);
    } catch {
      // bookkeeping must never mask the rejection itself
    }
  };

  const resolveRequired = (
    ref: string,
  ): { rt?: SessionRuntime; reject?: ReturnType<typeof text>; reason?: string } => {
    const rt = resolveWork(ref);
    if ('error' in rt) {
      return { reject: text({ status: 'rejected', code: 'session_invalid', reason: rt.error }, true), reason: rt.error };
    }
    // This resolver is the admission boundary for non-skill work tools, not
    // a general session lookup. Reset before logging/approvals/proxy catalog
    // awaits, even when the handler later returns a business error.
    skillReadStateFor(rt).reset();
    return { rt };
  };

  /**
   * Optional attribution for the keyless reference tools (guide/skill): a
   * caller that carries its session id gets the fetch recorded on its
   * session's call feed; without a resolvable id it stays a machine-level
   * event exactly as before. Attribution NEVER gates the call — an unknown or
   * stale id gets only the bootstrap response. The callback receives a runtime
   * only after admission; private project context must never be guessed.
   */
  const attributedFeed = async <T extends ReturnType<typeof text>>(
    sid: unknown,
    tool: string,
    args: unknown,
    machineEvent: (sessionRowId: string | null) => void,
    run: (runtime?: SessionRuntime) => T,
  ): Promise<T> => {
    if (typeof sid === 'string' && isSessionId(sid)) {
      const rt = resolveWork(sid);
      if (!('error' in rt)) {
        if (tool !== 'skill') skillReadStateFor(rt).reset();
        return withCallTracking(rt, tool, args, () => {
          machineEvent(rt.session.id);
          return Promise.resolve(run(rt));
        }) as Promise<T>;
      }
    }
    machineEvent(null);
    return run();
  };

  /**
   * Route data for the live card. The panel key is intentionally part of
   * structuredContent (the model may see it and may use it for polling),
   * while the app token is UI-only result metadata and never enters the
   * model-visible payload.
   */
  const panelRoutingFor = (rt: SessionRuntime): Record<string, unknown> | undefined => {
    if (deps.panels === undefined || deps.panelBase === undefined) return undefined;
    // `show` is the explicit boundary between prompt rounds. A fresh key
    // makes the previous iframe terminal, while the cursor keeps this round's
    // call feed free of earlier-round history.
    const panelKey = deps.panels.mountFresh(rt.session.id, toolCalls.maxSeqForSession(rt.session.id));
    return {
      panel_key: panelKey,
      panel_base: deps.panelBase(),
      panel_start_seq: deps.panels.startSeqFor(rt.session.id),
    };
  };
  // One decision drives both guidance and tool visibility. Read handshake state
  // from this connection only; unknown clients get the script-safe fallback.
  const startupMode = (): StartupMode => {
    const client = server.server.getClientVersion();
    if (!client?.name?.trim() || client.name === 'bh-cli') return 'script';
    const ui = server.server.getClientCapabilities()?.extensions?.['io.modelcontextprotocol/ui'];
    const mimeTypes = ui && 'mimeTypes' in ui ? ui.mimeTypes : undefined;
    return Array.isArray(mimeTypes) && mimeTypes.includes(RESOURCE_MIME_TYPE) ? 'apps' : 'script';
  };
  const panelResourceUri = deps.panelResourceUri ?? PANEL_RESOURCE_URI;


  const panelMetaFor = (sessionId: string, attach: boolean): Record<string, unknown> | undefined => {
    if (!attach || deps.panels === undefined) return undefined;
    const appToken = deps.panels.appTokenFor(sessionId);
    return {
      ui: {
        resourceUri: panelResourceUri,
        visibility: ['model'],
      },
      'openai/outputTemplate': panelResourceUri,
      'ui/resourceUri': panelResourceUri,
      ...(appToken ? { [PANEL_APP_TOKEN_META]: appToken } : {}),
    };
  };

  /**
   * Explicit render entry for a new ChatGPT prompt/conversation. It does not
   * repeat the long operating manual; the guide remains the one-time rules
   * entry point. Each call starts a new panel round and invalidates the
   * previous round; keeping this separate from ordinary tools prevents every
   * work call from remounting UI.
   */
  const showTool = registerTool(
    'show',
    {
      title: 'Show BlackHole Panel',
      description: 'Open BlackHole\'s live progress panel for the current task. This is presentation-only: it does not read or modify workspace files, run commands, or approve actions. Call at most once after each new user message when a live panel would help.',
      inputSchema: {
        sessionId: SESSION_ID_SCHEMA,
      },
      _meta: {
        ui: {
          resourceUri: panelResourceUri,
          visibility: ['model'],
        },
        'openai/outputTemplate': panelResourceUri,
        'ui/resourceUri': panelResourceUri,
      },
      outputSchema: {
        status: z.enum(['mounted', 'unavailable', 'rejected']),
        panel_key: z.string().optional(),
        panel_base: z.string().optional(),
        panel_start_seq: z.number().int().nonnegative().optional(),
      },
    },
    async (args) => {
      // Also guard the handler: stale discovery or a direct call must not mount UI.
      if (startupMode() !== 'apps') return text({ status: 'unavailable' }, true);
      const a = args as { sessionId: string };
      const { rt, reject, reason } = resolveRequired(a.sessionId);
      if (!rt || reject) {
        recordRejected('show', a, reason ?? 'session did not resolve');
        return reject!;
      }
      const routing = panelRoutingFor(rt);
      if (!routing || deps.panels === undefined) {
        return text({ status: 'unavailable' });
      }
      return text(
        { status: 'mounted', ...routing },
        false,
        panelMetaFor(rt.session.id, true),
      );
    },
  );

  // Discovery is fixed for this protocol pair at initialize time. A cached or
  // direct show call still reaches the handler guard above and cannot mount UI.
  const refreshShow = (): void => {
    const available = startupMode() === 'apps';
    if (showTool.enabled !== available) {
      if (available) showTool.enable();
      else showTool.disable();
    }
  };
  showTool.disable();
  const previousInitialized = server.server.oninitialized;
  server.server.oninitialized = () => {
    refreshShow();
    previousInitialized?.call(server.server);
  };

  registerTool(
    'guide',
    {
      title: 'BlackHole Guide',
      description: 'Start here: read and reuse the operating guide before workspace work. Pass either tool for exec/process help or workflow for a named workflow. workflow=handoff with content saves/replaces task context for a valid session; omit content to read. After confirmed saved, stop workspace work. Never mounts a panel.',
      inputSchema: GUIDE_INPUT,
      annotations: { readOnlyHint: false, idempotentHint: false },
      outputSchema: {
        instruction: z.string().describe('How to use the manual when operating BlackHole.'),
        manual: z.string().describe('The operating manual or selected workflow overlay, markdown.'),
        workflow: z.enum(WORKFLOW_NAMES).optional().describe('Present only for a workflow response.'),
        status: z.literal('saved').optional(),
        id: z.string().optional(),
        created_at: z.number().optional(),
        bytes: z.number().optional(),
        runtime: z.object({
          daemon_version: z.string(), platform: z.string(), arch: z.string(),
          execution_tools: z.array(z.enum(['exec', 'process'])),
          exec_shell: z.string().nullable(), process_shell: z.string().nullable(),
          process_unavailable_reason: z.string().nullable(),
          sandbox: z.object({
            backend: z.enum(['none','bubblewrap','seatbelt','windows-acl']),
            status: z.enum(['available','unavailable','deferred','unsupported']),
            reason: z.string().nullable(), detail: z.string().nullable(), fail_closed: z.literal(true),
          }),
          process_management: z.object({
            owner: z.enum(['job-object','process-group-supervisor','unavailable']),
            cleanup_guarantee: z.enum(['kernel-owned','confirmed-or-unknown','unavailable']),
          }),
          discovery_hint: z.string(),
        }).optional().describe('Server-side execution, sandbox and process-management facts; not proof that the client has loaded these tools.'),
      },
    },
    async (args, extra) => {
      const a = args as { sessionId?: string; tool?: 'exec' | 'process'; workflow?: unknown; content?: string };
      if (Object.prototype.hasOwnProperty.call(a, 'content')) {
        const fail = (code: string) => text({ instruction: code === 'save_unconfirmed'
          ? 'Handoff save unconfirmed. Stop work and automatic retries; ask the user to inspect the current Handoff in the plugin before deciding whether to replace it.'
          : 'Handoff not saved. Check the submission arguments and session availability.', manual: '', code }, true);
        if (a.workflow !== 'handoff' || a.tool !== undefined || typeof a.content !== 'string'
          || !a.content.trim() || Buffer.byteLength(a.content, 'utf8') > HANDOFF_MAX_BYTES) return fail('invalid_submission');
        if (!a.sessionId || !isSessionId(a.sessionId)) return fail('session_invalid');
        const metadata = { sessionId: a.sessionId, workflow: 'handoff', action: 'submit', content_bytes: Buffer.byteLength(a.content, 'utf8') };
        const { rt, reject, reason } = resolveRequired(a.sessionId);
        if (!rt || reject) {
          recordRejected('guide', metadata, reason ?? 'session unavailable');
          return fail('session_invalid');
        }
        if (!deps.handoffs || extra.signal.aborted || a.content.includes(a.sessionId)) return fail('submission_rejected');
        let committed = false;
        try {
          const result = await withCallTracking(rt, 'guide', metadata, async () => {
            if (extra.signal.aborted) return fail('cancelled');
            // Do not allow a storage exception to carry user input into audit logs.
            let saved;
            try { saved = deps.handoffs!.set(rt.session.id, a.content!); }
            catch { return fail('not_saved'); }
            committed = true;
            return text({ instruction: 'Handoff saved. Copy the connector or sandbox prompt directly from Handoff in the BlackHole session list or details; viewing is optional. Stop workspace work now.',
              manual: '', workflow: 'handoff', status: 'saved', id: saved.id,
              created_at: saved.created_at, bytes: Buffer.byteLength(saved.content, 'utf8') });
          });
          return committed && result.isError ? fail('save_unconfirmed') : result;
        } catch { return fail(committed ? 'save_unconfirmed' : 'not_saved'); }
      }
      if (a.tool && a.workflow !== undefined) {
        return text({ instruction: 'Choose either tool or workflow, not both.', manual: '' }, true);
      }
      const workflow = a.workflow === undefined ? undefined : getWorkflow(a.workflow);
      if (a.workflow !== undefined && !workflow) {
        return text({ instruction: `Unsupported workflow. Available workflows: ${WORKFLOW_NAMES.join(', ')}.`, manual: '' }, true);
      }
      const instruction =
        'Read and apply this operating manual before workspace operations. Follow Startup for this connection, then carry out the user task. ' +
        'Reuse the manual; revisit after context loss or when an instruction is unclear.';
      const startup = startupMode();
      return attributedFeed(
        a.sessionId,
        'guide',
        args,
        (sessionRowId) => events.append(
          sessionRowId,
          'guide_fetched',
          workflow ? { workflow: workflow.id } : {},
        ),
        (rt) => {
          // These use the same gates as tool registration. A client showing only
          // a lazy/cached subset must not be mistaken for an unsupported OS.
          const platform=deps.execution?.platform??process.platform;
          const processSupported=deps.processes?.supported===true;
          const sandbox=deps.execution?.sandbox??{backend:'none' as const,status:'unsupported' as const,reason:'sandbox_unsupported_platform',detail:'execution environment unavailable'};
          const runtime = {
            daemon_version: VERSION, platform,
            arch: deps.execution?.arch ?? process.arch,
            execution_tools: ['exec', ...(processSupported ? ['process'] : [])],
            exec_shell: deps.execution?.exec.shell.executable ?? null,
            process_shell: deps.execution?.process.shell?.executable ?? null,
            process_unavailable_reason: processSupported ? null : deps.execution?.process.reason ?? 'backend_unavailable',
            sandbox:{...sandbox,fail_closed:true as const},
            process_management:processManagementCapability(platform,processSupported),
            discovery_hint: 'exec/process are native BlackHole tools, not proxy entries. If listed here but missing in your client, refresh the host connector/tool discovery. A sandbox status of unavailable means restricted calls fail closed; it does not remove exec from server tools/list.',
          };
          const project = rt?.session.workspace_path ? readProjectInstructions(rt.session.workspace_path) : undefined;
          if (project && project.status !== 'ok') return text({ runtime, manual: '',
            instruction: `Project instructions could not be loaded completely (${project.status}). Resolve this error before workspace work; do not treat the file as absent.` }, true);
          const appendProject = (manual: string): string => project?.content
            ? `${manual}\n\n## PROJECT INSTRUCTIONS\n${project.content}`
            : manual;
          if (a.tool === 'process' && !deps.processes?.supported) return text({ instruction: 'process is unavailable on this daemon.', manual: '', runtime }, true);
          if (workflow) {
            return text({
              runtime,
              instruction: workflow.instruction,
              manual: appendProject(workflow.manual),
              workflow: workflow.id,
            });
          }
          const manual = a.tool === 'exec' ? machine.execDescription
            : a.tool === 'process' ? processHelp(deps.execution?.process.shell)
            : fullGenericManual('exec', deps.log ?? (() => undefined), semantic?.available === true, true, deps.proxy !== undefined, deps.processes?.supported === true, startup);
          return text({
            runtime,
            instruction: a.tool ? 'Use this supplement only for the selected tool; the operating guide still applies.' : instruction,
            manual: appendProject(manual),
          });
        },
      );
    },
  );

  const skillLaunchDirectory = process.cwd();
  registerTool(
    'skill',
    {
      title: 'Operator Skills',
      description: 'Read operator workflows and referenced files through this tool. Scripts are returned as text, not executed.',
      inputSchema: {
        sessionId: ATTRIBUTION_SCHEMA,
        name: z.string().min(1).max(255).optional().describe('Exact folder identifier from the skill list, not its display title. Omit to list skills.'),
        path: z.string().min(1).max(2048).optional().describe('Path relative to the named skill root, e.g. references/engineering-decisions.md. Omit for SKILL.md; use . for root discovery. No absolute or parent-traversal paths.'),
        offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional().describe('Directory pagination only: pass next_offset from the previous directory result.'),
        reload: z.boolean().optional().describe('Explicit file reread after context loss, failed delivery or a user request. Does not reset other files; not for directory/library listings.'),
      },
      outputSchema: {
        status: z.literal('ok'),
        kind: z.enum(['library', 'document', 'file', 'directory']),
        complete: z.boolean().describe('File/document: the server returned the whole file, not a model-delivery receipt. Directory: no further page remains. Library: discovery finished; inspect issues for invalid entries.'),
        instruction: z.string(),
        skills: z.array(SKILL_SUMMARY_SCHEMA).optional(),
        issues: z.array(z.object({
          name: z.string(), source: z.enum(['project', 'user', 'custom']),
          code: z.enum(['invalid_path', 'invalid_request', 'not_found', 'too_large', 'not_text', 'unreadable', 'resource_changed']),
          reason: z.string(),
        })).optional().describe('Invalid selected entries. A zero count with issues is not a healthy empty library; lower same-name versions remain shadowed.'),
        source: z.enum(['project', 'user', 'custom']).optional(),
        count: z.number().optional(),
        total: z.number().optional(),
        next_offset: z.number().optional(),
        name: z.string().optional(),
        title: z.string().optional().describe('Optional display title from frontmatter; use name for calls.'),
        description: z.string().optional(),
        dir: z.string().optional().describe(`Informational skill directory, not permission to access it with ${WORKSPACE_FILE_TOOL}.`),
        path: z.string().optional().describe('Resource path relative to the skill root.'),
        bytes: z.number().optional().describe('UTF-8 file byte count before JSON encoding.'),
        resource_id: z.string().optional().describe('Opaque identity of the actual file within its skill root; aliases share an identity.'),
        version: z.string().optional().describe('SHA-256 of the returned UTF-8 file content.'),
        dedupe: z.enum(['session_phase', 'untracked']).optional().describe('File-read guard scope; complete does not mean the host/model retained it.'),
        content: z.string().optional().describe('Complete UTF-8 text for a document/file; referenced files are fetched separately with name and path.'),
        entries: z.array(z.object({ name: z.string(), path: z.string(), kind: z.enum(['file', 'directory']) })).optional(),
      },
    },
    async (args, extra) => {
      const a = (args ?? {}) as { name?: string; sessionId?: string; path?: string; offset?: number; reload?: boolean };
      // Resolve once at admission. Re-resolving after a queue wait could move a
      // response into another attribution scope following credential rotation.
      let rt: SessionRuntime | undefined;
      if (typeof a.sessionId === 'string' && isSessionId(a.sessionId)) {
        const resolved = resolveWork(a.sessionId);
        if (!('error' in resolved)) rt = resolved;
      }
      // Automatic home/project discovery is private session context. Preserve
      // only the explicitly configured operator library's existing keyless contract.
      if (!rt && !cfg.skillsDir?.trim()) return text({ status: 'session_required',
        reason: 'Pass a valid supplied sessionId for project and default user skills. No automatic directories were read.' }, true);
      const locations = skillLocations(cfg.skillsDir, rt?.session.workspace_path, undefined, skillLaunchDirectory);
      const state = rt ? skillReadStateFor(rt) : undefined;
      const phase = state?.capture();
      const cancelled = () => extra?.signal?.aborted === true;
      const report = (payload: Record<string, unknown>, failed = false): Promise<ReturnType<typeof text>> => {
        const run = () => {
          if (cancelled()) return text({ status: 'cancelled', reason: 'The read was cancelled; it was not marked as provided.' }, true);
          const row = rt?.session.id ?? null;
          if (!failed) {
            if (payload.kind === 'library') events.append(row, 'skill_listed', { count: payload.count });
            else if (payload.kind === 'directory') events.append(row, 'skill_resources_listed', { name: payload.name, path: payload.path, count: payload.count });
            else events.append(row, 'skill_fetched', { name: payload.name, path: payload.path, bytes: payload.bytes, version: payload.version, complete: true });
          } else if (payload.code === 'SKILL_ALREADY_PROVIDED') {
            events.append(row, 'skill_duplicate_rejected', { name: payload.name, path: payload.path, version: payload.version });
          }
          return text(payload, failed);
        };
        return rt ? withCallTracking(rt, 'skill', args, async () => run()) : Promise.resolve().then(run);
      };
      if (cancelled()) return report({ status: 'cancelled' }, true);
      let payload: Record<string, unknown>;
      let resource: ReturnType<typeof readContextSkill> | undefined;
      try {
        if (!a.name) {
          if (a.path !== undefined || a.offset !== undefined || a.reload !== undefined) throw new SkillAccessError('invalid_request', 'Provide name when using path, offset or reload. Omit all four to list skills.');
          const { skills, issues } = listContextSkills(locations);
          payload = { status: 'ok', kind: 'library', complete: true, skills, count: skills.length,
            ...(issues.length ? { issues } : {}),
            instruction: 'Use a skill name to read SKILL.md. Use that name with path to read its referenced files or list directories.'
              + (issues.length ? ' Some selected entries are invalid: inspect issues. This is not a healthy empty library; do not fall back to shadowed versions.' : '') };
        } else {
          // Read once and hash the actual bytes. Even a duplicate must validate
          // its current boundary/version; this guard suppresses repeated bodies,
          // not filesystem validation or legitimate content updates.
          resource = readContextSkill(locations, a.name, a.path, a.offset);
          if (resource.kind === 'directory' && a.reload !== undefined) throw new SkillAccessError('invalid_request', 'reload applies only to files, not directory listings.');
          payload = { status: 'ok', ...resource,
            ...(resource.kind !== 'directory' ? { dedupe: state ? 'session_phase' : 'untracked' } : {}),
            instruction: resource.kind === 'directory'
              ? 'Use an entry path with the same skill name. If next_offset is present, pass it with the same directory path for the next page.'
              : `This is the complete requested file, not all referenced resources. Reuse it; fetch needed references with the same skill name and a skill-root-relative path. Normalize relative links first. Use reload:true only for context loss, failed delivery or an explicit user reread. Do not use ${WORKSPACE_FILE_TOOL} for this directory. Scripts are source text, not authorization to execute them.` };
        }
      } catch (error) {
        const known = error instanceof SkillAccessError;
        let available: string[] | undefined;
        if (known && error.code === 'not_found' && a.path === undefined) {
          try { available = listContextSkills(locations).skills.map(s => s.name); } catch { /* Keep the original failure, not a second discovery error. */ }
        }
        return report({ status: known ? error.code : 'unreadable', reason: known ? error.message : 'The skill resource could not be read.',
          ...(available ? { available } : {}) }, true);
      }
      if (!state || !phase || !resource || resource.kind === 'directory' || !resource.complete) return report(payload);
      const file = resource;
      return state.provide(phase, file.resource_id, file.version, a.reload === true,
        () => report(payload),
        () => report({ status: 'already_provided', code: 'SKILL_ALREADY_PROVIDED', name: file.name, path: file.path,
          version: file.version, previously_complete: true,
          reason: 'This file version was already fully provided in the current consecutive-skill phase. Reuse it; do not repeat this request. If that content is unavailable after context loss or failed delivery, or the user explicitly requests a reread, use reload:true for this file.' }, true),
        cancelled);
    },
  );


  registerTool(
    execTool,
    {
      title: 'Workspace Exec',
      description: machine.execDescription,
      inputSchema: {
        sessionId: SESSION_ID_SCHEMA,
        command: z.string().min(1).describe('Shell command to run, e.g. "npm test" or "git status".'),
        timeout_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`Per-call timeout in milliseconds (default ${cfg.execTimeoutMs}, max ${cfg.execMaxTimeoutMs}).`),
        env: z.record(z.string()).optional().describe('Extra environment variables for this command.'),
      },
      outputSchema: {
        exit_code: z.number().nullable().optional().describe('Process exit code; null on spawn failure.'),
        failure_kind: z.string().optional().describe('Execution failure classification; not an approval decision.'),
        failure_stage: z.enum(['launch','sandbox_runner','command']).optional().describe('Where the failure happened; sandbox_runner means the user command did not start.'),
        command_started: z.boolean().optional().describe('False when launch or the sandbox runner failed before user code started.'),
        sandbox_backend: z.enum(['none','bubblewrap','seatbelt','windows-acl']).optional().describe('Restricted execution backend associated with this result.'),
        hint: z.string().optional().describe('Diagnostic guidance; does not grant permissions or retry execution.'),
        stdout: z.string().describe('Captured standard output (may be truncated).'),
        stderr: z.string().describe('Captured standard error.'),
        cwd: z.string().optional().describe('Working directory after the command.'),
        duration_ms: z.number().optional().describe('Wall-clock duration in milliseconds.'),
        timed_out: z.boolean().optional().describe('True if the command was killed after the timeout.'),
        truncated: z.boolean().optional().describe('True if stdout/stderr hit the output cap.'),
      },
    },
    async (args) => {
      const a = args as { sessionId: string; command: string; timeout_ms?: number; env?: Record<string, string> };
      const { rt, reject, reason: rejectReason } = resolveRequired(a.sessionId);
      if (!rt || reject) {
        recordRejected(execTool, a, rejectReason ?? 'session did not resolve');
        return reject!;
      }
      return withCallTracking(rt, execTool, a, async (callId) => {
        const sandbox=deps.execution?.sandbox;
        const mode = normalizePermissionMode(rt.session.permission_mode);
        // M4.6 writableDirs：命中额外授权目录的路径按内侧处理（不弹越界确认）。
        // 仅 workspace-write 会话生效——read-only 仍整体只读，授权目录也不放开
        const pathCtx = normalizePermissionMode(rt.session.permission_mode) === 'workspace-write'
          ? { workspaceRoot: rt.workspace, cwd: rt.cwd, extraWritableDirs: rt.session.writable_dirs }
          : { workspaceRoot: rt.workspace, cwd: rt.cwd };
        // one classification feeds the decision, the card, and the scope grant.
        // `cats` is display/category level; `units` are the stable authorization
        // identities (pattern label+level / path parent-dir) that grants match.
        const matches = riskMatches(a.command, pathCtx);
        const cats = riskCategories(a.command, pathCtx);
        const units = approvalUnits(matches, a.command);
        const decision = assessCommand(mode, a.command, pathCtx);
        if (decision === 'deny') {
          return text(
            {
              status: 'denied',
              reason: `[sandbox: command denied under ${mode} mode] commands that mutate files or reach outside the workspace are blocked; ask the operator to run it or switch the session to workspace-write or danger-full-access`,
            },
            true,
          );
        }
        const rec = recordedArgs(a);
        const argsHash = sha256(JSON.stringify(rec));
        if (decision === 'confirm') {
          // M4.6 auto_approve：操作者显式开启的会话跳过审批卡直接执行——
          // 边界（read-only 拒绝 / ACL 沙箱 / deny 规则）全部不变，去掉的
          // 只是"问"这一步；跳过同样落审计事件，事后可追责。
          if (rt.autoApprove === true) {
            events.append(rt.session.id, 'approval_auto_skipped', { call_id: callId, tool: execTool, categories: cats });
          } else {
            // 审批等待状态机已抽到 approval/seam.ts：找/建确认、同步等决议、
            // ONCE 原子认领、scope 记忆与全部审计事件都在 seam 内完成；
            // 这里只通过 hooks 接调用追踪。denied 时 finish/事件已由 hooks+seam
            // 做过，不能再重复。
            const outcome = await seam.waitForApproval(
              {
                sessionId: rt.session.id,
                tool: execTool,
                units,
                argsHash,
                argsJson: JSON.stringify(rec),
                card: { command: a.command, matches: riskMatches(a.command, pathCtx), categories: cats },
                callId,
              },
              {
                tracking: {
                  onAwaiting: (id) => toolCalls.awaitApproval(id),
                  onGranted: (id, scope) => {
                    toolCalls.setApprovalScope(id, scope);
                    toolCalls.resume(id);
                  },
                  onDenied: (id, summaryJson) => toolCalls.finish(id, 'denied', summaryJson),
                },
              },
            );
            if (outcome.outcome === 'denied') {
              return text({ status: 'superseded', reason: outcome.reason }, true);
            }
          }
        }
        const timeoutMs = Math.min(Math.max(a.timeout_ms ?? cfg.execTimeoutMs, 1000), cfg.execMaxTimeoutMs);
        if (rt.pwsh) {
          const r = await rt.serialize(() => rt.pwsh!.run(a.command, timeoutMs, a.env));
          if (r.cwd && r.cwd !== rt.cwd) {
            rt.cwd = r.cwd;
            sessions.setCwd(rt.session.id, rt.cwd);
          }
          if (r.timed_out) {
            // Timeout is an executed tool outcome, not an MCP protocol failure.
            // Keep structuredContent so clients can inspect timed_out/exit_code directly.
            return text({ ...r, hint: `killed after ${timeoutMs} ms` });
          }
          if (r.exit_code === 0 && /Exception:|ParserError:|ErrorAction Stop/i.test(r.stderr)) r.exit_code = 1;
          return text(withExecutionDiagnostic(r, mode, sandbox));
        }
        let result:Awaited<ReturnType<typeof runShell>>;
        try {
          result = await rt.serialize(() =>
            runShell(
              {
                command: a.command,
                mode,
                extraWritableDirs: rt.session.writable_dirs,
                cwd: rt.cwd,
                workspace: rt.workspace,
                timeoutMs,
                env: a.env,
                outputCapBytes: cfg.execOutputCapBytes,
              },
              rt.shell,
            ),
          );
        } catch (error) {
          return text(executionErrorDiagnostic(error,mode,sandbox),true);
        }
        if (result.cwd && result.cwd !== rt.cwd) {
          rt.cwd = result.cwd;
          sessions.setCwd(rt.session.id, rt.cwd);
        }
        if (result.timed_out) {
          return text({ ...result, hint: `killed after ${timeoutMs} ms` });
        }
        const diagnosed=withExecutionDiagnostic(result,mode,sandbox);
        return text(diagnosed,diagnosed.failure_stage==='sandbox_runner');
      });
    },
  );

  registerTool(
    WORKSPACE_FILE_TOOL,
    {
      title: 'Editor',
      description: EDITOR_DESCRIPTION,
      inputSchema: WORKSPACE_EDITOR_INPUT_SCHEMA,
      outputSchema: {
        result: z.object({
          message: z.string().describe('Human-readable result or error message.'),
          isError: z.boolean().describe('True when the operation failed.'),
          code: z.string().optional().describe('Stable machine-readable error code, present when available.'),
          diff: z
            .object({
              added: z.number().describe('Lines added by the operation.'),
              removed: z.number().describe('Lines removed by the operation.'),
            })
            .optional()
            .describe('Line-level change stats, present for create/str_replace/insert/delete.'),
        }).describe('Editor operation result.'),
      },
    },
    async (args) => {
      const a = args as WorkspaceEditorInput;
      const { rt, reject, reason: rejectReason } = resolveRequired(a.sessionId);
      if (!rt || reject) {
        recordRejected(WORKSPACE_FILE_TOOL, a, rejectReason ?? 'session did not resolve');
        return reject!;
      }
      const editor = editorFor(rt);
      let navigationJson: string | undefined;
      const reply = (res: EditorResult) => {
        const { navigation, ...publicResult } = res;
        if (navigation) navigationJson = JSON.stringify(navigation);
        return text({ result: publicResult }, res.isError);
      };
      return withCallTracking(rt, WORKSPACE_FILE_TOOL, a, async () => {
        const mode = rt.session.permission_mode;
        const op = a.operation;
        if (mode === 'read-only' && op.command !== 'view') {
          return text({ result: { message: `[sandbox: command denied under read-only mode] "${op.command}" mutates files; ask the operator or switch the session to workspace-write or danger-full-access`, isError: true, code: 'PERMISSION_DENIED' } }, true);
        }
        switch (op.command) {
          case 'view':
            return reply(editor.view(a.path, op.view_range));
          case 'create':
            return reply(editor.create(a.path, op.content));
          case 'str_replace':
            return reply(editor.strReplace(a.path, op.old_text, op.new_text));
          case 'insert':
            return reply(editor.insert(a.path, op.line, op.content));
          case 'delete':
            return reply(editor.delete(a.path));
        }
      }, () => ({ navigationJson }));
    },
  );

  registerTool(
    'todo',
    {
      title: 'Task List',
      description:
        "Optional live milestone tracking; follow the guide's criteria for creating a board. " +
        "Reuse the same task's board across turns; do not overwrite unrelated work. Track outcomes, not individual files or tool calls. " +
        "`command='patch'` updates items by a unique content fragment. Patch verified completion and the next in_progress together when applicable; update at real milestones, not per tool call or only at the end. " +
        "`command='write'` replaces the complete list and optional Task Contract; use it to create or restructure a needed board. At most one in_progress; an empty list clears it. Include contract to retain it; omission clears it. " +
        "`command='read'` returns the list, optional Task Contract, and progress counts; use it only when needed state is missing or stale, not routinely after successful updates or at completion.",
      inputSchema: z.object({
        sessionId: SESSION_ID_SCHEMA,
        command: z.enum(['read', 'write', 'patch']).describe("`read` returns the current list; `write` replaces the whole list; `patch` updates existing items in place."),
        todos: z
          .array(
            z
              .object({
                content: z.string().min(1).max(TODO_LIMITS.content).describe('Imperative task text, e.g. "fix the login redirect".'),
                status: z.enum(['pending', 'in_progress', 'completed']).describe('Item state.'),
                activeForm: z
                  .string()
                  .min(1)
                  .max(TODO_LIMITS.activeForm)
                  .optional()
                  .describe('Present-continuous form shown while this item is in_progress, e.g. "fixing the login redirect".'),
              })
              .strict(),
          )
          .max(TODO_LIMITS.items)
          .optional()
          .describe('REQUIRED for command=write: the complete new list, in display order. FORBIDDEN for read and patch.'),
        updates: z
          .array(
            z
              .object({
                content: z.string().min(1).max(200).describe('Case-insensitive fragment that must match exactly one item content.'),
                status: z.enum(['pending', 'in_progress', 'completed']).optional().describe('New status.'),
                activeForm: z.string().min(1).max(200).optional().describe('New present-continuous form.'),
              })
              // strict 不是装饰：zod 默认剥离未知键——没有它 agent 传来的
              // `index` 会被静默扔掉，patch 语义就在协议层悄悄变了
              .strict(),
          )
          .max(50)
          .optional()
          .describe('REQUIRED for command=patch (1-50 updates). FORBIDDEN for read and write.'),
        contract: z.object({
          goal: z.string().trim().min(1).max(TODO_LIMITS.goal),
          nonGoals: z.array(z.string().trim().min(1).max(TODO_LIMITS.nonGoal)).max(TODO_LIMITS.contractEntries),
          successCriteria: z.array(z.string().trim().min(1).max(TODO_LIMITS.successCriterion)).max(TODO_LIMITS.contractEntries),
          verification: z.array(z.string().trim().min(1).max(TODO_LIMITS.verification)).max(TODO_LIMITS.contractEntries),
        }).strict().optional()
          .describe('Optional Task Contract for write: persist Goal, Non-Goal, Success Criteria and Verification together. Omit to clear it.'),
      }).strict(),
      // read/patch/write 共用一个 schema：除 command 外全部 optional——任一侧
      // required 字段都会让另一侧的输出过不了 structuredContent 校验。
      outputSchema: {
        command: z.enum(['read', 'write', 'patch']),
        items: z
          .array(
            z.object({
              content: z.string(),
              status: z.enum(['pending', 'in_progress', 'completed']),
              activeForm: z.string().optional(),
            }),
          )
          .optional()
          .describe("read only: the current list, in display order."),
        contract: z.object({
          goal: z.string(),
          nonGoals: z.array(z.string()),
          successCriteria: z.array(z.string()),
          verification: z.array(z.string()),
        }).optional().describe('read only: the saved Task Contract, if any.'),
        status: z.string().optional().describe("write/patch only: 'ok'."),
        updated: z.number().optional().describe('patch only: how many updates applied.'),
        active: z
          .object({
            content: z.string(),
            status: z.enum(['pending', 'in_progress', 'completed']),
            activeForm: z.string().optional(),
          })
          .optional()
          .describe('patch only: the single item now in_progress after applying — the current next step. Absent when nothing is in_progress.'),
        total: z.number().optional().describe('List size.'),
        completed_count: z.number().optional().describe('Items with status completed.'),
        in_progress_count: z.number().optional().describe('Items with status in_progress.'),
        updated_at: z.number().optional().describe('read only: last write, epoch ms (0 = never written).'),
      },
    },
    async (args) => {
      const a = args as {
        sessionId: string;
        command: 'read' | 'write' | 'patch';
        todos?: TodoItem[];
        updates?: { content: string; status?: TodoItem['status']; activeForm?: string }[];
        contract?: TaskContract;
      };
      const { rt, reject, reason: rejectReason } = resolveRequired(a.sessionId);
      if (!rt || reject) {
        recordRejected('todo', a, rejectReason ?? 'session did not resolve');
        return reject!;
      }
      return withCallTracking(rt, 'todo', a, async () => {
        const counts = (items: TodoItem[]) => ({
          total: items.length,
          completed_count: items.filter((t) => t.status === 'completed').length,
          in_progress_count: items.filter((t) => t.status === 'in_progress').length,
        });
        if (a.command === 'read') {
          // 读意图携带清单/更新 = 模型手滑，明确拒绝：绝不静默当成一次写入
          if (Array.isArray(a.todos) || Array.isArray(a.updates) || a.contract !== undefined) {
            return text(
              { status: 'rejected', reason: 'command=read takes no `todos`/`updates`/`contract`; use write to replace or patch to update' },
              true,
            );
          }
          const board = todos.get(rt.session.id);
          return text({
            command: 'read',
            items: board.items,
            ...(board.contract ? { contract: board.contract } : {}),
            ...counts(board.items),
            updated_at: board.updated_at,
          });
        }
        if (a.command === 'patch') {
          if (Array.isArray(a.todos) || a.contract !== undefined) {
            return text(
              { status: 'rejected', reason: 'command=patch updates existing items; use command=write to replace the list' },
              true,
            );
          }
          const updates = a.updates ?? [];
          if (updates.length === 0) {
            return text({ status: 'rejected', reason: 'command=patch requires a non-empty `updates` array' }, true);
          }
          const board = todos.get(rt.session.id);
          if (board.items.length === 0) {
            return text({ status: 'rejected', reason: 'the task list is empty; use command=write to create it first' }, true);
          }
          // 原子性：全部更新在副本上应用，任一 content 片段 0/多命中即整单拒绝
          // 并回显候选——绝不出半态；合并结果仍受"至多一个 in_progress"校验
          const items = board.items.map((t) => ({ ...t }));
          // 只统计真正发生变更的条目。请求带了定位片段却未携带任何可变更字段
          // (status/activeForm) 时不得计为已更新，否则等于向调用方谎报成功。
          let changed = 0;
          for (const u of updates) {
            const needle = u.content.trim().toLowerCase();
            const hits = items.filter((t) => t.content.toLowerCase().includes(needle));
            if (hits.length === 0) {
              return text(
                { status: 'rejected', reason: `no item matches "${u.content}"`, candidates: board.items.map((t) => t.content).slice(0, 10) },
                true,
              );
            }
            if (hits.length > 1) {
              return text(
                { status: 'rejected', reason: `"${u.content}" matches ${hits.length} items; use a longer fragment`, candidates: hits.map((t) => t.content).slice(0, 10) },
                true,
              );
            }
            // 定位片段本身就是 content 语义（按原文片段找条目），“改名”无从
            // 谈起：patch 不支持替换 content 全文，那等于要求全等定位且行为
            // 与 write 重叠——重构清单走 write。
            const target = hits[0]!;
            let touched = false;
            if (u.status !== undefined && target.status !== u.status) {
              target.status = u.status;
              touched = true;
            }
            if (u.activeForm !== undefined && target.activeForm !== u.activeForm) {
              target.activeForm = u.activeForm;
              touched = true;
            }
            if (touched) changed += 1;
          }
          const c = counts(items);
          if (c.in_progress_count > 1) {
            return text({ status: 'rejected', reason: 'at most one item may be in_progress', ...counts(board.items) }, true);
          }
          todos.set(rt.session.id, items, board.contract);
          // 回显最新计数 + patch 后唯一的 in_progress 条目（= 下一步）：
          // fragment 误配会在这里立刻暴露，agent 不必再 read 对账
          const active = items.find((t) => t.status === 'in_progress');
          return text({
            command: 'patch',
            status: 'ok',
            updated: changed,
            ...c,
            ...(active
              ? { active: { content: active.content, status: active.status, ...(active.activeForm ? { activeForm: active.activeForm } : {}) } }
              : {}),
          });
        }
        // write
        if (Array.isArray(a.updates)) {
          return text(
            { status: 'rejected', reason: 'command=write replaces the whole list; do not send `updates` — use command=patch for point updates' },
            true,
          );
        }
        if (!Array.isArray(a.todos)) {
          return text({ status: 'rejected', reason: 'command=write requires the complete `todos` array' }, true);
        }
        if (a.todos.filter((t) => t.status === 'in_progress').length > 1) {
          return text({ status: 'rejected', reason: 'at most one item may be in_progress' }, true);
        }
        todos.set(rt.session.id, a.todos, a.contract);
        // write 只回计数不回显 items：要完整清单就 read，读写职责清晰
        return text({ command: 'write', status: 'ok', ...counts(a.todos) });
      });
    },
  );

  // ─── proxy（plan M1：配置了 upstream 才注册；boot 定死工具面）────────
  if (deps.proxy !== undefined) {
    registerProxyTool(server, deps.proxy, {
      beforeExecute: () => deps.entitlement?.ensure() ?? Promise.resolve(),
      resolveRequired,
      recordRejected,
      withCallTracking,
      tracking: {
        onDenied: (id, summaryJson) => toolCalls.finish(id, 'denied', summaryJson),
      },
      deps: { events },
      text,
    }, registerTool);
  }

  // ─── context_search (registered only when a search key resolved) ──
  //
  // Startup-time gating, deliberately: MCP clients cache tools/list, so a tool
  // that appears and disappears mid-connection is worse than one that is never
  // offered. Rotating the key therefore needs a daemon restart, which the CLI
  // says out loud.
  if (semantic !== undefined && semantic.available) {
    registerTool(
      'context_search',
      {
        title: 'Semantic Code Search',
        description: SEARCH_DESCRIPTION,
        inputSchema: {
          sessionId: SESSION_ID_SCHEMA,
          query: z
            .string()
            .min(3)
            .describe('What to find, phrased in natural language (e.g. "where uploaded images are decoded before the request is sent").'),
          path: z
            .string()
            .optional()
            .describe(
              'Workspace-relative directory to search, e.g. "src" or "src/server". Defaults to the workspace root. ' +
                'Narrow it on a large repo: it shortens the map the search agent sees and the whole call.',
            ),
          tree_depth: z
            .number()
            .int()
            .min(1)
            .max(6)
            .optional()
            .describe('Directory-tree depth of the repo map, 1-6 (default 3). Lowered automatically when the map gets too large.'),
          max_turns: z
            .number()
            .int()
            .min(1)
            .max(5)
            .optional()
            .describe('Search rounds, 1-5 (default 3). 1 round only explores and its answer is unreliable — a query for something absent can return guessed files. 2+ verifies before answering.'),
          max_results: z.number().int().min(1).max(30).optional().describe('Maximum files to return (default 10).'),
          exclude_paths: z
            .array(z.string())
            .optional()
            .describe('Extra directory/file names to skip. node_modules, dist, build and similar are already skipped.'),
          include_content: z
            .boolean()
            .optional()
            .describe('Include the code of the returned line ranges (default true, under a ~48 KB budget). Set false for a path+range list only.'),
        },
        outputSchema: {
          result: z
            .object({
              message: z.string().describe('The report: file list, then the code of each range. On failure, the error plus diagnostics and a hint.'),
              isError: z.boolean().describe('True when the search failed or found nothing usable.'),
              files: z
                .array(
                  z.object({
                    path: z.string().describe('Workspace-relative path, e.g. "src/server/upload.ts".'),
                    ranges: z.array(z.tuple([z.number(), z.number()])).describe('1-based inclusive line ranges.'),
                  }),
                )
                .optional()
                .describe('Structured hits (empty when nothing matched), for clients that do not want to parse the text.'),
              meta: z
                .object({
                  tree_depth: z.number().optional(),
                  tree_size_kb: z.number().optional(),
                  engine: z.string().optional().describe('Search backend used locally (ripgrep path or the built-in scanner).'),
                  cache_hit: z.boolean().optional().describe('True when an identical recent search was reused.'),
                  salvaged: z.boolean().optional().describe('True when the answer was recovered from a malformed response — treat the ranges as approximate.'),
                  truncated_files: z.number().optional().describe(`Files whose code was cut by the content budget (0 = full). When > 0, narrow the query/path or read the listed ranges with ${WORKSPACE_FILE_TOOL} view.`),
                })
                .optional(),
            })
            .describe('Search outcome.'),
        },
      },
        // Read-only: it greps and reads inside the session workspace, writes nothing.
        async (args, extra) => {
          const a = args as {
            sessionId: string;
            query: string;
            path?: string;
            tree_depth?: number;
            max_turns?: number;
            max_results?: number;
            exclude_paths?: string[];
            include_content?: boolean;
          };
          const { rt, reject, reason: rejectReason } = resolveRequired(a.sessionId);
          if (!rt || reject) {
            recordRejected('context_search', a, rejectReason ?? 'session did not resolve');
            return reject!;
          }
          return withCallTracking(rt, 'context_search', a, async () => {
            const query = typeof a.query === 'string' ? a.query.trim() : '';
            if (query === '') return text({ result: { message: 'Error: query must be a non-empty description', isError: true } }, true);

            const outcome = await runContextSearch({
              cfg,
              probe: semantic,
              workspaceRoot: rt.workspace,
              query,
              ...(a.path ? { subPath: a.path } : {}),
              ...(a.tree_depth ? { treeDepth: clampInt(a.tree_depth, 1, 6, 3) } : {}),
              ...(a.max_turns ? { maxTurns: clampInt(a.max_turns, 1, 5, 3) } : {}),
              ...(a.max_results ? { maxResults: clampInt(a.max_results, 1, 30, 10) } : {}),
              ...(a.exclude_paths ? { excludePaths: a.exclude_paths.filter((p) => typeof p === 'string' && p.trim() !== '') } : {}),
              includeContent: a.include_content !== false,
              // The SDK aborts the request when the client disconnects or
              // cancels: without this, an abandoned search keeps running for
              // its full budget and spends the operator's quota twice on a retry.
              ...(extra?.signal ? { signal: extra.signal } : {}),
            });

            // An empty result is NOT an error: the search agent's own policy is
            // to return nothing rather than guess, and marking that as a failure
            // trains the agent to re-ask (and re-pay) until it gets noise.
            const failed = outcome.meta.errorCode !== undefined;
            return text({
              result: {
                message: outcome.report,
                isError: failed,
                files: outcome.files.map((f) => ({ path: f.path, ranges: f.ranges })),
                meta: {
                  tree_depth: outcome.meta.treeDepth,
                  tree_size_kb: outcome.meta.treeSizeKB,
                  engine: semantic.engine,
                  ...(outcome.meta.cacheHit ? { cache_hit: true } : {}),
                  ...(outcome.meta.salvaged ? { salvaged: true } : {}),
                  // 内容预算截面的可见信号：>0 提示收窄重搜或转 view 续读
                  ...(outcome.truncatedFiles > 0 ? { truncated_files: outcome.truncatedFiles } : {}),
                },
              },
            }, failed);
          });
        }
    );
  }
}
