# 发布责任与门槛（共享核心渠道）

本文件定义把开发工件推进为可发布下载物时的角色、门槛和证据要求。具体的
构建、打包与校验命令以脚本和 CI workflow 为准；执行真实发布前先完成
[发布验收清单](RELEASE-VALIDATION.md)。没有证据的门槛一律视为未通过，
不得用源码测试、fixture 或开发候选冒充发布证据。

## 角色

| 角色 | 职责 | 不得兼任的检查 |
| --- | --- | --- |
| 实现者 | 完成功能、测试和候选工件，给出变更与已知限制说明 | 不得自行签收自己候选的发布门槛 |
| 审核者 | 核对 diff、测试新鲜度、工件哈希和证据边界 | 不得在未复跑关键验证时签收 |
| 发布负责人（Release Owner） | 冻结候选 commit、决定渠道推进、维护下载元数据和发布记录 | 不接触生产签名私钥 |
| 签名负责人（Signing Owner） | 独立保管生产签名密钥，按签名清单核对哈希后签名并留痕 | 不得修改候选内容或代签未经审核的哈希 |
| 验收者 | 在隔离环境执行人工验收矩阵并记录结果 | 不得把 CI/源码冒烟当作真机验收 |

## 门槛

- **G0 源码冻结**：候选对应完整 commit SHA；工作树无遗漏改动；CI 必需
  检查通过；涉及的 flaky 必须有记录和处置（复跑证据或跟踪项），不得
  以放宽断言/TTL 换取通过。证据：CI 运行链接、commit SHA。
- **G1 工件互匹配**：Seed/Core、bridge/首发 VSIX、Desktop 与 installer
  由同一候选源码构建；记录每个工件的字节数与 SHA-256；Manager、daemon
  和 Web 构建标识在各工件间一致。证据：`artifact-manifest.json` 及生成
  它的 CI/本地日志（参考 `.github/workflows/shared-core-prepare.yml`）。
- **G2 自动化联合验证**：打包后的真实 daemon 通过 Seed smoke、冷切换、
  Desktop/VSIX 双适配器联合 smoke 与升级/回滚自动化；失败项不得以
  “环境问题”跳过而不建跟踪项。证据：各 smoke 的结构化输出与端口隔离记录。
- **G3 许可与 SBOM**：`node scripts/third-party-licenses.mjs --check`
  通过；发布候选生成 CycloneDX SBOM（`scripts/generate-sbom.mjs`），
  覆盖 npm 生产依赖、Desktop 的 Go 模块与随 Core 分发的运行时组件；
  Inno Setup 等工具的商业许可状态必须明确记录（未确认商业许可时不得
  以该工具链生产商业分发件）。证据：SBOM 文件哈希、许可证检查输出。
- **G4 人工隔离验收**：按人工指南在隔离 Windows 环境完成安装/升级/
  卸载、VSIX 安装与 reload、多窗口、托盘与确认框、数据与注册表保留。
  执行安装器、真实 VSIX 或注册表写入需要事先单独授权；验收未完成时
  候选只能停留在 test 渠道。证据：验收记录（步骤、版本、哈希、结果）。
- **G5 签名与发布**：生产签名只允许由签名负责人用生产密钥对 G1 清单
  中的哈希执行 `scripts/sign-artifacts.mjs sign --environment production
  --confirm-production-signing`，随后第三方可用公钥 `verify`。生产下载
  元数据（`scripts/release-metadata.mjs --channel production`）只在生产
  签名存在且工件为 production 构建时生成。发布、官网部署、市场提交、
  版本号变更均为独立显式动作，不属于任何准备脚本的默认行为。

## 渠道规则

- `test` 渠道：可使用测试签名根和自动生成的临时密钥验证全链路；下载
  元数据必须标注 test，测试根构建不得作为生产下载分发。
- `production` 渠道：只接受 production 构建、生产签名和通过 G4 的同一
  哈希工件；任一工件哈希变化都必须重走 G1–G5。
- 回退：发布后回退只能回退到前一个已通过全部门槛的哈希集合，并在发布
  记录中写明原因；不得静默替换已发布文件。

## 当前状态锚点

开发候选与 §13.25 的匹配工件满足 G1–G3 的自动化部分（见主计划执行
记录）；G4 人工验收与 G5 生产签名尚未执行，也未获得授权。
