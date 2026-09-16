/**
 * 长文本批量导入引擎
 *
 * 解决的问题
 *   手边常有一大坨现成的指令集合——从别的工具导出的、聊天记录里攒的、
 *   某份手册里整整一节的模板。逐条复制进本应用是纯体力活。
 *   这个模块把「一大坨文本」自动拆成「一条条可入库的指令」。
 *
 * 设计原则
 *   1. 规则优先。结构化文本（有分隔线、有编号标题）靠规则就能切干净，
 *      不联网、不消耗 API、不上传用户数据。AI 只作兜底增强。
 *   2. 不猜。切不准的地方标出来（warnings），宁可让用户改，也不静默丢内容。
 *   3. 可回溯。每条候选记录它在原文中的行号区间，用户能对照原文核验。
 *   4. 幂等。同一段文本分析两次，结果必须一致（无时间戳、无随机数参与）。
 *
 * 本模块不依赖 DOM，可在 Node 下直接测试。
 */

import { md5Hex, utf8Bytes } from './hash.js';
import { classifyByRules } from './classify.js';

/* ================================================================== 常量 */

/** 只由这些字符组成、且长度足够的行，视为分隔线 */
const SEP_RE = /^\s*(?:[-=_~*─═—–·※]{6,})\s*$/;
/** 代码围栏 */
const FENCE_RE = /^\s*```/;

/**
 * 已知技能名。出现在正文里即视为「点名了某个能力」，
 * 这既是强指令信号，也是很好的标签来源。
 */
const SKILL_RE = /\b([a-z][a-z0-9]*(?:-[a-z0-9]+){1,3})\b/g;
const SKILL_WHITELIST = new Set([
  'nature-reader', 'nature-paper-card', 'nature-paper2ppt', 'nature-image2ppt',
  'nature-polishing', 'nature-writing', 'nature-reviewer', 'nature-response',
  'nature-citation', 'nature-academic-search', 'nature-ref-verifier', 'nature-data',
  'nature-statistics', 'nature-figure', 'nature-paper-to-patent', 'nature-experiment-log',
  'nature-literature-pipeline', 'nature-downloader', 'researchwrite',
]);

/**
 * 说明性标题的判据。
 *
 * 刻意用「以此开头」而不是「包含」——「产品说明书撰写」是个正经指令，
 * 「使用说明」不是。包含式匹配会把前者一起误伤。
 */
const NOISE_TITLE_RE =
  /^(?:使用说明|使用方式|使用指南|使用手册|速查表|速查|运行环境|环境配置|排错|故障|常见问题|注意事项|目录|前言|文档结束|更新日志|更新说明|更新技能|版本记录|通用前缀|通用约束|通用规则|约束句|占位符|常用占位符|怎么用|如何用|附录|免责|changelog|license)/i;

/** 祈使句信号：指令几乎总是「动词开头 / 要求式」的 */
const IMPERATIVE_RE =
  /(要求[:：]|使用\s*[a-z\u4e00-\u9fff]|请|帮我|把.{0,24}(改成|转成|整理|生成|做成|还原)|需要你替换|需要产出|按.{0,12}(执行|顺序|步骤)|执行以下|遵守以下|逐条|输出到|保存到|写到|写入)/;

/**
 * 真正的动作词。
 * 用来区分「指令」和「通则」——后者全是约束句（不要编造、保留原值），
 * 却没有一个动词说明要干什么。这类内容更该进备注而不是正文。
 */
const ACTION_RE =
  /(生成|整理|写|翻译|润色|检索|下载|审查|核验|绘制|制作|拆解|分析|检查|转换|还原|总结|提取|归纳|对比|复盘|起草|列出|给出|输出|导出|汇报|精读|复现)/;

/* ================================================================== 工具 */

/** 把任意文本归一化成指纹用字符串：去空白、去标点、转小写 */
function normalizeForFp(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。、；：！？""''（）【】《》〈〉·,.!?;:'"()<>[\]{}|\\/`~@#$%^&*+=_—-]+/g, '');
}

/** 内容指纹（md5 前 20 位）——用于跨次分析、跨库比对去重 */
export function fingerprint(text) {
  const norm = normalizeForFp(text);
  if (!norm) return '';
  return md5Hex(utf8Bytes(norm)).slice(0, 20);
}

/** 字符二元组 Dice 相似度，用于「疑似重复」判断 */
export function similarity(a, b) {
  const x = normalizeForFp(a);
  const y = normalizeForFp(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return x === y ? 1 : 0;
  const grams = (s) => {
    const m = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) || 0) + 1);
    }
    return m;
  };
  const gx = grams(x);
  const gy = grams(y);
  let inter = 0;
  let total = 0;
  for (const [g, c] of gx) {
    total += c;
    const d = gy.get(g);
    if (d) inter += Math.min(c, d);
  }
  for (const c of gy.values()) total += c;
  return total ? (2 * inter) / total : 0;
}

/** 行级：是否为分隔线 */
export function isSeparator(line) {
  return SEP_RE.test(line);
}

/**
 * 行级：识别标题
 * @returns {{number:string|null, title:string, hasDot:boolean}|null}
 */
