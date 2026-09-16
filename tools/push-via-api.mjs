/**
 * 通过 GitHub REST API 推送本地 git 历史（不依赖 git 协议）
 *
 * 适用场景：所处网络屏蔽了 github.com:443（git push 会报
 * `CONNECT tunnel failed` 或连接超时），但 api.github.com 可以访问。
 * 这种情况下 `git push` 无论如何都走不通，只能绕到 API。
 *
 * 原理：把本地每个提交用 Git Data API 重放一遍
 *   1. 逐个提交：本地 blob → 远端 blob（base64，二进制安全）
 *   2. 组装完整 tree
 *   3. 创建 commit（父提交：第一个提交接在远端当前 HEAD 上，其余接上一个新提交）
 *   4. 最后把分支引用指到最后一个新提交
 *
 * 产出与 `git push` 完全等价：相同的历史结构、相同的提交信息与时间戳、
 * 相同的文件字节内容（含二进制文件）。
 *
 * 用法：
 *   GITHUB_TOKEN=ghp_xxx node tools/push-via-api.mjs
 *   GITHUB_TOKEN=ghp_xxx node tools/push-via-api.mjs --dry-run
 *
 * 环境变量：
 *   GITHUB_TOKEN  必填。需要 repo 权限（classic）或 Contents:write（fine-grained）
 *   GH_OWNER      默认 hongrui023
 *   GH_REPO       默认 promots
 *   GH_BRANCH     默认 main
 *
 * 安全提示：Token 只从环境变量读取，不写入任何文件。
 *           用完请到 https://github.com/settings/tokens 撤销。
 */

import { execFileSync } from 'node:child_process';

const TOKEN = process.env.GITHUB_TOKEN || '';
const OWNER = process.env.GH_OWNER || 'hongrui023';
const REPO = process.env.GH_REPO || 'promots';
const BRANCH = process.env.GH_BRANCH || 'main';
const DRY = process.argv.includes('--dry-run');

const API = 'https://api.github.com';

if (!TOKEN) {
  console.error('缺少 GITHUB_TOKEN 环境变量');
  process.exit(1);
}

/* ------------------------------------------------------------------ 工具 */

const gitBuf = (...args) => execFileSync('git', args, { maxBuffer: 1024 * 1024 * 512 });
const gitText = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 512 }).replace(/\n+$/, '');

let apiCalls = 0;

async function api(path, { method = 'GET', body } = {}) {
  apiCalls++;
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'ai-prompt-hub-api-push',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {
    data = text;
  }

  if (!res.ok) {
    const detail = data && typeof data === 'object' ? data.message || JSON.stringify(data) : String(text).slice(0, 200);
    throw new Error(`${method} ${path} → HTTP ${res.status}：${detail}`);
  }
  return data;
}

function fmt(n) {
  return n.toLocaleString('en-US');
}

/* ------------------------------------------------------------------ 前置检查 */

console.log('\x1b[1m\x1b[35m通过 API 推送 git 历史\x1b[0m');
console.log(`\x1b[90m目标 ${OWNER}/${REPO}  分支 ${BRANCH}${DRY ? '  [DRY RUN]' : ''}\x1b[0m\n`);

const me = await api('/user');
console.log(`  身份：${me.login}`);

const repo = await api(`/repos/${OWNER}/${REPO}`);
if (!repo.permissions?.push) throw new Error(`没有 ${OWNER}/${REPO} 的推送权限`);
console.log(`  仓库：${repo.full_name}（${repo.private ? '私有' : '公开'}，默认分支 ${repo.default_branch}）`);

