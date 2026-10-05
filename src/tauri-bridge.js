/* ==========================================================================
   大肥鱼串口助手 · Tauri 桥接层
   --------------------------------------------------------------------------
   把 Tauri 的 invoke / listen 包装成和 Electron preload 完全一致的
   window.native 接口，这样业务代码（app.js）不需要关心底层是 Electron 还是 Tauri。
   ========================================================================== */
(function () {
  'use strict';

  const core = (window.__TAURI__ && window.__TAURI__.core) || null;
  const evt = (window.__TAURI__ && window.__TAURI__.event) || null;

  if (!core) {
    console.error('[bridge] 未检测到 Tauri API，请确认 tauri.conf.json 里 withGlobalTauri = true');
    return;
  }

  const invoke = core.invoke;

  function on(event, cb) {
    if (!evt || !evt.listen) return Promise.resolve(function () { });
    return evt.listen(event, function (e) { cb(e.payload); });
  }

  window.native = {
    isDesktop: true,
    platform: 'win32',

    /* ---------- 链路 ---------- */
    listPorts: function () {
      return invoke('list_ports');
    },
    open: function (cfg) {
      return invoke('open_link', { cfg: cfg });
    },
    close: function () {
      return invoke('close_link');
    },
    write: function (data) {
      // 用普通数组传，避免 Uint8Array 的序列化差异。
      // 返回 Promise，调用方可以 catch 到「链路未打开」「还没有客户端接入」这类错误。
      return invoke('write_link', { data: Array.prototype.slice.call(data) });
    },
    setSignals: function (s) {
      return invoke('set_signals', {
        dtr: typeof s.dtr === 'boolean' ? s.dtr : null,
        rts: typeof s.rts === 'boolean' ? s.rts : null
      });
    },

    /* ---------- 事件 ---------- */
    onData: function (cb) {
      return on('link:data', function (payload) {
        cb(new Uint8Array(payload));
      });
    },
    onClosed: function (cb) { return on('link:closed', cb); },
    onError: function (cb) { return on('link:error', cb); },
    onPeer: function (cb) { return on('link:peer', cb); },
    onPortsChanged: function (cb) { return on('link:ports-changed', cb); },

    /* ---------- 文件 / 系统 ---------- */
    saveFile: function (payload) {
      return invoke('save_file', { payload: payload });
    },
    appInfo: function () { return invoke('app_info'); },
    localIPs: function () { return invoke('local_ips'); }
  };
})();
