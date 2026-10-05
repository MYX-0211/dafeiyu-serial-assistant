/**
 * 串口调试助手 · 桌面版 —— Electron 主进程
 * 职责：窗口 + 链路驱动（串口 / TCP Client / TCP Server / UDP）+ 文件保存
 *
 * 链路抽象：不管串口还是网络，统一成 open / close / write / onData 四个动作，
 * 渲染层不需要关心底层是哪一种。
 */
'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const dgram = require('dgram');
const { SerialPort } = require('serialport');

/* ==========================================================================
   全局状态
   ========================================================================== */
let win = null;
let quitting = false;

let link = null;                        // { kind, write(buf), close() }
let serialPort = null;                  // 串口实例（用于 setSignals）
let linkInfo = { mode: 'none', label: '' };
let rxBatch = [];
let rxTimer = null;
let rxBytes = 0;
let txBytes = 0;
let pollTimer = null;
let lastPortKey = '';

let tcpServer = null;
let tcpClient = null;
let udpSock = null;
let closing = false;      // 主动关闭中：屏蔽自己触发的 close 事件，避免误报“连接已断开”

const isDev = !app.isPackaged;

/* ==========================================================================
   启动 / 内存优化
   --------------------------------------------------------------------------
   · 限制 V8 堆：串口长时间高速接收时，日志缓冲在 500 KB 就会滚动清理，
     给 256 MB 足够用，同时避免异常情况下的内存失控
   · 关掉用不到的 Chromium 特性，减少常驻内存与启动开销
   · 注意：不能禁用 GPU —— 界面的毛玻璃（backdrop-filter）依赖 GPU 合成
   ========================================================================== */
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=256');
app.commandLine.appendSwitch('disable-features', 'MediaRouter,CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('renderer-process-limit', '1');   // 只开一个渲染进程，省内存

/* ==========================================================================
   窗口状态记忆
   ========================================================================== */
function stateFile() {
  return path.join(app.getPath('userData'), 'window-state.json');
}
function readState() {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    if (s && typeof s === 'object') return s;
  } catch (_) { }
  return null;
}
function writeState() {
  if (!win || win.isDestroyed()) return;
  try {
    const b = win.getNormalBounds ? win.getNormalBounds() : win.getBounds();
    fs.writeFileSync(stateFile(), JSON.stringify({
      x: b.x, y: b.y, width: b.width, height: b.height,
      maximized: win.isMaximized()
    }), 'utf8');
  } catch (_) { }
}

/* ==========================================================================
   窗口
   ========================================================================== */
function createWindow() {
  const st = readState() || {};
  const bounds = {
    width: Math.max(880, st.width || 1020),
    height: Math.max(560, st.height || 680)
  };
  if (typeof st.x === 'number' && typeof st.y === 'number') {
    bounds.x = st.x; bounds.y = st.y;
  }

  win = new BrowserWindow({
    ...bounds,
    minWidth: 840,
    minHeight: 500,
    show: false,
    frame: true,
    autoHideMenuBar: true,
    backgroundColor: '#F2F2F7',
    title: '大肥鱼串口助手',
    icon: path.join(__dirname, 'renderer', 'assets', 'app.ico'),   // 放在打包范围内，否则会回退成默认图标
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      spellcheck: false
    }
  });

  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.once('ready-to-show', () => {
    win.show();
    if (st.maximized) win.maximize();
  });

  let saveTimer = null;
  const saveSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(writeState, 400); };
  win.on('resize', saveSoon);
  win.on('move', saveSoon);
  win.on('close', writeState);
  win.on('closed', () => { win = null; });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev) {
    win.webContents.on('before-input-event', (e, input) => {
      if (input.control && input.shift && input.key.toLowerCase() === 'i') {
        win.webContents.toggleDevTools();
      }
    });
  }
}

/* ==========================================================================
   数据上行
   ========================================================================== */
