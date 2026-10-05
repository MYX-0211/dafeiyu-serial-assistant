/**
 * 临时测试脚本（不参与打包）
 * - term 模式：模拟串口数据，验证界面与波形
 * - tcp  模式：起真实 TCP echo server，走完整「UI → IPC → 链路 → 回显」验证
 * 用法：electron test/shot.js <输出png> <light> <term|tcp|tool>
 */
'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');

app.setPath('userData', path.join(os.tmpdir(), 'ss-test-' + Date.now()));

const OUT = process.argv[2] || path.join(__dirname, 'shot.png');
const VIEW = process.argv[4] || 'term';
const LOG_PATH = OUT + '.log';
const LOG = [];
function log(s) {
  LOG.push(new Date().toISOString().slice(11, 23) + '  ' + s);
  try { fs.writeFileSync(LOG_PATH, LOG.join('\n'), 'utf8'); } catch (_) { }
}

const ECHO_PORT = 18830;
let echoHits = 0;

/* ---------------- 真实 TCP echo server ---------------- */
const echoServer = net.createServer(function (sock) {
  log('echo: 客户端接入');
  sock.on('data', function (d) {
    echoHits++;
    log('echo: 收到 ' + d.length + ' 字节 → 原样回发');
    sock.write(d);
  });
  sock.on('close', function () { log('echo: 客户端断开'); });
});
echoServer.listen(ECHO_PORT, '127.0.0.1', function () { log('echo server 监听 127.0.0.1:' + ECHO_PORT); });

/* ---------------- IPC 桩（链路用真实实现） ---------------- */
const PORTS = [
  { path: 'COM3', friendlyName: 'USB-SERIAL CH340', vendorId: '1A86', productId: '7523', serialNumber: '', manufacturer: 'wch.cn' },
  { path: 'COM5', friendlyName: 'Silicon Labs CP210x USB to UART Bridge', vendorId: '10C4', productId: 'EA60', serialNumber: '0123ABCD', manufacturer: 'Silicon Labs' }
];
const H = function (ch, fn) { try { ipcMain.handle(ch, fn); } catch (e) { log('ipc 注册失败 ' + ch); } };

let tcpSock = null;

H('link:list-ports', async function () { return PORTS; });
H('link:open', async function (e, cfg) {
  log('link:open 收到 → ' + JSON.stringify(cfg));
  /* 故障注入：验证主进程抛异常时界面不会卡在「打开中」 */
  if (VIEW === 'failure') {
    throw new Error('模拟主进程内部异常');
  }
  if (cfg.mode === 'tcp-server') {
    return await new Promise(function (resolve) {
      let settled = false;
      srv = net.createServer(function (client) {
        srvClient = client;
        log('server: 客户端接入 ' + client.remoteAddress + ':' + client.remotePort);
        client.on('data', function (d) {
          log('server: 收到 ' + d.length + ' 字节');
          win.webContents.send('link:data', new Uint8Array(d));
        });
        win.webContents.send('link:peer', { connected: true, peer: client.remoteAddress + ':' + client.remotePort });
      });
      srv.once('error', function (err) {
        log('server: 监听失败 ' + err.code);
        if (!settled) { settled = true; resolve({ ok: false, error: err.code + ' ' + err.message }); }
      });
      srv.listen(Number(cfg.localPort), cfg.localAddr, function () {
        settled = true;
        log('server: 已在 ' + cfg.localAddr + ':' + cfg.localPort + ' 监听（绑定成功）');
        resolve({ ok: true, label: '监听 ' + cfg.localAddr + ':' + cfg.localPort });
      });
    });
  }
  if (cfg.mode === 'tcp-client') {
    return await new Promise(function (resolve) {
      let settled = false;
      tcpSock = net.createConnection({ host: cfg.remoteHost, port: Number(cfg.remotePort) }, function () {
        settled = true;
        tcpSock.on('data', function (d) {
          log('主进程收到对端数据 ' + d.length + ' 字节，转给渲染层');
          win.webContents.send('link:data', new Uint8Array(d));
        });
        tcpSock.on('close', function () { win.webContents.send('link:closed', { reason: '连接已断开' }); });
        resolve({ ok: true, label: cfg.remoteHost + ':' + cfg.remotePort });
      });
      tcpSock.on('error', function (err) {
        if (!settled) { settled = true; resolve({ ok: false, error: err.message }); }
        else win.webContents.send('link:error', err.message);
      });
    });
  }
  return { ok: true, label: 'COM3' };
});
H('link:close', async function () {
  if (tcpSock) { tcpSock.destroy(); tcpSock = null; }
  if (srv) { try { srv.close(); } catch (_) { } srv = null; }
  return { ok: true };
});

