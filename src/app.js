/* ==========================================================================
   串口调试助手 · 桌面版 —— 渲染层主逻辑
   ========================================================================== */
(function () {
'use strict';

/* ==========================================================================
   0. 工具
   ========================================================================== */
const $ = function (id) { return document.getElementById(id); };
const pad2 = function (n) { return String(n).padStart(2, '0'); };
const NATIVE = window.native || null;

function timeStr() {
  const d = new Date();
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}
function fmtNum(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(2) + ' MB';
}
function bytesToHex(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += (u8[i] < 16 ? '0' : '') + u8[i].toString(16).toUpperCase() + ' ';
  return s;
}
function parseHex(str) {
  const clean = String(str).replace(/0x/gi, '').replace(/[\s,;:_-]+/g, '');
  if (!clean.length) return new Uint8Array(0);
  if (/[^0-9a-fA-F]/.test(clean)) throw new Error('含有非十六进制字符');
  if (clean.length % 2 !== 0) throw new Error('十六进制字符个数为奇数，无法按字节解析');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  return out;
}
function newlineBytes(mode) {
  if (mode === 'n') return new Uint8Array([0x0A]);
  if (mode === 'r') return new Uint8Array([0x0D]);
  return new Uint8Array([0x0D, 0x0A]);
}
function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0); out.set(b, a.length);
  return out;
}
function esc(s) { return String(s).replace(/[&<>]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]; }); }

/* ==========================================================================
   1. 校验算法
   ========================================================================== */
const CRC_TABLE_MODBUS = (function () {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? ((c >>> 1) ^ 0xA001) : (c >>> 1);
    t[i] = c & 0xFFFF;
  }
  return t;
})();
function crc16modbus(u8) {
  let crc = 0xFFFF;
  for (let i = 0; i < u8.length; i++) crc = (crc >>> 8) ^ CRC_TABLE_MODBUS[(crc ^ u8[i]) & 0xFF];
  return crc & 0xFFFF;
}
function crc16ccitt(u8) {
  let crc = 0xFFFF;
  for (let i = 0; i < u8.length; i++) {
    crc ^= u8[i] << 8;
    for (let j = 0; j < 8; j++) crc = (crc & 0x8000) ? (((crc << 1) ^ 0x1021) & 0xFFFF) : ((crc << 1) & 0xFFFF);
  }
  return crc & 0xFFFF;
}
function add8(u8) { let s = 0; for (let i = 0; i < u8.length; i++) s = (s + u8[i]) & 0xFF; return s; }
function xor8(u8) { let s = 0; for (let i = 0; i < u8.length; i++) s ^= u8[i]; return s; }
function checksumBytes(algo, data) {
  switch (algo) {
    case 'crc16modbus': { const v = crc16modbus(data); return new Uint8Array([v & 0xFF, (v >> 8) & 0xFF]); }
    case 'crc16ccitt': { const v = crc16ccitt(data); return new Uint8Array([(v >> 8) & 0xFF, v & 0xFF]); }
    case 'add8': return new Uint8Array([add8(data)]);
    case 'xor8': return new Uint8Array([xor8(data)]);
    default: return new Uint8Array(0);
  }
}
const ALGO_NAME = { crc16modbus: 'Modbus CRC16', crc16ccitt: 'CRC16-CCITT', add8: '累加和 ADD8', xor8: '异或 XOR8' };

/* ==========================================================================
   2. 状态
   ========================================================================== */
const S = {
  ports: [], isOpen: false, opening: false,
  mode: 'serial', openLabel: '', localIPs: [],

  hexView: false, ts: false, packet: true, autoWrap: true, echo: false,
  pktGap: 20, bufLimit: 500000,

  encoding: 'utf-8',
  sendHex: false, newline: true, nlMode: 'rn', checksum: 'none',
  keySend: false, enterSend: false,
  timerId: null,

  rxBytes: 0, txBytes: 0, rxPkt: 0, dropped: 0, logBytes: 0,

  lastRxAt: 0, lineEnded: false, buf: [], flushTimer: null, paused: false,

  cmds: [],
  loopId: null, loopIdx: 0,

  toolAlgo: 'crc16modbus',
  logSize: 12.5
};
/* 给可能卡住的异步操作加个上限，避免界面永久停在「处理中」 */
function withTimeout(promise, ms, msg) {
  return Promise.race([
    promise,
    new Promise(function (_, reject) {
      setTimeout(function () { reject(new Error(msg || '操作超时')); }, ms);
    })
  ]);
}

const LS = {
  get: function (k, d) {
    try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); }
    catch (e) { return d; }
  },
  set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } }
};

/* ==========================================================================
   3. Toast / 弹窗
   ========================================================================== */
function toast(msg, type, ms) {
  const el = document.createElement('div');
  el.className = 'toast ' + (type || 'info');
  const bar = document.createElement('span'); bar.className = 'bar';
  const txt = document.createElement('span'); txt.textContent = msg;
  el.appendChild(bar); el.appendChild(txt);
  $('toasts').appendChild(el);
  setTimeout(function () {
    el.classList.add('out');
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 220);
  }, ms || 2600);
}
function openModal(el) { el.classList.add('show'); }
function closeModal(el) { el.classList.remove('show'); }

/* ==========================================================================
   4. 日志渲染（40ms 批量提交）
   ========================================================================== */
const logEl = $('log');
const logWrap = logEl.parentNode;
const emptyEl = $('logEmpty');
/* 接收/回显的解码器 —— 支持切换编码（Keil 工程的中文多为 GBK） */
let rxDec = new TextDecoder('utf-8', { fatal: false });
let echoDec = new TextDecoder('utf-8', { fatal: false });
function setEncoding(enc, persist) {
  const e = (enc === 'gbk') ? 'gbk' : 'utf-8';
  S.encoding = e;
  rxDec = new TextDecoder(e, { fatal: false });
  echoDec = new TextDecoder(e, { fatal: false });
  if (persist !== false) LS.set('serialstudio.encoding', e);
}

