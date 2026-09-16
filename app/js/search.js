/**
 * 搜索引擎 —— 四种模式 + 自动编排
 *
 *   quick    快速搜索：输入即出，前缀/子串 + 拼音首字母，零延迟
 *   fuzzy    模糊搜索：编辑距离 + 二元组 Dice 系数 + 拼音近似，容忍错字与乱序
 *   synonym  近义词搜索：同义组扩展，跨表达命中
 *   nl       自然语言搜索：规则解析（+ 可选 LLM）→ 结构化条件再检索
 *   auto     智能模式：按查询特征自动挑选/混合上述模式
 *
 * 统一出口：search(query, { mode, filters, items })
 * 返回 { results, meta }，results 元素为 { prompt, score, why[], hits[] }
 */

import { expand, hasSynonym } from './synonyms.js';
import { initials, initialsVariants } from './pinyin.js';
import { classifyByRules, categoryName } from './classify.js';

export const MODES = [
  { key: 'auto', name: '智能', icon: '✨', hint: '自动判断该用哪种搜索' },
  { key: 'quick', name: '快速', icon: '⚡', hint: '输入即搜，命中标题/标签/正文，支持拼音首字母' },
  { key: 'fuzzy', name: '模糊', icon: '🔍', hint: '容忍错别字、少字漏字、词序打乱' },
  { key: 'synonym', name: '近义词', icon: '🔗', hint: '搜「摘要」也能找到只写了「总结/提炼」的指令' },
  { key: 'nl', name: '自然语言', icon: '💬', hint: '「上周收藏的翻译指令」这样直接说' },
];

export const PLATFORMS = [
  { key: 'chatgpt', name: 'ChatGPT', color: '#10a37f' },
  { key: 'workbuddy', name: 'WorkBuddy', color: '#2f6fed' },
  { key: 'deepseek', name: 'DeepSeek', color: '#4d6bfe' },
  { key: 'doubao', name: '豆包', color: '#1664ff' },
  { key: 'claude', name: 'Claude', color: '#d97757' },
  { key: 'gemini', name: 'Gemini', color: '#4285f4' },
  { key: 'kimi', name: 'Kimi', color: '#1f2329' },
  { key: 'tongyi', name: '通义', color: '#615ced' },
  { key: 'other', name: '其他', color: '#94a3b8' },
];
export const PLATFORM_MAP = new Map(PLATFORMS.map((p) => [p.key, p]));

/* ------------------------------------------------------------------ 归一化 */

const PUNCT_RE = /[\s\u3000,，。、;；:：!！?？()（）\[\]【】{}<>《》"'“”‘’`~@#$%^&*+=|\\/—\-_…·]/g;

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(PUNCT_RE, '');
}

/** 分词：英文单词 + 中文 2~4 字滑窗 */
const STOPWORDS = new Set([
  '帮我', '给我', '我要', '我想', '一下', '一个', '那些', '这些', '我的', '有关', '关于',
  '所有', '找找', '查找', '搜索', '搜一下', '有没有', '哪个', '什么', '怎么', '如何',
  '之前', '以前', '写过', '做个', '找个', '看看', '一下的', '用于', '可以', '能够',
  '请', '吧', '啊', '呢', '的', '了', '和', '与', '或', '是', '在', '把', '被', '对',
  '我', '你', '他', '它', '这', '那', '就', '都', '也', '还', '要', '会', '有', '没',
]);

