# DSH-Novel · AI 写作

> 一个 Agent 预设，把 DeepSeek Harness 变成「AI 写小说」工作台：**6 个方法论 skill + 9 个工程化工具 + 确定性 AI 味检查**，全部随「小说助手」预设内置、持久可用。
> 把本仓库（或 GitHub 链接）交给任意 DeepSeek Harness Agent，按 `INSTALL.md` 执行即可自动安装完成。

---

## 一、这是什么

本项目只包含一件东西——**「小说助手」（novelist）Agent 预设**。它以写小说为核心，把 DSH 变成一位专业网文写作助手。

### 分工原则：创作任务交给 skill，工具只做代码擅长的事

Agent 本身就是 LLM——「参数拼提示词→一次子调用」的伪工具只会带来模型目录噪音。所以：

| 层 | 载体 | 负责什么 |
| --- | --- | --- |
| **常驻提示词**（薄） | `agent.cordis.yml` 人设 + 工作法路由段 | 身份、分工原则、每章硬流程闭环、skill/工具路由索引、硬纪律 |
| **skill**（6 个，按需加载） | `skills/` 目录 | **全部创作任务与方法论**：任务流程 + 领域知识。Agent 加载后亲自完成 |
| **工具**（9 个） | `plugins/novel-tools.mjs` | **只有代码能做的事**：确定性 lint、文件读写、上下文自动组装、多稿流水线、结构化解析 |

工具的 LLM 子调用是无状态新会话（看不到 Agent 已加载的 skill），因此插件启动时从 `skills/` 装载方法论包注入子调用——**skill 是方法论唯一事实源**，改 SKILL.md 同时改善 Agent 亲写与工具成稿两条路径。

### 6 个 skill

| skill | 何时加载 |
| --- | --- |
| `novel-prose-standards` | 写/改/润色/翻译/去AI味任何正文——正文铁律 + 各任务流程 |
| `novel-continuity` | 动笔前查设定、衔接前文、归档回填、漏洞排查 |
| `novel-plotting` | 总纲/卷纲/细纲/章节规划/情节推演/灵感/书名简介包装 |
| `novel-craft` | 场景写作/黄金三章/对话密集段/角色设计/角色采访 |
| `novel-analysis` | 小说分析/拆书/评阅/模拟读者团/合规体检/起名 |
| `novel-project` | 工程初始化/人物卡设定集建档/归档/索引/Obsidian |

### 9 个工具

`novel_lint`（AI 味确定性检查，纯代码秒回）、`novel_style_profile`（文风卡提取落盘）、`novel_continue`（自动衔接续写）、`novel_write_chapter`（单章成稿流水线）、`novel_briefing`（写前简报）、`novel_archive`（章后归档）、`novel_project`（作品工程）、`novel_import`（旧稿导入）、`novel_scan_book`（全书体检）。

### 针对长篇老大难问题的机制化解法

| 痛点 | 机制 |
| --- | --- |
| 忘记设定 | 成稿时**程序化读取**工程文件注入子调用（出场人物卡按细纲人名自动匹配），不靠模型记忆 |
| 无法衔接前文 | 自动读取工程里最新一章结尾（1000 字）+ 最近归档，开头按「场景/时间/情绪」三锚点承接 |
| 文风不一致 | **文风卡**：从基准章节提取结构化文风指纹落盘 `文风卡.md`，成稿自动注入对齐 |
| 节奏不一致 | 标准细纲模板（目标/事件序列/转折/爽点/钩子/伏笔操作结构化字段）+ 节奏量化参考 |
| AI 味重 | 可量化规则（破折号≤1、禁词表、副词频次、句式频次、比喻密度）交给**确定性代码 lint**；亲写正文走「写完 → novel_lint → 修复 → 复检」自检循环；write_chapter 内置 lint→定向修订环 |

## 二、目录结构

```
DSH-Novel/
├── README.md                      # 本说明
├── INSTALL.md                     # 安装指引（交给 Agent 执行，或手动参考）
├── LICENSE                        # MIT 开源许可证
└── novelist/                      # 「小说助手」Agent 预设（整目录复制到 ~/.dsh/.agent-presets/novelist）
    ├── preset.yml                 # 预设元数据（名称/描述）
    ├── agent.cordis.yml           # 组合文件（人设 + 标准工作台 + skills 目录挂载 + 内置工具行）
    ├── plugins/
    │   └── novel-tools.mjs        # 9 个工程化工具（编排逻辑 + lint 引擎 + 子调用提示分层）
    └── skills/                    # 方法论 skill（创作任务的唯一事实源）
        ├── novel-prose-standards/ #   正文铁律：去 AI 味 + 润色/改写/对话/翻译任务流程
        ├── novel-continuity/      #   设定一致性与前文衔接 + 漏洞排查
        ├── novel-plotting/        #   大纲细纲与节奏设计 + 规划类任务流程
        ├── novel-craft/           #   场景与对话写作技法 + 场景/开篇/采访任务流程
        ├── novel-analysis/        #   分析/拆书/评阅/读者团/合规/起名任务流程
        └── novel-project/         #   工程与落盘约定 + 人物卡/设定集建档模板
```

## 三、安装

### 方式一：交给 DSH 自动安装（推荐）

