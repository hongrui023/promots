/**
 * 微云通道端到端测试
 *
 * 真实地往微云写入、读回、逐字节比对，用来验证：
 *   · MCP 协议封装是否正确（JSON-RPC 请求体 / 响应解包）
 *   · 两阶段上传流程是否能跑通（预上传 → 分片 → 完成）
 *   · 目录定位与自动创建是否正常
 *   · 上传的多分块路径（>512KB）是否正确
 *   · 取回的 JSON 是否与原数据完全一致
 *
 * 用法：
 *   1) 直连微云官方端点（需自己的 Token）
 *      node tools/weiyun-e2e.mjs --token <mcp_token>
 *
 *   2) 经由本地 MCP 代理测试（此时 --token 传代理的 Bearer 值）
 *      node tools/weiyun-e2e.mjs --token <bearer> --url http://127.0.0.1:PORT/xxx/mcp
 *
 * 可选参数：
 *   --dir <文件夹名>     默认 AI-PromptHub
 *   --file <文件名>      默认 ai-prompt-hub.json
 *   --big                额外测试大文件（>512KB，走多分块上传），完成后自动删除
 *   --keep               保留写入的文件（默认也保留主文件，仅 --big 的临时文件会被清理）
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const APP_JS = path.resolve(__dirname, '..', 'app', 'js');

/* ------------------------------------------------------------------ 参数 */

