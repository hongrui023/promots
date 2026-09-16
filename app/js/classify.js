/**
 * 智能自动分类
 *
 * 三层策略，逐层降级，保证零配置也能用：
 *   1. 用户锁定  —— categoryLocked 为真时直接尊重用户选择，永不覆盖
 *   2. 规则打分  —— 关键词加权命中（标题/标签权重高于正文），置信度足够即定案
 *   3. LLM 兜底  —— 规则置信度低且用户配置了 API Key 时，调用大模型判定
 *
 * 设计取舍：不引入本地 embedding 模型。prompt 管理器的分类是「粗粒度归档」，
 * 规则 + 近义词表在中文 AI 语料上命中率已经很高，且零延迟、零成本、可解释。
 */

import { SYNONYM_GROUPS } from './synonyms.js';

/** 分类体系。key 一旦发布不要改名，否则历史数据会掉分类 */
export const CATEGORIES = [
  { key: 'writing', name: '写作创作', icon: '✍️', color: '#8b5cf6' },
  { key: 'coding', name: '编程开发', icon: '💻', color: '#0ea5e9' },
  { key: 'translate', name: '翻译语言', icon: '🌐', color: '#14b8a6' },
  { key: 'office', name: '办公效率', icon: '📊', color: '#f59e0b' },
  { key: 'data', name: '数据分析', icon: '📈', color: '#6366f1' },
  { key: 'marketing', name: '市场营销', icon: '📣', color: '#ec4899' },
  { key: 'study', name: '学习研究', icon: '📚', color: '#22c55e' },
  { key: 'design', name: '图像设计', icon: '🎨', color: '#f43f5e' },
  { key: 'media', name: '音视频', icon: '🎬', color: '#a855f7' },
  { key: 'business', name: '商业职场', icon: '💼', color: '#0891b2' },
  { key: 'life', name: '生活日常', icon: '🌱', color: '#84cc16' },
  { key: 'meta', name: '角色设定', icon: '🎭', color: '#64748b' },
  { key: 'other', name: '其他', icon: '📦', color: '#94a3b8' },
];

export const CATEGORY_MAP = new Map(CATEGORIES.map((c) => [c.key, c]));

export function categoryName(key) {
  return CATEGORY_MAP.get(key)?.name || key;
}
export function categoryMeta(key) {
  return CATEGORY_MAP.get(key) || CATEGORY_MAP.get('other');
}

/**
 * 每个分类的关键词及权重。
 * 权重含义：1.0 = 普通指示词，2.0 = 强指示词，0.5 = 弱相关词
 */