export function headingInfo(line) {
  const t = String(line || '').trim();
  if (!t || t.length > 120) return null;
  let m;

  // 【3.1】读论文：中英对照全文   /  〔3.1〕…  /  [3.1] …
  if ((m = t.match(/^[【〔\[]\s*(\d+(?:\.\d+)*)\s*[】〕\]]\s*(.*)$/))) {
    return { number: m[1], title: m[2].trim(), hasDot: m[1].includes('.') };
  }
  // ■ 3  单技能指令模板   /  ■ 标题
  if ((m = t.match(/^■+\s*(\d+(?:\.\d+)*)?\s*[、.)）]?\s*(.*)$/))) {
    const num = m[1] || null;
    return { number: num, title: (m[2] || '').trim(), hasDot: Boolean(num && num.includes('.')) };
  }
  // ### 3.1 标题   /   ## 标题
  if ((m = t.match(/^#{1,6}\s+(\d+(?:\.\d+)*)?\s*[、.)）]?\s*(.*)$/))) {
    const num = m[1] || null;
    const title = (m[2] || '').trim();
    if (!num && !title) return null;
    return { number: num, title, hasDot: Boolean(num && num.includes('.')) };
  }
  // 3.1 标题（纯编号，必须有小数点才算，避免把「1. 每个模板…」当成标题）
  if ((m = t.match(/^(\d+\.\d+(?:\.\d+)*)\s*[、.)）]?\s*(\S.*)$/))) {
    return { number: m[1], title: m[2].trim(), hasDot: true };
  }
  // 一、标题（中文序号，且整行很短）
  if ((m = t.match(/^[（(]?([一二三四五六七八九十]+)[)）、.]\s*(\S.{0,39})$/))) {
    return { number: null, title: m[2].trim(), hasDot: false, cn: m[1] };
  }
  return null;
}

/** 行级：是否为元数据行（技能：xxx / 需要你替换：xxx） */
export function metaOf(line) {
  const t = String(line || '').trim();
  if (!t) return null;
  let m;
  if ((m = t.match(/^(?:技能|skill|使用技能)\s*[:：]\s*(.+)$/i))) {
    return { key: 'skill', value: m[1].trim() };
  }
  if ((m = t.match(/^(?:需要你替换|需要替换|替换|把)\s*[:：]\s*(.+)$/))) {
    return { key: 'replace', value: m[1].trim() };
  }
  if ((m = t.match(/^(?:需要产出|产出|交付物)\s*[:：]\s*(.+)$/))) {
    return { key: 'deliver', value: m[1].trim() };
  }
  if ((m = t.match(/^(?:听众|听众背景|适用|场景|场景背景)\s*[:：]\s*(.+)$/))) {
    return { key: 'context', value: m[1].trim() };
  }
  if ((m = t.match(/^(?:标签|tags?)\s*[:：]\s*(.+)$/i))) {
    return { key: 'tags', value: m[1].trim() };
  }
  return null;
}

/** 纯编号（3.1 / 12 / 1.2.3）不是占位符，是章节序号 */
const INDEX_ONLY_RE = /^\d+(?:\.\d+)*$/;

/** 提取 【…】 占位符 */
export function extractVariables(text) {
  const out = [];
  const seen = new Set();
  const re = /【([^】\n]{1,40})】/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const v = m[1].trim();
    if (!v || seen.has(v)) continue;
    if (INDEX_ONLY_RE.test(v)) continue; // 【3.1】【12】这类是序号，不是要替换的内容
    seen.add(v);
    out.push(v);
  }
  return out;
}

/** 从文本里扫出已知技能名 */
export function extractSkills(text) {
  const out = new Set();
  const s = String(text || '');
  let m;
  SKILL_RE.lastIndex = 0;
  while ((m = SKILL_RE.exec(s))) {
    const name = m[1].toLowerCase();
    if (SKILL_WHITELIST.has(name)) out.add(name);
  }
  return Array.from(out);
}

/* ================================================================== 分块 */

/**
 * 按分隔线把文本切成片段。
 * 分隔线在此类文档里的作用往往是「标题区 / 正文区」的分界，而不是纯块边界，
 * 所以这里只切分、不判定归属，归属交给 coalesce 处理。
 */
function splitBySeparator(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const segs = [];
  let cur = [];
  let start = 0;
  let inFence = false;

  const flush = (endLine) => {
    if (cur.some((l) => l.trim())) segs.push({ startLine: start, endLine, lines: cur });
    cur = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE_RE.test(line)) inFence = !inFence;
    if (!inFence && isSeparator(line)) {
      flush(i - 1);
      start = i + 1;
      continue;
    }
    if (!cur.length) start = i;
    cur.push(line);
  }
  flush(lines.length - 1);

  return segs.map((s, i) => ({ ...s, index: i }));
}

/**
 * 片段是否是「纯头部」——只由标题行和元数据行组成，没有任何正文。
 * 这类片段要跟后面的正文片段合并成一条。
 *
 * 判定必须严格：每一行都得是标题或元数据行。
 * （这里写错过一次：加了「不是项目符号行」的条件，
 *   而它对所有不以 - • * 开头的行都成立，于是每个块都被判成纯头部，
 *   整篇文本被合并成一条。教训：合取条件里的每一项都要真的能收窄集合。）
 */
function isHeaderOnly(seg) {
  const body = seg.lines.map((l) => l.trim()).filter(Boolean);
  if (!body.length) return true;
  if (body.length > 8) return false;
  if (body.join('').length > 300) return false;
  return body.every((l) => Boolean(headingInfo(l) || metaOf(l)));
}

/**
 * 把纯头部片段并入紧随其后的正文片段。
 *
 * 这类文档的典型结构是「标题 + 元数据 → 分隔线 → 正文」，
 * 分隔线两侧本属同一条内容，必须合起来才是一段完整指令。
 * 连续多个纯头部（如「■ 3 单技能指令模板」+「【3.1】读论文…」）一并合并，
 * 具体取哪个当标题交给 parseBlock 判断。
 */
