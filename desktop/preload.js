/**
 * 预加载脚本：向渲染层暴露一组受限的原生能力
 *
 * 安全约定
 *   - contextIsolation 开启，渲染层拿不到 Node
 *   - 只暴露白名单方法，不接受任意命令执行
 *   - 文件读写只在用户选定的同步目录内使用（由渲染层传路径，用户可见）
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__aiph', {
  isDesktop: true,
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },

  /** 通用 HTTP 转发，用于绕开渲染层的跨域限制 */
  httpRequest: (opts) => ipcRenderer.invoke('aiph:http', opts),

  /** 读取文本文件，返回 {exists, content} */
  fsRead: (filePath) => ipcRenderer.invoke('aiph:fs-read', filePath),

  /** 原子写入文本文件 */
  fsWrite: (filePath, content) => ipcRenderer.invoke('aiph:fs-write', filePath, content),

  /** 路径信息 {exists, isDirectory, size, mtime} */
  fsStat: (target) => ipcRenderer.invoke('aiph:fs-stat', target),

  /** 弹出目录选择框，返回 {path} */
  pickDirectory: () => ipcRenderer.invoke('aiph:pick-directory'),

  /** 用系统浏览器打开链接 */
  openExternal: (url) => ipcRenderer.invoke('aiph:open-external', url),

  /** 应用与运行环境信息 */
  appInfo: () => ipcRenderer.invoke('aiph:app-info'),

  /** 监听菜单事件：onMenu((action) => {})，action ∈ new | import | export */
  onMenu: (handler) => {
    const listener = (_e, action) => handler(action);
    ipcRenderer.on('aiph:menu', listener);
    return () => ipcRenderer.removeListener('aiph:menu', listener);
  },
});