function tokenizeQuery(q) {
  const raw = String(q || '').trim();
  const out = [];
  for (const m of raw.matchAll(/[a-zA-Z][a-zA-Z0-9_+#.-]*/g)) out.push(m[0].toLowerCase());
  for (const m of raw.matchAll(/[\u4e00-\u9fff]+/g)) {
    const seg = m[0];
    if (seg.length <= 4) {
      out.push(seg);
    } else {
      // 长中文串：先整体，再按 2 字切
      out.push(seg);
      for (let i = 0; i + 2 <= seg.length; i += 2) out.push(seg.slice(i, i + 2));
    }
  }
  return Array.from(new Set(out.filter((t) => t && !STOPWORDS.has(t))));
}

function stripStopwords(text) {
  let s = String(text || '');
  for (const w of STOPWORDS) s = s.split(w).join(' ');
  return s.replace(/\s+/g, ' ').trim();
}

/* ------------------------------------------------------------------ 距离算法 */

/** 带早停的编辑距离（超过 max 直接返回 max+1） */
function levenshtein(a, b, max = 999) {
  const la = a.length;
  const lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;
  if (Math.abs(la - lb) > max) return max + 1;
  let prev = new Array(lb + 1);
  let cur = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= lb; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    const t = prev;
    prev = cur;
    cur = t;
  }
  return prev[lb];
}

function charSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const max = Math.max(a.length, b.length);
  const allowed = Math.max(1, Math.floor(max * 0.45));
  const d = levenshtein(a, b, allowed);
  if (d > allowed) return 0;
  return 1 - d / max;
}

function bigrams(s) {
  const out = new Set();
  if (s.length < 2) {
    if (s) out.add(s);
    return out;
  }
  for (let i = 0; i + 2 <= s.length; i++) out.add(s.slice(i, i + 2));
  return out;
}

function diceCoefficient(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size);
}

/** 综合模糊相似度：编辑距离 + 二元组，中文更信编辑距离 */
function fuzzySim(q, target) {
  if (!q || !target) return 0;
  const hasCJK = /[\u4e00-\u9fff]/.test(q);
  const cs = charSimilarity(q, target);
  const dc = diceCoefficient(q, target);
  // 中文词短、二元组信息量低，编辑距离更能反映「差一两个字」；
  // 英文词长、字母可随意替换，二元组更稳。两者权重因此不同。
  const bias = hasCJK ? 0.72 : q.length >= 4 ? 0.45 : 0.6;
  return bias * cs + (1 - bias) * dc;
}

/**
 * 滑动窗口取最优相似度。
 * 必要性：查询词只有 4 个字、标题却有 11 个字时，整体比对会被长尾稀释到接近 0，
 * 而「代码申查」对「代码审查codereview」这种局部近似恰恰是用户真实意图。
 */
function bestWindowSim(n, target) {
  let best = fuzzySim(n, target);
  if (target.length > n.length + 1 && n.length >= 2) {
    const span = n.length;
    for (let i = 0; i + span <= target.length; i++) {
      const s = fuzzySim(n, target.slice(i, i + span));
      if (s > best) best = s;
      if (best >= 0.95) break;
    }
  }
  return best;
}

/** 单词模糊匹配：取标题/标签/备注中的最佳得分 */
function bestFuzzyFor(n, entry) {
  if (!n) return { sim: 0, field: '' };
  let best = 0;
  let field = '';

  const targets = [
    { text: entry.nTitle, w: 1.0, label: '标题' },
    ...entry.nTags.map((t) => ({ text: t, w: 0.86, label: '标签' })),
    { text: entry.nNote, w: 0.5, label: '备注' },
  ];

  for (const t of targets) {
    if (!t.text) continue;
    let sim = bestWindowSim(n, t.text);
    // 直接子串命中最可信，给保底分（单字也允许，中文单字有意义）
    if (t.text.includes(n)) sim = Math.max(sim, n.length === 1 ? 0.72 : 0.8);
    // 中文长查询里只要有一个有意义的二字片段出现，就算较强命中
    // （「跟代码」→「代码」，「最近写的」→ 无；这正是自然语言查询的常见形态）
    if (n.length >= 3 && /[\u4e00-\u9fff]/.test(n)) {
      for (let i = 0; i + 2 <= n.length; i++) {
        if (t.text.includes(n.slice(i, i + 2))) {
          sim = Math.max(sim, 0.7);
          break;
        }
      }
    }
    const weighted = sim * t.w;
    if (weighted > best) {
      best = weighted;
      field = `${t.label}（相似 ${Math.round(sim * 100)}%）`;
    }
  }

  // 拼音维度
  const qPy = initials(n);
  if (qPy && qPy.length >= 2) {
    const label = /[\u4e00-\u9fff]/.test(n) ? '拼音首字母' : '首字母/英文';
    if (entry.pyTitle.startsWith(qPy)) {
      if (0.92 > best) { best = 0.92; field = `${label}（${qPy}）`; }
    } else if (entry.pyTitle.includes(qPy)) {
      if (0.7 > best) { best = 0.7; field = `${label}（${qPy}）`; }
    }
    for (const pt of entry.pyTags) {
      if (pt.includes(qPy) && 0.66 > best) { best = 0.66; field = `标签${label}（${qPy}）`; }
    }
    if (best < 0.6 && entry.pyVariants.some((v) => v === qPy)) {
      best = 0.6;
      field = `拼音多音字（${qPy}）`;
    }
  }

  return { sim: best, field };
}

