/**
 * 生成拼音首字母索引表，输出到 app/js/pinyin-data.js
 *
 * 为什么要生成而不是运行时引入 pinyin 库：
 *   - 应用核心要求「零依赖、零构建」，双击 index.html 就能跑
 *   - 只用到「首字母」这一维度，全量汉字表压缩后仅 ~21KB，比任何运行时库都小
 *   - 生成结果提交进仓库，用户无需执行本脚本
 *
 * 用法：npm i && npm run gen:pinyin
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { pinyin } = require('pinyin-pro');

const START = 0x4e00;
const END = 0x9fff;

const primary = [];
/** 多音字：不同读音首字母不同的字符 -> Set of initials */
const poly = new Map();

for (let code = START; code <= END; code++) {
  const ch = String.fromCodePoint(code);

  // 主读音首字母
  let first = '';
  try {
    const r = pinyin(ch, { pattern: 'first', toneType: 'none', type: 'array' });
    first = (r && r[0] ? String(r[0]) : '').toLowerCase();
  } catch (_) {
    first = '';
  }
  if (!/^[a-z]$/.test(first)) first = '0'; // 0 = 无拼音（生僻字/非汉字），占位保持定长
  primary.push(first);

  // 多音字的所有可能首字母
  try {
    const all = pinyin(ch, { pattern: 'first', toneType: 'none', multiple: true, type: 'array' });
    const set = new Set(
      (all || [])
        .map((v) => String(v).toLowerCase())
        .filter((v) => /^[a-z]$/.test(v))
    );
    if (set.size > 1) {
      // 排序保证结果稳定，避免每次生成 diff 噪音
      poly.set(ch, Array.from(set).sort().join('').replace(/(.)\1+/g, '$1'));
    }
  } catch (_) {
    /* 忽略 */
  }
}

// 多音字表做成紧凑字符串 "中zc长cz..."，运行时 split 还原
const polyPairs = [];
for (const [ch, initials] of poly.entries()) polyPairs.push(ch + initials);

const out = `/* eslint-disable */
/**
 * 自动生成，请勿手工编辑。
 * 由 tools/gen-pinyin.js 生成，重新生成：npm run gen:pinyin
 *
 * UNICODE_RANGE = U+4E00 ~ U+9FFF（CJK 统一表意文字基本区，共 ${END - START + 1} 字）
 * PINYIN_INITIALS[i] 为对应字符的拼音首字母；'0' 表示该字无拼音。
 * PINYIN_POLY 为多音字表，形如 "中zc长cz"，每 1 位汉字 + N 位可能首字母。
 */
export const UNICODE_START = 0x${START.toString(16)};

export const PINYIN_INITIALS = ${JSON.stringify(primary.join(''))};

export const PINYIN_POLY = ${JSON.stringify(polyPairs.join(''))};
`;

const target = path.resolve(__dirname, '..', 'app', 'js', 'pinyin-data.js');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, out, 'utf8');

const kb = (Buffer.byteLength(out, 'utf8') / 1024).toFixed(1);
console.log(`[gen-pinyin] 已写入 ${path.relative(process.cwd(), target)}`);
console.log(`[gen-pinyin] 汉字 ${END - START + 1} 个，多音字 ${poly.size} 个，文件 ${kb} KB`);
