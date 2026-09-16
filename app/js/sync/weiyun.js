/**
 * 微云同步通道
 *
 * 用的是微云官方 MCP 服务（`https://www.weiyun.com/api/v3/mcpserver`），
 * 走 JSON-RPC over HTTP，鉴权只需一个自助获取的 mcp_token，
 * 不需要开发者资质、不需要应用审核。
 *
 * ─── 为什么之前说「微云不对个人开放」，现在又做了通道 ───
 * 早先的判断基于 2013 年 QQ 互联时代的 `graph.qq.com/weiyun/*` REST 接口，
 * 那套确实已停止对个人发放。但微云后来上线了官方 MCP 服务，
 * 任何用户都能在 https://www.weiyun.com/act/openclaw 用 QQ/微信扫码自助领取 mcp_token。
 * 所以正确的结论是：**REST 开放平台对个人关闭，MCP 服务对个人开放**。
 *
 * ─── 平台限制（实测，非推测） ───
 * MCP 端点不返回任何 CORS 响应头（预检 OPTIONS 直接 401 且无 Access-Control-Allow-Origin）。
 * 因此：
 *   · 桌面端（Electron）✅ 由主进程代发请求，不受同源策略约束
 *   · 浏览器 / PWA / Android ⛔ 会被预检拦掉
 *
 * ─── 上传协议 ───
 * 微云不用标准的分块 SHA1，而是用 **流式 SHA1 的内部寄存器状态**（小端序）。
 * 算法与官方脚本 tools 保持一致，正确性由 tools/verify.mjs 对照 Node crypto 与 Python 参考实现校验。
 */

import { SHA1, MD5, utf8Bytes, bytesToBase64 } from '../hash.js';
import { httpRequest, isDesktop } from './http.js';

export const MCP_URL = 'https://www.weiyun.com/api/v3/mcpserver';
export const BLOCK_SIZE = 524288; // 512 KB
export const TOKEN_URL = 'https://www.weiyun.com/act/openclaw';
const APP_CHANNEL = 'AIPROMPTHUB';

/* ------------------------------------------------------------------ 上传参数 */

/**
 * 计算微云上传所需的全部校验参数
 *
 * 与官方 gen_block_info_list.py 逐字段对齐：
 *   1. 共用一个 SHA1 对象流式处理整个文件
 *   2. 非最后分块的 sha = 处理完该块后的内部状态（h0-h4 小端序）
 *   3. 最后一块的 sha = 整个文件的标准 SHA1（大端序）
 *   4. check_sha = 处理完「最后一块去掉末尾 checkBlockSize 字节」后的内部状态
 *   5. check_data = 文件末尾 checkBlockSize 字节的 Base64
 *
 * @param {Uint8Array} bytes
 */
export function computeUploadParams(bytes) {
  const fileSize = bytes.length;
  if (fileSize === 0) throw new Error('文件为空，无法上传');

  let lastBlockSize = fileSize % BLOCK_SIZE;
  if (lastBlockSize === 0) lastBlockSize = BLOCK_SIZE;

  let checkBlockSize = lastBlockSize % 128;
  if (checkBlockSize === 0) checkBlockSize = 128;

  const beforeBlockSize = fileSize - lastBlockSize;

  const sha1 = new SHA1();
  const blockShaList = [];

  // 除最后一块外的所有分块：取内部状态，注意此时缓冲区必为空
  // （524288 是 64 的整数倍，getStateHex 的断言天然成立）
  for (let offset = 0; offset < beforeBlockSize; offset += BLOCK_SIZE) {
    sha1.update(bytes.subarray(offset, offset + BLOCK_SIZE));
    blockShaList.push(sha1.getStateHex());
  }

  // 最后一块：先吃掉靠前的部分拿 check_sha，再吃掉尾部拿最终摘要
  const betweenEnd = fileSize - checkBlockSize;
  sha1.update(bytes.subarray(beforeBlockSize, betweenEnd));
  const checkSha = sha1.getStateHex();

  const checkBytes = bytes.subarray(betweenEnd, fileSize);
  sha1.update(checkBytes);
  const fileSha = sha1.hexdigest();

  blockShaList.push(fileSha);

  return {
    fileSize,
    fileSha,
    fileMd5: new MD5().update(bytes).hexdigest(),
    checkSha,
    checkData: bytesToBase64(checkBytes),
    blockShaList,
    blockCount: blockShaList.length,
    lastBlockSize,
    checkBlockSize,
  };
}

