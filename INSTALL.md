# DSH-Novel 安装指引（给 DSH Agent 执行）

本文件描述如何把 DSH-Novel 安装到 DeepSeek Harness 中，快速构建 AI 写小说环境。
本项目的全部能力都封装在 **Agent 预设「小说助手」**（仓库内的 `novelist/` 目录）中，**无需安装任何动态插件**，因此也没有浏览器授权步骤。
Agent 请按顺序执行；**手动安装**也可按同样步骤操作。

---

## 0. 环境确认

- DSH 用户预设根目录：`$HOME/.dsh/.agent-presets/`（Windows 下即 `C:\Users\<用户名>\.dsh\.agent-presets\`；
  可用 `echo $env:DSH_HOME` 确认，默认 `$HOME/.dsh`；`agentPresets.list()` 可查真实路径）。
- Agent 预设通过**文件复制**安装（持久，进程重启与切换会话都不失效）。

## 1. 安装 Agent 预设「小说助手」（持久）

1. 把仓库中的整个 `novelist/` 目录复制到 `$HOME/.dsh/.agent-presets/novelist/`，包含：
   - `preset.yml`（预设元数据）
   - `agent.cordis.yml`（组合文件）
   - `plugins/novel-tools.mjs`（9 个工程化工具）
   - `skills/`（6 个方法论 skill 目录：novel-prose-standards / novel-continuity / novel-plotting / novel-craft / novel-analysis / novel-project）
   - 该目录在会话工作区之外：若文件写入被沙箱拒绝（`[sandbox: file access denied ...]`），用 `sandbox_permissions: danger-full-access` 重试一次（需用户批准），一次性完成全部文件复制。
2. 挂载校验：通过临时插件注入 `agentPresets` 服务并调用 `agentPresets.standingKeyFor('novelist')`；正常返回即校验通过
   （组合可挂载：所有行能解析、配置合法、无服务越界、无未激活行——包括本地 `./plugins/novel-tools.mjs` 工具行与 `skills/` 目录挂载行）。
   校验不通过时，把错误信息原样反馈给作者排查。
3. 新建会话，在预设选择器中选择「**小说助手**」，确认：
   - 工具列表包含 9 个 `novel_*` 工具（novel_lint / novel_style_profile / novel_continue / novel_write_chapter / novel_briefing / novel_archive / novel_project / novel_import / novel_scan_book）；
   - 技能列表包含 6 个 `novel-*` skill；
   - 系统提示包含「小说助手工作法」路由段（分工原则 + 每章闭环 + skill/工具路由 + 硬纪律）。

## 2. 收尾与使用

- 完成标志：新会话选择「小说助手」后，能加载 novel-* skill、能调用 9 个 novel_* 工具、能直接开始写小说。
- 全程**无需安装插件、无需浏览器授权**；skill、工具、人设全部随预设持久存在。
- 建议开书流程：`novel_project 初始化工程` → 写 1-2 章定稿 → `novel_style_profile` 提取文风卡 → 之后每章走「简报 → 成稿 → 归档」闭环（详见 README「四、使用」）。
- 卸载：删除 `$HOME/.dsh/.agent-presets/novelist` 目录即可。

---

## 常见问题

- **Q：工具调用报“没有可用模型”？** 在设置里配置模型提供方；或调用工具时显式传 `provider` / `model`。
- **Q：预设选择器里没有「小说助手」？** 确认 `novelist/` 已完整复制到用户预设根目录（`skills/` 子目录必须随行——工具子调用的方法论包从它装载），且挂载校验（`standingKeyFor`）通过；预设清单是即时扫描的，无需重启即可出现。
- **Q：想改写作方法论或任务流程？** 编辑 `novelist/skills/*/SKILL.md` 后复制覆盖即可，Agent 亲写与工具成稿同时生效，不用动代码。
- **Q：想改 lint 规则或上下文组装逻辑？** 编辑 `novelist/plugins/novel-tools.mjs` 后复制覆盖到 `~/.dsh/.agent-presets/novelist/plugins/novel-tools.mjs` 即可。
