/**
 * LLM 接入层（可选能力）
 *
 * 两个用途
 *   1. 自然语言搜索：把「上周写的那些翻译的、我收藏过的」解析成结构化检索条件
 *   2. 低置信度自动分类兜底
 *
 * 重要说明（务必知悉）
 *   - 本模块是「可选增强」。不配置任何 Key，所有搜索模式与分类依然可用（走规则引擎）。
 *   - 浏览器 / PWA 直接请求大模型接口普遍会被 CORS 拦截。桌面端（Electron）通过
 *     主进程 IPC 转发可绕过。Web 端若遇到跨域失败，属于预期行为，不是 Bug。
 *   - 支持任何 OpenAI 兼容 /chat/completions 接口。
 */

const PRESETS = {
  glm: {
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
    doc: 'https://open.bigmodel.cn/usercenter/apikeys',
  },
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    doc: 'https://platform.deepseek.com/api_keys',
  },
  doubao: {
    label: '豆包（火山方舟）',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-pro-32k',
    doc: 'https://console.volcengine.com/ark',
  },
  qwen: {
    label: '通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    doc: 'https://bailian.console.aliyun.com/',
  },
  moonshot: {
    label: 'Kimi（月之暗面）',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
    doc: 'https://platform.moonshot.cn/console/api-keys',
  },
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    doc: 'https://platform.openai.com/api-keys',
  },
  custom: { label: '自定义（OpenAI 兼容）', baseUrl: '', model: '', doc: '' },
};

export function llmPresets() {
  return PRESETS;
}

let _settings = null;

export function configure(settings) {
  _settings = settings || null;
}

function cfg() {
  const s = _settings || {};
  const preset = PRESETS[s.llmProvider] || PRESETS.custom;
  return {
    baseUrl: (s.llmBaseUrl || preset.baseUrl || '').replace(/\/+$/, ''),
    apiKey: s.llmApiKey || '',
    model: s.llmModel || preset.model || '',
    enabled: Boolean(s.llmEnabled),
    timeout: Number(s.llmTimeout) || 20000,
  };
}

export function llmAvailable() {
  const c = cfg();
  return Boolean(c.enabled && c.apiKey && c.baseUrl && c.model);
}

export function llmStatus() {
  const c = cfg();
  return {
    available: llmAvailable(),
    enabled: c.enabled,
    hasKey: Boolean(c.apiKey),
    baseUrl: c.baseUrl,
    model: c.model,
  };
}

/**
 * 统一的 chat 调用。桌面端自动走原生转发以规避 CORS。
 */
