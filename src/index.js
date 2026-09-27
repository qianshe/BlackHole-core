import http from 'node:http';
import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { SessionStore } from './session.js';
import { ApprovalBroker } from './approval.js';
import { buildRules } from './rules.js';

const SHELL_TOOL = process.platform === 'win32' ? 'pwsh' : 'bash';

const SHELL_DESC =
  process.platform === 'win32'
    ? `Run commands in a PowerShell shell
* State is persistent across command calls: cwd and environment carry over.
* Use native Windows paths (C:\\...) and $env:NAME; this is PowerShell, not bash.
* Avoid commands that produce very large output.
* Run long-lived commands in the background.`
    : `Run commands in a bash shell
* State is persistent across command calls: cwd and environment carry over.
* To inspect a line range of a file, e.g. 'sed -n 10,25p /path/to/file'.
* Avoid commands that produce very large output.
* Run long-lived commands in the background, e.g. 'sleep 10 &'.`;

const EDITOR_DESC = `Workspace file tool for reading, creating and editing files at absolute paths inside the session workspace.
* Tool routing: use this tool for file inspection/editing; use the shell only for command execution.
* Shared path stays top-level; command plus command-specific fields live inside the strict operation object. Commands: view, create, str_replace, insert, delete. Only 'view' works on directories.
* view: shows contents with one-based line numbers. Optional view_range=[start,end] is inclusive; end=-1 means EOF; end beyond EOF is clamped; start beyond EOF is an error.
* create: writes content to a NEW file. It FAILS if the file already exists.
* str_replace: old_text must match EXACTLY ONE location; new_text replaces it. No replace_all.
* insert: adds content AFTER line (one-based); line=0 inserts before the first line.
* delete: removes ONE regular file inside the workspace (never directories).`;

