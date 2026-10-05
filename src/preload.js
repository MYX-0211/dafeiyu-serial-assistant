/**
 * 预加载脚本 —— 通过 contextBridge 把主进程能力安全地暴露给渲染层
 * 渲染层不接触 Node，只拿到这一组白名单 API。
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('native', {
  isDesktop: true,
  platform: process.platform,

  /* ---------- 链路（串口 / TCP / UDP 统一接口） ---------- */
  listPorts: () => ipcRenderer.invoke('link:list-ports'),
  open: (cfg) => ipcRenderer.invoke('link:open', cfg),
  close: () => ipcRenderer.invoke('link:close'),
  write: (data) => ipcRenderer.send('link:write', data),
  setSignals: (s) => ipcRenderer.invoke('link:signals', s),
  info: () => ipcRenderer.invoke('link:info'),

  onData: (cb) => ipcRenderer.on('link:data', (e, buf) => cb(buf instanceof Uint8Array ? buf : new Uint8Array(buf))),
  onPortsChanged: (cb) => ipcRenderer.on('link:ports-changed', (e, list) => cb(list)),
  onClosed: (cb) => ipcRenderer.on('link:closed', (e, info) => cb(info)),
  onError: (cb) => ipcRenderer.on('link:error', (e, msg) => cb(msg)),
  onPeer: (cb) => ipcRenderer.on('link:peer', (e, info) => cb(info)),

  /* ---------- 文件 / 系统 ---------- */
  saveFile: (payload) => ipcRenderer.invoke('file:save', payload),
  appInfo: () => ipcRenderer.invoke('app:info'),
  localIPs: () => ipcRenderer.invoke('net:local-ip')
});