function flushRx() {
  rxTimer = null;
  if (!rxBatch.length) return;
  if (!win || win.isDestroyed()) { rxBatch = []; return; }
  const total = rxBatch.reduce((a, b) => a + b.length, 0);
  const merged = Buffer.concat(rxBatch, total);
  rxBatch = [];
  rxBytes += total;
  win.webContents.send('link:data', new Uint8Array(merged));
}
function onLinkData(chunk) {
  rxBatch.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (!rxTimer) rxTimer = setTimeout(flushRx, 16);
}
function send(ch, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(ch, payload);
}

/* ==========================================================================
   枚举串口
   ========================================================================== */
async function listPorts() {
  try {
    const list = await SerialPort.list();
    return list
      .map((p) => ({
        path: p.path || '',
        manufacturer: p.manufacturer || '',
        friendlyName: p.friendlyName || '',
        serialNumber: p.serialNumber || '',
        vendorId: p.vendorId || '',
        productId: p.productId || ''
      }))
      .filter((p) => p.path)
      .sort((a, b) => {
        const na = parseInt(String(a.path).replace(/\D/g, ''), 10) || 0;
        const nb = parseInt(String(b.path).replace(/\D/g, ''), 10) || 0;
        return na - nb;
      });
  } catch (e) {
    return [];
  }
}
function startPortWatcher() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    if (!win || win.isDestroyed()) return;
    const list = await listPorts();
    const key = list.map((p) => p.path).join(',');
    if (key !== lastPortKey) {
      const first = lastPortKey === '';
      lastPortKey = key;
      if (!first) send('link:ports-changed', list);
    }
  }, 1500);
}

/* ==========================================================================
   关闭 / 打开 / 写
   ========================================================================== */
function teardown(reason) {
  closing = true;
  try { doTeardown(reason); } finally { closing = false; }
}
function doTeardown(reason) {
  if (rxTimer) { clearTimeout(rxTimer); rxTimer = null; }
  flushRx();
  const old = link;
  link = null;
  linkInfo = { mode: 'none', label: '' };
  if (old) { try { old.close(); } catch (_) { } }
  serialPort = null;
  if (tcpClient) { try { tcpClient.destroy(); } catch (_) { } tcpClient = null; }
  if (tcpServer) { try { tcpServer.close(); } catch (_) { } tcpServer = null; }
  if (udpSock) { try { udpSock.close(); } catch (_) { } udpSock = null; }
  if (reason) send('link:closed', { reason: reason });
}

/* ---------------------------- 串口 ---------------------------- */
function openSerial(cfg) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };

    let p;
    try {
      p = new SerialPort({
        path: cfg.path,
        baudRate: Number(cfg.baudRate) || 115200,
        dataBits: Number(cfg.dataBits) || 8,
        stopBits: cfg.stopBits === '1.5' ? 1.5 : (Number(cfg.stopBits) || 1),
        parity: cfg.parity || 'none',
        rtscts: !!cfg.rtscts,
        xon: !!cfg.xon,
        xoff: !!cfg.xoff,
        dtr: cfg.dtr !== false,
        rts: !!cfg.rts,
        autoOpen: false,
        highWaterMark: 1 << 20
      });
    } catch (e) {
      return done({ ok: false, error: e.message });
    }

    p.on('error', (err) => send('link:error', err.message || String(err)));
    p.on('close', () => { if (!quitting && !closing) teardown('设备已断开或被占用'); });

    p.open((err) => {
      if (err) {
        try { p.removeAllListeners(); } catch (_) { }
        const msg = err.message || String(err);
        let hint = msg;
        if (/Access denied|busy|Cannot open|EBUSY/i.test(msg)) {
          hint = '串口被占用或拒绝访问 —— 请先关闭 SSCOM / XCOM 等其它串口工具后再试';
        } else if (/File not found|ENOENT/i.test(msg)) {
          hint = '找不到该串口，设备可能已被拔出';
        }
        return done({ ok: false, error: hint });
      }
      p.on('data', onLinkData);
      serialPort = p;
      link = {
        kind: 'serial',
        write: function (buf) { return p.write(buf); },
        close: function () {
          try { p.removeAllListeners(); } catch (_) { }
          if (p.isOpen) { try { p.close(() => { }); } catch (_) { } }
        }
      };
      linkInfo = { mode: 'serial', label: cfg.path };
      done({ ok: true, label: cfg.path });
    });
  });
}

