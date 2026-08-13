# DSH-Novel · AI 网文写作环境

> 把 DeepSeek Harness 一键变成「AI 写小说」工作台：**一个插件（23 个网文写作工具 + 小说阅览窗口）+ 专为写小说设计的 Agent 预设「小说助手」**。
> 把本仓库（或 GitHub 链接）交给任意 DeepSeek Harness Agent，按 `INSTALL.md` 执行即可自动安装完成。

---

## 一、这是什么

本项目包含两件东西，互相配合构成完整的网文创作环境：

| 组件 | 类型 | 作用 |
| --- | --- | --- |
| **novel-assistant** 插件（唯一插件） | 动态 Cordis 插件（Host + Client） | 融合了「写作工具」与「阅览窗口」两部分：<br>① **23 个 `novel_*` 写作工具**（Host）：润色、续写、大纲整理/优化/续写、小说分析、拆书学习、灵感生成、世界观构建、角色设计、章节规划、场景写作、黄金三章、书名/标题、简介与梗概、作品评阅、改写、对话优化、文学翻译、剧情漏洞排查、起名、文风设定、情节推演——每个工具都会调用当前会话模型做**真正的文本生成**；<br>② **小说阅览窗口**（Host 文件读写 RPC + Client 浮动窗口 UI）：浏览 / 查看 / 编辑 / 复制工作区文本文件，左列文件列表（自动刷新、可进子目录），右列阅读编辑区（中文字体优化、自动换行无横向滚动），支持保存写回、一键复制、标题栏拖动、右边缘拉伸宽度。写小说时用来随时查看 Agent 产出的章节并人工微调。 |
| **小说助手（novelist）** Agent 预设 | 用户 Agent 预设（持久） | 以写小说为核心的人设 + 完整的《网文创作方法论》提示段（黄金三章法则、爽点公式、节奏钩子、伏笔闭环、长篇工程、成稿流程）；并**把 23 个写作工具内置进预设**（`novel-tools.mjs`）——任何会话选择该预设即自带全部写作能力，不依赖动态插件。同时保留标准工作台：文件读写、网页检索、子代理与工作流、目标与待办、计划模式。 |

## 二、目录结构

```
DSH-Novel/
├── README.md                      # 本说明
├── LICENSE                        # MIT 开源许可证
├── INSTALL.md                     # 安装指引（交给 Agent 执行，或手动参考）
├── plugins/                       # novel-assistant 插件源码
│   ├── novel-assistant.host.js    # Host 半部：23 个写作工具 + 阅览窗口文件读写 RPC
│   └── novel-assistant.client.js  # Client 半部：浮动阅览窗口 UI + 右上角开关按钮
└── agent-presets/
    └── novelist/                  # 「小说助手」Agent 预设（复制到 ~/.dsh/.agent-presets/novelist）
        ├── preset.yml             # 预设元数据（名称/描述）
        ├── agent.cordis.yml       # 组合文件（人设 + 标准工作台 + 内置工具行）
        └── plugins/
            └── novel-tools.mjs    # 预设内置的 23 个写作工具（自包含，随预设加载）
```

## 三、安装

### 方式一：交给 DSH 自动安装（推荐）

1. 把本仓库目录（或 GitHub 链接）交给任意 DeepSeek Harness Agent，例如：
   > “请把 DSH-Novel 项目安装到当前环境，按 INSTALL.md 执行。”
2. Agent 会按 `INSTALL.md` 依次完成：
   - 用 `cordis_define` + `cordis_run` 安装 **novel-assistant** 插件（Host + Client 合并版）；
   - 插件含浏览器界面，需要你在 **Run 卡片上点一次「允许」**；
   - 把 `agent-presets/novelist/` 复制到 DSH 用户预设根目录 `~/.dsh/.agent-presets/novelist`；
   - 用 `agentPresets.standingKeyFor('novelist')` 做挂载校验；
   - 完成后新建会话选择「小说助手」即可开始写作。

### 方式二：手动安装

见 `INSTALL.md` 中的逐条步骤（同一套内容，供手动执行）。

## 四、使用

- **日常写作**：新建会话 → 预设选择「**小说助手**」→ 直接对话：
  - “把这些素材整理成大纲，再规划第一卷 10 章”
  - “接着这篇正文续写 2000 字，结尾留钩子”
  - “帮我润色这段 / 拆解这段开篇学它的钩子写法”
- **查看与微调成稿**：网页右上角「📖 阅览」打开小说阅览窗口 → 点开 Agent 写好的章节文件查看 → 手动修改后点「💾 保存」→ 继续让 Agent 接着写，它会读到修改后的内容。
- **当前会话临时增强**：在任意会话安装 novel-assistant 动态插件（见 `INSTALL.md` 第 1 步），即可使用 novel_* 工具与阅览窗口。

## 五、说明

- **持久性（重要）**：
  - **23 个写作工具：持久**。「小说助手」预设已把它们内置（`novel-tools.mjs`），任何选择该预设的会话都自带全部写作能力，无需每次安装。
  - **小说阅览窗口：会话级**。浏览器 UI 依赖 DSH 的动态插件机制（`harness` 内建 + 包私有 RPC `host.call`），该机制设计上就是**进程级**的——进程重启后需重新安装一次（这是动态插件的工作方式，并非缺陷；安装只需一条指令，把项目交给 Agent 按 `INSTALL.md` 第 1 步执行即可自动重装）。
  - **为什么不做成部署级持久**：部署级持久要求把浏览器 UI 改写成 DSH 的 web 插件包（`dsh.client` 清单 + 平台模块导入的 bundle），并把文件操作 RPC 从动态插件专用的 `harness.handle`/`host.call` 改成 Remote 服务，同时修改本机部署组合——重写量大、绑定具体机器、且破坏「克隆即用」的可移植性。当前「预设持久 + 阅览窗口按需一条命令重装」是刻意选择的便携架构。
- **模型路由**：所有工具默认调用当前会话的默认模型，每个工具都支持传入 `provider` / `model` 覆盖；无默认模型时自动兜底到第一个可用提供方。
- **文件安全**：阅览窗口的读写严格限制在**当前会话工作区**内（`fs.contains` 边界校验 + 会话沙箱策略），不会越权访问其他目录。

## 六、维护

- 修改插件：编辑 `plugins/` 下两个源文件，在当前会话用 `cordis_define(kind: existing, pluginId)` 追加新 Package，再 `cordis_run` 更新；同时同步 `agent-presets/novelist/plugins/novel-tools.mjs` 中的工具改动（预设内置版）。
- 修改预设：编辑 `agent-presets/novelist/` 下文件，复制覆盖到 `~/.dsh/.agent-presets/novelist/`，并重新挂载校验。
- 卸载：动态插件 `cordis_stop` / `cordis_undefine`；预设删除 `~/.dsh/.agent-presets/novelist` 目录即可。

## 七、许可证

本项目使用 [MIT License](LICENSE)，© 2026 KurohaneKaoruko。你可以自由使用、修改、分发（含商用），但需保留版权与许可声明。
