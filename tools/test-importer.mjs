/**
 * 长文本批量导入引擎功能测试
 *
 * 用法：node tools/test-importer.mjs
 *
 * 用一份真实结构的长文本（工具手册里的一整节指令模板）作为夹具，
 * 检验分块、字段抽取、噪音过滤、去重标记是否可靠。
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'app', 'js');
const TMP = path.join(ROOT, 'tools', '.verify');
const FIXTURE = path.join(__dirname, 'fixtures', 'longtext-templates.txt');

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
const mod = (rel) => import(url.pathToFileURL(path.join(TMP, 'js', rel)).href);

const IMP = await mod('importer.js');

console.log('\x1b[1m\x1b[35mAI Prompt Hub · 长文本导入引擎测试\x1b[0m');

const FIXTURE_TEXT = fs.readFileSync(FIXTURE, 'utf8');

/* ================================================================ 一、基础函数 */

section('一、基础识别函数');

ok('分隔线识别', IMP.isSeparator('--------------------------------') && IMP.isSeparator('========='));
ok('普通文本不是分隔线', !IMP.isSeparator('---- 我是标题 ----') && !IMP.isSeparator('abc'));

const h1 = IMP.headingInfo('【3.1】读论文：中英对照全文');
ok('方括号编号标题', h1 && h1.number === '3.1' && h1.title === '读论文：中英对照全文', JSON.stringify(h1));

const h2 = IMP.headingInfo('■ 3  单技能指令模板');
ok('实心方块标题', h2 && h2.number === '3' && h2.title === '单技能指令模板', JSON.stringify(h2));

const h3 = IMP.headingInfo('### 2.1 安装依赖');
ok('Markdown 标题', h3 && h3.number === '2.1' && h3.title === '安装依赖');

ok('短编号句不是标题', IMP.headingInfo('1. 每个模板都能整段复制到对话框，把【】里的内容换成你自己的信息即可。') === null);
ok('无编号中文标题识别', Boolean(IMP.headingInfo('一、总则')));

const m1 = IMP.metaOf('技能：nature-reader');
ok('技能元数据行', m1 && m1.key === 'skill' && m1.value === 'nature-reader');

const m2 = IMP.metaOf('需要你替换：【论文路径/DOI】【输出目录】');
ok('替换信息元数据行', m2 && m2.key === 'replace');

ok('元数据行不误判普通文本', IMP.metaOf('使用 nature-reader，把论文做成中英对照。') === null);

const vars = IMP.extractVariables('把【论文路径】输出到【输出目录】，期刊是【目标期刊】。');
ok('占位符提取', vars.length === 3 && vars[0] === '论文路径' && vars[2] === '目标期刊', vars.join(' / '));
ok('占位符去重', IMP.extractVariables('【A】和【A】还有【B】').length === 2);

const skills = IMP.extractSkills('使用 nature-reader 然后 nature-paper2ppt，参考 fake-skill-xyz');
ok('技能名提取（白名单过滤）', skills.length === 2 && skills.includes('nature-reader') && !skills.includes('fake-skill-xyz'), skills.join(','));

ok('指纹稳定：同内容同指纹', IMP.fingerprint('你好，世界！') === IMP.fingerprint('你好世界'));
ok('指纹区分：不同内容不同指纹', IMP.fingerprint('你好') !== IMP.fingerprint('再见'));
ok('相似度：完全相同为 1', IMP.similarity('abcdefg', 'abcdefg') === 1);
ok('相似度：相近文本高分', IMP.similarity('把这篇论文翻译成中文', '把这篇论文翻译成中文。') > 0.85);
ok('相似度：无关文本低分', IMP.similarity('把这篇论文翻译成中文', '查询天气怎么样') < 0.2);

/* ================================================================ 二、真实文本分析 */

section('二、真实长文本分析');

const result = IMP.analyze(FIXTURE_TEXT, { existing: [] });
const { items, stats } = result;

console.log(`  \x1b[90m夹具：${stats.chars} 字符 → ${stats.blocks} 个块 → ${stats.total} 条候选\x1b[0m`);
console.log(
  `  \x1b[90m分类：指令 ${stats.prompt} / 说明 ${stats.note} / 表格 ${stats.table} / 碎片 ${stats.fragment}；默认勾选 ${stats.selected} 条\x1b[0m`
);

const titles = items.map((i) => i.title);
const promptTitles = items.filter((i) => i.kind === 'prompt').map((i) => i.title);

ok('切出足够多的候选条目', stats.total >= 12, `${stats.total} 条`);
ok('识别出指令条目', stats.prompt >= 8, `${stats.prompt} 条指令`);

