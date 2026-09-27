> **私有迁移候选版本。** 当前保持 Private。导入范围、验收结果和已知失败见 [MIGRATION-STATUS.md](MIGRATION-STATUS.md)。本次导入不等于公开发布或生产部署。

<div align="right">

**简体中文** | [English](README.md)

</div>

# BlackHole

**以受控方式，让网页 AI 使用你的本地开发工作区。**

BlackHole 通过 MCP Streamable HTTP 将网页 AI 连接到本地 daemon。AI 可以在选定的工作区内查看文件、修改代码和调用工具，你则在 VS Code 中管理会话、权限、审批和活动记录。

```text
网页 AI / 兼容的 MCP 宿主
        ↕ MCP Streamable HTTP
你配置的公网渠道
        ↓
BlackHole daemon（仅监听 loopback）
        ↓
选定的工作区、shell 和已配置的 MCP 上游
```

[VS Code 插件](packages/vscode/README.md)是推荐的用户入口。本 README 同时介绍项目架构和源码开发流程。请阅读[许可证范围](#许可证范围)，不要默认整个仓库适用同一许可证。

## 快速开始

1. 打开 VS Code 的**扩展**面板，搜索 **BlackHole**，选择发布者为 **qianshe** 的插件，扩展标识为 `qianshe.blackhole-vscode`。
2. 打开本地工作区，在 BlackHole 侧边栏中通过系统浏览器完成登录。
3. 创建工作区会话并检查权限模式。多根工作区需要明确选择该会话绑定的文件夹。
4. 在设置 → 公网渠道 → Cloudflare 点击“一键初始化安装”，验证通过后选择“保存并重启”，再点击“启动临时”。已有可用路径时可跳过安装；其他连接方式见[使用指南](https://blackhole.stellarbridge.dpdns.org/faq#required-config)。
5. 连接兼容的 AI，并在 VS Code 中查看工具活动、批准或拒绝待审批操作。

安装、设置和故障排查详见[插件使用说明](packages/vscode/README.md)。普通插件用户无需单独安装 Node.js；插件使用 VS Code 自带的运行时启动内置 daemon。

## 主要能力

- **本地工具**：使用机器上的真实项目、shell 和依赖环境。
- **工作区会话**：选择目录及权限模式，暂停、恢复、撤销或轮换访问凭证。
- **活动与审批**：查看工具调用、结果、任务及等待审批的操作。
- **公网渠道**：使用临时或持久 Cloudflare 隧道，也可使用自己维护的 HTTPS 入口。
- **MCP 上游**：通过稳定的 `proxy` 接口接入已配置的第三方工具。
- **技能与可选语义搜索**：提供可复用的指令，并按需启用外部代码搜索。
- **规划与交接**：保存计划、按计划执行，并用 Handoff 在新对话中接续任务。参阅[日常使用](https://blackhole.stellarbridge.dpdns.org/faq#planning-workflows)。
- **MCP Apps**：在兼容宿主中显示会话进度；不支持面板的宿主仍可使用普通 MCP 工具。

## 账号与订阅

账号和订阅操作在插件内完成。新账号提供 **3 天试用**，从原始注册时间开始计算；重新登录不会重新计时。

购买功能开放时，可以通过支付宝购买使用时长、查看购买记录或兑换订阅卡。时长包采用**单次付款，不自动续费**。付款前请核对插件显示的账号、时长和金额。

退款针对选定的订单，在明确确认前先展示金额预览。普通退款只计算该订单符合条件的剩余付费时长，不将免费试用或赠送时长兑换为现金。已确认超时付款、但未交付权益的订单有单独的退款处理路径。结果未知时，应继续核对**同一订单**，不要重复付款或另建退款。

购买是否开放及当前价格以服务端为准。参阅[价格说明](https://blackhole.stellarbridge.dpdns.org/pricing)、[退款条款](https://blackhole.stellarbridge.dpdns.org/terms#refunds)、[隐私政策](https://blackhole.stellarbridge.dpdns.org/privacy)和[服务条款](https://blackhole.stellarbridge.dpdns.org/terms)。

## 连接方式与公网渠道

BlackHole 不会自动将本地 daemon 暴露到公网。只在需要时启动或配置公网渠道。

- **连接器方式**：在兼容的宿主中配置 BlackHole，然后复制会话提示词。
- **直接连接方式**：将生成的 MCP 连接提供给具有公网访问能力的 AI 环境。
- **持久 Cloudflare 渠道**：使用本机管理的 named tunnel 和固定公网地址。
- **临时 Cloudflare 渠道**：使用 quick tunnel 进行测试。Quick tunnel 不支持 SSE；宿主要求 SSE 时应使用持久渠道。
- **自定义渠道**：自行维护公网 HTTPS 入口并设置其基础地址，BlackHole 不会代为管理外部服务。

插件不内置 `cloudflared`。在 **设置 → 公网渠道 → Cloudflare** 中，可以点击 **「一键初始化安装」**：优先验证 PATH 中已有的程序，未找到时由用户明确触发下载固定版本到 BlackHole 的私有用户目录，并回填仍可编辑的完整路径；也可以继续自行安装并填写路径。BlackHole 不会静默下载，初始化也不会启动公网渠道。参阅[渠道配置指南](https://blackhole.stellarbridge.dpdns.org/#channels)。手动修改 PATH 后，需要同时重启 VS Code 和已经运行的 daemon。

轮换会话 key 不会改变机器级 MCP URL，但旧会话 key 会失效。**连接 URL、会话 key 和生成的连接提示词都应按凭证保护**，只提供给你明确授权的 AI。

## MCP 工具

| 工具 | 用途 |
| --- | --- |
| `exec` | 执行有限命令并等待结果；工具描述按当前操作系统声明 daemon 选择的 shell 语法和状态保留方式。 |
| `process` | `start/list/status/stop` 管理独立后台进程；按 ID 查近期输出、错误和退出结果，每个进程对应独立集成终端视图。 |
| `editor` | 查看、创建、编辑、插入或删除文件，执行工作区路径边界检查。 |
| `guide` | 提供操作规则和已授权项目指令，不返回 Skill 目录。 |
| `todo` | 持久化完整 Task Contract 与步骤进度，让复杂任务在上下文变化后恢复。 |
| `skill` | 读取项目或用户 Skill 的指令与引用资源。 |
| `show` | 在支持 MCP Apps 的宿主中显示会话面板。 |
| `context_search`（可选） | 配置可用凭据后，通过 Devin Fast Context 进行代码语义搜索。 |
| `proxy` | 发现并调用已配置 MCP 上游的工具，不将上游工具直接合并进宿主工具列表。 |

### 项目与个人 Skill

每个 Skill 单独建一个目录，入口文件为 `SKILL.md`：

- **项目目录：**`<会话工作区>/.agents/skills/<名称>/SKILL.md`。
- **个人默认目录：**`~/.agents/skills/<名称>/SKILL.md`，位于 daemon 当前运行用户的 home 下。
- **手动目录：**VS Code 设置 `blackhole.skillsDir`；直接启动 daemon 时使用 `BLACKHOLE_SKILLS_DIR`。手动目录替代个人默认目录，即使不存在也不回退；项目 Skill 仍启用。清空 VS Code 设置会恢复默认发现，并清除该次启动继承的旧目录覆盖。支持 `~/`、`~\` 用户目录写法。

有效会话合并读取项目库和选定的用户级库（手动或默认二选一，不隐式增加第三个来源）。同名项目版本优先，两边不同名的技能都保留；名称指可调用的文件夹标识，不是 frontmatter 展示标题，大小写遵循实际文件系统规则。引用文件只从选中的 Skill 根目录读取，不跨库补找。手动相对路径以 daemon 启动目录为基准，不以会话工作区为基准，推荐绝对路径或用户目录写法。

调用 `skill` 且不传名称来发现目录，再指定名称和可选相对路径读取正文、引用。`guide` 不返回 Skill 目录，也不扫描技能库。读取型 `guide` 附带已授权会话工作区根目录的 `AGENTS.md`，没有大写文件时兼容 `agents.md`；不向父目录搜索。项目规则缺失不影响使用；越界、过大或不可读会明确报错，不静默丢弃。Handoff 保存回执不变。

技能库目录缺失时不提供技能，也不会自动创建。库路径是文件、断链、不可读或越出项目边界时明确报错，不当成正常空库。选中的技能目录损坏时，不加入 `skills`，而是在 `issues` 中报告；仍会遮蔽低优先级同名版本。数量为 0 但存在诊断代表配置问题。库响应的 `complete` 只表示发现结束，不代表每个条目都健康。设置页仅预览目录结构，不表示会话最终可用技能数。

项目 Skill 和指令不能通过链接越出工作区；加载它们不会扩大权限或执行脚本。自动发现项目和默认用户目录需要有效会话；没有有效会话时，只保留显式手动库的只读能力，不会顺带扫描默认库或通过错误提示泄露其名称。请勿在无会话可读库中存放凭据。

验证入口为 `pnpm test:skills`、`pnpm test:guide-workflows` 和 `pnpm verify:prompts`。独立原生 CI 覆盖 Windows、Linux、macOS 的 x64 与 ARM64，核对实际测试进程架构，并要求文件符号链接边界测试真正执行，不能因权限不足跳过后仍判定通过。

### 后台开发进程

开发服务器、watch 使用 `process start`；一次性测试、构建、Git 仍使用短命令工具。启动后保存 `processId`，用 `status` 检查近期 stdout/stderr、退出码，再访问实际端点确认就绪。丢失响应时先 `list/status`，同一启动意图沿用相同 `requestId`，不能盲目再开一个服务。

VS Code 自动为匹配工作区的每个进程显示独立只读集成终端；关闭终端标签会请求停止对应任务，Ctrl+C 也会请求停止但保留终端视图。命令面板提供 **BlackHole: 显示后台进程**、**停止后台进程**（保留最终日志）和 **停止并关闭后台进程**（仅在清理确认后关闭该终端）；停止未确认时会保留终端供排查。终端不可用不影响按 ID 查询，`terminal.state=open` 必须由 VS Code 实际确认。只有需要额外说明时才调用 `guide(tool="process")`，默认指南不展开使用细节。

本地 Windows、macOS、Linux 复用这套终端视图，执行能力由 daemon 探测。Windows 有限命令保留既有 PowerShell 会话；macOS/Linux 当前使用 Bash，只保留 cwd，变量和函数不跨调用保留。后台任务始终独立运行；受限 Linux 需要可用的 bubblewrap，受限 macOS 需要可用的系统沙箱。Windows 和 Linux 已有实际执行证据，macOS 原生进程与终端验收仍需在对应系统完成；Remote SSH/WSL/容器窗口尚未启用该终端桥接。

### MCP 上游路由

在插件设置的 **MCP Proxies** 中配置上游。面向 AI 的接口为：

```text
proxy(sessionId, command = list | explain | call | cancel, tool?, argsJson?, optionsJson?)
```

`list` 返回全局工具注册表；`explain` 和 `call` 使用可见工具名，BlackHole 在内部解析对应的 MCP server。Alias 决定可见名称。多个已启用上游提供同名工具时，该名称进入冲突状态，需要操作者解决；不会静默选择服务器或自动添加前缀。

上游调用**不经过 BlackHole 的 shell 审批门**。显式拒绝策略、取消、超时、脱敏及已配置的 profile 限制仍然有效。可选的 browser profile 不是通用浏览器沙箱；`chrome-devtools-mcp` 等浏览器 MCP 需要另行安装和配置。

### MCP Apps 面板

兼容宿主中的 `show` 可展示任务进度、工具活动和待审批操作，使用资源 URI `ui://blackhole/panel.html`。为同一会话创建新的面板 capability 会使之前的 capability 失效。不支持 MCP Apps 的宿主仍可使用普通工具。

## 安全边界

权限模式与单次审批决定是两套不同的控制：

| 模式 | 边界 |
| --- | --- |
| `read-only` | 不通过工作区编辑器或受限 shell 授予文件写入权限。 |
| `workspace-write`（默认） | 允许写入选定工作区、明确授权的目录和私有临时目录；高风险操作可能需要审批。 |
| `danger-full-access` | 显式解除 shell 写入隔离，不应作为缺少沙箱后端时的替代方案。 |

`editor` 检查路径，包括目录穿越、符号链接和真实路径逃逸。受限 shell 在 Windows 上使用写入受限令牌，在 Linux 上使用 bubblewrap，在 macOS 上使用 Seatbelt。所需后端无法初始化时会拒绝执行，而不是退化为无隔离运行。批准操作本身不会移除操作系统的写入边界。

这些机制限制的是**文件写入**，并不限制所有文件读取、网络流量或主机服务交互。Windows 限制也存在 Everyone 可写对象、硬链接等边界条件。已配置的 MCP 上游使用自身的主机或服务权限，不会自动受到会话 shell 沙箱的隔离。

**不要将这些控制视为运行任意恶意软件的隔离环境。** 不可信代码应放在可丢弃的虚拟机或容器中运行；只启用可信上游，并保留备份。

## 隐私与外部数据流

- 工作区文件和工具执行由本地 daemon 处理。授权的网页 AI 可以通过你配置的连接接收所请求的文件内容和工具结果。
- Shell 命令和 MCP 上游可能访问外部服务，其权限和隐私条款仍然适用。
- 可选语义搜索会向 Devin Fast Context 发送所需路径和代码片段。默认凭据策略要求明确配置；自动发现本机 Devin/Windsurf 凭据需要主动开启。
- BlackHole Cloud 处理登录、订阅检查、订阅卡兑换及支付／退款。这些操作本身不会上传工作区文件。
- 账号 bearer token 使用 VS Code SecretStorage 保存。插件仅在内存中保留活动工作区会话 key；daemon 将其凭证材料保存为哈希。插件没有独立的产品遥测或广告跟踪器。

不要在公开问题报告中提交连接 URL、key、token、Cookie、卡密或敏感工作区内容。

## 环境要求与支持范围

- 插件用户需要 **VS Code 桌面版 1.107.0 或更新版本**；使用内置 daemon 无需另行安装 Node.js。
- 当前支持的工作流使用本地文件夹。多根工作区需要为会话选择文件夹。Remote SSH、WSL、容器扩展宿主以及 VS Code for the Web 不在此支持范围内。
- 通用 VSIX 包含 Windows x64 沙箱运行时，但不包含隧道程序。不支持 Windows ARM 或 32 位原生执行。
- Linux 受限命令需要 `/usr/bin/bwrap` 和可用的 user namespaces；macOS 需要 `/usr/bin/sandbox-exec`。
- 通用安装包不代表每种 Linux/macOS 发行版、系统版本和架构都已通过发布验收。缺少沙箱后端时会拒绝执行受限命令。

## 源码开发

源码贡献者需要 **Node.js 22.5 或更新版本**，以及 `package.json` 声明的 pnpm 版本。这是开发要求，不是普通插件用户的额外安装要求。

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
```

启动本地 daemon：

```bash
pnpm start
```

默认监听 `127.0.0.1:7306`。从源码构建不会绕过账号、权益或权限检查。

这个独立 Core 仓库不要求取得私有 Cloud 源码或部署配置。公开客户端构建配置位于 `scripts/environment-config.mjs`。默认测试配置使用合成的 `example.org` 地址与一次性公钥，仅用于构建和打包验证，不能登录真实服务。对接自己的测试服务时，向构建／打包入口同时传入 `--cloud-origin` 和 `--cloud-public-key`；不要把签名私钥放进客户端配置。正式服务地址与公钥信任保持不变。

在本地构建或打包插件。首次打包通用 VSIX 前，需要显式下载锁定版本的跨平台 keyring 二进制；脚本按 npm registry 的 SHA-512 integrity 校验下载内容，只写入被忽略的本地构建／缓存目录。

```bash
pnpm --filter @blackhole/web build
pnpm --filter blackhole-vscode build          # 合成测试配置
node scripts/fetch-keyring-prebuilds.mjs      # 通用 VSIX 的一次性准备
pnpm --filter blackhole-vscode package        # 测试 VSIX，不用于真实 Cloud 登录
pnpm --filter blackhole-vscode build:production
pnpm --filter blackhole-vscode package:production
```

打包生成不包含 `cloudflared` 的通用 VSIX，不再区分内置隧道程序包和轻量包。构建、打包不会自动提升版本号、安装插件、重启正在运行的 daemon 或部署云服务。测试与正式端点及其信任配置都是固定的构建时环境配置，不是面向用户的设置项。

### CLI 参考

| 命令 | 用途 |
| --- | --- |
| `serve [--port N] [--db PATH]` | 运行 daemon。 |
| `create <workspace> [--mode read-only\|workspace-write\|danger-full-access] [--name <task>] [--copy url\|prompt]` | 创建工作区会话。 |
| `ls / show <id>` | 列出或查看会话。 |
| `pause \| resume \| revoke \| rotate <id>` | 管理访问及会话生命周期。 |
| `events <id> / calls <id>` | 查看事件和工具调用。 |
| `confirmations / approve \| deny <id>` | 查看并决定待审批操作。 |
| `tunnel` | 查看公网渠道状态。 |

完成本地服务配置后，可使用以下命令：

```bash
node dist/cli.js create D:/path/to/project --copy prompt
node dist/cli.js tunnel

# 先将 BLACKHOLE_PUBLIC_URL 设置为固定 HTTPS 地址，再启动 named tunnel。
node dist/cli.js tunnel start named

# 临时测试渠道；使用完毕后停止活动渠道。
node dist/cli.js tunnel start quick
node dist/cli.js tunnel stop
```

日常配置和凭据输入建议使用插件设置。默认端口为 `7306`；daemon 的 `BLACKHOLE_PUBLIC_URL` 和 `BLACKHOLE_CLOUDFLARED` 分别配置公网地址及隧道程序。插件中的 `blackhole.publicBaseUrl`、`blackhole.cloudflaredPath` 提供相应的用户设置。

### 验证

```bash
pnpm build
pnpm test:pack        # 面向 Windows 的完整门禁
pnpm test:posix       # 跨平台子集
pnpm test:build-flavor
pnpm test:contracts
```

完整门禁包含仅限 Windows 的行为 smoke 测试。POSIX 子集不能替代实际系统／架构验收。真实隧道、浏览器和外部语义服务检查是依赖运行环境的单独测试；不能把本地单元测试通过等同于真实支付或生产部署验收。

包括 `docs/vscode/development.md` 在内的贡献者资料通过根目录 `docs/` 索引维护。这些是维护者本地资料，不随仓库或 VSIX 分发，使用插件也不需要它们。

## 交流与反馈

欢迎加入 **[QQ 交流群](https://qm.qq.com/q/k2BaemO1Es)** 或 **[Telegram 交流群](https://t.me/+Wj0geSQ71qcyYzc1)**，交流 BlackHole 的使用体验、分享建议并寻求社区帮助。

需要跟踪的 Bug 和功能建议，请通过 **[GitHub Issues](https://github.com/qianshe/BlackHole-core/issues)** 提交，并提供已安装的 BlackHole 版本、VS Code 版本、系统／架构及复现步骤。只提供最少量的相关**脱敏**日志；不要在群聊或问题报告中发送连接凭证、会话 key、token、Cookie、卡密或敏感工作区内容。

按版本记录的变化见[插件更新日志](packages/vscode/CHANGELOG.md)。

## 许可证范围

`packages/vscode` 下的源码采用 **Apache-2.0**，另行标识的第三方组件除外。请阅读该目录的 [LICENSE](packages/vscode/LICENSE)、[NOTICE](packages/vscode/NOTICE) 和[第三方声明](packages/vscode/THIRD_PARTY_NOTICES.md)。

该许可证不授予 `packages/vscode` 之外组件的许可，包括 BlackHole 云服务、支付／账号／订阅后端及部署配置。不要默认整个仓库或托管服务适用同一开源许可证。打包组件仍遵循各自适用的条款。