const RULES = {
  writing: {
    写作: 2, 撰写: 2.5, 创作: 2, 文案: 2.5, 文章: 2, 润色: 2.5, 改写: 2.5, 扩写: 2.5,
    缩写: 2, 大纲: 2, 标题: 1.5, 小说: 2.5, 故事: 1.5, 剧本: 2.5, 分镜: 2, 诗歌: 2,
    稿: 2, 段落: 1.5, 文风: 2, 语气: 1, 口吻: 1.5, 邮件: 1.5, 简历: 2, 致辞: 2,
    论文: 1, 文献: 0.5, word: 0.5, blog: 1.5, article: 1.5, writing: 2, copywriting: 2,
    写一篇: 3, 帮我写: 2.5, 生成文案: 3, 公文: 2.5, 通讯稿: 2, 讲话稿: 2,
  },
  coding: {
    代码: 3, 编程: 3, 程序: 2, 脚本: 2, 调试: 2.5, bug: 2.5, 报错: 2, 异常: 1.5,
    重构: 2.5, 函数: 1.5, 接口: 1.5, 算法: 2, 正则: 2.5, 前端: 2.5, 后端: 2.5,
    数据库: 2, sql: 2.5, api: 1.5, python: 2.5, javascript: 2.5, java: 1.5, typescript: 2.5,
    报错信息: 2.5, 编译: 2, 单元测试: 2.5, 爬虫: 2.5, 部署: 1.5, 命令行: 1.5, shell: 1.5,
    git: 1.5, docker: 2, 代码审查: 3, code: 1.5, debug: 2.5, refactor: 2.5, implement: 1.5,
    实现一个: 2, 写个函数: 3, 性能优化: 1.5,
  },
  translate: {
    翻译: 3, 译: 2, 中译英: 3, 英译中: 3, translate: 3, translation: 3, 英文: 1.5,
    日语: 2, 韩语: 2, 法语: 2, 德语: 2, 本地化: 2, 语法: 1.5, 拼写: 1.5, 错别字: 1.5,
    术语表: 2, 润色英文: 2, 语言: 1,
  },
  office: {
    excel: 3, 表格: 2.5, 幻灯片: 3, ppt: 3, 演示文稿: 3, 会议纪要: 3, 周报: 2.5,
    日报: 2, 月报: 2, 汇报: 1.5, 待办: 1.5, 日程: 1.5, 安排: 1, 模板: 1.5,
    审批: 1.5, 流程图: 1.5, outlook: 2, 邮件分类: 1.5, spreadsheet: 2.5, 办公: 2,
    工作总结: 2, 公式: 1.5, 数据透视: 2.5,
  },
  data: {
    数据分析: 3, 数据: 1.5, 统计: 2, 可视化: 2.5, 图表: 1.5, 指标: 1.5, 趋势: 1.5,
    预测: 1.5, 清洗: 1.5, 洞察: 2, 相关系数: 2.5, 回归: 2, 聚类: 2.5, 报表: 1.5,
    增长率: 2, 漏斗: 1.5, abtest: 2.5, 'a/b': 2, ab测试: 2.5, 分流测试: 2, dataset: 2, kpi: 1.5, 数据表: 1.5,
    样本: 1, 建模: 2,
  },
  marketing: {
    营销: 3, 推广: 2.5, 广告: 2.5, 投放: 2.5, 种草: 2.5, 获客: 2.5, 转化: 2,
    用户增长: 2.5, seo: 2.5, 关键词: 1.5, 品牌: 2, slogan: 2, 卖点: 2.5, 竞品: 2.5,
    活动策划: 2.5, 私域: 2.5, 直播: 1.5, 电商: 2, 详情页: 2.5, 带货: 2, marketing: 2.5,
    爆款: 2, 引流: 2.5, 客户画像: 2.5,
    小红书: 3, 朋友圈: 2, 种草文案: 3.5, 社媒: 2.5, 抖音: 2.5, 视频号: 2, 达人: 2, 带货文案: 3,
  },
  study: {
    学习: 2, 讲解: 2.5, 教学: 2, 解释: 2, 科普: 2.5, 入门: 2, 概念: 1.5, 定义: 1.5,
    出题: 2.5, 测验: 2.5, 考试: 2, 背诵: 2, 知识点: 2.5, 举例说明: 2, 题型: 2,
    讲义: 2.5, 课程: 1.5, 学习方法: 2.5, explain: 1.5, 帮我理解: 2.5, 通俗: 2,
    学术: 1.5, 研究方法: 2,
    // 科研工作流。这个工具的主要用户是写论文、跑实验的人，
    // 而「读论文 / 看文献 / 投稿返修」以前全被归进了写作创作或办公效率——
    // 那只是因为这些词当时只存在于写作词表里。「论文:1」现在留给「写论文」用。
    文献: 2.5, 精读: 3, 综述: 2, 期刊: 2, 投稿: 2.5, 审稿: 2.5, 返修: 2.5,
    参考文献: 2.5, 引用: 2, doi: 2.5, 开题: 2.5, 基金: 2, 国自然: 2.5, 专利: 2,
    组会: 2.5, 实验: 1.5, 数据可用性: 2.5, 预印本: 2, 影响因子: 2, 作者贡献: 2,
    // 「论文」两边都有，但权重更高的一侧是学术场景：
    // 「读论文/查论文」归学习研究，「帮我写论文」仍靠「帮我写」把分数拉回写作创作
    论文: 1.8, 阅读: 1.5, 检索: 2, 核验: 2, 汇报: 1.5,
  },
  design: {
    图片: 2, 配图: 2.5, 图像: 2, 插画: 2.5, 海报: 2.5, logo: 3, 图标: 2, 配色: 2.5,
    色彩: 2, 排版: 2, 版式: 2, 修图: 2.5, 抠图: 2.5, 美颜: 2, 绘画: 2.5, 画一张: 2.5,
    midjourney: 3, stable: 1.5, 文生图: 3, 提示词: 1.5, banner: 2, 视觉: 1.5,
    设计: 2, '3d': 1.5, 三维: 2, 三维建模: 2.5, 建模: 2, photoshop: 2,
  },
  media: {
    视频: 2.5, 音频: 2.5, 配音: 2.5, 字幕: 2.5, 剪辑: 2.5, 音乐: 2, 歌词: 2.5,
    旁白: 2, 脚本分镜: 2, 语音转文字: 3, 播客: 2.5, 短剧: 2.5, 分镜脚本: 2.5,
    video: 2, audio: 2, 转写: 2.5, 长视频: 1.5,
  },
  business: {
    商业: 2, 创业: 2.5, 方案: 1.5, 策划: 2, 合同: 2.5, 法律: 2.5, 合规: 2.5,
    财务: 2.5, 会计: 2.5, 谈判: 2.5, 面试: 2.5, 招聘: 2.5, 求职: 2.5, 商业计划: 3,
    商业模式: 3, 融资: 2.5, 路演: 2.5, 汇报材料: 2, 管理: 1, 复盘: 2, swot: 2.5,
    产业链: 2, 竞品分析: 2,
  },
  life: {
    旅行: 2.5, 旅游: 2.5, 行程: 2, 健身: 2.5, 运动: 2, 菜谱: 2.5, 食谱: 2.5,
    做饭: 2, 健康: 2, 养生: 2, 情绪: 2, 心理: 2, 装修: 2, 家居: 2, 育儿: 2.5,
    亲子: 2.5, 宠物: 2.5, 减肥: 2.5, 睡眠: 2, 收纳: 2, 购物: 1.5, 节日: 1.5,
    送礼: 2, 表白: 2, 道歉: 2, 生活: 1.5,
  },
  meta: {
    扮演: 3, 角色扮演: 3, 你是: 3, 作为一名: 3, 身份: 2, 人格: 2.5, 专家: 2,
    顾问: 2, 助手: 2, 'act as': 3, 扮演角色: 3, 担任角色: 3, role: 2, persona: 2.5, 设定: 1.5, 系统提示词: 3,
    提示词工程: 2.5, 思维链: 2.5, 输出格式: 2, json: 1.5, 拒绝: 1.5,
    请你担任: 3, 现在你是: 3,
  },
};