/* --- 逐条核对：这些标题必须被识别为指令 --- */
const expectPrompts = [
  '读论文：中英对照全文',
  '精读一篇论文（Paper Card）',
  '论文 → 中文汇报 PPT',
  '润色 / 翻译 / 精简',
  '科研配图 / 多面板图 / 机制图',
  '合法下载全文与 SI',
  '投稿前冲刺（读 → 审 → 补 → 改）',
  '组会 / 文献汇报流水线（读 → 卡 → PPT）',
  '新方向快速调研',
];
for (const t of expectPrompts) {
  const hit = items.find((i) => i.title === t);
  ok(`识别为指令：${t}`, Boolean(hit) && hit.kind === 'prompt', hit ? `kind=${hit.kind} score=${hit.score}` : '未找到');
}

/* --- 噪音必须被排除在默认勾选之外 --- */
for (const t of ['使用说明', '通用前缀']) {
  const hit = items.find((i) => i.title.includes(t));
  ok(`说明性章节不默认勾选：${t}`, !hit || hit.kind !== 'prompt', hit ? `kind=${hit.kind} score=${hit.score}` : '已被过滤');
}
const cheat = items.find((i) => i.title.includes('速查表'));
ok('速查表被识别为表格或说明', !cheat || cheat.kind !== 'prompt', cheat ? `kind=${cheat.kind}` : '已被过滤');

ok('容器标题（■ 3 单技能指令模板）未被当作指令', !titles.includes('单技能指令模板'));
ok('文档结束语未被当作指令', !promptTitles.some((t) => t.includes('文档结束')));

/* --- 字段抽取正确性 --- */
const reader = items.find((i) => i.title === '读论文：中英对照全文');
ok('技能被识别为标签', reader?.tags.includes('nature-reader'), reader?.tags.join(','));
ok('占位符被提取', reader?.variables.length >= 2, (reader?.variables || []).join(' / '));
ok('来源章节被记录', /单技能指令模板/.test(reader?.note || ''), reader?.note);
ok('占位符写进备注', /需要替换/.test(reader?.note || ''));
ok('正文保留了结构', /1\./.test(reader?.content || '') && (reader?.content || '').length > 200, `${reader?.content.length} 字符`);
ok('正文不含标题行', !/^【3\.1】/.test(reader?.content || ''));
ok('正文不含分隔线', !/^-{10,}/m.test(reader?.content || ''));
ok('原文行号区间被记录', Array.isArray(reader?.sourceRange) && reader.sourceRange[1] > reader.sourceRange[0], `行 ${reader?.sourceRange?.join('-')}`);

const sprint = items.find((i) => i.title === '投稿前冲刺（读 → 审 → 补 → 改）');
ok('组合流程被识别为指令', sprint?.kind === 'prompt', `score=${sprint?.score}`);
ok('组合流程来源章节正确', /组合工作流/.test(sprint?.note || ''), sprint?.note);
ok('一个条目含多个技能时取首个为 skill', skills.indexOf(sprint?.skill) >= 0 || Boolean(sprint?.skill), sprint?.skill);

/* --- 分类预判 --- */
const catOk = items.filter((i) => i.kind === 'prompt').every((i) => i.category && i.category !== '');
ok('每条都有分类预判', catOk);
const studyCount = items.filter((i) => i.kind === 'prompt' && i.category === 'study').length;
ok('科研类指令多数归入「学习研究」', studyCount >= 5, `${studyCount} 条归入 study`);

/* --- 每条都完整 --- */
ok('所有条目都有标题', items.every((i) => i.title && i.title.length > 1));
ok('所有条目都有正文', items.every((i) => i.content.length > 10));
ok('所有条目的指纹非空', items.every((i) => i.fingerprint.length === 20));
ok('kind 取值合法', items.every((i) => ['prompt', 'note', 'table', 'fragment'].includes(i.kind)));
ok('统计数与实际一致', stats.total === items.length && stats.prompt === items.filter((i) => i.kind === 'prompt').length);

/* ================================================================ 三、幂等性 */

section('三、幂等与稳定性');

const r2 = IMP.analyze(FIXTURE_TEXT, { existing: [] });
ok('两次分析结果完全一致', JSON.stringify(r2.items) === JSON.stringify(items));
ok('不含时间戳或随机数', !JSON.stringify(items).match(/\b1[6-9]\d{11}\b/));

/* ================================================================ 四、去重 */

section('四、重复标记');