/**
 * 模糊打分
 * 与快速搜索的 AND 语义不同：模糊查询允许「部分词命中」，
 * 否则「周抱生成器 + 周抱 + 生成 + 器」这种分词结果里只要有一个碎片对不上就整体被否，
 * 等于把容错能力废掉。这里要求命中数过半即可。
 */
function fuzzyScore(entry, terms, threshold = 0.5) {
  let total = 0;
  let matched = 0;
  const why = [];
  const hits = [];

  for (const term of terms) {
    const n = normalize(term);
    const { sim, field } = bestFuzzyFor(n, entry);
    if (sim >= threshold) {
      matched++;
      total += sim * 100;
      hits.push(term);
      why.push(field);
    } else if (sim >= threshold * 0.6) {
      total += sim * 60;
      why.push(field + '（弱匹配）');
    }
  }

  const need = Math.max(1, Math.ceil(terms.length * 0.5));
  if (matched < need) return null;
  return { score: total * heat(entry.p), why, hits };
}

/* ------------------------------------------------------------------ 索引 */

const INDEX_CACHE = new WeakMap();

/**
 * 为条目集合建立检索索引（按数组引用缓存）
 */
export function buildIndex(items) {
  const cached = INDEX_CACHE.get(items);
  if (cached) return cached;

  const entries = items.map((p) => {
    const nTitle = normalize(p.title);
    const nNote = normalize(p.note);
    const nContent = normalize(p.content);
    const nTags = (p.tags || []).map(normalize);
    const pyTitle = initials(p.title);
    const pyTags = (p.tags || []).map(initials).filter(Boolean);
    const pyVariants = initialsVariants(p.title).concat((p.tags || []).flatMap((t) => initialsVariants(t)));
    const cjkChars = new Set(Array.from(nTitle + nNote).filter((c) => /[\u4e00-\u9fff]/.test(c)));
    return {
      p,
      nTitle,
      nNote,
      nContent,
      nTags,
      pyTitle,
      pyTags,
      pyVariants: Array.from(new Set(pyVariants)),
      cjkChars,
      hay: nTitle + ' ' + nTags.join(' ') + ' ' + nNote + ' ' + nContent,
    };
  });

  const idx = { entries };
  INDEX_CACHE.set(items, idx);
  return idx;
}

/* ------------------------------------------------------------------ 过滤器 */

export const DEFAULT_FILTERS = {
  category: null,
  tag: null,
  favoriteOnly: false,
  platforms: [],
  days: null,
  includeDeleted: false,
};

function applyFilters(entries, filters) {
  const f = { ...DEFAULT_FILTERS, ...(filters || {}) };
  const cutoff = f.days ? Date.now() - f.days * 86400000 : 0;
  return entries.filter(({ p }) => {
    if (!f.includeDeleted && p.deleted) return false;
    if (f.category && p.category !== f.category) return false;
    if (f.tag && !(p.tags || []).includes(f.tag)) return false;
    if (f.favoriteOnly && !p.favorite) return false;
    if (f.platforms.length && !f.platforms.some((x) => (p.platforms || []).includes(x))) return false;
    if (cutoff && p.updatedAt < cutoff) return false;
    return true;
  });
}

/** 通用热度修正：常用 + 最近用过的略微上浮 */
function heat(p) {
  const use = 1 + Math.log1p(p.useCount || 0) * 0.08;
  const ageDays = (Date.now() - (p.lastUsedAt || p.updatedAt)) / 86400000;
  const recency = 1 + Math.max(0, 0.12 - Math.min(0.12, ageDays * 0.002));
  return use * recency;
}

/* ------------------------------------------------------------------ 模式 1：快速 */

/**
 * 单词语义打分：返回该词在该条目上的最佳命中强度。
 * 抽成独立函数是因为快速模式（AND 语义）和自然语言模式（覆盖率语义）都要用它。
 * @returns {{score:number, field:string}|null}
 */
