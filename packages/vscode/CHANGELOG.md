# Change Log

## 0.3.187 — 2026-09-30

- **BlackHole: 打开本地 Web** and the sidebar browser button now open `http://localhost:<port>` instead of `127.0.0.1`, so the console reuses the sign-in you already have on that origin instead of asking for it again.
- New local Web console: run **BlackHole: 打开本地 Web** or click the browser button in the sidebar. It signs in with your BlackHole account, shows sessions, tool calls and Todo progress, and lets you create sessions, manage projects and change settings. Not available in VS Code Remote windows. Session creation now matches VS Code: no task field, the session is named from your first message, tool calls keep the same clamped side gutter, and unpair moved into the session actions menu. Your messages stand apart from agent output and long ones fold; code blocks have a copy button; the channels page lists every channel's status.
- Phone access: click **手机扫码** in the Public channel section of Settings, scan the QR code, then click **允许** on the computer. The phone can view sessions, answer approvals and start sessions in existing projects. Needs an https public address.
- New OpenAI connection channel next to Cloudflare, with its own start/stop, one-click client install on Windows (manual install on macOS/Linux), and Tunnel ID copy. Both channels can run at the same time.
- Settings and sign-in are now kept by the BlackHole background service (sign-in and the OpenAI key are saved in your user folder, encrypted on Windows) and shared by VS Code windows and the Web console; existing settings and sign-in move over automatically on update. Sessions now use project skills together with your personal skill library (same-name project skills win). The Settings page is reordered so common actions come first, and the extension package is smaller. Fixes: garbled Chinese output and paths in command execution on Windows; ended sessions no longer linger in lists.

