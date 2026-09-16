# 构建与部署

本文件覆盖三件事：怎么跑起来、怎么打 Windows 安装包、怎么出 Android 应用。

---

## 一、运行环境要求

| 用途 | 需要装什么 |
|---|---|
| 网页端预览 / PWA | **只要 Node.js 18+**（不需要 npm install） |
| 打 Windows 桌面端 | Node.js 18+。electron-builder 会自动下载所需工具链 |
| 打 Android APK | Node.js 18+、JDK 17、Android SDK（含 build-tools 与 platform 34） |

---

## 二、网页端 / PWA

```bash
npm run serve
```

默认监听 `http://127.0.0.1:5180`。换端口：

```bash
PORT=8080 npm run serve
# Windows PowerShell: $env:PORT=8080; npm run serve
```

`tools/serve.js` 只用了 Node 内置的 `http` / `fs` / `path`，所以**不需要 `npm install`** 就能跑。

> **不要用 `file://` 直接打开 `app/index.html`。**
> `file://` 属于非安全上下文，会禁用剪贴板 API、Service Worker 和部分存储能力，应用会直接报「启动失败」。

### 部署到静态托管

`app/` 目录本身就是一个完整的静态站点，整目录上传即可：

- **GitHub Pages**：仓库 Settings → Pages → Source 选 `main` 分支 `/app` 目录
- **Vercel / Netlify / Cloudflare Pages**：把 Publish directory 设为 `app`
- 任意对象存储 + CDN：把 `app/` 下的文件按原目录结构上传

托管到 `https://` 之后，Android Chrome 打开网址 → 菜单 → 「添加到主屏幕」，就是一个可以离线用的类原生应用。

### 启用 PWA 的注意事项

`app/manifest.webmanifest` 里的 `start_url` 是相对路径（`./index.html`），所以放在任意子目录都能正常工作。

Service Worker 会缓存应用外壳（HTML/CSS/JS/图标）。**跨域请求一律不拦截**——GitHub API、大模型接口、网盘接口都交给网络，避免缓存脏数据。

更新应用后如果发现浏览器还在用旧版本，强制刷新一次（`Ctrl + Shift + R`）即可；SW 会在后台拉取新版本。

---

## 三、Windows 桌面端

### 开发模式

```bash
npm run desktop:install   # 首次执行，安装 electron 与 electron-builder
npm run desktop:dev
```

### 打包

```bash
npm run desktop:build           # NSIS 安装包 + 便携版，都在 x64
cd desktop && npm run build:win:portable   # 只要便携版
cd desktop && npm run build:dir            # 只解包不打包，便于调试
```

产物在 `desktop/dist/`：

- `AI-Prompt-Hub-1.0.0-x64.exe` —— 安装包，可选安装目录
- `AI-Prompt-Hub-1.0.0-便携版.exe` —— 免安装，双击即用

### 构建产物下载慢怎么办

electron 的二进制默认从 GitHub Releases 拉取，国内可能很慢或失败。设置镜像后重试：

```bash
# Windows PowerShell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
npm run desktop:build
```

### 桌面端的两个设计要点

**1. 用内置 HTTP 服务加载，而不是 `file://`**

`desktop/main.js` 在启动时于 `127.0.0.1` 起一个静态服务，再用 `loadURL` 打开。原因是 `file://` 是非安全上下文，会禁用剪贴板 API、Service Worker 和 IndexedDB 的完整能力——而剪贴板正是这个应用的核心。

**2. 固定 5180 端口**

百度网盘 OAuth 的回调地址必须在开放平台预先登记，端口不能变，所以桌面端优先占用 5180。如果这个端口被占用（比如你同时开着 `npm run serve`），会自动换随机端口并在控制台警告——此时百度网盘通道的回调地址就对不上了，要么关掉 `npm run serve`，要么去开放平台改登记的地址。

### 跨域处理

主进程通过 `session.webRequest.onHeadersReceived` 给所有响应补上 `Access-Control-Allow-Origin` 等头。桌面端是可信的本地环境，这样做让渲染层可以直接调用 GitHub API、各大大模型接口、WebDAV 和百度网盘接口，不必为每个服务单独写代理。

同时 `preload.js` 通过 IPC 暴露了一组受限的原生能力（HTTP 转发、文件读写、目录选择、打开外部链接），`contextIsolation` 保持开启，渲染层拿不到 Node。

---

## 四、Android

### 方式 A：PWA（推荐先这样）

1. 把 `app/` 部署到任意 HTTPS 托管（见上文）；
2. Android Chrome 打开该网址；
3. 菜单 →「添加到主屏幕」→ 确认。

得到的图标支持全屏、离线启动，和原生应用的使用感受差别很小。缺点：不能访问文件系统，所以「本地同步文件夹」通道不可用（用 Gist / WebDAV / 百度网盘代替）。

### 方式 B：Capacitor 打成 APK

需要先装好 JDK 17 与 Android SDK，并设置 `ANDROID_HOME` 环境变量。

```bash
# 1) 在项目根目录初始化 Capacitor
npm install @capacitor/core @capacitor/cli @capacitor/android --save-dev
npx cap init "AI Prompt Hub" com.hongrui023.aiprompthub --web-dir=app

# 2) 添加 Android 平台
npx cap add android

# 3) 每次改完 app/ 下的代码后同步一次
npx cap sync android

# 4) 打开 Android Studio 构建，或直接用命令行
cd android
./gradlew assembleDebug        # Windows: gradlew.bat assembleDebug
```

产物：`android/app/build/outputs/apk/debug/app-debug.apk`，传到手机安装即可（需要在系统里允许「安装未知来源应用」）。

打包正式版（需要签名密钥）：

```bash
cd android
./gradlew assembleRelease
```

### Android 端的已知限制

| 能力 | 状态 | 说明 |
|---|---|---|
| 五项同步通道 | Gist / WebDAV / 百度网盘 / 手动 | 「本地同步文件夹」不可用 |
| 百度网盘上传 | ⚠️ 可能失败 | `d.pcs.baidu.com` 的跨域策略会拦截，建议改用 Gist |
| 剪贴板 | ✅ | Android 需要 HTTPS 或 localhost 环境 |
| 离线使用 | ✅ | 通过 Service Worker 缓存 |
| 数据存储 | ✅ | WebView 的 IndexedDB，随应用卸载而清除（记得先同步） |

> **卸载应用会连同本地数据一起清掉。** 卸载前先同步一次，或用「设置 → 数据 → 导出全部为 JSON」备份。

---

## 五、自检

改完核心算法后务必跑一遍：

```bash
node tools/verify.mjs
```

覆盖：全部模块语法、拼音检索、近义词扩展、自动分类（13 个用例）、四种搜索模式、过滤器、排序、边界情况、同步适配器注册。当前 **66 项全部通过**。

调试某条指令的分类打分明细：

```bash
node tools/debug-classify.mjs "小红书种草文案"
```

会打印各分类的得分、胜出分类、置信度，以及命中的关键词证据。

---

## 六、重新生成拼音表（一般不需要）

`app/js/pinyin-data.js` 是**生成产物，已提交进仓库**，正常使用不需要动它。只有你想调整覆盖范围时才需要重新生成：

```bash
npm install          # 安装 pinyin-pro（唯一的 devDependency）
npm run gen:pinyin
```

输出：20992 个汉字的首字母 + 1953 个多音字的全部读法，约 31 KB。
