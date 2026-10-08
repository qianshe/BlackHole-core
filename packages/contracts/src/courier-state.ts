export type CourierTurnState = 'running' | 'done' | 'stopped';

/** Standalone: serialized into the VS Code webview as well as used by Web/mobile. */
export function courierGenerating(
  target: { busy?: boolean | null; turnState?: CourierTurnState | null } | null | undefined,
  messages: readonly { kind?: string; status?: string }[] = [],
): boolean {
  if (target?.turnState === 'running') return true;
  // A protocol terminal state describes generation, not whether the DOM editor is ready.
  // Do not rewrite stored partial text or pretend missing reply bytes were recovered.
  if (target?.turnState === 'done' || target?.turnState === 'stopped') return false;
  if (target?.busy) return true;
  // A historical streaming fragment must not lock every subsequent user turn.
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    if (m.kind === 'user' && m.status !== 'failed') break;
    if (m.status === 'streaming') return true;
  }
  return false;
}
