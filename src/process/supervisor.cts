import { spawn, type ChildProcess } from 'node:child_process';

// Private POSIX runtime sidecar, not an MCP endpoint. The daemon forks it as a
// new session/group leader. Holding that identity avoids killing a reused PGID.
interface Launch { type: 'start'; argv: string[]; cwd: string; env: Record<string, string> }
let task: ChildProcess | undefined;
let started = false, stopping = false, finishing = false;
let exitCode: number | null = null, signal: NodeJS.Signals | null = null;
let reason = 'command_exited';

function finish(group: boolean): void {
  if (finishing) return;
  finishing = true; stopping = true;
  const receipt = { type: 'result', exitCode, signal, reason, started, group };
  let ended = false;
  const end = () => {
    if (ended) return; ended = true;
    if (group) process.kill(-process.pid, 'SIGKILL');
    else process.exit(0);
  };
  // Send the root result before terminating our own group. The parent still
  // waits for close/EOF; receipt alone never means the task has stopped.
  const deadline = setTimeout(end, 100);
  if (process.connected) {
    try { process.send!(receipt, () => { clearTimeout(deadline); end(); }); }
    catch { clearTimeout(deadline); end(); }
  } else { clearTimeout(deadline); end(); }
}

function stop(why: string): void {
  if (stopping) return;
  stopping = true; reason = why;
  if (!task?.pid) { finish(false); return; }
  // The supervisor receives this signal too, but stopping prevents recursion.
  // The target must stay in the managed foreground; external service brokers
  // and deliberately escaping sessions are outside this tool's contract.
  try { process.kill(-process.pid, 'SIGTERM'); } catch { /* final group kill below */ }
  setTimeout(() => finish(true), 500);
}

process.on('SIGTERM', () => stop('stop_requested'));
process.on('SIGINT', () => stop('stop_requested'));
process.on('disconnect', () => stop('daemon_disconnected'));
process.on('error', () => stop('supervisor_error'));
process.stdout.on('error', () => { /* daemon may have exited; still clean up */ });
process.stderr.on('error', () => { /* never let a closed output pipe skip cleanup */ });
process.on('message', (raw: unknown) => {
  if (!raw || typeof raw !== 'object') return;
  const message = raw as Launch | { type: 'stop' };
  if (message.type === 'stop') { stop('stop_requested'); return; }
  if (message.type !== 'start' || task || stopping || !process.connected) return;
  if (!Array.isArray(message.argv) || !message.argv.length || message.argv.some(v => typeof v !== 'string') || typeof message.cwd !== 'string') {
    reason = 'spawn_failed'; finish(false); return;
  }
  try {
    // Do not inherit NODE_CHANNEL_FD or the daemon's control channel. Only the
    // three explicit standard streams reach the actual user command.
    task = spawn(message.argv[0]!, message.argv.slice(1), {
      cwd: message.cwd, env: message.env, detached: false, stdio: ['ignore', 'inherit', 'inherit'],
    });
    task.once('spawn', () => {
      started = true;
      if (stopping || !process.connected) { stop('daemon_disconnected'); return; }
      process.send?.({ type: 'started' });
    });
    task.once('error', error => {
      process.stderr.write(error.message + '\n'); exitCode = null;
      stop('spawn_failed');
    });
    task.once('exit', (code, sig) => {
      exitCode = code; signal = sig;
      stop(stopping ? reason : 'command_exited');
    });
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
    stop('spawn_failed');
  }
});

// No user code runs until the parent receives this receipt and sends a plan.
if (process.connected) process.send?.({ type: 'ready' });
else stop('daemon_disconnected');