function toggleEmpty() {
  if (logEl.children.length > 0) emptyEl.classList.add('hide');
  else emptyEl.classList.remove('hide');
}
function queueLog(text, kind, brk) {
  if (S.paused) return;
  S.buf.push({ text: text, kind: kind, brk: !!brk });
  if (!S.flushTimer) S.flushTimer = setTimeout(flushLog, 40);
}
function piecesOf(str, firstBrk) {
  const res = [];
  const re = /\r\n|\r|\n/g;
  let last = 0, m, brk = firstBrk, ended = false;
  while ((m = re.exec(str)) !== null) {
    res.push({ text: str.slice(last, m.index), brk: brk });
    brk = true; ended = true;
    last = m.index + m[0].length;
  }
  const tail = str.slice(last);
  if (tail === '' && ended) {
    S.lineEnded = true;
  } else {
    res.push({ text: tail, brk: brk });
    S.lineEnded = false;
  }
  return res;
}
function flushLog() {
  S.flushTimer = null;
  if (!S.buf.length) return;
  if (S.paused) { S.buf.length = 0; return; }
  /* 智能跟随：滚动条本来就在底部才自动跟着走，用户往上翻看历史时不打断 */
  const atBottom = (logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight) < 40;
  const frag = document.createDocumentFragment();
  let cur = null;
  for (let i = 0; i < S.buf.length; i++) {
    const it = S.buf[i];
    if (cur === null || it.brk) {
      cur = document.createElement('div');
      cur.className = 'line';
      if (S.ts) {
        const t = document.createElement('span');
        t.className = 'ts';
        t.textContent = '[' + timeStr() + '] ';
        cur.appendChild(t);
      }
      frag.appendChild(cur);
    }
    if (it.text) {
      const prev = cur.lastElementChild;
      if (prev && prev.dataset && prev.dataset.k === it.kind) {
        prev.appendChild(document.createTextNode(it.text));
      } else {
        const sp = document.createElement('span');
        sp.className = 'k-' + it.kind;
        sp.dataset.k = it.kind;
        sp.textContent = it.text;
        cur.appendChild(sp);
      }
      S.logBytes += it.text.length;
    }
  }
  S.buf.length = 0;
  logEl.appendChild(frag);
  trimLog();
  if (atBottom) logEl.scrollTop = logEl.scrollHeight;
  toggleEmpty();
  $('rxBadge').textContent = t('rx.lines', { n: logEl.children.length });
}
function trimLog() {
  let guard = 0;
  while (S.logBytes > S.bufLimit && logEl.firstChild && guard++ < 20000) {
    const n = logEl.firstChild;
    S.logBytes -= (n.textContent || '').length;
    logEl.removeChild(n);
  }
  if (S.logBytes < 0) S.logBytes = 0;
}
function clearLog() {
  logEl.innerHTML = '';
  S.buf.length = 0;
  S.logBytes = 0; S.lineEnded = false;
  $('rxBadge').textContent = t('rx.lines', { n: 0 });
  toggleEmpty();
}

/* ==========================================================================
   5. 接收
   ========================================================================== */
function onRxChunk(u8) {
  S.rxBytes += u8.length;

  const t = performance.now();
  const isNewPkt = (S.lastRxAt === 0) || ((t - S.lastRxAt) > S.pktGap);
  S.lastRxAt = t;
  if (isNewPkt) S.rxPkt++;

  if (S.paused) { S.dropped += u8.length; updateStats(); return; }

  const brk = S.packet && isNewPkt;
  if (S.hexView) {
    queueLog(bytesToHex(u8), 'rx', brk || S.lineEnded);
    S.lineEnded = false;
  } else {
    const text = rxDec.decode(u8, { stream: true });
    if (!text.length) { updateStats(); return; }
    const safe = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '\u00b7');
    const first = brk || S.lineEnded;
    S.lineEnded = false;
    const pieces = piecesOf(safe, first);
    for (let i = 0; i < pieces.length; i++) queueLog(pieces[i].text, 'rx', pieces[i].brk);
  }
  updateStats();
}
function onTxEcho(u8) {
  if (!S.echo || S.paused) return;
  if (S.hexView) queueLog(bytesToHex(u8), 'tx', true);
  else {
    const text = echoDec.decode(u8);
    const pieces = piecesOf(text.replace(/\r\n|\r|\n/g, '\n'), true);
    for (let i = 0; i < pieces.length; i++) queueLog(pieces[i].text, 'tx', pieces[i].brk);
  }
}

/* ==========================================================================
   6. 统计 / 状态栏
   ========================================================================== */
function updateStats() {
  $('sbRx').textContent = fmtNum(S.rxBytes);
  $('sbTx').textContent = fmtNum(S.txBytes);
  $('sbPkt').textContent = fmtNum(S.rxPkt);
}

/* ==========================================================================
   7. 链路（串口 / TCP Client / TCP Server / UDP）
   ========================================================================== */
const MODE_LABEL = { 'tcp-client': 'TCP Client', 'tcp-server': 'TCP Server', 'udp': 'UDP' };
function isSerialMode() { return !MODE_LABEL[S.mode]; }

function portLabel(p) {
  const name = p.friendlyName || p.manufacturer || '';
  return name ? (p.path + ' · ' + name) : p.path;
}

/* 下拉框 = 串口列表 + 网络模式（与 SSCOM 一致） */
function renderModeOptions() {
  const sel = $('modeSel');
  const prev = sel.value;
  sel.innerHTML = '';

  const gSerial = document.createElement('optgroup');
  gSerial.label = t('mode.serial');
  if (!S.ports.length) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = t('mode.noPort');
    o.disabled = true;
    gSerial.appendChild(o);
  } else {
    S.ports.forEach(function (p) {
      const o = document.createElement('option');
      o.value = 'serial:' + p.path;
      o.textContent = portLabel(p);
      gSerial.appendChild(o);
    });
  }
  sel.appendChild(gSerial);

  const gNet = document.createElement('optgroup');
  gNet.label = t('mode.network');
  ['tcp-client', 'tcp-server', 'udp'].forEach(function (m) {
    const o = document.createElement('option');
    o.value = m;
    o.textContent = MODE_LABEL[m];
    gNet.appendChild(o);
  });
  sel.appendChild(gNet);

  /* 尽量保留原选择 */
  if (prev && sel.querySelector('option[value="' + prev + '"]')) sel.value = prev;
  else if (S.ports.length) sel.value = 'serial:' + S.ports[0].path;

  applyModeUI();
  updateHint();
}

/* 按当前模式显示串口参数或网络参数 */
function applyModeUI() {
  const v = $('modeSel').value || '';
  const serial = v.indexOf('serial:') === 0 || v === '';
  S.mode = serial ? 'serial' : v;
  $('serialOpts').hidden = !serial;
  $('netOpts').hidden = serial;
  if (serial) return;

  /* 各模式用到的字段不同：
     TCP Client → 远程 IP/端口（本地地址可选，用来指定走哪张网卡）
     TCP Server → 本地地址/端口（远程不参与）
     UDP        → 远程 + 本地都要 */
  const isServer = (S.mode === 'tcp-server');
  const isUdp = (S.mode === 'udp');
  $('netRemoteWrap').hidden = isServer;
  $('netPort').hidden = isServer;
  $('netBindWrap').hidden = false;
  $('netLocalPort').hidden = !(isServer || isUdp);
}

