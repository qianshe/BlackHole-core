#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { DEFAULT_DB_PATH, DEFAULT_PORT, PERMISSION_MODES, type PermissionMode } from './config.js';
import { EntitlementGate } from './cloud/entitlement-gate.js';
import { ENTITLEMENT_SPKI, ENTITLEMENT_ORIGIN } from './cloud/entitlement-public-key.js';
import { startDaemon } from './daemon.js';
import { waitForPredecessor } from './util/self-restart.js';
import { STALE_MS } from './tunnel/watchdog.js';
import { VERSION } from './version.js';
import { buildConnectorPrompt } from './prompt.js';

interface ParsedArgs {
  flags: Record<string, string | boolean>;
  positional: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else if (i + 1 < argv.length && !argv[i + 1]?.startsWith('--')) {
        flags[arg.slice(2)] = argv[i + 1] as string;
        i++;
      } else {
        flags[arg.slice(2)] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

const str = (flags: Record<string, string | boolean>, key: string): string | undefined => {
  const v = flags[key];
  return typeof v === 'string' ? v : undefined;
};

const daemonPort = (): number => Number(process.env.BLACKHOLE_PORT ?? 7306);

async function api(port: number, method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', host: `127.0.0.1:${port}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

function print(json: unknown): void {
  process.stdout.write(`${JSON.stringify(json, null, 2)}\n`);
}

function fail(json: unknown): never {
  const msg = (json as { error?: string })?.error ?? JSON.stringify(json);
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

function copyToClipboard(text: string): void {
  try {
    if (process.platform === 'win32') {
      const child = spawn('clip', [], { stdio: 'pipe', shell: false });
      child.stdin?.end(text);
    } else if (process.platform === 'darwin') {
      const child = spawn('pbcopy', [], { stdio: 'pipe' });
      child.stdin?.end(text);
    } else {
      const child = spawn('wl-copy', [], { stdio: 'pipe', shell: false });
      child.stdin?.end(text);
    }
  } catch {
    /* clipboard is a nicety, not a requirement */
  }
}

const HELP = `blackhole ${VERSION} — expose a local workspace to remote AI agents over MCP

Usage:
  blackhole serve [--port N] [--tunnel auto|off] [--db PATH]
      Start the daemon (foreground). Tunnel: auto uses cloudflared if available.
  blackhole create <workspace> [--mode read-only|workspace-write|danger-full-access] [--name <task>] [--expires-in-s N] [--copy url|prompt]
      Create a session, print (and optionally copy) the machine MCP URL and
      this session's current session ID.
  blackhole ls                                    List sessions.
  blackhole show <session-id>                     Show one session.
  blackhole pause|resume|revoke|rotate <id>       Lifecycle actions; rotate replaces the session id (the session itself continues).
  blackhole events <id> [--after N] [--limit N]   Read the session event log.
  blackhole calls <id>                            Recent tool calls and their status.
  blackhole confirmations [--session <id>]        Pending high-risk command approvals.
  blackhole approve|deny <confirmation-id>        Resolve a pending confirmation; the blocked call then runs or returns denied.
  blackhole semantic [<KEY>|clear]              Show / store / drop the context_search credential (restart to apply).
  blackhole tunnel [start [quick|named] | stop]
      Public channel status; start/stop on demand (named needs BLACKHOLE_PUBLIC_URL + creds).
  blackhole help                                  This text.

Environment:
  BLACKHOLE_PORT (${DEFAULT_PORT}), BLACKHOLE_DB (${DEFAULT_DB_PATH}),
  BLACKHOLE_TUNNEL (auto: quick tunnel allowed on demand), BLACKHOLE_TUNNEL_NAME (blackhole),
  BLACKHOLE_CLOUDFLARED, BLACKHOLE_PUBLIC_URL, BLACKHOLE_BASH, BLACKHOLE_EXEC_TIMEOUT_MS,
  BLACKHOLE_GIT_USR_BIN (prepended to the shell PATH: GNU grep/sed/awk/find)
  BLACKHOLE_SEMANTIC (off|explicit|auto, default explicit), BLACKHOLE_SEMANTIC_KEY,
  BLACKHOLE_SEMANTIC_TIMEOUT_MS (120000), BLACKHOLE_SEMANTIC_RG, BH_SEMANTIC_* (see README)

Security notes:
  - The MCP URL is machine-level and stable; every session shares it. Agents
    pass a per-session numeric id as the sessionId argument on every tool call —
    the pair grants shell access to that session's workspace. Treat both like passwords.
  - revoke kills the session id immediately; rotate replaces it with a fresh
    number (the session itself and the connector URL stay the same).
  - The daemon listens on 127.0.0.1 only; public access goes through the tunnel.
`;

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;
  const { flags, positional } = parseArgs(rest ?? []);
  const port = Number(str(flags, 'port') ?? process.env.BLACKHOLE_PORT ?? 7306);

  switch (command) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP);
      return;

    case 'version':
    case '--version':
    case '-v':
      process.stdout.write(`${VERSION}\n`);
      return;

    case 'serve': {
      // A self-restart replacement waits until the previous daemon released the port.
      await waitForPredecessor();
      const daemon = await startDaemon(
        {
          port,
          tunnel: flags.tunnel === 'off' ? 'off' : flags.tunnel === 'auto' ? 'auto' : undefined,
          dbPath: str(flags, 'db'),
        },
        (line) => process.stderr.write(`${line}\n`),
        new EntitlementGate(ENTITLEMENT_SPKI, ENTITLEMENT_ORIGIN),
      );
      const shutdown = (signal: string): void => {
        process.stderr.write(`\n${signal} received, shutting down...\n`);
        void daemon.stop().then(
          () => process.exit(0),
          () => process.exit(1),
        );
      };
      process.once('SIGINT', () => shutdown('SIGINT'));
      process.once('SIGTERM', () => shutdown('SIGTERM'));
      return;
    }

    case 'create': {
      const workspace = positional[0];
      if (!workspace) {
        process.stderr.write('usage: blackhole create <workspace> [--mode read-only|workspace-write|danger-full-access] [--name <task>] [--expires-in-s N] [--copy url|prompt]\n');
        process.exit(2);
      }
      const mode = (str(flags, 'mode') ?? 'workspace-write') as PermissionMode;
      if (!PERMISSION_MODES.includes(mode)) {
        fail({ error: `--mode must be one of ${PERMISSION_MODES.join(', ')}` });
      }
      const expiresInS = Number(str(flags, 'expires-in-s') ?? 0) || undefined;
      const name = str(flags, 'name');
      const { status, json } = await api(port, 'POST', '/sessions', {
        workspace_path: workspace,
        permission_mode: mode,
        expires_in_s: expiresInS,
        ...(name ? { name } : {}),
      });
      if (status >= 400) fail(json);
      const session = json as { mcp_url?: string; session_id?: string; id?: string; workspace_path?: string; name?: string | null };
      const output = { ...session, connector_prompt: buildConnectorPrompt(session) };
      if (flags.copy) {
        const what = flags.copy === 'prompt' ? output.connector_prompt : output.mcp_url;
        if (typeof what === 'string') copyToClipboard(what);
      }
      print(output);
      return;
    }

    case 'ls': {
      const { status, json } = await api(port, 'GET', '/sessions');
      if (status >= 400) fail(json);
      print(json);
      return;
    }

    case 'show': {
      const id = positional[0];
      if (!id) process.exit(2);
      const { status, json } = await api(port, 'GET', `/sessions/${id}`);
      if (status >= 400) fail(json);
      print(json);
      return;
    }

    case 'pause':
    case 'resume':
    case 'revoke':
    case 'rotate': {
      const id = positional[0];
      if (!id) process.exit(2);
      const { status, json } = await api(port, 'POST', `/sessions/${id}/${command}`);
      if (status >= 400) fail(json);
      print(json);
      return;
    }

    case 'events': {
      const id = positional[0];
      if (!id) process.exit(2);
      const after = Number(str(flags, 'after') ?? 0) || 0;
      const limit = Number(str(flags, 'limit') ?? 200) || 200;
      const { status, json } = await api(port, 'GET', `/sessions/${id}/events?after=${after}&limit=${limit}`);
      if (status >= 400) fail(json);
      print(json);
      return;
    }

    case 'calls': {
      const id = positional[0];
      if (!id) process.exit(2);
      const { status, json } = await api(port, 'GET', `/sessions/${id}/calls`);
      if (status >= 400) fail(json);
      print(json);
      return;
    }

    case 'confirmations': {
      const session = str(flags, 'session');
      const qs = session ? `?session_id=${encodeURIComponent(session)}` : '';
      const { status, json } = await api(port, 'GET', `/confirmations${qs}`);
      if (status >= 400) fail(json);
      print(json);
      return;
    }

    case 'approve':
    case 'deny': {
      const id = positional[0];
      if (!id) process.exit(2);
      const { status, json } = await api(port, 'POST', `/confirmations/${id}/${command}`);
      if (status >= 400) fail(json);
      print(json);
      return;
    }

    case 'semantic': {
      // Show / store / drop the context_search credential, and say what the
      // daemon registered at boot — the tool list cannot change underneath a
      // connected client, so a fresh key needs a restart.
      const value = positional[0];
      if (value === 'clear') {
        const { status, json } = await api(port, 'POST', '/semantic/clear', {});
        if (status >= 400) fail(json);
        print(json);
        return;
      }
      if (typeof value === 'string' && value !== '') {
        const { status, json } = await api(port, 'POST', '/semantic/key', { key: value });
        if (status >= 400) fail(json);
        print(json);
        return;
      }
      const { status, json } = await api(port, 'GET', '/semantic');
      if (status >= 400) fail(json);
      print(json);
      return;
    }

    case 'tunnel': {
      const sub = positional[0];
      if (sub === 'start') {
        const mode = positional[1] === 'named' ? { mode: 'named' } : { mode: 'quick' };
        const { status, json } = await api(port, 'POST', '/tunnel/start', mode);
        if (status >= 400) fail(json);
        // the channel auto-closes after the stale-heartbeat window; the VS Code
        // extension renews it automatically — a CLI-only channel keeps itself
        // alive only while this note is read (one heartbeat was sent above).
        print(json);
        process.stderr.write(`note: channel auto-closes after ~${Math.round(STALE_MS / 1000)}s without a heartbeat (VS Code renews it; CLI sessions are one-shot by design)\n`);
        return;
      }
      if (sub === 'stop') {
        const { status, json } = await api(port, 'POST', '/tunnel/stop', {});
        if (status >= 400) fail(json);
        print(json);
        return;
      }
      const { status, json } = await api(port, 'GET', '/tunnel');
      if (status >= 400) fail(json);
      print(json);
      return;
    }

    default:
      process.stderr.write(`unknown command "${command}" — try 'blackhole help'\n`);
      process.exit(2);
  }
}

void main().catch((e) => {
  process.stderr.write(`error: ${e instanceof Error ? e.message : e}\n`);
  process.exit(1);
});
