/**
 * 打印某个文件的微云上传参数，用于与官方 Python 脚本交叉验证。
 *
 * 存在的理由：SHA-1 的最终摘要有标准实现可以对拍（Node crypto 就行），
 * 但微云用的是**未经 finalization 的内部寄存器状态**，没有标准库能验证。
 * 唯一可信的参照物是微云官方提供的 gen_block_info_list.py。
 *
 * 用法：
 *   node tools/weiyun-params.mjs <文件路径>
 *
 * 与官方脚本对拍（需本机有 python）：
 *   python <微云skill>/scripts/gen_block_info_list.py <文件路径>
 *   两者输出的 file_sha / check_sha / block_sha_list 必须完全一致
 */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const APP_JS = path.resolve(__dirname, '..', 'app', 'js');

// app 下的模块是浏览器 ESM（无 package.json type），拷到带 type:module 的临时目录再导入
const TMP = path.join(__dirname, '.params-tmp');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(path.join(TMP, 'js'), { recursive: true });
for (const f of fs.readdirSync(APP_JS, { withFileTypes: true })) {
  if (f.isFile() && f.name.endsWith('.js')) {
    fs.copyFileSync(path.join(APP_JS, f.name), path.join(TMP, 'js', f.name));
  }
}
fs.mkdirSync(path.join(TMP, 'js', 'sync'), { recursive: true });
for (const f of fs.readdirSync(path.join(APP_JS, 'sync'))) {
  fs.copyFileSync(path.join(APP_JS, 'sync', f), path.join(TMP, 'js', 'sync', f));
}
fs.writeFileSync(path.join(TMP, 'package.json'), '{"type":"module"}', 'utf8');

const { computeUploadParams } = await import(
  url.pathToFileURL(path.join(TMP, 'js', 'sync', 'weiyun.js')).href + '?t=' + Date.now()
);

const filePath = process.argv[2];
if (!filePath || !fs.existsSync(filePath)) {
  console.error('用法：node tools/weiyun-params.mjs <文件路径>');
  process.exit(1);
}

const bytes = new Uint8Array(fs.readFileSync(filePath));
const p = computeUploadParams(bytes);

console.log(`file_path:  ${path.resolve(filePath)}`);
console.log(`filename:   ${path.basename(filePath)}`);
console.log(`file_size:  ${p.fileSize}`);
console.log(`file_sha:   ${p.fileSha}`);
console.log(`file_md5:   ${p.fileMd5}`);
console.log(`check_sha:  ${p.checkSha}`);
console.log(`check_data: ${p.checkData}`);
console.log(`block_size: 524288`);
console.log(`block_count: ${p.blockCount}`);
console.log();
console.log('block_sha_list (for McpUploadReq.block_sha_list):');
console.log(JSON.stringify(p.blockShaList, null, 2));

fs.rmSync(TMP, { recursive: true, force: true });
