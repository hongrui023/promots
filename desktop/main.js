/**
 * AI Prompt Hub 桌面端主进程
 *
 * 两件事决定了这个文件的存在：
 *
 * 1. 用内置 HTTP 服务加载应用，而不是 file://
 *    file:// 属于非安全上下文，会禁用剪贴板 API、Service Worker 和部分存储能力。
 *    127.0.0.1 是浏览器认可的安全上下文，所有 Web 能力都能正常用。
 *
 * 2. 固定端口 5180
 *    百度网盘 OAuth 的回调地址必须在开放平台预先登记，端口不能变。
 *    所以这里优先占 5180；若被占用（比如你同时开着 npm run serve）则自动换端口并在日志里提示。
 *
 * 另外，主进程通过注入 CORS 响应头，让渲染层的 fetch 可以直接访问 GitHub API、
 * 各大大模型接口、WebDAV 和百度网盘接口，避免网页端常见的跨域失败。
 */

'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const http = require('http');

const PREFERRED_PORT = 5180;
const isDev = !app.isPackaged;

/** 应用资源根目录：开发时在 ../app，打包后在 resources/app */
function resolveAppRoot() {
  if (isDev) return path.resolve(__dirname, '..', 'app');
  return path.join(process.resourcesPath, 'app');
}

/* ------------------------------------------------------------------ 静态服务 */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

let serverPort = null;

function startStaticServer(root, port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let urlPath;
      try {
        urlPath = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
      } catch (_) {
        res.writeHead(400).end('Bad Request');
        return;
      }
      if (urlPath === '/') urlPath = '/index.html';
      const filePath = path.join(root, urlPath);
      if (!filePath.startsWith(root)) {
        res.writeHead(403).end('Forbidden');
        return;
      }
      fs.stat(filePath, (err, stat) => {
        if (err || !stat.isFile()) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404');
          return;
        }
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
          'Cache-Control': 'no-cache',
        });
        fs.createReadStream(filePath).pipe(res);
      });
    });

    server.on('error', (e) => {
      if (e.code === 'EADDRINUSE' && port === PREFERRED_PORT) {
        console.warn(`[server] 端口 ${PREFERRED_PORT} 被占用，改用随机端口。注意：这会影响百度网盘 OAuth 回调地址的匹配。`);
        startStaticServer(root, 0).then(resolve, reject);
      } else {
        reject(e);
      }
    });

    server.listen(port, '127.0.0.1', () => {
      serverPort = server.address().port;
      console.log(`[server] http://127.0.0.1:${serverPort} → ${root}`);
      resolve(server);
    });
  });
}