/** 预编译：构建 词 -> [分类, 权重] 反查表，并注入近义词组的变体 */
const LEXICON = (() => {
  const map = new Map();
  for (const [cat, words] of Object.entries(RULES)) {
    for (const [w, weight] of Object.entries(words)) {
      const key = w.toLowerCase();
      map.set(key, { cat, weight });
    }
  }
  // 用近义词组做泛化：若某组中已有词属于某分类，则该组其他词继承较低权重
  for (const group of SYNONYM_GROUPS) {
    for (const w of group) {
      const hit = map.get(w.toLowerCase());
      if (!hit) continue;
      for (const other of group) {
        const k = other.toLowerCase();
        if (map.has(k)) continue;
        map.set(k, { cat: hit.cat, weight: hit.weight * 0.55 });
      }
    }
  }
  return map;
})();

const FIELD_WEIGHT = { title: 3.0, tags: 2.4, note: 1.2, content: 0.8 };

function tokenize(text) {
  const s = String(text || '').toLowerCase();
  const out = [];
  // 英文单词
  for (const m of s.matchAll(/[a-z][a-z0-9_+#.-]{1,}/g)) out.push({ term: m[0], type: 'word' });
  // 中文 2~6 字 n-gram（覆盖「数据分析」「角色扮演」这类词）
  for (const m of s.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
    const seg = m[0];
    for (let n = 2; n <= Math.min(6, seg.length); n++) {
      for (let i = 0; i + n <= seg.length; i++) out.push({ term: seg.slice(i, i + n), type: 'cjk' });
    }
  }
  return out;
}

/**
 * 规则打分分类
 * @param {{title?:string, content?:string, note?:string, tags?:string[]}} prompt
 * @returns {{category:string, confidence:number, ranking:{category:string,score:number}[]}}
 */
export function classifyByRules(prompt) {
  const scores = new Map();
  const evidence = new Map();

  const fields = [
    ['title', prompt.title || ''],
    ['tags', (prompt.tags || []).join(' ')],
    ['note', prompt.note || ''],
    ['content', prompt.content || ''],
  ];

  for (const [field, text] of fields) {
    if (!text) continue;
    const fw = FIELD_WEIGHT[field] || 1;
    const seen = new Set();
    for (const { term } of tokenize(text)) {
      if (seen.has(term)) continue;
      seen.add(term);
      const hit = LEXICON.get(term);
      if (!hit) continue;
      // 长词更具体，给轻微加成
      const lenBonus = hit.cat === 'other' ? 1 : 1 + Math.min(0.4, (term.length - 2) * 0.08);
      const add = hit.weight * fw * lenBonus;
      scores.set(hit.cat, (scores.get(hit.cat) || 0) + add);
      if (!evidence.has(hit.cat)) evidence.set(hit.cat, []);
      const ev = evidence.get(hit.cat);
      if (ev.length < 6) ev.push(term);
    }
  }

  const ranking = Array.from(scores.entries())
    .map(([category, score]) => ({ category, score: Number(score.toFixed(2)) }))
    .sort((a, b) => b.score - a.score);

  if (!ranking.length) {
    return { category: 'other', confidence: 0, ranking: [], evidence: {} };
  }

  const top = ranking[0];
  const second = ranking[1]?.score || 0;
  // 置信度 = 绝对强度 × 领先优势
  const strength = Math.min(1, top.score / 12);
  const margin = top.score > 0 ? (top.score - second) / top.score : 0;
  const confidence = Number((strength * (0.45 + 0.55 * margin)).toFixed(3));

  return {
    category: top.category,
    confidence,
    ranking: ranking.slice(0, 4),
    evidence: Object.fromEntries(evidence),
  };
}

/**
 * 综合自动分类
 * @param {object} prompt
 * @param {{force?:boolean}} opts force=true 时无视 categoryLocked
 * @returns {Promise<{category:string, confidence:number, source:'locked'|'rule'|'llm'|'fallback', ranking:any[], evidence:any}>}
 */
export async function autoClassify(prompt, { force = false } = {}) {
  if (prompt.categoryLocked && !force) {
    return { category: prompt.category, confidence: 1, source: 'locked', ranking: [], evidence: {} };
  }

  const rules = classifyByRules(prompt);
  if (rules.confidence >= 0.34) {
    return { ...rules, source: 'rule' };
  }

  // 规则不够确定，尝试 LLM
  try {
    const { llmAvailable, llmClassify } = await import('./llm.js');
    if (llmAvailable()) {
      const llm = await llmClassify(prompt);
      if (llm && llm.category) {
        return {
          category: llm.category,
          confidence: llm.confidence ?? 0.7,
          source: 'llm',
          ranking: rules.ranking,
          evidence: rules.evidence,
          reason: llm.reason,
        };
      }
    }
  } catch (e) {
    console.warn('[classify] LLM 兜底失败，回落规则结果', e);
  }

  if (rules.ranking.length) return { ...rules, source: 'fallback' };
  return { category: 'other', confidence: 0, source: 'fallback', ranking: [], evidence: {} };
}

/**
 * 批量重分类
 * @param {Array} items
 * @param {{skipLocked?:boolean, onProgress?:Function}} opts
 */
export async function reclassifyAll(items, { skipLocked = true, onProgress } = {}) {
  const changed = [];
  let i = 0;
  for (const item of items) {
    i++;
    if (skipLocked && item.categoryLocked) continue;
    const r = await autoClassify({ ...item, categoryLocked: false });
    if (r.category && r.category !== item.category) {
      changed.push({ id: item.id, from: item.category, to: r.category, confidence: r.confidence, source: r.source });
    }
    if (onProgress && i % 20 === 0) onProgress(i, items.length);
  }
  if (onProgress) onProgress(items.length, items.length);
  return changed;
}

export const RULE_LEXICON_SIZE = LEXICON.size;