/* -------------------------- TCP Client ------------------------ */
function openTcpClient(cfg) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };

    const sock = new net.Socket();
    sock.setNoDelay(true);

    const onErr = (err) => {
      if (settled) { send('link:error', err.message || String(err)); return; }
      let hint = err.message || String(err);
      if (err.code === 'ECONNREFUSED') hint = '连接被拒绝 —— 目标 IP / 端口没有在监听，或被防火墙拦了';
      else if (err.code === 'ETIMEDOUT') hint = '连接超时 —— 检查 IP 是否可达、网线 / 网段是否通';
      else if (err.code === 'ENOTFOUND') hint = '主机名解析失败 —— 检查 IP / 主机名';
      else if (err.code === 'EADDRNOTAVAIL') hint = '本地地址不可用 —— 换「全部网卡」或选一个真正属于本机的网卡地址';
      else if (err.code === 'EHOSTUNREACH' || err.code === 'ENETUNREACH') hint = '目标网络不可达 —— 确认本机和目标在同一网段';
      try { sock.destroy(); } catch (_) { }
      done({ ok: false, error: hint });
    };

    sock.once('error', onErr);
    sock.once('connect', () => {
      settled = true;
      sock.removeListener('error', onErr);
      sock.on('error', (err) => send('link:error', err.message || String(err)));
      sock.on('data', onLinkData);
      sock.on('close', () => { if (!quitting && !closing) teardown('连接已断开'); });
      link = {
        kind: 'tcp-client',
        write: function (buf) { return sock.write(buf); },
        close: function () { try { sock.destroy(); } catch (_) { } }
      };
      linkInfo = { mode: 'tcp-client', label: cfg.remoteHost + ':' + cfg.remotePort };
      done({ ok: true, label: linkInfo.label });
    });

    const rPort = Number(cfg.remotePort);
    if (!Number.isInteger(rPort) || rPort < 1 || rPort > 65535) {
      return done({ ok: false, error: '远程端口无效（应为 1–65535）' });
    }
    try {
      const opt = { host: String(cfg.remoteHost).trim(), port: rPort };
      /* 只有用户明确指定了具体网卡才传 localAddress；0.0.0.0 交给系统自动选路 */
      if (cfg.localAddr && cfg.localAddr !== '0.0.0.0') opt.localAddress = cfg.localAddr;
      sock.connect(opt);
    } catch (e) { onErr(e); }
    setTimeout(() => { if (!settled) onErr(new Error('连接超时')); }, 8000);
  });
}