/* ------------------------------------------------------------------ MCP 调用 */

let requestSeq = 0;

function qua() {
  const platform = isDesktop() ? 'WINDOWS' : 'WEB';
  return `${platform}_1.0_${APP_CHANNEL}_1.0.0`;
}

function parseMcpResponse(r) {
  const data = r.data;
  if (!data) throw new Error(`微云接口返回空响应（HTTP ${r.status}）`);
  if (data.error) {
    const msg = data.error.message || data.error.data || JSON.stringify(data.error);
    throw new Error(`微云接口错误：${msg}`);
  }
  const content = data.result?.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item.type === 'text' && typeof item.text === 'string') {
        try {
          return JSON.parse(item.text);
        } catch (_) {
          return { text: item.text };
        }
      }
    }
  }
  return data.result ?? null;
}

const RETRYABLE = /50000|服务繁忙|back end fail|117406/i;

/**
 * 调用一个微云 MCP 工具
 * @param {object} cfg  { mcpToken }
 * @param {string} tool 例如 weiyun.list
 * @param {object} args
 */
export async function mcpCall(cfg, tool, args = {}) {
  const token = String(cfg.mcpToken || '').trim();
  if (!token) throw new Error('缺少微云 Token，请先到设置里填写');

  const payload = {
    jsonrpc: '2.0',
    id: ++requestSeq,
    method: 'tools/call',
    params: {
      name: tool,
      arguments: { ...args, req_header: { qua: qua(), version: '1.0.0' } },
    },
  };

  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await httpRequest(MCP_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          WyHeader: `mcp_token=${token}`,
        },
        body: JSON.stringify(payload),
        timeout: 120000,
      });

      if (res.status === 401) {
        throw new Error('Token 无效或已过期，请到 weiyun.com/act/openclaw 重新获取');
      }
      if (res.status === 429) {
        throw new Error('今日调用配额已用完，请明天再试');
      }
      if (!res.ok && !res.text) {
        throw new Error(`微云接口 HTTP ${res.status}`);
      }

      let parsed;
      try {
        parsed = JSON.parse(res.text);
      } catch (_) {
        throw new Error(`微云接口响应无法解析（HTTP ${res.status}）：${res.text.slice(0, 160)}`);
      }

      const out = parseMcpResponse({ ...res, data: parsed });

      // 业务层错误：可重试的重试，其余直接抛
      const errText = out && typeof out === 'object' ? String(out.error || out.errmsg || '') : '';
      if (errText) {
        if (RETRYABLE.test(errText) && attempt < 3) {
          lastErr = new Error(errText);
          await sleep(2000 + attempt * 1000);
          continue;
        }
        throw new Error(`微云接口返回错误：${errText}`);
      }
      return out;
    } catch (e) {
      lastErr = e;
      const retryable = RETRYABLE.test(String(e.message)) || /超时|timeout|ETIMEDOUT/i.test(String(e.message));
      if (retryable && attempt < 3) {
        await sleep(2000 + attempt * 1000);
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error('微云接口调用失败');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ 目录与文件 */

/** 列出目录内容。不传参数即为 token 绑定的默认目录。 */
async function listDir(cfg, { dirKey, pdirKey } = {}) {
  const args = { limit: 50, get_type: 0, order_by: 2, asc: false };
  if (dirKey) args.dir_key = dirKey;
  if (pdirKey) args.pdir_key = pdirKey;
  return mcpCall(cfg, 'weiyun.list', args);
}

/**
 * 定位（必要时创建）数据存放目录
 * @returns {Promise<{key:string, name:string, rootPdirKey:string, created:boolean}>}
 */
async function resolveContainer(cfg) {
  const root = await listDir(cfg);
  const rootKey = root.pdir_key;
  if (!rootKey) throw new Error('未能获取微云默认目录，请检查 Token 是否有效');

  const dirName = String(cfg.remoteDir || '').trim();
  if (!dirName) return { key: rootKey, name: '（默认目录）', rootPdirKey: rootKey, created: false };

  const hit = (root.dir_list || []).find((d) => d.dir_name === dirName);
  if (hit) return { key: hit.dir_key, name: hit.dir_name, rootPdirKey: rootKey, created: false };

  const created = await mcpCall(cfg, 'weiyun.create_dir', { pdir_key: rootKey, dir_name: dirName });
  if (!created.dir_key) throw new Error(`创建目录失败：${created.error || '未知原因'}`);
  return { key: created.dir_key, name: created.dir_name || dirName, rootPdirKey: rootKey, created: true };
}

/** 在指定目录里按文件名查找文件 */
async function findFile(cfg, containerKey, filename) {
  const list = await listDir(cfg, { dirKey: containerKey, pdirKey: containerKey });
  const files = list.file_list || [];
  return files.find((f) => f.filename === filename) || null;
}

/* ------------------------------------------------------------------ 上传 */

/**
 * 两阶段上传：预上传拿通道 → 逐片上传，直到 upload_state = 2。
 * 每一轮都要重新预上传，因为服务端返回的通道是短时有效的。
 */
async function uploadBytes(cfg, containerKey, filename, bytes) {
  const p = computeUploadParams(bytes);
  const baseArgs = {
    filename,
    file_size: p.fileSize,
    file_sha: p.fileSha,
    file_md5: p.fileMd5,
    block_sha_list: p.blockShaList,
    check_sha: p.checkSha,
    check_data: p.checkData,
    pdir_key: containerKey,
  };

  for (let round = 1; round <= 60; round++) {
    const pre = await mcpCall(cfg, 'weiyun.upload', baseArgs);

    if (pre.file_exist) {
      return { fileId: pre.file_id, filename: pre.filename || filename, instant: true };
    }

    const channelList = pre.channel_list || [];
    const channel = channelList.find((c) => Number(c.len) > 0);

    if (!channel) {
      if (Number(pre.upload_state) === 2) {
        return { fileId: pre.file_id, filename: pre.filename || filename, instant: false };
      }
      throw new Error(`微云未返回可用上传通道（upload_state=${pre.upload_state}）`);
    }

    const offset = Number(channel.offset);
    const len = Math.min(Number(channel.len), bytes.length - offset);
    if (len <= 0) throw new Error(`分片长度异常：offset=${offset}, len=${len}`);

    const up = await mcpCall(cfg, 'weiyun.upload', {
      filename,
      file_size: p.fileSize,
      file_sha: p.fileSha,
      block_sha_list: [],
      check_sha: p.checkSha,
      upload_key: pre.upload_key,
      channel_list: channelList.map((c) => ({
        id: Number(c.id),
        offset: Number(c.offset),
        len: Number(c.len),
      })),
      channel_id: Number(channel.id),
      ex: pre.ex,
      file_data: bytesToBase64(bytes.subarray(offset, offset + len)),
    });

    if (Number(up.upload_state) === 2) {
      return { fileId: up.file_id, filename: up.filename || filename, instant: false };
    }
  }

  throw new Error('上传轮数超过上限，未完成');
}

/* ------------------------------------------------------------------ 通道对象 */

export const weiyun = {
  key: 'weiyun',
  name: '腾讯微云',
  desc: '调用微云官方 MCP 服务，Token 用 QQ/微信扫码自助领取，无需开发者申请。桌面端完整可用；手机浏览器会被跨域策略拦住。',
  fields: [
    {
      key: 'mcpToken',
      label: '微云 Token',
      type: 'password',
      required: true,
      hint: '打开下面的页面，用 QQ 或微信扫码登录，复制得到的 Token 粘贴到这里。Token 只保存在本机，且不会同步到云端。',
      link: TOKEN_URL,
    },
    {
      key: 'remoteDir',
      label: '云端存放文件夹',
      type: 'text',
      default: 'AI-PromptHub',
      hint: '会在微云根目录下自动创建这个文件夹。留空则直接放在 Token 绑定的默认目录里。',
    },
    {
      key: 'fileName',
      label: '数据文件名',
      type: 'text',
      default: 'ai-prompt-hub.json',
      hint: '多台设备必须保持一致，否则会各写各的文件。',
    },
  ],

  available: () => true,

  unavailableReason() {
    return isDesktop()
      ? ''
      : '微云 MCP 端点不返回跨域头，浏览器端（含手机 PWA）会被预检拦掉。请用桌面端，或换用 GitHub Gist / WebDAV。';
  },

  async test(cfg) {
    if (!String(cfg.mcpToken || '').trim()) throw new Error('请先填写微云 Token');

    const root = await listDir(cfg);
    if (root.error) throw new Error(root.error);

    const dirCount = (root.dir_list || []).length;
    const fileCount = (root.file_list || []).length;
    const container = await resolveContainer(cfg);

    const note = isDesktop()
      ? ''
      : '　⚠ 当前在浏览器环境，实际同步时可能被跨域策略拦截，建议改用桌面端。';

    return {
      ok: true,
      message:
        `已连接微云。默认目录内 ${dirCount} 个文件夹 / ${fileCount} 个文件；` +
        `数据将存放在「${container.name}」。${note}`,
    };
  },

  async pull(cfg) {
    const filename = cfg.fileName || 'ai-prompt-hub.json';
    const container = await resolveContainer(cfg);
    const file = await findFile(cfg, container.key, filename);
    if (!file) return null;

    const dl = await mcpCall(cfg, 'weiyun.download', {
      items: [{ file_id: file.file_id, pdir_key: container.key }],
    });
    const item = (dl.items || [])[0];
    if (!item || !item.https_download_url) {
      throw new Error(`未获取到下载链接${item?.error ? '：' + item.error : ''}`);
    }

    const res = await httpRequest(item.https_download_url, {
      method: 'GET',
      headers: item.cookie ? { Cookie: item.cookie } : {},
      timeout: 90000,
      // CDN 下载链接走原生通道，避免浏览器端的跨域与混合内容限制
      viaNative: true,
    });
    if (!res.ok) throw new Error(`下载数据文件失败（HTTP ${res.status}）`);
    if (!res.text) return null;
    return JSON.parse(res.text);
  },

  async push(cfg, snapshot) {
    const filename = cfg.fileName || 'ai-prompt-hub.json';
    const bytes = utf8Bytes(JSON.stringify(snapshot, null, 2));
    const container = await resolveContainer(cfg);

    // 先删后传：微云同名上传的行为是「自动改名」而不是覆盖，
    // 不删的话每同步一次就多出一份历史副本，很快会把目录塞满。
    // 删除文件不需要二次确认（删除目录才需要）。
    const existing = await findFile(cfg, container.key, filename);
    if (existing) {
      await mcpCall(cfg, 'weiyun.delete', {
        file_list: [{ file_id: existing.file_id, pdir_key: container.key }],
        delete_completely: true,
      });
    }

    const up = await uploadBytes(cfg, container.key, filename, bytes);
    const sizeKb = (bytes.length / 1024).toFixed(1);

    return {
      rev: snapshot.exportedAt,
      fileId: up.fileId,
      name: up.filename,
      message:
        `已${up.instant ? '秒传' : '上传'}到微云 ${container.name}/${filename}（${sizeKb} KB）` +
        (up.filename !== filename ? `　注意：文件名被云端改为「${up.filename}」` : ''),
    };
  },

  /* 暴露给测试脚本用 */
  _internal: { listDir, resolveContainer, findFile, uploadBytes },
};
