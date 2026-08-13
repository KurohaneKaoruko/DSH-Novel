# DSH-Novel 安装指引（给 DSH Agent 执行）

本文件描述如何把 DSH-Novel 安装到 DeepSeek Harness 中，快速构建 AI 写小说环境。
Agent 请按顺序执行；涉及浏览器授权的步骤需用户确认。**手动安装**也可按同样步骤操作。

---

## 0. 环境确认

- DSH 用户预设根目录：`$HOME/.dsh/.agent-presets/`（Windows 下即 `C:\Users\<用户名>\.dsh\.agent-presets\`；
  可用 `echo $env:DSH_HOME` 确认，默认 `$HOME/.dsh`；`agentPresets.list()` 可查真实路径）。
- 动态插件通过 `cordis_define` + `cordis_run` 安装（会话级、进程级）；Agent 预设是文件复制（持久）。

## 1. 安装动态插件 novel-assistant（唯一插件：23 个写作工具 + 小说阅览窗口）

本插件是 Host + Client 合并版，一次安装即可同时获得写作工具与阅览窗口。

1. 读取 `plugins/novel-assistant.host.js`（Host 代码）与 `plugins/novel-assistant.client.js`（Client 代码）。
2. 调用 `cordis_define`：
   - `plugin.kind: 'new'`，`plugin.idPrefix: 'novel'`；
   - `name: 'novel-assistant'`；
   - `code.host` 填入 Host 文件内容，`code.client` 填入 Client 文件内容。
3. 调用 `cordis_run`（`mode: 'run'`）。Client 半部需要浏览器授权：若返回 `awaiting-approval`，
   请用户在该 Run 卡片上点击「允许」；授权后 Client 异步激活。
4. 验证：
   - `cordis_inspect_query(host, Tool, listTools)` 应能看到 `novel_polish`、`novel_continue` 等共 23 个 `novel_*` 工具；
   - `cordis_inspect_self` 中该插件 `state: running`、client `status: running`，Host handlers 含 `nreader:list` / `nreader:read` / `nreader:write`；
   - 页面右上角出现「📖 阅览」按钮，浮动窗口列出工作区文件。

## 2. 安装 Agent 预设「小说助手」（持久）

1. 把整个 `agent-presets/novelist/` 目录复制到 `$HOME/.dsh/.agent-presets/novelist/`（包含 `preset.yml`、`agent.cordis.yml`、`plugins/novel-tools.mjs` 三个文件/目录）。
   - 该目录在会话工作区之外：若文件写入被沙箱拒绝（`[sandbox: file access denied ...]`），用 `sandbox_permissions: danger-full-access` 重试一次（需用户批准），一次性完成全部文件复制。
2. 挂载校验：通过临时插件注入 `agentPresets` 服务并调用 `agentPresets.standingKeyFor('novelist')`；正常返回即校验通过
   （组合可挂载：所有行能解析、配置合法、无服务越界、无未激活行——包括本地 `./plugins/novel-tools.mjs` 工具行）。
   校验不通过时，把错误信息原样反馈给作者排查。
3. 新建会话，在预设选择器中选择「**小说助手**」，确认工具列表包含 23 个 `novel_*` 工具、系统提示包含《网文创作方法论》。

## 3. 收尾与使用

- 完成标志：新会话选择「小说助手」后，能调用 novel_* 工具、能打开阅览窗口、能直接开始写小说。
- 动态插件只在当前会话生效；预设持久可用（工具内置其中）。新会话想用阅览窗口时，重复第 1 步（或让 Agent 自动执行）。
- 卸载：动态插件用 `cordis_stop` / `cordis_undefine`；预设删除 `$HOME/.dsh/.agent-presets/novelist` 目录。

---

## 常见问题

- **Q：阅览窗口按钮没出现？** 确认 novel-assistant 的 Client 已授权激活（`cordis_inspect_self` 查看 client status）；必要时刷新页面。
- **Q：窗口显示的是运行目录而不是工作区？** 确认当前已打开一个会话（窗口根目录取“当前会话工作区”）；无会话时回退到最近工作区。
- **Q：保存文件失败？** 检查会话文件策略是否为允许写工作区（默认 workspace-write）；窗口只允许写当前工作区内路径。
- **Q：工具调用报“没有可用模型”？** 在设置里配置模型提供方；或调用工具时显式传 `provider` / `model`。
