/**
 * SHA-1 与 MD5 实现（含内部状态提取）
 *
 * 为什么不用 Web Crypto：
 *   `crypto.subtle.digest()` 是异步的、且**只能拿到最终摘要**。
 *   微云的上传协议需要的是 SHA-1 **未经 finalization 的内部寄存器状态**（h0–h4），
 *   用于生成每个分块的 sha 和防篡改校验值 check_sha。浏览器 API 拿不到这个。
 *
 * 所以这里手写两个算法，公开一个 `getStateHex()`。
 * 正确性由 tools/verify.mjs 对照 Node 内置 crypto 逐字节校验。
 */

/* ------------------------------------------------------------------ SHA-1 */

const SHA1_INIT = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];

function rotl(n, b) {
  return ((n << b) | (n >>> (32 - b))) >>> 0;
}

/** 32 位整数 -> 小端序 4 字节 hex */
function leHex(n) {
  const x = n >>> 0;
  return (
    ((x & 0xff) >>> 0).toString(16).padStart(2, '0') +
    (((x >>> 8) & 0xff) >>> 0).toString(16).padStart(2, '0') +
    (((x >>> 16) & 0xff) >>> 0).toString(16).padStart(2, '0') +
    (((x >>> 24) & 0xff) >>> 0).toString(16).padStart(2, '0')
  );
}

/** 32 位整数 -> 大端序 4 字节 hex（标准 SHA-1 输出） */
function beHex(n) {
  const x = n >>> 0;
  return (
    (((x >>> 24) & 0xff) >>> 0).toString(16).padStart(2, '0') +
    (((x >>> 16) & 0xff) >>> 0).toString(16).padStart(2, '0') +
    (((x >>> 8) & 0xff) >>> 0).toString(16).padStart(2, '0') +
    ((x & 0xff) >>> 0).toString(16).padStart(2, '0')
  );
}

export class SHA1 {
  constructor() {
    this.h = SHA1_INIT.slice();
    this.length = 0; // 已 update 的字节总数
    this.tail = new Uint8Array(0);
  }

  update(input) {
    const data = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (!data.length) return this;
    this.length += data.length;

    let buf;
    if (this.tail.length) {
      buf = new Uint8Array(this.tail.length + data.length);
      buf.set(this.tail, 0);
      buf.set(data, this.tail.length);
    } else {
      buf = data;
    }

    const usable = buf.length - (buf.length % 64);
    for (let off = 0; off < usable; off += 64) this._block(buf, off);
    this.tail = usable === buf.length ? new Uint8Array(0) : buf.slice(usable);
    return this;
  }

  _block(buf, off) {
    const w = new Uint32Array(80);
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      w[i] = ((buf[j] << 24) | (buf[j + 1] << 16) | (buf[j + 2] << 8) | buf[j + 3]) >>> 0;
    }
    for (let i = 16; i < 80; i++) {
      w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    }

    let a = this.h[0];
    let b = this.h[1];
    let c = this.h[2];
    let d = this.h[3];
    let e = this.h[4];

    for (let i = 0; i < 80; i++) {
      let f;
      let k;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = (rotl(a, 5) + (f >>> 0) + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = temp;
    }

    this.h[0] = (this.h[0] + a) >>> 0;
    this.h[1] = (this.h[1] + b) >>> 0;
    this.h[2] = (this.h[2] + c) >>> 0;
    this.h[3] = (this.h[3] + d) >>> 0;
    this.h[4] = (this.h[4] + e) >>> 0;
  }

  /**
   * 内部状态（h0–h4）按小端序输出为 40 字符 hex。
   * 微云用它作为「非最后分块」的 sha 值。
   *
   * 前提：缓冲区必须为空，也就是已处理数据长度是 64 的整数倍。
   * 微云协议天然满足——分块 512KB、checkBlockSize 是 128 的约数，两者都是 64 的倍数。
   * 不满足时抛错而不是静默返回错误哈希，避免上传到一半才发现校验失败。
   */
  getStateHex() {
    if (this.tail.length !== 0) {
      throw new Error(
        `SHA1.getStateHex 要求缓冲区为空，当前残留 ${this.tail.length} 字节。` +
          '调用方需保证已处理数据长度是 64 的整数倍。'
      );
    }
    return this.h.map(leHex).join('');
  }

