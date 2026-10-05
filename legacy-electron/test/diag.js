/**
 * 临时诊断脚本（不参与打包）
 * 直接调用 serialport 原生模块，验证预编译二进制在当前 Electron ABI 下能否加载。
 * 用法：electron test/diag.js <输出json>
 */
'use strict';

const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const OUT = process.argv[2] || path.join(__dirname, 'diag.json');
app.setPath('userData', path.join(os.tmpdir(), 'ss-diag-' + Date.now()));

const report = {
  versions: {
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    modules: process.versions.modules,
    arch: process.arch,
    platform: process.platform
  },
  steps: []
};

function step(name, ok, extra) {
  report.steps.push(Object.assign({ step: name, ok: ok }, extra || {}));
}

app.whenReady().then(async function () {
  /* 1. 能否 require 到 serialport */
  let SerialPort = null;
  try {
    SerialPort = require('serialport').SerialPort;
    step('require serialport', true);
  } catch (e) {
    step('require serialport', false, { error: String(e && e.message) });
  }

  /* 2. 原生绑定是否加载（这一步会真正 dlopen 那个 .node 文件） */
  if (SerialPort) {
    try {
      const list = await SerialPort.list();
      step('SerialPort.list', true, {
        count: list.length,
        ports: list.map(function (p) {
          return p.path + ' | ' + (p.friendlyName || p.manufacturer || '');
        })
      });
    } catch (e) {
      step('SerialPort.list', false, { error: String(e && e.message) });
    }

    /* 3. 尝试打开一个不存在的端口，验证 open 路径能走到驱动层（预期失败但不应崩溃） */
    await new Promise(function (resolve) {
      let done = false;
      let p = null;
      try {
        p = new SerialPort({ path: 'COM_DIAG_NOT_EXIST', baudRate: 115200, autoOpen: false });
      } catch (e) {
        step('打开不存在端口', true, { thrown: String(e && e.message) });
        return resolve();
      }
      p.on('error', function () { });
      p.open(function (err) {
        if (done) return;
        done = true;
        step('打开不存在端口', true, { rejected: err ? err.message : '(意外成功)' });
        try { if (p.isOpen) p.close(function () { }); } catch (_) { }
        resolve();
      });
      setTimeout(function () { if (!done) { done = true; step('打开不存在端口', false, { error: '超时无响应' }); resolve(); } }, 4000);
    });
  }

  fs.writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');
  console.log('DIAG_WRITTEN ' + OUT);
  app.quit();
});

app.on('window-all-closed', function () { app.quit(); });