function updateHint() {
  const v = $('modeSel').value || '';
  if (S.isOpen) {
    $('hint').textContent = t('hint.opened', { word: doneWord(), label: S.openLabel || '' });
    return;
  }
  if (v.indexOf('serial:') === 0) {
    const path = v.slice(7);
    const p = S.ports.filter(function (x) { return x.path === path; })[0];
    const bits = [];
    if (p) {
      if (p.vendorId) bits.push('VID ' + p.vendorId + (p.productId ? ' / PID ' + p.productId : ''));
      if (p.serialNumber) bits.push('SN ' + p.serialNumber);
    }
    bits.push(t('hint.portInfo', { n: S.ports.length }));
    $('hint').textContent = bits.join('   ·   ');
  } else if (v === 'tcp-client') {
    $('hint').textContent = t('hint.tcpClient');
  } else if (v === 'tcp-server') {
    const laRaw = $('netLocalAddr').value || '0.0.0.0';
    $('hint').textContent = (laRaw === '0.0.0.0')
      ? t('hint.tcpServerAll') + (S.localIPs.join('  /  ') || '—')
      : t('hint.tcpServerOne', { addr: laRaw });
  } else if (v === 'udp') {
    $('hint').textContent = t('hint.udp');
  } else {
    $('hint').textContent = t('hint.noPort');
  }
}

/* 填充「本地」地址下拉：全部网卡 + 本机每张网卡的 IPv4 */
async function refreshLocalIPs() {
  const sel = $('netLocalAddr');
  if (!sel) return;
  const prev = sel.value || '0.0.0.0';
  if (!S.localIPs.length && NATIVE) {
    try { S.localIPs = await NATIVE.localIPs(); } catch (_) { }
  }
  sel.innerHTML = '';
  const all = document.createElement('option');
  all.value = '0.0.0.0';
  all.textContent = '全部网卡';
  sel.appendChild(all);
  S.localIPs.forEach(function (ip) {
    const o = document.createElement('option');
    o.value = ip; o.textContent = ip;
    sel.appendChild(o);
  });
  if (sel.querySelector('option[value="' + prev + '"]')) sel.value = prev;
  else sel.value = '0.0.0.0';
}

async function refreshPorts(showToast) {
  if (!NATIVE) return;
  try {
    S.ports = await NATIVE.listPorts();
    renderModeOptions();
    if (showToast) toast(t('toast.scanned', { n: S.ports.length }));
  } catch (e) {
    toast(t('toast.scanFail') + (e.message || e), 'err');
  }
}

function paramsText() {
  if (!isSerialMode()) {
    const rh = ($('netHost').value || '').trim() || '—';
    const rp = ($('netPort').value || '').trim() || '—';
    const laRaw = $('netLocalAddr').value || '0.0.0.0';
    const la = (laRaw === '0.0.0.0') ? '全部网卡' : laRaw;
    const lp = ($('netLocalPort').value || '').trim() || '—';
    if (S.mode === 'tcp-server') return '监听 ' + la + ':' + lp;
    if (S.mode === 'udp') return la + ':' + lp + ' → ' + rh + ':' + rp;
    return rh + ':' + rp;
  }
  const par = { none: 'N', even: 'E', odd: 'O', mark: 'M', space: 'S' }[$('parity').value];
  const flow = { none: '', rtscts: ' RTS/CTS', xonxoff: ' XON/XOFF' }[$('flowCtrl').value];
  return ($('baudRate').value || '115200') + ' · ' + $('dataBits').value + par + $('stopBits').value + flow;
}

function buildOpenConfig() {
  const mode = S.mode;
  if (mode === 'serial') {
    const v = $('modeSel').value || '';
    return {
      mode: 'serial',
      path: v.indexOf('serial:') === 0 ? v.slice(7) : '',
      baudRate: Number($('baudRate').value) || 115200,
      dataBits: Number($('dataBits').value) || 8,
      stopBits: $('stopBits').value,
      parity: $('parity').value,
      rtscts: $('flowCtrl').value === 'rtscts',
      xon: $('flowCtrl').value === 'xonxoff',
      xoff: $('flowCtrl').value === 'xonxoff',
      dtr: $('dtrChk').checked,
      rts: $('rtsChk').checked
    };
  }
  return {
    mode: mode,
    remoteHost: ($('netHost').value || '').trim(),
    remotePort: Number($('netPort').value),
    localAddr: $('netLocalAddr').value || '0.0.0.0',
    localPort: Number($('netLocalPort').value) || 0
  };
}

async function openLink() {
  if (!NATIVE) { toast('未检测到桌面运行环境', 'err'); return; }
  if (S.opening) return;
  const cfg = buildOpenConfig();
  if (cfg.mode === 'serial' && !cfg.path) { toast(t('toast.needPort'), 'warn'); return; }
  if (cfg.mode !== 'serial' && cfg.mode !== 'tcp-server') {
    if (!cfg.remoteHost) { toast(t('toast.needRemoteHost'), 'warn'); return; }
    if (!cfg.remotePort) { toast(t('toast.needRemotePort'), 'warn'); return; }
  }
  if (cfg.mode === 'tcp-server' && !cfg.localPort) { toast(t('toast.needLocalPort'), 'warn'); return; }

  S.opening = true;
  setOpenBtnBusy(true);

  let r;
  try {
    r = await withTimeout(NATIVE.open(cfg), 15000, t('toast.opening'));
  } catch (e) {
    r = { ok: false, error: (e && e.message) || String(e) };
  } finally {
    /* 无论成功、失败还是异常，这里都必须复位，否则按钮会永远卡在「打开中」 */
    S.opening = false;
    setOpenBtnBusy(false);
  }

  if (!r || !r.ok) {
    const msg = (r && r.error) || 'unknown error';
    toast(t('toast.openFail', { word: busyWord() }) + msg, 'err', 5200);
    queueLog(t('toast.openFail', { word: busyWord() }) + msg, 'err', true); flushLog();
    return;
  }
  S.isOpen = true;
  S.openLabel = r.label || '';
  setConnectedUI(true);
  const okLine = (cfg.mode === 'serial') ? (S.openLabel + '   ' + paramsText()) : S.openLabel;
  queueLog(t('log.opened', { word: doneWord() }) + okLine, 'sys', true);
  flushLog();
  toast(t('toast.opened', { word: doneWord(), label: S.openLabel }), 'ok');
}

