/**
 * 同步通道适配器集合
 *
 * 统一接口（每个 adapter 都要实现）
 *   key         唯一标识
 *   name        显示名
 *   desc        说明
 *   fields      设置项描述，UI 据此渲染表单
 *   available() 当前运行环境是否支持（如 File System Access API 在 Android Chrome 不可用）
 *   test(cfg)   连通性自检
 *   pull(cfg)   取回远端快照对象，无数据返回 null
 *   push(cfg, snapshot) 写入远端
 *
 * 快照就是 store.snapshot() 的产物：{schema, exportedAt, device, items[]}
 */

import { describeError, httpJson, httpRequest, isDesktop } from './http.js';
import { weiyun } from './weiyun.js';

// 供 sync/manager.js 沿用原有导入路径
export { describeError };

/* ------------------------------------------------------------------ 通用 */

/** 兼容旧调用名：请求实现已统一到 http.js */
const httpRaw = httpRequest;

/* ------------------------------------------------------------------ 1. 本地同步文件夹 */

export const localFolder = {
  key: 'localfolder',
  name: '本地同步文件夹',
  desc: '把数据文件放进网盘客户端的同步目录（微云同步助手 / 百度网盘同步空间 / OneDrive），由客户端负责跨设备同步。Windows 端推荐。',
  fields: [
    { key: 'mode', label: '目录选择方式', type: 'select', options: [
      { value: 'picker', label: '浏览器目录选择器（推荐）' },
      { value: 'manual', label: '手动填写绝对路径（桌面端）' },
    ], default: 'picker' },
    { key: 'dirPath', label: '绝对路径', type: 'text', placeholder: '例如 D:\\微云同步助手\\AI-PromptHub', hint: '仅桌面端 + 手动模式需要' },
    { key: 'fileName', label: '数据文件名', type: 'text', default: 'ai-prompt-hub.json' },
  ],

  available() {
    if (isDesktop()) return true;
    return typeof globalThis.showDirectoryPicker === 'function';
  },

  unavailableReason() {
    if (isDesktop()) return '';
    if (typeof globalThis.showDirectoryPicker !== 'function') {
      return '当前浏览器不支持目录选择（Android Chrome 已移除该能力）。请改用 GitHub Gist、WebDAV 或百度网盘通道。';
    }
    return '';
  },

  /** 弹出目录选择器，返回可持久化的句柄信息 */
  async chooseDirectory() {
    if (isDesktop()) {
      const r = await globalThis.__aiph.pickDirectory();
      if (!r || !r.path) throw new Error('未选择目录');
      return { mode: 'manual', dirPath: r.path };
    }
    if (typeof globalThis.showDirectoryPicker !== 'function') {
      throw new Error(this.unavailableReason());
    }
    const handle = await globalThis.showDirectoryPicker({ mode: 'readwrite', id: 'aiph-sync' });
    // 句柄可结构化克隆，存 IndexedDB 即可跨会话复用
    await putHandle('sync-localfolder-dir', handle);
    return { mode: 'picker' };
  },

  async _getHandle(cfg) {
    if (cfg.mode === 'manual' || isDesktop()) return null;
    const h = await getHandle('sync-localfolder-dir');
    if (!h) throw new Error('尚未选择同步目录，请点「选择目录」');
    let perm = await h.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') perm = await h.requestPermission({ mode: 'readwrite' });
    if (perm !== 'granted') throw new Error('未获得目录读写权限');
    return h;
  },

  async _readText(cfg) {
    const name = cfg.fileName || 'ai-prompt-hub.json';
    if (isDesktop()) {
      const r = await globalThis.__aiph.fsRead(joinPath(cfg.dirPath, name));
      return r && r.exists ? r.content : null;
    }
    const dir = await this._getHandle(cfg);
    try {
      const fh = await dir.getFileHandle(name);
      const f = await fh.getFile();
      return await f.text();
    } catch (e) {
      if (e.name === 'NotFoundError') return null;
      throw e;
    }
  },

  async _writeText(cfg, text) {
    const name = cfg.fileName || 'ai-prompt-hub.json';
    if (isDesktop()) {
      await globalThis.__aiph.fsWrite(joinPath(cfg.dirPath, name), text);
      return { path: joinPath(cfg.dirPath, name) };
    }
    const dir = await this._getHandle(cfg);
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(text);
    await w.close();
    return { path: `${dir.name}/${name}` };
  },

  async test(cfg) {
    if (isDesktop()) {
      if (!cfg.dirPath) throw new Error('请先填写或选择目录路径');
      const info = await globalThis.__aiph.fsStat(cfg.dirPath);
      if (!info.exists) throw new Error(`目录不存在：${cfg.dirPath}`);
      if (!info.isDirectory) throw new Error(`路径不是目录：${cfg.dirPath}`);
      return { ok: true, message: `目录可用：${cfg.dirPath}` };
    }
    await this._getHandle(cfg);
    return { ok: true, message: '目录句柄可用' };
  },

  async pull(cfg) {
    const text = await this._readText(cfg);
    if (!text) return null;
    return JSON.parse(text);
  },

  async push(cfg, snapshot) {
    const target = await this._writeText(cfg, JSON.stringify(snapshot, null, 2));
    return { rev: snapshot.exportedAt, message: `已写入 ${target.path}` };
  },
};