function termScore(entry, term) {
  let best = 0;
  let bestField = '';
  const n = normalize(term);
  if (!n) return null;

  if (entry.nTitle === n) {
    best = 120;
    bestField = '标题完全匹配';
  } else if (entry.nTitle.startsWith(n)) {
    best = 95;
    bestField = '标题开头';
  } else if (entry.nTitle.includes(n)) {
    best = 78;
    bestField = '标题包含';
  }

  for (const t of entry.nTags) {
    if (t === n && 88 > best) {
      best = 88;
      bestField = '标签完全匹配';
    } else if (t.startsWith(n) && 70 > best) {
      best = 70;
      bestField = '标签开头';
    } else if (t.includes(n) && 55 > best) {
      best = 55;
      bestField = '标签包含';
    }
  }

  if (entry.nNote.includes(n) && 34 > best) {
    best = 34;
    bestField = '备注包含';
  }
  if (entry.nContent.includes(n) && 20 > best) {
    best = 20;
    bestField = '正文包含';
  }

  // 拼音 / 英文首字母
  // 注意：这里不能因为「查询词本身就是纯字母」就跳过——
  // 用户输入的 gwxz / xhs 正是拼音首字母，initials() 对纯字母是原样返回，
  // 而 pyTitle 是由汉字标题转出来的，两者比对才有意义。
  const qPy = initials(term);
  if (qPy && qPy.length >= 2) {
    const label = /[\u4e00-\u9fff]/.test(term) ? '拼音首字母' : '首字母/英文';
    if (entry.pyTitle.startsWith(qPy) && 92 > best) {
      best = 92;
      bestField = `${label}（${qPy}）`;
    } else if (entry.pyTitle.includes(qPy) && 62 > best) {
      best = 62;
      bestField = `${label}（${qPy}）`;
    }
    for (const pt of entry.pyTags) {
      if (pt.includes(qPy) && 58 > best) {
        best = 58;
        bestField = `标签${label}（${qPy}）`;
      }
    }
    if (best < 58 && entry.pyVariants.some((v) => v === qPy)) {
      best = 50;
      bestField = `拼音多音字（${qPy}）`;
    }
  }

  if (best <= 0) return null;
  return { score: best, field: bestField };
}

/** 快速搜索：所有词都必须命中（AND 语义），保证精确性 */
function quickScore(entry, terms) {
  let score = 0;
  const why = [];
  const hits = [];

  for (const term of terms) {
    const r = termScore(entry, term);
    if (!r) return null;
    score += r.score;
    why.push(r.field);
    hits.push(term);
  }

  return { score: score * heat(entry.p), why: Array.from(new Set(why)), hits };
}

/**
 * 自然语言打分：覆盖率语义（至少一半的词命中即可）
 *
 * 为什么不能沿用 AND：
 *   自然语言查询经过分词后一定带上碎片（「跟代码」→ 跟/代码，「最近写的」→ 最近/写），
 *   要求全部命中等于永远搜不到。这里对每个词依次尝试
 *   直接命中 → 近义扩展 → 模糊近似，命中数过半即接受，并保留整句覆盖率加成。
 */
function nlScore(entry, terms) {
  let total = 0;
  let matched = 0;
  const why = [];
  const hits = [];

  for (const term of terms) {
    let hit = termScore(entry, term);

    // 近义扩展
    if (!hit) {
      const n = normalize(term);
      for (const v of expandOn(term)) {
        if (normalize(v) === n) continue;
        const r = termScore(entry, v);
        if (r && (!hit || r.score * 0.86 > hit.score)) hit = { score: r.score * 0.86, field: `近义词「${term}」→「${v}」` };
      }
    }

    // 模糊近似兜底
    if (!hit) {
      const f = bestFuzzyFor(normalize(term), entry);
      if (f.sim >= 0.6) hit = { score: f.sim * 74, field: f.field };
    }

    if (hit) {
      matched++;
      total += hit.score;
      hits.push(term);
      why.push(hit.field);
    }
  }

  // NL 是「召回优先」的模式：只要有一个关键词真的命中就保留，
  // 相关度完全交给分数和覆盖率加成来排序。若在这里也用覆盖率做硬门槛，
  // 分词产生的碎片会把本该命中的条目一起挡掉。
  if (matched < 1) return null;

  const coverage = matched / Math.max(1, terms.length);
  return { score: total * (0.7 + 0.3 * coverage) * heat(entry.p), why: Array.from(new Set(why)), hits };
}

