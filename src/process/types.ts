import type { PermissionMode } from '../config.js';

export type ProcessState = 'starting' | 'running' | 'stopping' | 'exited' | 'failed' | 'unknown';
export type TerminalState = 'pending' | 'open' | 'closed' | 'unavailable';
export interface ProcessOwner {
  sessionId: string;
  workspace: string;
  mode: PermissionMode;
  writableDirs: readonly string[];
}
export interface StartInput { requestId: string; script: string; name?: string; cwd?: string }
export interface ProcessSpec extends ProcessOwner {
  processId: string;
  requestId: string;
  script: string;
  name: string;
  cwd: string;
}
export interface OutputEvent { seq: number; stream: 'stdout' | 'stderr'; text: string }
export interface ProcessSummary {
  processId: string;
  daemonId: string;
  requestId: string;
  name: string;
  cwd: string;
  state: ProcessState;
  pid: number | null;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  signal: string | null;
  reason: string | null;
  terminal: { state: TerminalState; reason?: string };
}
export interface ProcessSnapshot extends ProcessSummary {
  output: { stdout: string; stderr: string; truncated: boolean; version: number };
}
export interface ProcessExit { exitCode: number | null; signal?: string | null; reason?: string | null; cleanupConfirmed: boolean }
export interface BackendCallbacks {
  output(stream: 'stdout' | 'stderr', data: Buffer): void;
  exit(result: ProcessExit): void;
  fault(message: string): void;
}
export interface ProcessHandle { pid: number; ready?: Promise<void>; stop(): Promise<void> }
export type ProcessBackend = (spec: ProcessSpec, callbacks: BackendCallbacks) => ProcessHandle;
export class ProcessError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'ProcessError'; }
}
export const PROCESS_LIMITS = Object.freeze({
  sessionRunning: 4,
  running: 16,
  sessionRecords: 64,
  records: 256,
  sessionHistory: 32,
  history: 128,
  historyRetentionMs: 24 * 60 * 60 * 1000,
  // Accepted requestIds are never forgotten during this daemon/session lifetime.
  // These high hard caps bound memory; reaching them rejects a NEW intention
  // instead of deleting an old key and risking duplicate execution.
  sessionRequestHistory: 4096,
  requestHistory: 16384,
});
export const isTerminalState = (state: ProcessState): boolean => state === 'exited' || state === 'failed';