/* -------------------------- TCP Server ------------------------ */
function openTcpServer(cfg) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };

    const srv = net.createServer((client) => {
      if (tcpClient) { try { tcpClient.destroy(); } catch (_) { } }
      tcpClient = client;
      client.setNoDelay(true);
      client.on('data', onLinkData);
      client.on('error', (err) => send('link:error', err.message || String(err)));
      client.on('close', () => {
        if (tcpClient === client) tcpClient = null;
        send('link:peer', { connected: false });
      });
      send('link:peer', { connected: true, peer: client.remoteAddress + ':' + client.remotePort });
    });

    const bindAddr = (typeof cfg.localAddr === 'string' && cfg.localAddr.trim()) ? cfg.localAddr.trim() : '0.0.0.0';
    const bindPort = Number(cfg.localPort);
    if (!Number.isInteger(bindPort) || bindPort < 1 || bindPort > 65535) {
      return done({ ok: false, error: '本地监听端口无效（应为 1–65535）' });
    }

    srv.once('error', (err) => {
      let hint = err.message || String(err);
      if (err.code === 'EADDRINUSE') hint = '本地端口 ' + bindPort + ' 已被其它程序占用';
      else if (err.code === 'EACCES') hint = '端口 ' + bindPort + ' 需要管理员权限';
      else if (err.code === 'EADDRNOTAVAIL') {
        hint = '本地地址 ' + bindAddr + ' 不属于本机可用网卡 —— 请把「本地」改成「全部网卡」，或选一个真正的本机 IP';
      }
      try { srv.close(); } catch (_) { }
      done({ ok: false, error: hint });
    });

    srv.listen(bindPort, bindAddr, () => {
      settled = true;
      tcpServer = srv;
      link = {
        kind: 'tcp-server',
        write: function (buf) {
          if (!tcpClient) throw new Error('还没有客户端接入');
          return tcpClient.write(buf);
        },
        close: function () {
          if (tcpClient) { try { tcpClient.destroy(); } catch (_) { } tcpClient = null; }
          try { srv.close(); } catch (_) { }
        }
      };
      linkInfo = { mode: 'tcp-server', label: '监听 ' + bindAddr + ':' + bindPort };
      done({ ok: true, label: linkInfo.label });
    });
  });
}

/* ----------------------------- UDP ---------------------------- */
function openUdp(cfg) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };

    const sock = dgram.createSocket('udp4');

    const bindAddr = (typeof cfg.localAddr === 'string' && cfg.localAddr.trim()) ? cfg.localAddr.trim() : '0.0.0.0';
    const bindPort = Number(cfg.localPort) || 0;
    if (bindPort && (!Number.isInteger(bindPort) || bindPort < 1 || bindPort > 65535)) {
      return done({ ok: false, error: '本地端口无效（应为 0–65535，0 表示自动分配）' });
    }

    sock.once('error', (err) => {
      let hint = err.message || String(err);
      if (err.code === 'EADDRINUSE') hint = '本地端口 ' + bindPort + ' 已被占用';
      else if (err.code === 'EADDRNOTAVAIL') {
        hint = '本地地址 ' + bindAddr + ' 不属于本机可用网卡 —— 请把「本地」改成「全部网卡」';
      }
      try { sock.close(); } catch (_) { }
      done({ ok: false, error: hint });
    });

    sock.on('message', (msg) => onLinkData(msg));

    sock.bind(bindPort, bindAddr, () => {
      settled = true;
      udpSock = sock;
      sock.on('error', (err) => send('link:error', err.message || String(err)));
      link = {
        kind: 'udp',
        write: function (buf) { sock.send(buf, Number(cfg.remotePort), cfg.remoteHost); return true; },
        close: function () { try { sock.close(); } catch (_) { } }
      };
      linkInfo = {
        mode: 'udp',
        label: '本机 ' + (bindPort || '自动') + ' → ' + cfg.remoteHost + ':' + cfg.remotePort
      };
      done({ ok: true, label: linkInfo.label });
    });
  });
}

/* --------------------------- 统一入口 ------------------------- */
async function openLink(cfg) {
  try {
    return await openLinkInner(cfg);
  } catch (err) {
    /* 兜底：无论内部出什么异常，都要给渲染层一个明确答复，否则界面会卡在「处理中」 */
    try { teardown(null); } catch (_) { }
    return { ok: false, error: (err && err.message) ? err.message : String(err) };
  }
}