/* ------------------------------------------------------------------ 模式 2：模糊 */

/* ------------------------------------------------------------------ 模式 3：近义词 */

function synonymScore(entry, terms) {
  let total = 0;
  const why = [];
  const hits = [];

  for (const term of terms) {
    const variants = expandOn(term);
    let best = 0;
    let bestVariant = '';

    for (const v of variants) {
      const n = normalize(v);
      if (!n) continue;
      const isSame = n === normalize(term);
      const penalty = isSame ? 1 : 0.86;

      let s = 0;
      if (entry.nTitle === n) s = 110;
      else if (entry.nTitle.includes(n)) s = 82;
      for (const t of entry.nTags) {
        if (t === n) s = Math.max(s, 92);
        else if (t.includes(n)) s = Math.max(s, 62);
      }
      if (!s && entry.nNote.includes(n)) s = 36;
      if (!s && entry.nContent.includes(n)) s = 22;
      if (!s) {
        const qPy = initials(v);
        if (qPy && entry.pyTitle.includes(qPy)) s = 48;
      }

      const weighted = s * penalty;
      if (weighted > best) {
        best = weighted;
        bestVariant = v;
      }
    }

    if (best > 0) {
      total += best;
      const same = normalize(bestVariant) === normalize(term);
      why.push(same ? `直接命中「${term}」` : `近义词命中「${term}」→「${bestVariant}」`);
      hits.push(term);
    } else {
      return null;
    }
  }

  return { score: total * heat(entry.p), why, hits };
}

/** 近义扩展（带缓存，扩展开销只在首次出现该词时产生） */
const EXPAND_CACHE = new Map();
export function expandOn(term) {
  const key = String(term || '').toLowerCase();
  if (EXPAND_CACHE.has(key)) return EXPAND_CACHE.get(key);
  const out = expand(key);
  EXPAND_CACHE.set(key, out);
  return out;
}

/** 供 UI 展示：这个词能否被近义扩展 */
export function canExpand(term) {
  return hasSynonym(term);
}

/** 清空扩展缓存（词库热更新用） */
export function clearExpandCache() {
  EXPAND_CACHE.clear();
}

/* ------------------------------------------------------------------ 模式 4：自然语言 */

const TIME_RULES = [
  { re: /(今天|今日)/, days: 1, label: '今天' },
  { re: /(昨天|昨日)/, days: 2, label: '昨天起' },
  { re: /(最近|近期|这几天)/, days: 7, label: '最近 7 天' },
  { re: /(这周|本周|这一周)/, days: 7, label: '本周' },
  { re: /(上周|上个星期|上个周)/, days: 14, label: '近两周' },
  { re: /(这个月|本月)/, days: 31, label: '本月' },
  { re: /(最近一个月|近一个月|一个月)/, days: 31, label: '最近一个月' },
  { re: /(最近半年|近半年)/, days: 183, label: '最近半年' },
];

const FAV_RE = /(收藏|星标|标星|喜欢|我的最爱|重点)/;
const SORT_RULES = [
  { re: /(最常用|用得最多|常用|经常用)/, sort: 'used', label: '按使用频率' },
  { re: /(最新|最近创建|新加|刚加)/, sort: 'created', label: '按创建时间' },
  { re: /(最近改|刚改|更新)/, sort: 'recent', label: '按修改时间' },
];

/**
 * 自然语言里只表达「怎么找」而不含检索信息的片段。
 * 必须从关键词里剔掉，否则分词后剩下的碎片会污染检索：
 * 「最近写的关于数据分析的」若不剔除，会得到 ['最近写','数据分析'] 两个词，
 * 而「最近写」在任何指令里都不可能出现。
 */
const NL_FILLER = /(最近|近期|这几天|这周|本周|这一周|上周|上个星期|上个周|这个月|本月|最近一个月|近一个月|一个月|最近半年|近半年|今天|今日|昨天|昨日|收藏|星标|标星|喜欢|最爱|重点|最常用|用得最多|常用|经常用|最新|最近创建|新加|刚加|最近改|刚改|更新|帮我|给我|我想|我要|找一下|找找|查找|搜索|搜一下|看看|看一下|有没有|有哪些|哪些|关于|有关|相关|那些|这些|一些|用来|用于|写过|写过的|用过的)/g;

