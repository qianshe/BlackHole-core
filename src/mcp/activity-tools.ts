import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SessionActivity } from '../session-activity.js';
import type { SessionsRepo } from '../storage/sessions.js';
import type { HandoffsRepo } from '../storage/handoffs.js';
import { WORKSPACE_FILE_TOOL } from '../tool-routing.js';
import { isSessionId } from '../util/token.js';

interface ActivityDeps {
  sessionActivity?: SessionActivity;
  sessions: Pick<SessionsRepo, 'byCredential'>;
  handoffs?: Pick<HandoffsRepo, 'pendingId' | 'consume'>;
  log?: (line: string) => void;
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Only actual work can consume pending context; reference and status reads cannot. */
function isWork(name: string, input: unknown): boolean {
  const command = object(input)?.command;
  if (name === WORKSPACE_FILE_TOOL || name === 'exec' || name === 'context_search') return true;
  if (name === 'todo') return command === 'write' || command === 'patch';
  if (name === 'process') return command === 'start' || command === 'stop';
  return name === 'proxy' && command === 'call';
}

function succeeded(name: string, input: unknown, value: unknown): boolean {
  const result = object(value), payload = object(result?.structuredContent);
  if (!result || result.isError === true || !payload) return false;
  // Exec deliberately reports timeout/nonzero exit as protocol success.
  if (name === 'exec') return payload.exit_code === 0 && payload.timed_out !== true && payload.command_started !== false;
  if (name === WORKSPACE_FILE_TOOL || name === 'context_search') return object(payload.result)?.isError === false;
  if (name === 'process') {
    if (payload.status !== 'ok' || payload.command_started === false) return false;
    return object(input)?.command === 'stop' ? payload.state === 'exited'
      : payload.state === 'running' || (payload.state === 'exited' && payload.exitCode === 0);
  }
  return payload.status === 'ok'; // todo write/patch and proxy call
}

/** Wrap validated SDK handlers only: discovery/handshakes/control polling never count. */
export function activityToolRegistrar(server: McpServer, deps: ActivityDeps): McpServer['registerTool'] {
  const register: McpServer['registerTool'] = (name, config, callback) => {
    // Preserve the SDK's conditional (args, extra)/(extra) callback signature.
    // Neither arguments, result, errors nor cancellation signals are transformed.
    const tracked = (async (...args: Parameters<typeof callback>) => {
      const input = config.inputSchema ? args[0] : undefined;
      const sid = object(input)?.sessionId;
      const extra = (config.inputSchema ? args[1] : args[0]) as { signal?: AbortSignal } | undefined;
      let finish: (() => void) | undefined;
      let pending: { sessionId: string; id: string } | undefined;
      if ((deps.sessionActivity || deps.handoffs) && typeof sid === 'string' && isSessionId(sid)) {
        const row = deps.sessions.byCredential(sid);
        if (row?.status === 'active' && (row.expires_at == null || row.expires_at >= Date.now())) {
          finish = deps.sessionActivity?.begin(row.id);
          if (deps.handoffs && isWork(name, input)) {
            try {
              const id = deps.handoffs.pendingId(row.id);
              if (id) pending = { sessionId: row.id, id };
            } catch { deps.log?.('handoff: pending state could not be read; leaving it unchanged'); }
          }
        }
      }
      try {
        const result = await Reflect.apply(callback, undefined, args);
        if (pending && typeof sid === 'string' && !extra?.signal?.aborted && succeeded(name, input, result)) {
          // Rotation/revocation during work must not let an old credential consume.
          try {
            const current = deps.sessions.byCredential(sid);
            if (current?.id === pending.sessionId && current.status === 'active') {
              deps.handoffs?.consume(pending.sessionId, pending.id);
            }
          } catch { deps.log?.('handoff: cleanup failed; preserving the pending context for later work'); }
        }
        return result;
      } finally {
        // A transport abort is not completion: wait until the handler settles.
        finish?.();
      }
    }) as typeof callback;
    return server.registerTool(name, config, tracked);
  };
  return register;
}
