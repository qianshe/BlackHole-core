# Attribution

`src/semantic/` 移植自 [SammySnake-d/fast-context-mcp](https://github.com/SammySnake-d/fast-context-mcp)
（MIT License，Copyright (c) 2025，版本基线 v1.3.2），经由
`dsh-assistant-optimization/lib/fast-context/`（同为 MIT）的 TypeScript 化改写：

| 参考仓库 | 本目录 | 改动 |
| --- | --- | --- |
| src/protobuf.mjs | protocol.ts | 仅 TS 化 |
| src/response-repair.mjs | repair.ts | 路径解析改用本仓库 `util/fspaths.ts`；仅 TS 化 |
| src/shared.mjs | shared.ts + prompt.ts | 系统提示词拆到 prompt.ts；删除 DSH ctx.llm 变体；树遍历加 node_modules 剪枝与目录条目上限；答案路径改为工作区相对 |
| src/executor.mjs | executor.ts | 路径守卫复用本仓库实现；rg 三级回退（env → PATH → 已装 dsh 的打包 rg）+ 纯 JS 扫描兜底；输出虚拟路径重写为逐行前缀替换 |
| src/core.mjs（协议部分） | brain.ts | 仅保留 Windsurf brain；设备指纹默认脱敏（`BH_SEMANTIC_DEVICE_INFO=1` 还原）；TLS 开关改名 |
| src/core.mjs（循环部分） | search.ts | 单一 brain（去掉 A→B 降级）；新增 `subPath` 作用域；工作区相对路径回填 |
| src/cache.mjs | cache.ts | 环境变量改名；指纹跳过 node_modules 等 |
| src/extract-key.mjs | extract-key.ts | 仅 TS 化（`node:sqlite` 读快照，先拷贝再只读打开） |
| —（dsh 插件新增） | key.ts | key 解析链：env → `~/.blackhole/semantic-key` → 本地安装（**默认关闭**） |
| —（dsh 插件新增） | content.ts | 区间代码回读 + 字节预算 |
| —（本仓库新增） | index.ts | 启动期探测 + 调用期超时/取消包装 |

## 非官方协议声明

`brain.ts` 调用 Windsurf/Devin 的**非官方**端点（`server.self-serve.windsurf.com`），
`extract-key.ts` 读取本地 Devin/Windsurf 应用数据（`state.vscdb`）。二者均无契约承诺：
端点可能无通知变更、可能限流，是否符合服务条款由操作者自行判断。因此本仓库中：

- 本地凭据自动读取**默认关闭**（`BLACKHOLE_SEMANTIC=auto` 显式开启）；
- 设备信息默认脱敏（`BH_SEMANTIC_DEVICE_INFO=1` 还原真实主机名/CPU/内存）；
- 未解析到 key 时 `context_search` 工具整体不注册。

使用即代表用户自担上述风险。完整 MIT 许可见本目录 `LICENSE-MIT`。
