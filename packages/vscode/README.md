# BlackHole

**Let Web Agents work with your local project—while you control access from VS Code.**

BlackHole connects web-based AI agents to a local MCP daemon. Keep your real workspace, shell and development tools on your machine, with visible sessions, permissions and activity.

[Website](https://blackhole.stellarbridge.dpdns.org/) · [Full guide](https://blackhole.stellarbridge.dpdns.org/en/faq) · [简体中文](https://blackhole.stellarbridge.dpdns.org/faq)

- **Workspace sessions:** choose a project and permission mode; pause, resume, revoke or rotate access.
- **Agent connections:** copy a ready-to-use prompt or MCP connection for a compatible Web Agent.
- **Visible execution:** inspect tool calls, results, activity and pending approvals in VS Code.
- **Finite and background work:** `exec` waits for one-off command results; `process` tracks servers/watch tasks by ID in independent integrated terminals, with separate stop and stop-and-close actions.
- **Workspace editing and discovery:** `editor` reads and modifies workspace files with path-boundary checks; optional `context_search` locates unfamiliar code semantically.
- **Plans and handoffs:** save a plan, execute it, and use Handoff to continue in a new conversation. See [daily work](https://blackhole.stellarbridge.dpdns.org/en/faq#planning-workflows).
- **Your toolchain:** configure MCP upstreams and reusable skills, with optional semantic code search.

## Quick start

1. In VS Code **Extensions**, search for **BlackHole** by **qianshe** (`qianshe.blackhole-vscode`).
2. Open a **local workspace**, open the BlackHole sidebar and sign in through the system browser.
3. Create a session for the project and review its permission mode. For a multi-root workspace, select the folder the session should use.
4. In Settings → Public Channel → Cloudflare, click **One-click initialization**, choose **Save and restart**, then **Start Temporary**. Skip installation if a working path is already configured. See the [guide](https://blackhole.stellarbridge.dpdns.org/en/faq#required-config) for other connection options.
5. Copy the generated connection or prompt to your agent. Keep the session panel available to review activity and approve or deny operations when prompted.

Use a configured connector or an agent environment that can reach your public endpoint. Cloudflare quick tunnels are temporary and do not support SSE; choose a persistent named tunnel when the host needs SSE or a stable URL. BlackHole does not automatically expose the daemon publicly.

Open **Settings → BlackHole** for channel, Web Agent, skills and other options. Most defaults can stay unchanged. See the [connection guide](https://github.com/qianshe/BlackHole-core/blob/main/README.md#connections-and-channels) for details.

## Skills and project instructions

- Put project skills in `.agents/skills/<name>/SKILL.md`; personal skills default to `~/.agents/skills/<name>/SKILL.md`.
- Project folders override matching names. Setting `blackhole.skillsDir` replaces the personal default, even if the custom directory is missing; project skills remain enabled. Clear the setting to restore the default.
- With the supplied session ID, use `skill` without a name to discover the merged project + selected user library. `guide` does not list or scan skills; read-only guide requests include the project root's `AGENTS.md` (falling back to `agents.md`). Bodies and references load on demand through `skill`, without cross-library resource fallback.
- Missing directories are empty; unreadable, broken or non-directory library paths are errors. Invalid selected skills produce `issues` and still shadow lower matching names. A zero count with issues is not a healthy empty library. The settings count is only a structural preview, not the final session catalog.
- These reads do not run scripts or expand workspace permissions. Automatic discovery needs a valid session. Without one, only the explicit custom library is readable; the default library is not implicitly added. Keyless libraries must not contain credentials.
- The skill/guide contract CI covers Windows, Linux and macOS on x64 and ARM64. This reference-tool matrix does not extend the separate native execution support described below.

## Requirements

- **VS Code desktop 1.107.0 or newer.** The extension uses VS Code's runtime; no separate Node.js installation is needed.
- **Local workspace folders.** Remote SSH, WSL, container extension hosts and VS Code for the Web are outside the supported scope.
- **Windows x64** includes the native sandbox runtime. Windows ARM and 32-bit native execution are not supported.
- **Linux/macOS:** restricted commands require working `/usr/bin/bwrap` and user namespaces on Linux, or `/usr/bin/sandbox-exec` on macOS. A universal VSIX does not mean every OS/architecture has been release-tested.
- **Cloudflare channels:** `cloudflared` is not bundled. The Public Channel card can explicitly initialize the pinned build for the current OS/CPU, or reuse PATH/a manually entered full path. It never downloads silently or starts a channel during initialization. After manually changing PATH, restart VS Code and any already-running BlackHole daemon.

## Accounts and subscriptions

New accounts receive a **3-day trial**, starting at the original registration time—not each login. Manage your account, purchase history and subscription-card redemption inside the extension.

When purchasing is available, confirm the displayed account, duration and price before opening Alipay. Purchases are **one-time payments, not automatic renewals**; verified payments add time to the account. See [pricing](https://blackhole.stellarbridge.dpdns.org/pricing) for service information.

Refund requests show an amount preview for the selected order before confirmation. Ordinary refunds cover eligible unused paid time; free trial and gifted time are not refundable for cash. Late-paid orders without delivered entitlement have a refund action in purchase history. Read the [refund terms](https://blackhole.stellarbridge.dpdns.org/terms#refunds).

**Unknown result? Check the same order.** Stopping a local payment wait does not cancel an existing payment. Do not pay again or create another refund merely because confirmation is delayed.

## Safety and privacy

- The default `workspace-write` mode limits file writes to the workspace and explicitly permitted locations, including a private temporary directory. Higher-risk operations can require approval. `read-only` does not grant file-write access; `danger-full-access` deliberately removes shell write confinement.
- Restricted commands **fail closed** if the required sandbox backend is unavailable. These controls do not restrict every read, network request or host-service interaction and are not isolation for arbitrary hostile software. Use a disposable VM/container for untrusted code and keep backups.
- MCP upstreams use their own permissions and do not pass through the shell approval gate. Enable only upstreams you trust.
- Login, subscription and payment operations do not upload workspace files by themselves. Authorized agents can receive requested files and tool results; commands, upstreams and optional `context_search` may send data to external services. Semantic search requires credentials, and automatic credential discovery is opt-in.
- Treat connection URLs, session keys and generated prompts as credentials. Do not share tokens, cookies, card codes or unredacted logs in chats or issue reports.

Read the full [security boundaries](https://github.com/qianshe/BlackHole-core/blob/main/README.md#security-boundaries), [privacy policy](https://blackhole.stellarbridge.dpdns.org/privacy) and [terms](https://blackhole.stellarbridge.dpdns.org/terms).

## Community & Feedback

Join the **[QQ group](https://qm.qq.com/q/k2BaemO1Es)** or **[Telegram group](https://t.me/+Wj0geSQ71qcyYzc1)** to discuss BlackHole and get help from the community.

Use **[GitHub Issues](https://github.com/qianshe/BlackHole-core/issues)** for trackable bugs and feature requests. Include your installed BlackHole version, VS Code version, OS/architecture and reproduction steps; attach only minimal, redacted logs. Versioned updates are in the [changelog](https://github.com/qianshe/BlackHole-core/blob/main/packages/vscode/CHANGELOG.md).

## License

The extension source under `packages/vscode` uses **Apache-2.0**, except separately licensed components. This does not automatically cover cloud services or components outside that directory. See [LICENSE](https://github.com/qianshe/BlackHole-core/blob/main/packages/vscode/LICENSE), [NOTICE](https://github.com/qianshe/BlackHole-core/blob/main/packages/vscode/NOTICE) and [third-party notices](https://github.com/qianshe/BlackHole-core/blob/main/packages/vscode/THIRD_PARTY_NOTICES.md).
