/** Native loopback process bridge DTOs. No launch/script/PID-kill endpoint exists. */
export interface ProcessViewItem {
  processId: string; sessionId: string; daemonId: string; requestId: string; name: string;
  workspace: string; cwd: string; state: 'starting' | 'running' | 'stopping' | 'exited' | 'failed' | 'unknown';
  pid: number | null; startedAt: string; endedAt: string | null; exitCode: number | null; signal: string | null; reason: string | null;
  terminal: { state: 'pending' | 'open' | 'closed' | 'unavailable'; reason?: string };
  owned: boolean; closeTerminal?: boolean;
  output: { events: { seq: number; stream: 'stdout' | 'stderr'; text: string }[]; next: number; gap: boolean };
}
export type TerminalAcknowledgement = { processId: string; state: ProcessViewItem['terminal']['state'] };
export interface ProcessSyncInput {
  clientId: string; daemonId?: string; workspaces: string[]; cursors: Record<string, number>;
  acknowledgements: TerminalAcknowledgement[]; reopen?: string;
}
export interface ProcessSyncResult { daemonId: string; supported: boolean; items: ProcessViewItem[] }
export interface ProcessStopInput { clientId: string; daemonId: string; workspaces: string[]; processId: string }
export interface ProcessTerminalApi {
  processSync(input: ProcessSyncInput): Promise<ProcessSyncResult>;
  processStop(input: ProcessStopInput): Promise<{ state: ProcessViewItem['state']; reason: string | null; exitCode: number | null }>;
}
