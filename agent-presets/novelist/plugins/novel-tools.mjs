// 小说助手内置写作工具插件（随「小说助手」预设一起安装）
// -----------------------------------------------------------------------------
// 由 agent.cordis.yml 中的相对路径行 './plugins/novel-tools.mjs' 加载，因此
// 本文件是预设目录的一部分，随预设一起复制与分发。
//
// 本文件是「自包含」模块：不 import 任何外部包（预设目录位于用户主目录下，
// Node 的 node_modules 向上查找无法到达 DSH 安装目录），只使用 Cordis 上下文
// 提供的真实服务：ctx.tools.register() 注册模型工具、ctx.llm.stream() 完成
// 真正的文本生成、ctx.systemPrompt.section() 注册创作方法论提示段。
//
// 它注册 23 个 novel_* 网文写作工具，覆盖：润色、续写、大纲整理/优化/续写、
// 小说分析、拆书学习、灵感生成、世界观构建、角色设计、章节规划、场景写作、
// 黄金三章、书名/标题、简介与梗概、作品评阅、改写、对话优化、文学翻译、
// 剧情漏洞排查、起名、文风设定、情节推演。
export default {
  name: 'novel-tools',
  inject: ['llm', 'tools', 'systemPrompt'],
  apply(ctx) {
    const disposers = [];

    // ---------------- 共享工具函数 ----------------

    // 把声明式参数 DSL 编译为原始 JSON Schema（供模型可见的 parameters 使用）
    function compileParams(spec) {
      const properties = {};
      const required = [];
      for (const key of Object.keys(spec)) {
        const prop = { ...spec[key] };
        if (prop.required === true) {
          required.push(key);
          delete prop.required;
        }
        properties[key] = prop;
      }
      return { type: 'object', properties, required };
    }

    // 解析模型路由：用户显式指定 > 会话默认模型 > 第一个可用提供方
    async function resolveRoute(args) {
      const given = args && typeof args === 'object' ? args : {};
      if (typeof given.provider === 'string' && given.provider && typeof given.model === 'string' && given.model) {
        return { provider: given.provider, model: given.model };
      }
      const def = ctx.get('agentDefaultModel');
      if (def !== undefined) {
        try {
          const sel = def.currentSelection();
          if (sel && typeof sel.provider === 'string' && sel.provider && typeof sel.model === 'string' && sel.model) {
            const route = { provider: sel.provider, model: sel.model };
            if (typeof sel.reasoningEffort === 'string' && sel.reasoningEffort) route.reasoningEffort = sel.reasoningEffort;
            return route;
          }
        } catch (err) { /* 继续走兜底路径 */ }
      }
      const providers = ctx.llm.listProviders();
      if (!providers.length) throw new Error('没有可用的模型提供方（provider），请在设置中先配置模型。');
      const provider = providers[0].id;
      let models = [];
      try { models = await ctx.llm.listModels(provider); } catch (err) { /* 忽略 */ }
      if (!models.length) throw new Error(`提供方「${provider}」没有可用模型，请先在设置中配置模型。`);
      return { provider, model: models[0].id };
    }

    // 调用 LLM 完成一次生成，返回纯文本
    async function generate(system, user, args, exec, opts) {
      const route = await resolveRoute(args);
      const messages = [{
        id: `novel-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
        role: 'user',
        content: [{ type: 'text', text: user }],
        source: { kind: 'plugin', plugin: 'novel-tools' },
      }];
      const options = {
        provider: route.provider,
        model: route.model,
        messages,
        system,
        signal: exec.signal,
      };
      if (route.reasoningEffort) options.reasoningEffort = route.reasoningEffort;
      if (opts && opts.maxTokens !== undefined) options.maxTokens = opts.maxTokens;

      let out = '';
      let failure = null;
      try {
        for await (const chunk of ctx.llm.stream(options)) {
          if (chunk.type === 'text-delta') out += chunk.text;
          else if (chunk.type === 'finish') {
            if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
              failure = (chunk.reason.failure && chunk.reason.failure.message) || chunk.reason.kind;
            }
          }
        }
      } catch (err) {
        if (exec.signal.aborted) throw new Error('任务已被取消。');
        throw new Error(`模型调用出错：${err && err.message ? err.message : String(err)}`);
      }
      if (failure) throw new Error(`模型调用失败：${failure}`);
      if (!out || !out.trim()) throw new Error('模型没有返回任何文本，请重试或更换模型。');
      return out.trim();
    }

    function field(label, value) {
      if (value === undefined || value === null || value === '') return '';
      const v = Array.isArray(value) ? value.join('、') : String(value);
      return `【${label}】\n${v}`;
    }
    function compose(parts) { return parts.filter((p) => p && p.trim()).join('\n\n'); }
    function pick(v, fallback) {
      if (Array.isArray(v) && v.length) return v;
      if (typeof v === 'string' && v.trim()) return v.split(/[,，、\s]+/).filter(Boolean);
      return fallback;
    }

    const commonSystem = `你是一位服务网络小说作者的职业写作助手，精通中文网文创作技巧：黄金三章、爽点设计、节奏把控、人物弧光、悬念伏笔、对话艺术与画面感营造。

通用原则：
1. 尊重作者意图：除非任务明确要求，否则绝不擅自改变已有情节、人物设定与既定事实。
2. 输出高质量、可直接使用的中文文本；网文特点：开篇抓人、节奏明快、爽点清晰、情绪到位、每章收尾有钩子。
3. 用 Markdown 组织输出，结构清晰；解释部分简明扼要。
4. 涉及改写/续写时，保持与原文一致的连贯性、人物语气与叙事视角。

【去 AI 味 · 写作红线】（正文一律遵守，宁可平淡也不要 AI 腔）：
1. 禁用万能套话：如「在这个……的世界里」「他不知道的是」「时间仿佛凝固」「空气瞬间安静」「眼底闪过一丝」「嘴角勾起一抹」「这一刻，世界都安静了」「然而事情远没有这么简单」。
2. 具体代替抽象：少写「他很生气」这类概括，用动作、眼神、语气、小动作让读者自己看见；用名词和动词承载，形容词副词能省则省。
3. 拒绝堆砌：不连续堆四字词，不用排比撑场面，不滥用「缓缓」「轻轻」「微微」。
4. 少解释多留白：别在每个动作后补心理分析，内心戏只在关键处给一两句；留白让读者自己脑补。
5. 对话像人话：口语化、有口癖、有停顿、有答非所问，别让每个人物都像念书面报告。
6. 结构长短错落：长短句、长短段交替；允许平淡过渡，别陷入「动作—心理—结论」的循环。
7. 视角稳定：紧跟主角，不随时切上帝视角解释设定。
8. 正文禁止 markdown 符号、emoji、成串破折号与解释性插入语。`;

    // 每个工具都支持的可选路由参数
    const routeParams = {
      provider: { type: 'string', description: '可选：指定模型提供方（默认使用当前会话的默认模型）' },
      model: { type: 'string', description: '可选：指定模型名称（默认使用当前会话的默认模型）' },
    };

    // 工具注册工厂：spec = { name, description, parameters, system, user, opts?, timeoutMs? }
    function tool(spec) {
      const def = {
        name: spec.name,
        description: spec.description,
        parameters: compileParams(spec.parameters),
        ...(spec.timeoutMs ? { timeoutMs: spec.timeoutMs } : {}),
        output: {
          schema: { type: 'object', properties: { result: { type: 'string' } }, additionalProperties: false },
          render(args, value) { return [{ type: 'text', text: value.result }]; },
        },
        async execute(args, exec) {
          const system = typeof spec.system === 'function' ? spec.system(args) : spec.system;
          const user = typeof spec.user === 'function' ? spec.user(args) : spec.user;
          const result = await generate(system, user, args, exec, spec.opts || {});
          return { result };
        },
      };
      disposers.push(ctx.tools.register(def));
    }

    // ---------------- 1. 小说润色 ----------------
    tool({
      name: 'novel_polish',
      description: '润色小说片段：提升文笔、画面感、节奏与对话质量，同时严格保留情节、人设与事实。用户想改文笔、修语病、让文字更有画面感或更顺滑时使用。',
      timeoutMs: 180000,
      parameters: {
        ...routeParams,
        text: { type: 'string', description: '需要润色的原文（一段、一章或整篇）', required: true },
        style: { type: 'string', enum: ['保持原风格', '细腻精致', '简洁明快', '网文节奏', '厚重史诗'], description: '目标文风，默认保持原风格' },
        intensity: { type: 'string', enum: ['轻微润色', '中度润色', '深度重写'], description: '润色力度，默认中度润色' },
        requirements: { type: 'string', description: '额外要求，如「加强画面感」「保留口语感」「多用短句」等' },
        preserve: { type: 'string', description: '必须保持不变的内容：情节节点、专有名词、人物姓名、事实设定等' },
      },
      system: (args) => `${commonSystem}

你现在担任资深网文编辑，负责润色作者稿件。

润色要求：
1. 先通读原文，把握情节、人物与情绪基调，再动手。
2. 按「润色力度」执行：轻微=只修语病、错别字、重复与衔接；中度=在轻微基础上提升描写画面感、对话自然度与节奏（长短句搭配）；深度=在保持情节与人设的前提下重写段落，使文笔显著提升。
3. 严格保留：情节走向、人物言行逻辑、专有名词、时间地点、事实设定（见「必须保留的内容」）。
4. 网文向：画面感强（调动五感）、情绪到位、读起来顺滑，避免翻译腔与欧化长句。

输出格式（Markdown）：
## 润色结果
（润色后的完整文本，直接可复制使用）
## 修改要点
（逐条列出主要修改及原因，每条一行，简明）`,
      user: (args) => compose([
        field('待润色原文', args.text),
        field('目标文风', args.style),
        field('润色力度', args.intensity),
        field('额外要求', args.requirements),
        field('必须保留的内容', args.preserve),
      ]),
      opts: { maxTokens: 8000 },
    });

    // ---------------- 2. 小说续写 ----------------
    tool({
      name: 'novel_continue',
      description: '续写小说正文：承接用户提供的最新正文继续往下写，可结合大纲与设定，自动保持视角、人物与文风一致，结尾留钩子。',
      timeoutMs: 180000,
      parameters: {
        ...routeParams,
        text: { type: 'string', description: '已写的正文（从断点处开始续写）', required: true },
        outline: { type: 'string', description: '当前大纲/细纲，帮助保持一致（可选）' },
        setting: { type: 'string', description: '世界观与人物设定（可选）' },
        direction: { type: 'string', description: '下一步剧情方向或目标（可选）' },
        length: { type: 'integer', description: '期望输出的大致字数（可选）' },
        style: { type: 'string', description: '风格要求（可选）' },
      },
      system: (args) => `${commonSystem}

你现在担任资深网文作者，负责续写正文。

续写要求：
1. 严格承接上文：延续视角、人物、地点、时间与情绪状态，不重复上文已写内容，开头直接推进情节。
2. 遵守大纲与设定：若有大纲/设定，不得与其矛盾；若没有，则顺着上文自然发展。
3. 若给出「下一步剧情方向」，优先朝该方向推进；否则选择最合理且最有看点的走向。
4. 网文向：每段有推进，情绪递进，结尾留钩子（悬念/期待/情绪余韵）。
5. 直接输出续写正文，不要输出任何前言、说明或标题解释。`,
      user: (args) => compose([
        field('已写正文（从此处续写）', args.text),
        field('当前大纲', args.outline),
        field('世界观与人物设定', args.setting),
        field('下一步剧情方向', args.direction),
        args.length ? `【目标字数】约 ${args.length} 字` : '',
        field('风格要求', args.style),
      ]),
      opts: { maxTokens: 8000 },
    });

    // ---------------- 3. 大纲整理 ----------------
    tool({
      name: 'novel_outline_organize',
      description: '大纲整理：把零散的想法、素材、笔记整理成结构化大纲（支持三幕式/起承转合/卷-章结构/主线+支线/自由结构）。',
      timeoutMs: 150000,
      parameters: {
        ...routeParams,
        notes: { type: 'string', description: '零散的想法、素材、笔记', required: true },
        format: { type: 'string', enum: ['三幕式', '起承转合', '卷-章结构', '主线+支线', '自由结构'], description: '目标大纲结构，默认卷-章结构' },
        genre: { type: 'string', description: '题材类型（可选）' },
      },
      system: (args) => `${commonSystem}

你现在担任网文大纲整理专家，负责把作者零散的素材整理成结构化大纲。

要求：
1. 先归类素材：主线事件、支线、人物、设定、灵感片段等。
2. 按「目标结构」组织：三幕式（开端-发展-高潮/结局）、起承转合、卷-章结构（卷名+章名+每章要点/钩子/爽点）、主线+支线（分别列出并标注交织点）、自由结构。
3. 保留作者原意，不擅自添加离谱设定；素材不明确处保留并标注【待定】。
4. 输出可直接作为写作依据的清晰大纲。`,
      user: (args) => compose([
        field('零散素材/笔记', args.notes),
        field('目标结构', args.format),
        field('题材类型', args.genre),
      ]),
      opts: { maxTokens: 6000 },
    });

    // ---------------- 4. 大纲优化 ----------------
    tool({
      name: 'novel_outline_optimize',
      description: '大纲优化：审查并改进现有大纲的节奏、冲突、悬念、爽点密度、人物弧光、伏笔回收与逻辑问题，输出优化后大纲及修改说明。',
      timeoutMs: 180000,
      parameters: {
        ...routeParams,
        outline: { type: 'string', description: '待优化的大纲', required: true },
        focus: { type: 'array', items: { type: 'string', enum: ['节奏', '冲突', '悬念', '人物弧光', '爽点密度', '伏笔回收', '逻辑自洽'] }, description: '优化重点，默认全部' },
        depth: { type: 'string', enum: ['轻量建议', '深度重构'], description: '优化深度，默认深度重构' },
      },
      system: (args) => `${commonSystem}

你现在担任网文主编，负责优化大纲。

优化要求：
1. 从「优化重点」逐项审查现有大纲，找出问题：节奏（拖沓/赶工）、冲突薄弱、悬念缺失或断链、爽点密度不足、伏笔无回收、人物弧光缺失、逻辑不自洽。
2. 对每个问题给出：问题定位 → 具体优化方案（可执行的新安排）。
3. 「深度重构」时输出重构后的完整大纲（含改动标记），并附优化说明；「轻量建议」时只输出问题清单与针对性建议，不改动原大纲。
4. 网文向：确保每卷/每章有推进、有钩子、有情绪点。`,
      user: (args) => compose([
        field('现有大纲', args.outline),
        field('优化重点', pick(args.focus, ['节奏', '冲突', '悬念', '人物弧光', '爽点密度', '伏笔回收', '逻辑自洽'])),
        field('优化深度', args.depth),
      ]),
      opts: { maxTokens: 6000 },
    });

    // ---------------- 5. 大纲续写 ----------------
    tool({
      name: 'novel_outline_extend',
      description: '大纲续写：在现有大纲基础上延伸下一卷、下一章、支线剧情或全书完本规划，保持设定与叙事走向一致。',
      timeoutMs: 150000,
      parameters: {
        ...routeParams,
        outline: { type: 'string', description: '现有大纲', required: true },
        target: { type: 'string', enum: ['下一卷', '下一章', '支线剧情', '全书完本', '新副本'], description: '续写目标，默认下一卷' },
        length: { type: 'string', enum: ['简短续写', '标准续写', '详细续写'], description: '详细程度，默认标准续写' },
        constraints: { type: 'string', description: '额外约束（可选）' },
      },
      system: (args) => `${commonSystem}

你现在担任网文大纲续写专家，负责在现有大纲基础上延伸剧情。

要求：
1. 严格遵循现有大纲的风格、人物、设定与叙事走向，新内容不得与已有内容矛盾。
2. 根据「续写目标」延伸：下一卷（规划新卷的卷名、目标、分章要点与卷末高潮）、下一章（细化下一章的推进与钩子）、支线剧情（设计独立但能回收的支线）、全书完本（规划收尾节奏与结局）、新副本（设计新地图/副本的目标与机制）。
3. 每段新内容都要有明确推进目标和结尾钩子。
4. 按「详细程度」控制颗粒度。`,
      user: (args) => compose([
        field('现有大纲', args.outline),
        field('续写目标', args.target),
        field('详细程度', args.length),
        field('额外约束', args.constraints),
      ]),
      opts: { maxTokens: 6000 },
    });

    // ---------------- 6. 小说分析 ----------------
    tool({
      name: 'novel_analyze',
      description: '小说分析：从人物、情节、节奏、文笔、爽点、悬念、主题、市场潜力等维度系统分析一部小说（自己的稿子或别人的作品），输出结构化报告。',
      timeoutMs: 180000,
      parameters: {
        ...routeParams,
        text: { type: 'string', description: '要分析的小说文本（片段或全文）', required: true },
        aspect: { type: 'array', items: { type: 'string', enum: ['人物塑造', '情节结构', '节奏把控', '文笔语言', '爽点设计', '悬念伏笔', '主题立意', '对话水平', '市场潜力'] }, description: '分析维度，默认全部' },
        title: { type: 'string', description: '作品名称（可选）' },
      },
      system: (args) => `${commonSystem}

你现在担任资深小说编辑与文学评论家，负责分析小说文本。

要求：
1. 从「分析维度」系统分析，优点与问题并重，避免空话套话。
2. 每个结论尽量给出文本依据（引用原文短句）。
3. 若提供作品名，报告中注明。
4. 网文向分析时，额外评估：市场定位、目标读者、题材热度与商业化潜力（付费点/改编空间）。
5. 输出结构化报告：总评（一句话+评分，10 分制）→ 分维度分析 → 核心优势 → 主要问题 → 改进建议。`,
      user: (args) => compose([
        field('作品名称', args.title),
        field('分析文本', args.text),
        field('分析维度', pick(args.aspect, ['人物塑造', '情节结构', '节奏把控', '文笔语言', '爽点设计', '悬念伏笔', '主题立意', '对话水平', '市场潜力'])),
      ]),
      opts: { maxTokens: 6000 },
    });

    // ---------------- 7. 拆书学习 ----------------
    tool({
      name: 'novel_deconstruct',
      description: '拆书学习：像写作教练一样拆解优秀文本，提炼开篇钩子、章节结构、爽点、人物塑造、对话技巧、悬念伏笔等可复用技法与模板。',
      timeoutMs: 180000,
      parameters: {
        ...routeParams,
        text: { type: 'string', description: '要拆解的文本', required: true },
        focus: { type: 'string', enum: ['开篇钩子', '章节结构', '爽点设计', '人物塑造', '对话技巧', '悬念与伏笔', '节奏与转场'], description: '拆解重点，默认章节结构' },
        depth: { type: 'string', enum: ['表层分析', '深度拆解'], description: '拆解深度，默认深度拆解' },
        reusable: { type: 'boolean', description: '是否提取可复用的写作模板（默认提取）' },
      },
      system: (args) => `${commonSystem}

你现在担任拆书教练，专门帮作者从优秀作品中学习写作技法。

要求：
1. 按「拆解重点」剖析文本：开篇钩子（前 N 字如何抓人）、章节结构（节拍/转折/收尾）、爽点设计（情绪起伏机制）、人物塑造（出场/反差/成长）、对话技巧（潜台词/性格化）、悬念与伏笔（铺设-发酵-回收）、节奏与转场。
2. 输出两部分：
   - 结构拆解：文本的组织方式与手法分析；
   - 技法清单：把每个手法抽象成「可复用模板」，并给出「何时用/怎么用/示例」。
3. 「表层分析」侧重直接观察；「深度拆解」额外追问手法为何有效、能迁移到哪些题材。`,
      user: (args) => compose([
        field('拆解文本', args.text),
        field('拆解重点', args.focus),
        field('拆解深度', args.depth),
        args.reusable === false ? '' : '【额外要求】请同时提取可复用的写作模板，并附示例。',
      ]),
      opts: { maxTokens: 6000 },
    });

    // ---------------- 8. 灵感生成 ----------------
    tool({
      name: 'novel_idea',
      description: '灵感生成：基于题材、关键词与创作约束，生成差异化的小说创意（每个含一句话核心、主角、核心冲突、独特卖点与爽点方向）。',
      timeoutMs: 120000,
      parameters: {
        ...routeParams,
        genre: { type: 'string', description: '题材类型，如玄幻/都市/科幻/历史/言情/无限流等（可选）' },
        seeds: { type: 'string', description: '灵感种子/关键词，逗号分隔（可选）' },
        count: { type: 'integer', description: '生成创意数量，默认 5' },
        constraints: { type: 'string', description: '创作约束，如「无后宫」「单女主」「轻松日常」（可选）' },
      },
      system: (args) => `${commonSystem}

你现在担任网文创意策划，负责生成差异化的小说创意。

要求：
1. 基于「题材类型」与「灵感种子」构思，避免烂大街的同质化设定。
2. 每个创意包含：一句话核心（logline）、主角设定一句话、核心冲突、独特卖点、3 个可写的爽点/看点方向。
3. 遵守「创作约束」（如无后宫、单女主、轻松日常等）。
4. 数量按要求输出，宁可少而精，不要注水凑数。`,
      user: (args) => compose([
        field('题材类型', args.genre),
        field('灵感种子/关键词', args.seeds),
        args.count ? `【生成数量】${args.count} 个` : '',
        field('创作约束', args.constraints),
      ]),
      opts: { maxTokens: 3000 },
    });

    // ---------------- 9. 世界观构建 ----------------
    tool({
      name: 'novel_worldbuilding',
      description: '世界观构建：设计自洽且有延展性的小说世界观，支持力量体系、地理、势力、历史、文化、经济、社会规则等模块，规则自带边界与代价。',
      timeoutMs: 150000,
      parameters: {
        ...routeParams,
        genre: { type: 'string', description: '题材类型（可选）' },
        premise: { type: 'string', description: '核心设定/故事前提（可选）' },
        aspect: { type: 'array', items: { type: 'string', enum: ['力量体系', '地理格局', '势力组织', '历史脉络', '文化民俗', '科技水平', '经济体系', '社会规则'] }, description: '构建模块，默认力量体系+地理格局+势力组织' },
        depth: { type: 'string', enum: ['简略', '标准', '详尽'], description: '详细程度，默认标准' },
      },
      system: (args) => `${commonSystem}

你现在担任世界观构建师，负责设计自洽且有延展性的小说世界观。

要求：
1. 按「构建模块」逐一设计，模块之间互相呼应、逻辑自洽。
2. 力量/规则体系必须有清晰的边界与代价（越强限制越多），避免无敌与崩坏。
3. 每个模块给出：核心规则 → 关键设定条目 → 对剧情的可用性提示（哪些设定可以当钩子/冲突源）。
4. 按「详细程度」控制篇幅；输出结构化文档，善用列表与表格。`,
      user: (args) => compose([
        field('题材类型', args.genre),
        field('核心前提', args.premise),
        field('构建模块', pick(args.aspect, ['力量体系', '地理格局', '势力组织'])),
        field('详细程度', args.depth),
      ]),
      opts: { maxTokens: 6000 },
    });

    // ---------------- 10. 角色设计 ----------------
    tool({
      name: 'novel_character',
      description: '角色设计：生成立体完整的人物卡（基本信息、性格、动机、弧光、口头禅、台词风格、弱点等），支持主角、反派、配角等定位，可一次生成多个差异化角色。',
      timeoutMs: 150000,
      parameters: {
        ...routeParams,
        role: { type: 'string', enum: ['主角', '女主/男主', '反派', '重要配角', '主角团成员', '群像配角'], description: '角色定位，默认主角' },
        traits: { type: 'string', description: '已有性格/特征/关键词（可选）' },
        archetype: { type: 'string', description: '原型/标签，如「废柴逆袭」「高冷男神」（可选）' },
        story: { type: 'string', description: '故事背景（可选）' },
        count: { type: 'integer', description: '生成角色数量，默认 1' },
      },
      system: (args) => `${commonSystem}

你现在担任角色设计专家，负责塑造立体、有记忆点的小说角色。

要求：
1. 每个角色包含：基本信息（姓名/年龄/身份/外貌）、性格（3-5 个核心特质 + 1-2 个内在矛盾）、动机（欲望/目标 + 恐惧）、能力与限制、人物弧光（初始状态→关键变化→终态）、口头禅与习惯动作、台词风格、关键关系、弱点与黑历史。
2. 反派也要有自洽动机，不脸谱化；配角要有独立欲望。
3. 角色要「可用」：每个特质都能转化为剧情冲突或看点。
4. 一次生成多个角色时，彼此差异化、关系可交织。`,
      user: (args) => compose([
        field('角色定位', args.role),
        field('已有特征/关键词', args.traits),
        field('原型/标签', args.archetype),
        field('故事背景', args.story),
        args.count ? `【生成数量】${args.count} 个` : '',
      ]),
      opts: { maxTokens: 6000 },
    });

    // ---------------- 11. 章节规划 ----------------
    tool({
      name: 'novel_chapter_plan',
      description: '章节规划：把一段剧情弧线拆解成逐章计划，每章含章名、本章目标、事件/场景流、开篇钩子、结尾钩子、爽点/情绪点与伏笔布置。',
      timeoutMs: 150000,
      parameters: {
        ...routeParams,
        arc: { type: 'string', description: '本卷/本段剧情目标与内容', required: true },
        chapters: { type: 'integer', description: '章节数，默认 10' },
        hook: { type: 'string', description: '本卷核心悬念/高潮（可选）' },
        goal: { type: 'string', enum: ['稳推进度', '强爽点', '埋伏笔', '收束剧情', '过渡蓄力'], description: '规划目标，默认稳推进度' },
      },
      system: (args) => `${commonSystem}

你现在担任网文章节规划师，负责把剧情弧线拆解成可执行的章节计划。

要求：
1. 把「本卷剧情内容」拆成指定数量的章节，章节间要递进、不断链。
2. 每章给出：章名、本章目标（推进什么）、事件/场景流（3-5 步）、开篇钩子、结尾钩子、爽点/情绪点、伏笔布置（若需要）。
3. 根据「规划目标」调整：稳推进度（主线优先）、强爽点（爽点密度拉高）、埋伏笔（布置长线悬念）、收束剧情（回收伏笔与冲突）、过渡蓄力（埋线+情绪铺垫）。
4. 「核心悬念/高潮」必须得到铺设并指向高潮。`,
      user: (args) => compose([
        field('本卷剧情内容', args.arc),
        args.chapters ? `【章节数】${args.chapters} 章` : '',
        field('核心悬念/高潮', args.hook),
        field('规划目标', args.goal),
      ]),
      opts: { maxTokens: 6000 },
    });

    // ---------------- 12. 场景写作 ----------------
    tool({
      name: 'novel_scene_write',
      description: '场景写作：把一句话/一个场景要点扩写成完整场景正文，含明确目标、冲突、情绪变化、画面感与结尾钩子。',
      timeoutMs: 180000,
      parameters: {
        ...routeParams,
        beat: { type: 'string', description: '场景要点/一句话剧情，如「主角在拍卖会上打脸纨绔」', required: true },
        outline: { type: 'string', description: '相关大纲（可选）' },
        setting: { type: 'string', description: '人物与设定（可选）' },
        pov: { type: 'string', description: '叙事视角（可选）' },
        length: { type: 'integer', description: '目标字数（可选）' },
      },
      system: (args) => `${commonSystem}

你现在担任网文场景写手，负责把场景要点扩写成完整场景。

要求：
1. 场景必须有：明确目标（这场戏要达成什么）、冲突或张力（哪怕内心冲突）、情绪变化（起→落→余韵）。
2. 动作与心理描写结合，避免纯叙述流水账；画面感强（五感+细节）。
3. 对话符合人物性格与当前关系，承担信息或冲突。
4. 遵守大纲与设定，保持叙事视角一致。
5. 场景结尾留钩子或情绪余韵。直接输出正文，不输出说明。`,
      user: (args) => compose([
        field('场景要点', args.beat),
        field('相关大纲', args.outline),
        field('人物与设定', args.setting),
        field('叙事视角', args.pov),
        args.length ? `【目标字数】约 ${args.length} 字` : '',
      ]),
      opts: { maxTokens: 8000 },
    });

    // ---------------- 13. 黄金三章（开篇） ----------------
    tool({
      name: 'novel_opening',
      description: '黄金三章：从零创作或打磨小说开篇，遵循网文开篇法则（前300字抓人、首章给钩子与爽点），支持按起点/番茄/晋江/飞卢等平台调整调性。',
      timeoutMs: 180000,
      parameters: {
        ...routeParams,
        story: { type: 'string', description: '故事核心设定与主线', required: true },
        platform: { type: 'string', enum: ['通用', '起点', '番茄', '晋江', '飞卢', '纵横'], description: '目标平台，默认通用' },
        mode: { type: 'string', enum: ['从零创作开篇', '打磨现有开篇'], description: '工作模式，默认从零创作开篇' },
        current: { type: 'string', description: '已有开篇（打磨模式时提供）' },
        length: { type: 'integer', description: '每章目标字数（可选）' },
      },
      system: (args) => `${commonSystem}

你现在担任网文「黄金三章」专家，深谙各平台开篇法则。

开篇法则：
1. 前 300 字内交代主角身份处境并抛出异常/危机/金手指；前 1000 字内出现第一次冲突、爽点或强悬念；三章内完成「身份确立→异常危机→金手指/契机→第一次反击或期待建立」。
2. 禁忌：大段设定灌输、路人视角开场、慢热铺垫、出场人物过多、无信息量的日常。
3. 平台调性：起点重期待感与金手指爽点；番茄重快节奏与即时钩子；晋江重人设与情绪张力；飞卢重视觉化与脑洞。
4. 从零创作：直接写出符合法则的开篇章节；打磨现有：先逐条诊断问题，再给出重写版。
5. 输出：开篇正文（含章节划分）+ 创作思路说明（每个钩子/爽点的设计意图）。`,
      user: (args) => compose([
        field('故事核心设定与主线', args.story),
        field('目标平台', args.platform),
        field('工作模式', args.mode),
        args.length ? `【每章目标字数】约 ${args.length} 字` : '',
        field('已有开篇（打磨时提供）', args.current),
      ]),
      opts: { maxTokens: 8000 },
    });

    // ---------------- 14. 书名/标题生成 ----------------
    tool({
      name: 'novel_title',
      description: '书名/标题生成：根据故事卖点生成有传播力、有期待感的书名或章节标题，每个附推荐理由，支持多种风格与平台调性。',
      timeoutMs: 120000,
      parameters: {
        ...routeParams,
        summary: { type: 'string', description: '故事简介/核心卖点', required: true },
        style: { type: 'string', enum: ['网文爽文风', '文艺风', '悬念风', '古风', '科幻风', '轻松搞笑风'], description: '标题风格，默认网文爽文风' },
        platform: { type: 'string', enum: ['通用', '起点', '番茄', '晋江', '飞卢', '纵横'], description: '目标平台，默认通用' },
        count: { type: 'integer', description: '生成数量，默认 10' },
      },
      system: (args) => `${commonSystem}

你现在担任网文书名策划专家。

要求：
1. 标题要信息量大（一眼看出题材/金手指/看点）、好记、有期待感、贴合平台调性。
2. 每个标题附一句推荐理由。
3. 按「标题风格」调整：网文爽文风（直给金手指与爽点）、文艺风（意象化、留白）、悬念风（疑问与未知）、古风（典雅对仗）、科幻风（概念感）、轻松搞笑风（口语化谐趣）。
4. 避免与知名作品重名（给出时注意区分度）。`,
      user: (args) => compose([
        field('故事简介/核心卖点', args.summary),
        field('标题风格', args.style),
        field('目标平台', args.platform),
        args.count ? `【生成数量】${args.count} 个` : '',
      ]),
      opts: { maxTokens: 3000 },
    });

    // ---------------- 15. 简介与梗概 ----------------
    tool({
      name: 'novel_synopsis',
      description: '简介与梗概：撰写平台简介（300字内）、一句话简介、完整梗概、投稿大纲或版权推荐语，抓卖点与悬念，不剧透结局。',
      timeoutMs: 120000,
      parameters: {
        ...routeParams,
        summary: { type: 'string', description: '故事内容/核心卖点', required: true },
        kind: { type: 'string', enum: ['平台简介', '一句话简介', '完整梗概', '投稿大纲', '版权推荐语'], description: '输出类型，默认平台简介' },
        platform: { type: 'string', description: '目标平台（可选）' },
        tone: { type: 'string', description: '语气风格（可选）' },
      },
      system: (args) => `${commonSystem}

你现在担任网文简介写作专家。

要求（按输出类型）：
- 平台简介：300 字以内，先给卖点与悬念，再给主角与冲突，最后留钩子；不剧透结局；分段与断句要适合平台阅读。
- 一句话简介：20 字以内，凝练核心看点。
- 完整梗概：500-1000 字，按起承转合讲清主线。
- 投稿大纲：含作品定位、人物表、主线分卷概述、卖点分析。
- 版权推荐语：突出改编潜力与差异化卖点。
2. 语气按指定风格；平台不同可调整句式（番茄短句多、晋江情绪化、起点重设定钩子）。`,
      user: (args) => compose([
        field('故事内容/卖点', args.summary),
        field('输出类型', args.kind),
        field('目标平台', args.platform),
        field('语气风格', args.tone),
      ]),
      opts: { maxTokens: 3000 },
    });

    // ---------------- 16. 作品评阅 ----------------
    tool({
      name: 'novel_review',
      description: '作品评阅：对稿件进行专业审稿，给出评分、优点清单、按严重程度分级的问题清单（含修改方向）与修改优先级计划。',
      timeoutMs: 180000,
      parameters: {
        ...routeParams,
        text: { type: 'string', description: '待评阅的稿件', required: true },
        focus: { type: 'array', items: { type: 'string', enum: ['剧情', '人物', '文笔', '节奏', '爽点', '逻辑', '对话'] }, description: '评阅重点，默认全部' },
        tone: { type: 'string', enum: ['温和鼓励', '客观中立', '严格挑剔'], description: '评阅语气，默认客观中立' },
      },
      system: (args) => `${commonSystem}

你现在担任网文审稿编辑，负责评阅作者稿件。

要求：
1. 按「评阅语气」输出：温和鼓励（问题给足建设性）、客观中立（优点问题对半）、严格挑剔（按上稿标准挑刺）。
2. 报告结构：总评（10 分制评分 + 一句话结论）→ 优点清单 → 问题清单（每条标注严重程度：致命/重要/建议，并给出具体位置与修改方向）→ 修改优先级计划。
3. 网文向额外关注：前三章留存力、爽点密度、节奏、付费点设计。
4. 避免空话，每个问题要能直接指导修改。`,
      user: (args) => compose([
        field('待评阅稿件', args.text),
        field('评阅重点', pick(args.focus, ['剧情', '人物', '文笔', '节奏', '爽点', '逻辑', '对话'])),
        field('评阅语气', args.tone),
      ]),
      opts: { maxTokens: 6000 },
    });

    // ---------------- 17. 小说改写 ----------------
    tool({
      name: 'novel_rewrite',
      description: '小说改写：按模式改写文本（换视角/换人称/扩写/缩写/场景化/风格转换/古白互转），保持剧情与人设一致，输出改写结果及改动说明。',
      timeoutMs: 180000,
      parameters: {
        ...routeParams,
        text: { type: 'string', description: '原文', required: true },
        mode: { type: 'string', enum: ['换视角', '换人称', '扩写', '缩写', '场景化', '风格转换', '古风转白话', '白话转古风'], description: '改写模式', required: true },
        target: { type: 'string', description: '目标视角/人称/风格（模式需要时填写）' },
        requirements: { type: 'string', description: '其他要求（可选）' },
      },
      system: (args) => `${commonSystem}

你现在担任小说改写专家。

要求：
1. 按「改写模式」执行：
   - 换视角：如第三人称→第一人称（心理描写改主观表达）、反之（主观心理改客观呈现），保持信息量不流失；
   - 换人称：他/她/你/我之间切换，动词与称呼相应调整；
   - 扩写：丰富细节、心理、环境与情绪，但不得注水、不得改变剧情；
   - 缩写：保留骨架、关键情绪与信息，删冗余；
   - 场景化：把叙述性段落改写成场景+对话+动作；
   - 风格转换：按「目标风格」整体转换文风；
   - 古风转白话/白话转古风：互转时保持意思与韵味。
2. 保持剧情走向、人物行为逻辑与设定一致。
3. 输出：改写后文本 + 简短改写说明（主要改动点）。`,
      user: (args) => compose([
        field('原文', args.text),
        field('改写模式', args.mode),
        field('目标视角/人称/风格', args.target),
        field('其他要求', args.requirements),
      ]),
      opts: { maxTokens: 8000 },
    });

    // ---------------- 18. 对话优化 ----------------
    tool({
      name: 'novel_dialogue',
      description: '对话优化：让对话更符合人物性格与身份、更自然口语化、更有冲突与潜台词，输出优化后片段及逐处改动说明。',
      timeoutMs: 180000,
      parameters: {
        ...routeParams,
        text: { type: 'string', description: '含对话的原文片段', required: true },
        goal: { type: 'string', enum: ['性格鲜明', '强化冲突', '信息自然', '潜台词与留白', '口语化自然'], description: '优化目标，默认性格鲜明' },
        setting: { type: 'string', description: '人物性格/身份/关系（可选）' },
      },
      system: (args) => `${commonSystem}

你现在担任小说对话优化专家。

要求：
1. 让对话符合人物：性格（用词、句式、口头禅）、身份（文化水平、职业）、当前情绪与关系（亲疏、敌友、地位差）。
2. 让对话承载功能：推进信息、制造或升级冲突、暴露内心、埋潜台词；删掉寒暄与废话。
3. 善用潜台词与留白（言外之意），配合动作与神态描写增强表现力。
4. 口语化、自然，避免书面腔与舞台腔。
5. 输出：优化后片段 + 逐处改动说明（为什么这样改）。`,
      user: (args) => compose([
        field('原文片段', args.text),
        field('优化目标', args.goal),
        field('人物性格/关系', args.setting),
      ]),
      opts: { maxTokens: 6000 },
    });

    // ---------------- 19. 文学翻译 ----------------
    tool({
      name: 'novel_translate',
      description: '小说翻译：在中英及多语种之间做文学级翻译，支持忠实/意译/本地化三种模式，保留文风、语气与韵味，附专有名词处理说明。',
      timeoutMs: 180000,
      parameters: {
        ...routeParams,
        text: { type: 'string', description: '待翻译文本', required: true },
        target_lang: { type: 'string', enum: ['英文', '中文', '日文', '韩文', '法文', '德文', '西班牙文'], description: '目标语言', required: true },
        mode: { type: 'string', enum: ['忠实翻译', '意译传神', '本地化改写'], description: '翻译模式，默认意译传神' },
      },
      system: (args) => `${commonSystem}

你现在担任小说文学翻译专家。

要求：
1. 忠实模式：逐句对应，准确传达原意与信息。
2. 意译模式（默认推荐）：在忠实的基础上追求传神与可读性，保留文风、语气与情绪张力，符合目标语言的表达习惯。
3. 本地化模式：把文化意象、梗、语境改写成目标语言读者熟悉的形式，并附注释说明取舍。
4. 人名与专有名词：给出处理方案（音译/意译/保留）并简要说明。
5. 输出：译文 + 简短的翻译说明（专有名词处理、风格取舍、难点说明）。`,
      user: (args) => compose([
        field('待翻译文本', args.text),
        field('目标语言', args.target_lang),
        field('翻译模式', args.mode),
      ]),
      opts: { maxTokens: 6000 },
    });

    // ---------------- 20. 剧情漏洞排查 ----------------
    tool({
      name: 'novel_plot_hole',
      description: '剧情漏洞排查：检查时间线、人物动机、设定自洽、逻辑因果、伏笔回收、战力体系等问题，输出分级问题清单、修复建议与设定一致性检查表。',
      timeoutMs: 180000,
      parameters: {
        ...routeParams,
        story: { type: 'string', description: '故事现状/已写内容', required: true },
        outline: { type: 'string', description: '大纲（可选）' },
        setting: { type: 'string', description: '设定集（可选）' },
        focus: { type: 'array', items: { type: 'string', enum: ['时间线', '人物动机', '设定自洽', '逻辑因果', '伏笔回收', '战力体系'] }, description: '排查重点，默认全部' },
      },
      system: (args) => `${commonSystem}

你现在担任小说剧情逻辑审查员。

要求：
1. 按「排查重点」逐项核对：时间线（先后/时长/年龄）、人物动机（行为是否与性格目标一致）、设定自洽（力量体系/规则是否前后矛盾）、逻辑因果（事件链是否成立）、伏笔回收（铺设是否兑现或遗忘）、战力体系（强弱是否崩坏）。
2. 输出问题清单，每条含：【位置】【问题描述】【严重程度（高/中/低）】【修复建议】。
3. 最后给出「设定一致性检查表」，把关键设定与前后文对照结果列出。
4. 若未发现问题，明确说明「未发现明显漏洞」，并指出需要注意的薄弱点。`,
      user: (args) => compose([
        field('故事现状/已写内容', args.story),
        field('大纲', args.outline),
        field('设定集', args.setting),
        field('排查重点', pick(args.focus, ['时间线', '人物动机', '设定自洽', '逻辑因果', '伏笔回收', '战力体系'])),
      ]),
      opts: { maxTokens: 6000 },
    });

    // ---------------- 21. 起名工坊 ----------------
    tool({
      name: 'novel_name',
      description: '起名工坊：为角色、地名、门派/组织、功法、法宝、书名、章节名生成有寓意、有区分度的名字，每个附含义解释，支持多种风格。',
      timeoutMs: 120000,
      parameters: {
        ...routeParams,
        kind: { type: 'string', enum: ['角色名', '地名', '门派/组织名', '功法/技能名', '武器/法宝名', '书名', '章节名'], description: '命名类别', required: true },
        style: { type: 'string', enum: ['古风雅致', '西幻', '科幻未来', '现代都市', '网文热血', '仙侠出尘'], description: '风格，默认古风雅致' },
        theme: { type: 'string', description: '主题/意象/寓意提示（可选）' },
        gender: { type: 'string', enum: ['男', '女', '中性'], description: '性别（角色名时使用）' },
        count: { type: 'integer', description: '生成数量，默认 10' },
      },
      system: (args) => `${commonSystem}

你现在担任小说命名专家（角色名/地名/组织名/功法/法宝/书名/章节名）。

要求：
1. 名字要：贴合主题与意象、有寓意层次（可拆解出内涵）、音韵优美易读、避免生僻字与歧义联想、与同类名字区分度高。
2. 角色名需考虑性别、身份与时代/世界背景；功法与法宝名要有气势或巧思；书名需有传播力。
3. 每个名字附简短含义解释。
4. 按风格调整：古风雅致（典雅字眼）、西幻（音译感/史诗感）、科幻未来（概念词组合）、现代都市（简洁现实）、网文热血（力量感）、仙侠出尘（道韵缥缈）。`,
      user: (args) => compose([
        field('命名类别', args.kind),
        field('风格', args.style),
        field('主题/意象提示', args.theme),
        field('性别', args.gender),
        args.count ? `【生成数量】${args.count} 个` : '',
      ]),
      opts: { maxTokens: 3000 },
    });

    // ---------------- 22. 文风设定 ----------------
    tool({
      name: 'novel_style_guide',
      description: '文风设定：分析现有文本提炼「文风画像」，或从零创建一份小说风格指南（目标读者、语调、词汇表、句式、描写、对话、禁忌与示例）。',
      timeoutMs: 150000,
      parameters: {
        ...routeParams,
        sample: { type: 'string', description: '已有文风样本（分析模式时提供）' },
        genre: { type: 'string', description: '题材类型（可选）' },
        tone: { type: 'string', enum: ['热血', '轻松搞笑', '沉稳厚重', '细腻文艺', '冷峻悬疑', '甜宠'], description: '情绪基调，默认热血' },
        mode: { type: 'string', enum: ['分析现有文风', '创建风格指南'], description: '工作模式，默认创建风格指南' },
      },
      system: (args) => `${commonSystem}

你现在担任文风分析师与风格设计师。

分析模式（提供样本时）：
1. 提炼样本的：词汇偏好（常用词/雅俗度）、句式节奏（长短句比例/段落密度）、描写密度（动作/心理/环境占比）、对话风格（口语化程度/信息量）、情绪基调（热血/沉郁/诙谐）、叙事距离（全知/限知）。
2. 输出「文风画像」：一句话概括 + 分项特征 + 可模仿要点。

创建模式：
3. 产出风格指南：目标读者、总体语调、词汇表（偏好词/禁用词）、句式建议、描写原则、对话风格、情绪节奏、禁忌清单、风格参考例句（原创）。`,
      user: (args) => compose([
        field('已有文风样本', args.sample),
        field('题材类型', args.genre),
        field('情绪基调', args.tone),
        field('工作模式', args.mode),
      ]),
      opts: { maxTokens: 6000 },
    });

    // ---------------- 23. 情节推演 / 头脑风暴 ----------------
    tool({
      name: 'novel_brainstorm',
      description: '情节推演：针对剧情前提或写作困境，头脑风暴多个差异化方案（可能走向/反转/危机破局/人物抉择/伏笔设计/爽点强化），每个方案含收益与风险。',
      timeoutMs: 180000,
      parameters: {
        ...routeParams,
        premise: { type: 'string', description: '剧情前提/当前困境', required: true },
        angle: { type: 'array', items: { type: 'string', enum: ['多种可能走向', '反转设计', '危机与破局', '人物抉择', '伏笔设计', '爽点强化'] }, description: '思考角度，默认多种可能走向' },
        count: { type: 'integer', description: '方案数量，默认 5' },
        constraints: { type: 'string', description: '约束（可选）' },
      },
      system: (args) => `${commonSystem}

你现在担任情节推演与头脑风暴专家。

要求：
1. 基于「剧情前提/当前困境」生成多个可行方案。
2. 每个方案包含：一句话走向、关键转折点（怎么转）、情绪与爽点收益（读者体验）、风险与代价（剧情负担/逻辑压力）。
3. 按「思考角度」发散：多种可能走向、反转设计（让预期落空）、危机与破局、人物抉择（两难）、伏笔设计、爽点强化。
4. 方案之间差异化明显，避免同质；遵守「约束」。`,
      user: (args) => compose([
        field('剧情前提/当前困境', args.premise),
        field('思考角度', pick(args.angle, ['多种可能走向'])),
        args.count ? `【方案数量】${args.count} 个` : '',
        field('约束', args.constraints),
      ]),
      opts: { maxTokens: 6000 },
    });

    // ---------------- 创作方法论提示段 ----------------
    // 随预设注入 systemPrompt，确保即使 novel_* 工具不可用，Agent 也具备
    // 完整的网文创作方法论，可独立完成同等质量的创作任务。
    disposers.push(ctx.systemPrompt.section({
      name: 'novel:methodology',
      order: 50,
      text: `【网文创作方法论】——本助手内置的创作指南，任何时候都要遵守：

一、黄金三章与开篇
- 前 300 字交代主角身份处境并抛出异常/危机/金手指；前 1000 字内出现第一次冲突、爽点或强悬念；三章内完成「身份确立→异常危机→金手指→第一次反击/期待建立」。
- 禁忌：大段设定灌输、路人视角开场、慢热铺垫、出场人物过多。

二、爽点与情绪
- 每章至少一个情绪点：打脸、升级、收获、反转、暧昧、危机解除等。
- 爽点公式：压（铺垫憋屈）→ 转（契机）→ 爽（释放）→ 钩（新期待）。

三、节奏与钩子
- 长短章交替、张弛有度；每章结尾留钩子（悬念/期待/情绪余韵）；卷末留大高潮。

四、人物与对话
- 人物有欲望、恐惧与弧光；反派动机自洽；对话承担信息或冲突，符合身份与关系，善用潜台词与留白。

五、悬念与伏笔
- 伏笔「铺设-发酵-回收」闭环；重要伏笔记入伏笔清单，防止遗忘。

六、长篇工程
- 卷-章大纲先行；设定集与人物卡随写随更；战力/时间线/等级体系必须自洽，越强限制越多。

七、成稿流程
- 大纲 → 细纲/章节计划 → 场景写作/续写 → 润色 → 漏洞排查 → 评阅定稿。

八、去 AI 味（每次落笔与收尾自查）
- 检查万能套话与模板句，逐句删改；
- 检查抽象概括，换成具体细节；
- 检查心理独白是否过密，删到克制；
- 检查对话是否书面化，改口语；
- 检查结构是否均匀，打破「动作—心理—结论」的循环。`,
    }));

    return () => { for (const d of disposers) d(); };
  },
};