function coalesce(segs) {
  const out = [];
  let i = 0;
  while (i < segs.length) {
    if (!isHeaderOnly(segs[i])) {
      out.push(segs[i]);
      i++;
      continue;
    }
    // 收集连续的纯头部片段
    let j = i;
    const heads = [];
    while (j < segs.length && isHeaderOnly(segs[j])) {
      heads.push(segs[j]);
      j++;
    }
    if (j < segs.length && heads.length <= 3) {
      // 后面还有正文：头部与正文合成一条
      out.push({
        startLine: heads[0].startLine,
        endLine: segs[j].endLine,
        lines: [...heads.flatMap((h) => h.lines), ...segs[j].lines],
        index: heads[0].index,
      });
      i = j + 1;
    } else {
      // 已到末尾，或连续头部过多（说明是一串短标题）：各自保留
      for (const h of heads) out.push(h);
      i = j;
    }
  }
  return out;
}

/** 没有分隔线时：按标题行切 */
function splitByHeading(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const segs = [];
  let cur = null;
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE_RE.test(line)) inFence = !inFence;
    const h = !inFence ? headingInfo(line) : null;
    if (h && cur && cur.lines.length > 1) {
      segs.push(cur);
      cur = { startLine: i, endLine: i, lines: [line], index: segs.length };
      continue;
    }
    if (!cur) cur = { startLine: i, endLine: i, lines: [], index: 0 };
    cur.lines.push(line);
    cur.endLine = i;
  }
  if (cur && cur.lines.some((l) => l.trim())) segs.push({ ...cur, index: segs.length });
  return segs;
}

/**
 * 自适应分块。
 * 分隔线数量足够就按分隔线切，否则按标题切。
 */
export function splitBlocks(text, { minSeparators = 3 } = {}) {
  const seps = splitBySeparator(text);
  let blocks;
  if (seps.length >= minSeparators) {
    blocks = coalesce(seps);
  } else {
    const byHead = splitByHeading(text);
    blocks = byHead.length > 1 ? byHead : coalesce(seps);
  }
  // 丢弃空块
  return blocks.filter((b) => b.lines.some((l) => l.trim()));
}

/* ================================================================== 字段抽取 */

/**
 * 表格行占比——速查表这类内容不该被当成指令。
 *
 * 两种形态都要抓：
 *   管道表格        | 列 | 列 |
 *   对照式列表      读论文 → nature-reader
 * 后者不能只看「有没有箭头」，要看「是不是每行都有」——
 * 指令正文里偶尔出现一个箭头（「问题 → 缺口 → 方案」）是正常的。
 */
function tableRatio(lines) {
  const body = lines.map((l) => l.trim()).filter(Boolean);
  if (!body.length) return 0;
  const piped = body.filter((l) => (l.match(/[│|]/g) || []).length >= 2 || /^\s*[+-]{3,}/.test(l));
  const arrowed = body.filter((l) => /[→⇒⇢]|=>|\s{4,}[-—]{1,2}\s*\S/.test(l));
  return Math.max(piped.length, arrowed.length) / body.length;
}

/**
 * 把一个块解析成候选条目。
 * @param {object} block splitBlocks 的产物
 * @param {object} ctx  { section: string|null }
 */
