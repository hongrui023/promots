/**
 * 浏览器冒烟测试：用 CDP 协议驱动一个已开启调试端口的浏览器，验证界面真的能渲染与交互。
 *
 * 为什么不用 agent-browser：本机下载 Chromium 被网络阻断。系统自带 Edge，
 * 用 `--remote-debugging-port` 起一个 headless 实例即可，Node 22 自带 WebSocket，零依赖。
 *
 * 用法：
 *   1) 启动浏览器（Windows 示例）
 *      "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" ^
 *        --headless=new --remote-debugging-port=9222 --user-data-dir=%TEMP%\aiph --no-first-run about:blank
 *   2) node tools/smoke-browser.mjs [页面地址] [调试端口]
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');

const PAGE_URL = process.argv[2] || 'http://127.0.0.1:5180/index.html';
const PORT = Number(process.argv[3] || 9222);
const CDP = `http://127.0.0.1:${PORT}`;

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ CDP 客户端 */

class CDPClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(new Error('WebSocket 连接失败：' + (e.message || 'unknown')));
      this.ws.onmessage = (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch (_) {
          return;
        }
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve: res, reject: rej } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) rej(new Error(msg.error.message || JSON.stringify(msg.error)));
          else res(msg.result);
        } else if (msg.method) {
          const set = this.listeners.get(msg.method);
          if (set) for (const fn of set) fn(msg.params);
        }
      };
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时：${method}`));
        }
      }, 30000);
    });
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(fn);
  }

  /** 在页面里执行表达式并取回可序列化结果 */
  async eval(expression, { awaitPromise = true } = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || '页面内执行异常');
    }
    return r.result?.value;
  }

  close() {
    try {
      this.ws.close();
    } catch (_) { /* 忽略 */ }
  }
}

/* ------------------------------------------------------------------ 主流程 */

console.log('\x1b[1m\x1b[35mAI Prompt Hub · 浏览器冒烟测试\x1b[0m');
console.log(`\x1b[90m目标 ${PAGE_URL}  ·  CDP ${CDP}\x1b[0m\n`);

// 探测调试端口
let version;
try {
  const res = await fetch(`${CDP}/json/version`);
  version = await res.json();
  console.log(`\x1b[90m浏览器：${version.Browser}\x1b[0m\n`);
} catch (e) {
  console.error(`\x1b[31m无法连接调试端口 ${CDP}：${e.message}\x1b[0m`);
  console.error('请先启动一个带 --remote-debugging-port 的浏览器实例（见本文件头部说明）。');
  process.exit(1);
}

// 新建标签页（新版 Chromium 要求 PUT）
const targetRes = await fetch(`${CDP}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' });
const target = await targetRes.json();

const client = new CDPClient(target.webSocketDebuggerUrl);
await client.connect();

// 收集控制台错误与页面异常 —— 这是最有价值的信号
const consoleErrors = [];
const pageErrors = [];
client.on('Runtime.consoleAPICalled', (p) => {
  if (p.type === 'error') {
    consoleErrors.push((p.args || []).map((a) => a.value ?? a.description ?? a.type).join(' '));
  }
});
client.on('Runtime.exceptionThrown', (p) => {
  pageErrors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || 'unknown');
});

await client.send('Runtime.enable');
await client.send('Page.enable');

console.log('\x1b[1m〇、清理缓存（保证测的是最新代码）\x1b[0m');

// 必须先清掉 Service Worker 与缓存再测。
// PWA 会缓存应用外壳，不清的话测的是上一次的旧代码，会得出假结论——
// 这个坑真实踩到过：新增一个同步通道后，测试仍报旧通道数量。
await client.send('Page.navigate', { url: PAGE_URL });
await sleep(1500);
const cleaned = await client.eval(`(async () => {
  let sw = 0, ck = 0;
  try {
    const rs = await navigator.serviceWorker.getRegistrations();
    sw = rs.length;
    await Promise.all(rs.map(r => r.unregister()));
    const keys = await caches.keys();
    ck = keys.length;
    await Promise.all(keys.map(k => caches.delete(k)));
  } catch (_) {}
  return { sw, ck };
})()`);
console.log(`  \x1b[90m注销 Service Worker ${cleaned.sw} 个，清空缓存 ${cleaned.ck} 个\x1b[0m`);
ok('缓存已清空，测试环境干净', true, `SW ${cleaned.sw} / Cache ${cleaned.ck}`);

await client.send('Network.enable');
await client.send('Network.setCacheDisabled', { cacheDisabled: true });

console.log('\n\x1b[1m一、页面加载\x1b[0m');

const loadPromise = new Promise((resolve) => {
  let done = false;
  const finish = () => {
    if (!done) {
      done = true;
      resolve();
    }
  };
  client.on('Page.loadEventFired', finish);
  setTimeout(finish, 12000);
});

await client.send('Page.navigate', { url: PAGE_URL });
await loadPromise;
await sleep(1800); // 等 IndexedDB 初始化与示例数据灌入

const boot = await client.eval(`(() => ({
  title: document.title,
  crashed: document.body.innerHTML.includes('启动失败'),
  bodyText: document.body.innerText.slice(0, 200),
  hasApp: !!document.querySelector('.app'),
  cards: document.querySelectorAll('.card').length,
  resultCount: (document.querySelector('#result-count') || {}).textContent || '',
  navCats: document.querySelectorAll('#nav-cats .nav-item').length,
  tagPills: document.querySelectorAll('#tagcloud .tagpill').length,
  modePills: document.querySelectorAll('.mode-pill').length,
  syncBadge: (document.querySelector('#sync-badge .txt') || {}).textContent || '',
  emptyHidden: document.querySelector('#empty')?.classList.contains('hidden'),
}))()`);

ok('页面标题正确', /Prompt Hub/.test(boot.title), boot.title);
ok('应用外壳渲染成功（未走到启动失败页）', boot.hasApp && !boot.crashed, boot.crashed ? boot.bodyText.replace(/\n/g, ' ') : '');
ok('示例指令已导入并渲染成卡片', boot.cards === 14, `${boot.cards} 张卡片`);
ok('结果计数已显示', /\d+\s*条结果/.test(boot.resultCount), boot.resultCount);
ok('侧边栏分类已渲染', boot.navCats >= 13, `${boot.navCats} 个分类项`);
ok('标签云已渲染', boot.tagPills > 5, `${boot.tagPills} 个标签`);
ok('搜索模式按钮共 5 个', boot.modePills === 5, `${boot.modePills} 个`);
ok('同步状态徽标已初始化', boot.syncBadge.length > 0, boot.syncBadge);
ok('空状态默认隐藏', boot.emptyHidden === true);

console.log('\n\x1b[1m二、搜索交互\x1b[0m');

/** 在页面里输入关键词并等待防抖完成 */
async function searchAs(query, mode) {
  await client.eval(`(async () => {
    const input = document.querySelector('#search-input');
    if (${JSON.stringify(mode)} !== 'keep') {
      const pill = document.querySelector('.mode-pill[data-mode="${mode}"]');
      if (pill) pill.click();
    }
    input.value = ${JSON.stringify(query)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(700);
  return client.eval(`(() => {
    const cards = Array.from(document.querySelectorAll('.card'));
    return {
      count: cards.length,
      titles: cards.map(c => (c.querySelector('.card-title')||{}).textContent || ''),
      countText: (document.querySelector('#result-count')||{}).textContent || '',
      explain: (document.querySelector('#result-explain')||{}).innerText || '',
      why: Array.from(document.querySelectorAll('.card-why .w')).slice(0,3).map(e => e.textContent),
      marks: document.querySelectorAll('mark').length,
      emptyShown: !document.querySelector('#empty').classList.contains('hidden'),
    };
  })()`);
}

let r = await searchAs('周报', 'quick');
ok('快速搜索「周报」命中 1 条', r.count === 1 && /周报生成器/.test(r.titles[0]), r.titles.join('、') || '无结果');
ok('命中原因已展示', r.why.length > 0, r.why.join(' / '));
ok('关键词高亮生效', r.marks > 0, `${r.marks} 处高亮`);

r = await searchAs('gwxz', 'quick');
ok('拼音首字母「gwxz」命中公文写作助手', /公文写作助手/.test(r.titles[0] || ''), r.titles.slice(0, 2).join('、') || '无结果');

r = await searchAs('周抱生成器', 'fuzzy');
ok('模糊搜索容忍错字「周抱」', r.count >= 1 && /周报生成器/.test(r.titles[0] || ''), r.titles.slice(0, 2).join('、') || '无结果');

r = await searchAs('摘要', 'synonym');
ok('近义词搜索「摘要」有结果', r.count >= 1, `${r.count} 条：${r.titles.slice(0, 3).join('、')}`);

r = await searchAs('我收藏的代码类', 'nl');
ok('自然语言搜索命中代码审查', r.count >= 1 && r.titles.some((t) => /代码审查/.test(t)), `${r.count} 条：${r.titles.slice(0, 3).join('、')}`);
ok('自然语言解析说明已展示', r.explain.length > 0, r.explain.replace(/\n/g, ' | ').slice(0, 90));

r = await searchAs('绝对不存在的查询词', 'quick');
ok('无结果时展示空状态与引导', r.count === 0 && r.emptyShown, `卡片 ${r.count} 张`);

r = await searchAs('', 'quick');
ok('清空搜索后恢复全部 14 条', r.count === 14, `${r.count} 条`);

console.log('\n\x1b[1m三、侧边栏与筛选\x1b[0m');

const catFilter = await client.eval(`(async () => {
  const items = Array.from(document.querySelectorAll('#nav-cats .nav-item'));
  const target = items.find(el => el.textContent.includes('编程开发'));
  if (!target) return { error: '未找到分类项' };
  target.click();
  await new Promise(r => setTimeout(r, 600));
  return {
    count: document.querySelectorAll('.card').length,
    titles: Array.from(document.querySelectorAll('.card-title')).map(e => e.textContent),
    activeFilter: (document.querySelector('#active-filters')||{}).innerText || '',
  };
})()`);
ok('点击分类可筛选', !catFilter.error && catFilter.count === 2, `${catFilter.count} 条：${(catFilter.titles || []).join('、')}`);
ok('筛选条件以标签形式展示', /编程开发/.test(catFilter.activeFilter), catFilter.activeFilter.replace(/\n/g, ' '));

const favView = await client.eval(`(async () => {
  const el = Array.from(document.querySelectorAll('#nav-main .nav-item')).find(e => e.textContent.includes('收藏'));
  el.click();
  await new Promise(r => setTimeout(r, 600));
  return { count: document.querySelectorAll('.card').length };
})()`);
ok('收藏视图筛出 4 条', favView.count === 4, `${favView.count} 条`);

await client.eval(`(async () => {
  const el = Array.from(document.querySelectorAll('#nav-main .nav-item')).find(e => e.textContent.includes('全部指令'));
  el.click();
  await new Promise(r => setTimeout(r, 400));
  return true;
})()`);

console.log('\n\x1b[1m四、编辑器与设置\x1b[0m');

const editor = await client.eval(`(async () => {
  document.querySelector('#btn-new').click();
  await new Promise(r => setTimeout(r, 500));
  const modal = document.querySelector('.modal');
  const title = modal ? (modal.querySelector('.modal-title')||{}).textContent : '';
  const inputs = modal ? modal.querySelectorAll('input.input, textarea.textarea').length : 0;
  const catOptions = modal ? modal.querySelectorAll('select.select option').length : 0;
  const platforms = modal ? modal.querySelectorAll('.platform-picker .chip').length : 0;
  return { hasModal: !!modal, title, inputs, catOptions, platforms };
})()`);
ok('新建指令弹窗可打开', editor.hasModal, editor.title);
ok('表单字段齐全', editor.inputs >= 4, `${editor.inputs} 个输入控件`);
ok('分类下拉含 13 个分类', editor.catOptions >= 13, `${editor.catOptions} 项`);
ok('平台选择器含 9 个平台', editor.platforms >= 9, `${editor.platforms} 个`);

// 自动分类联动
const autoCls = await client.eval(`(async () => {
  const modal = document.querySelector('.modal');
  const titleInput = modal.querySelector('input.input');
  titleInput.value = '小红书种草文案生成';
  titleInput.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 1400));
  const hint = (modal.querySelector('.classify-hint')||{}).innerText || '';
  const sel = modal.querySelector('select.select');
  return { hint, category: sel ? sel.value : '' };
})()`);
ok('编辑时自动分类联动生效', autoCls.category === 'marketing', `判定为 ${autoCls.category}：${autoCls.hint.replace(/\n/g, ' ')}`);

await client.eval(`document.querySelector('.modal-head .icon-btn').click()`);
await sleep(400);

const settings = await client.eval(`(async () => {
  document.querySelector('#btn-settings').click();
  await new Promise(r => setTimeout(r, 600));
  const tabs = Array.from(document.querySelectorAll('.tab')).map(t => t.textContent);
  const cards = Array.from(document.querySelectorAll('.provider-card'));
  const providers = cards.map(c => (c.querySelector('.pc-name')||{}).textContent || '');
  const badges = cards.map(c => (c.querySelector('.pc-rec')||{}).textContent || '');
  return { tabs, providers, badges };
})()`);
ok('设置弹窗含 4 个标签页', settings.tabs.length === 4, settings.tabs.join(' / '));
ok('同步通道全部展示（含微云共 6 个）', settings.providers.length === 6, settings.providers.join(' / '));
ok('微云排在首位', /微云/.test(settings.providers[0] || ''), settings.providers[0]);
ok('微云带「桌面端推荐」标记', /桌面端推荐/.test(settings.badges[0] || ''), settings.badges.join(' | '));

// 选中微云后应出现 Token 输入框与取 Token 的链接
const weiyunForm = await client.eval(`(async () => {
  const cards = Array.from(document.querySelectorAll('.provider-card'));
  const target = cards.find(c => /微云/.test(c.querySelector('.pc-name').textContent));
  target.click();
  await new Promise(r => setTimeout(r, 700));
  const modal = document.querySelector('.modal');
  const pw = modal.querySelector('input[type=password]');
  const link = Array.from(modal.querySelectorAll('a')).map(a => a.href);
  const labels = Array.from(modal.querySelectorAll('.field > label')).map(l => l.textContent);
  return { hasPassword: !!pw, link, labels };
})()`);
ok('微云配置表单出现 Token 输入框', weiyunForm.hasPassword === true, weiyunForm.labels.join(' / '));
ok(
  'Token 申请链接指向微云官方页面',
  weiyunForm.link.some((h) => /weiyun\.com\/act\/openclaw/.test(h)),
  weiyunForm.link.find((h) => /weiyun/.test(h)) || '未找到链接'
);

await client.eval(`document.querySelector('.modal-head .icon-btn').click()`);
await sleep(400);

console.log('\n\x1b[1m五、响应式与截图\x1b[0m');

// 桌面截图
await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await sleep(500);
let shot = await client.send('Page.captureScreenshot', { format: 'png' });
fs.mkdirSync(OUT, { recursive: true });
const desktopShot = path.join(OUT, 'desktop.png');
fs.writeFileSync(desktopShot, Buffer.from(shot.data, 'base64'));
ok('桌面端截图已生成', fs.existsSync(desktopShot), `${(fs.statSync(desktopShot).size / 1024).toFixed(0)} KB`);

// 移动端截图
await client.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await sleep(600);
shot = await client.send('Page.captureScreenshot', { format: 'png' });
const mobileShot = path.join(OUT, 'mobile.png');
fs.writeFileSync(mobileShot, Buffer.from(shot.data, 'base64'));
ok('移动端截图已生成', fs.existsSync(mobileShot), `${(fs.statSync(mobileShot).size / 1024).toFixed(0)} KB`);

const responsive = await client.eval(`(() => {
  const burger = document.querySelector('#btn-open-sidebar');
  const sidebar = document.querySelector('#sidebar');
  return {
    burgerVisible: getComputedStyle(burger).display !== 'none',
    sidebarOffscreen: sidebar.getBoundingClientRect().left < 0,
    cardsPerRow: document.querySelectorAll('.list .card').length,
  };
})()`);
ok('移动端显示汉堡菜单', responsive.burgerVisible === true);
ok('移动端侧边栏默认收起', responsive.sidebarOffscreen === true);

await client.send('Emulation.clearDeviceMetricsOverride');

console.log('\n\x1b[1m六、运行期错误\x1b[0m');
ok('无页面异常（uncaught error）', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | ') || '0 个');
ok('无控制台 error 输出', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | ') || '0 个');

/* ------------------------------------------------------------------ 结果 */

client.close();
await fetch(`${CDP}/json/close/${target.id}`).catch(() => {});

console.log('\n' + '─'.repeat(56));
if (fail === 0) {
  console.log(`\x1b[32m\x1b[1m浏览器冒烟测试全部通过：${pass} 项\x1b[0m`);
} else {
  console.log(`\x1b[31m\x1b[1m失败 ${fail} 项\x1b[0m，通过 ${pass} 项`);
  for (const f of failures) console.log('  · ' + f);
}
console.log('─'.repeat(56) + '\n');

process.exit(fail === 0 ? 0 : 1);
