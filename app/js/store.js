/**
 * 数据层：IndexedDB 持久化 + 内存索引 + 变更事件
 *
 * 设计要点
 *  - 记录级 last-write-wins 合并：同步时按 id 对齐，比 updatedAt，保留较新一条
 *  - 软删除 + 墓碑（tombstone）：删除动作也能跨设备传播，否则会被另一端「复活」
 *  - categoryLocked：用户手工调整过分类后，自动分类不再覆盖
 *  - 全量导出/导入为单个 JSON，便于塞进任意网盘通道
 */

const DB_NAME = 'ai-prompt-hub';
const DB_VERSION = 1;
const OS_PROMPTS = 'prompts';
const OS_META = 'meta';

/** @typedef {Object} Prompt
 * @property {string}   id
 * @property {string}   title
 * @property {string}   content
 * @property {string}   note
 * @property {string[]} tags
 * @property {string}   category
 * @property {boolean}  categoryLocked
 * @property {boolean}  favorite
 * @property {string[]} platforms
 * @property {number}   useCount
 * @property {number|null} lastUsedAt
 * @property {number}   createdAt
 * @property {number}   updatedAt
 * @property {boolean}  deleted
 * @property {number|null} deletedAt
 * @property {string}   deviceId  最后修改设备，便于排查冲突
 */