async function closeLink(silent) {
  if (!NATIVE) return;
  /* 即使界面上还认为连着，也要把主进程那边关干净；反之亦然 */
  const hadLink = S.isOpen || S.opening;
  S.opening = false;
  setOpenBtnBusy(false);
  try {
    await withTimeout(NATIVE.close(), 5000, t('toast.closed'));
  } catch (e) {
    queueLog(t('toast.closeErr') + ((e && e.message) || e), 'err', true);
  } finally {
    /* 无论主进程怎么回，界面都必须回到能再次操作的「未连接」状态 */
    S.isOpen = false;
    S.openLabel = '';
    stopTimerSend();
    stopLoopSend();
    rxDec = new TextDecoder(S.encoding, { fatal: false });
    setConnectedUI(false);
  }
  if (!silent && hadLink) {
    queueLog(t('log.closed'), 'sys', true);
    flushLog();
  }
}

/* 连接按钮的用词跟着模式 + 语言走 */
function modeWord() {
  const m = S.mode || 'serial';
  if (m === 'tcp-client') {
    return { off: t('btn.connect'), on: t('btn.disconnect'), ing: t('btn.connecting'), done: t('btn.connect') };
  }
  if (m === 'tcp-server') {
    return { off: t('btn.listen'), on: t('btn.disconnect'), ing: t('btn.listening'), done: t('btn.listen') };
  }
  return { off: t('btn.open'), on: t('btn.close'), ing: t('btn.opening'), done: t('btn.open') };
}
function busyWord() { return modeWord().done; }
function doneWord() { return modeWord().done; }
function setOpenBtnBusy(busy) {
  const w = modeWord();
  $('btnOpenText').textContent = busy ? w.ing : (S.isOpen ? w.on : w.off);
  $('btnOpen').disabled = false;
  $('btnOpen').classList.toggle('busy', !!busy);
}

function setConnectedUI(on) {
  $('sbPort').textContent = on ? (S.openLabel || t('sb.rx')) : t('sb.idle');
  $('btnOpenText').textContent = on ? modeWord().on : modeWord().off;
  ['modeSel', 'btnRefresh', 'baudRate', 'dataBits', 'stopBits', 'parity', 'flowCtrl',
   'dtrChk', 'rtsChk', 'netHost', 'netPort', 'netLocalAddr', 'netLocalPort']
    .forEach(function (id) { const el = $(id); if (el) el.disabled = on; });
  updateHint();
}

async function applySignals() {
  if (!NATIVE || !S.isOpen || !isSerialMode()) return;
  await NATIVE.setSignals({ dtr: $('dtrChk').checked, rts: $('rtsChk').checked });
}

function sendBytes(u8, silent) {
  if (!S.isOpen) { if (!silent) toast(t('toast.notOpen'), 'warn'); return false; }
  if (!u8.length) return false;
  /* Electron 版返回 undefined，Tauri 版返回 Promise —— 两边都兼容 */
  const wp = NATIVE.write(u8);
  if (wp && typeof wp.catch === 'function') {
    wp.catch(function (e) {
      const msg = (e && e.message) || String(e);
      if (!silent) toast(t('toast.writeFail') + msg, 'err');
      queueLog(t('toast.writeFail') + msg, 'err', true);
    });
  }
  S.txBytes += u8.length;
  onTxEcho(u8);
  updateStats();
  return true;
}

/* ==========================================================================
   8. 组装发送数据
   ========================================================================== */
function buildPayload(text, isHex, withNewline, nlMode, checksum) {
  let body;
  if (isHex) body = parseHex(text);
  else body = new TextEncoder().encode(text);
  if (withNewline && !isHex) body = concatBytes(body, newlineBytes(nlMode));
  if (checksum && checksum !== 'none') {
    if (!body.length) throw new Error('内容为空，无法添加校验');
    body = concatBytes(body, checksumBytes(checksum, body));
  }
  return body;
}
function updateSendInfo() {
  const txt = $('sendText').value;
  const info = $('sendInfo');
  if (!txt.length) { info.textContent = t('tx.bytes', { n: 0 }); return; }
  let n;
  if (S.sendHex) {
    try { n = parseHex(txt).length; }
    catch (e) { info.textContent = t('tx.hexBad'); return; }
  } else {
    n = new TextEncoder().encode(txt).length;
    if (S.newline) n += (S.nlMode === 'rn' ? 2 : 1);
  }
  const withCk = S.checksum !== 'none' && n > 0;
  if (withCk) n += (S.checksum.indexOf('crc16') === 0 ? 2 : 1);
  info.textContent = withCk ? t('tx.bytesCk', { n: n }) : t('tx.bytes', { n: n });
}
function doSend(silent) {
  const txt = $('sendText').value;
  let payload;
  try {
    payload = buildPayload(txt, S.sendHex, S.newline, S.nlMode, S.checksum);
  } catch (e) {
    if (!silent) toast(t('toast.badContent') + e.message, 'err');
    else if (S.timerId) { stopTimerSend(); toast(t('toast.timerOff') + e.message, 'err'); }
    return false;
  }
  if (!payload.length) {
    if (!silent) toast(t('toast.noContent'), 'warn');
    if (S.timerId) stopTimerSend();
    return false;
  }
  return sendBytes(payload, silent);
}
function startTimerSend() {
  const ms = Math.max(10, Number($('timerMs').value) || 1000);
  $('timerMs').value = String(ms);
  if (!S.isOpen) { toast(t('toast.notOpen'), 'warn'); $('chkTimer').checked = false; return; }
  if (!S.timerId) {
    S.timerId = setInterval(function () { doSend(true); }, ms);
    $('chkTimer').checked = true;
    $('timerMs').disabled = true;
    toast(t('toast.timerOn', { ms: ms }), 'ok');
  }
}
function stopTimerSend() {
  if (S.timerId) { clearInterval(S.timerId); S.timerId = null; }
  $('chkTimer').checked = false;
  $('timerMs').disabled = false;
}
async function sendFile(file) {
  if (!S.isOpen) { toast(t('toast.notOpen'), 'warn'); return; }
  const buf = new Uint8Array(await file.arrayBuffer());
  if (!buf.length) { toast(t('toast.fileEmpty'), 'warn'); return; }
  toast(t('toast.fileStart', { name: file.name, size: fmtSize(buf.length) }));
  const CHUNK = 256;
  const total = buf.length;
  let sent = 0;
  for (let i = 0; i < total; i += CHUNK) {
    if (!S.isOpen) break;
    const part = buf.subarray(i, Math.min(i + CHUNK, total));
    if (!sendBytes(part, true)) break;
    sent += part.length;
    await new Promise(function (r) { setTimeout(r, 8); });
  }
  if (sent < total) toast(t('toast.fileAbort', { sent: fmtSize(sent), total: fmtSize(total) }), 'err');
  else toast(t('toast.fileDone', { name: file.name, size: fmtSize(sent) }), 'ok');
}
async function saveLog() {
  const nodes = logEl.children;
  if (!nodes.length) { toast(t('toast.nothingToSave'), 'warn'); return; }
  const lines = [];
  for (let i = 0; i < nodes.length; i++) lines.push(nodes[i].textContent);
  const d = new Date();
  const stamp = d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '_' +
    pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
  const r = await NATIVE.saveFile({
    title: '保存接收数据',
    defaultName: 'serial_' + stamp + (S.hexView ? '_hex' : '') + '.txt',
    content: lines.join('\r\n')
  });
  if (r && r.ok) toast(t('toast.saved') + r.filePath, 'ok', 4200);
  else if (r && !r.canceled) toast(t('toast.saveFail') + (r.error || ''), 'err');
}