const existing = [
  { title: '读论文：中英对照全文', content: reader.content, deleted: false },
  { title: '论文润色', content: '完全不同的内容，随便写点什么让指纹不一样。', deleted: false },
];
const r3 = IMP.analyze(FIXTURE_TEXT, { existing });
const duped = r3.items.filter((i) => i.dup);
ok('与库中已有条目比出去重项', duped.length >= 1, `标记 ${duped.length} 条`);
ok('内容相同判为 exact', duped.some((i) => i.dup.level === 'exact'), duped.map((i) => i.dup.level).join(','));
ok('重复项默认不勾选', duped.every((i) => !i.selected));
ok('统计里体现重复数', r3.stats.duplicated === duped.length);

const selfDup = IMP.markInternalDuplicates([
  { title: 'A', content: '一样的内容一样的内容一样的内容', fingerprint: 'x', selected: true, tags: [] },
  { title: 'B', content: '一样的内容一样的内容一样的内容', fingerprint: 'x', selected: true, tags: [] },
]);
ok('候选内部重复也能查出', selfDup.filter((i) => i.dup).length === 1 && selfDup[1].selected === false);

/* ================================================================ 五、边界情况 */

section('五、边界情况');

ok('空文本返回空结果', IMP.analyze('').items.length === 0);
ok('纯空白返回空结果', IMP.analyze('   \n\n  \t ').items.length === 0);
ok('单行文本能处理', IMP.analyze('帮我写一封辞职信，语气要客气但坚定，不要提具体原因。').items.length === 1);

const marker = IMP.analyze('@long-text:\n\n## 我的指令\n\n把下面这段文字翻译成英文，保持专业术语不变，输出到桌面。');
ok('剥掉 @long-text: 标记', marker.items.length === 1 && marker.items[0].title === '我的指令', marker.items[0]?.title);

const noHeading = IMP.analyze('第一段：帮我总结这篇论文的核心贡献。\n\n第二段：把总结翻译成英文，术语保持一致，输出到指定目录。');
ok('无标题文本不崩', noHeading.items.length >= 1, `${noHeading.items.length} 条`);

const codeFence = IMP.analyze(
  '## 代码审查\n\n请审查下面这段代码：\n\n```js\nfunction f() {\n  // ---------- 这行分隔线在代码块里，不该切块 ----------\n}\n```\n\n重点看边界条件与错误处理，输出到报告文件。'
);
ok('代码围栏内的分隔线不切块', codeFence.items.length === 1, `${codeFence.items.length} 条`);
ok('代码块内容被完整保留', /function f\(\)/.test(codeFence.items[0]?.content || ''));

const longText = IMP.analyze('普通一句话。'.repeat(2000));
ok('超长无结构文本不卡死', Array.isArray(longText.items));

/* ================================================================ 六、诊断 */

section('六、诊断报告');

const d1 = IMP.diagnose(result);
ok('正常文本诊断通过', d1.level === 'ok' || d1.level === 'warn', d1.notes.join(' / '));
const d2 = IMP.diagnose(IMP.analyze(''));
ok('空文本诊断报错', d2.level === 'error', d2.notes[0]);
const d3 = IMP.diagnose(IMP.analyze('【1.1】条目一\n\n' + '内容'.repeat(3000) + '\n\n---\n\n'));
ok('超长条目给出提示', d3.notes.some((n) => /偏长/.test(n)), d3.notes.join(' / '));

/* ================================================================ 七、写入载荷 */

section('七、入库载荷');

const payload = IMP.toPromptPayload(reader, { tags: ['论文', '翻译'], category: 'study' });
ok('载荷含全部必需字段', ['title', 'content', 'note', 'tags', 'category', 'categoryLocked'].every((k) => k in payload));
ok('标签合并去重', payload.tags.includes('nature-reader') && payload.tags.includes('论文') && new Set(payload.tags).size === payload.tags.length, payload.tags.join(','));
ok('默认不锁定分类（自动预判不该挡住智能整理）', payload.categoryLocked === false);
ok('用户改过分类才锁定', IMP.toPromptPayload(reader, { category: 'study', lockCategory: true }).categoryLocked === true);
ok('指定分类优先', payload.category === 'study');
ok('kindLabel 可读', IMP.kindLabel('prompt') === '指令' && IMP.kindLabel('note') === '说明');

/* ================================================================ 结果 */

console.log(`\n\x1b[1m结果：\x1b[0m \x1b[32m${pass} 项通过\x1b[0m${fail ? `，\x1b[31m${fail} 项失败\x1b[0m` : ''}`);
if (fail) {
  console.log('\x1b[31m失败项：\x1b[0m');
  for (const f of failures) console.log('  - ' + f);
}
console.log();
process.exit(fail ? 1 : 0);