async function openLinkInner(cfg) {
  teardown(null);
  rxBytes = 0; txBytes = 0;
  const mode = (cfg && cfg.mode) || 'serial';

  if (mode === 'serial') {
    if (!cfg.path) return { ok: false, error: '请选择一个串口设备' };
    const r = await openSerial(cfg);
    return r;
  }
  if (mode === 'tcp-client' || mode === 'tcp-server' || mode === 'udp') {
    /* 用到「远程」的模式，必须先填对端地址 */
    if (mode !== 'tcp-server' && !cfg.remoteHost) return { ok: false, error: '请填写远程 IP / 主机名' };
    if (mode !== 'tcp-server' && !Number(cfg.remotePort)) return { ok: false, error: '请填写有效的远程端口' };
    /* 用到「本地端口」的模式，端口不能为 0（UDP 除外，0 表示自动分配） */
    if (mode === 'tcp-server' && !Number(cfg.localPort)) return { ok: false, error: '请填写本地监听端口' };
    if (mode === 'tcp-client') return openTcpClient(cfg);
    if (mode === 'tcp-server') return openTcpServer(cfg);
    return openUdp(cfg);
  }
  return { ok: false, error: '不支持的模式：' + mode };
}

function writeLink(data) {
  if (!link) return { ok: false, error: '链路未打开' };
  try {
    const buf = Buffer.from(data);
    if (!buf.length) return { ok: false, error: '空数据' };
    txBytes += buf.length;
    link.write(buf);
    return { ok: true, length: buf.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/* ==========================================================================
   IPC
   ========================================================================== */
function registerIpc() {
  ipcMain.handle('link:list-ports', async () => listPorts());
  ipcMain.handle('link:open', async (e, cfg) => {
    try {
      return await openLink(cfg || {});
    } catch (err) {
      return { ok: false, error: (err && err.message) ? err.message : String(err) };
    }
  });

  ipcMain.handle('link:close', () => {
    try { teardown(null); } catch (_) { }
    return { ok: true };
  });

  ipcMain.on('link:write', (e, data) => {
    const r = writeLink(data);
    if (!r.ok) send('link:error', r.error);
  });

  /* 串口线路信号（DTR / RTS） */
  ipcMain.handle('link:signals', async (e, s) => {
    if (!serialPort || !serialPort.isOpen) return { ok: false };
    return new Promise((resolve) => {
      const payload = {};
      if (typeof s.dtr === 'boolean') payload.dtr = s.dtr;
      if (typeof s.rts === 'boolean') payload.rts = s.rts;
      if (!Object.keys(payload).length) return resolve({ ok: true });
      serialPort.set(payload, (err) => resolve({ ok: !err, error: err ? err.message : null }));
    });
  });

  ipcMain.handle('link:info', () => ({
    open: !!link,
    mode: linkInfo.mode,
    label: linkInfo.label,
    rx: rxBytes,
    tx: txBytes
  }));

  ipcMain.handle('file:save', async (e, payload) => {
    if (!win) return { ok: false };
    const res = await dialog.showSaveDialog(win, {
      title: payload.title || '保存文件',
      defaultPath: payload.defaultName || 'export.txt',
      filters: payload.filters || [{ name: '文本文件', extensions: ['txt'] }]
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    try {
      fs.writeFileSync(res.filePath, payload.binary ? Buffer.from(payload.content) : String(payload.content), 'utf8');
      return { ok: true, filePath: res.filePath };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    platform: process.platform,
    arch: process.arch
  }));

  ipcMain.handle('net:local-ip', () => {
    const list = [];
    const ifs = require('os').networkInterfaces();
    Object.keys(ifs).forEach((name) => {
      (ifs[name] || []).forEach((i) => {
        if (i.family === 'IPv4' && !i.internal) list.push(i.address);
      });
    });
    return list;
  });
}

/* ==========================================================================
   生命周期
   ========================================================================== */
/* 允许多开：一个实例连 COM3、另一个连 COM5 是常见用法，
   所以这里不再用 requestSingleInstanceLock 限制单实例。 */

if (true) {
  app.whenReady().then(() => {
    /* 整体是白色毛玻璃风格：让系统标题栏 / 菜单 / 弹窗也用浅色 */
    try { nativeTheme.themeSource = 'light'; } catch (_) { }
    registerIpc();
    createWindow();
    startPortWatcher();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    quitting = true;
    teardown(null);
    app.quit();
  });

  app.on('before-quit', () => {
    quitting = true;
    teardown(null);
  });
}
