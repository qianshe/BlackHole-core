# 核心执行工具跨平台验收

GitHub 只验证源码，不打包 VSIX、不自动发布。本地打包与手动发布命令保持不变。

## 入口

```sh
pnpm install --frozen-lockfile
pnpm test:execution:core
```

需要项目支持的 Node（CI 使用 Node 22）。命令只编译根项目 TypeScript，再运行
`scripts/core-execution.test.mjs`，无需 VS Code、扩展构建、账号、公开隧道或 VSIX。
它复用 `process-harness`，在临时目录中启动真实 `startDaemon`，使用真实执行环境探测、
平台后端、工具注册和 MCP HTTP 调用；没有复制一套探测或注册实现。

## 检查阶段

启动和后端加载 → health/shell 能力 → 临时会话 → MCP 握手 → 完整 tools/list →
exec 输出和 cwd → process 启动并通过 HTTP 确认就绪 → list → stop/端口关闭 → cleanup。
缺少 exec/process 会失败，不允许以 skip 通过。POSIX 额外验证缺失 PATH、失效终端配置，
以及机器上存在的 /bin/sh、/bin/bash、/bin/zsh。Windows 运行原生基线。

诊断报告写入 `.cache/core-execution/*.json`，包含版本、平台、架构、shell、工具列表、
各阶段耗时及失败堆栈。GitHub 无论成功失败都尝试上传报告。编译或模块导入阶段失败时
可能尚未生成 JSON，以 Actions 原始日志为准。报告不记录会话密钥和 MCP URL。

## CI

`.github/workflows/vscode-extension.yml`（显示名称 Core Runtime CI）在原生 Windows、
Ubuntu 22.04、macos-15、macos-15-intel 上运行同一核心入口。
保留既有原生沙箱及集成回归测试，删除远程打包/自动发布和 packed discovery 步骤。
PR、main push 或手动 workflow_dispatch 触发；tag 不再触发此工作流。
本地 `test:execution:packed` 仍可选用。

## 验证边界

核心验收使用隔离的 full-access 测试会话，只执行固定的测试脚本，不访问用户数据库。
沙箱可用性单独记录，不把沙箱不可用误判为工具未注册；限制模式的安全性由原生沙箱门禁验证。
直接调用 startDaemon 的测试入口不经过生产 CLI 的云订阅校验，未改动任何生产授权代码。
此验收证明源码核心在对应 runner 的兼容性，不证明最终包内容、VS Code 扩展生命周期、
用户账号授权或第三方客户端缓存/界面展示。Mac/Linux 的结论以对应 GitHub job 实际结果为准。