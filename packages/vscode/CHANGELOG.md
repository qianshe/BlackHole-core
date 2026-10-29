# Change Log

## 0.4.31 — 2026-10-28（多平台社区分发）

- 补齐 Windows x64、macOS Intel / Apple Silicon、Linux x64 / ARM64 的生产环境安装包构建与自动安装验收。
- macOS 采用无需开发者账号的 ad-hoc 签名，提供拖入“应用程序”的安装入口；未经 Apple 公证，首次启动可能需手动允许。
- Linux Debian / Ubuntu 安装包声明 WebKitGTK 等运行依赖；macOS / Linux 当前通过手动安装包升级。
- 发布分阶段验收，保留 Core 与更新签名、Node 完整性检查及卸载后用户数据。线上支付保持关闭。

历史版本记录见 [CHANGELOG-HISTORY.md](CHANGELOG-HISTORY.md)。