const argv = process.argv.slice(2);
function arg(name, def = null) {
  const i = argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const TOKEN = arg('token') || process.env.WEIYUN_MCP_TOKEN || '';
const URL_OVERRIDE = arg('url') || process.env.WEIYUN_MCP_URL_OVERRIDE || '';
const CTX = arg('ctx') || process.env.WEIYUN_MCP_CTX || '';
const DIR_NAME = arg('dir') || 'AI-PromptHub';
const FILE_NAME = arg('file') || 'ai-prompt-hub.json';
const TEST_BIG = Boolean(arg('big'));

if (!TOKEN || TOKEN === true) {
  console.error('缺少 --token（或在环境变量 WEIYUN_MCP_TOKEN 中提供）');
  process.exit(1);
}

/* ------------------------------------------------------------------ 准备模块 */

const TMP = path.join(__dirname, '.e2e-tmp');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(path.join(TMP, 'js', 'sync'), { recursive: true });
for (const f of fs.readdirSync(APP_JS, { withFileTypes: true })) {
  if (f.isFile() && f.name.endsWith('.js')) {
    fs.copyFileSync(path.join(APP_JS, f.name), path.join(TMP, 'js', f.name));
  }
}
for (const f of fs.readdirSync(path.join(APP_JS, 'sync'))) {
  fs.copyFileSync(path.join(APP_JS, 'sync', f), path.join(TMP, 'js', 'sync', f));
}
fs.writeFileSync(path.join(TMP, 'package.json'), '{"type":"module"}', 'utf8');

// 代理模式下改写请求：目标地址换成代理，鉴权头从 WyHeader 换成 Authorization
if (URL_OVERRIDE) {
  const realFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (u, init = {}) => {
    if (String(u).includes('www.weiyun.com/api/v3/mcpserver')) {
      const headers = { ...(init.headers || {}) };
      for (const k of Object.keys(headers)) {
        if (k.toLowerCase() === 'wyheader') delete headers[k];
      }
      headers.Authorization = `Bearer ${TOKEN}`;
      if (CTX) headers['X-WorkBuddy-MCP-Context'] = CTX;
      return realFetch(URL_OVERRIDE, { ...init, headers });
    }
    return realFetch(u, init);
  };
}

const wy = await import(url.pathToFileURL(path.join(TMP, 'js', 'sync', 'weiyun.js')).href + '?t=' + Date.now());
const { weiyun, mcpCall } = wy;

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

const cfg = { mcpToken: TOKEN, remoteDir: DIR_NAME, fileName: FILE_NAME };
const now = () => new Date().toLocaleTimeString('zh-CN');

console.log('\x1b[1m\x1b[35m微云通道 · 端到端测试\x1b[0m');
console.log(`\x1b[90m${URL_OVERRIDE ? '经由代理 ' + URL_OVERRIDE : '直连 ' + weiyun.constructor.name}　${now()}\x1b[0m\n`);

/* ------------------------------------------------------------------ 1. 连通性 */

console.log('\x1b[1m一、连通性与目录\x1b[0m');

let container;
try {
  const root = await mcpCall(cfg, 'weiyun.list', { limit: 50, get_type: 0 });
  ok('weiyun.list 调用成功', Array.isArray(root.dir_list) || Array.isArray(root.file_list), `根目录 ${(root.dir_list || []).length} 个文件夹 / ${(root.file_list || []).length} 个文件`);
  ok('返回了目录 key', Boolean(root.pdir_key), root.pdir_key || '缺失');
} catch (e) {
  ok('weiyun.list 调用成功', false, e.message);
  console.error(`\n\x1b[31m连通性失败，后续测试无意义，终止。\x1b[0m`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
}

try {
  const t = await weiyun.test(cfg);
  ok('通道自检通过', t.ok === true, t.message.replace(/\s+/g, ' '));
  container = await weiyun._internal.resolveContainer(cfg);
  ok('已定位数据目录', Boolean(container.key), `${container.name}${container.created ? '（本次新建）' : ''}`);
} catch (e) {
  ok('通道自检通过', false, e.message);
}

/* ------------------------------------------------------------------ 2. 上传 / 下载往返 */

console.log('\n\x1b[1m二、数据往返（小文件，单分块）\x1b[0m');

// 构造一份贴近真实的快照：直接从应用示例数据生成
const seedMod = await import(url.pathToFileURL(path.join(TMP, 'js', 'seed.js')).href + '?t=' + Date.now());
const items = seedMod.SEED_PROMPTS.map((p, i) => ({
  id: 'e2e-' + i,
  title: p.title,
  content: p.content,
  note: p.note || '',
  tags: p.tags || [],
  category: 'other',
  categoryLocked: false,
  favorite: Boolean(p.favorite),
  platforms: p.platforms || [],
  useCount: 0,
  lastUsedAt: null,
  createdAt: Date.now() - i * 1000,
  updatedAt: Date.now() - i * 1000,
  deleted: false,
  deletedAt: null,
  rev: 1,
}));

const snapshot = {
  schema: 1,
  app: 'ai-prompt-hub',
  exportedAt: Date.now(),
  device: { id: 'e2e-test', name: '端到端测试' },
  items,
};

const t0 = Date.now();
let pushResult;
try {
  pushResult = await weiyun.push(cfg, snapshot);
  ok('上传成功', true, `${pushResult.message}　耗时 ${Date.now() - t0} ms`);
} catch (e) {
  ok('上传成功', false, e.message);
}

if (pushResult) {
  const t1 = Date.now();
  let pulled;
  try {
    pulled = await weiyun.pull(cfg);
    ok('下载成功', pulled !== null, `耗时 ${Date.now() - t1} ms`);
  } catch (e) {
    ok('下载成功', false, e.message);
  }

  if (pulled) {
    ok('取回的条目数一致', pulled.items?.length === snapshot.items.length, `${pulled.items?.length} vs ${snapshot.items?.length}`);
    ok('取回的 device 一致', pulled.device?.name === snapshot.device.name);
    const a = JSON.stringify(snapshot, Object.keys(snapshot).sort());
    const b = JSON.stringify(pulled, Object.keys(pulled).sort());
    ok('往返后内容逐字节一致', a === b, a === b ? '' : `长度 ${a.length} vs ${b.length}`);
    if (a !== b) {
      // 指出第一处差异，方便定位
      let i = 0;
      while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
      console.log(`    \x1b[90m首个差异位于第 ${i} 字符：${JSON.stringify(a.slice(Math.max(0, i - 40), i + 40))}\x1b[0m`);
      console.log(`    \x1b[90m对比：${JSON.stringify(b.slice(Math.max(0, i - 40), i + 40))}\x1b[0m`);
    }
    ok('中文内容未损坏', /[\u4e00-\u9fff]/.test(JSON.stringify(pulled)), '含中文字符');
  }
}

/* ------------------------------------------------------------------ 3. 多分块 */

if (TEST_BIG) {
  console.log('\n\x1b[1m三、多分块上传（> 512KB）\x1b[0m');

  // 撑到 700KB 以上，强制走两个分块
  const bigItems = [];
  let size = 0;
  let i = 0;
  while (size < 720000) {
    const filler = '这是一段用于填充体积的测试文本。'.repeat(80) + i;
    bigItems.push({ ...items[i % items.length], id: 'big-' + i, content: filler });
    size += Buffer.byteLength(filler, 'utf8');
    i++;
  }
  const bigSnap = { ...snapshot, exportedAt: Date.now(), items: bigItems };
  const bigJson = JSON.stringify(bigSnap, null, 2);
  const bigBytes = Buffer.byteLength(bigJson, 'utf8');
  const params = wy.computeUploadParams(new TextEncoder().encode(bigJson));

  ok('测试数据已超过 512KB', bigBytes > 524288, `${(bigBytes / 1024).toFixed(0)} KB`);
  ok('该数据会分成 2 个分块', params.blockCount === 2, `${params.blockCount} 块`);
  ok(
    'file_sha 等于整文件标准 SHA1',
    params.fileSha === crypto.createHash('sha1').update(bigJson).digest('hex')
  );

  const bigCfg = { ...cfg, fileName: '_selftest-big.json' };
  const t2 = Date.now();
  let bigPush;
  try {
    bigPush = await weiyun.push(bigCfg, bigSnap);
    ok('多分块上传成功', true, `${bigPush.message}　耗时 ${Date.now() - t2} ms`);
  } catch (e) {
    ok('多分块上传成功', false, e.message);
  }

  if (bigPush) {
    try {
      const back = await weiyun.pull(bigCfg);
      ok('多分块内容完整取回', back?.items?.length === bigSnap.items.length, `${back?.items?.length} vs ${bigSnap.items.length} 条`);
      const same = JSON.stringify(back) === JSON.stringify(bigSnap);
      ok('多分块往返逐字节一致', same, same ? '' : '内容不一致');
    } catch (e) {
      ok('多分块内容完整取回', false, e.message);
    }

    // 清理临时文件（删除文件无需二次确认；删除目录才需要）
    try {
      const f = await weiyun._internal.findFile(cfg, container.key, bigCfg.fileName);
      if (f) {
        await mcpCall(cfg, 'weiyun.delete', {
          file_list: [{ file_id: f.file_id, pdir_key: container.key }],
          delete_completely: true,
        });
        ok('临时测试文件已清理', true, bigCfg.fileName);
      } else {
        ok('临时测试文件已清理', false, '未找到待清理文件');
      }
    } catch (e) {
      ok('临时测试文件已清理', false, e.message);
    }
  }
}

/* ------------------------------------------------------------------ 4. 覆写行为 */

console.log('\n\x1b[1m四、重复上传（覆写而非堆积）\x1b[0m');

try {
  const before = await weiyun._internal.listDir(cfg, { dirKey: container.key, pdirKey: container.key });
  const countBefore = (before.file_list || []).filter((f) => f.filename === FILE_NAME).length;

  await weiyun.push(cfg, { ...snapshot, exportedAt: Date.now() });

  const after = await weiyun._internal.listDir(cfg, { dirKey: container.key, pdirKey: container.key });
  const countAfter = (after.file_list || []).filter((f) => f.filename === FILE_NAME).length;

  ok('再次上传后同名文件仍只有 1 个', countAfter === 1, `上传前 ${countBefore} 个 → 上传后 ${countAfter} 个`);
} catch (e) {
  ok('再次上传后同名文件仍只有 1 个', false, e.message);
}

/* ------------------------------------------------------------------ 结果 */

fs.rmSync(TMP, { recursive: true, force: true });

console.log('\n' + '─'.repeat(56));
if (fail === 0) {
  console.log(`\x1b[32m\x1b[1m微云端到端测试全部通过：${pass} 项\x1b[0m`);
} else {
  console.log(`\x1b[31m\x1b[1m失败 ${fail} 项\x1b[0m，通过 ${pass} 项`);
  for (const f of failures) console.log('  · ' + f);
}
console.log('─'.repeat(56) + '\n');

process.exit(fail === 0 ? 0 : 1);
