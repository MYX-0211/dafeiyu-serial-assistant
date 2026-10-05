/* ==========================================================================
   大肥鱼串口助手 · 轻量曲线
   --------------------------------------------------------------------------
   从接收到的文本里自动提取 name=123 / name:123 画曲线。
   刻意做得轻：
     · 每条通道只保留最近 N 个点，内存恒定
     · 只有切到「曲线」视图时才绘制，文本模式下完全不跑
     · 数值不是自带协议的（比如纯 hex 流）就安静地不画，不打扰
   ========================================================================== */
(function () {
  'use strict';

  const MAX_PTS = 800;          // 每条通道保留的点数
  const MAX_SERIES = 6;         // 最多画几条（超了就忽略新的）
  const PALETTE = ['#4A7BC8', '#D9534F', '#3E9E6E', '#D08A2C', '#6E6BD4', '#2C6A9E'];

  let canvas = null, ctx = null, wrap = null, tipEl = null;
  let series = [];              // [{ name, pts: [], color }]
  let active = false;           // 当前是否在曲线视图
  let dirty = false;
  let rafId = 0;

  function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name);
    return (v && v.trim()) || fallback;
  }

  function find(name) {
    for (let i = 0; i < series.length; i++) {
      if (series[i].name === name) return series[i];
    }
    return null;
  }

  function push(name, val) {
    let s = find(name);
    if (!s) {
      if (series.length >= MAX_SERIES) return;
      s = { name: name, pts: [], color: PALETTE[series.length % PALETTE.length] };
      series.push(s);
    }
    s.pts.push(val);
    if (s.pts.length > MAX_PTS) s.pts.splice(0, s.pts.length - MAX_PTS);
  }

  /** 从一行文本里提取数值；识别 a=1 b=2 这种键值对 */
  function feed(text) {
    if (!text) return;
    const re = /([A-Za-z_][A-Za-z0-9_.]*)\s*[=:]\s*(-?\d+(?:\.\d+)?)/g;
    let m;
    let got = false;
    while ((m = re.exec(text)) !== null) {
      push(m[1], parseFloat(m[2]));
      got = true;
    }
    if (!got) {
      // 没有键值对时，退回「逐行数列」：按数字出现的位置分到 c1、c2…
      const nums = text.match(/-?\d+(?:\.\d+)?/g);
      if (nums) {
        for (let i = 0; i < nums.length && i < MAX_SERIES; i++) {
          push('c' + (i + 1), parseFloat(nums[i]));
        }
      }
    }
    if (active) requestDraw();
  }

  function requestDraw() {
    dirty = true;
    if (!rafId) {
      rafId = requestAnimationFrame(function () {
        rafId = 0;
        if (dirty) { dirty = false; draw(); }
      });
    }
  }

  function resize() {
    if (!canvas || !wrap) return;
    const dpr = window.devicePixelRatio || 1;
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    if (w <= 0 || h <= 0) return;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (active) requestDraw();
  }

  function niceRange(min, max) {
    if (!isFinite(min) || !isFinite(max)) return [0, 1];
    if (min === max) { min -= 1; max += 1; }
    const pad = (max - min) * 0.08;
    return [min - pad, max + pad];
  }

  function draw() {
    if (!active || !ctx) return;
    const W = wrap.clientWidth;
    const H = wrap.clientHeight;
    const padL = 52, padR = 12, padT = 14, padB = 20;
    const iw = W - padL - padR;
    const ih = H - padT - padB;
    if (iw <= 10 || ih <= 0) return;

    const gridColor = cssVar('--line', 'rgba(60,60,67,.10)');
    const textColor = cssVar('--text-faint', 'rgba(60,60,67,.4)');

    ctx.clearRect(0, 0, W, H);

    if (!series.length) {
      if (tipEl) tipEl.hidden = false;
      return;
    }
    if (tipEl) tipEl.hidden = true;

    // 计算纵轴范围（所有通道统一刻度）
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < series.length; i++) {
      const p = series[i].pts;
      for (let j = 0; j < p.length; j++) {
        if (p[j] < lo) lo = p[j];
        if (p[j] > hi) hi = p[j];
      }
    }
    const r = niceRange(lo, hi);
    lo = r[0]; hi = r[1];

    // 横向网格 + 纵轴刻度
    ctx.strokeStyle = gridColor;
    ctx.fillStyle = textColor;
    ctx.font = '11px ' + cssVar('--font-mono', 'monospace');
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 1;
    for (let k = 0; k <= 4; k++) {
      const y = padT + (ih * k) / 4;
      ctx.beginPath();
      ctx.moveTo(padL, y + 0.5);
      ctx.lineTo(padL + iw, y + 0.5);
      ctx.stroke();
      const v = hi - ((hi - lo) * k) / 4;
      const txt = Math.abs(v) >= 1000 ? v.toFixed(0) : (Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));
      ctx.fillText(txt, padL - 6, y);
    }

    // 各通道曲线
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    for (let i = 0; i < series.length; i++) {
      const s = series[i];
      const p = s.pts;
      if (p.length < 2) continue;
      const stepX = iw / (MAX_PTS - 1);
      const startX = padL + iw - (p.length - 1) * stepX;
      ctx.strokeStyle = s.color;
      ctx.beginPath();
      for (let j = 0; j < p.length; j++) {
        const x = startX + j * stepX;
        const y = padT + ih - ((p[j] - lo) / (hi - lo)) * ih;
        if (j === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // 图例（右上角，简单列出通道名和最新值）
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = '11px ' + cssVar('--font-mono', 'monospace');
    let ly = padT + 2;
    for (let i = 0; i < series.length; i++) {
      const s = series[i];
      const last = s.pts.length ? s.pts[s.pts.length - 1] : 0;
      ctx.fillStyle = s.color;
      ctx.fillRect(padL + 8, ly + 3, 7, 7);
      ctx.fillStyle = cssVar('--text-dim', '#444');
      ctx.fillText(s.name + ' = ' + last, padL + 20, ly);
      ly += 14;
    }
  }

  function setActive(on) {
    active = !!on;
    if (canvas) canvas.hidden = !active;
    if (!active) {
      if (tipEl) tipEl.hidden = true;
      return;
    }
    resize();
    requestDraw();
  }

  function clear() {
    series = [];
    if (active) requestDraw();
  }

  function init() {
    canvas = document.getElementById('chart');
    wrap = document.getElementById('logWrap');
    tipEl = document.getElementById('chartTip');
    if (!canvas || !wrap) return;
    ctx = canvas.getContext('2d');
    canvas.hidden = true;
    window.addEventListener('resize', function () { if (active) resize(); });
  }

  window.ChartView = {
    init: init,
    feed: feed,
    setActive: setActive,
    clear: clear,
    resize: resize,
    hasData: function () { return series.length > 0; }
  };
})();
