/**
 * 同步通道共用的 HTTP 辅助
 *
 * 关键设计：优先走桌面端主进程转发。
 * 原因是大模型接口、WebDAV、百度网盘这些服务基本都不返回跨域头，
 * 浏览器里直接 fetch 一定被 CORS 拦掉；Electron 主进程没有同源策略，
 * 由它代发请求可以一次性解决所有通道的跨域问题。
 */

export const isDesktop = () => Boolean(globalThis.__aiph?.isDesktop);

/** 把各种异常翻译成人能看懂的一句话 */
export function describeError(e) {
  if (!e) return '未知错误';
  if (e.name === 'AbortError') return '请求超时';
  if (e instanceof TypeError && /fetch/i.test(String(e.message))) {
    return '被浏览器跨域策略（CORS）拦截。请改用桌面端，或换一个允许跨域的通道。';
  }
  return e.message || String(e);
}

/**
 * 发请求并取回文本响应
 * @returns {Promise<{status:number, ok:boolean, text:string, headers:Object}>}
 */
export async function httpRequest(url, { method = 'GET', headers = {}, body = null, timeout = 30000, viaNative = true } = {}) {
  // FormData 不经过 IPC（结构化克隆语义不稳），改由渲染层直发
  const useNative = viaNative && globalThis.__aiph?.httpRequest && !(body instanceof FormData);

  if (useNative) {
    const r = await globalThis.__aiph.httpRequest({ url, method, headers, body, timeout });
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      text: r.body ?? '',
      headers: r.headers || {},
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { method, headers, body, signal: controller.signal });
    const text = await res.text();
    return {
      status: res.status,
      ok: res.ok,
      text,
      headers: Object.fromEntries(res.headers.entries()),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 发请求并解析 JSON。解析失败时抛出带响应片段的错误，便于定位。 */
export async function httpJson(url, opts = {}) {
  const r = await httpRequest(url, opts);
  let data = null;
  try {
    data = r.text ? JSON.parse(r.text) : null;
  } catch (_) {
    throw new Error(`响应不是合法 JSON（HTTP ${r.status}）：${r.text.slice(0, 200)}`);
  }
  return { ...r, data };
}

/** 把对象编码为 application/x-www-form-urlencoded */
export function formEncode(obj) {
  return new URLSearchParams(obj).toString();
}
