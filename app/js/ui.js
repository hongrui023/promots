/**
 * UI 基础工具：DOM 构造、提示、弹窗、剪贴板、高亮、格式化
 */

/** 创建元素：el('div.card', { onclick }, [children]) */
export function el(spec, props = {}, children = []) {
  const m = String(spec).match(/^([a-zA-Z0-9-]*)((?:\.[\w-]+)*)$/);
  const tag = (m && m[1]) || 'div';
  const node = document.createElement(tag);
  if (m && m[2]) {
    for (const c of m[2].split('.').filter(Boolean)) node.classList.add(c);
  }
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className += (node.className ? ' ' : '') + v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in node && k !== 'list') node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 依据 [start,end] 区间数组把文本转成带 <mark> 的 HTML */
export function highlight(text, spans) {
  const src = String(text ?? '');
  if (!spans || !spans.length) return escapeHtml(src);
  let out = '';
  let cursor = 0;
  for (const [s, e] of spans) {
    if (s > src.length) break;
    out += escapeHtml(src.slice(cursor, s));
    out += '<mark>' + escapeHtml(src.slice(s, Math.min(e, src.length))) + '</mark>';
    cursor = Math.min(e, src.length);
  }
  out += escapeHtml(src.slice(cursor));
  return out;
}

/* ------------------------------------------------------------------ 提示 */

let toastBox = null;
export function toast(message, type = 'info', ms = 2600) {
  if (!toastBox) {
    toastBox = el('div.toasts');
    document.body.appendChild(toastBox);
  }
  const node = el('div.toast', { dataset: { type } }, [
    el('span.toast-icon', { text: type === 'success' ? '✓' : type === 'error' ? '✕' : type === 'warn' ? '!' : 'i' }),
    el('span.toast-msg', { text: message }),
  ]);
  toastBox.appendChild(node);
  requestAnimationFrame(() => node.classList.add('in'));
  setTimeout(() => {
    node.classList.remove('in');
    setTimeout(() => node.remove(), 260);
  }, ms);
  return node;
}

/* ------------------------------------------------------------------ 弹窗 */

/**
 * 打开弹窗
 * @param {{title:string, body:Node, footer?:Node[], width?:string, onClose?:Function}} opts
 */
export function modal({ title, body, footer = [], width = '560px', onClose }) {
  const backdrop = el('div.modal-backdrop');
  const close = () => {
    backdrop.classList.remove('in');
    setTimeout(() => backdrop.remove(), 200);
    document.removeEventListener('keydown', onKey);
    if (onClose) onClose();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };

  const box = el('div.modal', { style: { maxWidth: width } }, [
    el('div.modal-head', {}, [
      el('h3.modal-title', { text: title }),
      el('button.icon-btn', { text: '✕', title: '关闭', onclick: close }),
    ]),
    el('div.modal-body', {}, [body]),
    footer.length ? el('div.modal-foot', {}, footer) : null,
  ]);

  backdrop.appendChild(box);
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(backdrop);
  requestAnimationFrame(() => backdrop.classList.add('in'));
  return { close, box, backdrop };
}

/** 确认框 */
export function confirmDialog(message, { title = '确认操作', danger = false, okText = '确定' } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const m = modal({
      title,
      width: '420px',
      body: el('p.confirm-text', { text: message }),
      footer: [
        el('button.btn', { text: '取消', onclick: () => { done(false); m.close(); } }),
        el('button.btn' + (danger ? '.btn-danger' : '.btn-primary'), {
          text: okText,
          onclick: () => { done(true); m.close(); },
        }),
      ],
      onClose: () => done(false),
    });
  });
}

/* ------------------------------------------------------------------ 剪贴板 */

export async function copyText(text) {
  const t = String(text ?? '');
  try {
    if (navigator.clipboard && globalThis.isSecureContext) {
      await navigator.clipboard.writeText(t);
      return true;
    }
  } catch (_) {
    /* 走降级 */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = t;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, t.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (_) {
    return false;
  }
}

/* ------------------------------------------------------------------ 格式化 */

export function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const now = new Date();
  const diff = now - d;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000 && d.getDate() === now.getDate()) return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (diff < 7 * 86400000) return `${Math.floor(diff / 86400000)} 天前`;
  const sameYear = d.getFullYear() === now.getFullYear();
  return `${sameYear ? '' : d.getFullYear() + '-'}${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function fmtFull(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function byteSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function debounce(fn, ms = 200) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/** 平台标签渲染 */
export function platformChip(key, name, color) {
  return el('span.chip.chip-platform', { style: { '--c': color }, title: name }, [el('i.dot'), name]);
}

/** 首个字符作头像字 */
export function initialLetter(text) {
  const s = String(text || '').trim();
  if (!s) return '?';
  const m = s.match(/[\u4e00-\u9fff]/);
  if (m) return m[0];
  const w = s.match(/[a-zA-Z0-9]/);
  return w ? w[0].toUpperCase() : '?';
}

/** 由字符串生成稳定的柔和色相 */
export function hueOf(text) {
  let h = 0;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}