/** NL 模式下视作「容器词」的名词：它们不指示内容，只是用户在描述要找的是什么东西 */
const NL_GENERIC = new Set([
  '指令', '提示词', 'prompt', 'prompts', '模板', '内容', '东西', '条目', '工具', '收藏夹',
]);

/**
 * 规则版自然语言解析（无 LLM 也能用）
 */
export function parseQueryRules(query) {
  const q = String(query || '');
  const parsed = {
    keywords: [],
    category: null,
    tags: [],
    favoriteOnly: false,
    platforms: [],
    days: null,
    sort: 'relevance',
    explain: [],
    source: 'rule',
  };

  for (const r of TIME_RULES) {
    if (r.re.test(q)) {
      parsed.days = r.days;
      parsed.explain.push(`时间范围：${r.label}`);
      break;
    }
  }

  if (FAV_RE.test(q)) {
    parsed.favoriteOnly = true;
    parsed.explain.push('只看已收藏');
  }

  for (const r of SORT_RULES) {
    if (r.re.test(q)) {
      parsed.sort = r.sort;
      parsed.explain.push(r.label);
      break;
    }
  }

  for (const p of PLATFORMS) {
    if (q.toLowerCase().includes(p.key) || q.includes(p.name)) {
      parsed.platforms.push(p.key);
    }
  }
  if (parsed.platforms.length) parsed.explain.push(`平台：${parsed.platforms.map((k) => PLATFORM_MAP.get(k)?.name).join('、')}`);

  // 分类识别与关键词提取：先剔除「怎么找」的功能性片段，再分词
  let semantic = q;
  for (const p of PLATFORMS) {
    if (q.toLowerCase().includes(p.key) || q.includes(p.name)) {
      semantic = semantic.split(p.name).join(' ');
    }
  }
  semantic = semantic.replace(NL_FILLER, ' ');
  semantic = stripStopwords(semantic);

  const cls = classifyByRules({ title: semantic, content: '', note: '', tags: [] });
  if (cls.confidence >= 0.3) {
    parsed.category = cls.category;
    parsed.explain.push(`分类倾向：${categoryName(cls.category)}`);
  }

  parsed.keywords = tokenizeQuery(semantic).filter((k) => !NL_GENERIC.has(k.toLowerCase()));
  parsed.semantic = semantic.trim();
  return parsed;
}

async function parseQueryLLM(query, ctx) {
  const { llmAvailable, llmParseQuery } = await import('./llm.js');
  if (!llmAvailable()) return null;
  try {
    const r = await llmParseQuery(query, ctx);
    r.source = 'llm';
    return r;
  } catch (e) {
    console.warn('[search] LLM 解析失败，回落规则', e);
    return null;
  }
}

/* ------------------------------------------------------------------ 统一入口 */

/**
 * @param {string} query
 * @param {object} opts
 * @param {Array}  opts.items       待检索条目（必填）
 * @param {string} opts.mode        auto|quick|fuzzy|synonym|nl
 * @param {object} opts.filters     {category, tag, favoriteOnly, platforms, days, includeDeleted}
 * @param {string} opts.sort        relevance|recent|created|used|title
 * @param {boolean} opts.useLLM    是否允许调用 LLM（nl 模式）
 * @param {number} opts.limit
 * @param {Function} opts.onStage   阶段回调，用于 UI 显示进度
 */