export function uid() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return 'p-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(OS_PROMPTS)) {
        db.createObjectStore(OS_PROMPTS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(OS_META)) {
        db.createObjectStore(OS_META, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, store, mode) {
  return db.transaction(store, mode).objectStore(store);
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** 极简事件总线 */
class Emitter {
  constructor() {
    this._h = new Map();
  }
  on(type, fn) {
    if (!this._h.has(type)) this._h.set(type, new Set());
    this._h.get(type).add(fn);
    return () => this._h.get(type).delete(fn);
  }
  emit(type, payload) {
    const set = this._h.get(type);
    if (set) for (const fn of set) {
      try {
        fn(payload);
      } catch (e) {
        console.error('[store] listener error', e);
      }
    }
    const all = this._h.get('*');
    if (all) for (const fn of all) fn(type, payload);
  }
}

export const bus = new Emitter();

function normalize(raw) {
  const now = Date.now();
  const p = {
    id: raw.id || uid(),
    title: String(raw.title || '').trim() || '未命名指令',
    content: String(raw.content || ''),
    note: String(raw.note || ''),
    tags: Array.isArray(raw.tags) ? raw.tags.map((t) => String(t).trim()).filter(Boolean) : [],
    category: raw.category || 'other',
    categoryLocked: Boolean(raw.categoryLocked),
    favorite: Boolean(raw.favorite),
    platforms: Array.isArray(raw.platforms) ? raw.platforms.slice() : [],
    useCount: Number(raw.useCount) || 0,
    lastUsedAt: raw.lastUsedAt || null,
    createdAt: raw.createdAt || now,
    updatedAt: raw.updatedAt || raw.createdAt || now,
    deleted: Boolean(raw.deleted),
    deletedAt: raw.deletedAt || null,
    deviceId: raw.deviceId || 'unknown',
  };
  // 去重标签
  p.tags = Array.from(new Set(p.tags));
  return p;
}

export class Store {
  constructor() {
    this.db = null;
    this.mem = new Map(); // id -> Prompt
    this.deviceId = 'unknown';
    this.deviceName = 'unknown';
    this._ready = null;
    this._exportHandler = null;
  }

  async init() {
    this._ready = (async () => {
      this.db = await openDB();
      await this._loadMeta();
      const all = await wrap(tx(this.db, OS_PROMPTS, 'readonly').getAll());
      this.mem.clear();
      for (const raw of all) {
        const p = normalize(raw);
        this.mem.set(p.id, p);
      }
      bus.emit('ready', { count: this.mem.size });
    })();
    return this._ready;
  }

  async ready() {
    if (!this._ready) await this.init();
    return this._ready;
  }

  async _loadMeta() {
    const rows = await wrap(tx(this.db, OS_META, 'readonly').getAll());
    const map = new Map(rows.map((r) => [r.key, r.value]));
    this.deviceId = map.get('deviceId');
    if (!this.deviceId) {
      this.deviceId = uid();
      await this._setMeta('deviceId', this.deviceId);
    }
    this.deviceName = map.get('deviceName') || defaultDeviceName();
    await this._setMeta('deviceName', this.deviceName);
    this.settings = map.get('settings') || {};
  }

  async _setMeta(key, value) {
    await wrap(tx(this.db, OS_META, 'readwrite').put({ key, value }));
  }

  async getSettings() {
    await this.ready();
    const rows = await wrap(tx(this.db, OS_META, 'readonly').getAll());
    const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    return map.settings || {};
  }

  async saveSettings(patch) {
    await this.ready();
    const cur = await this.getSettings();
    const next = { ...cur, ...patch };
    await this._setMeta('settings', next);
    bus.emit('settings', next);
    return next;
  }

  // ---------------------------------------------------------------- 读

  /** 全部指令（默认排除回收站） */
  all({ includeDeleted = false } = {}) {
    const list = Array.from(this.mem.values());
    return includeDeleted ? list : list.filter((p) => !p.deleted);
  }

  get(id) {
    return this.mem.get(id) || null;
  }

  stats() {
    const live = this.all();
    const byCat = {};
    let favorites = 0;
    let deleted = 0;
    for (const p of this.mem.values()) {
      if (p.deleted) {
        deleted++;
        continue;
      }
      byCat[p.category] = (byCat[p.category] || 0) + 1;
      if (p.favorite) favorites++;
    }
    return { total: live.length, favorites, deleted, byCat };
  }

  collectedTags() {
    const m = new Map();
    for (const p of this.all()) {
      for (const t of p.tags) m.set(t, (m.get(t) || 0) + 1);
    }
    return Array.from(m.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count }));
  }

  // ---------------------------------------------------------------- 写

  async _put(p) {
    this.mem.set(p.id, p);
    await wrap(tx(this.db, OS_PROMPTS, 'readwrite').put(p));
    bus.emit('change', { type: 'put', id: p.id });
    return p;
  }

  async create(data) {
    await this.ready();
    const now = Date.now();
    const p = normalize({ ...data, id: uid(), createdAt: now, updatedAt: now, deviceId: this.deviceId });
    return this._put(p);
  }

  /**
   * 更新。传入 $touch 表示仅刷新时间戳。
   * 修改 category 时若 byUser 为 true，则锁定分类。
   */
  async update(id, patch, { byUser = false } = {}) {
    await this.ready();
    const cur = this.mem.get(id);
    if (!cur) return null;
    const next = normalize({ ...cur, ...patch, id: cur.id, updatedAt: Date.now(), deviceId: this.deviceId });
    if (byUser && Object.prototype.hasOwnProperty.call(patch, 'category')) next.categoryLocked = true;
    return this._put(next);
  }

  async remove(id) {
    await this.ready();
    const cur = this.mem.get(id);
    if (!cur) return null;
    const now = Date.now();
    return this._put({ ...cur, deleted: true, deletedAt: now, updatedAt: now, deviceId: this.deviceId });
  }

  async restore(id) {
    await this.ready();
    const cur = this.mem.get(id);
    if (!cur) return null;
    return this._put({ ...cur, deleted: false, deletedAt: null, updatedAt: Date.now(), deviceId: this.deviceId });
  }

  /** 物理删除（回收站里再次删除） */
  async purge(id) {
    await this.ready();
    this.mem.delete(id);
    await wrap(tx(this.db, OS_PROMPTS, 'readwrite').delete(id));
    bus.emit('change', { type: 'purge', id });
  }

  async emptyTrash() {
    await this.ready();
    for (const p of Array.from(this.mem.values())) {
      if (p.deleted) await this.purge(p.id);
    }
  }

  async toggleFavorite(id) {
    const cur = this.mem.get(id);
    if (!cur) return null;
    return this.update(id, { favorite: !cur.favorite });
  }

  async markUsed(id) {
    const cur = this.mem.get(id);
    if (!cur) return null;
    // 使用计数不参与「内容更新」的语义，这里仍刷新 updatedAt，
    // 因为跨设备统计次数取较大值是合理的（见 merge 中的 useCount 规则）
    return this.update(id, { useCount: cur.useCount + 1, lastUsedAt: Date.now() });
  }

  // ---------------------------------------------------------------- 同步用

  /** 导出为可直接落盘的 JSON 快照 */
  snapshot() {
    return {
      schema: 1,
      app: 'ai-prompt-hub',
      exportedAt: Date.now(),
      device: { id: this.deviceId, name: this.deviceName },
      count: this.mem.size,
      items: Array.from(this.mem.values()),
    };
  }

  /**
   * 三方合并：本地 <-> 远端快照
   * 规则
   *  1. 同一 id，updatedAt 大者胜（内容级 LWW）
   *  2. useCount 取两者最大值（计数不该因为同步而回退）
   *  3. 一方不存在则直接采用另一方
   * 返回合并后的完整集合，调用方负责写回本地并上传。
   */
  merge(remote) {
    const remoteItems = Array.isArray(remote?.items) ? remote.items : [];
    const merged = new Map();
    let localWin = 0;
    let remoteWin = 0;
    let added = 0;

    for (const [id, p] of this.mem) merged.set(id, p);

    for (const raw of remoteItems) {
      const r = normalize(raw);
      const local = merged.get(r.id);
      if (!local) {
        merged.set(r.id, r);
        added++;
        continue;
      }
      if (r.updatedAt > local.updatedAt) {
        merged.set(r.id, {
          ...r,
          useCount: Math.max(r.useCount, local.useCount),
          lastUsedAt: Math.max(r.lastUsedAt || 0, local.lastUsedAt || 0) || null,
        });
        remoteWin++;
      } else if (local.updatedAt > r.updatedAt) {
        merged.set(r.id, {
          ...local,
          useCount: Math.max(r.useCount, local.useCount),
          lastUsedAt: Math.max(r.lastUsedAt || 0, local.lastUsedAt || 0) || null,
        });
        localWin++;
      } else {
        // 时间戳相同，保守取本地
        localWin++;
      }
    }

    // 兜底：同步 useCount 最大值（针对两侧都未更新的条目）
    for (const raw of remoteItems) {
      const local = merged.get(raw.id);
      if (!local) continue;
      if ((raw.useCount || 0) > local.useCount) {
        merged.set(local.id, { ...local, useCount: raw.useCount, lastUsedAt: Math.max(local.lastUsedAt || 0, raw.lastUsedAt || 0) || null });
      }
    }

    return {
      items: Array.from(merged.values()),
      report: { total: merged.size, added, localWin, remoteWin },
    };
  }

  /** 用合并结果覆盖本地 */
  async applyMerged(items) {
    await this.ready();
    const incoming = new Map();
    for (const raw of items) {
      const p = normalize(raw);
      incoming.set(p.id, p);
    }
    const toDelete = [];
    for (const id of this.mem.keys()) if (!incoming.has(id)) toDelete.push(id);

    const store = tx(this.db, OS_PROMPTS, 'readwrite');
    for (const p of incoming.values()) {
      this.mem.set(p.id, p);
      store.put(p);
    }
    for (const id of toDelete) {
      this.mem.delete(id);
      store.delete(id);
    }
    await new Promise((resolve, reject) => {
      store.transaction.oncomplete = resolve;
      store.transaction.onerror = () => reject(store.transaction.error);
    });
    bus.emit('change', { type: 'bulk', count: incoming.size });
  }

  /**
   * 导入 JSON
   * @param {object} payload
   * @param {'merge'|'replace'} mode
   */
  async importSnapshot(payload, mode = 'merge') {
    await this.ready();
    const items = Array.isArray(payload?.items) ? payload.items : Array.isArray(payload) ? payload : null;
    if (!items) throw new Error('文件格式不正确：缺少 items 数组');
    if (mode === 'replace') {
      await this.applyMerged(items);
      return { mode, total: items.length };
    }
    const { items: merged, report } = this.merge({ items });
    await this.applyMerged(merged);
    return { mode, ...report };
  }

  async reset() {
    await this.ready();
    const store = tx(this.db, OS_PROMPTS, 'readwrite');
    store.clear();
    this.mem.clear();
    await new Promise((resolve, reject) => {
      store.transaction.oncomplete = resolve;
      store.transaction.onerror = () => reject(store.transaction.error);
    });
    bus.emit('change', { type: 'reset' });
  }
}

function defaultDeviceName() {
  const ua = navigator.userAgent || '';
  if (/Android/i.test(ua)) return 'Android 设备';
  if (/Windows/i.test(ua)) return 'Windows 电脑';
  if (/Macintosh/i.test(ua)) return 'Mac';
  if (/Linux/i.test(ua)) return 'Linux';
  return '未知设备';
}

export const store = new Store();

/* ------------------------------------------------------------------ 工具 */

/** 触发浏览器下载 */
export function downloadJSON(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