/* ==========================================================================
   9. chip 开关
   ========================================================================== */
function setChip(el, on) {
  el.dataset.on = on ? '1' : '0';
  el.classList.toggle('on', !!on);
}
function bindToggle(el, initial, onChange) {
  setChip(el, initial);
  el.addEventListener('click', function () {
    const next = el.dataset.on !== '1';
    setChip(el, next);
    onChange(next);
  });
}

/* ==========================================================================
   10. 快捷指令
   ========================================================================== */
const CMD_KEY = 'serialstudio.cmds.v2';

function defaultCmds() {
  return [
    { id: 1, data: 'AT+VER?', hex: false },
    { id: 2, data: '01 03 00 00 00 02', hex: true },
    { id: 3, data: 'Hello STM32!', hex: false }
  ];
}
function loadCmds() {
  const v = LS.get(CMD_KEY, null);
  S.cmds = (Array.isArray(v) && v.length) ? v : defaultCmds();
}
function saveCmds() { LS.set(CMD_KEY, S.cmds); }

/* 多条字符串：直接内联可编辑，改完自动保存（SSCOM 的操作方式） */
function renderCmds() {
  const box = $('cmdList');
  box.innerHTML = '';
  if (!S.cmds.length) {
    const h = document.createElement('div');
    h.className = 'hint';
    h.style.cssText = 'padding:16px;text-align:center';
    h.textContent = t('cmd.empty');
    box.appendChild(h);
    return;
  }
  S.cmds.forEach(function (c, i) {
    const row = document.createElement('div');
    row.className = 'cmd';
    row.dataset.id = String(c.id);

    const idx = document.createElement('span');
    idx.className = 'idx';
    idx.textContent = String(i + 1);

    const inp = document.createElement('input');
    inp.className = 'cmd-input';
    inp.dataset.act = 'edit';
    inp.value = c.data;
    inp.spellcheck = false;
    inp.title = c.data;
    inp.placeholder = c.hex ? t('cmd.phHex') : t('cmd.phAsc');

    const tp = document.createElement('button');
    tp.className = 'cmd-type' + (c.hex ? ' hex' : '');
    tp.dataset.act = 'type';
    tp.textContent = c.hex ? 'HEX' : 'ASC';
    tp.title = t('cmd.typeTip');

    const sd = document.createElement('button');
    sd.className = 'cmd-send';
    sd.dataset.act = 'send';
    sd.textContent = t('cmd.send');

    const dl = document.createElement('button');
    dl.className = 'cmd-del';
    dl.dataset.act = 'del';
    dl.textContent = '×';
    dl.title = t('cmd.del');

    row.appendChild(idx); row.appendChild(inp); row.appendChild(tp);
    row.appendChild(sd); row.appendChild(dl);
    box.appendChild(row);
  });
}
function sendCmd(c, silent) {
  let u8;
  try { u8 = buildPayload(c.data, c.hex, !c.hex && S.newline, S.nlMode, 'none'); }
  catch (e) { if (!silent) toast(t('toast.badContent') + e.message, 'err'); return false; }
  if (!u8.length) { if (!silent) toast(t('toast.emptyCmd'), 'warn'); return false; }
  return sendBytes(u8, silent);
}
async function sendAllCmds() {
  if (!S.isOpen) { toast(t('toast.notOpen'), 'warn'); return; }
  if (!S.cmds.length) { toast(t('toast.noCmd'), 'warn'); return; }
  let done = 0;
  for (let i = 0; i < S.cmds.length; i++) {
    if (!S.isOpen) break;
    const row = $('cmdList').children[i];
    if (row && row.classList) row.classList.add('sending');
    const ok = sendCmd(S.cmds[i], true);
    if (row && row.classList) row.classList.remove('sending');
    if (!ok) break;
    done++;
    await new Promise(function (r) { setTimeout(r, 60); });
  }
  if (done < S.cmds.length) toast(t('toast.sendInterrupted', { a: done, b: S.cmds.length }), 'err');
  else toast(t('toast.sentAll', { n: done }), 'ok');
}
function startLoopSend() {
  if (!S.cmds.length) { toast(t('toast.noLoopCmd'), 'warn'); $('chkCmdLoop').checked = false; return; }
  if (!S.isOpen) { toast(t('toast.notOpen'), 'warn'); $('chkCmdLoop').checked = false; return; }
  const ms = Math.max(1, Number($('cmdLoopMs').value) || 1000);
  $('cmdLoopMs').value = String(ms);
  if (S.loopId) return;
  S.loopIdx = 0;
  S.loopId = setInterval(function () {
    if (!S.isOpen) { stopLoopSend(); return; }
    const c = S.cmds[S.loopIdx % S.cmds.length];
    S.loopIdx++;
    if (c) sendCmd(c, true);
  }, ms);
  $('chkCmdLoop').checked = true;
  $('cmdLoopMs').disabled = true;
}
function stopLoopSend() {
  if (S.loopId) { clearInterval(S.loopId); S.loopId = null; }
  $('chkCmdLoop').checked = false;
  $('cmdLoopMs').disabled = false;
}
/* 多条字符串的增删改都在列表里内联完成（见上面的 renderCmds 与 bindAll 的委托事件） */