export async function search(query, opts = {}) {
  const {
    items = [],
    mode = 'auto',
    filters = {},
    sort = 'relevance',
    useLLM = true,
    limit = 300,
    onStage = () => {},
  } = opts;

  const t0 = performance.now();
  const q = String(query || '').trim();
  const index = buildIndex(items);
  const meta = { mode, query: q, stages: [], parsed: null, took: 0, matched: 0, errors: [] };

  const stage = (label) => {
    meta.stages.push({ label, at: performance.now() - t0 });
    onStage(label);
  };

  // 空查询：只按过滤器 + 排序返回
  if (!q) {
    const entries = applyFilters(index.entries, filters);
    const results = entries
      .map((e) => ({ prompt: e.p, score: heat(e.p), why: [], hits: [] }))
      .sort(sorter(sort))
      .slice(0, limit);
    meta.matched = results.length;
    meta.took = performance.now() - t0;
    return { results, meta };
  }

  let effectiveMode = mode;
  let filtersFinal = { ...DEFAULT_FILTERS, ...filters };
  let terms = tokenizeQuery(q);
  let parsed = null;

  // ---------- auto：特征判断
  if (mode === 'auto') {
    effectiveMode = decideMode(q, terms);
    stage(`智能判定 → ${effectiveMode}`);
  }

  // ---------- nl：先解析
  if (effectiveMode === 'nl') {
    const ruleParsed = parseQueryRules(q);
    parsed = ruleParsed;
    stage('规则解析完成');

    if (useLLM && q.length >= 6 && looksLikeSentence(q)) {
      const llmParsed = await parseQueryLLM(q, {
        categories: undefined,
        tags: Array.from(new Set(items.flatMap((p) => p.tags || []))).slice(0, 80),
      });
      if (llmParsed) {
        parsed = mergeParsed(ruleParsed, llmParsed);
        stage('LLM 解析完成');
      } else {
        meta.errors.push('LLM 解析不可用，已使用本地规则解析');
      }
    }

    filtersFinal = {
      ...filtersFinal,
      category: filtersFinal.category || parsed.category || null,
      favoriteOnly: filtersFinal.favoriteOnly || parsed.favoriteOnly,
      platforms: (filtersFinal.platforms && filtersFinal.platforms.length ? filtersFinal.platforms : parsed.platforms) || [],
      days: filtersFinal.days || parsed.days || null,
    };
    if (sort === 'relevance' && parsed.sort && parsed.sort !== 'relevance') sort = parsed.sort;
    // NL 模式完全信任解析结果：解析不出关键词就是「纯条件检索」（例如「我收藏的」），
    // 此时绝不能退回用原始分词碎片去搜，否则 '我收藏的' 会变成 ['我收','藏的'] 这种垃圾查询。
    terms = parsed.keywords;
  }

  meta.parsed = parsed;
  meta.mode = effectiveMode;
  meta.terms = terms;

  // ---------- 候选集
  const entries = applyFilters(index.entries, filtersFinal);
  stage(`过滤后候选 ${entries.length} 条`);

  if (!terms.length) {
    const results = entries.map((e) => ({ prompt: e.p, score: heat(e.p), why: [], hits: [] })).sort(sorter(sort)).slice(0, limit);
    meta.matched = results.length;
    meta.took = performance.now() - t0;
    return { results, meta };
  }

  // ---------- 打分
  const scorer =
    effectiveMode === 'fuzzy' ? fuzzyScore :
    effectiveMode === 'synonym' ? synonymScore :
    effectiveMode === 'nl' ? nlScore :
    quickScore;

  let scored = [];
  for (const e of entries) {
    let r = scorer(e, terms);
    // 近义词模式额外用快速搜索兜一层，避免「原词直接命中」被近义扩展稀释
    if (!r && effectiveMode === 'synonym') r = quickScore(e, terms);
    if (r) scored.push({ prompt: e.p, ...r });
  }
  stage(`命中 ${scored.length} 条`);

  // 快速模式若一条都没有，自动降级到模糊，避免"什么都没找到"的挫败感
  if (!scored.length && effectiveMode === 'quick') {
    for (const e of entries) {
      const r = fuzzyScore(e, terms, 0.5);
      if (r) scored.push({ prompt: e.p, ...r });
    }
    if (scored.length) {
      meta.mode = 'quick→fuzzy';
      stage(`快速无结果，自动降级模糊，命中 ${scored.length} 条`);
    }
  }

  // ---------- LLM 语义重排（自然语言模式）
  if (effectiveMode === 'nl' && useLLM && scored.length > 1 && scored.length <= 60) {
    try {
      const { llmAvailable, llmRerank } = await import('./llm.js');
      if (llmAvailable()) {
        const top = scored.slice(0, 40);
        const scores = await llmRerank(q, top.map((s) => s.prompt));
        if (Object.keys(scores).length) {
          for (const s of scored) {
            const semantic = scores[s.prompt.id];
            if (typeof semantic === 'number') {
              s.semantic = semantic;
              s.score = s.score * 0.4 + semantic * 180;
              s.why = [...s.why, `语义相关度 ${(semantic * 100).toFixed(0)}%`];
            }
          }
          stage('LLM 语义重排完成');
        }
      }
    } catch (e) {
      meta.errors.push('语义重排失败：' + e.message);
    }
  }

  scored.sort(sorter(sort));
  meta.matched = scored.length;
  meta.took = performance.now() - t0;
  return { results: scored.slice(0, limit), meta };
}