function joinPath(dir, name) {
  const sep = /\\/.test(dir) ? '\\' : '/';
  return String(dir).replace(/[\\/]+$/, '') + sep + name;
}

/* 句柄持久化（IndexedDB，可存 FileSystemDirectoryHandle） */
function handleDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('ai-prompt-hub', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('prompts')) db.createObjectStore('prompts', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function putHandle(key, handle) {
  const db = await handleDB();
  await new Promise((res, rej) => {
    const os = db.transaction('meta', 'readwrite').objectStore('meta');
    const r = os.put({ key, value: handle });
    r.onsuccess = res;
    r.onerror = () => rej(r.error);
  });
}
async function getHandle(key) {
  const db = await handleDB();
  return new Promise((res, rej) => {
    const os = db.transaction('meta', 'readonly').objectStore('meta');
    const r = os.get(key);
    r.onsuccess = () => res(r.result?.value || null);
    r.onerror = () => rej(r.error);
  });
}

/* ------------------------------------------------------------------ 2. GitHub Gist */

export const gist = {
  key: 'gist',
  name: 'GitHub Gist（推荐）',
  desc: '用 GitHub 的私有 Gist 当中转仓库。跨平台一致可用、无需服务器、无需备案，是手机端最省事的方案。需要一个只勾选 gist 权限的 Token。',
  fields: [
    { key: 'token', label: 'Personal Access Token', type: 'password', required: true,
      hint: 'GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic) → Generate new token，只勾选 gist 权限。只保存在本机。',
      link: 'https://github.com/settings/tokens/new?scopes=gist&description=AI-Prompt-Hub' },
    { key: 'gistId', label: 'Gist ID（留空则自动创建）', type: 'text', placeholder: '自动创建后自动回填，其他设备填同一个 ID 即可' },
    { key: 'fileName', label: '文件名', type: 'text', default: 'ai-prompt-hub.json' },
    { key: 'secret', label: '创建为私有 Gist', type: 'checkbox', default: true, hint: '私有 Gist 不会出现在你的公开列表里，但持有链接者可访问。请勿勾掉除非你确定要公开。' },
  ],

  available: () => true,

  _headers(cfg) {
    if (!cfg.token) throw new Error('缺少 GitHub Token');
    return {
      Authorization: `Bearer ${cfg.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    };
  },

  _file(cfg) {
    return cfg.fileName || 'ai-prompt-hub.json';
  },

  async _resolveGistId(cfg) {
    if (cfg.gistId) return cfg.gistId;
    const res = await httpJson('https://api.github.com/gists?per_page=100', { headers: this._headers(cfg) });
    if (!res.ok) throw new Error(`列举 Gist 失败（${res.status}）：${res.text.slice(0, 200)}`);
    const list = JSON.parse(res.text);
    const hit = list.find((g) => g.files && g.files[this._file(cfg)]);
    return hit ? hit.id : null;
  },

  async test(cfg) {
    const res = await httpJson('https://api.github.com/user', { headers: this._headers(cfg) });
    if (res.status === 401) throw new Error('Token 无效或已过期');
    if (!res.ok) throw new Error(`鉴权失败（${res.status}）：${res.text.slice(0, 200)}`);
    const me = JSON.parse(res.text);
    const scopes = res.headers?.['x-oauth-scopes'];
    const id = await this._resolveGistId(cfg);
    return {
      ok: true,
      message: `已连接 ${me.login}${id ? `，找到数据 Gist ${id}` : '，尚未创建数据 Gist（首次同步时自动创建）'}`,
      data: { gistId: id, scopes },
    };
  },

  async pull(cfg) {
    const id = await this._resolveGistId(cfg);
    if (!id) return null;
    const res = await httpJson(`https://api.github.com/gists/${id}`, { headers: this._headers(cfg) });
    if (!res.ok) throw new Error(`读取 Gist 失败（${res.status}）：${res.text.slice(0, 200)}`);
    const data = JSON.parse(res.text);
    const file = data.files?.[this._file(cfg)];
    if (!file) return null;
    let content = file.content;
    if (file.truncated && file.raw_url) {
      const raw = await httpJson(file.raw_url, { headers: { Authorization: `Bearer ${cfg.token}` } });
      content = raw.text;
    }
    return JSON.parse(content);
  },

  async push(cfg, snapshot) {
    const name = this._file(cfg);
    const body = JSON.stringify({ files: { [name]: { content: JSON.stringify(snapshot, null, 2) } } });
    let id = await this._resolveGistId(cfg);

    if (!id) {
      const createBody = JSON.stringify({
        description: 'AI Prompt Hub 同步数据（由应用自动维护）',
        public: cfg.secret === false,
        files: { [name]: { content: JSON.stringify(snapshot, null, 2) } },
      });
      const res = await httpJson('https://api.github.com/gists', { method: 'POST', headers: this._headers(cfg), body: createBody });
      if (!res.ok) throw new Error(`创建 Gist 失败（${res.status}）：${res.text.slice(0, 200)}`);
      const data = JSON.parse(res.text);
      return { rev: snapshot.exportedAt, gistId: data.id, message: `已创建 Gist ${data.id}（其他设备填入该 ID 即可同步）` };
    }

    const res = await httpJson(`https://api.github.com/gists/${id}`, { method: 'PATCH', headers: this._headers(cfg), body });
    if (!res.ok) throw new Error(`更新 Gist 失败（${res.status}）：${res.text.slice(0, 200)}`);
    return { rev: snapshot.exportedAt, gistId: id, message: `已更新 Gist ${id}` };
  },
};

/* ------------------------------------------------------------------ 3. WebDAV */

export const webdav = {
  key: 'webdav',
  name: 'WebDAV',
  desc: '通用协议。坚果云、Nextcloud、群晖、阿里云盘第三方网关等都支持。在任意设备上都能用。',
  fields: [
    { key: 'url', label: '文件完整地址', type: 'text', required: true,
      placeholder: 'https://dav.jianguoyun.com/dav/AI-PromptHub/ai-prompt-hub.json',
      hint: '坚果云：账号设置 → 安全选项 → 添加应用密码，用户名填邮箱，密码填应用密码。' },
    { key: 'username', label: '用户名', type: 'text', required: true },
    { key: 'password', label: '密码 / 应用密码', type: 'password', required: true },
  ],

  available: () => true,

  _headers(cfg) {
    if (!cfg.url || !cfg.username) throw new Error('请完整填写地址与用户名');
    const auth = btoa(unescape(encodeURIComponent(`${cfg.username}:${cfg.password || ''}`)));
    return { Authorization: `Basic ${auth}` };
  },

  async _ensureDirs(cfg) {
    try {
      const u = new URL(cfg.url);
      const segs = u.pathname.split('/').filter(Boolean);
      segs.pop(); // 去掉文件名
      let acc = '';
      for (const s of segs) {
        acc += '/' + s;
        const dirUrl = `${u.origin}${acc}/`;
        await httpRaw(dirUrl, { method: 'MKCOL', headers: this._headers(cfg), timeout: 15000 }).catch(() => {});
      }
    } catch (_) {
      /* 目录创建失败不阻断，很多服务商根目录已存在 */
    }
  },

  async test(cfg) {
    const res = await httpRaw(cfg.url, { method: 'PROPFIND', headers: { ...this._headers(cfg), Depth: '0' }, timeout: 15000 });
    if (res.status === 401 || res.status === 403) throw new Error('用户名或密码不正确');
    if (res.status === 404) return { ok: true, message: '路径可达，文件尚未创建（首次同步会自动建）' };
    if (res.status >= 400) throw new Error(`服务返回 ${res.status}：${res.text.slice(0, 200)}`);
    return { ok: true, message: '连接成功' };
  },

  async pull(cfg) {
    const res = await httpRaw(cfg.url, { method: 'GET', headers: this._headers(cfg) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`下载失败（${res.status}）：${res.text.slice(0, 200)}`);
    if (!res.text) return null;
    return JSON.parse(res.text);
  },

  async push(cfg, snapshot) {
    const res = await httpRaw(cfg.url, {
      method: 'PUT',
      headers: { ...this._headers(cfg), 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(snapshot, null, 2),
    });
    if (res.status === 404) {
      await this._ensureDirs(cfg);
      const retry = await httpRaw(cfg.url, {
        method: 'PUT',
        headers: { ...this._headers(cfg), 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(snapshot, null, 2),
      });
      if (!retry.ok && retry.status !== 201 && retry.status !== 204) {
        throw new Error(`上传失败（${retry.status}）：${retry.text.slice(0, 200)}`);
      }
      return { rev: snapshot.exportedAt, message: '已创建目录并上传' };
    }
    if (!res.ok && res.status !== 201 && res.status !== 204) {
      throw new Error(`上传失败（${res.status}）：${res.text.slice(0, 200)}`);
    }
    return { rev: snapshot.exportedAt, message: '已上传' };
  },
};

/* ------------------------------------------------------------------ 4. 百度网盘 */

export const baidupan = {
  key: 'baidupan',
  name: '百度网盘（进阶）',
  desc: '调用百度网盘开放平台 API，两端都能用。需要你实名注册并创建应用，且手机端可能受跨域限制，建议在桌面端使用。',
  fields: [
    { key: 'appKey', label: 'AppKey（即 client_id）', type: 'text', required: true,
      hint: '百度网盘开放平台 → 控制台 → 创建应用（类型选「软件」）后获得', link: 'https://pan.baidu.com/union/console/applist' },
    { key: 'secretKey', label: 'SecretKey', type: 'password', required: true, hint: '用于刷新 Token，请勿泄露' },
    { key: 'appId', label: 'AppID（纯数字）', type: 'text', hint: '拼接授权链接时作为 device_id' },
    { key: 'redirectUri', label: 'OAuth 回调地址', type: 'text', default: 'http://127.0.0.1:5180/oauth-callback.html',
      hint: '必须与开放平台「安全设置 → OAuth 授权回调页地址」完全一致，需单独点按钮添加，只填全局地址无效。' },
    { key: 'accessToken', label: 'Access Token', type: 'password', hint: '点下方「获取授权」按钮自动回填，也可手动粘贴。有效期 30 天。' },
    { key: 'refreshToken', label: 'Refresh Token', type: 'password', hint: '自动回填' },
    { key: 'remotePath', label: '云端存放路径', type: 'text', default: '/apps/AI-Prompt-Hub/ai-prompt-hub.json',
      hint: '必须以 /apps/你的应用名/ 开头，这是开放平台的沙箱限制。' },
  ],

  available: () => true,

  unavailableReason() {
    return isDesktop() ? '' : '浏览器端调用百度网盘上传接口大概率被跨域拦截，建议在桌面端使用本通道。';
  },

  getAuthUrl(cfg) {
    if (!cfg.appKey) throw new Error('请先填写 AppKey');
    const p = new URLSearchParams({
      response_type: 'token',
      client_id: cfg.appKey,
      redirect_uri: cfg.redirectUri,
      scope: 'basic,netdisk',
      device_id: cfg.appId || '',
      display: 'page',
    });
    return `https://openapi.baidu.com/oauth/2.0/authorize?${p.toString()}`;
  },

  async refresh(cfg) {
    const p = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: cfg.refreshToken,
      client_id: cfg.appKey,
      client_secret: cfg.secretKey,
    });
    const res = await httpJson(`https://openapi.baidu.com/oauth/2.0/token?${p.toString()}`, { method: 'POST' });
    if (!res.ok) throw new Error(`刷新 Token 失败（${res.status}）：${res.text.slice(0, 200)}`);
    const data = JSON.parse(res.text);
    if (data.error) throw new Error(`刷新失败：${data.error_description || data.error}`);
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || cfg.refreshToken,
      expiresAt: Date.now() + (data.expires_in || 2592000) * 1000,
    };
  },

  async test(cfg) {
    if (!cfg.accessToken) throw new Error('尚未授权，请点「获取授权」');
    const res = await httpJson(`https://pan.baidu.com/rest/2.0/xpan/nas?method=uinfo&access_token=${encodeURIComponent(cfg.accessToken)}`);
    if (!res.ok) throw new Error(`校验失败（${res.status}）：${res.text.slice(0, 200)}`);
    const data = JSON.parse(res.text);
    if (data.errno) throw new Error(`接口返回错误 ${data.errno}：${data.errmsg || ''}（111 = Token 失效，需重新授权）`);
    return { ok: true, message: `已授权，账号：${data.baidu_name || data.netdisk_name || '未知'}` };
  },

  async pull(cfg) {
    const path = cfg.remotePath;
    const listUrl = `https://pan.baidu.com/rest/2.0/xpan/multimedia?method=filemetas&dlink=1&fsids=&path=${encodeURIComponent(path)}&access_token=${encodeURIComponent(cfg.accessToken)}`;
    // 先查文件是否存在
    const metaRes = await httpJson(
      `https://pan.baidu.com/rest/2.0/xpan/file?method=search&key=${encodeURIComponent(path.split('/').pop())}&recursion=1&access_token=${encodeURIComponent(cfg.accessToken)}`
    );
    if (metaRes.ok) {
      const m = JSON.parse(metaRes.text);
      if (m.errno === 0 && Array.isArray(m.list)) {
        const hit = m.list.find((f) => f.path === path);
        if (hit) {
          const dlinkRes = await httpJson(
            `https://pan.baidu.com/rest/2.0/xpan/multimedia?method=filemetas&dlink=1&fsids=[${hit.fsid}]&access_token=${encodeURIComponent(cfg.accessToken)}`
          );
          if (dlinkRes.ok) {
            const d = JSON.parse(dlinkRes.text);
            const dlink = d.list?.[0]?.dlink;
            if (dlink) {
              const fileRes = await httpRaw(`${dlink}&access_token=${encodeURIComponent(cfg.accessToken)}`);
              if (fileRes.ok && fileRes.text) return JSON.parse(fileRes.text);
            }
          }
        }
      }
    }
    void listUrl;
    return null;
  },

  async push(cfg, snapshot) {
    const token = encodeURIComponent(cfg.accessToken);
    const path = cfg.remotePath;
    const content = JSON.stringify(snapshot, null, 2);
    const size = new TextEncoder().encode(content).length;

    // 1) precreate
    const preBody = new URLSearchParams({
      path,
      size: String(size),
      isdir: '0',
      autoinit: '1',
      block_list: JSON.stringify(['0']),
      rtype: '3',
    }).toString();
    const preRes = await httpJson(`https://pan.baidu.com/rest/2.0/xpan/file?method=precreate&access_token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: preBody,
    });
    if (!preRes.ok) throw new Error(`预上传失败（${preRes.status}）：${preRes.text.slice(0, 200)}`);
    const pre = JSON.parse(preRes.text);
    if (pre.errno) throw new Error(`预上传错误 ${pre.errno}：${pre.errmsg || ''}`);

    // 2) 上传分片（单分片足够，数据文件通常远小于 4MB）
    const form = new FormData();
    form.append('file', new Blob([content], { type: 'application/octet-stream' }), 'ai-prompt-hub.json');
    const upUrl = `https://d.pcs.baidu.com/rest/2.0/pcs/superfile2?method=upload&access_token=${token}&type=tmpfile&path=${encodeURIComponent(path)}&uploadid=${encodeURIComponent(pre.uploadid)}&partseq=0`;
    const upRes = await httpRaw(upUrl, { method: 'POST', body: form, timeout: 90000 });
    if (!upRes.ok) throw new Error(`上传分片失败（${upRes.status}）：${upRes.text.slice(0, 200)}`);

    // 3) create
    const createBody = new URLSearchParams({
      path,
      size: String(size),
      isdir: '0',
      block_list: JSON.stringify(['0']),
      uploadid: pre.uploadid,
      rtype: '3',
    }).toString();
    const createRes = await httpJson(`https://pan.baidu.com/rest/2.0/xpan/file?method=create&access_token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: createBody,
    });
    if (!createRes.ok) throw new Error(`确认上传失败（${createRes.status}）：${createRes.text.slice(0, 200)}`);
    const created = JSON.parse(createRes.text);
    if (created.errno) throw new Error(`确认上传错误 ${created.errno}：${created.errmsg || ''}`);

    return { rev: snapshot.exportedAt, message: `已上传到 ${path}` };
  },
};

/* ------------------------------------------------------------------ 5. 手动导入导出 */

export const manual = {
  key: 'manual',
  name: '手动导入 / 导出',
  desc: '不用任何通道：导出 JSON 文件自己丢进网盘，或从网盘下载后导入合并。最土但永远有效。',
  fields: [],
  available: () => true,
  async test() {
    return { ok: true, message: '无需配置' };
  },
  async pull() {
    return null;
  },
  async push() {
    return { rev: Date.now(), message: '请在「数据」页使用导出按钮' };
  },
};

/* ------------------------------------------------------------------ 注册表 */

/** 顺序即设置页的展示顺序：桌面端最顺手的排前面 */
export const ADAPTERS = [weiyun, gist, localFolder, webdav, baidupan, manual];
export const ADAPTER_MAP = new Map(ADAPTERS.map((a) => [a.key, a]));

/** 默认推荐。微云是桌面端首选，Gist 是跨平台兜底。 */
export const RECOMMENDED = 'weiyun';

export const BADGES = {
  weiyun: '桌面端推荐',
  gist: '跨平台推荐',
};

export function badgeOf(key) {
  return BADGES[key] || '';
}
