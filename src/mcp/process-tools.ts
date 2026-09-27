import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from './tools.js';
import { normalizePermissionMode } from '../config.js';
import { createApprovalSeam } from '../approval/seam.js';
import { approvalUnits, assessCommand, riskCategories, riskMatches } from '../workspace/risk.js';
import { isSessionId, sha256, deriveAccessToken } from '../util/token.js';
import { ProcessError, type ProcessOwner } from '../process/types.js';
import { canonicalDirectory, ownerFingerprint } from '../process/manager.js';
import { processDescription } from '../process/guidance.js';
import { shellLabel } from '../execution.js';
import { sandboxFailureHint, type SandboxBackend, type SandboxDiagnosticCode } from '../workspace/posix-sandbox.js';
import { skillReadStateFor } from '../workspace/skill-read-state.js';

const sid = z.string().min(1);
const id = z.string().regex(/^proc_[0-9a-f-]{36}$/);
const launch = {
  sessionId: sid, command: z.literal('start'), requestId: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/),
  script: z.string().min(1).max(8192), name: z.string().min(1).max(80).optional(), cwd: z.string().min(1).max(2048).optional(),
};
export const PROCESS_INPUT = z.discriminatedUnion('command', [
  z.object(launch).strict(), z.object({ sessionId: sid, command: z.literal('list') }).strict(),
  z.object({ sessionId: sid, command: z.literal('status'), processId: id }).strict(),
  z.object({ sessionId: sid, command: z.literal('stop'), processId: id, closeTerminal: z.boolean().optional() }).strict(),
]);
const result = (data: Record<string, unknown>, error = false) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data) }], structuredContent: data, isError: error,
});

export function processSandboxDiagnostic(reason:string|null|undefined,backend:SandboxBackend):Record<string,unknown> {
  if(reason==='runtime_asset_missing')return {
    code:reason,failure_stage:'launch',command_started:false,
    hint:'后台任务没有启动：process 监护组件缺失。请重新安装完整的 BlackHole 插件并重启本地服务；不要重复提交同一启动请求。',
  };
  if(reason==='unsupported_platform')return {
    code:reason,failure_stage:'launch',command_started:false,
    hint:'后台任务没有启动：当前平台或架构没有受支持的 process 后端。exec 是否可用请以 guide.runtime 为准。',
  };
  const code=reason as SandboxDiagnosticCode|undefined;
  if(!code||!['sandbox_runner_missing','sandbox_runner_nested','sandbox_runner_failed','sandbox_configuration_error','sandbox_unsupported_platform','execution_policy_denied','sandbox_policy_denied'].includes(code))return {};
  const runner=code!=='execution_policy_denied'&&code!=='sandbox_policy_denied';
  return {code,failure_stage:runner?'sandbox_runner':'command',command_started:!runner,sandbox_backend:backend,hint:sandboxFailureHint(code,backend)};
}

