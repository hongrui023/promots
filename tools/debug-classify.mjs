/** 临时调试脚本：查看某条指令的分类打分明细。用完即删。 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(ROOT, 'tools', '.dbg');

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, e.name);
    const d = path.join(to, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}
fs.rmSync(TMP, { recursive: true, force: true });
copyDir(path.join(ROOT, 'app', 'js'), path.join(TMP, 'js'));
fs.writeFileSync(path.join(TMP, 'package.json'), '{"type":"module"}', 'utf8');

const cls = await import(url.pathToFileURL(path.join(TMP, 'js', 'classify.js')).href + '?t=' + Date.now());
const seed = await import(url.pathToFileURL(path.join(TMP, 'js', 'seed.js')).href + '?t=' + Date.now());

const target = process.argv[2] || '小红书种草文案';
const item = seed.SEED_PROMPTS.find((p) => p.title === target) || { title: target, content: '', tags: [] };
const r = cls.classifyByRules(item);
console.log(`\n「${target}」→ ${cls.categoryName(r.category)}  置信度 ${r.confidence}\n`);
for (const x of r.ranking) {
  console.log(`  ${String(x.score).padStart(8)}  ${cls.categoryName(x.category)}`);
  const ev = r.evidence[x.category];
  if (ev) console.log(`            ${ev.join(' / ')}`);
}

fs.rmSync(TMP, { recursive: true, force: true });
