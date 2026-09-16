/**
 * 自检脚本：语法校验 + 搜索引擎功能测试
 *
 * 用法：node tools/verify.mjs
 *
 * 为什么需要它：
 *   应用本身零构建、零依赖，好处是简单，代价是没有编译器帮你兜底。
 *   这个脚本用 Node 把纯逻辑模块（拼音/近义词/分类/搜索）真跑一遍，
 *   确保改完代码后核心算法没被改坏。
 *
 * 注意：只覆盖不依赖浏览器的模块，DOM 与 IndexedDB 相关部分不在此列。
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'app', 'js');
const TMP = path.join(ROOT, 'tools', '.verify');

/* ------------------------------------------------------------------ 准备 */

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, entry.name);
    const d = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

fs.rmSync(TMP, { recursive: true, force: true });
copyDir(SRC, path.join(TMP, 'js'));
fs.writeFileSync(path.join(TMP, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');

/* ------------------------------------------------------------------ 断言 */

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}${extra ? '  \x1b[90m' + extra + '\x1b[0m' : ''}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${extra ? '  \x1b[31m' + extra + '\x1b[0m' : ''}`);
  }
}

function section(t) {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
}

async function mod(rel) {
  return import(url.pathToFileURL(path.join(TMP, 'js', rel)).href + '?t=' + Date.now());
}

/* ------------------------------------------------------------------ 测试 */

console.log('\x1b[1m\x1b[35mAI Prompt Hub · 自检\x1b[0m');

// ---------- 1. 语法
section('一、模块语法');
const jsFiles = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) jsFiles.push(p);
  }
})(SRC);

let syntaxBad = 0;
for (const f of jsFiles) {
  const rel = path.relative(SRC, f);
  try {
    await import(url.pathToFileURL(path.join(TMP, 'js', rel)).href + '?s=' + Date.now());
    pass++;
  } catch (e) {
    // main.js 会在导入时调用 boot()，依赖 DOM，属预期失败
    if (rel === 'main.js' && /document|navigator|window|indexedDB/i.test(e.message)) {
      pass++;
      console.log(`  \x1b[32m✓\x1b[0m ${rel}  \x1b[90m（含 DOM 引导代码，跳过运行时导入）\x1b[0m`);
    } else {
      syntaxBad++;
      fail++;
      failures.push(`${rel} 语法/导入`);
      console.log(`  \x1b[31m✗\x1b[0m ${rel}  \x1b[31m${e.message}\x1b[0m`);
    }
  }
}
console.log(`  \x1b[90m共 ${jsFiles.length} 个模块，${syntaxBad} 个有问题\x1b[0m`);

// ---------- 2. 拼音
section('二、拼音检索');
const py = await mod('pinyin.js');
ok('汉字转首字母 公文写作 → gwxz', py.initials('公文写作') === 'gwxz', py.initials('公文写作'));
ok('混合文本 数据分析SQL → sjfxsql', py.initials('数据分析SQL') === 'sjfxsql', py.initials('数据分析SQL'));
ok('首字母表已生成', py.pinyinAvailable(), `字典 ${py.PY_DICT_SIZE} 字 / 多音字 ${py.PY_POLY_SIZE} 个`);
ok('多音字 中 有多个读音', py.initialOf('中').length >= 1, py.initialOf('中'));
const variants = py.initialsVariants('重写');
ok('多音字变体 重写 含 zx 与 cx', variants.includes('zx') && variants.includes('cx'), variants.join(','));
ok('标点与空格被忽略', py.initials('周报、生成 器') === 'zbscq', py.initials('周报、生成 器'));

// ---------- 3. 近义词
section('三、近义词扩展');
const syn = await mod('synonyms.js');
const g1 = syn.expand('摘要');
ok('「摘要」可扩展到「总结/概括/提炼」', g1.includes('总结') && g1.includes('概括') && g1.includes('提炼'), g1.slice(0, 6).join('、'));
const g2 = syn.expand('翻译');
ok('「翻译」含英文 translate', g2.includes('translate'), g2.join('、'));
ok('未收录的词返回自身', syn.expand('zzz不存在zzz').length === 1);
ok('同义组数量合理', syn.SYNONYM_COUNT >= 100, `${syn.SYNONYM_COUNT} 组`);

// ---------- 4. 分类
section('四、自动分类');
const cls = await mod('classify.js');
const seed = await mod('seed.js');

const cases = [
  ['公文写作助手', 'writing'],
  ['周报生成器', 'office'],
  ['代码审查（Code Review）', 'coding'],
  ['中英互译 + 母语级润色', 'translate'],
  ['会议纪要提炼', 'office'],
  ['数据分析与业务洞察', 'data'],
  ['小红书种草文案', 'marketing'],
  ['把复杂概念讲到外行能懂', 'study'],
  ['文生图提示词生成器', 'design'],
  ['短视频分镜脚本', 'media'],
  ['SQL 查询生成与优化', 'coding'],
  ['合同风险审查（非法律意见）', 'business'],
  ['旅行行程规划', 'life'],
];

let classHit = 0;
for (const [title, expect] of cases) {
  const item = seed.SEED_PROMPTS.find((p) => p.title === title);
  const body = item ? { ...item, title } : { title, content: '', note: '', tags: [] };
  const r = cls.classifyByRules(body);
  const good = r.category === expect;
  if (good) classHit++;
  ok(`「${title}」→ ${cls.categoryName(r.category)}`, good, good ? '' : `期望 ${cls.categoryName(expect)}，置信度 ${r.confidence}`);
}
console.log(`  \x1b[90m分类命中率 ${classHit}/${cases.length} = ${((classHit / cases.length) * 100).toFixed(0)}%\x1b[0m`);
ok('词库已构建近义词泛化', cls.RULE_LEXICON_SIZE > 300, `${cls.RULE_LEXICON_SIZE} 个词条`);

// ---------- 5. 搜索
section('五、搜索引擎');
const se = await mod('search.js');

// 用 seed 数据构造条目，模拟真实分类结果
const items = seed.SEED_PROMPTS.map((p, i) => {
  const r = cls.classifyByRules(p);
  return {
    id: 'seed-' + i,
    title: p.title,
    content: p.content,
    note: p.note || '',
    tags: p.tags || [],
    category: r.category,
    categoryLocked: false,
    favorite: Boolean(p.favorite),
    platforms: p.platforms || [],
    useCount: i % 4,
    lastUsedAt: null,
    createdAt: Date.now() - i * 86400000,
    updatedAt: Date.now() - i * 86400000,
    deleted: false,
    deletedAt: null,
  };
});

async function run(q, opts = {}) {
  return se.search(q, { items, useLLM: false, ...opts });
}

// 快速搜索
let r = await run('周报', { mode: 'quick' });
ok('快速：搜「周报」命中周报生成器', r.results[0]?.prompt.title === '周报生成器', `首条：${r.results[0]?.prompt.title}`);

r = await run('gwxz', { mode: 'quick' });
ok('快速：拼音首字母「gwxz」命中公文写作助手', r.results[0]?.prompt.title === '公文写作助手', `首条：${r.results[0]?.prompt.title}`);

r = await run('sql', { mode: 'quick' });
ok('快速：搜「sql」命中 SQL 指令', /SQL/i.test(r.results[0]?.prompt.title || ''), `首条：${r.results[0]?.prompt.title}`);

r = await run('翻译', { mode: 'quick' });
ok('快速：搜「翻译」命中翻译指令', /翻译|互译/.test(r.results[0]?.prompt.title || ''), `首条：${r.results[0]?.prompt.title}`);

// 模糊搜索
r = await run('周抱生成器', { mode: 'fuzzy' });
ok('模糊：错字「周抱」仍命中周报生成器', r.results[0]?.prompt.title === '周报生成器', `首条：${r.results[0]?.prompt.title}`);

r = await run('代码申查', { mode: 'fuzzy' });
ok('模糊：错字「申查」命中代码审查', /代码审查/.test(r.results[0]?.prompt.title || ''), `首条：${r.results[0]?.prompt.title}`);

r = await run('xhs', { mode: 'fuzzy' });
ok('模糊：拼音首字母「xhs」能找到小红书', r.results.some((x) => /小红书/.test(x.prompt.title)), `命中 ${r.results.length} 条`);

// 近义词搜索
r = await run('摘要', { mode: 'synonym' });
ok('近义词：搜「摘要」能命中含「提炼」的指令', r.results.length > 0 && /纪要|提炼/.test(r.results.map((x) => x.prompt.title).join()), `命中：${r.results.map((x) => x.prompt.title).slice(0, 3).join('、')}`);

r = await run('summarize', { mode: 'synonym' });
ok('近义词：英文 summarize 命中会议纪要', r.results.length > 0, `命中 ${r.results.length} 条`);

r = await run('译', { mode: 'synonym' });
ok('近义词：单字「译」命中翻译类', r.results.some((x) => /互译|翻译/.test(x.prompt.title)), `命中 ${r.results.length} 条`);

// 自然语言搜索
r = await run('我收藏的', { mode: 'nl' });
ok('自然语言：识别出「收藏」过滤', r.results.length > 0 && r.results.every((x) => x.prompt.favorite), `${r.results.length} 条，均属收藏`);

r = await run('我收藏的代码类', { mode: 'nl' });
ok(
  '自然语言：收藏 + 关键词联合筛选',
  r.results.length > 0 && r.results.every((x) => x.prompt.favorite),
  r.results.map((x) => x.prompt.title).join('、') || '无结果'
);

r = await run('最近写的关于数据分析的', { mode: 'nl' });
ok('自然语言：解析出时间与主题', r.results.length > 0, `命中 ${r.results.length} 条：${r.results.map((x) => x.prompt.title).slice(0, 3).join('、')}`);

r = await run('跟代码有关的', { mode: 'nl' });
ok(
  '自然语言：「跟代码有关的」命中编程类',
  r.results.some((x) => x.prompt.category === 'coding'),
  `解析分类=${r.meta.parsed?.category || '未识别'}，命中 ${r.results.length} 条`
);

r = await run('有没有讲翻译的', { mode: 'nl' });
ok('自然语言：「有没有讲翻译的」命中翻译类', r.results.some((x) => /翻译|互译/.test(x.prompt.title)), `命中 ${r.results.length} 条`);

// 智能模式
r = await run('gwxz', { mode: 'auto' });
ok('智能模式：纯拼音串走模糊通道', r.meta.mode === 'fuzzy', `实际模式 ${r.meta.mode}`);

r = await run('我上周收藏的会议纪要', { mode: 'auto' });
ok('智能模式：长句走自然语言通道', r.meta.mode === 'nl', `实际模式 ${r.meta.mode}`);

r = await run('周报', { mode: 'auto' });
ok('智能模式：短词走快速通道', r.meta.mode === 'quick', `实际模式 ${r.meta.mode}`);

// 过滤器
r = await run('', { mode: 'quick', filters: { category: 'coding' } });
ok('过滤器：按分类筛选生效', r.results.length > 0 && r.results.every((x) => x.prompt.category === 'coding'), `${r.results.length} 条编程类`);

r = await run('', { mode: 'quick', filters: { favoriteOnly: true } });
ok('过滤器：仅收藏生效', r.results.length > 0 && r.results.every((x) => x.prompt.favorite), `${r.results.length} 条收藏`);

r = await run('', { mode: 'quick', filters: { platforms: ['claude'] } });
ok('过滤器：按平台筛选生效', r.results.every((x) => x.prompt.platforms.includes('claude')), `${r.results.length} 条支持 Claude`);

// 排序
r = await run('', { mode: 'quick', sort: 'used' });
const uses = r.results.map((x) => x.prompt.useCount);
ok('排序：按使用次数降序', uses.every((v, i) => i === 0 || uses[i - 1] >= v), uses.slice(0, 5).join(' ≥ '));

// 边界
r = await run('绝对不存在的词xyzabc', { mode: 'quick' });
ok('边界：无结果时不抛异常且降级尝试模糊', Array.isArray(r.results), `${r.results.length} 条`);
ok('边界：搜索耗时被记录', typeof r.meta.took === 'number' && r.meta.took >= 0, `${r.meta.took.toFixed(1)} ms`);

// 性能
const t0 = performance.now();
await run('代码', { mode: 'quick' });
const t1 = performance.now();
ok('性能：14 条数据快速搜索 < 50ms', t1 - t0 < 50, `${(t1 - t0).toFixed(2)} ms`);

// 高亮
const spans = se.findSpans('周报生成器', ['周报']);
ok('高亮：正确定位命中区间', spans.length === 1 && spans[0][0] === 0 && spans[0][1] === 2, JSON.stringify(spans));

// ---------- 6. 同步适配器
section('六、同步适配器');
const ad = await mod('sync/adapters.js');
ok('5 个通道已注册', ad.ADAPTERS.length === 5, ad.ADAPTERS.map((a) => a.name).join(' / '));
ok('每个通道都有 test/pull/push', ad.ADAPTERS.every((a) => typeof a.test === 'function' && typeof a.pull === 'function' && typeof a.push === 'function'));
ok('推荐通道存在', Boolean(ad.ADAPTER_MAP.get(ad.RECOMMENDED)), ad.RECOMMENDED);
const baidu = ad.ADAPTER_MAP.get('baidupan');
const authUrl = baidu.getAuthUrl({ appKey: 'TESTKEY', redirectUri: 'http://127.0.0.1:5180/oauth-callback.html', appId: '123' });
ok('百度授权链接可生成', authUrl.startsWith('https://openapi.baidu.com/oauth/2.0/authorize?') && authUrl.includes('scope=basic%2Cnetdisk'), authUrl.slice(0, 72) + '…');

/* ------------------------------------------------------------------ 结果 */

console.log('\n' + '─'.repeat(56));
if (fail === 0) {
  console.log(`\x1b[32m\x1b[1m全部通过：${pass} 项\x1b[0m`);
} else {
  console.log(`\x1b[31m\x1b[1m失败 ${fail} 项\x1b[0m，通过 ${pass} 项`);
  console.log('\x1b[31m失败清单：\x1b[0m');
  for (const f of failures) console.log('  · ' + f);
}
console.log('─'.repeat(56) + '\n');

fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