export function registerProcessTool(register: McpServer['registerTool'], deps: ToolDeps): void {
  const manager = deps.processes;
  if (!manager?.supported) return;
  const syntax = deps.execution ? shellLabel(deps.execution.process.shell) : 'daemon-selected shell';
  const seam = createApprovalSeam({ confirmations: deps.confirmations, events: deps.events, beforeGrant: () => deps.entitlement?.ensure() ?? Promise.resolve() });
  const sandboxDiagnostic=(reason:string|null|undefined):Record<string,unknown>=>processSandboxDiagnostic(reason,deps.execution?.sandbox.backend??'none');
  const resolve = (credential: string) => {
    const row = isSessionId(credential) ? deps.sessions.byCredential(credential) : undefined;
    if (!row || row.status !== 'active' || (row.expires_at !== null && row.expires_at < Date.now())) throw new ProcessError('session_invalid', 'Session is unavailable, paused, expired or revoked');
    return row;
  };
  const owner = (row: ReturnType<typeof resolve>): ProcessOwner => ({
    sessionId: row.id, workspace: canonicalDirectory(row.workspace_path), mode: normalizePermissionMode(row.permission_mode),
    writableDirs: (row.writable_dirs ?? []).map(canonicalDirectory),
  });
  register('process', {
    title: 'Background Process', description: processDescription(deps.execution?.process.shell),
    // Flat, connector-compatible discovery schema; the strict union below enforces command-specific fields.
    inputSchema: {
      sessionId: sid.describe('The operator-supplied session credential, unchanged.'),
      command: z.enum(['start', 'list', 'status', 'stop']),
      requestId: launch.requestId.optional().describe('Required for start. Stable ID for one launch intention; reuse on a lost response.'),
      script: launch.script.optional().describe(`Required for start. ${syntax} script; keep the service in the foreground.`),
      name: launch.name.describe('Display label only.'), cwd: launch.cwd.describe('Working directory; defaults to the workspace root, not the previous shell cwd.'),
      processId: id.optional().describe('Required for status/stop. Use the ID returned by start/list, never construct it or pass an OS PID.'),
      closeTerminal: z.boolean().optional().describe('stop only. Default false. After stop is confirmed, request closing this processId\'s VS Code terminal; unconfirmed cleanup keeps it open.'),
    },
    outputSchema: {
      status: z.enum(['ok', 'error']), processId: z.string().optional(), daemonId: z.string().optional(), requestId: z.string().optional(),
      name: z.string().optional(), cwd: z.string().optional(), state: z.enum(['starting', 'running', 'stopping', 'exited', 'failed', 'unknown']).optional(),
      pid: z.number().nullable().optional(), startedAt: z.string().optional(), endedAt: z.string().nullable().optional(),
      exitCode: z.number().nullable().optional(), signal: z.string().nullable().optional(), reason: z.string().nullable().optional(),
      output: z.object({ stdout: z.string(), stderr: z.string(), truncated: z.boolean(), version: z.number() }).optional(),
      terminal: z.object({ state: z.enum(['pending', 'open', 'closed', 'unavailable']), reason: z.string().optional() }).optional(),
      items: z.array(z.record(z.unknown())).optional(), code: z.string().optional(),
      failure_stage: z.enum(['launch','sandbox_runner','command']).optional(), command_started: z.boolean().optional(),
      sandbox_backend: z.enum(['none','bubblewrap','seatbelt','windows-acl']).optional(), hint: z.string().optional(),
    },
  }, async (raw, extra) => {
    let callId: string | undefined, internalId: string | undefined;
    try {
      const parsed = PROCESS_INPUT.safeParse(raw);
      if (!parsed.success) return result({ status: 'error', code: 'invalid_request', reason: 'Invalid process fields for this command', hint: 'start requires requestId/script; status/stop require processId; list accepts only sessionId/command.' }, true);
      const input = parsed.data;
      const row = resolve(input.sessionId); internalId = row.id;
      const rt = deps.runtimes?.get(row.id); if (rt) skillReadStateFor(rt).reset();
      const secrets = [input.sessionId, deriveAccessToken(), ...(deps.proxy?.secretValues ?? [])];
      const clean = (value: string) => secrets.filter(s => s.length >= 4).reduce((s, key) => s.split(key).join('[redacted]'), value);
      const { sessionId: _credential, ...args } = input;
      const safeArgs = clean(JSON.stringify(args));
      callId = deps.toolCalls.start(row.id, 'process', safeArgs, sha256(JSON.stringify(args))).id;
      let payload: Record<string, unknown>;
      if (input.command === 'list') payload = { status: 'ok', daemonId: manager.daemonId, items: manager.list(row.id) };
      else if (input.command === 'status') {
        const snapshot=manager.status(row.id,input.processId);
        payload={status:'ok',...snapshot,...sandboxDiagnostic(snapshot.reason)};
      }
      else if (input.command === 'stop') payload = { status: 'ok', ...await manager.stop(row.id, input.processId, 'operator_stop', input.closeTerminal ?? false) };
      else {
        const selected = owner(row), expected = ownerFingerprint(selected);
        const launched = await manager.start(selected, input, async (spec, stopSignal) => {
          const signal = AbortSignal.any([extra.signal, stopSignal]);
          const recheck = () => {
            if (signal.aborted) throw new ProcessError('cancelled', 'Launch was cancelled before spawn');
            const fresh = resolve(input.sessionId);
            if (fresh.id !== selected.sessionId || ownerFingerprint(owner(fresh)) !== expected) throw new ProcessError('permission_changed', 'Session permissions changed while authorizing launch');
          };
          recheck(); await deps.entitlement?.ensure(); recheck();
          const context = { workspaceRoot: spec.workspace, cwd: spec.cwd, extraWritableDirs: spec.mode === 'workspace-write' ? spec.writableDirs : [] };
          const decision = assessCommand(spec.mode, spec.script, context);
          if (decision === 'deny') throw new ProcessError('permission_denied', 'Command is denied by the current workspace policy');
          const freshApproval = resolve(input.sessionId);
          if (decision === 'confirm' && !(String(freshApproval.auto_approve ?? '') === '1' || freshApproval.auto_approve === true)) {
            const matches = riskMatches(spec.script, context);
            const outcome = await seam.waitForApproval({
              sessionId: row.id, tool: 'process', units: approvalUnits(matches, spec.script),
              argsHash: sha256(JSON.stringify(['process', args, expected, spec.cwd])),
              // Existing approval renderers and critical-scope checks consume command, not the MCP action verb.
              argsJson: clean(JSON.stringify({ action: 'start', requestId: spec.requestId, name: spec.name, cwd: spec.cwd,
                command: 'Background process (' + syntax + ')\ncwd: ' + spec.cwd + '\n' + spec.script })),
              card: { command: clean('Background process (' + syntax + ')\ncwd: ' + spec.cwd + '\n' + spec.script), categories: [...riskCategories(spec.script, context), 'background_process'] },
              callId,
            }, { signal, tracking: {
              onAwaiting: id => deps.toolCalls.awaitApproval(id),
              onGranted: (id, scope) => { deps.toolCalls.setApprovalScope(id, scope); deps.toolCalls.resume(id); },
            } });
            if (outcome.outcome !== 'granted') throw new ProcessError('approval_denied', outcome.reason);
          } else if (decision === 'confirm') deps.events.append(row.id, 'approval_auto_skipped', { call_id: callId, tool: 'process' });
          recheck(); // last synchronous check before ProcessManager performs native spawn
        }, secrets, callId);
        const diagnostic=sandboxDiagnostic(launched.reason);
        payload = { status: launched.state === 'failed' || launched.reason === 'cancelled_before_spawn' ? 'error' : 'ok', ...launched,
          ...diagnostic,
          ...('hint' in diagnostic?{}:{hint:'Use status with this processId. running is not ready; verify the actual endpoint. Stop after the task unless the operator asks to keep it.'}) };
      }
      // Keep large/binary-like logs out of permanent tool-call history; status returns them to the caller only.
      const summary = JSON.stringify({ status: payload.status, processId: payload.processId, state: payload.state, reason: payload.reason, exitCode: payload.exitCode });
      if (deps.sessions.get(row.id)?.status !== 'revoked') deps.toolCalls.finish(callId, payload.status === 'error' ? 'failed' : 'completed', summary);
      return result(payload, payload.status === 'error');
    } catch (error) {
      const code = error instanceof ProcessError ? error.code : 'process_unavailable';
      // Unexpected exceptions are sanitized; OS errors already live in the bounded per-process output.
      const payload = { status: 'error', code, reason: error instanceof ProcessError ? error.message : 'Process request could not be completed; inspect managed status before retrying.',
        ...sandboxDiagnostic(code) };
      if (callId && internalId && deps.sessions.get(internalId)?.status !== 'revoked') deps.toolCalls.finish(callId, 'failed', JSON.stringify(payload));
      return result(payload, true);
    }
  });
}