/* ------------------------------------------------------------------ 窗口 */

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 420,
    minHeight: 520,
    show: false,
    backgroundColor: '#f5f6f8',
    title: 'AI Prompt Hub',
    icon: path.join(resolveAppRoot(), 'icon.svg'),
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${serverPort}/index.html`);

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // 外部链接用系统浏览器打开，不要在应用内跳走
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url) && !url.includes('127.0.0.1')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

/* ------------------------------------------------------------------ CORS 放行 */

/**
 * 把跨域响应头补上。桌面端是可信环境，这样做可以：
 *   - 让渲染层直接 fetch 各平台开放接口
 *   - 避免预检请求（OPTIONS）因服务端不支持而失败
 */
function installCorsBypass() {
  const { session } = require('electron');
  const filter = { urls: ['*://*/*'] };
  session.defaultSession.webRequest.onHeadersReceived({ urls: ['*://*/*'] }, (details, callback) => {
    const headers = Object.assign({}, details.responseHeaders);
    const set = (key, value) => {
      for (const k of Object.keys(headers)) {
        if (k.toLowerCase() === key.toLowerCase()) delete headers[k];
      }
      headers[key] = [value];
    };
    set('Access-Control-Allow-Origin', '*');
    set('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS,MKCOL,PROPFIND');
    set('Access-Control-Allow-Headers', '*');
    set('Access-Control-Expose-Headers', '*');
    callback({ responseHeaders: headers });
  });
  void filter;
}

/* ------------------------------------------------------------------ IPC */

function installIpc() {
  // 通用 HTTP 转发（渲染层在需要时可用它绕开浏览器限制）
  ipcMain.handle('aiph:http', async (_e, opts) => {
    const { url, method = 'GET', headers = {}, body = null, timeout = 30000 } = opts || {};
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url, { method, headers, body, signal: controller.signal });
      const text = await res.text();
      return {
        status: res.status,
        body: text,
        headers: Object.fromEntries(res.headers.entries()),
      };
    } finally {
      clearTimeout(timer);
    }
  });

  ipcMain.handle('aiph:fs-read', async (_e, filePath) => {
    try {
      const content = await fsp.readFile(filePath, 'utf8');
      return { exists: true, content };
    } catch (e) {
      if (e.code === 'ENOENT') return { exists: false, content: null };
      throw e;
    }
  });

  ipcMain.handle('aiph:fs-write', async (_e, filePath, content) => {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    // 先写临时文件再改名，避免同步过程中途崩掉留下半个文件
    const tmp = filePath + '.tmp';
    await fsp.writeFile(tmp, content, 'utf8');
    await fsp.rename(tmp, filePath);
    return { ok: true, path: filePath };
  });

  ipcMain.handle('aiph:fs-stat', async (_e, target) => {
    try {
      const st = await fsp.stat(target);
      return { exists: true, isDirectory: st.isDirectory(), size: st.size, mtime: st.mtimeMs };
    } catch (e) {
      if (e.code === 'ENOENT') return { exists: false, isDirectory: false };
      throw e;
    }
  });

  ipcMain.handle('aiph:pick-directory', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择同步目录',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: '选择此文件夹',
    });
    if (r.canceled || !r.filePaths.length) return { path: null };
    return { path: r.filePaths[0] };
  });

  ipcMain.handle('aiph:open-external', async (_e, url) => {
    await shell.openExternal(url);
    return { ok: true };
  });

  ipcMain.handle('aiph:app-info', async () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    port: serverPort,
    userData: app.getPath('userData'),
    appRoot: resolveAppRoot(),
  }));
}

/* ------------------------------------------------------------------ 菜单 */

function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        { label: '新建指令', accelerator: 'CmdOrCtrl+N', click: () => mainWindow?.webContents.send('aiph:menu', 'new') },
        { label: '批量导入…', accelerator: 'CmdOrCtrl+Shift+N', click: () => mainWindow?.webContents.send('aiph:menu', 'bulk') },
        { type: 'separator' },
        { label: '导入 JSON…', click: () => mainWindow?.webContents.send('aiph:menu', 'import') },
        { label: '导出 JSON…', click: () => mainWindow?.webContents.send('aiph:menu', 'export') },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'forceReload', label: '强制重新加载' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
        { role: 'toggleDevTools', label: '开发者工具' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '打开数据目录',
          click: () => shell.openPath(app.getPath('userData')),
        },
        {
          label: '项目主页（GitHub）',
          click: () => shell.openExternal('https://github.com/hongrui023/ai-prompt-hub'),
        },
        {
          label: '关于',
          click: () =>
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: '关于',
              message: 'AI Prompt Hub',
              detail:
                `版本 ${app.getVersion()}\n` +
                `Electron ${process.versions.electron} / Chromium ${process.versions.chrome}\n` +
                `本地服务端口 ${serverPort}\n\n` +
                '本地优先的 AI 指令管理中心。数据保存在本机，同步到你自己的网盘或 Gist。',
              buttons: ['好'],
            }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ------------------------------------------------------------------ 启动 */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    nativeTheme.themeSource = 'light';
    installCorsBypass();

    const root = resolveAppRoot();
    if (!fs.existsSync(path.join(root, 'index.html'))) {
      dialog.showErrorBox('资源缺失', `找不到应用文件：${root}\n请确认 app 目录完整。`);
      app.quit();
      return;
    }

    try {
      await startStaticServer(root, PREFERRED_PORT);
    } catch (e) {
      dialog.showErrorBox('启动失败', '无法启动本地服务：' + e.message);
      app.quit();
      return;
    }

    installIpc();
    buildMenu();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
