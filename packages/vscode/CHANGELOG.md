# Change Log

## 0.3.174 — 2026-09-26

- Local Web: create sessions from the page (pick a folder, set permissions and optional auto-approve) and copy the session ID for your AI.
- Local Web: new **Projects** page to keep frequently used folders, pin or rename them, and start a session from any of them.

## 0.3.173 — 2026-09-26

- Add a read-only local Web page: run **BlackHole: 打开本地 Web** from the Command Palette or click the browser button in the BlackHole sidebar title bar. It signs in automatically and shows sessions, tool calls and Todo progress with filters, search and auto-refresh. Not available in VS Code Remote windows.

## 0.3.171 — 2026-09-25

- Add Handoff support for continuing work in a new conversation with fresh Connector or Sandbox connection details.
- Improve plan, execute-plan, review, and handoff workflows for saved plans, progress updates, code review, and task continuation.
- Collapse completed Todo lists while keeping an immediate completion receipt, hiding historical completed lists, and restoring the list when new work appears.
- Improve multi-window daemon upgrades, cross-platform command execution, background tasks, native dialogs, and Handoff/sidebar layout.
- Fix upgrade races, stale daemon readiness, Todo recovery edge cases, shell discovery failures, and unwanted Windows background console windows.