function createMcpServer(session) {
  const rules = (session.rules ??= buildRules(session.workspacePath, SHELL_TOOL, session.shellMode, session.policy.mode));
  const server = new McpServer(
    { name: 'blackhole', version: '0.1.0' },
    { instructions: rules }
  );

  server.registerResource(
    'workspace_rules',
    'blackhole://rules',
    { title: 'Workspace Rules', description: 'The rules the remote agent MUST follow for this workspace', mimeType: 'text/markdown' },
    async (uri) => ({ contents: [{ uri: uri.href, text: rules }] })
  );

  server.registerPrompt(
    'blackhole_operator',
    { title: 'Start operating this workspace', description: 'Load the workspace rules before making any change' },
    () => ({ messages: [{ role: 'user', content: { type: 'text', text: `${rules}\n\nAcknowledge these rules, then start by viewing the workspace root and propose the first minimal, safe step.` } }] })
  );

  server.registerTool(
    SHELL_TOOL,
    {
      description: SHELL_DESC,
      inputSchema: { command: z.string(), timeoutMs: z.number().int().positive().max(600000).optional() },
      outputSchema: { stdout: z.string(), stderr: z.string(), exitCode: z.number() },
    },
    async ({ command, timeoutMs }) => {
      // Every path returns structuredContent matching outputSchema (clients
      // like ChatGPT connectors surface the schema to the model); the text
      // content stays for older clients (bh.py).
      const denied = (msg) => ({
        content: [{ type: 'text', text: msg }],
        structuredContent: { stdout: '', stderr: msg, exitCode: -1 },
        isError: true,
      });
      const verdict = session.policy.evaluateShell(command);
      if (verdict.action === 'deny') {
        return denied(`Blocked by policy [${session.policy.mode}]: ${verdict.reason}`);
      }
      if (verdict.action === 'review') {
        // Human-in-the-loop: the operator answers OUT-OF-BAND (daemon terminal),
        // never through this MCP connection. No channel configured -> fail closed.
        if (!session.approval) {
          return denied(`Command needs human approval (${verdict.category}: ${verdict.reason}) but no approval channel is configured. Denied.`);
        }
        let approved = false;
        try {
          approved = await session.approval.ask({ tool: SHELL_TOOL, category: verdict.category, reason: verdict.reason, command, workspace: session.workspacePath });
        } catch (e) {
          return denied(`Approval channel unavailable (denied): ${e.message}`);
        }
        if (!approved) {
          return denied(`Denied by operator (human review): ${verdict.category} — ${verdict.reason}. If the task genuinely requires this, ask the user in chat to approve it at the daemon terminal, then retry once.`);
        }
      }
      try {
        const r = await session.shell.run(command, timeoutMs);
        const text =
          (r.stdout || '') +
          (r.stderr ? `\n[stderr]\n${r.stderr}` : '') +
          (typeof r.exitCode === 'number' ? `\n[exit code: ${r.exitCode}]` : '');
        return {
          content: [{ type: 'text', text: text || '(no output)' }],
          structuredContent: { stdout: r.stdout || '', stderr: r.stderr || '', exitCode: typeof r.exitCode === 'number' ? r.exitCode : -1 },
        };
      } catch (e) {
        return denied(`Error: ${e.message}`);
      }
    }
  );

  server.registerTool(
    'editor',
    {
      description: EDITOR_DESC,
      inputSchema: z.object({
        path: z.string(),
        operation: z.discriminatedUnion('command', [
          z.object({ command: z.literal('view'), view_range: z.tuple([z.number().int().min(1), z.union([z.literal(-1), z.number().int().min(1)])]).optional() }).strict(),
          z.object({ command: z.literal('create'), content: z.string() }).strict(),
          z.object({ command: z.literal('str_replace'), old_text: z.string(), new_text: z.string() }).strict(),
          z.object({ command: z.literal('insert'), line: z.number().int().min(0), content: z.string() }).strict(),
          z.object({ command: z.literal('delete') }).strict(),
        ]),
      }).strict(),
      outputSchema: { result: z.string() },
    },
    async (args) => {
      try {
        const { path: p, operation } = args;
        if (operation.command !== 'view') {
          const v = session.policy.evaluateEditorWrite();
          if (v.action === 'deny') return err(`Blocked by policy [${session.policy.mode}]: ${v.reason}`);
        }
        switch (operation.command) {
          case 'view': return await session.editor.view(p, operation.view_range);
          case 'create': return await session.editor.create(p, operation.content);
          case 'str_replace': return await session.editor.strReplace(p, operation.old_text, operation.new_text);
          case 'insert': return await session.editor.insert(p, operation.line, operation.content);
          case 'delete': return await session.editor.delete(p);
          default: return err(`unknown command: ${operation.command}`);
        }
      } catch (e) {
        return err(e.message);
      }
    }
  );

  return server;
}

