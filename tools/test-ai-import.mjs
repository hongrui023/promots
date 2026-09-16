/**
 * AI 助手拆分路径的端到端测试（真实调用模型）
 *
 * 用法：
 *   GLM_KEY=xxx node tools/test-ai-import.mjs
 *   node tools/test-ai-import.mjs --key xxx --model glm-4-flash
 *
 * 这个测试会真的把文本发到模型服务上，所以：
 *   - 默认不参与常规自检（verify.mjs 里不含它），只在需要时手动跑
 *   - Key 只从命令行/环境变量读，绝不写入任何文件
 *   - 用官方夹具（公开的技术手册片段）而非任何私人材料
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'app', 'js');
const TMP = path.join(ROOT, 'tools', '.verify');
const FIXTURE = path.join(__dirname, 'fixtures', 'longtext-templates.txt');

const arg = (name) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : null;
};

const KEY = arg('key') || process.env.GLM_KEY || process.env.LLM_API_KEY || '';
const BASE = (arg('base') || process.env.GLM_BASE || 'https://open.bigmodel.cn/api/paas/v4').replace(/\/+$/, '');
const MODEL = arg('model') || process.env.GLM_MODEL || 'glm-4-flash';

if (!KEY) {
  console.error('\x1b[33m未提供模型 API Key。\x1b[0m');
  console.error('用法：GLM_KEY=xxx node tools/test-ai-import.mjs');
  process.exit(2);
}

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
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const mod = (rel) => import(url.pathToFileURL(path.join(TMP, 'js', rel)).href);

const IMP = await mod('importer.js');

console.log('\x1b[1m\x1b[35mAI 拆分路径测试\x1b[0m');
console.log(`\x1b[90m模型 ${MODEL}  ·  ${BASE}\x1b[0m`);

/* ------------------------------------------------------------------ 调用封装 */

let apiCalls = 0;
let tokens = 0;

async function chat(messages, { jsonMode = false, maxTokens = 800 } = {}) {
  apiCalls++;
  const body = { model: MODEL, messages, temperature: 0, max_tokens: maxTokens };
  if (jsonMode) body.response_format = { type: 'json_object' };
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`接口 HTTP ${res.status}：${text.slice(0, 240)}`);
  const j = JSON.parse(text);
  tokens += j.usage?.total_tokens || 0;
  const c = j.choices?.[0]?.message?.content;
  if (!c) throw new Error('接口未返回内容');
  return c;
}

/* ------------------------------------------------------------------ 一、连通 */

section('一、连通性');
const t0 = Date.now();
const pong = await chat([{ role: 'user', content: '只回复两个字：正常' }], { maxTokens: 16 });
ok('模型可调用', pong.trim().length > 0, `回复「${pong.trim().slice(0, 12)}」，${Date.now() - t0} ms`);

/* ------------------------------------------------------------------ 二、真实长文本 */

section('二、用技术手册片段做 AI 拆分');

const fixture = fs.readFileSync(FIXTURE, 'utf8');
const result = await IMP.analyzeWithAI(fixture, { chat, batchChars: 3500 });

console.log(`  \x1b[90m${fixture.length} 字符 → ${result.items.length} 条，API 调用 ${apiCalls} 次\x1b[0m`);
for (const it of result.items) {
  console.log(`  \x1b[90m· [${it.category}] ${it.title}  (${it.content.length} 字)\x1b[0m`);
}

ok('返回了条目', result.items.length >= 4, `${result.items.length} 条`);
ok('每条都有标题', result.items.every((i) => i.title && i.title.length >= 2));
ok('每条都有正文', result.items.every((i) => i.content.length >= 40));
ok('每条都有分类', result.items.every((i) => i.category && i.category !== ''));

/* --- 说明性章节不该被当成指令 --- */
const noiseTitles = result.items.filter((i) => /使用说明|速查表|运行环境|排错|占位符|文档结束/.test(i.title));
ok('说明性章节未被当作指令', noiseTitles.length === 0, noiseTitles.map((i) => i.title).join(' / ') || '0 条');

