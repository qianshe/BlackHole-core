> **Public Core development repository.** Cloud backend and deployment secrets remain private and are not part of this repository. Source visibility and CI results do not constitute a Marketplace release or a completed security audit. Read [project status](MIGRATION-STATUS.md), [CI scope](.github/CI.md), [contribution guidelines](CONTRIBUTING.md), [security reporting](SECURITY.md), and [license scope](#license-scope).
>
> [![Core Runtime CI](https://github.com/qianshe/BlackHole-core/actions/workflows/vscode-extension.yml/badge.svg?branch=main)](https://github.com/qianshe/BlackHole-core/actions/workflows/vscode-extension.yml)
> The badge reports the default-branch workflow only; it does not validate uncommitted local code or certify every platform.

<div align="right">

**English** | [简体中文](README.zh-CN.md)

</div>

# BlackHole

**A local MCP bridge that gives Web Agents controlled access to your development workspace.**

BlackHole connects web-based AI agents to a local daemon through MCP Streamable HTTP. Agents can inspect files, edit code and run tools in a selected workspace, while you manage sessions, permissions, approvals and activity from VS Code.

```text
Web Agent / compatible MCP host
        ↕ MCP Streamable HTTP
Public channel you configure
        ↓
BlackHole daemon (loopback listener)
        ↓
Selected workspace, shell and configured MCP upstreams
```

The [VS Code extension](packages/vscode/README.md) is the recommended user-facing entry point. This README also covers the architecture and source-development workflow. See [License scope](#license-scope) before assuming that one license covers the entire repository.

## Get started

1. Open VS Code **Extensions**, search for **BlackHole**, and select publisher **qianshe** (`qianshe.blackhole-vscode`).
2. Open a local workspace, open the BlackHole sidebar and sign in through the system browser.
3. Create a workspace session and review its permission mode. In a multi-root workspace, select the folder to bind to the session.
4. In Settings → Public Channel → Cloudflare, click **One-click initialization**, choose **Save and restart**, then **Start Temporary**. Skip installation if a working path is already configured. See the [guide](https://blackhole.stellarbridge.dpdns.org/en/faq#required-config) for other connection options.
5. Connect a compatible agent and review tool activity and approvals in VS Code.

For detailed installation, settings and troubleshooting, use the [extension usage guide](packages/vscode/README.md). End users do not need a separate Node.js installation; the extension uses VS Code's runtime to launch its bundled daemon.

## Capabilities

- **Local tools:** work with the real project, shell and dependencies on your machine.
- **Workspace sessions:** choose a workspace and permission mode, then pause, resume, revoke or rotate access.
- **Activity and approvals:** inspect tool calls, results, tasks and operations awaiting approval.
- **Public channels:** use a temporary or persistent Cloudflare tunnel, or your own HTTPS endpoint.
- **MCP upstreams:** expose configured third-party tools behind one stable `proxy` interface.
- **Skills and optional semantic search:** provide reusable instructions and opt in to external code search.
- **Plans and handoffs:** save a plan, execute it, and use Handoff to continue in a new conversation. See [daily work](https://blackhole.stellarbridge.dpdns.org/en/faq#planning-workflows).
- **MCP Apps:** show session progress in compatible hosts; ordinary MCP tools remain usable without this panel support.

## Accounts and subscriptions

Account and subscription management takes place in the extension. New accounts receive a **3-day trial**, starting at the original registration time; signing in again does not reset it.

When purchasing is available, users can buy additional time through Alipay, inspect purchase history and redeem subscription cards. Time purchases are one-time payments, **not automatic renewals**. Confirm the account, duration and amount displayed by the extension before payment.

Refunds are requested for a selected order with an explicit amount preview. Ordinary refunds cover eligible unused paid time from that order, not free trial or gifted time. A verified late payment that has not delivered entitlement has a separate refund path. If a result is unknown, check the same order rather than paying again or creating another refund.

Availability and prices are controlled by the service. See [pricing](https://blackhole.stellarbridge.dpdns.org/pricing), [refund terms](https://blackhole.stellarbridge.dpdns.org/terms#refunds), [privacy](https://blackhole.stellarbridge.dpdns.org/privacy) and [terms](https://blackhole.stellarbridge.dpdns.org/terms).

## Connections and channels

BlackHole does not automatically expose a local daemon publicly. Start or configure a public channel only when needed.

- **Connector workflow:** configure BlackHole in a compatible host, then copy the session prompt.
- **Direct workflow:** provide the generated MCP connection to an agent environment with public network access.
- **Persistent Cloudflare channel:** use a locally managed named tunnel and a fixed public URL.
- **Temporary Cloudflare channel:** use a quick tunnel for testing. Quick tunnels do not support SSE; choose a persistent channel when the host requires it.
- **Custom channel:** maintain your own public HTTPS endpoint and set its base URL. BlackHole does not manage the external service for you.

`cloudflared` is not bundled with the extension. In **Settings → Public Channel → Cloudflare**, use **One-click initialization** to verify an existing PATH entry or explicitly download the pinned build into BlackHole's private user directory and fill the editable path field. You can also install it yourself and enter the full executable path. BlackHole never downloads it silently, and initialization never starts a public channel. See the [channel setup guide](https://blackhole.stellarbridge.dpdns.org/#channels). After manually changing PATH, restart VS Code and any already-running daemon.

The machine-level MCP URL stays stable when a session key is rotated; the old session key is invalidated. **Treat connection URLs, session keys and generated prompts as credentials**, and share them only with agents you intend to authorize.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `exec` | Run a finite command and wait for its result. Tool metadata declares the daemon-selected shell syntax and state semantics for the current operating system. |
| `process` | Manage independent background processes with `start/list/status/stop`, bounded output and exit results by ID, and a separate integrated-terminal view per process. |
| `editor` | View, create, edit, insert or delete workspace files with path-boundary checks. |
| `guide` | Provide operating rules and admitted project instructions; no skill catalog. |
| `todo` | Persist the Task Contract and step progress so substantial work can recover after context loss. |
| `skill` | Read project or user skill instructions and referenced resources. |
| `show` | Display a session panel in a host supporting MCP Apps. |
| `context_search` — optional | Search code semantically through Devin Fast Context when usable credentials are configured. |
| `proxy` | Discover and call tools from configured MCP upstreams without merging them into BlackHole's host tool list. |

### Project and personal skills

Put each skill in its own directory containing `SKILL.md`:

- **Project:** `<session-workspace>/.agents/skills/<name>/SKILL.md`.
- **Personal default:** `~/.agents/skills/<name>/SKILL.md`, under the daemon user's home.
- **Custom library:** set `blackhole.skillsDir` in VS Code, or `BLACKHOLE_SKILLS_DIR` for a directly launched daemon. It replaces the personal default, even when missing; project skills remain enabled. Clearing the VS Code setting restores default discovery and clears inherited overrides for that launch. Custom paths support `~/` and `~\` home notation.

Each admitted session merges its project library with the selected user-level library (custom **or** default, never an implicit third source). Same-name project folders win; distinct names from both libraries remain available. Names are callable folder identifiers, not frontmatter display titles, and follow the actual filesystem's case rules. References stay in the selected skill root and never fall back to another library. Relative custom paths are resolved against the daemon launch directory, not the session workspace; prefer absolute paths or home notation.

Use `skill` without a name to discover the catalog, then supply a name and optional relative path to read a document or reference. `guide` neither returns a skill catalog nor scans skill libraries. Read-only `guide` requests include the admitted session root's `AGENTS.md` (or `agents.md` when the uppercase file is absent). Parent directories are not searched. Missing instructions are optional; unsafe, oversized or unreadable instructions are reported instead of silently omitted. Handoff save receipts are unchanged.

Missing library directories contribute no skills and are not automatically created. A library path that is a file, broken link, unreadable or outside its project boundary produces an error, not a healthy empty catalog. Invalid selected skill directories are excluded from `skills` and reported in `issues`; they still shadow lower same-name versions. A zero count with issues is a configuration problem. `complete` on a catalog means discovery finished, not that every entry is healthy. The settings page is only a directory-structure preview, not the session's usable-skill count.

Project skills and instructions cannot follow links outside the workspace. Loading them grants no extra permissions and never executes scripts. Automatic project/default discovery requires a valid session. Without one, only an explicit custom library retains keyless access; the default library is not implicitly scanned or exposed through error hints. Do not put credentials in a keyless library.

Run `pnpm test:skills`, `pnpm test:guide-workflows` and `pnpm verify:prompts` for these contracts. The dedicated native CI matrix covers Windows, Linux and macOS on x64 and ARM64, checks the actual test-runtime architecture, and requires file-symlink boundary tests rather than accepting permission-based skips.

### Background development processes

Use `process start` for explicit dev servers/watch tasks and the finite-command tool for one-shot tests, builds and Git. Save `processId`, inspect bounded stdout/stderr and exit results through `status`, then verify the actual endpoint. After a lost response, check `list/status` and reuse the same `requestId` and arguments for the same launch intention; do not blindly spawn again.

Each matching workspace process gets its own read-only VS Code integrated terminal. Closing the terminal view requests stopping that task; Ctrl+C does the same without closing the view. The command palette offers **BlackHole: 显示后台进程** (show), **停止后台进程** (stop and retain final logs), and **停止并关闭后台进程** (close only after cleanup is confirmed). Unconfirmed cleanup keeps the terminal visible for diagnosis. `terminal.state=open` requires a real VS Code acknowledgement. Request `guide(tool="process")` only when extra details are needed; the default guide stays brief.

Local Windows, macOS and Linux share this terminal view; the daemon selects the execution environment. Windows finite commands retain the existing PowerShell session. macOS/Linux currently use Bash with cwd-only persistence; variables and functions do not carry over. Background tasks always run independently. Restricted Linux execution needs working bubblewrap; restricted macOS execution needs the system sandbox. Windows and Linux execution have been tested; native macOS process/terminal acceptance remains pending. The terminal bridge is not enabled in Remote SSH, WSL or container windows.

### MCP upstream routing

Configure upstreams through **MCP Proxies** in the extension's settings. The agent-facing interface is:

```text
proxy(sessionId, command = list | explain | call | cancel, tool?, argsJson?, optionsJson?)
```

`list` exposes the global tool registry. `explain` and `call` use the visible tool name; BlackHole resolves the MCP server internally. Aliases determine visible names. Duplicate names from enabled upstreams become conflicts until resolved by the operator; BlackHole does not silently pick a server or invent a prefix.

Upstream calls do **not** use BlackHole's shell approval gate. Explicit deny policies, cancellation, timeouts, redaction and configured profile restrictions still apply. The optional browser profile is not a general browser sandbox. A browser MCP such as `chrome-devtools-mcp` must be installed and configured separately.

### MCP Apps panel

On compatible hosts, `show` displays task progress, tool activity and pending approvals. It uses the resource URI `ui://blackhole/panel.html`; a new panel capability invalidates the previous one for that session. Hosts without MCP Apps support can continue using the normal tools.

## Security boundaries

Permissions and individual approval decisions are separate controls:

| Mode | Boundary |
| --- | --- |
| `read-only` | Does not grant file-write access through the workspace editor or restricted shell. |
| `workspace-write` — default | Allows writes in the selected workspace, explicitly authorized directories and a private temporary directory; higher-risk operations can require approval. |
| `danger-full-access` | Explicitly removes shell write confinement. It is not a workaround for a missing sandbox backend. |

`editor` checks paths, including traversal and symlink/realpath escapes. Restricted shell execution uses a Windows write-restricted token, Linux bubblewrap or macOS Seatbelt. If a required runner cannot initialize, the command is refused rather than executed unconfined. Approval does not itself remove the OS write boundary.

These mechanisms restrict **file writes**, not all file reads, network traffic or host-service interactions. Windows restrictions have limitations involving Everyone-writable objects and hard links. Configured MCP upstreams run with their own host/service permissions and are not automatically contained by the session shell sandbox.

**Do not treat these controls as isolation for arbitrary hostile software.** Use a disposable VM/container for untrusted code, enable only trusted upstreams and keep backups.

## Privacy and external data flow

- Workspace files and tool execution are handled by the local daemon. An authorized Web Agent can receive requested file content and tool results through the configured connection.
- Shell commands and MCP upstreams may communicate with other services. Their permissions and privacy terms still matter.
- Optional semantic search sends the necessary paths and code excerpts to Devin Fast Context. The default credential policy requires explicit configuration; discovering local Devin/Windsurf credentials is opt-in.
- BlackHole Cloud handles login, subscription checks, card redemption and payment/refund operations. Those operations do not upload workspace files by themselves.
- Authentication data is local to the user's machine. Keep credentials and runtime data out of source commits, build artifacts and support attachments. See [security guidance](SECURITY.md) for reporting and disclosure rules.

Do not post connection URLs, keys, tokens, cookies, card codes or sensitive workspace content in public issue reports.

## Requirements and platform scope

- Extension users need **VS Code desktop 1.107.0 or newer**. A separate Node.js installation is not required for the bundled daemon.
- The supported workflow uses local workspace folders. Select a folder for multi-root sessions. Remote SSH/WSL/container extension hosts and VS Code for the Web are outside this scope.
- The universal VSIX includes the Windows x64 sandbox runtime but no tunnel binary. Windows ARM and 32-bit native execution are not supported.
- Linux restricted commands require `/usr/bin/bwrap` and usable user namespaces. macOS restricted commands require `/usr/bin/sandbox-exec`.
- A universal package does not mean every Linux/macOS distribution, OS version and architecture has passed release acceptance. Missing sandbox backends fail closed.

## Source development

Use the Node.js version pinned in [Core CI](.github/workflows/vscode-extension.yml) and the pnpm version declared in `package.json`. These tools are for source development; the installed VS Code extension uses its bundled runtime.

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
```

Start the local daemon:

```bash
pnpm start
```

The default listener is `127.0.0.1:7306`. Source builds do not bypass account, entitlement or permission checks.

Core builds independently of the private Cloud repository. The production client profile is [src/environments/production.json](src/environments/production.json). Test builds use an explicit origin/public-key pair or a local `config/environments/test.json`; offline fixtures cannot be packaged for installation. See [release validation](RELEASE-VALIDATION.md) for configuration precedence and artifact checks.

Create the intended package explicitly:

```bash
pnpm package:vsix:production  # Official service
pnpm package:vsix:test        # Requires an independent test service profile
```

Packaging produces a universal VSIX without `cloudflared`. It does not install the extension, bump its version, restart a daemon, publish a release or deploy Cloud. Source configuration is editable; the selected endpoint and verification key are fixed when the artifact is built.

### CLI reference

| Command | Purpose |
| --- | --- |
| `serve [--port N] [--db PATH]` | Run the daemon. |
| `create <workspace> [--mode read-only\|workspace-write\|danger-full-access] [--name <task>] [--copy url\|prompt]` | Create a workspace session. |
| `ls / show <id>` | List or inspect sessions. |
| `pause \| resume \| revoke \| rotate <id>` | Manage access and session lifecycle. |
| `events <id> / calls <id>` | Inspect events and tool calls. |
| `confirmations / approve \| deny <id>` | Inspect and decide pending approvals. |
| `tunnel` | Inspect public-channel status. |

For example, after configuring the local service:

```bash
node dist/cli.js create D:/path/to/project --copy prompt
node dist/cli.js tunnel

# Set BLACKHOLE_PUBLIC_URL to your fixed HTTPS URL before starting a named tunnel.
node dist/cli.js tunnel start named

# Temporary testing channel; stop the active channel when finished.
node dist/cli.js tunnel start quick
node dist/cli.js tunnel stop
```

Use the extension's settings for everyday configuration and credential entry. The default port is `7306`; `BLACKHOLE_PUBLIC_URL` and `BLACKHOLE_CLOUDFLARED` configure the public URL and tunnel executable for the daemon. The extension's `blackhole.publicBaseUrl` and `blackhole.cloudflaredPath` expose the corresponding user-facing choices.

### Verification

```bash
pnpm build
pnpm test:pack        # Windows-oriented full gate
pnpm test:posix       # Cross-platform subset
pnpm test:build-flavor
pnpm test:contracts
```

The full gate includes a Windows-only behavioral smoke suite. The POSIX subset does not replace real OS/architecture acceptance. Live-tunnel, real-browser and external semantic-service checks are separate, environment-dependent tests; do not interpret a local unit-test pass as a real payment or production-deployment acceptance result.

Start with [CONTRIBUTING.md](CONTRIBUTING.md) for development, [.github/CI.md](.github/CI.md) for automated checks, and [RELEASE-VALIDATION.md](RELEASE-VALIDATION.md) for release acceptance. Private maintainer notes and migration archives are not part of this repository.

## Community & Feedback

Join the **[QQ group](https://qm.qq.com/q/k2BaemO1Es)** or **[Telegram group](https://t.me/+Wj0geSQ71qcyYzc1)** to discuss BlackHole, share usage experiences and get help from the community.

Use **[GitHub Issues](https://github.com/qianshe/BlackHole-core/issues)** for trackable bugs and feature requests. Include the installed BlackHole version, VS Code version, OS/architecture and reproduction steps. Share only minimal, **redacted** logs; never post connection credentials, session keys, tokens, cookies, card codes or sensitive workspace content in a group or issue report.

See the [extension changelog](packages/vscode/CHANGELOG.md) for versioned updates.

## License scope

The source under `packages/vscode` is licensed under **Apache-2.0**, except separately identified third-party components. Read its [LICENSE](packages/vscode/LICENSE), [NOTICE](packages/vscode/NOTICE) and [third-party notices](packages/vscode/THIRD_PARTY_NOTICES.md).

That license does not grant a license to components outside `packages/vscode`, including BlackHole cloud services, payment/account/subscription backends and deployment configuration. Do not assume one open-source license applies to the whole repository or hosted service. Bundled components retain their own applicable terms.