/* ==========================================================================
   11. 校验计算器
   ========================================================================== */
function algoValueHex(a, b) {
  let v;
  if (a === 'crc16modbus') v = b[0] | (b[1] << 8);
  else if (a === 'crc16ccitt') v = (b[0] << 8) | b[1];
  else v = b[0];
  return '0x' + v.toString(16).toUpperCase().padStart(b.length === 2 ? 4 : 2, '0');
}
function runTool() {
  const out = $('toolResult');
  const raw = $('toolInput').value;
  if (!raw.trim()) { out.textContent = t('tool.waiting'); return; }
  let u8;
  try { u8 = parseHex(raw); }
  catch (e) { out.textContent = t('tool.badInput') + e.message; return; }
  if (!u8.length) { out.textContent = t('tool.waiting'); return; }
  const list = (S.toolAlgo === 'all')
    ? ['crc16modbus', 'crc16ccitt', 'add8', 'xor8']
    : [S.toolAlgo];
  let html = '<div>' + t('tool.inputIs', { n: u8.length }) +
    '<span class="hl">' + esc(bytesToHex(u8).trim()) + '</span></div>';
  list.forEach(function (a) {
    const b = checksumBytes(a, u8);
    html += '<div>' + ALGO_NAME[a] + ' → <b>' + bytesToHex(b).trim() + '</b>　(' + algoValueHex(a, b) + ')</div>';
  });
  out.innerHTML = html;
}

/* ==========================================================================
   12. 主题
   ========================================================================== */

function setTheme() {
  document.documentElement.setAttribute('data-theme', 'light');
}

/* ==========================================================================
   13. 校验计算器窗口
   ========================================================================== */
function openTool() {
  openModal($('extModal'));
  $('extHint').textContent = '';
  setTimeout(function () { $('toolInput').focus(); }, 60);
}

/* 切换语言后：静态文案由 applyLang 处理，动态生成的部件要重建一遍 */
function refreshAfterLangChange() {
  $('langLabel').textContent = (getLang() === 'zh') ? 'EN' : '中';
  renderModeOptions();
  renderCmds();
  setConnectedUI(S.isOpen);
  updateStats();
  updateSendInfo();
  runTool();
  $('rxBadge').textContent = t('rx.lines', { n: logEl.children.length });
}

/* ==========================================================================
   14. 事件绑定
   ========================================================================== */
