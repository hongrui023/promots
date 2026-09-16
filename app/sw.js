/**
 * Service Worker —— 让应用可以离线打开
 *
 * 策略：**同源 GET 一律网络优先，失败回落缓存**
 *
 * 为什么不用「缓存优先」：
 *   缓存优先对内容型站点是对的（首屏快），但对这个应用是错的——
 *   它更新频繁，而缓存优先意味着更新后用户要刷新两次才看到新代码，
 *   而且是静默的：用户不知道自己看到的是旧版本。这个坑在开发过程中真实踩到过。
 *   网络优先在本应用没有代价：数据文件与 API 请求都不走这里，
 *   外壳文件要么来自本地 127.0.0.1（极快），要么来自静态托管（有 HTTP 缓存兜底）。
 *
 * 跨域请求（微云 MCP / GitHub API / 大模型接口 / 网盘接口）完全不拦截，交给网络，
 * 避免缓存住鉴权失败之类的脏响应。
 */

const VERSION = 'v1.2.0';
const SHELL_CACHE = `aiph-shell-${VERSION}`;

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.svg',
  './icon-maskable.svg',
  './oauth-callback.html',
  './css/app.css',
  './js/main.js',
  './js/ui.js',
  './js/store.js',
  './js/search.js',
  './js/classify.js',
  './js/synonyms.js',
  './js/pinyin.js',
  './js/pinyin-data.js',
  './js/hash.js',
  './js/llm.js',
  './js/importer.js',
  './js/bulk-import.js',
  './js/seed.js',
  './js/sync/http.js',
  './js/sync/weiyun.js',
  './js/sync/manager.js',
  './js/sync/adapters.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) =>
        // 单个资源失败不应让整个安装失败
        Promise.all(SHELL.map((url) => cache.add(url).catch(() => null)))
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 跨域一律放行，不缓存

  event.respondWith(
    fetch(req)
      .then((res) => {
        // 只缓存完整的同源 200 响应，避免把错误页写进缓存
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(async () => {
        const cached = await caches.match(req);
        if (cached) return cached;
        // 离线时导航请求统一回落到外壳
        if (req.mode === 'navigate') {
          const shell = await caches.match('./index.html');
          if (shell) return shell;
        }
        return new Response('离线且无缓存', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      })
  );
});
