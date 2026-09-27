# Change Log

## 0.3.185 — 2026-09-28

- New local Web console: run **BlackHole: 打开本地 Web** or click the browser button in the sidebar. It signs in with your BlackHole account, shows sessions, tool calls and Todo progress, and lets you create sessions, manage projects and change settings. Not available in VS Code Remote windows.
- Phone access: click **手机扫码** in the Public channel section of Settings, scan the QR code, then click **允许** on the computer. The phone can view sessions, answer approvals and start sessions in existing projects. Needs an https public address.
- New OpenAI connection channel next to Cloudflare, with its own start/stop, one-click client install on Windows (manual install on macOS/Linux), and Tunnel ID copy. Both channels can run at the same time.
- Settings and sign-in are now kept by the BlackHole background service (sign-in and the OpenAI key are saved in your user folder, encrypted on Windows) and shared by VS Code windows and the Web console; existing settings and sign-in move over automatically on update. Sessions now use project skills together with your personal skill library (same-name project skills win).
- The Settings page is reordered so common actions come first, and the extension package is smaller. Fixes: garbled Chinese output and paths in command execution on Windows; ended sessions no longer linger in lists.

