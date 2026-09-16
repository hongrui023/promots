/**
 * 同步编排器
 *
 * 职责
 *   - 保存 / 读取同步配置（存在 store 的 settings 里，密钥只落本机）
 *   - 执行「拉取 → 三方合并 → 写回本地 → 上传」的完整往返
 *   - 变更后自动同步（防抖），以及冲突/失败状态上报
 *
 * 冲突策略：记录级 Last-Write-Wins（比 updatedAt），useCount 取最大值。
 * 这个策略对「个人多设备管理指令库」是合适的：两端同时改同一条的概率极低，
 * 且即使发生，丢失的也只是一次编辑，不会损坏整个库。
 */

import { bus, store } from '../store.js';
import { ADAPTER_MAP, describeError } from './adapters.js';

const SYNC_KEY = 'sync';

let autoTimer = null;
let running = false;
let lastResult = null;

export function getConfig() {
  const s = (store.settings && store.settings[SYNC_KEY]) || {};
  return {
    provider: s.provider || null,
    auto: s.auto !== false,
    intervalMin: Number(s.intervalMin) || 15,
    lastSyncAt: s.lastSyncAt || null,
    lastStatus: s.lastStatus || null,
    lastError: s.lastError || null,
    configs: s.configs || {},
  };
}

export async function saveConfig(patch) {
  const cur = getConfig();
  const next = { ...cur, ...patch };
  const settings = await store.saveSettings({ [SYNC_KEY]: next });
  store.settings = settings;
  bus.emit('sync:config', next);
  return next;
}

export async function saveProviderConfig(provider, cfg) {
  const cur = getConfig();
  const configs = { ...cur.configs, [provider]: { ...(cur.configs[provider] || {}), ...cfg } };
  return saveConfig({ configs });
}

export function providerConfig(provider) {
  return { ...(getConfig().configs[provider] || {}) };
}

export function activeAdapter() {
  const { provider } = getConfig();
  return provider ? ADAPTER_MAP.get(provider) || null : null;
}

async function setStatus(status, error = null) {
  const patch = { lastStatus: status };
  if (status === 'success') {
    patch.lastSyncAt = Date.now();
    patch.lastError = null;
  }
  if (error) patch.lastError = error;
  await saveConfig(patch);
}

/**
 * 完整同步
 * @param {{direction?:'both'|'push'|'pull', silent?:boolean}} opts
 */
export async function syncNow({ direction = 'both', silent = false } = {}) {
  const adapter = activeAdapter();
  if (!adapter) throw new Error('尚未选择同步通道');
  if (running) return { skipped: true, reason: '同步进行中' };

  running = true;
  bus.emit('sync:start', { direction });
  const started = Date.now();

  try {
    const cfg = providerConfig(adapter.key);
    await setStatus('running');

    let remote = null;
    let pulled = false;

    if (direction === 'both' || direction === 'pull') {
      bus.emit('sync:stage', '正在从云端拉取…');
      remote = await adapter.pull(cfg);
      pulled = true;
    }

    let report = null;
    let snapshot;

    if (remote && Array.isArray(remote.items)) {
      bus.emit('sync:stage', `云端 ${remote.items.length} 条，正在合并…`);
      const merged = store.merge(remote);
      await store.applyMerged(merged.items);
      report = merged.report;
      snapshot = store.snapshot();
    } else if (pulled && direction === 'pull') {
      await setStatus('success');
      return { ok: true, pulled: true, remoteEmpty: true, message: '云端暂无数据，未做改动' };
    } else {
      // 云端为空且方向是 both：首次同步，把本地推上去
      snapshot = store.snapshot();
    }

    let pushResult = null;
    if (direction === 'both' || direction === 'push') {
      bus.emit('sync:stage', '正在上传到云端…');
      pushResult = await adapter.push(cfg, snapshot);
      if (pushResult?.gistId && pushResult.gistId !== cfg.gistId) {
        await saveProviderConfig(adapter.key, { gistId: pushResult.gistId });
      }
    }

    await setStatus('success');
    lastResult = {
      ok: true,
      provider: adapter.key,
      ms: Date.now() - started,
      report,
      push: pushResult,
      remoteCount: remote?.items?.length ?? null,
      localCount: snapshot.items.length,
    };
    bus.emit('sync:done', lastResult);
    return lastResult;
  } catch (e) {
    const msg = describeError(e);
    await setStatus('error', msg);
    lastResult = { ok: false, error: msg, provider: adapter.key, ms: Date.now() - started };
    bus.emit('sync:error', lastResult);
    if (!silent) throw e;
    return lastResult;
  } finally {
    running = false;
  }
}

/** 仅上传本地（云端不拉取），适合「这条数据一定以我为最新」的场景 */
export function pushOnly() {
  return syncNow({ direction: 'push' });
}

/** 仅从云端拉取并合并 */
export function pullOnly() {
  return syncNow({ direction: 'pull' });
}

/* ------------------------------------------------------------------ 自动同步 */

export function startAutoSync() {
  stopAutoSync();
  const cfg = getConfig();
  if (!cfg.auto || !cfg.provider) return;

  // 数据变更后延迟 8 秒上传（防抖，避免连续编辑时反复请求）
  bus.on('change', () => {
    if (!getConfig().auto) return;
    clearTimeout(autoTimer);
    autoTimer = setTimeout(() => {
      syncNow({ direction: 'push', silent: true });
    }, 8000);
  });

  // 定时全量双向同步，兜住「另一台设备改过」的情况
  const interval = Math.max(5, cfg.intervalMin) * 60000;
  autoTimer = setInterval(() => {
    if (document.hidden) return;
    syncNow({ direction: 'both', silent: true });
  }, interval);
}

export function stopAutoSync() {
  if (autoTimer) {
    clearTimeout(autoTimer);
    clearInterval(autoTimer);
    autoTimer = null;
  }
}

export function syncStatus() {
  const c = getConfig();
  return {
    provider: c.provider,
    providerName: c.provider ? ADAPTER_MAP.get(c.provider)?.name : null,
    auto: c.auto,
    lastSyncAt: c.lastSyncAt,
    lastStatus: c.lastStatus,
    lastError: c.lastError,
    running,
    lastResult,
  };
}

export async function testProvider(provider, cfg) {
  const adapter = ADAPTER_MAP.get(provider);
  if (!adapter) throw new Error('未知通道');
  return adapter.test(cfg || providerConfig(provider));
}
