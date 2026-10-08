# VS Code 插件发布验收

本文件只列发布前的检查条件。开发流程见[贡献指南](CONTRIBUTING.md)，自动检查的触发方式、平台矩阵和手动选项见 [CI 说明](.github/CI.md)。发布插件与部署 Cloud 是独立操作。

## 1. 固定候选

审核并提交本次准备发布的源码、配置、新测试和锁文件。记录完整 commit SHA，确认没有遗漏的未提交改动；CI 与安装包必须对应这一候选。使用工作流固定的 Node.js 和项目声明的 pnpm 版本。

## 2. 核对环境配置

| 配置 | 用途 |
| --- | --- |
| [src/environments/production.json](src/environments/production.json) | 正式服务地址和验签公钥，随源码审查 |
| `config/environments/test.json` | 本机测试服务配置，只含公开客户端字段，不提交 |
| [scripts/fixtures/cloud-test-profile.json](scripts/fixtures/cloud-test-profile.json) | 离线测试 fixture，不可生成可安装包 |

正式包只使用正式 profile，不接受测试地址／公钥覆盖。测试包的优先级为：完整的显式地址／公钥参数对 → 本机测试 JSON → 离线 fixture；最后一级只能用于源码检查。配置解析器为 [scripts/environment-config.mjs](scripts/environment-config.mjs)，VS Code 与 desktop 复用相应构建选择。

登录后生成的凭据不是构建配置，禁止进入源码、VSIX、CI 附件和诊断导出。修改 Core 配置不会自动修改 Cloud 部署。

## 3. 检查 CI

确认候选提交的必需检查通过，尤其是 Windows x64 的 **Audited VSIX smoke**（真实 VSIX 的环境、清单、资源哈希及隔离 daemon 启动）和 Linux x64 的 **Shared settings browser**（真实 Web / VS Code 共用组件、窄屏、二维码与焦点）。逐项记录失败、跳过和缺少的系统前置条件；这些 CI 作业均不发布，也不安装扩展。涉及隧道安装器时执行单独的真实下载验收；发行 desktop 时另跑其构建和安装验收。工作流的默认选项不代表这些手动检查已经完成。

精确命令以 [workflow 文件](.github/workflows/)为准，不在本文件维护第二套测试矩阵。模拟平台、交叉编译或缺少权限导致的跳过，不计作对应原生平台通过。

## 4. 构建并审计产物

在 Core 仓库根目录执行：

```sh
pnpm install --frozen-lockfile
pnpm package:vsix:production --out .cache/release-candidate.vsix
node scripts/audit-universal-vsix.mjs .cache/release-candidate.vsix
```

保存审计结果与 VSIX 的 SHA-256。检查包内环境、版本、公开验签配置、运行文件完整性及秘密文件排除情况。后续验收和发布使用同一个哈希的安装包，不另行打包替换。

## 5. 安装与升级验收

在对应系统的隔离测试实例中检查扩展激活、daemon 启动、原生模块加载、登录持久化与退出、权限拒绝、命令超时与进程回收，以及升级恢复。核对 daemon 的版本和 Cloud origin；Linux/macOS 还需检查实际使用的可执行文件权限。

测试实例必须隔离 daemon 数据目录、端口和凭据；仅切换 VS Code profile 不等于隔离全部运行状态。CI 使用合成凭据，真实账号交互和人工验收另行记录，不把生产凭据交给公共 PR。

## 6. 发布记录

记录以下内容后再发布已验收的 VSIX：

```text
版本：
完整 commit SHA：
VSIX 文件名与 SHA-256：
CI 运行链接和平台结果：
安装／升级／登录验收结果：
已知限制与回退版本：
```

没有取得某个平台的证据时，标记为未验证，不声明全平台通过。失败应交给对应实现负责人修复，不通过删测试或放宽权限换取通过。