export async function chat(messages, { temperature = 0, jsonMode = false, maxTokens = 800 } = {}) {
  const c = cfg();
  if (!llmAvailable()) throw new Error('LLM 未配置：请到「设置」填写服务商与 API Key');

  const url = `${c.baseUrl}/chat/completions`;
  const body = {
    model: c.model,
    messages,
    temperature,
    max_tokens: maxTokens,
  };
  if (jsonMode) body.response_format = { type: 'json_object' };

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${c.apiKey}`,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), c.timeout);

  try {
    let res;
    if (globalThis.__aiph?.httpRequest) {
      // Electron 主进程转发
      const r = await globalThis.__aiph.httpRequest({ url, method: 'POST', headers, body: JSON.stringify(body) });
      res = { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => r.body };
    } else {
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
    }

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`接口返回 ${res.status}：${text.slice(0, 300)}`);
    }
    const data = JSON.parse(text);
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error('接口未返回内容');
    return content;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('请求超时，请检查网络或调大超时时间');
    if (e instanceof TypeError && /fetch/i.test(e.message)) {
      throw new Error('请求被浏览器跨域策略拦截。请改用桌面端（Electron），或在本地服务器环境访问。');
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function safeJson(text) {
  if (!text) return null;
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const start = s.search(/[[{]/);
  if (start > 0) s = s.slice(start);
  try {
    return JSON.parse(s);
  } catch (_) {
    return null;
  }
}

const CLASSIFY_SYSTEM = `你是提示词管理系统的分类引擎。请把用户给出的 AI 指令归类到下列分类之一，只输出 JSON。

可选分类（key 必须原样使用）：
writing 写作创作 / coding 编程开发 / translate 翻译语言 / office 办公效率 / data 数据分析 /
marketing 市场营销 / study 学习研究 / design 图像设计 / media 音视频 / business 商业职场 /
life 生活日常 / meta 角色设定 / other 其他

输出格式：{"category":"key","confidence":0.0-1.0,"reason":"不超过20字的理由"}
不要输出任何其他文字。`;

export async function llmClassify(prompt) {
  const payload = {
    title: prompt.title || '',
    tags: prompt.tags || [],
    note: prompt.note || '',
    content: String(prompt.content || '').slice(0, 1200),
  };
  const content = await chat(
    [
      { role: 'system', content: CLASSIFY_SYSTEM },
      { role: 'user', content: JSON.stringify(payload) },
    ],
    { jsonMode: true, maxTokens: 200 }
  );
  const obj = safeJson(content);
  if (!obj || !obj.category) return null;
  const valid = ['writing', 'coding', 'translate', 'office', 'data', 'marketing', 'study', 'design', 'media', 'business', 'life', 'meta', 'other'];
  if (!valid.includes(obj.category)) return null;
  return {
    category: obj.category,
    confidence: typeof obj.confidence === 'number' ? Math.min(1, Math.max(0, obj.confidence)) : 0.7,
    reason: obj.reason || '',
  };
}

/**
 * 自然语言查询 -> 结构化检索条件
 * @param {string} query
 * @param {object} ctx 可选上下文：分类清单、标签清单、当前时间
 */
export async function llmParseQuery(query, ctx = {}) {
  const now = new Date();
  const cats = (ctx.categories || []).map((c) => `${c.key}=${c.name}`).join('、');
  const tags = (ctx.tags || []).slice(0, 80).join('、');

  const system = `你是提示词检索助手。把用户的自然语言检索意图解析为 JSON 检索条件。

当前时间：${now.toLocaleString('zh-CN')}（ISO ${now.toISOString()}）

可用分类：${cats || '（未提供）'}
库中已有标签示例：${tags || '（未提供）'}

字段说明
- keywords: 字符串数组，抽取出的核心检索词（去掉"帮我找""那些"等无实际含义的词），保留动作词如"翻译""总结"
- category: 命中的分类 key，没有则为 null
- tags: 命中的已有标签，没有则为 []
- favoriteOnly: true 表示用户明确要求"收藏过的"
- platforms: 数组，取值 chatgpt/workbuddy/deepseek/doubao/claude/gemini，未指定为 []
- days: 数字，表示"最近 N 天"；"上周"约 7，"今天"为 1；未指定为 null
- sort: "recent" | "used" | "created" | "relevance"，默认 "relevance"
- explain: 一句话说明你的理解（不超过 30 字）

只输出 JSON，不要其他文字。`;

  const content = await chat(
    [
      { role: 'system', content: system },
      { role: 'user', content: query },
    ],
    { jsonMode: true, maxTokens: 500 }
  );
  const obj = safeJson(content);
  if (!obj) throw new Error('模型返回内容无法解析为 JSON');
  return {
    keywords: Array.isArray(obj.keywords) ? obj.keywords.map(String).filter(Boolean) : [],
    category: obj.category || null,
    tags: Array.isArray(obj.tags) ? obj.tags.map(String) : [],
    favoriteOnly: Boolean(obj.favoriteOnly),
    platforms: Array.isArray(obj.platforms) ? obj.platforms.map(String) : [],
    days: Number.isFinite(obj.days) ? Number(obj.days) : null,
    sort: obj.sort || 'relevance',
    explain: obj.explain || '',
  };
}

/**
 * 语义重排：给候选指令按与查询的语义相关度打分
 * @param {string} query
 * @param {{id:string,title:string,note:string}[]} candidates
 * @returns {Promise<Record<string, number>>} id -> 0~1
 */
export async function llmRerank(query, candidates) {
  if (!candidates.length) return {};
  const list = candidates.slice(0, 40).map((c, i) => `${i}. ${c.title}${c.note ? ' —— ' + c.note.slice(0, 60) : ''}`).join('\n');
  const content = await chat(
    [
      { role: 'system', content: '你是检索排序模型。给定用户查询和候选条目，输出每个条目与查询的语义相关度。只输出 JSON：{"scores":[{"i":序号,"s":0到1的小数}]}，按相关度降序，只保留 s>=0.3 的条目。' },
      { role: 'user', content: `查询：${query}\n\n候选：\n${list}` },
    ],
    { jsonMode: true, maxTokens: 900 }
  );
  const obj = safeJson(content);
  const out = {};
  if (obj?.scores) {
    for (const row of obj.scores) {
      const c = candidates[row.i];
      if (c) out[c.id] = Math.min(1, Math.max(0, Number(row.s) || 0));
    }
  }
  return out;
}

/** 连通性自检 */
export async function llmTest() {
  const t0 = Date.now();
  const content = await chat([{ role: 'user', content: '回复两个字：正常' }], { maxTokens: 16 });
  return { ok: true, ms: Date.now() - t0, reply: content.trim().slice(0, 40) };
}