/* --- 真正该拆出来的条目 --- */
const titles = result.items.map((i) => i.title).join(' | ');
ok('拆出了「读论文/中英对照」类条目', /中英对照|读论文|对照阅读|论文阅读/.test(titles), titles.slice(0, 120));
ok('拆出了「精读卡」类条目', /精读|Paper Card|证据链/i.test(titles));
ok('拆出了「组会 PPT」类条目', /PPT|组会|汇报/i.test(titles));

/* --- 正文没有被改写：占位符必须原样保留 --- */
const allContent = result.items.map((i) => i.content).join('\n');
ok('占位符原样保留（未替换成具体值）', /【[^】]{2,20}】/.test(allContent));
ok('保留了原文的技能名', /nature-/.test(allContent), (allContent.match(/nature-[a-z-]+/g) || []).slice(0, 4).join(', '));
ok('保留了「输出到」这类硬约束', /输出到|写入|保存到/.test(allContent));

/* --- 正文不该被大幅精简 --- */
const sumLen = result.items.reduce((s, i) => s + i.content.length, 0);
ok('正文总长度与原文量级相当（未被过度精简）', sumLen > fixture.length * 0.25, `${sumLen} / ${fixture.length} 字符`);

/* --- 标签 --- */
const tagged = result.items.filter((i) => i.tags.length);
ok('多数条目带上了标签', tagged.length >= result.items.length * 0.5, `${tagged.length}/${result.items.length} 条有标签`);

/* ------------------------------------------------------------------ 三、分批 */

section('三、超长文本分批');

// 造一份约 2.5 倍夹具大小的文本，强制走分批逻辑
const big = [fixture, fixture.replace(/■ 3/g, '■ 7').replace(/【3\./g, '【5.'), fixture.replace(/■ 4/g, '■ 8').replace(/【4\./g, '【6.')].join('\n\n');
const before = apiCalls;
const bigResult = await IMP.analyzeWithAI(big, { chat, batchChars: 3500 });
const calls = apiCalls - before;

ok('超长文本触发了分批', calls >= 2, `${big.length} 字符切成 ${calls} 批`);
ok('分批后条目数多于单批', bigResult.items.length > result.items.length, `${bigResult.items.length} 条`);
ok('分批结果无空洞条目', bigResult.items.every((i) => i.title && i.content.length > 20));

/* ------------------------------------------------------------------ 四、进度回调 */

section('四、进度回调与错误处理');

let progressSeen = [];
await IMP.analyzeWithAI(fixture, {
  chat,
  batchChars: 3500,
  onProgress: (p) => progressSeen.push(`${p.done}/${p.total}`),
});
ok('进度回调被调用', progressSeen.length >= 2, progressSeen.join(' → '));

let errOk = false;
try {
  await IMP.analyzeWithAI('测试文本', { chat: null });
} catch (e) {
  errOk = /chat/.test(e.message);
}
ok('未提供 chat 时抛出明确错误', errOk);

let badKeyOk = false;
try {
  await IMP.analyzeWithAI('测试文本', {
    chat: async () => {
      const r = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer invalid-key' },
        body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] }),
      });
      if (!r.ok) throw new Error(`接口 HTTP ${r.status}`);
      return (await r.json()).choices[0].message.content;
    },
  });
} catch (e) {
  badKeyOk = /HTTP 401|HTTP 403|invalid/i.test(e.message);
}
ok('无效 Key 会抛出错误而不是静默失败', badKeyOk);

/* ------------------------------------------------------------------ 结果 */

console.log(
  `\n\x1b[1m结果：\x1b[0m \x1b[32m${pass} 项通过\x1b[0m${fail ? `，\x1b[31m${fail} 项失败\x1b[0m` : ''}`
);
console.log(`\x1b[90m共调用接口 ${apiCalls} 次，消耗 ${tokens} tokens\x1b[0m`);
if (fail) {
  console.log('\x1b[31m失败项：\x1b[0m');
  for (const f of failures) console.log('  - ' + f);
}
console.log();
process.exit(fail ? 1 : 0);