export function parseBlock(block, ctx = {}) {
  const rawLines = block.lines;
  const warnings = [];
  let section = ctx.section || null;

  // ---- 1. 找出块内所有标题行，挑出「最具体」的那个当条目标题
  //    同一块里可能有「■ 3 单技能指令模板」+「【3.1】读论文…」两层，
  //    有小数点的编号是条目，没有的只是容器，后者降级为来源章节。
  const headings = [];
  rawLines.forEach((line, idx) => {
    const h = headingInfo(line);
    if (h) headings.push({ idx, info: h });
  });

  let pick = null;
  const dotted = headings.filter((h) => h.info.hasDot);
  if (dotted.length) pick = dotted[dotted.length - 1];
  else if (headings.length) pick = headings[headings.length - 1];

  if (pick) {
    const above = headings.filter((h) => h.idx < pick.idx);
    if (above.length) {
      // 标题上有更上层的标题 → 那是章节
      const c = above[above.length - 1].info;
      section = (c.number ? c.number + ' ' : '') + c.title;
    } else if (!pick.info.hasDot) {
      // 本块只有这一个标题、且它没有小数点编号 → 它自己就是章节标题
      section = (pick.info.number ? pick.info.number + ' ' : '') + pick.info.title;
    }
  }
  const head = pick ? pick.info : null;

  // ---- 2. 分离头部行（标题 + 元数据）与正文行
  const metas = { skill: null, replace: null, deliver: null, context: null, tags: null };
  const bodyLines = [];
  let headConsumed = false; // 头部区 = 块开头连续的「标题行 + 元数据行」

  for (const line of rawLines) {
    const t = line.trim();
    if (!t) {
      if (headConsumed) bodyLines.push('');
      continue;
    }
    if (isSeparator(t)) continue;

    if (!headConsumed) {
      // 标题行吃掉，但**不结束头部区**——标题下面往往还跟着
      // 「技能：xxx」「需要你替换：xxx」这类元数据行，它们也属于头部。
      // （早先写成「遇到标题就结束头部区」，结果元数据行全被当成正文留在 content 里。）
      if (headingInfo(t)) continue;
      const mt = metaOf(t);
      if (mt) {
        metas[mt.key] = mt.value;
        continue;
      }
      // 第一行真正的正文：从这里开始头部区结束
      headConsumed = true;
      bodyLines.push(line);
      continue;
    }
    bodyLines.push(line);
  }

  // ---- 3. 标题兜底
  let title = head ? head.title : '';
  if (!title) {
    const firstText = bodyLines.map((l) => l.trim()).find(Boolean) || '';
    title = firstText.slice(0, 40);
    if (firstText.length > 40) warnings.push('标题由正文首行截取，建议核对');
  }

  title = title
    .replace(/^[【〔\[]\s*[】〕\]]\s*/, '')
    .replace(/^[-—·•※*#\s]+/, '')
    .replace(/[\s:：、，,。;；]+$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!title) {
    title = '未命名指令';
    warnings.push('原文中未能识别出标题');
  }

  // ---- 4. 正文：只去首尾空行，保留内部结构
  while (bodyLines.length && !bodyLines[0].trim()) bodyLines.shift();
  while (bodyLines.length && !bodyLines[bodyLines.length - 1].trim()) bodyLines.pop();
  const content = bodyLines.join('\n').replace(/\n{4,}/g, '\n\n\n').trim();

  // 注意：这里刻意不把头部的「需要你替换：…」拼回正文。
  // 它是这本手册的组织方式，不是指令本身的一部分；其中要替换的字段
  // 会作为变量列进备注，正文保持原样，用户复制走的就是能直接用的那段。

  // ---- 5. 标签 / 变量 / 技能
  const skills = extractSkills([metas.skill || '', title, content].join('\n'));
  if (metas.skill) {
    for (const s of metas.skill.split(/[、,，\s/]+/).filter(Boolean)) {
      const key = s.toLowerCase();
      if (SKILL_WHITELIST.has(key)) skills.push(key);
    }
  }
  const tags = Array.from(new Set(skills));
  if (metas.tags) {
    for (const t of metas.tags.split(/[、,，\s]+/).filter(Boolean)) tags.push(t);
  }

  // 变量 = 正文里的占位符 + 「需要你替换」行里声明的
  const variables = Array.from(
    new Set([...extractVariables(content), ...extractVariables(metas.replace || '')])
  );

  // ---- 6. 备注
  const noteParts = [];
  if (section) noteParts.push(`来源：${section}`);
  if (metas.context) noteParts.push(metas.context);
  if (variables.length) noteParts.push(`需要替换：${variables.join('、')}`);
  const note = noteParts.join('　|　');

  // ---- 7. 分类预判
  let category = 'other';
  let categoryConf = 0;
  try {
    const r = classifyByRules({ title, content, note, tags });
    if (r && r.category) {
      category = r.category;
      categoryConf = r.confidence || 0;
    }
  } catch (_) {
    /* 分类失败不影响导入 */
  }

  // ---- 8. 指令性评分
  const scored = scoreImport({ title, content, tags, variables, metas, lines: rawLines });

  // 块里除了标题行，还有没有别的东西？
  // 这决定它是不是一个「光杆章节标题」——那种该丢，而带一句说明的章节该留。
  const hasBody = rawLines.some((l) => {
    const t = l.trim();
    return t && !isSeparator(t) && !headingInfo(t);
  });

  return {
    id: `c-${block.index}-${block.startLine}`,
    title,
    content,
    note,
    tags: Array.from(new Set(tags)),
    category,
    categoryConf,
    variables,
    skill: skills[0] || null,
    section,
    number: head?.number || null,
    hasBody,
    kind: scored.kind,
    score: scored.score,
    scoreWhy: scored.why,
    selected: scored.kind === 'prompt',
    warnings,
    sourceRange: [block.startLine + 1, block.endLine + 1],
    fingerprint: fingerprint(content),
    original: rawLines.join('\n'),
  };
}

const KIND_LABEL = { prompt: '指令', note: '说明', table: '表格', fragment: '片段' };
export function kindLabel(k) {
  return KIND_LABEL[k] || k;
}

/**
 * 判定这块内容「像不像一条可以入库的指令」。
 *
 * 这是整个模块最关键的判断。判错了的代价是不对称的：
 *   把说明塞进指令库 → 库变脏，用户要一条条删
 *   把指令误判成说明 → 用户取消勾选即可，成本低
 * 所以阈值偏保守：宁可漏勾，不要误勾。
 */
function scoreImport({ title, content, tags, variables, metas, lines }) {
  let score = 0;
  const why = [];

  if (tags.length) { score += 4; why.push('点名了技能'); }
  if (variables.length) { score += 2; why.push(`含 ${variables.length} 个占位符`); }
  if (IMPERATIVE_RE.test(content)) { score += 2; why.push('含祈使句'); }
  if (metas.replace || metas.deliver) { score += 2; why.push('声明了输入/产出'); }
  if (content.length >= 150) { score += 1; why.push('正文完整'); }

  // 有没有真动作。只有约束、没有说话动词的，是「通则/前缀」而不是指令
  if (ACTION_RE.test(content)) { score += 2; why.push('含动作词'); }
  else if (IMPERATIVE_RE.test(content)) { score -= 1; why.push('只有约束没有动作'); }

  const tr = tableRatio(lines);
  if (tr > 0.4) { score -= 5; why.push(`对照式内容占 ${Math.round(tr * 100)}%`); }
  const noisy = NOISE_TITLE_RE.test(title);
  if (noisy) { score -= 6; why.push('标题像说明性章节'); }
  if (content.length < 60) { score -= 4; why.push('正文过短'); }
  else if (content.length < 120) { score -= 1; }

  // 既没动作词、也没占位符、也没点名技能 —— 大概率是在描述或引用，不是在派活
  if (!ACTION_RE.test(content) && !variables.length && !tags.length) {
    score -= 3;
    why.push('无动作词、无占位符');
  }

  // 说明性标题是一道否决线：这类段落里常引用技能名、也常出现「输出到」，
  // 靠扣分压不住（实测「运行环境与排错」扣完 6 分还剩 5 分，照样越线）。
  // 要求它拿到明显高于普通指令的分数，才允许翻案。
  let kind;
  if (noisy && score < 12) kind = 'note';
  else if (score >= 5) kind = 'prompt';
  else if (tr > 0.4) kind = 'table';
  else if (content.length < 60) kind = 'fragment';
  else kind = 'note';

  return { score, why, kind };
}

/* ================================================================== 主入口 */

/**
 * 分析长文本，产出候选条目列表。
 *
 * @param {string} text
 * @param {object} opts
 * @param {Array}  opts.existing   已有指令，用于去重标记
 * @returns {{items:Array, stats:object, plan:string}}
 */
export function analyze(text, opts = {}) {
  const src = String(text || '');
  if (!src.trim()) {
    return { items: [], stats: emptyStats(), plan: 'empty' };
  }

  // 去掉用户可能带的标记前缀，如 "@long-text:"
  const cleaned = src.replace(/^\s*@[\w-]+\s*[:：]\s*/i, '');

  const blocks = splitBlocks(cleaned);
  const items = [];
  let section = null;

  for (const b of blocks) {
    const parsed = parseBlock(b, { section });
    if (parsed.section) section = parsed.section;

    // 光杆章节标题（块里除了标题行什么都没有）才直接丢弃。
    // 带正文的说明性章节仍然作为候选列出来（默认不勾选）——
    // 用户可能确实想把某段说明留档，静默丢掉比多列一行更糟。
    // 注意判据是「有没有正文行」而不是「正文长不长」：
    // 一句 30 字的说明也是内容，按长度判会把它当空标题丢掉。
    const bareContainer =
      parsed.number !== null &&
      !parsed.number.includes('.') &&
      parsed.kind !== 'prompt' &&
      parsed.hasBody === false;
    if (bareContainer) continue;

    items.push(parsed);
  }

  // 二次合并：碎片块并入前一条（同一指令被空行拆散的情况）
  const merged = mergeFragments(items);

  // 去重标记
  const existing = Array.isArray(opts.existing) ? opts.existing : [];
  markDuplicates(merged, existing);

  const stats = {
    blocks: blocks.length,
    total: merged.length,
    prompt: merged.filter((i) => i.kind === 'prompt').length,
    note: merged.filter((i) => i.kind === 'note').length,
    table: merged.filter((i) => i.kind === 'table').length,
    fragment: merged.filter((i) => i.kind === 'fragment').length,
    selected: merged.filter((i) => i.selected).length,
    duplicated: merged.filter((i) => i.dup).length,
    chars: src.length,
  };

  return { items: merged, stats, plan: 'rule' };
}

function emptyStats() {
  return { blocks: 0, total: 0, prompt: 0, note: 0, table: 0, fragment: 0, selected: 0, duplicated: 0, chars: 0 };
}

/** 过短的碎片并入前一条 */
function mergeFragments(items) {
  const out = [];
  for (const it of items) {
    const prev = out[out.length - 1];
    const isTiny = it.content.length < 60 && !it.variables.length && !it.tags.length;
    if (prev && isTiny && it.kind === 'fragment' && prev.sourceRange[1] + 3 >= it.sourceRange[0]) {
      prev.content += '\n\n' + (it.title && it.title !== '未命名指令' ? `**${it.title}**\n` : '') + it.content;
      prev.sourceRange[1] = it.sourceRange[1];
      prev.original += '\n' + it.original;
      prev.fingerprint = fingerprint(prev.content);
      if (!prev.warnings.includes('已合并相邻片段')) prev.warnings.push('已合并相邻片段');
      continue;
    }
    out.push(it);
  }
  return out;
}

/**
 * 与已有指令比对，标记重复。
 * 分三档：
 *   exact  内容指纹相同      → 完全重复
 *   title  标题完全相同      → 高度疑似
 *   high   内容相似度 >0.86  → 疑似
 */
export function markDuplicates(items, existing) {
  if (!existing.length) {
    for (const it of items) { it.dup = null; }
    return items;
  }
  const byFp = new Map();
  const byTitle = new Map();
  for (const p of existing) {
    if (p.deleted) continue;
    const fp = fingerprint(p.content);
    if (fp && !byFp.has(fp)) byFp.set(fp, p);
    const t = String(p.title || '').trim().toLowerCase();
    if (t && !byTitle.has(t)) byTitle.set(t, p);
  }

  for (const it of items) {
    it.dup = null;
    if (it.fingerprint && byFp.has(it.fingerprint)) {
      it.dup = { level: 'exact', title: byFp.get(it.fingerprint).title };
      it.selected = false;
      continue;
    }
    const t = it.title.trim().toLowerCase();
    if (t && byTitle.has(t)) {
      it.dup = { level: 'title', title: byTitle.get(t).title };
      it.selected = false;
      continue;
    }
  }

  // 内容相似度比对（只在数量不大时做，避免 O(n·m) 爆炸）
  if (existing.length <= 800) {
    for (const it of items) {
      if (it.dup) continue;
      const norm = normalizeForFp(it.content);
      if (norm.length < 40) continue;
      for (const p of existing) {
        if (p.deleted) continue;
        if (similarity(it.content, p.content) > 0.86) {
          it.dup = { level: 'high', title: p.title };
          it.selected = false;
          break;
        }
      }
    }
  }
  return items;
}

/** 组内互相比对，找出候选之间自己重复的（保留靠前的） */
export function markInternalDuplicates(items) {
  const seen = new Map();
  for (const it of items) {
    if (it.fingerprint && seen.has(it.fingerprint)) {
      it.dup = it.dup || { level: 'exact', title: seen.get(it.fingerprint).title, internal: true };
      it.selected = false;
      continue;
    }
    if (it.fingerprint) seen.set(it.fingerprint, it);
    const t = it.title.trim().toLowerCase();
    if (t && seen.has('t:' + t)) {
      it.dup = it.dup || { level: 'title', title: seen.get('t:' + t).title, internal: true };
      it.selected = false;
      continue;
    }
    if (t) seen.set('t:' + t, it);
  }
  return items;
}

/* ================================================================== 诊断 */

/**
 * 分析结果的自检报告。用于把「切得好不好」这件事变成可读的判断，
 * 而不是让用户自己去数。
 */
export function diagnose(result) {
  const notes = [];
  const { items, stats } = result;
  if (!items.length) {
    return { level: 'error', notes: ['没有从文本中解析出任何内容。请确认粘贴的是文本而不是图片或文件。'] };
  }
  const avg = items.reduce((s, i) => s + i.content.length, 0) / items.length;

  if (stats.total <= 2 && stats.chars > 2000) {
    notes.push(`文本约 ${stats.chars} 字符，却只切出 ${stats.total} 条——分隔结构可能不完整。可以手动在条目之间插入一行「--------」再试。`);
  }
  if (avg > 4000) {
    notes.push(`平均每条 ${Math.round(avg)} 字符，偏长。可能多个条目被并成了一条，或启用了 AI 辅助拆分。`);
  }
  if (stats.fragment > stats.total * 0.4) {
    notes.push(`${stats.fragment} 条被判定为碎片，说明原文的分块粒度太细（空行过多）。`);
  }
  if (!stats.prompt) {
    notes.push('没有任何条目被自动勾选——所有内容看起来都像说明性文字。请人工检查后手动勾选。');
  }
  const noTitle = items.filter((i) => i.warnings.some((w) => w.includes('标题'))).length;
  if (noTitle) notes.push(`${noTitle} 条的标题是自动截取的，建议核对。`);

  if (!notes.length) notes.push('解析正常。下面逐条确认后即可导入。');
  return { level: notes.length > 1 ? 'warn' : 'ok', notes };
}

/* ================================================================== AI 增强 */

/**
 * 用大模型增强拆分。
 *
 * 架构：**规则负责切与正文，AI 负责判断与命名**
 *
 * 一开始是让模型自己从一整段文本里找边界，实测不成立——
 * 小模型面对几千字的输入，会把它当成「一段要处理的文本」，处理完开头就宣告完成
 * （finish_reason=stop，只吐了一条，还偏偏是说明性章节）。
 *
 * 于是改成：规则先切块 → 让模型逐块表态。第二版仍然失败，原因是
 * **让模型把正文原样回吐**：块有 3500 字，模型就要输出 3500 字的 content，
 * 加上 JSON 转义直接顶到 max_tokens，返回被截断、JSON 解析失败，
 * 整批结果静默消失——测试里表现为一半条目凭空不见。
 *
 * 第三版（当前）：模型只回答「这块是不是指令」和「叫什么、打什么标签」，
 * 几十个 token 就够了；**正文一律取规则切出的原文，模型碰不到**。
 * 好处是三重的：不会截断、token 省一大截、正文物理上不可能被改写。
 *
 * @param {string} text
 * @param {object} deps
 * @param {Function} deps.chat   LLM 调用函数（签名同 llm.chat），注入以便测试
 * @param {number}   deps.batchChars 每批发给模型的字符预算
 */
export async function analyzeWithAI(text, { chat, batchChars = 8000, onProgress } = {}) {
  if (typeof chat !== 'function') throw new Error('未提供 chat 调用函数');

  const src = String(text || '').trim();
  if (!src) return { items: [], stats: emptyStats(), plan: 'ai' };

  const cleaned = src.replace(/^\s*@[\w-]+\s*[:：]\s*/i, '');
  const blocks = splitBlocks(cleaned);
  // 规则切出足够多的块 → 「逐块表态」模式；结构太松散才让模型自己找边界
  const structured = blocks.length >= 3 && blocks.length <= 500;

  const items = structured
    ? await judgeStructured(blocks, chat, { batchChars, onProgress })
    : (await splitLoosely(cleaned, chat, { onProgress })).map((r, i) => finalizeAIItem(r, i));

  markInternalDuplicates(items);

  const stats = {
    blocks: structured ? blocks.length : 1,
    total: items.length,
    prompt: items.length,
    note: 0,
    table: 0,
    fragment: 0,
    selected: items.filter((i) => i.selected).length,
    duplicated: items.filter((i) => i.dup).length,
    chars: src.length,
  };
  return { items, stats, plan: 'ai' };
}

/* ---- 模式 A：规则切块 + 模型逐块表态 ---- */

async function judgeStructured(blocks, chat, { batchChars, onProgress }) {
  // 先用规则把每块解析出来。正文取自这里，模型不会碰。
  const parsed = [];
  let section = null;
  for (const b of blocks) {
    const p = parseBlock(b, { section });
    if (p.section) section = p.section;
    parsed.push(p);
  }

  // 光杆章节标题不发给模型——既省 token，也免得模型把「■ 3 单技能指令模板」当指令
  const askable = parsed
    .map((p, idx) => ({ idx, p }))
    .filter(({ p }) => !(p.number !== null && !p.number.includes('.') && p.kind !== 'prompt' && p.hasBody === false));

  const batches = [];
  let cur = [];
  let curLen = 0;
  for (const item of askable) {
    const len = item.p.original.length;
    if (cur.length && curLen + len > batchChars) {
      batches.push(cur);
      cur = [];
      curLen = 0;
    }
    cur.push(item);
    curLen += len;
  }
  if (cur.length) batches.push(cur);

  const judged = new Map(); // 块号(1-based) -> {keep,title,tags,note}
  let failed = 0;
  let lastErr = null;

  for (let bi = 0; bi < batches.length; bi++) {
    if (onProgress) onProgress({ done: bi, total: batches.length });
    try {
      const list = await judgeOneBatch(batches[bi], chat, bi + 1, batches.length);
      for (const x of list) {
        const i = Number(x && x.i);
        if (Number.isFinite(i)) judged.set(i, x);
      }
    } catch (e) {
      // 单批失败不该让整次导入失败——没表态的块会走规则兜底。
      // 但**全部批次都失败**必须抛出去：那说明是 Key、网络或额度的问题，
      // 静默返回空结果会让用户以为「这段文本里没有指令」。
      failed++;
      lastErr = e;
      console.warn('[importer] AI 批次失败：', e.message);
    }
  }
  if (onProgress) onProgress({ done: batches.length, total: batches.length });
  if (failed && failed === batches.length) {
    throw new Error(`AI 拆分失败（${batches.length} 批全部出错）：${lastErr.message}`);
  }

  const items = [];
  parsed.forEach((p, idx) => {
    const j = judged.get(idx + 1);
    if (j) {
      if (j.keep === false) return; // 模型明确判为非指令
      items.push(fromJudgement(p, j));
      return;
    }
    // 模型没表态：退回规则判断，并明确标出来
    if (p.number !== null && !p.number.includes('.') && p.kind !== 'prompt' && p.hasBody === false) return;
    p.warnings = [...p.warnings, 'AI 未对这个片段表态，此处为规则判断结果'];
    p.selected = false;
    items.push(p);
  });
  return items;
}

/** 把「规则切出的块」与「模型的判断」合成一条最终条目 */
function fromJudgement(p, j) {
  const title =
    String(j.title || '')
      .replace(/^[【〔\[]\s*[】〕\]]\s*/, '')
      .replace(/^[-—·•※*#\s]+/, '')
      .replace(/[\s:：、，,。;；]+$/, '')
      .trim() || p.title;

  const aiTags = Array.isArray(j.tags)
    ? j.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 6)
    : [];
  const tags = Array.from(new Set([...aiTags, ...p.tags]));
  const note = String(j.note || '').trim() || p.note;

  let category = p.category;
  let categoryConf = p.categoryConf;
  try {
    const r = classifyByRules({ title, content: p.content, note, tags });
    if (r?.category) {
      category = r.category;
      categoryConf = r.confidence || 0;
    }
  } catch (_) {
    /* 分类失败不影响导入 */
  }

  return {
    ...p,
    title,
    tags,
    note,
    category,
    categoryConf,
    kind: 'prompt',
    score: 10,
    scoreWhy: ['AI 判定为指令'],
    selected: true,
    aiRefined: true,
  };
}

const JUDGE_SYSTEM = `你在帮用户整理「AI 指令库」。用户会把文档按分隔结构切好的若干块发给你，
每块前面有 <<<块 N>>> 标记。

对每一块，回答一个问题：**它是不是「一条可以直接粘贴到 AI 对话框、让 AI 去干一件事的完整指令」？**

【最重要的原则】
判断错的代价是不对称的：
- 把一条真指令判成 false → 用户永远看不到它，等于内容凭空丢失
- 把说明文字判成 true → 用户取消一下勾选就行

所以**默认倾向是 keep=true**。只要一块看起来像「在让 AI 去做某件事」，就判 true。
拿不准的时候，判 true。这类文档多半就是指令手册，大部分块都应该是 true。

【什么算 keep=true】
块里含有这类内容就算：使用某技能去做一件事、包含「要求：」「输出到」这类执行说明、
带有【待填占位符】、有条目编号加一段可执行正文、含「帮我…」「把…改成…」这类祈使句。
标题不重要，正文有没有具体动作才重要。

【只有明显是下列类型时才 keep=false】
- 通篇在讲「怎么使用这份文档」的说明、操作指南、目录、前言、注意事项、免责声明
- 纯粹的速查表 / 对照表（整块都是「做事 → 用某技能」这样的行）
- 环境配置、安装步骤、报错排查清单
- 只有标题、完全没有正文的空章节名
- 「常用占位符一览」「常用约束句一览」这类词条清单

【keep=true 时的字段】
- title：12-24 字中文标题，概括这条指令做什么。不要编号、不要【】、不要以句号结尾。
  不要在后面加「指令」两个字——标题本身就是这条指令的名字。
  好例子：「读论文：中英对照全文」「投稿前冲刺」「精读一篇论文」
- tags：正文里出现的技能名或领域词，0-4 个，没有就给 []。
- note：不超过 40 字，说明适用场景或需要替换什么；没有就给 ""。

【硬性要求】
- **每一个块都必须出现在输出里，一块一条**，不许省略、不许合并、不许跳过。
- 你不需要输出正文。正文由系统从原文取得，你只负责判断和起名。
- 只输出 JSON，不要任何解释文字，不要代码围栏。

输出格式：{"blocks":[{"i":1,"keep":true,"title":"读论文：中英对照全文","tags":["nature-reader"],"note":"需要替换论文路径与输出目录"},{"i":2,"keep":false}]}`;

async function judgeOneBatch(batch, chat, batchNo, batchTotal) {
  const payload = batch.map(({ idx, p }) => `<<<块 ${idx + 1}>>>\n${p.original}`).join('\n\n');
  const lo = batch[0].idx + 1;
  const hi = batch[batch.length - 1].idx + 1;

  const content = await chat(
    [
      { role: 'system', content: JUDGE_SYSTEM },
      {
        role: 'user',
        content:
          `这是第 ${batchNo}/${batchTotal} 批，共 ${batch.length} 个块（块号 ${lo}-${hi}）。\n` +
          `请对每一块给出判断，${batch.length} 个块就要有 ${batch.length} 条记录。\n\n${payload}`,
      },
    ],
    { jsonMode: true, maxTokens: Math.min(4000, Math.max(600, batch.length * 150)) }
  );

  const obj = parseJsonLoose(content);
  const list = Array.isArray(obj)
    ? obj
    : Array.isArray(obj?.blocks)
      ? obj.blocks
      : Array.isArray(obj?.items)
        ? obj.items
        : null;

  if (!list) {
    // 解析失败必须抛出去，而不是默默返回空数组——
    // 静默的空结果会被当成「这些块都不是指令」，整批条目就此消失。
    throw new Error(`模型返回无法解析为 JSON（批次 ${batchNo}，${String(content).length} 字符）`);
  }
  return list;
}

/* ---- 模式 B：结构松散时，让模型自己找边界 ---- */

const SPLIT_SYSTEM = `你在帮用户整理「AI 指令库」。用户会给你一段可能包含多条 AI 指令的长文本，
请把里面**所有**可以执行的指令逐条提取出来。

什么是指令：一段可以直接粘贴到 AI 对话框、让 AI 去干一件事的完整文字。
什么不是：使用说明、对照表、目录、环境配置、排错清单、免责声明。

字段要求
- title：12-24 字中文标题，不要编号、不要【】、不要以句号结尾。
- content：完整正文，原样保留，不要改写或精简，占位符【】必须原样保留。换行用 \\n 表示。
- tags：技能名或领域词，0-4 个。
- note：不超过 40 字。

硬性要求
- 文本里有几条指令就输出几条，不要只处理开头就结束，也不要合并成一条。
- 如果整段文本里没有任何可执行的指令，输出 {"items":[]}。
- 只输出 JSON，不要解释文字，不要代码围栏。

输出格式：{"items":[{"title":"...","content":"...","tags":[],"note":""}]}`;

async function splitLoosely(text, chat, { onProgress } = {}) {
  const chunks = chunkText(text, 6000);
  const out = [];
  let failed = 0;
  let lastErr = null;
  for (let i = 0; i < chunks.length; i++) {
    if (onProgress) onProgress({ done: i, total: chunks.length });
    try {
      const content = await chat(
        [
          { role: 'system', content: SPLIT_SYSTEM },
          { role: 'user', content: `第 ${i + 1}/${chunks.length} 段：\n\n${chunks[i]}` },
        ],
        { jsonMode: true, maxTokens: 4000 }
      );
      const obj = parseJsonLoose(content);
      const list = Array.isArray(obj) ? obj : Array.isArray(obj?.items) ? obj.items : [];
      out.push(...list.filter((x) => x && (x.content || x.title)));
    } catch (e) {
      failed++;
      lastErr = e;
      console.warn('[importer] AI 分段失败：', e.message);
    }
  }
  if (onProgress) onProgress({ done: chunks.length, total: chunks.length });
  if (failed && failed === chunks.length) {
    throw new Error(`AI 拆分失败（${chunks.length} 段全部出错）：${lastErr.message}`);
  }
  return out;
}

/** 容忍模型返回里的代码围栏与前后废话 */
function parseJsonLoose(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1].trim() : s;
  const start = body.search(/[[{]/);
  try {
    return JSON.parse(start > 0 ? body.slice(start) : body);
  } catch (_) {
    return null;
  }
}

function chunkText(text, maxChars) {
  if (text.length <= maxChars) return [text];
  const paras = text.split(/\n{2,}/);
  const out = [];
  let cur = '';
  for (const p of paras) {
    if (cur && cur.length + p.length + 2 > maxChars) {
      out.push(cur);
      cur = '';
    }
    // 单段就超长：硬切
    if (p.length > maxChars) {
      for (let i = 0; i < p.length; i += maxChars) out.push(p.slice(i, i + maxChars));
      continue;
    }
    cur = cur ? cur + '\n\n' + p : p;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function finalizeAIItem(raw, idx) {
  const title = String(raw.title || '').replace(/[\s:：、，。]+$/, '').trim() || `未命名指令 ${idx + 1}`;
  const content = String(raw.content || '').replace(/\\n/g, '\n').trim();
  const tags = Array.isArray(raw.tags) ? raw.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 6) : [];
  const note = String(raw.note || '').trim();

  let category = 'other';
  let categoryConf = 0;
  try {
    const r = classifyByRules({ title, content, note, tags });
    if (r?.category) { category = r.category; categoryConf = r.confidence || 0; }
  } catch (_) { /* 忽略 */ }

  return {
    id: `ai-${idx}`,
    title,
    content,
    note,
    tags: Array.from(new Set(tags)),
    category,
    categoryConf,
    variables: extractVariables(content),
    skill: tags.find((t) => SKILL_WHITELIST.has(t)) || null,
    section: null,
    number: null,
    kind: 'prompt',
    score: 10,
    scoreWhy: ['AI 判定为指令'],
    selected: true,
    warnings: [],
    sourceRange: null,
    fingerprint: fingerprint(content),
    original: content,
  };
}

/* ================================================================== 写入 */

/**
 * 把选中的候选写成可入库的对象（补全 Prompt 结构）。
 *
 * @param {object} item
 * @param {object} opts
 * @param {string[]} opts.tags          额外附加的标签（如「批量导入」）
 * @param {string}   opts.category      覆盖分类
 * @param {boolean}  opts.lockCategory  是否锁定分类。
 *   只有用户在预览里亲手改过分类才该为 true——
 *   自动预判的分类是规则引擎给的，不该拦住之后的「智能整理」。
 */
export function toPromptPayload(item, { tags = [], category, lockCategory = false } = {}) {
  const allTags = Array.from(new Set([...(item.tags || []), ...tags].filter(Boolean)));
  return {
    title: item.title,
    content: item.content,
    note: item.note || '',
    tags: allTags,
    category: category || item.category || 'other',
    categoryLocked: Boolean(lockCategory),
    favorite: false,
    platforms: [],
  };
}