function err(msg) {
  return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true, structuredContent: { result: `Error: ${msg}` } };
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createApp(store) {
  /** @type {Map<string, StreamableHTTPServerTransport>} key = `${token}::${mcpSessionId}` */
  const transports = new Map();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    // CORS for browser-based MCP clients.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'content-type, mcp-session-id, mcp-protocol-version, authorization');
    res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        `<!doctype html><meta charset="utf-8"><title>blackhole</title>` +
        `<body style="font-family:ui-monospace,monospace;padding:2rem;line-height:1.6">` +
        `<h1>blackhole daemon</h1><p>sessions=${store.byToken.size}</p>` +
        `<p>CLI client for sites without an MCP connector: <a href="/bh.py">/bh.py</a></p>` +
        `<p>Machine probe: <a href="/health">/health</a></p></body>`
      );
      return;
    }

    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`blackhole daemon. sessions=${store.byToken.size}\n`);
      return;
    }

    // Zero-dependency CLI client for websites whose AI has a code sandbox but
    // no MCP connector: they fetch this and speak the MCP protocol themselves.
    if (url.pathname === '/bh.py') {
      try {
        const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'client', 'bh.py');
        const src = await fs.readFile(file, 'utf8');
        res.writeHead(200, { 'content-type': 'text/x-python; charset=utf-8' });
        res.end(src);
      } catch {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('client script missing');
      }
      return;
    }

    // Rules over plain HTTP (token-gated): clients that only expose TOOLS —
    // e.g. ChatGPT connectors, which cannot read MCP resources — can fetch the
    // rules with the shell tool itself (network is not gated by design).
    const rm = url.pathname.match(/^\/rules\/([A-Za-z0-9]+)\/?$/);
    if (rm) {
      const session = store.get(rm[1]);
      if (!session) { res.writeHead(403, { 'content-type': 'text/plain' }); res.end('invalid or revoked token'); return; }
      const rules = (session.rules ??= buildRules(session.workspacePath, SHELL_TOOL, session.shellMode, session.policy.mode));
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
      res.end(rules);
      return;
    }

    const m = url.pathname.match(/^\/mcp\/([A-Za-z0-9]+)$/);
    if (!m) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
    const token = m[1];

    const session = store.get(token);
    if (!session) { res.writeHead(403, { 'content-type': 'text/plain' }); res.end('invalid or revoked token'); return; }

    const sessionIdHeader = req.headers['mcp-session-id'];
    const key = `${token}::${sessionIdHeader}`;
    let transport = typeof sessionIdHeader === 'string' ? transports.get(key) : undefined;

    if (!transport) {
      if (req.method !== 'POST') {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('missing or invalid MCP session id'); return;
      }
      let body;
      try { body = await readJsonBody(req); } catch { res.writeHead(400); res.end('bad json'); return; }
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomBytes(8).toString('hex') });
      transport.onclose = () => { if (transport.sessionId) transports.delete(`${token}::${transport.sessionId}`); };
      const mcp = createMcpServer(session);
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
      if (transport.sessionId) transports.set(`${token}::${transport.sessionId}`, transport);
      return;
    }

    const body = req.method === 'POST' ? await readJsonBody(req) : undefined;
    await transport.handleRequest(req, res, body);
  });

  return server;
}

function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = process.env.BH_WORKSPACE ?? path.resolve(here, '..');
  const port = Number(process.env.BH_PORT ?? 3939);
  const shellMode = process.env.BH_SHELL === 'docker' ? 'docker' : 'host';
  const policyMode = process.env.BH_MODE ?? 'review';
  const approval = policyMode === 'review' ? new ApprovalBroker() : null;

  const store = new SessionStore({ defaultWorkspace: root, shellMode, policyMode, approval });

  // Multi-site: BH_TOKENS="tokA,tokB" gives each website its own token/session
  // (isolated shell state, individually revocable). BH_TOKEN remains the single alias.
  const tokens = [
    ...new Set(
      String(process.env.BH_TOKENS || process.env.BH_TOKEN || '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => /^[A-Za-z0-9]+$/.test(s))
    ),
  ];
  if (!tokens.length) tokens.push(randomBytes(12).toString('hex'));
  const sessions = tokens.map((t) => store.create({ token: t }));
  const session = sessions[0];

  const server = createApp(store);
  server.listen(port, '127.0.0.1', () => {
    console.log(`blackhole daemon listening on http://127.0.0.1:${port}`);
    console.log(`workspace : ${session.workspacePath}`);
    for (const s of sessions) console.log(`MCP URL   : http://127.0.0.1:${port}/mcp/${s.token}${sessions.length > 1 ? `  (token ${s.token})` : ''}`);
    console.log(`shell     : ${shellMode === 'docker' ? 'docker container (isolated: network=none, only workspace mounted)' : 'HOST pwsh — operates the real local project'}`);
    console.log(`policy    : ${session.policy.mode}${policyMode === 'review' ? ' — out-of-boundary commands (outside workspace / destructive / system-level) pause for HUMAN APPROVAL in this terminal' : ''}`);
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