let srv = null, srvClient = null;
H('link:open-server', async function () { return { ok: true }; });
ipcMain.on('link:write', function (e, data) {
  if (tcpSock) tcpSock.write(Buffer.from(data));
  else if (srvClient) srvClient.write(Buffer.from(data));
});
H('link:signals', async function () { return { ok: true }; });
H('link:info', async function () { return { open: !!tcpSock, mode: 'tcp-client', label: '', rx: 0, tx: 0 }; });
H('win:is-maximized', async function () { return false; });
H('file:save', async function () { return { ok: true, filePath: 'C:\\demo\\serial.txt' }; });
H('shell:open', async function () { return { ok: true }; });
H('theme:system', async function () { return 'dark'; });
H('net:local-ip', async function () { return ['127.0.0.1', '192.168.137.1']; });
H('app:info', async function () {
  return {
    version: '1.0.0', electron: process.versions.electron, node: process.versions.node,
    chrome: process.versions.chrome, platform: 'win32', arch: 'x64'
  };
});

/* ---------------- 主流程 ---------------- */
log('=== 启动 === electron ' + process.versions.electron);
setTimeout(function () { log('!! 全局超时'); app.exit(2); }, 25000);

let win = null;

app.whenReady().then(function () {
  win = new BrowserWindow({
    width: 1020, height: 680,
    show: true, frame: true, autoHideMenuBar: true,
    backgroundColor: '#F2F2F7',
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false
    }
  });
  log('窗口已创建 1020x680');

  win.webContents.on('console-message', function (a, b, c) {
    if (b && typeof b === 'object') log('CONSOLE ' + JSON.stringify(b).slice(0, 300));
    else log('CONSOLE[' + b + '] ' + String(c).slice(0, 300));
  });

  win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'))
    .then(function () { log('loadFile resolve'); })
    .catch(function (e) { log('!! loadFile 失败 ' + e.message); });

  win.webContents.once('did-finish-load', async function () {
    log('did-finish-load');
    const JS = function (code) { return win.webContents.executeJavaScript(code); };

    if (VIEW === 'tcp') {
      /* ---------- TCP 端到端验证 ---------- */
      await new Promise(function (r) { setTimeout(r, 500); });
      await JS("(function(){var s=document.getElementById('modeSel');s.value='tcp-client';" +
        "s.dispatchEvent(new Event('change',{bubbles:true}));return true;})()");
      await new Promise(function (r) { setTimeout(r, 200); });
      await JS("(function(){" +
        "var h=document.getElementById('netHost');h.value='127.0.0.1';h.dispatchEvent(new Event('input',{bubbles:true}));" +
        "var p=document.getElementById('netPort');p.value='" + ECHO_PORT + "';p.dispatchEvent(new Event('input',{bubbles:true}));" +
        "return true;})()");
      log('已切到 TCP Client 并填入 127.0.0.1:' + ECHO_PORT);
      await new Promise(function (r) { setTimeout(r, 200); });

      await JS("document.getElementById('btnOpen').click(); true");
      log('已点击「打开」');
      await new Promise(function (r) { setTimeout(r, 1200); });

      const opened = await JS("document.getElementById('sbPort').textContent");
      log('状态栏连接状态 = ' + opened);

      /* 发一条测试数据，看 echo 能不能回来 */
      await JS("(function(){var t=document.getElementById('sendText');" +
        "t.value='PING-TCP-TEST-123';t.dispatchEvent(new Event('input',{bubbles:true}));" +
        "document.getElementById('chkNewline').checked=false;" +
        "document.getElementById('btnSend').click();return true;})()");
      log('已点击「发送」');
      await new Promise(function (r) { setTimeout(r, 1200); });

      const logText = await JS("document.getElementById('log').textContent");
      log('echo 往返次数 = ' + echoHits);
      log('接收区是否含回显 = ' + (logText.indexOf('PING-TCP-TEST-123') >= 0));
      log('接收区内容片段 = ' + JSON.stringify(logText.slice(-90)));
    } else {
      /* ---------- 模拟串口数据 ---------- */
      const enc = new TextEncoder();
      const push = function (t) { win.webContents.send('link:data', enc.encode(t)); };
      setTimeout(function () {
        push('[BOOT] SerialStudio v1.0.0\r\n');
        push('[BOOT] COM3 已打开 115200 8N1\r\n');
      }, 120);
      let t = 0;
      const timer = setInterval(function () {
        t += 1;
        const speed = 200 * (1 - Math.exp(-t / 13)) + Math.sin(t / 2.4) * 2.4 + (Math.random() - .5) * 1.1;
        const cur = 132 + Math.sin(t / 4.4) * 16 + (Math.random() - .5) * 3;
        const duty = 1209 + Math.sin(t / 4.4) * 88 + (Math.random() - .5) * 18;
        push('target=200 speed=' + speed.toFixed(1) + ' cur=' + cur.toFixed(0) + ' duty=' + duty.toFixed(0) + '\r\n');
        if (t >= 240) clearInterval(timer);
      }, 26);
      log('数据泵已启动');
    }

    await new Promise(function (r) { setTimeout(r, VIEW === 'tcp' ? 600 : 2600); });

    if (VIEW === 'tool') {
      try {
        await JS("document.getElementById('btnTools').click(); true");
        await new Promise(function (r) { setTimeout(r, 300); });
        await JS("(function(){var t=document.getElementById('toolInput');" +
          "t.value='01 03 00 00 00 02';t.dispatchEvent(new Event('input',{bubbles:true}));return true;})()");
        await new Promise(function (r) { setTimeout(r, 400); });
        log('已打开校验计算器并填入测试帧');
      } catch (e) { log('打开失败 ' + e.message); }
    }

    try {
      const diag = await JS("JSON.stringify({" +
        "  mode: document.getElementById('modeSel').value," +
        "  opts: Array.prototype.map.call(document.getElementById('modeSel').options,function(o){return o.textContent;})," +
        "  rows: document.getElementById('cmdList').children.length," +
        "  sbPort: document.getElementById('sbPort').textContent" +
        "})");
      log('DIAG ' + diag);
    } catch (e) { log('DIAG 失败 ' + e.message); }

    /* 异常恢复：主进程抛错后，按钮必须能恢复可点 */
    if (VIEW === 'failure') {
      try {
        await JS("(function(){var s=document.getElementById('modeSel');s.value='tcp-server';" +
          "s.dispatchEvent(new Event('change',{bubbles:true}));return true;})()");
        await new Promise(function (r) { setTimeout(r, 200); });
        await JS("(function(){var p=document.getElementById('netLocalPort');p.value='18833';" +
          "p.dispatchEvent(new Event('input',{bubbles:true}));return true;})()");
        await JS("document.getElementById('btnOpen').click(); true");
        await new Promise(function (r) { setTimeout(r, 1500); });
        const txt = await JS("document.getElementById('btnOpenText').textContent");
        log('异常后按钮文字: ' + JSON.stringify(txt));
        log('是否已从「打开中」恢复: ' + (txt.indexOf('中') < 0));
        /* 再点一次，看是否还能正常发起（说明状态已复位） */
        await JS("document.getElementById('btnOpen').click(); true");
        await new Promise(function (r) { setTimeout(r, 800); });
        log('二次点击后按钮文字: ' + JSON.stringify(await JS("document.getElementById('btnOpenText').textContent")));
      } catch (e) { log('异常恢复测试失败 ' + e.message); }
    }

    /* 关于窗口实测 */
    if (VIEW === 'about') {
      try {
        await JS("document.getElementById('btnHelp').click(); true");
        await new Promise(function (r) { setTimeout(r, 250); });
        await JS("document.getElementById('btnAbout').click(); true");
        await new Promise(function (r) { setTimeout(r, 600); });
        const info = await JS("(function(){var m=document.querySelector('#aboutModal .modal');" +
          "var r=m.getBoundingClientRect();" +
          "return JSON.stringify({w:Math.round(r.width),h:Math.round(r.height)," +
          "name:document.querySelector('.about-name').textContent," +
          "icon:document.querySelector('.about-icon').naturalWidth+" +
          "' '+document.querySelector('.about-icon').offsetWidth});})()");
        log('关于窗口: ' + info);
      } catch (e) { log('关于窗口测试失败 ' + e.message); }
    }

    /* 语言切换实测 */
    if (VIEW === 'lang' || VIEW === 'en') {
      try {
        const getTexts = "JSON.stringify({brand:document.getElementById('brand').textContent," +
          "pane:document.querySelector('.pane-head .title').textContent," +
          "enc:document.querySelector('#selEncoding').previousElementSibling.textContent," +
          "btn:document.getElementById('btnSend').textContent," +
          "lang:document.getElementById('langLabel').textContent})";
        log('中文界面: ' + await JS(getTexts));
        await JS("document.getElementById('btnLang').click(); true");
        await new Promise(function (r) { setTimeout(r, 600); });
        log('英文界面: ' + await JS(getTexts));
        if (VIEW === 'lang') {
          await JS("document.getElementById('btnLang').click(); true");
          await new Promise(function (r) { setTimeout(r, 600); });
          log('切回中文: ' + await JS(getTexts));
        }
      } catch (e) { log('语言测试失败 ' + e.message); }
    }

    /* 按键即发 / 回车发送 实测 */
    if (VIEW === 'keysend') {
      try {
        const PORT = 18834;
        const recv = [];
        await JS("(function(){var s=document.getElementById('modeSel');s.value='tcp-server';" +
          "s.dispatchEvent(new Event('change',{bubbles:true}));return true;})()");
        await new Promise(function (r) { setTimeout(r, 200); });
        await JS("(function(){var a=document.getElementById('netLocalAddr');a.value='0.0.0.0';" +
          "a.dispatchEvent(new Event('change',{bubbles:true}));" +
          "var p=document.getElementById('netLocalPort');p.value='" + PORT + "';" +
          "p.dispatchEvent(new Event('input',{bubbles:true}));return true;})()");
        await JS("document.getElementById('btnOpen').click(); true");
        await new Promise(function (r) { setTimeout(r, 800); });

        const cli = net.createConnection({ host: '127.0.0.1', port: PORT }, function () {
          log('测试端已接入');
        });
        cli.on('data', function (d) { recv.push(d.toString('latin1')); });
        await new Promise(function (r) { setTimeout(r, 500); });

        /* 1) 按键即发：勾上后模拟敲 H i */
        await JS("(function(){var c=document.getElementById('chkKeySend');c.click();return true;})()");
        await new Promise(function (r) { setTimeout(r, 150); });
        const on1 = await JS("document.getElementById('chkKeySend').checked");
        log('按键即发已勾选: ' + on1);
        for (const ch of ['H', 'i']) {
          await JS("(function(){var el=document.getElementById('sendText');el.value+='" + ch + "';" +
            "el.dispatchEvent(new InputEvent('input',{inputType:'insertText',data:'" + ch + "',bubbles:true}));" +
            "return true;})()");
          await new Promise(function (r) { setTimeout(r, 150); });
        }
        log('敲了 H i 之后，对端收到: ' + JSON.stringify(recv.join('')));
        log('按键即发是否生效: ' + (recv.join('').indexOf('Hi') >= 0));

        /* 2) 回车发送：勾上后按 Enter，整行应发出 */
        recv.length = 0;
        await JS("(function(){var c=document.getElementById('chkEnterSend');c.click();return true;})()");
        await new Promise(function (r) { setTimeout(r, 150); });
        await JS("document.getElementById('sendText').value='OK'; true");
        await JS("(function(){var el=document.getElementById('sendText');" +
          "el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));" +
          "return true;})()");
        await new Promise(function (r) { setTimeout(r, 500); });
        log('回车后对端收到: ' + JSON.stringify(recv.join('')));
        log('回车发送是否生效: ' + (recv.join('').indexOf('OK') >= 0));
        log('输入框已清空: ' + ((await JS("document.getElementById('sendText').value")) === ''));

        try { cli.destroy(); } catch (_) { }
      } catch (e) { log('按键即发测试失败 ' + e.message); }
    }

    /* TCP Server 端到端：应用监听 → 脚本连进来 → 双向收发 */
    if (VIEW === 'server') {
      try {
        const PORT = 18832;
        await JS("(function(){var s=document.getElementById('modeSel');s.value='tcp-server';" +
          "s.dispatchEvent(new Event('change',{bubbles:true}));return true;})()");
        await new Promise(function (r) { setTimeout(r, 250); });
        await JS("(function(){" +
          "var a=document.getElementById('netLocalAddr');a.value='0.0.0.0';a.dispatchEvent(new Event('change',{bubbles:true}));" +
          "var p=document.getElementById('netLocalPort');p.value='" + PORT + "';p.dispatchEvent(new Event('input',{bubbles:true}));" +
          "return true;})()");
        await new Promise(function (r) { setTimeout(r, 150); });
        await JS("document.getElementById('btnOpen').click(); true");
        await new Promise(function (r) { setTimeout(r, 900); });
        log('打开后状态栏: ' + await JS("document.getElementById('sbPort').textContent"));

        /* 脚本当客户端连进去 */
        const cli = net.createConnection({ host: '127.0.0.1', port: PORT }, function () {
          log('测试端: 已连上应用');
          cli.write(Buffer.from('FROM-CLIENT' + String.fromCharCode(13, 10)));
        });
        cli.on('data', function (d) { log('测试端收到应用发来的: ' + JSON.stringify(d.toString())); });
        await new Promise(function (r) { setTimeout(r, 700); });

        /* 应用往客户端发一条 */
        await JS("(function(){var t=document.getElementById('sendText');t.value='FROM-APP';" +
          "t.dispatchEvent(new Event('input',{bubbles:true}));" +
          "document.getElementById('chkNewline').checked=false;" +
          "document.getElementById('btnSend').click();return true;})()");
        await new Promise(function (r) { setTimeout(r, 700); });

        const txt = await JS("document.getElementById('log').textContent");
        log('接收区含客户端数据: ' + (txt.indexOf('FROM-CLIENT') >= 0));
        try { cli.destroy(); } catch (_) { }
      } catch (e) { log('Server 测试失败 ' + e.message); }
    }

    /* GBK 解码实测：发一段 GBK 字节，切到 GBK 看是否正常 */
    if (VIEW === 'gbk') {
      try {
        const gbkBytes = [0xC4, 0xE3, 0xBA, 0xC3, 0xCA, 0xC0, 0xBD, 0xE7, 0x0D, 0x0A];
        await JS("(function(){var s=document.getElementById('selEncoding');s.value='gbk';" +
          "s.dispatchEvent(new Event('change',{bubbles:true}));return true;})()");
        await new Promise(function (r) { setTimeout(r, 200); });
        win.webContents.send('link:data', new Uint8Array(gbkBytes));
        await new Promise(function (r) { setTimeout(r, 400); });
        const t1 = await JS("document.getElementById('log').textContent");
        log('GBK 模式显示: ' + JSON.stringify(t1.trim()));
        log('GBK 解码正确: ' + (t1.indexOf('你好世界') >= 0));

        await JS("(function(){var s=document.getElementById('selEncoding');s.value='utf-8';" +
          "s.dispatchEvent(new Event('change',{bubbles:true}));return true;})()");
        await new Promise(function (r) { setTimeout(r, 200); });
        win.webContents.send('link:data', new Uint8Array(gbkBytes));
        await new Promise(function (r) { setTimeout(r, 400); });
        const t2 = await JS("document.getElementById('log').textContent");
        log('UTF-8 模式下同样字节: ' + JSON.stringify(t2.trim().slice(-12)));

        await JS("(function(){var s=document.getElementById('selEncoding');s.value='gbk';" +
          "s.dispatchEvent(new Event('change',{bubbles:true}));return true;})()");
      } catch (e) { log('GBK 测试失败 ' + e.message); }
    }

    /* 背景图诊断 */
    try {
      const bg = await JS(`(function(){
        var el = document.getElementById('bg');
        if (!el) return 'NO_ELEMENT';
        var cs = getComputedStyle(el);
        return JSON.stringify({
          bgImage: cs.backgroundImage.slice(0, 100),
          size: el.offsetWidth + 'x' + el.offsetHeight,
          z: cs.zIndex, op: cs.opacity
        });
      })()`);
      log('BG ' + bg);
      const im = await JS(`new Promise(function(res){
        var i = new Image();
        i.onload = function(){ res('OK ' + i.naturalWidth + 'x' + i.naturalHeight); };
        i.onerror = function(){ res('FAIL 无法加载 assets/bg.jpg'); };
        i.src = 'assets/bg.jpg';
      })`);
      log('IMG ' + im);
    } catch (e) { log('BG 诊断失败 ' + e.message); }

    log('开始截图');
    try {
      const img = await Promise.race([
        win.webContents.capturePage(),
        new Promise(function (_, rej) { setTimeout(function () { rej(new Error('超时')); }, 7000); })
      ]);
      fs.writeFileSync(OUT, img.toPNG());
      log('截图完成 ' + img.getSize().width + 'x' + img.getSize().height);
    } catch (e) { log('截图失败 ' + e.message); }
    log('=== 结束 ===');
    try { echoServer.close(); } catch (_) { }
    win.close();
  });
});

app.on('window-all-closed', function () { app.quit(); });
