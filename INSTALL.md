# DSH-Novel 安装指引（给 DSH Agent 执行）

本文件描述如何把 DSH-Novel 安装到 DeepSeek Harness 中，快速构建 AI 写小说环境。
本项目的全部能力都封装在 **Agent 预设「小说助手」** 中，**无需安装任何动态插件**，因此也没有浏览器授权步骤。
Agent 请按顺序执行；**手动安装**也可按同样步骤操作。

---

## 0. 环境确认

- DSH 用户预设根目录：`$HOME/.dsh/.agent-presets/`（Windows 下即 `C:\Users\<用户名>\.dsh\.agent-presets\`；
  可用 `echo $env:DSH_HOME` 确认，默认 `$HOME/.dsh`；`agentPresets.list()` 可查真实路径）。
- Agent 预设通过**文件复制**安装（持久，进程重启与切换会话都不失效）。

## 1. 安装 Agent 预设「小说助手」（持久）

1. 把整个 `agent-presets/novelist/` 目录复制到 `$HOME/.dsh/.agent-presets/novelist/`（包含 `preset.yml`、`agent.cordis.yml`、`plugins/novel-tools.mjs` 三个文件/目录）。
   - 该目录在会话工作区之外：若文件写入被沙箱拒绝（`[sandbox: file access denied ...]`），用 `sandbox_permissions: danger-full-access` 重试一次（需用户批准），一次性完成全部文件复制。
2. 挂载校验：通过临时插件注入 `agentPresets` 服务并调用 `agentPresets.standingKeyFor('novelist')`；正常返回即校验通过
   （组合可挂载：所有行能解析、配置合法、无服务越界、无未激活行——包括本地 `./plugins/novel-tools.mjs` 工具行）。
   校验不通过时，把错误信息原样反馈给作者排查。
3. 新建会话，在预设选择器中选择「**小说助手**」，确认：
   - 工具列表包含 23 个 `novel_*` 工具；
   - 系统提示包含《网文创作方法论》与「去 AI 味」红线。

## 2. 收尾与使用

- 完成标志：新会话选择「小说助手」后，能调用 novel_* 工具、能直接开始写小说。
- 全程**无需安装插件、无需浏览器授权**；写作工具、人设、方法论全部随预设持久存在。
- 建议让 Agent 把章节/大纲/设定集以 Markdown 保存到工作区，搭配 Obsidian 阅读与批注（见 README「五、搭配 Obsidian 使用」）。
- 卸载：删除 `$HOME/.dsh/.agent-presets/novelist` 目录即可。

---

## 常见问题

- **Q：工具调用报“没有可用模型”？** 在设置里配置模型提供方；或调用工具时显式传 `provider` / `model`。
- **Q：预设选择器里没有「小说助手」？** 确认 `agent-presets/novelist/` 已完整复制到用户预设根目录，且挂载校验（`standingKeyFor`）通过；预设清单是即时扫描的，无需重启即可出现。
- **Q：想自己扩展工具？** 编辑 `agent-presets/novelist/plugins/novel-tools.mjs` 后复制覆盖到 `~/.dsh/.agent-presets/novelist/plugins/novel-tools.mjs` 即可。