  /** 标准 SHA-1 摘要（大端序，与 hashlib/crypto 一致），不改变自身状态 */
  hexdigest() {
    const c = this.copy();
    const bitLen = c.length * 8;

    // padding：0x80 + 若干 0x00，使总长 ≡ 56 (mod 64)，再补 8 字节大端长度
    const tailLen = c.tail.length;
    const zeros = (55 - tailLen + 64) % 64;
    const pad = new Uint8Array(1 + zeros + 8);
    pad[0] = 0x80;
    const hi = Math.floor(bitLen / 0x100000000) >>> 0;
    const lo = bitLen >>> 0;
    pad[pad.length - 8] = (hi >>> 24) & 0xff;
    pad[pad.length - 7] = (hi >>> 16) & 0xff;
    pad[pad.length - 6] = (hi >>> 8) & 0xff;
    pad[pad.length - 5] = hi & 0xff;
    pad[pad.length - 4] = (lo >>> 24) & 0xff;
    pad[pad.length - 3] = (lo >>> 16) & 0xff;
    pad[pad.length - 2] = (lo >>> 8) & 0xff;
    pad[pad.length - 1] = lo & 0xff;

    c.update(pad);
    return c.h.map(beHex).join('');
  }

  copy() {
    const n = new SHA1();
    n.h = this.h.slice();
    n.length = this.length;
    n.tail = this.tail.slice();
    return n;
  }
}

/* ------------------------------------------------------------------ MD5 */

const MD5_SHIFT = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

/** K[i] = floor(|sin(i+1)| × 2^32)，按 RFC 1321 的定义现算，避免贴一大张常量表 */
const MD5_K = (() => {
  const k = new Uint32Array(64);
  for (let i = 0; i < 64; i++) {
    k[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
  }
  return k;
})();

export class MD5 {
  constructor() {
    this.h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
    this.length = 0;
    this.tail = new Uint8Array(0);
  }

  update(input) {
    const data = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (!data.length) return this;
    this.length += data.length;

    let buf;
    if (this.tail.length) {
      buf = new Uint8Array(this.tail.length + data.length);
      buf.set(this.tail, 0);
      buf.set(data, this.tail.length);
    } else {
      buf = data;
    }

    const usable = buf.length - (buf.length % 64);
    for (let off = 0; off < usable; off += 64) this._block(buf, off);
    this.tail = usable === buf.length ? new Uint8Array(0) : buf.slice(usable);
    return this;
  }

  _block(buf, off) {
    const M = new Uint32Array(16);
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      // MD5 输入按小端序读取
      M[i] = (buf[j] | (buf[j + 1] << 8) | (buf[j + 2] << 16) | (buf[j + 3] << 24)) >>> 0;
    }

    let a = this.h[0];
    let b = this.h[1];
    let c = this.h[2];
    let d = this.h[3];

    for (let i = 0; i < 64; i++) {
      let f;
      let g;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      f = (f + a + MD5_K[i] + M[g]) >>> 0;
      a = d;
      d = c;
      c = b;
      b = (b + rotl(f, MD5_SHIFT[i])) >>> 0;
    }

    this.h[0] = (this.h[0] + a) >>> 0;
    this.h[1] = (this.h[1] + b) >>> 0;
    this.h[2] = (this.h[2] + c) >>> 0;
    this.h[3] = (this.h[3] + d) >>> 0;
  }

  hexdigest() {
    const c = this.copy();
    const bitLen = c.length * 8;
    const tailLen = c.tail.length;
    const zeros = (55 - tailLen + 64) % 64;
    const pad = new Uint8Array(1 + zeros + 8);
    pad[0] = 0x80;
    // MD5 的 64 位长度按小端序追加
    const lo = bitLen >>> 0;
    const hi = Math.floor(bitLen / 0x100000000) >>> 0;
    pad[pad.length - 8] = lo & 0xff;
    pad[pad.length - 7] = (lo >>> 8) & 0xff;
    pad[pad.length - 6] = (lo >>> 16) & 0xff;
    pad[pad.length - 5] = (lo >>> 24) & 0xff;
    pad[pad.length - 4] = hi & 0xff;
    pad[pad.length - 3] = (hi >>> 8) & 0xff;
    pad[pad.length - 2] = (hi >>> 16) & 0xff;
    pad[pad.length - 1] = (hi >>> 24) & 0xff;

    c.update(pad);
    return c.h.map(leHex).join('');
  }

  copy() {
    const n = new MD5();
    n.h = this.h.slice();
    n.length = this.length;
    n.tail = this.tail.slice();
    return n;
  }
}

/* ------------------------------------------------------------------ 便捷函数 */

export function sha1Hex(bytes) {
  return new SHA1().update(bytes).hexdigest();
}

export function md5Hex(bytes) {
  return new MD5().update(bytes).hexdigest();
}

export function utf8Bytes(str) {
  return new TextEncoder().encode(str);
}

export function bytesToBase64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
