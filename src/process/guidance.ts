import { shellLabel, type ShellMetadata } from '../execution.js';

/** Discovery stays small; this supplement is returned only by guide(tool="process"). */
export const PROCESS_DESCRIPTION = 'Background dev servers/watch: start, list, status, stop. start returns processId; query status and verify readiness. Reuse requestId on retries.';
export function processDescription(shell?: ShellMetadata): string {
  return PROCESS_DESCRIPTION + (shell ? ` Shell: ${shellLabel(shell)}; independent per task.` : '');
}
export function processHelp(shell?: ShellMetadata): string {
  return [
    '# process',
    shell ? `Uses the VS Code/default managed shell: ${shellLabel(shell)}. Each task starts independently in the workspace (or explicit cwd).` : 'Each task uses the default managed shell independently; see script schema for syntax.',
    'start requires script and requestId. Keep the service in the foreground. Save processId; after a lost response use list, then retry the same requestId/arguments.',
    'status returns recent stdout/stderr, exitCode and terminal.state. running is not ready: verify the endpoint. Updates require querying; stderr can contain warnings.',
    'stop targets this processId and its owned task, never an arbitrary PID. Stop your tasks when done unless asked to keep them.',
    'runtime_asset_missing: packaged monitor absent. sandbox_runner_*: user code did not start. execution_policy_denied: a running command hit OS/sandbox policy.',
    'POSIX uses a supervised process group; stopping/unknown is unconfirmed. Windows uses a Job Object.',
    'VS Code terminals are read-only views; closing one or Ctrl+C stops that task.',
  ].join('\n');
}
