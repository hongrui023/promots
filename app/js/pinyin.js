/**
 * 拼音检索工具
 *
 * 依赖 pinyin-data.js（由 tools/gen-pinyin.js 预生成，零运行时依赖）。
 * 支持：
 *  - 汉字 -> 拼音首字母（含多音字多值）
 *  - 全拼首字母串，用于「gwxz」→「公文写作」这类输入法式检索
 */

import { UNICODE_START, PINYIN_INITIALS, PINYIN_POLY } from './pinyin-data.js';

/** 多音字表：char -> initials 字符串，如 '中' -> 'z' */
const POLY = (() => {
  const m = new Map();
  if (!PINYIN_POLY) return m;
  let i = 0;
  while (i < PINYIN_POLY.length) {
    const ch = PINYIN_POLY[i];
    i += 1;
    let j = i;
    while (j < PINYIN_POLY.length && /[a-z]/.test(PINYIN_POLY[j])) j += 1;
    m.set(ch, PINYIN_POLY.slice(i, j));
    i = j;
  }
  return m;
})();

const CJK_RE = /[\u4e00-\u9fff]/;

export function isCJK(ch) {
  return CJK_RE.test(ch);
}

/** 单个汉字的首字母（多音字合并，如 '中' -> 'z'，'长' -> 'cz'） */
export function initialOf(ch) {
  const poly = POLY.get(ch);
  if (poly) return poly;
  const code = ch.codePointAt(0);
  const idx = code - UNICODE_START;
  if (idx < 0 || idx >= PINYIN_INITIALS.length) return '';
  const v = PINYIN_INITIALS[idx];
  return v === '0' ? '' : v;
}

/**
 * 文本 -> 拼音首字母串。非汉字原样保留（转小写），便于中英混合检索。
 * 多音字只取主读音，保证串长与字符数一致；模糊匹配阶段会单独处理多音字。
 * @param {string} text
 * @returns {string}
 */
export function initials(text) {
  const s = String(text || '').toLowerCase();
  let out = '';
  for (const ch of s) {
    if (ch === ' ' || ch === '\n' || ch === '\t' || ch === '-' || ch === '_') continue;
    if (CJK_RE.test(ch)) out += initialOf(ch) || '';
    else if (/[a-z0-9]/.test(ch)) out += ch;
  }
  return out;
}

/**
 * 带空格的拼音首字母（按词边界），用于「gong wen」匹配。
 * @param {string} text
 */
export function initialsSpaced(text) {
  const raw = String(text || '');
  const tokens = raw.split(/[\s\u3000,，。、;；:：!！?？()（）\[\]【】"'“”]+/).filter(Boolean);
  return tokens.map((t) => initials(t)).filter(Boolean);
}

/**
 * 多音字全排列生成（限制在 32 种以内，防止爆炸）。
 * 用于「重写」可被 'zx' 或 'cx' 命中。
 * @param {string} text
 * @returns {string[]}
 */
export function initialsVariants(text) {
  const s = String(text || '');
  const slots = [];
  for (const ch of s) {
    if (CJK_RE.test(ch)) {
      const ini = initialOf(ch);
      if (!ini) continue;
      slots.push(ini.length > 1 ? ini.split('') : [ini]);
    }
  }
  if (!slots.length) return [];
  let results = [''];
  for (const slot of slots) {
    const next = [];
    for (const prefix of results) {
      for (const c of slot) {
        if (next.length >= 32) break;
        next.push(prefix + c);
      }
    }
    results = next;
    if (results.length >= 32) break;
  }
  return Array.from(new Set(results));
}

/** 查询串 -> 拼音首字母（用于把用户输入转成拼音去匹配词条） */
export function queryInitials(query) {
  return initials(query);
}

export function pinyinAvailable() {
  return PINYIN_INITIALS.length > 0;
}

export const PY_DICT_SIZE = PINYIN_INITIALS.length;
export const PY_POLY_SIZE = POLY.size;