function bindAll() {
  /* ---------- 扩展窗口（波形 / 校验） ---------- */
  $('btnTools').addEventListener('click', function () { openTool(); });
  $('btnExtClose').addEventListener('click', function () { closeModal($('extModal')); });
  $('extModal').addEventListener('click', function (e) { if (e.target === this) closeModal(this); });

  /* ---------- 接收区显示选项 ---------- */
  bindToggle($('chkHexView'), S.hexView, function (v) { S.hexView = v; });
  bindToggle($('chkTimestamp'), S.ts, function (v) { S.ts = v; });
  bindToggle($('chkPacket'), S.packet, function (v) { S.packet = v; });
  bindToggle($('chkEcho'), S.echo, function (v) { S.echo = v; });
  bindToggle($('chkAutoWrap'), S.autoWrap, function (v) {
    S.autoWrap = v;
    logEl.classList.toggle('nowrap', !v);
  });

  $('pktGap').addEventListener('change', function () {
    const v = Math.min(5000, Math.max(1, Number(this.value) || 20));
    this.value = String(v); S.pktGap = v;
  });

  /* 编码切换：立即重建解码器（流式状态一并重置），从下一条数据起生效 */
  $('selEncoding').addEventListener('change', function () {
    setEncoding(this.value);
    rxDec = new TextDecoder(S.encoding, { fatal: false });
    echoDec = new TextDecoder(S.encoding, { fatal: false });
    toast(this.value === 'gbk' ? t('toast.encGbk') : t('toast.encUtf8'));
  });

  /* ---------- 接收区按钮 ---------- */
  const SVG_PAUSE = '<svg viewBox="0 0 24 24"><path d="M8 5v14M16 5v14"/></svg>';
  const SVG_PLAY = '<svg viewBox="0 0 24 24"><path d="M6 4l14 8-14 8z"/></svg>';
  $('btnPause').addEventListener('click', function () {
    S.paused = !S.paused;
    logWrap.classList.toggle('paused', S.paused);
    this.classList.toggle('on', S.paused);
    this.textContent = S.paused ? t('rx.resume') : t('rx.pause');
    if (!S.paused && S.dropped) {
      queueLog(t('log.pausedDrop', { size: fmtSize(S.dropped) }), 'sys', true);
      S.dropped = 0; flushLog();
    }
    toast(S.paused ? t('toast.paused') : t('toast.resumed'));
  });
  $('btnBottom').addEventListener('click', function () {
    logEl.scrollTop = logEl.scrollHeight;
  });
  $('btnSave').addEventListener('click', saveLog);
  $('btnClear').addEventListener('click', function () {
    clearLog(); toast(t('toast.cleared'));
  });

  /* ---------- 模式 / 连接 ---------- */
  $('btnRefresh').addEventListener('click', function () { refreshPorts(true); });
  $('modeSel').addEventListener('change', function () {
    applyModeUI();
    updateHint();
    if (!S.isOpen) setOpenBtnBusy(false);   /* 按钮文案跟着模式走 */
  });
  ['netHost', 'netPort', 'netLocalPort'].forEach(function (id) {
    $(id).addEventListener('input', function () {
      LS.set('serialstudio.' + id, id === 'netHost' ? this.value : (Number(this.value) || 0));
      updateHint();
    });
  });
  $('netLocalAddr').addEventListener('change', function () {
    LS.set('serialstudio.netLocalAddr', this.value);
    updateHint();
  });
  $('btnOpen').addEventListener('click', function () {
    /* 万一还卡在「打开中」，允许点一下强制复位，不至于彻底点不动 */
    if (S.opening) {
      S.opening = false;
      setOpenBtnBusy(false);
      closeLink(true);
      toast(t('toast.cancelled'));
      return;
    }
    if (S.isOpen) closeLink(false); else openLink();
  });
  $('dtrChk').addEventListener('change', applySignals);
  $('rtsChk').addEventListener('change', applySignals);
  $('btnResetStat').addEventListener('click', function () {
    S.rxBytes = 0; S.txBytes = 0; S.rxPkt = 0; S.dropped = 0;
    updateStats();
    toast(t('toast.statReset'));
  });

  /* ---------- 发送选项 ---------- */
  bindToggle($('chkSendHex'), S.sendHex, function (v) {
    S.sendHex = v;
    $('sendText').placeholder = v ? t('tx.phHex') : t('tx.phAsc');
    updateSendInfo();
  });
  bindToggle($('chkNewline'), S.newline, function (v) {
    S.newline = v;
    $('selNewline').disabled = !v;
    updateSendInfo();
  });
  $('selNewline').addEventListener('change', function () { S.nlMode = this.value; updateSendInfo(); });
  $('selChecksum').addEventListener('change', function () { S.checksum = this.value; updateSendInfo(); });
  $('chkTimer').addEventListener('click', function () {
    if (S.timerId) stopTimerSend(); else startTimerSend();
  });
  $('timerMs').addEventListener('change', function () {
    const v = Math.min(600000, Math.max(10, Number(this.value) || 1000));
    this.value = String(v);
    if (S.timerId) { stopTimerSend(); startTimerSend(); }
  });
  /* ---------- 按键即发 / 回车发送 ---------- */
  bindToggle($('chkKeySend'), S.keySend, function (v) { S.keySend = v; });
  bindToggle($('chkEnterSend'), S.enterSend, function (v) { S.enterSend = v; });

  $('sendText').addEventListener('keydown', function (e) {
    /* 回车：把当前整行发出去（Shift+Enter 仍用于换行） */
    if (e.key === 'Enter' && !e.shiftKey && S.enterSend) {
      e.preventDefault();
      if (doSend(false)) { $('sendText').value = ''; updateSendInfo(); }
      return;
    }
    if (!S.keySend) return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;   /* 放行 Ctrl+C/V 这类快捷键 */

    /* 控制键按字节直接发；可打印字符交给下面的 input 事件（保留输入框显示） */
    let code = -1;
    if (e.key === 'Backspace') code = 0x08;
    else if (e.key === 'Tab') code = 0x09;
    else if (e.key === 'Escape') code = 0x1B;
    if (code >= 0) {
      e.preventDefault();
      if (S.isOpen) sendBytes(new Uint8Array([code]), true);
    }
  });

  $('sendText').addEventListener('input', function (e) {
    if (!S.keySend || !S.isOpen) return;
    if (e.inputType !== 'insertText' || !e.data) return;
    sendBytes(new TextEncoder().encode(e.data), true);
  });

  $('sendText').addEventListener('input', updateSendInfo);
  $('btnSend').addEventListener('click', function () { doSend(false); });
  $('btnSendFile').addEventListener('click', function () { $('fileInput').click(); });
  $('fileInput').addEventListener('change', function (e) {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (f) sendFile(f);
  });

  /* ---------- 多条字符串发送（内联编辑） ---------- */
  $('btnAddCmd').addEventListener('click', function () {
    S.cmds.push({ id: Date.now() + Math.floor(Math.random() * 1000), data: '', hex: false });
    saveCmds(); renderCmds();
    const inputs = $('cmdList').querySelectorAll('.cmd-input');
    if (inputs.length) inputs[inputs.length - 1].focus();
  });
  $('btnSendAll').addEventListener('click', sendAllCmds);
  $('chkCmdLoop').addEventListener('click', function () {
    if (S.loopId) stopLoopSend(); else startLoopSend();
  });
  $('cmdLoopMs').addEventListener('change', function () {
    const v = Math.min(600000, Math.max(1, Number(this.value) || 1000));
    this.value = String(v);
    if (S.loopId) { stopLoopSend(); startLoopSend(); }
  });
  const cmdOf = function (row) {
    return S.cmds.filter(function (x) { return x.id === Number(row.dataset.id); })[0];
  };
  $('cmdList').addEventListener('click', function (e) {
    const btn = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!btn) return;
    const row = btn.closest('.cmd');
    if (!row) return;
    const c = cmdOf(row);
    if (!c) return;
    const act = btn.dataset.act;
    if (act === 'send') sendCmd(c, false);
    else if (act === 'type') { c.hex = !c.hex; saveCmds(); renderCmds(); }
    else if (act === 'del') {
      S.cmds = S.cmds.filter(function (x) { return x.id !== c.id; });
      saveCmds(); renderCmds();
    }
  });
  $('cmdList').addEventListener('change', function (e) {
    const inp = e.target.closest ? e.target.closest('.cmd-input') : null;
    if (!inp) return;
    const row = inp.closest('.cmd');
    if (!row) return;
    const c = cmdOf(row);
    if (c) { c.data = inp.value; inp.title = inp.value; saveCmds(); }
  });
  $('cmdList').addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    const inp = e.target.closest ? e.target.closest('.cmd-input') : null;
    if (!inp) return;
    e.preventDefault();
    const row = inp.closest('.cmd');
    const c = cmdOf(row);
    if (c) { c.data = inp.value; saveCmds(); sendCmd(c, false); }
  });

  /* ---------- 校验工具 ---------- */
  $('toolInput').addEventListener('input', runTool);
  Array.prototype.forEach.call(document.querySelectorAll('[data-algo]'), function (b) {
    b.addEventListener('click', function () {
      S.toolAlgo = this.dataset.algo;
      Array.prototype.forEach.call(document.querySelectorAll('[data-algo]'), function (x) {
        setChip(x, x.dataset.algo === S.toolAlgo);
      });
      runTool();
    });
  });

  /* ---------- 语言切换 ---------- */
  $('btnLang').addEventListener('click', function () {
    setLang(getLang() === 'zh' ? 'en' : 'zh');
    refreshAfterLangChange();
    toast(t('toast.langSwitched'));
  });

  /* ---------- 关于 ---------- */
  $('btnAbout').addEventListener('click', function () { openModal($('aboutModal')); });
  $('btnAboutClose').addEventListener('click', function () { closeModal($('aboutModal')); });
  $('aboutModal').addEventListener('click', function (e) { if (e.target === this) closeModal(this); });

  /* ---------- 顶栏 / 弹窗 ---------- */
  $('btnHelp').addEventListener('click', function () { openModal($('helpModal')); });
  $('btnHelpClose').addEventListener('click', function () { closeModal($('helpModal')); });
  $('btnHelpOk').addEventListener('click', function () { closeModal($('helpModal')); });
  $('btnAbout').addEventListener('click', async function () {
    if (!NATIVE) return;
    const i = await NATIVE.appInfo();
    toast('Electron ' + i.electron + ' · Chromium ' + i.chrome + ' · Node ' + i.node + ' · ' + i.arch, 'info', 6000);
  });
  $('helpModal').addEventListener('click', function (e) { if (e.target === this) closeModal(this); });

  /* ---------- 发送区高度拖拽 ---------- */
  let dragging = false, startY = 0, startH = 0, lastSendH = 0;
  const sendArea = $('sendArea');
  $('resizeBar').addEventListener('mousedown', function (e) {
    dragging = true; startY = e.clientY; startH = sendArea.offsetHeight;
    document.body.style.userSelect = 'none'; e.preventDefault();
  });
  window.addEventListener('mousemove', function (e) {
    if (!dragging) return;
    const maxH = Math.max(200, window.innerHeight - 300);
    const h = Math.min(Math.max(startH - (e.clientY - startY), 116), maxH);
    sendArea.style.height = h + 'px';
    lastSendH = h;
  });
  window.addEventListener('mouseup', function () {
    if (!dragging) return;
    dragging = false;
    document.body.style.userSelect = '';
    if (lastSendH) LS.set('serialstudio.sendH', lastSendH);   /* 松手时才落盘 */
  });

  /* ---------- Ctrl + 滚轮 调字号 ---------- */
  logWrap.addEventListener('wheel', function (e) {
    if (!e.ctrlKey) return;
    e.preventDefault();
    S.logSize = Math.min(20, Math.max(9, S.logSize - Math.sign(e.deltaY) * 0.5));
    logEl.style.fontSize = S.logSize + 'px';
    LS.set('serialstudio.logSize', S.logSize);
  }, { passive: false });

  /* ---------- 键盘 ---------- */
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); doSend(false); return; }
    if (e.ctrlKey && !e.shiftKey && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); clearLog(); return; }
    if (e.ctrlKey && e.shiftKey && (e.key === 'L' || e.key === 'l')) { e.preventDefault(); $('sendText').value = ''; updateSendInfo(); return; }
    if (e.ctrlKey && !e.shiftKey && (e.key === 'e' || e.key === 'E')) { e.preventDefault(); openTool(); return; }
    if (e.key === 'Escape') {
      closeModal($('extModal')); closeModal($('helpModal'));
      stopTimerSend(); stopLoopSend();
    }
  });

  /* ---------- 文件拖放：拖到窗口即载入发送框 ---------- */
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) {
    e.preventDefault();
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) sendFile(f);
  });
}

