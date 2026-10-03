import { renderBootstrap } from './courier/prompt.js';

/** CLI adapter for the public control API response (session_id, not its internal row id). */
export function buildConnectorPrompt(session: { session_id?: string; name?: string | null }): string {
  if (typeof session.session_id !== 'string' || !session.session_id.trim()) {
    throw new Error('Cannot build a prompt: create response is missing session_id');
  }
  return renderBootstrap('connector', '', session.session_id);
}

/** Connection-local presentation hint, not a workspace authorization. */
export type StartupMode = 'script' | 'apps';

/** Connection-local startup guidance; Sandbox client discovery is a separate guide entry. */
export function buildStartupGuidance(mode: StartupMode = 'script'): string {
  return [
    '## STARTUP',
    ...(mode === 'apps'
      ? ['- When a live progress view would help, call `show` at most once after each new user message. The `show` call only opens BlackHole\'s progress panel; it does not read or modify workspace files, run commands, or approve actions.']
      : ['- Use the supplied connection for this session.']),
  ].join('\n');
}

export interface PromptCapabilities {
  execTool?: string | null;
  semantic: boolean;
  skills: boolean;
  todo: boolean;
}

/** High-signal execution loop; exceptional paths stay subordinate to the main loop. */
export function buildExecutionGuidance(capabilities: PromptCapabilities): string {
  return [
    '## EXECUTION',
    '**Inspect → Plan → Execute → Verify**',
    '- Inspect — prepare for the whole Goal before substantive changes: check relevant callers, contracts, tests, dependencies, failure paths, and how completion will be verified.',
    '- Plan — derive actions from the Goal, Non-Goal, and Success Criteria; avoid unnecessary work.',
    '- Execute — make the smallest change that satisfies the Goal; preserve unrelated user work. Continue through verification while safe, in-scope progress remains possible; do not stop at intermediate results.',
    '- Failure — preserve the exact error, diagnose the cause, and take the smallest evidence-producing recovery step. NEVER RETRY BLINDLY.',
    '- Verify — check actual results against the Goal and Success Criteria using fresh evidence.',
    ...(capabilities.todo
      ? ['- Recovery — after context loss, restore the Task Contract and active step from the user task or existing plan file; use `todo read` only to recover missing or stale state of a board already used for this task. Re-check workspace state before continuing.']
      : ['- Recovery — after context loss, restore the Task Contract and active step from the user task or existing plan file; re-check workspace state before continuing.']),
  ].join('\n');
}