1. 把本仓库目录（或 GitHub 链接）交给任意 DeepSeek Harness Agent，例如：
   > “请把 DSH-Novel 项目安装到当前环境，按 INSTALL.md 执行。”
2. Agent 会按 `INSTALL.md` 完成：
   - 把 `novelist/` 目录复制到 DSH 用户预设根目录 `~/.dsh/.agent-presets/novelist`；
   - 用 `agentPresets.standingKeyFor('novelist')` 做挂载校验；
   - 完成后新建会话选择「小说助手」即可开始写作。

### 方式二：手动安装

见 `INSTALL.md` 中的逐条步骤（同一套内容，供手动执行）。

## 四、使用

写作时的体验：你像在跟一位编辑搭档聊稿子。说一句「继续写下一章」，助手先翻一遍工程里的材料——大纲、人物卡、伏笔清单、上一章结尾、文风卡——浓缩成写前简报；确认后按细纲成稿整章，草稿自动过确定性 AI 味检查、违规定向修订；你在 Obsidian 里过目、批注、改字句，再说「归档」，伏笔清单、时间线、人物状态随之更新，下一章自动带着最新状态继续推进。长篇写到几十章都不乱，靠的是这些随写随更的工程文件和程序化注入，而不是模型的记忆。

- **开新书**：“初始化作品工程《书名》”（`novel_project`，自动建全套目录 + 文风卡占位）→ 写 1-2 章定稿后 “从这几章提取文风卡”（`novel_style_profile`）
- **长篇连载（每章走一遍闭环）**：
  1. “生成第 3 章的写前简报”（`novel_briefing`）
  2. “按这份简报和细纲写第 3 章，写完保存”（`novel_write_chapter`，auto_context 自动注入，lint 修订环保证干净稿）
  3. “归档第 3 章”（`novel_archive`）
  4. 下一步只需说“继续写下一章”
- **已有存稿**：先 “把这份旧稿导入工程”（`novel_import`，自动分章落盘 + 逆推大纲/人物卡/设定集）
- **日常创作任务**（润色、大纲、拆书、起名、采访……）：直接说，助手加载对应 skill 亲自完成；写完正文自动走 novel_lint 自检循环
- **发布前**：“给这章做合规体检 / 让读者团试试”（skill 任务）；“给全书做个体检，抽 8 章扫一致性”（`novel_scan_book`）
- **搭配 Obsidian**：把工作区作为 Vault，成稿即笔记；双链构成设定网络，图谱视图查孤岛；批注后直接告诉助手「继续写」，它会读到你的修改。

## 五、说明

- **持久性**：整个项目就是一个 Agent 预设，随 `~/.dsh/.agent-presets/novelist` 持久存在——skill、工具、人设全部内置，进程重启、切换会话都不影响。
- **模型路由**：工具的 LLM 子调用默认用当前会话的默认模型，支持传入 `provider` / `model` 覆盖；无默认模型时自动兜底到第一个可用提供方。
- **去 AI 味（落笔即防 + 确定性兜底）**：成稿子调用注入完整正文铁律；可量化项由 lintText 纯代码检查（`novel_lint` 单独可用，亲写正文后也必走）；去味重写只用于处理外来文本与旧稿。

## 六、维护

- **改创作方法论/任务流程**：编辑 `novelist/skills/` 下的 SKILL.md——Agent 亲写与工具成稿两条路径同时生效，无需动代码。
- **改工具编排**（上下文组装、lint 规则、流程）：编辑 `novelist/plugins/novel-tools.mjs`。
- **改人设/组合**：编辑 `novelist/agent.cordis.yml`。
- 改完复制覆盖到 `~/.dsh/.agent-presets/novelist/`，并重新挂载校验（`agentPresets.standingKeyFor('novelist')`）。
- 卸载：删除 `~/.dsh/.agent-presets/novelist` 目录即可。

## 七、参考来源与致谢

本项目的方法论在持续迭代中参考了以下来源（均为模式与思路层面的借鉴，项目内文字与代码为独立撰写；未搬运任何付费或私有内容）：

- **[chinese-webnovel-skills（网文工坊）](https://github.com/tance-mang/chinese-webnovel-skills)**（MIT © tance-mang）——AI 味量化检测指标（句长波动、连续同句式、极端词密度等，已用独立实现落入 `novel_lint`）、深层人味/失控感方法论、打脸四拍、爽点升级链、语言指纹、show-don't-tell 外化通道、钩子类型库的思路。
- **[web-novel-writing-skill](https://github.com/XINGANLIU/web-novel-writing-skill)**（MIT © NovelForge AI Contributors）——「写前约束 → 写中引导 → 写后审查 → 长期记忆」四层防幻觉架构的印证（与本项目 auto_context → 铁律 → lint → archive 闭环同构）。
- **星月写作社区公开讨论**（论坛公开帖）——脑洞公式、毒点防火墙、开篇量化指标（每 400 字爽点/对话占比）、一句话总控百章框架、章节监控表、结构化评分审稿等来自社区创作者公开发布的方法论模式。

## 八、许可证

本项目使用 [MIT License](LICENSE)，© 2026 KurohaneKaoruko。你可以自由使用、修改、分发（含商用），但需保留版权与许可声明。
