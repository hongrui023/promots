/**
 * Service Worker —— 让应用可以离线打开
 *
 * 策略
 *   - 应用外壳（HTML/CSS/JS/图标）：预缓存 + 后台更新
 *   - 其他同源 GET 请求：缓存优先，失败回落网络
 *   - 跨域请求（GitHub API / 大模型接口 / 网盘接口）：完全不拦截，交给网络，避免缓存脏数据
 */

const VERSION = 'v1.0.0';
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
  './js/llm.js',
  './js/seed.js',
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
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone();
            caches.open(SHELL_CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
