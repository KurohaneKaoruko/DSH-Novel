// 小说助手内置工具插件（随「小说助手」预设一起安装）
// -----------------------------------------------------------------------------
// 由 agent.cordis.yml 中的相对路径行 './plugins/novel-tools.mjs' 加载，因此
// 本文件是预设目录的一部分，随预设一起复制与分发。
//
// 架构（skill 承载任务，工具只做代码擅长的事）：
// - 创作任务（润色/大纲/拆书/评阅/对话/采访/合规……）全部由 Agent 加载对应
//   skill 后亲自完成——Agent 本身就是 LLM，伪工具（参数拼提示词→一次子调用）
//   只会带来模型目录噪音与维护负担。skills/ 是任务指南的唯一事实源。
// - 本文件只保留 9 个「代码做提示词做不到的事」的工具：
//   · novel_lint           确定性 AI 味检查（纯代码规则，秒回不耗模型）
//   · novel_style_profile  文风卡提取 + 落盘（长篇文风一致的机制保障）
//   · novel_continue       续写（自动读取工程上一章结尾/文风卡/伏笔清单）
//   · novel_write_chapter  单章成稿流水线（auto_context 自动注入工程材料
//                          → 草稿 → lint 修订环 → 终检 → 可选落盘）
//   · novel_briefing       写前简报（多文件组装浓缩）
//   · novel_archive        章后归档（===SECTION=== 结构化解析 + 表格更新）
//   · novel_project        作品工程（初始化/保存/伏笔清单/时间线/统计/索引）
//   · novel_import         旧稿导入（分章落盘 + 逆推大纲/人物卡/设定集）
//   · novel_scan_book      全书体检（跨章材料组装 + 一致性扫描）
// - 这些工具的 LLM 子调用是无状态新会话，看不到 Agent 已加载的 skill，因此
//   启动时从 ../skills/ 装载方法论包注入子调用——与 Agent 亲写路径同源。
//
// 只使用 Node 内建模块与 Cordis 上下文服务（不 import 外部 npm 包，预设目录
// 在用户主目录下无法解析 node_modules）。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ---------------- skill 装载（方法论单一事实源） ----------------
// 读取预设 skills/ 目录下的 SKILL.md，剥掉 YAML front-matter 取正文。
// skill 文件缺失时返回空串，工具退化为「身份基座 + 角色指令」仍可工作。
function loadSkillBody(name) {
  try {
    const raw = readFileSync(fileURLToPath(new URL(`../skills/${name}/SKILL.md`, import.meta.url)), 'utf8');
    return raw.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
  } catch (err) {
    return '';
  }
}
// 只装载子调用需要的三个包；craft/project 两个 skill 是 Agent 亲写专用
const SK = {
  prose: loadSkillBody('novel-prose-standards'),
  plotting: loadSkillBody('novel-plotting'),
  continuity: loadSkillBody('novel-continuity'),
};

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
    // 从 LLM 输出中按 ===NAME=== 分隔符提取小节（章后归档用）
    function extractSection(text, name) {
      const m = text.match(new RegExp(`===${name}===([\\s\\S]*?)(?:\\n===\\w+===|$)`));
      return m ? m[1].trim() : '';
    }
    // 章节文件名里的标题需要去掉文件系统不安全字符
    function safeName(name) {
      return String(name).replace(/[\\/:*?"<>|\r\n]/g, '').trim();
    }
    // 解析会话工作区根目录（novel_project 同款逻辑，抽出来共用）
    function workspaceRoot(exec, sp) {
      const session = exec && exec.agent ? exec.agent.session : undefined;
      return session && session.header && typeof session.header.cwd === 'string' && session.header.cwd
        ? session.header.cwd
        : (sp.workspaceRoot && sp.workspaceRoot.length ? sp.workspaceRoot : '.');
    }
    // 打开作品工程：读取（缺文件容错）、列 Markdown、写入三件套。工程目录约定：
    // 正文/（每章一个文件）、大纲/、设定集/、人物卡/、归档/、伏笔清单.md、时间线.md、README.md。
    // 各目录下由初始化生成的 说明.md 是脚手架，列目录时跳过。
    function openProject(fs, root, policy) {
      const readMaybe = async (rel, cap) => {
        try {
          const target = await fs.resolve(rel, { cwd: root });
          let text = await fs.readText(target);
          if (cap && text.length > cap) text = `${text.slice(0, cap)}\n…（已截断）`;
          return text;
        } catch (err) { return null; }
      };
      const listMd = async (dir) => {
        try {
          const target = await fs.resolve(dir, { cwd: root });
          const entries = await fs.listDir(target);
          return entries
            .filter((e) => e.type === 'file' && /\.md$/.test(e.name) && e.name !== '说明.md')
            .map((e) => e.name).sort();
        } catch (err) { return []; }
      };
      const write = async (rel, text) => {
        const target = await fs.resolve(rel, { cwd: root });
        await fs.writeText(target, text, undefined, undefined, policy);
        return rel;
      };
      // 章节文件按「第NNN章」序号排序取最新一篇；number 给定时取序号小于它的最后一章
      const latestChapter = async (number) => {
        const names = await listMd('正文');
        const parsed = names
          .map((n) => ({ n, num: parseInt((n.match(/^第(\d+)章/) || [])[1], 10) }))
          .filter((c) => !Number.isNaN(c.num) && (number === undefined || number === null || c.num < number));
        if (!parsed.length) return null;
        parsed.sort((a, b) => a.num - b.num);
        return parsed[parsed.length - 1].n;
      };
      const chapterTail = async (number, chars) => {
        const name = await latestChapter(number);
        if (!name) return null;
        const text = await readMaybe(`正文/${name}`);
        if (!text) return null;
        return { name, tail: text.length > chars ? text.slice(-chars) : text };
      };
      return { readMaybe, listMd, write, latestChapter, chapterTail };
    }
    // 保存一章正文到 正文/第NNN章-标题.md，返回相对路径
    async function saveChapterFile(fs, root, policy, num, title, body) {
      const file = `正文/第${String(num).padStart(3, '0')}章${title ? '-' + safeName(title) : ''}.md`;
      const target = await fs.resolve(file, { cwd: root });
      await fs.writeText(target, body, undefined, undefined, policy);
      return file;
    }
    // 解析文件系统执行上下文（fs 服务 + 工作区根 + 会话沙箱策略）；不可用时返回 null
    function fsContext(exec) {
      const fs = ctx.get('fs');
      const sp = ctx.get('sandboxPolicy');
      if (fs === undefined || sp === undefined) return null;
      const session = exec && exec.agent ? exec.agent.session : undefined;
      return { fs, root: workspaceRoot(exec, sp), policy: sp.resolve(session !== undefined ? { session } : {}) };
    }
    // 读取工程文风卡（不存在返回空串）；成稿工具注入为「文风参考」
    async function readStyleCard(proj) {
      try {
        const card = await proj.readMaybe('文风卡.md', 2500);
        return card && card.trim() ? card : '';
      } catch (err) { return ''; }
    }

    // ---------------- 确定性 AI 味检查（纯代码，不调用模型） ----------------
    // 把「正文铁律」中可量化的规则编译为计数/正则检查：能数出来的（标点、禁词、
    // 副词频次、句式频次、比喻密度、句长波动、同句式连用）交给代码逐条核对，
    // 模型自查只兜底不可量化项（视角越界、情绪标签、说明书腔）。
    // 返回 { hardCount, softCount, report }：hard=必须修的硬违规，soft=建议逐条核对。
    // 部分指标设计思路参考 MIT 开源项目 chinese-webnovel-skills（网文工坊，
    // github.com/tance-mang/chinese-webnovel-skills），实现为本项目独立编写；
    // 详见 README「参考来源与致谢」。
    function lintText(body) {
      const issues = [];
      const occurs = (w) => body.split(w).length - 1;
      const countRe = (re) => (body.match(re) || []).length;

      // 硬违规：标点纪律（整章级）
      const dash = countRe(/——/g);
      if (dash > 1) issues.push(['hard', `破折号（——）出现 ${dash} 次`, '整章上限 1 次，且只用于对话被打断']);
      const ellipsis = countRe(/……/g);
      if (ellipsis > 2) issues.push(['hard', `省略号（……）出现 ${ellipsis} 次`, '整章上限 2 次，只用于对话犹豫']);
      const semis = countRe(/；/g);
      if (semis > 0) issues.push(['hard', `正文出现分号 ${semis} 处`, '正文不用分号；一句话说不完拆成两句']);
      // 硬违规：感叹号按段（一段最多 1 个）
      const badPara = [];
      for (const p of body.split(/\n+/)) {
        if (!p.trim()) continue;
        const n = (p.match(/[！!]/g) || []).length;
        if (n > 1) badPara.push(p.trim().slice(0, 14));
      }
      if (badPara.length) issues.push(['hard', `${badPara.length} 个段落感叹号超过 1 个`, `如「${badPara[0]}…」`]);
      // 硬违规：标点堆砌情绪
      const stacked = countRe(/[？！]{2,}|[。]{3,}/g);
      if (stacked > 0) issues.push(['hard', `标点堆砌（？？/！！等）${stacked} 处`, '禁止用标点堆砌情绪']);
      // 硬违规：正文残留 Markdown
      if (/^#{1,6}\s|\*\*|```/.test(body)) issues.push(['hard', '正文残留 Markdown 符号（#/```/加粗）', '正文必须纯文本']);
      // 硬违规：简体网文标点规范——直角引号/英文引号/错误省略号/装饰符号
      const cornerQuotes = countRe(/[「」『』]/g);
      if (cornerQuotes > 0) issues.push(['hard', `直角引号「」『』出现 ${cornerQuotes} 处`, '简体网文用弯双引号""（嵌套用\'\'），不用直角引号']);
      const engQuotes = countRe(/["][^"\n]{1,40}["]/g);
      if (engQuotes > 0) issues.push(['hard', `疑似英文直引号 "…" 出现 ${engQuotes} 处`, '一律改为中文弯引号""']);
      const badEllipsis = countRe(/\.\.\.|。。。/g);
      if (badEllipsis > 0) issues.push(['hard', `错误省略号（.../。。。）出现 ${badEllipsis} 处`, '中文省略号用 ……（六点一个标点）']);
      const decorations = countRe(/[✦✨◆●★☆♦❖✳✴]/g);
      if (decorations > 0) issues.push(['hard', `装饰符号（✦✨◆★等）出现 ${decorations} 处`, '正文与标题一律不撒装饰符号，分隔用空行']);

      // 软违规：禁用词与模板化表达
      const banned = ['心中一沉', '瞳孔骤缩', '倒吸一口凉气', '后背发凉', '心脏漏跳', '指尖微颤', '眼底闪过', '嘴角勾起', '面色一变', '神色复杂', '眼中闪过', '时间仿佛凝固', '空气瞬间安静', '世界都安静', '远没有这么简单', '不知过了多久', '一室寂静', '难以言喻', '无法形容', '意味深长', '耐人寻味', '他不知道的是', '复杂的情绪', '眼眸', '薄唇'];
      const bannedHits = [];
      for (const w of banned) {
        const n = occurs(w);
        if (n > 0) bannedHits.push(`「${w}」×${n}`);
      }
      if (bannedHits.length) issues.push(['soft', '禁用词/模板化表达', bannedHits.join('、')]);
      // 软违规：万能量词
      const quantHits = [];
      for (const w of ['一丝', '一抹', '几分']) {
        const n = occurs(w);
        if (n > 0) quantHits.push(`「${w}」×${n}`);
      }
      if (quantHits.length) issues.push(['soft', '万能量词', `${quantHits.join('、')}（全砍）`]);
      // 软违规：副词频次（每词上限 2）
      const advHits = [];
      for (const w of ['缓缓', '轻轻', '微微', '不由得', '忍不住', '下意识地', '突然', '忽然', '猛地']) {
        const n = occurs(w);
        if (n > 2) advHits.push(`「${w}」×${n}`);
      }
      if (advHits.length) issues.push(['soft', '副词频次超限（每词上限 2 次）', advHits.join('、')]);
      // 软违规：极端词堆砌（密度制：每千字 ≤2）
      const kChars = Math.max(1, Math.round(body.replace(/\s+/g, '').length / 1000));
      const extreme = ['非常', '极其', '极大', '无比', '十分', '瞬间', '顿时', '刹那'];
      const extremeTotal = extreme.reduce((s, w) => s + occurs(w), 0);
      if (extremeTotal > kChars * 2) issues.push(['soft', `极端词 ${extremeTotal} 个（约 ${kChars} 千字）`, '密度应 ≤2/千字；程度靠具体画面给，删九成']);
      // 软违规：句式频次
      const buShi = countRe(/不是[^。！？\n]{0,30}而是/g);
      if (buShi > 1) issues.push(['soft', `「不是……而是……」出现 ${buShi} 次`, '整章上限 1 次']);
      const jiuZai = countRe(/就在这时|刹那间|的瞬间/g);
      if (jiuZai > 2) issues.push(['soft', `「就在这时/刹那间/的瞬间」合计 ${jiuZai} 次`, '整章合计上限 2 次']);
      // 软违规：比喻引导词密度（同一引导词上限 3）
      const simileHits = [];
      const likeCount = countRe(/(?<![画肖雕影录照相])像/g);
      if (likeCount > 3) simileHits.push(`「像」×${likeCount}`);
      for (const w of ['仿佛', '如同', '宛如', '恰似']) {
        const n = occurs(w);
        if (n > 3) simileHits.push(`「${w}」×${n}`);
      }
      if (simileHits.length) issues.push(['soft', '比喻引导词频次（同一引导词上限 3，一段最多一个比喻）', simileHits.join('、')]);
      // 软违规：AI 转折词/书面连接词
      const aiConn = ['然而，', '与此同时', '不仅如此', '值得一提的是', '不得不说'];
      const aiConnHits = aiConn.filter((w) => occurs(w) > 0).map((w) => `「${w.replace(/，$/, '')}」`);
      if (aiConnHits.length) issues.push(['soft', 'AI 转折词/书面连接词', `${aiConnHits.join('、')}——删掉或换成口语衔接`]);
      // 软违规：句长过于均匀（句长波动检测：段内长短句应有落差）
      const sentences = body.split(/[。！？\n]+/).map((s) => s.trim()).filter((s) => s.length > 1);
      if (sentences.length >= 8) {
        const lens = sentences.map((s) => s.length);
        const avg = lens.reduce((a, b) => a + b, 0) / lens.length;
        const variance = lens.reduce((s, l) => s + (l - avg) ** 2, 0) / lens.length;
        const cv = Math.sqrt(variance) / avg; // 变异系数
        const shortCount = lens.filter((l) => l <= 8).length;
        if (cv < 0.35 && shortCount < 3) issues.push(['soft', `句长过于均匀（变异系数 ${cv.toFixed(2)}，短句仅 ${shortCount} 个）`, '长短句要有落差：加碎句/单句成段，偶尔来一个 40 字长句']);
      }
      // 软违规：连续同句式开头（连续 3+ 句以相同人称代词/人名开头）
      const starts = sentences.map((s) => (s.match(/^(他|她|它|我|你|林|苏|叶|楚|萧|陈|秦|李|张|王|刘|周|赵)/) || [])[1]).filter(Boolean);
      let run = 1; let maxRun = 1;
      for (let i = 1; i < starts.length; i += 1) {
        if (starts[i] === starts[i - 1]) { run += 1; maxRun = Math.max(maxRun, run); } else run = 1;
      }
      if (maxRun >= 4) issues.push(['soft', `连续 ${maxRun} 句以「${starts[0] || '同一人称'}」类开头`, '连续同句式是强 AI 特征：换主语、倒装、或用动作句切入']);
      // 软违规：心理描写密度（一章不超 5 处）
      const psych = countRe(/心中|心头|涌上|感到/g);
      if (psych > 5) issues.push(['soft', `心理/情绪标签类表达约 ${psych} 处`, '心理描写一章不超 5 处，改用行为外化']);

      const hardCount = issues.filter((i) => i[0] === 'hard').length;
      const softCount = issues.length - hardCount;
      const lines = [];
      if (!issues.length) lines.push('通过：未发现可量化的铁律违规（视角越界、说明书腔、情绪太平均等不可量化项仍需人工/模型自查）。');
      for (const [level, name, detail] of issues) {
        lines.push(`- ${level === 'hard' ? '【必须修】' : '【建议查】'}${name}——${detail}`);
      }
      return { hardCount, softCount, report: lines.join('\n') };
    }

    // ---------------- 子调用提示词分层 ----------------
    // 两层结构：身份基座（所有子调用共用）+ 方法论包（从 skills/ 装载）+ 各工具
    // 自带的角色指令。方法论包内容住在 skills/*/SKILL.md，与 Agent 亲写同源。
    const baseSystem = `你是中文网文写手。文字要像跟读者聊天一样自然，不像在展示词汇量。你的读者是拿着手机快速划屏的人，不是文学评论家。

通用原则：
1. 尊重作者意图，不擅自改动既定情节与人设。
2. 输出可直接使用的正文；网文标准：开篇抓人，节奏明快，爽点清晰，每章尾留钩子。
3. Markdown 只用于大纲/分析/报告等非正文输出；小说正文必须是纯文本。
4. 涉及改写/续写时，保持与原文一致的连贯性、人物语气与叙事视角。`;
    const joinPack = (...parts) => parts.filter((p) => p && p.trim()).join('\n\n');
    // 规划分析类（novel_import 逆推大纲用）
    const plottingSystem = joinPack(baseSystem, SK.plotting && `【大纲细纲与节奏设计】\n${SK.plotting}`);
    // 一致性类：简报/归档/全书体检
    const continuitySystem = joinPack(baseSystem, SK.continuity && `【一致性与前文衔接守则】\n${SK.continuity}`);
    // 编排类：工程操作/文风工具——只要身份基座，角色指令自带
    const leanSystem = baseSystem;
    // 整章成稿类：正文铁律 + 一致性衔接（write_chapter / continue 用）
    const chapterSystem = joinPack(baseSystem, SK.prose && `【正文铁律 · 落笔即防】（写正文时逐条自检，违反任何一条就重写该句）\n${SK.prose}`, SK.continuity && `【一致性与前文衔接守则】\n${SK.continuity}`);

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
          // 支持自定义执行器（如文件读写类工具），否则走 LLM 生成
          if (typeof spec.run === 'function') {
            const custom = await spec.run(args, exec);
            return { result: custom };
          }
          const system = typeof spec.system === 'function' ? spec.system(args) : spec.system;
          const user = typeof spec.user === 'function' ? spec.user(args) : spec.user;
          const result = await generate(system, user, args, exec, spec.opts || {});
          return { result };
        },
      };
      disposers.push(ctx.tools.register(def));
    }

    // ---------------- 1. AI 味确定性检查 ----------------
    // 纯代码规则做可量化的铁律检查（标点计数、禁词表、副词/句式/比喻频次、
    // Markdown 残留），秒回、不耗模型。Agent 亲写正文后的自检环节也用它。
    tool({
      name: 'novel_lint',
      description: 'AI 味与正文铁律确定性检查（纯代码规则，不调用模型，秒回）：标点纪律（破折号/省略号/感叹号/分号）、简体网文标点规范（直角引号/英文引号/错误省略号/装饰符号）、禁用词与模板化表达、万能量词、副词频次、极端词密度、句式频次、AI 转折词、比喻引导词密度、句长均匀度（变异系数）、连续同句式开头、心理描写密度、Markdown 残留。对任何正文（成稿、旧稿、外来文本、亲写段落）跑一遍，输出违规清单：hard 项必须修，soft 项逐条核对（可能有误报）。novel_write_chapter 成稿时已内置此检查。',
      timeoutMs: 30000,
      parameters: {
        text: { type: 'string', description: '待检查的正文', required: true },
      },
      run: async (args) => {
        const text = args && typeof args.text === 'string' ? args.text : '';
        if (!text.trim()) throw new Error('缺少待检查文本（text）');
        const { hardCount, softCount, report } = lintText(text);
        const chars = text.replace(/\s+/g, '').length;
        const verdict = hardCount > 0 ? `发现 ${hardCount} 项硬违规，必须修（按清单逐句修复后可再跑一次复查）。` : '无硬违规。';
        const softLine = softCount > 0 ? `另有 ${softCount} 项软违规，建议逐条核对（禁词/频次类规则偶有语境误报，误报可忽略）。` : '';
        return `【正文铁律检查】（${chars} 字 · 确定性规则 · 未调用模型）\n\n${report}\n\n${verdict}${softLine}`;
      },
    });

    // ---------------- 2. 文风卡 ----------------
    // 文风一致性的机制化解法：从基准章节提取结构化文风卡，落盘为工程根目录的
    // 文风卡.md；novel_write_chapter / novel_continue 成稿时自动读取注入，
    // 对齐不靠模型记忆。每个工程生成一次，文风漂移或换基准时重新生成。
    tool({
      name: 'novel_style_profile',
      description: '文风卡：从基准文本（已定稿的 1-2 章或最能代表目标文风的段落）提取结构化「文风卡」，默认落盘为工程根目录的 文风卡.md；此后成稿工具（novel_write_chapter / novel_continue）自动读取并对齐，保证长篇文风一致。每个工程生成一次；用户改文风或基准变化时重新生成覆盖。',
      timeoutMs: 180000,
      parameters: {
        ...routeParams,
        sample: { type: 'string', description: '基准文本：最能代表目标文风的已定稿正文（一章或几段，2000 字以上为宜）', required: true },
        notes: { type: 'string', description: '文风补充说明（可选）：用户对文风的要求与偏好，会并入文风卡' },
        save: { type: 'boolean', description: '是否保存到工程根目录 文风卡.md，默认 true' },
      },
      run: async (args, exec) => {
        const sample = args && typeof args.sample === 'string' && args.sample.trim() ? args.sample.trim() : '';
        if (!sample) throw new Error('缺少基准文本（sample）：请提供最能代表目标文风的已定稿正文');
        const system = `${leanSystem}

你现在担任文风分析师。从基准文本中提取结构化「文风卡」，它是后续所有章节的文风基准——只描述语言习惯，绝不复述内容。

要求：
1. 每一节都写成「可执行的对齐指令」，不要空泛形容（不写「文笔优美」，要写「句子平均 15 字以内，两句长句后必接短句」）。
2. 从基准文本的实际统计特征出发，不套模板。

输出格式（Markdown）：
## 总体
（一句话概括：题材感 + 语调 + 叙述距离 + 叙述人称）
## 句式与节奏
（平均句长、长短句交替习惯、段落长度、节奏密度、单句成段的使用）
## 对话风格
（口语化程度、对话句长、口癖类型、对话与叙述占比、对话标签习惯）
## 描写与比喻
（描写密度、五感偏好、比喻使用频率与引导词习惯、心理描写外化方式）
## 用词倾向
（雅俗度、常用词域、禁用倾向、方言/行话、称谓习惯）
## 开头与结尾习惯
（章节/场景开头的切入方式分布、结尾钩子的落点习惯）
## 必须保持
（3-5 条最不能漂移的特征，违反即视为文风崩坏）
## 代表段摘录
（从基准文本中原样摘录 2-3 段最能代表文风的文字，每段 100 字以内）`;
        const card = await generate(system, compose([
          field('基准文本', sample),
          field('文风补充说明（并入卡中）', args.notes),
        ]), args, exec, { maxTokens: 4000 });
        let savedLine = '';
        if (!args || args.save !== false) {
          const fc = fsContext(exec);
          if (fc) {
            const target = await fc.fs.resolve('文风卡.md', { cwd: fc.root });
            await fc.fs.writeText(target, `# 文风卡\n\n> 由 novel_style_profile 生成；成稿工具自动读取对齐。重新生成直接覆盖本文件。\n\n${card}\n`, undefined, undefined, fc.policy);
            savedLine = '已保存：文风卡.md（工程内成稿工具此后自动读取对齐）';
          } else {
            savedLine = '（文件系统服务不可用，文风卡未落盘；请把以下内容保存为工程根目录的 文风卡.md，否则成稿工具无法自动对齐）';
          }
        }
        return compose([savedLine, `【文风卡】\n\n${card}`]);
      },
    });

    // ---------------- 3. 小说续写（自动衔接） ----------------
    tool({
      name: 'novel_continue',
      description: '续写小说正文：承接最新正文继续往下写，可结合大纲与设定，自动保持视角、人物与文风一致，结尾留钩子。工程内续写时开 auto_context：自动读取工程里最新一章结尾作上文、文风卡与活跃伏笔，不贴正文也能接。',
      timeoutMs: 180000,
      parameters: {
        ...routeParams,
        text: { type: 'string', description: '已写的正文（从断点处开始续写）；工程内续写可不填，配合 auto_context 自动读取上一章结尾' },
        auto_context: { type: 'boolean', description: '自动从工程读取衔接材料：最新一章结尾（作上文）、文风卡、伏笔清单。默认 false（提供了 text 时无需开启）' },
        outline: { type: 'string', description: '当前大纲/细纲，帮助保持一致（可选）' },
        setting: { type: 'string', description: '世界观与人物设定（可选）' },
        direction: { type: 'string', description: '下一步剧情方向或目标（可选）' },
        length: { type: 'integer', description: '期望输出的大致字数（可选）' },
        style: { type: 'string', description: '风格要求（可选）' },
        style_ref: { type: 'string', description: '文风参考（可选）：文风画像/风格指南/文风卡；auto_context 开启时自动读取文风卡.md，此处可覆盖' },
      },
      run: async (args, exec) => {
        let text = args && typeof args.text === 'string' ? args.text.trim() : '';
        let styleRef = args && typeof args.style_ref === 'string' ? args.style_ref : '';
        const autoParts = [];
        if (args && args.auto_context) {
          const fc = fsContext(exec);
          if (fc) {
            const proj = openProject(fc.fs, fc.root, fc.policy);
            if (!text) {
              const prev = await proj.chapterTail(undefined, 1000);
              if (prev) {
                text = prev.tail;
                autoParts.push(`上一章结尾（自动读取自 ${prev.name.replace(/\.md$/, '')}）`);
              }
            }
            if (!styleRef) {
              const card = await readStyleCard(proj);
              if (card) {
                styleRef = card;
                autoParts.push('文风卡（自动读取）');
              }
            }
          }
        }
        if (!text) throw new Error('缺少已写正文（text）；或开启 auto_context 从工程自动读取最新一章结尾');
        const system = `${chapterSystem}

你现在担任资深网文作者，负责续写正文。

续写要求：
1. 严格承接上文：动笔前先看原文最后一段的落点——场景、时间、在场人物、情绪状态；开头必须从同一场戏直接推进，不重复上文已写内容，不许出现场景、时间或情绪的断裂跳变。
2. 遵守大纲与设定：若有大纲/设定，不得与其矛盾；若没有，则顺着上文自然发展。
3. 若给出「下一步剧情方向」，优先朝该方向推进；否则选择最合理且最有看点的走向。
4. 若提供「文风参考」：句式节奏、用词雅俗、描写密度与对话风格向其对齐，但不模仿其具体情节与内容。
5. 网文向：每段有推进，情绪递进，结尾留钩子（悬念/期待/情绪余韵）。
6. 直接输出续写正文，不要输出任何前言、说明或标题解释。
7. 按【正文铁律】执行：先想画面再落笔，写完一段扫一段，输出前整篇快扫一遍——交出的就应该是干净稿。`;
        const user = compose([
          field('已写正文（从此处续写）', text),
          field('当前大纲', args.outline),
          field('世界观与人物设定', args.setting),
          field('下一步剧情方向', args.direction),
          args.length ? `【目标字数】约 ${args.length} 字` : '',
          field('风格要求', args.style),
          field('文风参考（对齐语言风格，不模仿内容）', styleRef),
        ]);
        const out = await generate(system, user, args, exec, { maxTokens: 8000 });
        return autoParts.length ? `${out}\n\n【已自动注入】${autoParts.join('、')}` : out;
      },
    });

    // ---------------- 4. 作品工程 ----------------
    tool({
      name: 'novel_project',
      description: '作品工程：把小说组织成 Obsidian 友好的 Markdown 工程——初始化目录结构（正文/大纲/设定集/人物卡/归档/伏笔清单/时间线/文风卡）、保存章节、生成伏笔清单、生成时间线、统计进度、整理作品索引。长篇项目管理的基础工具。',
      timeoutMs: 180000,
      parameters: {
        ...routeParams,
        action: { type: 'string', enum: ['初始化工程', '保存章节', '生成伏笔清单', '生成时间线', '统计进度', '整理索引'], description: '操作类型', required: true },
        title: { type: 'string', description: '作品名（初始化/整理索引时用）' },
        chapter_number: { type: 'integer', description: '章节序号（保存章节时用）' },
        chapter_title: { type: 'string', description: '章节标题（保存章节时用）' },
        content: { type: 'string', description: '章节正文（保存章节时用，纯文本）' },
        story: { type: 'string', description: '故事大纲/已写内容（生成伏笔清单/生成时间线时用）' },
      },
      run: async (args, exec) => {
        const fs = ctx.get('fs');
        const sp = ctx.get('sandboxPolicy');
        if (fs === undefined || sp === undefined) throw new Error('文件系统服务不可用');
        const session = exec && exec.agent ? exec.agent.session : undefined;
        const root = workspaceRoot(exec, sp);
        const policy = sp.resolve(session !== undefined ? { session } : {});
        const proj = openProject(fs, root, policy);
        const write = proj.write;
        const action = args && typeof args.action === 'string' ? args.action : '';
        const out = [];
        if (action === '初始化工程') {
          const t = args && args.title ? args.title : '未命名作品';
          await write('README.md', `# ${t}\n\n> 作品索引（由 novel_project 维护，双链导航）\n\n- 简介：\n- 状态：\n\n## 快速导航\n\n- [[伏笔清单]] · [[时间线]] · [[大纲/总纲|总纲]]\n- [[人物卡/_索引|人物卡]] · [[设定集/_索引|设定集]]\n- 章节：见下方（整理索引后自动生成）\n`);
          await write('伏笔清单.md', `# 伏笔清单\n\n| 伏笔 | 铺设位置 | 发酵 | 回收位置 | 状态 |\n| --- | --- | --- | --- | --- |\n`);
          await write('时间线.md', `# 时间线\n\n| 时间 | 事件 | 参与人物 | 影响/后续 |\n| --- | --- | --- | --- |\n`);
          await write('大纲/总纲.md', '# 总纲\n\n## 核心设定\n\n## 主线\n\n## 分卷规划\n');
          await write('设定集/_索引.md', '# 设定集索引\n\n> 每类设定一个文件；文件之间与人物卡用双链互相关联（如 [[主角]]、[[设定集/力量体系|力量体系]]）\n\n');
          await write('设定集/世界观.md', '# 世界观\n\n（核心世界观设定；相关链接：[[设定集/力量体系]]、[[设定集/地理]]）\n');
          await write('设定集/力量体系.md', '# 力量体系\n\n（等级/功法/战力规则与代价）\n');
          await write('设定集/地理.md', '# 地理\n\n（大陆/国家/城市/重要地点）\n');
          await write('设定集/势力.md', '# 势力\n\n（宗门/家族/组织/阵营）\n');
          await write('人物卡/_索引.md', '# 人物卡索引\n\n> 每个角色一个文件；关系用双链互链（如 [[林远]]），设定关联用 [[设定集/xxx]]\n\n');
          await write('归档/说明.md', '# 归档\n\n每章归档一个文件：第NNN章-归档.md（由 novel_archive 生成）\n');
          await write('正文/说明.md', '# 正文\n\n每章一个文件：`第NNN章-标题.md`\n');
          await write('文风卡.md', '# 文风卡\n\n> 用 novel_style_profile 从基准章节生成；生成后所有成稿工具自动读取对齐，长篇文风一致靠它兜底。重新生成直接覆盖本文件。\n');
          out.push('已初始化工程（每人一文件 + 设定分类 + 双链索引 + 文风卡占位）：README.md、伏笔清单、时间线、文风卡、大纲/总纲、设定集/（世界观/力量体系/地理/势力/_索引）、人物卡/_索引、归档/、正文/');
        } else if (action === '保存章节') {
          const num = args && args.chapter_number ? args.chapter_number : 1;
          const body = args && typeof args.content === 'string' && args.content.trim() ? args.content : '';
          if (!body) throw new Error('章节正文为空，请传入 content');
          const file = await saveChapterFile(fs, root, policy, num, args && args.chapter_title ? args.chapter_title : '', body);
          out.push(`已保存章节：${file}`);
        } else if (action === '生成伏笔清单' || action === '生成时间线') {
          const story = args && typeof args.story === 'string' && args.story.trim() ? args.story : '';
          if (!story) throw new Error(`缺少 story，无法${action}`);
          let system;
          if (action === '生成伏笔清单') {
            system = `${leanSystem}

你现在担任网文伏笔管理专家。从提供的故事/大纲中梳理所有伏笔，输出 Markdown 表格：
| 伏笔 | 铺设位置 | 发酵 | 回收位置 | 状态 |
状态取「铺设中/发酵中/已回收/待回收」。信息不明处标【待定】。只输出表格，不要其他说明。`;
          } else {
            system = `${leanSystem}

你现在担任网文时间线整理专家。从提供的故事/已写内容中梳理事件时间线，输出 Markdown 表格：
| 时间 | 事件 | 参与人物 | 影响/后续 |
时间用故事内纪年/相对时间（如「开篇当日」「三天后」），信息不明处标【待定】。按故事内时间先后排序。只输出表格，不要其他说明。`;
          }
          const text = await generate(system, `【故事/大纲】\n${story}`, args, exec, { maxTokens: 4000 });
          const file = action === '生成伏笔清单' ? '伏笔清单.md' : '时间线.md';
          const header = action === '生成伏笔清单' ? '# 伏笔清单\n\n' : '# 时间线\n\n';
          await write(file, `${header}${text}\n`);
          out.push(`已${action}：${file}`);
        } else if (action === '统计进度') {
          const names = await proj.listMd('正文');
          const rows = [];
          let total = 0;
          for (const name of names) {
            const text = await proj.readMaybe(`正文/${name}`);
            const count = text ? text.replace(/\s+/g, '').length : 0;
            total += count;
            rows.push(`| ${name.replace(/\.md$/, '')} | ${count} |`);
          }
          const avg = names.length ? Math.round(total / names.length) : 0;
          out.push([
            `## 进度统计`,
            ``,
            `| 章节 | 字数 |`,
            `| --- | --- |`,
            ...rows,
            ``,
            `章节数：${names.length}；总字数：${total}；平均每章：${avg}`,
          ].join('\n'));
        } else if (action === '整理索引') {
          const t = args && args.title ? args.title : '未命名作品';
          const chapters = await proj.listMd('正文');
          const chars = await proj.listMd('人物卡');
          const sets = await proj.listMd('设定集');
          const arcs = await proj.listMd('归档');
          const skip = (f) => f !== '_索引.md' && f !== '说明.md';
          const chapterLinks = chapters.map((c) => `- [[${c.replace(/\.md$/, '')}]]`).join('\n');
          const charLinks = chars.filter(skip).map((c) => `- [[人物卡/${c.replace(/\.md$/, '')}|${c.replace(/\.md$/, '')}]]`).join('\n');
          const setLinks = sets.filter(skip).map((s) => `- [[设定集/${s.replace(/\.md$/, '')}|${s.replace(/\.md$/, '')}]]`).join('\n');
          const arcLinks = arcs.filter(skip).map((a) => `- [[归档/${a.replace(/\.md$/, '')}|${a.replace(/\.md$/, '')}]]`).join('\n');
          await write('README.md', `# ${t}\n\n> 作品索引（由 novel_project 维护）\n\n- 简介：\n- 状态：\n- 章节数：${chapters.length}\n\n## 章节\n\n${chapterLinks || '（暂无）'}\n\n## 人物\n\n${charLinks || '（暂无）'}\n\n## 设定\n\n${setLinks || '（暂无）'}\n\n## 归档\n\n${arcLinks || '（暂无）'}\n\n## 追踪\n\n- [[伏笔清单]] · [[时间线]] · [[大纲/总纲|总纲]]\n`);
          // 同步更新人物卡索引
          if (chars.filter(skip).length > 0) {
            await write('人物卡/_索引.md', `# 人物卡索引\n\n> 每个角色一个文件；关系用双链互链（如 [[林远]]）\n\n${chars.filter(skip).map((c) => `- [[人物卡/${c.replace(/\.md$/, '')}|${c.replace(/\.md$/, '')}]]`).join('\n')}\n`);
          }
          if (sets.filter(skip).length > 0) {
            await write('设定集/_索引.md', `# 设定集索引\n\n> 每类设定一个文件；与人物卡用双链互相关联\n\n${sets.filter(skip).map((s) => `- [[设定集/${s.replace(/\.md$/, '')}|${s.replace(/\.md$/, '')}]]`).join('\n')}\n`);
          }
          out.push(`已整理索引：README.md（${chapters.length} 章、${chars.filter(skip).length} 人物、${sets.filter(skip).length} 设定，全部双链）`);
        } else {
          throw new Error(`未知操作：${action}`);
        }
        return out.join('\n');
      },
    });

    // ---------------- 5. 单章成稿流水线 ----------------
    // 长篇成稿质量的三道机制保障（不靠模型自觉）：
    // ① auto_context：程序化读取工程材料（上一章结尾/最近归档/出场人物卡/活跃
    //    伏笔/时间线/文风卡）注入子调用——忘记设定与衔接断裂的根治；
    // ② lint 修订环：草稿先过 lintText 确定性检查，违规清单驱动定向修订，
    //    修不好就保留较好版本（最多两轮）；
    // ③ 落笔即防：writerSystem 注入正文铁律 + 一致性守则（从 skills/ 装载）。
    tool({
      name: 'novel_write_chapter',
      description: '单章成稿流水线（写正文章节的首选工具）：按本章细纲成稿，auto_context 默认自动从工程读取衔接材料（上一章结尾/最近归档/出场人物卡/活跃伏笔/时间线/文风卡），草稿经确定性 AI 味 lint + 定向修订后交付，可选直接保存进工程。配合 novel_briefing（写前）与 novel_archive（写后）组成每章闭环。',
      timeoutMs: 600000,
      parameters: {
        ...routeParams,
        chapter_plan: { type: 'string', description: '本章细纲：本章要发生的事件、转折、爽点、伏笔处理、结尾钩子方向（建议用 novel-plotting skill 的标准细纲模板）', required: true },
        brief: { type: 'string', description: '写前简报（novel_briefing 的输出；auto_context 开启时可省略，工具会自动读取工程材料）' },
        outline: { type: 'string', description: '全书/本卷大纲的相关部分（可选）' },
        setting: { type: 'string', description: '世界观与人物设定（可选）' },
        previous_tail: { type: 'string', description: '上一章结尾的原文（几百字即可）；不填且 auto_context 开启时自动读取工程里最新一章结尾' },
        auto_context: { type: 'boolean', description: '自动从作品工程读取写作上下文（上一章结尾/最近归档/出场人物卡/活跃伏笔/时间线/文风卡），默认 true；工程不存在时自动忽略' },
        length: { type: 'integer', description: '目标字数，默认 3000' },
        passes: { type: 'string', enum: ['直接成稿', '草稿+修订', '草稿+自查+修订'], description: '成稿模式：默认草稿+修订（含确定性 lint 修订环）；重要章节用草稿+自查+修订；直接成稿只出草稿但仍附 lint 报告' },
        style_ref: { type: 'string', description: '文风参考（可选）：覆盖自动读取的文风卡；成稿语言风格向其对齐，不模仿其内容' },
        requirements: { type: 'string', description: '额外要求（可选）' },
        save: { type: 'boolean', description: '是否保存进作品工程（正文/第NNN章-标题.md），默认 false' },
        chapter_number: { type: 'integer', description: '章节序号（save 与定位上一章时用）' },
        chapter_title: { type: 'string', description: '章节标题（save 时用）' },
      },
      run: async (args, exec) => {
        const plan = args && typeof args.chapter_plan === 'string' && args.chapter_plan.trim() ? args.chapter_plan.trim() : '';
        if (!plan) throw new Error('缺少本章细纲（chapter_plan），请先给出本章要写的内容');
        const length = args && args.length ? args.length : 3000;
        const passes = args && typeof args.passes === 'string' && args.passes ? args.passes : '草稿+修订';
        const auto = !args || args.auto_context !== false;
        let brief = args && typeof args.brief === 'string' ? args.brief : '';
        let previousTail = args && typeof args.previous_tail === 'string' ? args.previous_tail : '';
        let styleRef = args && typeof args.style_ref === 'string' ? args.style_ref : '';
        const autoParts = [];
        // ① 自动上下文：程序化读取工程材料，不靠调用方自觉
        if (auto) {
          const fc = fsContext(exec);
          if (fc) {
            const proj = openProject(fc.fs, fc.root, fc.policy);
            const num = args && args.chapter_number ? args.chapter_number : undefined;
            if (!previousTail) {
              const prev = await proj.chapterTail(num, 1000);
              if (prev) {
                previousTail = prev.tail;
                autoParts.push(`上一章结尾（自动读取自 ${prev.name.replace(/\.md$/, '')}）`);
              }
            }
            if (!styleRef) {
              const card = await readStyleCard(proj);
              if (card) {
                styleRef = card;
                autoParts.push('文风卡（自动读取 文风卡.md）');
              }
            }
            if (!brief) {
              const archives = await proj.listMd('归档');
              if (archives.length) {
                const latest = await proj.readMaybe(`归档/${archives[archives.length - 1]}`, 1800);
                if (latest && latest.trim()) autoParts.push(`最近归档（自动读取 ${archives[archives.length - 1].replace(/\.md$/, '')}）`);
                if (latest && latest.trim()) brief = `【最近归档 · 摘要】\n${latest}`;
              }
              const foreshadow = await proj.readMaybe('伏笔清单.md', 2000);
              if (foreshadow && foreshadow.trim()) {
                brief = compose([brief, `【活跃伏笔（自动读取）】\n${foreshadow}`]);
                autoParts.push('伏笔清单');
              }
              // 出场人物卡：细纲/简报文本中出现的人物名自动匹配读取
              const castNames = [];
              const castText = `${plan}\n${brief || ''}`;
              const cards = await proj.listMd('人物卡');
              for (const c of cards.slice(0, 40)) {
                const cname = c.replace(/\.md$/, '');
                if (cname === '_索引') continue;
                if (castText.includes(cname)) castNames.push(cname);
              }
              const castCards = [];
              for (const cname of castNames.slice(0, 6)) {
                const card = await proj.readMaybe(`人物卡/${cname}.md`, 1500);
                if (card && card.trim()) castCards.push(`【人物卡 · ${cname}】\n${card}`);
              }
              if (castCards.length) {
                brief = compose([brief, ...castCards]);
                autoParts.push(`出场人物卡×${castCards.length}（${castNames.slice(0, 6).join('、')}）`);
              }
            }
          }
        }
        const context = compose([
          field('写前简报（出场人物/活跃伏笔/相关设定/衔接要点）', brief),
          field('大纲（相关部分）', args.outline),
          field('世界观与人物设定', args.setting),
          field('上一章结尾（紧接其后续写，不要重复）', previousTail),
          field('本章细纲', plan),
          field('文风参考（对齐语言风格，不模仿内容）', styleRef),
          field('额外要求', args.requirements),
          `【目标字数】约 ${length} 字（上下浮动不超过 20%）`,
        ]);
        const writerSystem = `${chapterSystem}

你现在担任网文章节写手，负责按细纲写出整章正文。

单章成稿规范：
1. 直接输出正文：不要章节标题、不要前言后语、不要任何解释、不要 markdown 符号。
2. 有「上一章结尾」时必须紧接其自然续写（场景/时间/情绪三锚点对齐，见衔接守则），不重复上文；没有上文时按黄金三章法则开篇。
3. 严格按「本章细纲」推进：细纲中的事件、转折、伏笔与爽点都要落实到正文；细纲之外不得擅自增加重大剧情。
4. 出场人物言行严格符合人物卡与设定：性格、口癖、关系、当前状态一致；活跃伏笔如本章涉及，务必按细纲处理；角色只说自己可能知道的信息。
5. 有「文风参考」时：句式节奏、用词雅俗、描写密度与对话风格向其对齐，但不模仿其具体情节与内容。
6. 结尾必须留钩子：悬念、期待或情绪余韵，指向下一章。
7. 全程执行【正文铁律】：先想画面再落笔，写完一段扫一段；全文写完后再整篇快扫一遍才输出——初稿就必须是去净 AI 腔的干净稿，后续修订只做兜底，不是擦洗工序。`;
        const reviserSystem = `${chapterSystem}

你现在担任网文终稿修订师。当前稿件存在确定性检查发现的铁律违规，你的任务是逐项修复「违规清单」上的问题，其余内容原样保留——不重写、不润色、不增删情节。

修订要求：
1. 逐条对照「违规清单」修改对应句子；【必须修】项全部消除，【建议查】项逐条判断（确认违规的改掉）。
2. 修改时保持上下文连贯、字数不明显缩水；删改后重读前后句，不留语病。
3. 只输出修订后的完整正文，不要任何说明。`;
        const finisherSystem = `${chapterSystem}

你现在担任网文终稿写手。初稿已按红线边写边防并通过确定性检查，你的任务是兜底终检：只改必须改的，不要推倒重写。

终检清单（逐项检查，有问题才动笔）：
1. 落笔即防红线兜底快扫：套话、情绪标签、堆砌、书面腔对话，漏网即改。
2. 开头是否紧接上文、结尾钩子是否成立有力；不成立就改写。
3. 人物言行是否符合人物卡与简报；越界处纠正。
4. 细纲事件是否全部落实；删除注水、重复与离题内容。
5. 字数是否达标（±20%）；不足则按细纲补充场景与细节，不注水。
只输出修订后的完整正文，不要任何说明。`;
        const draft = await generate(writerSystem, context, args, exec, { maxTokens: 8000 });
        let final = draft;
        // ② lint 修订环：确定性违规清单驱动定向修订，最多两轮，保留较好版本
        let lintFinal = lintText(final);
        const lintScore = (l) => l.hardCount * 10 + l.softCount;
        if (passes !== '直接成稿') {
          for (let round = 0; round < 2 && (lintFinal.hardCount > 0 || lintFinal.softCount >= 3); round += 1) {
            const revised = await generate(reviserSystem, compose([context, field('当前稿件', final), field('违规清单（确定性检查，逐项修复）', lintFinal.report)]), args, exec, { maxTokens: 8000 });
            const lintRevised = lintText(revised);
            if (lintScore(lintRevised) < lintScore(lintFinal)) {
              final = revised;
              lintFinal = lintRevised;
            } else break; // 没有改善就保留现版本，不越修越差
          }
        }
        if (passes === '草稿+修订') {
          final = await generate(finisherSystem, compose([context, field('初稿', final)]), args, exec, { maxTokens: 8000 });
          lintFinal = lintText(final);
        } else if (passes === '草稿+自查+修订') {
          const critique = await generate(`${chapterSystem}

你现在担任网文审稿编辑，对「初稿」做发布前自查，只输出问题清单、不重写。（确定性检查已另行完成，你专注不可量化项。）

逐项检查：
1. 视角越界：角色说出了不可能知道的信息。
2. 情绪标签与说明书腔对话；结尾升华抒情。
3. 开头衔接、结尾钩子、细纲落实、爽点兑现、伏笔处理、人物一致性、字数达标。
4. 每个问题输出：【位置】【问题】【具体改法】，按严重程度排序；没有问题的项明确写「通过」。`, compose([context, field('初稿', final)]), args, exec, { maxTokens: 3000 });
          final = await generate(finisherSystem, compose([context, field('初稿', final), field('审稿问题清单', critique)]), args, exec, { maxTokens: 8000 });
          lintFinal = lintText(final);
        }
        let savedLine = '';
        if (args && args.save) {
          const fc2 = fsContext(exec);
          if (!fc2) throw new Error('文件系统服务不可用，无法保存；请直接取用下方正文');
          const file = await saveChapterFile(fc2.fs, fc2.root, fc2.policy, args.chapter_number || 1, args.chapter_title || '', final);
          savedLine = `已保存：${file}`;
        }
        const lintLine = `【铁律检查】${lintFinal.hardCount ? `${lintFinal.hardCount} 项硬违规未消除（建议 novel_lint 复查或手动修复）` : '硬违规清零'}；${lintFinal.softCount} 项软提示${lintFinal.softCount ? '（多为禁词/频次，误报可忽略）' : ''}`;
        return compose([
          savedLine,
          `【成稿模式】${passes}；定稿约 ${final.replace(/\s+/g, '').length} 字。${autoParts.length ? `已自动注入：${autoParts.join('、')}。` : ''}${lintLine}`,
          '定稿后建议用 novel_archive 归档本章（更新伏笔清单/时间线/人物状态）。',
          final,
        ]);
      },
    });

    // ---------------- 6. 写前简报 ----------------
    tool({
      name: 'novel_briefing',
      description: '写前简报：从作品工程（大纲/设定集/人物卡/伏笔清单/时间线/最近归档/上一章结尾）中汇总写作上下文，浓缩成一份「写前简报」，供续写或 novel_write_chapter 单章成稿使用。每章动笔前先调它，长篇一致性靠它兜底。',
      timeoutMs: 300000,
      parameters: {
        ...routeParams,
        chapter_number: { type: 'integer', description: '准备写的章节序号（用于定位上一章结尾；不填则取最新一章之后）' },
        focus: { type: 'string', description: '本章计划/要写什么（可选，帮助简报取舍重点）' },
        condense: { type: 'boolean', description: '是否用模型浓缩成简报；false 时返回原始汇总材料，默认 true' },
      },
      run: async (args, exec) => {
        const fs = ctx.get('fs');
        const sp = ctx.get('sandboxPolicy');
        if (fs === undefined || sp === undefined) throw new Error('文件系统服务不可用');
        const session = exec && exec.agent ? exec.agent.session : undefined;
        const root = workspaceRoot(exec, sp);
        const policy = sp.resolve(session !== undefined ? { session } : {});
        const proj = openProject(fs, root, policy);
        const parts = [];
        const collect = async (dir, label, maxFiles, cap) => {
          const names = await proj.listMd(dir);
          for (const name of names.slice(0, maxFiles)) {
            const text = await proj.readMaybe(`${dir}/${name}`, cap);
            if (text && text.trim()) parts.push(`【${label} · ${name.replace(/\.md$/, '')}】\n${text}`);
          }
        };
        await collect('大纲', '大纲', 4, 2500);
        await collect('设定集', '设定', 6, 2000);
        await collect('人物卡', '人物卡', 8, 2000);
        const foreshadow = await proj.readMaybe('伏笔清单.md', 3000);
        if (foreshadow && foreshadow.trim()) parts.push(`【伏笔清单】\n${foreshadow}`);
        const timeline = await proj.readMaybe('时间线.md', 2000);
        if (timeline && timeline.trim()) parts.push(`【时间线】\n${timeline}`);
        const archives = await proj.listMd('归档');
        if (archives.length) {
          const latest = await proj.readMaybe(`归档/${archives[archives.length - 1]}`, 2000);
          if (latest && latest.trim()) parts.push(`【最近归档 · ${archives[archives.length - 1].replace(/\.md$/, '')}】\n${latest}`);
        }
        const prev = await proj.chapterTail(args && args.chapter_number, 1200);
        if (prev) parts.push(`【上一章结尾 · ${prev.name.replace(/\.md$/, '')}】\n${prev.tail}`);
        if (!parts.length) {
          throw new Error('工作区没有找到作品工程（大纲/设定集/人物卡/伏笔清单/正文）。先用 novel_project 初始化工程并保存内容，或改用工具参数直接传入材料。');
        }
        const materials = parts.join('\n\n');
        const condense = !args || args.condense !== false;
        if (!condense) return `【写前材料汇总】（原始材料，共 ${parts.length} 项）\n\n${materials}`;
        const system = `${continuitySystem}

你现在担任网文主编号手，负责在作者动笔前把工程材料浓缩成一份「写前简报」。简报是下一章写作的唯一上下文来源，务必精炼且不丢关键事实。

输出格式（Markdown，每节简明扼要）：
## 主线进度
（用 3-5 句话概括故事当前进展与所处剧情位置）
## 本章任务
（结合「本章计划」给出本章要完成的事件/爽点/钩子；未提供本章计划则给出建议的下一步）
## 出场人物要点
（本章可能出场的人物：当前状态、动机、关系变化、口癖要点）
## 活跃伏笔
（状态为铺设中/发酵中/待回收的伏笔，标注本章是否需要推进或回收）
## 相关设定
（本章会用到的世界观/力量体系/地点设定要点）
## 衔接要点
（上一章结尾的场面、情绪与悬而未决处，下一章开头必须承接）
## 注意事项
（时间线、人物状态、战力等一致性风险提示）`;
        const brief = await generate(system, compose([field('本章计划', args && args.focus), materials]), args, exec, { maxTokens: 3000 });
        return `【写前简报】（由 ${parts.length} 项工程材料浓缩，原始材料共 ${materials.length} 字）\n\n${brief}`;
      },
    });

    // ---------------- 7. 章后归档 ----------------
    tool({
      name: 'novel_archive',
      description: '章后归档：章节写完后调用——提取本章事件更新时间线、更新伏笔清单状态、生成归档记录（章节摘要/人物状态变化/新增设定）。与 novel_briefing 组成「写前—写后」闭环，是长篇不断片的保障。',
      timeoutMs: 300000,
      parameters: {
        ...routeParams,
        chapter_number: { type: 'integer', description: '章节序号', required: true },
        chapter_title: { type: 'string', description: '章节标题（可选）' },
        content: { type: 'string', description: '本章正文（纯文本）', required: true },
        update_foreshadow: { type: 'boolean', description: '是否更新伏笔清单.md，默认 true' },
        update_timeline: { type: 'boolean', description: '是否更新时间线.md，默认 true' },
      },
      run: async (args, exec) => {
        const fs = ctx.get('fs');
        const sp = ctx.get('sandboxPolicy');
        if (fs === undefined || sp === undefined) throw new Error('文件系统服务不可用');
        const session = exec && exec.agent ? exec.agent.session : undefined;
        const root = workspaceRoot(exec, sp);
        const policy = sp.resolve(session !== undefined ? { session } : {});
        const proj = openProject(fs, root, policy);
        const body = args && typeof args.content === 'string' && args.content.trim() ? args.content.trim() : '';
        if (!body) throw new Error('缺少本章正文（content）');
        const num = args && args.chapter_number ? args.chapter_number : 1;
        const ct = args && args.chapter_title ? args.chapter_title : '';
        const foreshadow = await proj.readMaybe('伏笔清单.md', 4000);
        const timeline = await proj.readMaybe('时间线.md', 2500);
        const system = `${continuitySystem}

你现在担任网文连续性管理员，负责在章节定稿后维护作品工程。根据本章正文与现有工程记录，严格按以下分隔格式输出（四个分隔符各占一行、原样输出）：
===FORESHADOW_TABLE===
（更新后的完整伏笔清单 Markdown 表格，表头：| 伏笔 | 铺设位置 | 发酵 | 回收位置 | 状态 |。在现有表格基础上：本章铺设的新伏笔追加一行（状态：铺设中），本章推进/回收的更新其发酵与回收位置及状态（已回收），无变化的行原样保留；没有现有表格则新建并填入本章内容能确定的伏笔）
===TIMELINE_ROWS===
（本章新增的时间线行，每行一条：| 时间 | 事件 | 参与人物 | 影响/后续 |，时间用故事内相对时间；无新增写「无」）
===ARCHIVE_REPORT===
（① 本章摘要：150 字以内客观记录 ② 人物状态变化：逐条「人物：变化」，无则写「无」③ 新增设定要点：逐条，无则写「无」④ 遗留问题：本章未解决/需注意之处，无则写「无」）`;
        const text = await generate(system, compose([
          field(`本章正文（第${num}章${ct ? ' ' + ct : ''}）`, body),
          field('现有伏笔清单', foreshadow),
          field('现有时间线', timeline),
        ]), args, exec, { maxTokens: 4000 });
        const table = extractSection(text, 'FORESHADOW_TABLE');
        const tlRows = extractSection(text, 'TIMELINE_ROWS');
        const report = extractSection(text, 'ARCHIVE_REPORT');
        const out = [];
        const archiveFile = `归档/第${String(num).padStart(3, '0')}章${ct ? '-' + safeName(ct) : ''}-归档.md`;
        if (!report && !table) {
          // 模型没有按分隔格式输出：整体写入归档文件，不覆盖工程表
          await proj.write(archiveFile, `# 第${num}章 归档\n\n${text}\n`);
          return `已保存归档：${archiveFile}\n（警告：归档模型未按分隔格式输出，伏笔清单与时间线未更新；请人工核对）`;
        }
        if (args && args.update_foreshadow === false) {
          out.push('伏笔清单：按参数跳过更新');
        } else if (table) {
          await proj.write('伏笔清单.md', `# 伏笔清单\n\n${table}\n`);
          out.push('伏笔清单：已更新');
        }
        if (args && args.update_timeline === false) {
          out.push('时间线：按参数跳过更新');
        } else if (tlRows && tlRows !== '无') {
          const existing = await proj.readMaybe('时间线.md');
          const header = '# 时间线\n\n| 时间 | 事件 | 参与人物 | 影响/后续 |\n| --- | --- | --- | --- |\n';
          const base = existing && existing.trim() ? `${existing.trimEnd()}\n` : header;
          await proj.write('时间线.md', `${base}${tlRows}\n`);
          out.push('时间线：已追加本章事件');
        }
        await proj.write(archiveFile, `# 第${num}章 归档${ct ? ' · ' + ct : ''}\n\n${report || text}\n`);
        out.push(`归档记录：${archiveFile}`);
        return compose([
          `第${num}章归档完成：`,
          ...out.map((l) => `- ${l}`),
          '提示：人物状态变化若影响人物卡，请同步更新 人物卡/ 下对应文件。',
        ]);
      },
    });

    // ---------------- 8. 旧稿导入 ----------------
    tool({
      name: 'novel_import',
      description: '旧稿导入：把已有小说存稿一键接入作品工程——自动按「第X章」标记分章、逐章落盘到 正文/，并用模型从全文逆推大纲、人物卡与设定集写入工程。适合把存量作品（txt 整书、导出章节）纳入工程化管理后开始 AI 辅助连载。',
      timeoutMs: 600000,
      parameters: {
        ...routeParams,
        text: { type: 'string', description: '旧稿全文（含「第X章」等章节标记的长文本）', required: true },
        title: { type: 'string', description: '作品名（写入索引，可选）' },
        chapter_number: { type: 'integer', description: '起始章号（默认 1，已有章节续接时改这里）' },
        reverse: { type: 'boolean', description: '是否逆推大纲/人物卡/设定集（默认 true）' },
      },
      run: async (args, exec) => {
        const fs = ctx.get('fs');
        const sp = ctx.get('sandboxPolicy');
        if (fs === undefined || sp === undefined) throw new Error('文件系统服务不可用');
        const session = exec && exec.agent ? exec.agent.session : undefined;
        const policy = sp.resolve(session !== undefined ? { session } : {});
        const root = workspaceRoot(exec, sp);
        const text = args && typeof args.text === 'string' ? args.text : '';
        if (!text.trim()) throw new Error('缺少旧稿文本（text）');
        const start = args && args.chapter_number ? args.chapter_number : 1;

        // 1) 分章：以独立的「第X章/回/节 标题」行为界
        const headingRe = /^第[0-9零一二三四五六七八九十百千两]+[章回节].{0,30}$/;
        const chapters = [];
        let cur = null;
        for (const raw of text.split('\n')) {
          const line = raw.trim();
          if (headingRe.test(line)) {
            if (cur) chapters.push(cur);
            cur = { title: line, body: [] };
          } else {
            if (!cur) cur = { title: '', body: [] };
            cur.body.push(raw);
          }
        }
        if (cur) chapters.push(cur);
        const real = chapters.filter((c) => (c.body.join('\n').trim().length > 0) || c.title);
        if (!real.length) throw new Error('未能识别出任何章节，请确认文本包含「第X章」类章节标记');

        // 2) 逐章落盘（文件名去掉原「第X章」前缀，按新序号重排）
        const saved = [];
        for (let i = 0; i < real.length; i++) {
          const body = real[i].body.join('\n').trim();
          if (!body) continue;
          const cleanTitle = real[i].title.replace(/^第[0-9零一二三四五六七八九十百千两]+[章回节]\s*[:：、.\-—]?\s*/, '');
          const file = await saveChapterFile(fs, root, policy, start + saved.length, cleanTitle, body);
          saved.push(file);
        }
        const out = [`已导入 ${saved.length} 章到 正文/（第${start}章起）`];

        // 3) 逆推工程材料（抽样限额，防超长）
        if (args && args.reverse === false) {
          out.push('已跳过逆推（reverse=false）');
        } else {
          const CAP = 48000;
          const sample = text.length > CAP
            ? `${text.slice(0, 30000)}\n…（中略）\n${text.slice(-15000)}`
            : text;
          const note = text.length > CAP ? '（材料过长已抽样，建议导入后人工补全）' : '';
          const gen = async (sys) => generate(sys, `【旧稿全文${note}】\n${sample}`, args, exec, { maxTokens: 5000 });
          const outlineSys = `${plottingSystem}

你现在担任网文结构编辑。通读旧稿，逆推一份结构化大纲（Markdown）：分卷-分章列出每章主要事件、转折与钩子；标注推断出的主线/支线。只依据文本内容，不臆造。`;
          const charSys = `${leanSystem}\n\n你现在担任角色分析师。通读旧稿，为主要出场人物各建一张人物卡：每人用「## 角色名」做二级标题开头，包含基本信息、性格与口癖、动机、关系（用双链 [[对方名]]）、当前状态（以文本末尾为准）。只依据文本内容。`;
          const setSys = `${leanSystem}\n\n你现在担任设定考古员。通读旧稿，把文本中出现的世界观设定按类别整理：每类用「## 类别名」做二级标题开头（如力量体系、地理、势力），类别之间用双链互相关联。只依据文本内容，不臆造。`;
          const [outline, chars, sets] = [
            await gen(outlineSys),
            await gen(charSys),
            await gen(setSys),
          ];
          const writeFile = async (rel, body) => {
            const target = await fs.resolve(rel, { cwd: root });
            await fs.writeText(target, body.trim() + '\n', undefined, undefined, policy);
          };
          await writeFile('大纲/总纲.md', '# 总纲（novel_import 逆推）\n\n' + outline);
          // 人物卡：按「## 角色名」拆分为每人一文件
          const charSections = chars.split(/\n(?=## )/);
          const charFiles = [];
          for (const sec of charSections) {
            const m = sec.match(/^## (.+)$/m);
            if (!m) continue;
            const name = safeName(m[1].trim());
            if (!name) continue;
            await writeFile(`人物卡/${name}.md`, sec.trim());
            charFiles.push(name);
          }
          // 设定集：按「## 类别名」拆分为每类一文件
          const setSections = sets.split(/\n(?=## )/);
          const setFiles = [];
          for (const sec of setSections) {
            const m = sec.match(/^## (.+)$/m);
            if (!m) continue;
            const name = safeName(m[1].trim());
            if (!name) continue;
            await writeFile(`设定集/${name}.md`, sec.trim());
            setFiles.push(name);
          }
          // 更新索引
          if (charFiles.length > 0) {
            await writeFile('人物卡/_索引.md', `# 人物卡索引\n\n> 每个角色一个文件；关系用双链互链\n\n${charFiles.map((n) => `- [[人物卡/${n}|${n}]]`).join('\n')}\n`);
          }
          if (setFiles.length > 0) {
            await writeFile('设定集/_索引.md', `# 设定集索引\n\n> 每类设定一个文件\n\n${setFiles.map((n) => `- [[设定集/${n}|${n}]]`).join('\n')}\n`);
          }
          out.push(`已逆推并写入：大纲/总纲.md、人物卡/（${charFiles.length} 人：${charFiles.join('、')}）、设定集/（${setFiles.length} 类：${setFiles.join('、')}）`);
          if (note) out.push(note);
        }
        if (args && args.title) {
          const listLines = saved.map((f) => '- [[' + f.replace(/^正文\//, '').replace(/\.md$/, '') + ']]').join('\n');
          const readme = '# ' + args.title + '\n\n> 作品索引（由 novel_project 维护；旧稿由 novel_import 导入）\n\n- 章节数：' + saved.length + '\n\n## 章节\n\n' + listLines + '\n';
          const target = await fs.resolve('README.md', { cwd: root });
          await fs.writeText(target, readme, undefined, undefined, policy);
          out.push('已更新索引：README.md');
        }
        return out.join('\n');
      },
    });

    // ---------------- 9. 全书体检 ----------------
    tool({
      name: 'novel_scan_book',
      description: '全书体检：直接读取作品工程（人物卡/设定集/伏笔清单/大纲 + 正文章节），做跨章一致性扫描与 AI 重复检测——人物言行矛盾、时间线错位、设定冲突、战力崩坏、伏笔遗忘，以及跨章重复的套路句/比喻/反应动作。不用粘贴文本，工程在手即扫；连载中期定期跑一次。',
      timeoutMs: 600000,
      parameters: {
        ...routeParams,
        scope: { type: 'string', enum: ['最近章节', '全书抽样'], description: '扫描范围，默认最近章节' },
        chapter_count: { type: 'integer', description: '纳入扫描的章数（1-12），默认 5' },
        focus: { type: 'array', items: { type: 'string', enum: ['人物一致性', '时间线', '设定冲突', '战力体系', '伏笔遗忘', '跨章重复'] }, description: '检查重点，默认全部' },
      },
      run: async (args, exec) => {
        const fs = ctx.get('fs');
        const sp = ctx.get('sandboxPolicy');
        if (fs === undefined || sp === undefined) throw new Error('文件系统服务不可用');
        const session = exec && exec.agent ? exec.agent.session : undefined;
        const policy = sp.resolve(session !== undefined ? { session } : {});
        const root = workspaceRoot(exec, sp);
        const proj = openProject(fs, root, policy);

        // 选章
        const names = await proj.listMd('正文');
        const parsed = names
          .map((n) => ({ n, num: parseInt((n.match(/^第(\d+)章/) || [])[1], 10) }))
          .filter((c) => !Number.isNaN(c.num));
        if (!parsed.length) throw new Error('正文/ 下没有可扫描的章节文件，请先保存或导入章节');
        parsed.sort((a, b) => a.num - b.num);
        const count = args && args.chapter_count ? Math.max(1, Math.min(12, args.chapter_count)) : 5;
        const scope = args && args.scope === '全书抽样' ? '全书抽样' : '最近章节';
        let picked;
        if (scope === '全书抽样' && parsed.length > 4) {
          const head = parsed.slice(0, 2);
          const tail = parsed.slice(-Math.max(count - 3, 1));
          const mid = [parsed[Math.floor(parsed.length / 2)]];
          picked = [...head, ...mid, ...tail];
        } else {
          picked = parsed.slice(-count);
        }
        const seen = new Set();
        const chapters = [];
        for (const p of picked) {
          if (seen.has(p.n)) continue;
          seen.add(p.n);
          const t = await proj.readMaybe(`正文/${p.n}`, 9000);
          if (t) chapters.push(`### ${p.n}\n${t}`);
        }

        // 工程材料
        const readDir = async (dir, cap, maxFiles) => {
          const files = await proj.listMd(dir);
          const parts = [];
          for (const f of files.slice(0, maxFiles)) {
            const t = await proj.readMaybe(`${dir}/${f}`, cap);
            if (t) parts.push(`### ${dir}/${f}\n${t}`);
          }
          return parts.join('\n\n');
        };
        const [chars, sets, outline, foreshadow] = await Promise.all([
          readDir('人物卡', 2500, 6),
          readDir('设定集', 2500, 6),
          readDir('大纲', 2500, 4),
          proj.readMaybe('伏笔清单.md', 2500),
        ]);

        const system = `${continuitySystem}

你现在担任长篇连贯性审稿编辑，对「正文章节」做跨章体检，材料包括工程文件与正文章节。

逐项检查（按「检查重点」执行，默认全部）：
1. 人物一致性：言行、口癖、关系、状态与人物卡/前文是否矛盾；是否降智。
2. 时间线：事件先后、时长、年龄与时间线.md 是否错位。
3. 设定冲突：力量/等级/规则与设定集前后矛盾。
4. 战力体系：强弱表现是否崩坏、越级是否合理。
5. 伏笔遗忘：伏笔清单中「铺设中/发酵中」的伏笔是否长期未被提及（对照章节范围说明）。
6. 跨章重复：多章反复出现的同一套路句、同一比喻、同一反应动作（AI 通病）——列出来源章节。

输出格式（Markdown）：
## 问题清单
（每条：【位置/章节】【类型】【问题描述】【严重度：高/中/低】【修复建议】；按严重度排序）
## 跨章重复清单
（重复的表达 + 出现章节列表 + 替换建议；无则写「未发现明显重复」）
## 总体结论
（一句话健康度评价 + 下一步建议）`;

        const user = compose([
          chars ? field('人物卡（工程材料）', chars) : '（人物卡为空）',
          sets ? field('设定集（工程材料）', sets) : '（设定集为空）',
          outline ? field('大纲（工程材料）', outline) : '（大纲为空）',
          foreshadow ? field('伏笔清单', foreshadow) : '（伏笔清单为空）',
          field('检查重点', pick(args && args.focus, ['人物一致性', '时间线', '设定冲突', '战力体系', '伏笔遗忘', '跨章重复'])),
          `【扫描范围】${scope}（共 ${chapters.length} 章：${[...seen].join('、')}）`,
          field('正文章节', chapters.join('\n\n')),
        ]);
        return generate(system, user, args, exec, { maxTokens: 7000 });
      },
    });

    // ---------------- 工作法路由提示段（薄常驻层） ----------------
    // 分层原则：创作任务与方法论全部住在 skills/（Agent 加载后亲自完成），
    // 工具只负责确定性检查与工程编排；常驻层只保留硬流程、路由索引与硬纪律，
    // 不挤占每回合的上下文预算。
    disposers.push(ctx.systemPrompt.section({
      name: 'novel:methodology',
      order: 50,
      text: `【小说助手工作法】——硬流程与路由索引，任何时候都要遵守：

一、分工：创作任务你自己做，工具负责检查与编排
- 润色、大纲、细纲、拆书、评阅、对话、场景、采访、合规、起名、简介等创作任务：加载对应 skill 后**亲自完成**，不要寻找不存在的工具。
- 工具只用于代码擅长的事：novel_lint（AI 味确定性检查）、novel_style_profile（文风卡）、novel_continue（自动衔接续写）、novel_write_chapter（单章成稿流水线）、novel_briefing（写前简报）、novel_archive（章后归档）、novel_project（作品工程）、novel_import（旧稿导入）、novel_scan_book（全书体检）。

二、自写自检循环（亲写正文时必走）
按 skill 规范写完 → 把正文交给 novel_lint 检查 →【必须修】项逐句修复 → 再跑一次确认清零。lint 是纯代码规则秒回，不要省这一步。

三、每章标准闭环（长篇连载，顺序固定）
写前简报（novel_briefing）→ 单章成稿（novel_write_chapter，auto_context 默认自动注入工程材料与文风卡）→ 章后归档（novel_archive）→ 定期整理索引（novel_project）。没有简报不动笔；归档时伏笔清单、时间线、人物状态三项缺一不算完成。

四、skill 路由（动笔前加载对应 skill，按其规范执行）
- 写/改/润色/去AI味任何正文 → novel-prose-standards（正文铁律 + 润色/改写/对话/翻译任务流程）
- 动笔前查设定、衔接前文、归档回填、漏洞排查 → novel-continuity
- 总纲/卷纲/细纲/章节规划/情节推演/灵感/书名简介包装 → novel-plotting
- 场景写作/黄金三章/角色采访/人物出场 → novel-craft
- 小说分析/拆书/评阅/模拟读者团/合规体检/起名 → novel-analysis
- 工程初始化/人物卡设定集建档/归档/索引/旧稿/Obsidian → novel-project

五、硬纪律
1. 正文纯文本（无 markdown/emoji/标题）；大纲分析报告可用 Markdown。
2. 工程内有 文风卡.md 时动笔前必读并对齐（novel_style_profile 生成与更新）；没有文风卡的长篇以最近一两章为文风基准。
3. 可量化的 AI 味检查交给 novel_lint；模型自查只兜底不可量化项（视角越界、情绪标签、说明书腔）。
4. 人物卡先查后写、新设定先入设定集再进正文、伏笔必登记；称谓、战力、时间线全书一致。
5. 去 AI 味只用于外来文本与旧稿；正式成稿走「落笔即防」，不做「先带 AI 味、事后去味」的二道工序。
6. 断更或新会话续写：先读最近归档、伏笔清单与上一章结尾找回状态，再动笔。`,
    }));

    return () => { for (const d of disposers) d(); };
  },
};