/* ------------------------------------------------------------------ 排序 & 工具 */

function sorter(sort) {
  switch (sort) {
    case 'recent':
      return (a, b) => b.prompt.updatedAt - a.prompt.updatedAt;
    case 'created':
      return (a, b) => b.prompt.createdAt - a.prompt.createdAt;
    case 'used':
      return (a, b) => b.prompt.useCount - a.prompt.useCount || b.prompt.updatedAt - a.prompt.updatedAt;
    case 'title':
      return (a, b) => a.prompt.title.localeCompare(b.prompt.title, 'zh-Hans-CN');
    default:
      return (a, b) => b.score - a.score || b.prompt.updatedAt - a.prompt.updatedAt;
  }
}

/** 特征判断：纯拼音串 -> 模糊；像句子的中文 -> 自然语言；其余 -> 快速 */
function decideMode(q, terms) {
  const hasCJK = /[\u4e00-\u9fff]/.test(q);
  const isAsciiWord = /^[a-zA-Z0-9_\s.+#-]+$/.test(q);
  if (!hasCJK && isAsciiWord && q.replace(/\s/g, '').length >= 3) return 'fuzzy';
  if (looksLikeSentence(q)) return 'nl';
  if (terms.some((t) => hasSynonym(t)) && q.length >= 4) return 'synonym';
  return 'quick';
}

function looksLikeSentence(q) {
  if (q.length < 7) return false;
  if (/[?？]/.test(q)) return true;
  const markers = /(的|那些|哪些|有没有|帮我|我想|给我|关于|相关的|上次|之前|收藏过|用过|最近|上周|写过的|用来)/g;
  const hits = (q.match(markers) || []).length;
  return hits >= 2 || (hits >= 1 && q.length >= 10);
}

function mergeParsed(rule, llm) {
  const explain = [...(rule.explain || [])];
  if (llm.explain) explain.push(`AI 理解：${llm.explain}`);
  return {
    keywords: llm.keywords && llm.keywords.length ? llm.keywords : rule.keywords,
    category: llm.category || rule.category,
    tags: Array.from(new Set([...(rule.tags || []), ...(llm.tags || [])])),
    favoriteOnly: Boolean(rule.favoriteOnly || llm.favoriteOnly),
    platforms: Array.from(new Set([...(rule.platforms || []), ...(llm.platforms || [])])),
    days: rule.days ?? llm.days ?? null,
    sort: llm.sort && llm.sort !== 'relevance' ? llm.sort : rule.sort,
    explain,
    source: 'rule+llm',
  };
}

/* ------------------------------------------------------------------ 高亮 */

/** 在文本中定位查询片段的区间，供 UI 高亮 */
export function findSpans(text, terms) {
  const src = String(text || '');
  const low = src.toLowerCase();
  const spans = [];
  for (const t of terms) {
    const n = String(t || '').toLowerCase().trim();
    if (!n) continue;
    let from = 0;
    while (from < low.length) {
      const i = low.indexOf(n, from);
      if (i === -1) break;
      spans.push([i, i + n.length]);
      from = i + Math.max(1, n.length);
    }
  }
  if (!spans.length) return [];
  spans.sort((a, b) => a[0] - b[0]);
  const merged = [spans[0]];
  for (let i = 1; i < spans.length; i++) {
    const last = merged[merged.length - 1];
    if (spans[i][0] <= last[1]) last[1] = Math.max(last[1], spans[i][1]);
    else merged.push(spans[i]);
  }
  return merged;
}

/** 搜索自检，供设置页展示 */
export function engineInfo() {
  return {
    modes: MODES.length,
    platforms: PLATFORMS.length,
  };
}