let ref = null;
let remoteHead = null;
try {
  ref = await api(`/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
  remoteHead = ref.object.sha;
  console.log(`  远端 HEAD：${remoteHead.slice(0, 8)}`);
} catch (e) {
  if (!/HTTP 404/.test(e.message)) throw e;
  console.log('  远端分支尚不存在，将创建');
}

/* ------------------------------------------------------------------ 读取本地历史 */

const commits = gitText('rev-list', '--reverse', 'HEAD').split('\n').filter(Boolean);
console.log(`  本地提交：${commits.length} 个\n`);

if (!commits.length) {
  console.error('本地没有提交');
  process.exit(1);
}

const blobCache = new Map(); // 本地 blob sha -> 远端 blob sha
let parentSha = remoteHead;

/* ------------------------------------------------------------------ 逐提交重放 */

for (let i = 0; i < commits.length; i++) {
  const sha = commits[i];
  const short = sha.slice(0, 8);

  const message = gitText('log', '-1', '--format=%B', sha);
  const metaRaw = gitText('log', '-1', '--format=%an%x1f%ae%x1f%aI%x1f%cn%x1f%ce%x1f%cI', sha).split('\x1f');
  const [an, ae, ad, cn, ce, cd] = metaRaw;

  // git ls-tree -r：每行 "<mode> SP <type> SP <sha> TAB <path>"
  const treeLines = gitText('ls-tree', '-r', sha)
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [left, path] = line.split('\t');
      const [mode, type, blobSha] = left.split(/\s+/);
      return { mode, type, blobSha, path };
    })
    .filter((e) => e.type === 'blob');

  console.log(`\x1b[1m[${i + 1}/${commits.length}] ${short}  ${message.split('\n')[0]}\x1b[0m`);
  console.log(`  ${treeLines.length} 个文件`);

  if (DRY) {
    for (const e of treeLines) console.log(`    ${e.mode}  ${e.path}`);
    continue;
  }

  // 1) blob
  const treeEntries = [];
  let newBlobs = 0;
  for (const e of treeLines) {
    let remoteBlobSha = blobCache.get(e.blobSha);
    if (!remoteBlobSha) {
      const raw = gitBuf('cat-file', 'blob', e.blobSha);
      const created = await api(`/repos/${OWNER}/${REPO}/git/blobs`, {
        method: 'POST',
        body: { content: raw.toString('base64'), encoding: 'base64' },
      });
      remoteBlobSha = created.sha;
      blobCache.set(e.blobSha, remoteBlobSha);
      newBlobs++;
    }
    treeEntries.push({ path: e.path, mode: e.mode, type: 'blob', sha: remoteBlobSha });
  }
  console.log(`  新建 blob ${newBlobs} 个，复用 ${treeLines.length - newBlobs} 个`);

  // 2) tree（每次都建完整树，不依赖 base_tree，保证结果可预测）
  const tree = await api(`/repos/${OWNER}/${REPO}/git/trees`, {
    method: 'POST',
    body: { tree: treeEntries },
  });

  // 3) commit
  const commit = await api(`/repos/${OWNER}/${REPO}/git/commits`, {
    method: 'POST',
    body: {
      message,
      tree: tree.sha,
      parents: parentSha ? [parentSha] : [],
      author: { name: an, email: ae, date: ad },
      committer: { name: cn, email: ce, date: cd },
    },
  });

  console.log(`  → 提交 ${commit.sha.slice(0, 8)}  tree ${tree.sha.slice(0, 8)}`);
  parentSha = commit.sha;
}

if (DRY) {
  console.log('\n\x1b[33mDRY RUN：未做任何写操作\x1b[0m\n');
  process.exit(0);
}

/* ------------------------------------------------------------------ 更新分支引用 */

if (ref) {
  await api(`/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, {
    method: 'PATCH',
    body: { sha: parentSha, force: false },
  });
} else {
  await api(`/repos/${OWNER}/${REPO}/git/refs`, {
    method: 'POST',
    body: { ref: `refs/heads/${BRANCH}`, sha: parentSha },
  });
}

console.log(`\n  分支 ${BRANCH} → ${parentSha.slice(0, 8)}`);

/* ------------------------------------------------------------------ 校验 */

const verify = await api(`/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
const okRef = verify.object.sha === parentSha;

const remoteTree = await api(`/repos/${OWNER}/${REPO}/git/trees/${parentSha}?recursive=1`);
const remoteFiles = (remoteTree.tree || []).filter((t) => t.type === 'blob');
const localFiles = gitText('ls-tree', '-r', '--name-only', 'HEAD').split('\n').filter(Boolean);

const missing = localFiles.filter((p) => !remoteFiles.some((r) => r.path === p));

console.log('\n' + '─'.repeat(56));
console.log(`  远端分支已更新：${okRef ? '\x1b[32m是\x1b[0m' : '\x1b[31m否\x1b[0m'}`);
console.log(`  文件数：本地 ${localFiles.length}　远端 ${remoteFiles.length}`);
console.log(`  缺失文件：${missing.length ? '\x1b[31m' + missing.join(', ') + '\x1b[0m' : '\x1b[32m无\x1b[0m'}`);
console.log(`  API 调用次数：${apiCalls}`);
console.log('─'.repeat(56));
console.log(`\n  \x1b[1mhttps://github.com/${OWNER}/${REPO}\x1b[0m\n`);

process.exit(missing.length === 0 && okRef ? 0 : 1);