/* ==========================================================================
   15. 主进程事件
   ========================================================================== */
function bindNativeEvents() {
  if (!NATIVE) return;

  NATIVE.onData(function (u8) { onRxChunk(u8); });

  NATIVE.onPortsChanged(function (list) {
    const before = S.ports.length;
    S.ports = list || [];
    renderModeOptions();
    if (S.ports.length > before) toast(t('toast.newPort'));
  });

  /* TCP Server：客户端接入 / 断开 */
  NATIVE.onPeer(function (info) {
    if (!info) return;
    if (info.connected) {
      queueLog(t('toast.clientIn') + info.peer, 'sys', true); flushLog();
      toast(t('toast.peerIn') + info.peer, 'ok');
    } else {
      queueLog(t('toast.clientOut'), 'sys', true); flushLog();
    }
  });

  NATIVE.onClosed(function (info) {
    if (!S.isOpen) return;
    S.isOpen = false;
    S.openLabel = '';
    stopTimerSend();
    setConnectedUI(false);
    const why = (info && info.reason) || '连接已断开';
    queueLog(why, 'err', true); flushLog();
    toast(why, 'err', 4600);
  });

  NATIVE.onError(function (msg) {
    queueLog(msg, 'err', true); flushLog();
    toast(msg, 'err', 4200);
  });
}

/* ==========================================================================
   16. 初始化
   ========================================================================== */
async function init() {
  setTheme();

  /* 语言：本地偏好，默认中文 */
  let savedLang = 'zh';
  try { savedLang = localStorage.getItem('dfy.lang') || 'zh'; } catch (_) { }
  setLang(savedLang, false);
  $('langLabel').textContent = (savedLang === 'en') ? '中' : 'EN';
  applyLang();

  /* 局部尺寸偏好 */
  const sz = Number(LS.get('serialstudio.logSize', 12.5)) || 12.5;
  S.logSize = sz;
  logEl.style.fontSize = sz + 'px';
  const sh = Number(LS.get('serialstudio.sendH', 0));
  if (sh >= 100) $('sendArea').style.height = sh + 'px';

  /* 版本号 + 本机 IP（TCP Server 提示用） */
  if (NATIVE) {
    try {
      const info = await NATIVE.appInfo();
      $('aboutVer').textContent = 'v' + info.version;
      $('brand').textContent = t('app.name') + ' · MYX';
    } catch (_) { }
    try { S.localIPs = await NATIVE.localIPs(); } catch (_) { }
  }

  S.localIPs = (NATIVE ? [] : []);
  await refreshLocalIPs();

  const savedEnc = LS.get('serialstudio.encoding', 'utf-8');
  setEncoding(savedEnc, false);
  $('selEncoding').value = S.encoding;

  $('brand').textContent = t('app.name') + ' · MYX';

  loadCmds();
  renderCmds();
  bindAll();
  bindNativeEvents();
  updateSendInfo();
  updateStats();
  toggleEmpty();
  logEl.classList.toggle('nowrap', !S.autoWrap);
  $('selNewline').disabled = !S.newline;

  /* 恢复上次用的网络参数 */
  $('netHost').value = LS.get('serialstudio.netHost', '');
  $('netPort').value = String(LS.get('serialstudio.netPort', 8080));
  $('netLocalPort').value = String(LS.get('serialstudio.netLocalPort', 8080));
  const savedAddr = LS.get('serialstudio.netLocalAddr', '0.0.0.0');
  if ($('netLocalAddr').querySelector('option[value="' + savedAddr + '"]')) {
    $('netLocalAddr').value = savedAddr;
  }

  if (!NATIVE) {
    queueLog(t('log.noDesktop'), 'err', true);
    flushLog();
    toast(t('toast.noDesktop'), 'err', 5200);
  } else {
    await refreshPorts(false);
    setTimeout(function () { $('loading').classList.add('hide'); }, 200);
  }

}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
})();
